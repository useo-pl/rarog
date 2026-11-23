/**
 * Nadajnik APNs — HTTP/2 i JWT ES256 na wbudowanych `node:http2` i `node:crypto`.
 *
 * Jedno połączenie HTTP/2 na środowisko (`development` = `api.sandbox.push.apple.com`,
 * `production` = `api.push.apple.com`; wybór po `aps-environment`, który apka podaje przy
 * rejestracji), trzymane godzinami, jak każe Apple. Otwierane od nowa po GOAWAY, błędzie
 * połączenia i po przekroczeniu 10 s na odpowiedź; po godzinie ciszy przed wysyłką idzie PING,
 * a połączenie, które na niego nie odpowie, też jest zastępowane.
 *
 * Token dostawcy to JWT ES256 (`kid` = Key ID, `iss` = Team ID, `iat`) podpisany kluczem z pliku
 * z `RAROG_APNS_KEY_PATH`, trzymany w pamięci i odnawiany co 50 min (Apple: nie częściej niż co
 * 20 i nie rzadziej niż co 60). Odpowiedź `403 ExpiredProviderToken` unieważnia go od razu i daje
 * JEDNĄ ponowną próbę z nowym tokenem.
 *
 * Co znaczy odpowiedź (`ApnsResult`): `200` → doręczone do APNs; `410` oraz `400 BadDeviceToken`/
 * `DeviceTokenNotForTopic` → token martwy (`gone`, wpis wypada z rejestru); reszta → porażka tej
 * próby. Dwie porażki zmieniają stan nadajnika: `403 InvalidProviderToken`/
 * `BadEnvironmentKeyIdInToken` to klucz, który w tym środowisku NIGDY nie zadziała — środowisko
 * jest wyłączone do restartu i mówi o tym JEDNA linia logu; `5xx` wstrzymuje środowisko na 15 min
 * (Apple każe nie ponawiać wcześniej). `429` i `413 PayloadTooLarge` to porażka bez ponawiania.
 *
 * **Logi WYŁĄCZNIE kodem i powodem APNs.** Nigdy `String(err)`: komunikaty warstwy HTTP potrafią
 * wciągnąć nagłówki żądania, a w nagłówku `authorization` siedzi JWT. Nigdy tokenu urządzenia
 * (to adres do wysyłki) ani etykiety. `redact()` routera nie jest tu obroną — jego lista sekretów
 * jest statyczna, a JWT zmienia się co 50 min — więc obroną jest to, czego ten moduł NIE pisze.
 *
 * **Ten moduł nigdy nie rzuca** z `send`: powiadomienie jest best-effort.
 */
import http2 from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { ApnsEnvironment } from '@rarog/shared/rest';
import type { ApnsRequest } from './apns-payload.ts';

/** Hosty APNs per środowisko (`aps-environment` z profilu podpisu apki). */
export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** Wiek JWT, po którym podpisujemy nowy — w oknie 20–60 min, które dopuszcza Apple. */
export const APNS_JWT_TTL_MS = 50 * 60_000;
/** Sufit na odpowiedź APNs; po nim żądanie jest anulowane, a połączenie otwierane od nowa. */
export const APNS_REQUEST_TIMEOUT_MS = 10_000;
/** Cisza na połączeniu, po której przed wysyłką idzie PING. */
export const APNS_IDLE_PING_MS = 60 * 60_000;
/** Ile środowisko milczy po odpowiedzi `5xx` (Apple: nie ponawiać przez 15 min). */
export const APNS_SERVER_ERROR_PAUSE_MS = 15 * 60_000;

/** Powody `400`, po których token urządzenia jest martwy na zawsze (`410` jest martwy zawsze). */
const GONE_REASONS: ReadonlySet<string> = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);

/** `403`, po którym klucz w TYM środowisku nie zadziała do zmiany konfiguracji. */
const FATAL_REASONS: ReadonlySet<string> = new Set(['InvalidProviderToken', 'BadEnvironmentKeyIdInToken']);

/** Ile bajtów ciała odpowiedzi czytamy — APNs oddaje `{"reason": …}`, nigdy więcej. */
const RESPONSE_BODY_MAX_BYTES = 4096;

/**
 * Wynik jednej wysyłki. `reason` to WYŁĄCZNIE słowo z odpowiedzi APNs (sprawdzone wzorcem), kod
 * błędu Node (`ECONNREFUSED`) albo jedno z naszych: `timeout`, `disabled`, `paused`.
 */
export type ApnsResult =
  | { readonly kind: 'ok' }
  | {
    readonly kind: 'gone'; readonly status: number; readonly reason: string;
    /**
     * Przy `410`: chwila (ms epoki), w której APNs uznał token za nieważny. Apple każe przestać
     * wysyłać, CHYBA ŻE urządzenie zarejestrowało token po tej chwili — porównuje to sink.
     */
    readonly invalidSince?: number;
  }
  | { readonly kind: 'failed'; readonly status: number | null; readonly reason: string };

export interface ApnsSender {
  /** Jedna wysyłka do jednego tokenu. Nigdy nie rzuca. */
  send(environment: ApnsEnvironment, token: string, request: ApnsRequest): Promise<ApnsResult>;
  /** ISO chwili wyłączenia środowiska po trwałym błędzie klucza; `null` = działa. */
  disabledSince(environment: ApnsEnvironment): string | null;
  /** Zamyka połączenia (graceful shutdown). */
  close(): void;
}

export interface ApnsSenderOptions {
  /** Klucz prywatny EC P-256 (PEM z pliku albo gotowy `KeyObject`). */
  readonly privateKey: string | KeyObject;
  /** Key ID klucza APNs (`kid`). */
  readonly keyId: string;
  /** Team ID konta (`iss`). */
  readonly teamId: string;
  /** Podmiana hostów — wyłącznie testy (atrapa h2c na loopbacku). */
  readonly origins?: Partial<Record<ApnsEnvironment, string>>;
  /** Fabryka połączenia; domyślnie `http2.connect`. */
  readonly connect?: (origin: string) => ClientHttp2Session;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** JWT ES256 tokenu dostawcy — podpis w formacie `r‖s` (IEEE P1363), jak wymaga JWS. */
function signProviderToken(key: KeyObject, keyId: string, teamId: string, iatSec: number): string {
  const unsigned = `${base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}`
    + `.${base64url(JSON.stringify({ iss: teamId, iat: iatSec }))}`;
  const signature = sign('sha256', Buffer.from(unsigned, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

/** Kod błędu Node (stała, np. `ECONNREFUSED`) — NIGDY komunikat, który może nieść nagłówki. */
function errorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'no-code';
}

/** Pola odpowiedzi APNs: `reason` spoza wzorca słowa → `unknown`, `timestamp` tylko jako liczba całkowita. */
function sanitize(reason: unknown, timestamp: unknown): { readonly reason: string; readonly timestamp?: number } {
  const word = typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason) ? reason : 'unknown';
  return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) ? { reason: word, timestamp } : { reason: word };
}

/** Ciało odpowiedzi APNs: `reason` i `timestamp` przy `410`. */
function parseBody(body: string): { readonly reason: string; readonly timestamp?: number } {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; timestamp?: unknown } | null;
    return sanitize(parsed?.reason, parsed?.timestamp);
  } catch {
    // Puste albo nie-JSON ciało — powód nieznany.
    return { reason: 'unknown' };
  }
}

/**
 * Status i pola odpowiedzi APNs → {@link ApnsResult}. JEDNA reguła dla obu dróg: nadajnik bezpośredni czyta je
 * z ciała HTTP/2, przekaźnik oddaje je lustrem w `200 {apnsStatus, reason?, timestamp?}`.
 */
export function apnsResultOf(status: number, reason?: unknown, timestamp?: unknown): ApnsResult {
  if (status === 200) return { kind: 'ok' };
  const fields = sanitize(reason, timestamp);
  if (status === 410) {
    return {
      kind: 'gone', status, reason: fields.reason,
      ...(fields.timestamp === undefined ? {} : { invalidSince: fields.timestamp }),
    };
  }
  if (status === 400 && GONE_REASONS.has(fields.reason)) return { kind: 'gone', status, reason: fields.reason };
  return { kind: 'failed', status, reason: fields.reason };
}

function classify(status: number, body: string): ApnsResult {
  if (status === 200) return { kind: 'ok' };
  const { reason, timestamp } = parseBody(body);
  return apnsResultOf(status, reason, timestamp);
}

interface Connection {
  readonly session: ClientHttp2Session;
  lastUsedAt: number;
}

export function createApnsSender(options: ApnsSenderOptions): ApnsSender {
  const key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
  const origins: Record<ApnsEnvironment, string> = { ...APNS_ORIGINS, ...options.origins };
  const connect = options.connect ?? ((origin: string): ClientHttp2Session => http2.connect(origin));
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  const log = options.log;

  const connections = new Map<ApnsEnvironment, Connection>();
  const disabled = new Map<ApnsEnvironment, string>();
  const pausedUntil = new Map<ApnsEnvironment, number>();
  let jwt: { readonly value: string; readonly issuedAt: number } | undefined;

  const providerToken = (): string => {
    const at = now();
    if (jwt === undefined || at - jwt.issuedAt >= APNS_JWT_TTL_MS) {
      jwt = { value: signProviderToken(key, options.keyId, options.teamId, Math.floor(at / 1000)), issuedAt: at };
    }
    return jwt.value;
  };

  /** Połączenie przestaje być używane; `destroy` dla zepsutego, `close` dla GOAWAY. */
  const drop = (env: ApnsEnvironment, session: ClientHttp2Session, broken: boolean): void => {
    if (connections.get(env)?.session === session) connections.delete(env);
    if (session.destroyed) return;
    if (broken) session.destroy();
    else session.close();
  };

  const open = (env: ApnsEnvironment): Connection => {
    const session = connect(origins[env]);
    // Błąd połączenia bez słuchacza wywraca proces — tu jest tylko powodem, żeby otworzyć nowe.
    session.on('error', (err: unknown) => {
      log?.(`push: APNs ${env} connection failed (${errorCode(err)})`);
      drop(env, session, true);
    });
    // GOAWAY: trwające strumienie kończą się na starym połączeniu, nowe idą nowym.
    session.on('goaway', () => { drop(env, session, false); });
    session.on('close', () => { drop(env, session, false); });
    // Pusta pula połączeń APNs nie może trzymać procesu przy zamykaniu serwera.
    session.unref();
    const connection: Connection = { session, lastUsedAt: now() };
    connections.set(env, connection);
    return connection;
  };

  const ping = (session: ClientHttp2Session): Promise<boolean> => new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, timeoutMs);
    timer.unref();
    try {
      const sent = session.ping((err) => { clearTimeout(timer); resolve(err === null); });
      if (!sent) {
        clearTimeout(timer);
        resolve(false);
      }
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });

  /** Połączenie środowiska z rejestru, o ile jeszcze żyje (zamknięte wypada przy okazji). */
  const live = (env: ApnsEnvironment): Connection | undefined => {
    const connection = connections.get(env);
    if (connection !== undefined && (connection.session.closed || connection.session.destroyed)) {
      connections.delete(env);
      return undefined;
    }
    return connection;
  };

  const connectionFor = async (env: ApnsEnvironment): Promise<ClientHttp2Session> => {
    const idle = live(env);
    if (idle !== undefined && now() - idle.lastUsedAt >= APNS_IDLE_PING_MS) {
      // Znacznik PRZED czekaniem: równoległa wysyłka (dwa urządzenia naraz) nie pinguje drugi raz.
      idle.lastUsedAt = now();
      if (!(await ping(idle.session))) {
        log?.(`push: APNs ${env} PING failed (no reply) — new connection`);
        drop(env, idle.session, true);
      }
    }
    /*
     * Rejestr czytany OD NOWA po `await`: w czasie PING-u połączenie mogło
     * dostać GOAWAY, a równoległa wysyłka — otworzyć nowe. Otwieramy wyłącznie wtedy, gdy
     * żywego nie ma; inaczej nowe nadpisałoby w rejestrze cudze i tamto zostałoby otwarte na
     * zawsze, poza `close()`.
     */
    const connection = live(env) ?? open(env);
    connection.lastUsedAt = now();
    return connection.session;
  };

  /** Jedna próba; `jwt` = token dostawcy, z którym poszła (`undefined`, gdy nie doszło do żądania). */
  const attempt = async (
    env: ApnsEnvironment, token: string, request: ApnsRequest,
  ): Promise<{ readonly result: ApnsResult; readonly jwt?: string }> => {
    let session: ClientHttp2Session;
    try {
      session = await connectionFor(env);
    } catch (err: unknown) {
      return { result: { kind: 'failed', status: null, reason: errorCode(err) } };
    }
    const used = providerToken();
    const authorization = `bearer ${used}`;
    const result = await new Promise<ApnsResult>((resolve) => {
      let settled = false;
      let status = 0;
      let failure: string | undefined;
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (result: ApnsResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // Anulowane żądanie i NOWE połączenie przy następnej wysyłce: stare mogło utknąć.
        drop(env, session, true);
        finish({ kind: 'failed', status: null, reason: 'timeout' });
      }, timeoutMs);
      timer.unref();
      try {
        const stream = session.request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization,
          'content-type': 'application/json',
          ...request.headers,
        });
        stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
        stream.on('data', (chunk: Buffer) => {
          if (size >= RESPONSE_BODY_MAX_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('error', (err: unknown) => { failure = errorCode(err); });
        stream.on('close', () => {
          if (status > 0) finish(classify(status, Buffer.concat(chunks).toString('utf8')));
          else finish({ kind: 'failed', status: null, reason: failure ?? 'no-response' });
        });
        stream.end(request.body);
      } catch (err: unknown) {
        drop(env, session, true);
        finish({ kind: 'failed', status: null, reason: errorCode(err) });
      }
    });
    return { result, jwt: used };
  };

  /** Skutek odpowiedzi dla STANU nadajnika i jedyna linia logu o niej. */
  const react = (env: ApnsEnvironment, result: ApnsResult): void => {
    if (result.kind !== 'failed') return;
    const what = result.status === null ? result.reason : `${String(result.status)} ${result.reason}`;
    if (result.status === 403 && FATAL_REASONS.has(result.reason)) {
      if (disabled.has(env)) return;
      disabled.set(env, new Date(now()).toISOString());
      const session = connections.get(env)?.session;
      if (session !== undefined) drop(env, session, false);
      log?.(`push: APNs ${env} disabled (${result.reason}) — until the server restarts`);
      return;
    }
    if (result.status !== null && result.status >= 500) {
      pausedUntil.set(env, now() + APNS_SERVER_ERROR_PAUSE_MS);
      log?.(`push: APNs ${env} paused for 15 min (${what})`);
      return;
    }
    log?.(`push: APNs ${env} failed (${what})`);
  };

  return {
    async send(environment, token, request): Promise<ApnsResult> {
      if (disabled.has(environment)) return { kind: 'failed', status: null, reason: 'disabled' };
      if ((pausedUntil.get(environment) ?? 0) > now()) {
        return { kind: 'failed', status: null, reason: 'paused' };
      }
      const first = await attempt(environment, token, request);
      let result = first.result;
      if (result.kind === 'failed' && result.status === 403 && result.reason === 'ExpiredProviderToken') {
        // Token dostawcy wygasł po stronie APNs (zegar Maca, uśpienie) — nowy i JEDNA próba.
        log?.(`push: APNs ${environment} 403 ExpiredProviderToken — new JWT, one retry`);
        /*
         * Kasujemy WYŁĄCZNIE ten token, który APNs odrzucił: równoległa
         * wysyłka z tym samym starym JWT mogła go już odnowić, a każde zbędne odnowienie zbliża
         * do `429 TooManyProviderTokenUpdates`. Ponowna próba bierze wtedy token już odnowiony.
         */
        if (jwt?.value === first.jwt) jwt = undefined;
        result = (await attempt(environment, token, request)).result;
      }
      react(environment, result);
      return result;
    },
    disabledSince(environment): string | null {
      return disabled.get(environment) ?? null;
    },
    close(): void {
      for (const [env, connection] of [...connections]) drop(env, connection.session, false);
    },
  };
}
