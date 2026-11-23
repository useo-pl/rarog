/**
 * Klient przekaźnika push — `POST /v1/pass` i `POST /v1/push` na `fetch` Node, z originu
 * `RAROG_PUSH_RELAY_URL`. Kontrakt (trasy, macierz odpowiedzi, jednostki): `relay/README.md`; schematy
 * `shared/src/relay.ts`; przykłady każdego przypadku: `shared/fixtures/relay/` — żądania z tego modułu przy stałych
 * wejściach są RÓWNE ciałom z fixture'ów (`server/test/relay-fixtures-producenci.test.ts`).
 *
 * Ten moduł zna tylko protokół. KTÓRĄ drogą idzie wysyłka, rozstrzyga nadajnik złożony (`sender.ts`), a kiedy
 * zamawiać przepustki — `relay-pass.ts`.
 *
 * Co znaczy odpowiedź `/v1/push`:
 * - `200` — Apple odpowiedział; status i powód lustrem, mapowane TĄ SAMĄ regułą co nadajnik bezpośredni
 *   (`apnsResultOf`: 200 → `ok`, 410 i `BadDeviceToken`/`DeviceTokenNotForTopic` → `gone`, reszta → `failed`);
 *   `5xx` Apple wstrzymuje tę drogę w tym środowisku na 15 min (jak `apns.ts`), `renewedPass` idzie do wołającego;
 * - `401 pass-invalid` — przepustka odrzucona: wołający zdejmuje ją i zamawia nową (`relay-pass.ts`), wynik to brak
 *   próby (`pass-invalid`);
 * - `503 environment-unavailable` — przekaźnik nie obsłuży tego środowiska: droga milczy 15 min, a status tokenu
 *   mówi o degradacji od pierwszej takiej odpowiedzi do pierwszego 200;
 * - reszta (`400`, `429`, `502`, sieć, sufit czasu) — porażka tej próby.
 *
 * **Log WYŁĄCZNIE kodem, statusem i powodem.** Nigdy tokenu, przepustki, ładunku ani `String(err)` (komunikat
 * warstwy HTTP potrafi wciągnąć adres i nagłówki). Przepustki nie ma na liście `redact()` (`config.ts`,
 * `logSecrets`) i mieć nie może — zmienia się przy każdym wydaniu — więc obroną jest to, czego ten moduł NIE pisze.
 * Przekierowań nie wykonujemy (`redirect: 'error'`): przepustka i token idą wyłącznie pod skonfigurowany origin.
 *
 * **Ten moduł nigdy nie rzuca** z `push` ani `requestPass`.
 */
import type { ApnsEnvironment } from '@rarog/shared/rest';
import {
  RELAY_CLIENT_HEADER, RELAY_PROTOCOL_VERSION, relayErrorSchema, relayPassResponseSchema, relayPushResponseSchema,
} from '@rarog/shared/relay';
import type { RelayIssuedPass, RelayPassRequest, RelayPushRequest, RelayPushType } from '@rarog/shared/relay';
import { RAROG_VERSION } from '../version.ts';
import { APNS_REQUEST_TIMEOUT_MS, APNS_SERVER_ERROR_PAUSE_MS, apnsResultOf } from './apns.ts';
import type { ApnsResult } from './apns.ts';
import type { ApnsRequest } from './apns-payload.ts';

/** Sufit na odpowiedź przekaźnika — ten sam co na odpowiedź APNs w nadajniku bezpośrednim. */
export const RELAY_REQUEST_TIMEOUT_MS = APNS_REQUEST_TIMEOUT_MS;
/** Ile droga przekaźnika milczy w środowisku po `503 environment-unavailable` (jak po `5xx` Apple). */
export const RELAY_UNAVAILABLE_PAUSE_MS = APNS_SERVER_ERROR_PAUSE_MS;

/** Żądanie HTTP do przekaźnika w postaci pola `request` fixture'ów `shared/fixtures/relay/`. */
export interface RelayHttpRequest {
  readonly method: 'POST';
  readonly path: '/v1/pass' | '/v1/push';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RelayPassRequest | RelayPushRequest;
}

export interface RelayPassInput {
  /** Token urządzenia (`alert`) albo aktywności (`liveactivity`), tak jak stoi w rejestrze. */
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly type: RelayPushType;
  /** Temat wpisu urządzenia (bundle id apki). */
  readonly topic: string;
  /** Ważna przepustka urządzenia — wymagana przy `liveactivity`, zabroniona przy `alert`. */
  readonly devicePass?: string;
}

export interface RelayPushInput {
  readonly pass: string;
  readonly token: string;
  readonly environment: ApnsEnvironment;
  /** Gotowe żądanie APNs (`apns-payload.ts`): nagłówki i ciało, które idzie do Apple bajt w bajt. */
  readonly request: ApnsRequest;
}

/**
 * Nagłówki każdego żądania: oba WYMAGANE przez przekaźnik na trasach POST (bez nich 400
 * `bad-request`). Stoją w kształcie żądania, nie w transporcie, żeby ramki kontraktu pokazywały wymóg.
 */
const clientHeaders = (clientVersion: string): Record<string, string> =>
  ({ 'content-type': 'application/json', [RELAY_CLIENT_HEADER]: `rarog-server/${clientVersion}` });

/** `POST /v1/pass` dla danych wejść — kształt kontraktu, bez transportu. */
export function relayPassRequest(input: RelayPassInput, clientVersion: string = RAROG_VERSION): RelayHttpRequest {
  return {
    method: 'POST',
    path: '/v1/pass',
    headers: clientHeaders(clientVersion),
    body: {
      v: RELAY_PROTOCOL_VERSION,
      token: input.token,
      environment: input.environment,
      type: input.type,
      topic: input.topic,
      ...(input.devicePass === undefined ? {} : { devicePass: input.devicePass }),
    },
  };
}

/** `POST /v1/push` dla danych wejść: nagłówki APNs żądania i jego ciało jako łańcuch `payload`. */
export function relayPushRequest(input: RelayPushInput, clientVersion: string = RAROG_VERSION): RelayHttpRequest {
  return {
    method: 'POST',
    path: '/v1/push',
    headers: clientHeaders(clientVersion),
    body: {
      v: RELAY_PROTOCOL_VERSION,
      pass: input.pass,
      token: input.token,
      environment: input.environment,
      headers: { ...input.request.headers },
      payload: input.request.body,
    },
  };
}

/** Wynik `/v1/pass`. `reason` porażki to kod przekaźnika, kod błędu Node, `timeout` albo `unknown`. */
export type RelayPassOutcome =
  | { readonly kind: 'issued'; readonly pass: RelayIssuedPass }
  /** `422`: Apple odrzucił token (`400 BadDeviceToken`/`DeviceTokenNotForTopic` albo `410`). */
  | { readonly kind: 'token-rejected'; readonly apnsStatus: number; readonly reason: string; readonly timestamp?: number }
  /** `401`: przekaźnik odrzucił `devicePass` (przepustka aktywności). */
  | { readonly kind: 'pass-invalid' }
  | { readonly kind: 'failed'; readonly status: number | null; readonly reason: string };

export interface RelayPushOutcome {
  readonly result: ApnsResult;
  /** Odnowiona przepustka z `200` (mniej niż 7 dni do terminu albo stary `kid`). */
  readonly renewedPass?: RelayIssuedPass;
  /** `401 pass-invalid`: przepustka odrzucona — wołający ją zdejmuje i zamawia nową. */
  readonly passInvalid?: true;
}

export interface RelayClient {
  /** Origin przekaźnika — wiązanie każdej zapisanej przepustki. */
  readonly origin: string;
  requestPass(input: RelayPassInput): Promise<RelayPassOutcome>;
  push(input: RelayPushInput): Promise<RelayPushOutcome>;
  /** ISO pierwszego `503 environment-unavailable` w bieżącej serii; `null` = przekaźnik obsługuje środowisko. */
  unavailableSince(environment: ApnsEnvironment): string | null;
  /**
   * Do kiedy (ms epoki) droga przekaźnika w tym środowisku milczy — późniejsza z pauzy po `503` (kończy ją też
   * pierwsze 200 przekaźnika) i po `5xx` Apple (15 min); `0` = nie milczy.
   */
  pausedUntil(environment: ApnsEnvironment): number;
}

export interface RelayClientOptions {
  readonly origin: string;
  /** Podmiana wyłącznie w testach (atrapa przekaźnika bez sieci). */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Wersja w `X-Rarog-Relay-Client`; domyślnie wersja serwera (`version.ts`). */
  readonly clientVersion?: string;
  readonly log?: (line: string) => void;
}

/** Kod błędu Node albo undici (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`) — NIGDY komunikat. */
function errorCode(err: unknown): string {
  const pick = (value: unknown): string | undefined => {
    const code = typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? code : undefined;
  };
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return pick(cause) ?? pick(err) ?? 'no-code';
}

/** Słowo do logu z pola odpowiedzi (`rule`, powód Apple) — spoza wzorca znika. */
const word = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value) ? value : undefined;

type Reply = { readonly status: number; readonly body: unknown } | { readonly error: string };

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const { origin, log } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  const clientVersion = options.clientVersion ?? RAROG_VERSION;
  /**
   * Dwie OSOBNE pauzy: po `503 environment-unavailable` droga milczy do końca pauzy albo do
   * pierwszego 200 przekaźnika w tym środowisku (push albo pass, także spóźnionego z wysyłki w locie) — razem
   * z `unavailable`, więc status tokenu i następna wysyłka mówią to samo. Po `5xx` Apple — 15 min bez skrótu, jak
   * w `apns.ts` (Apple każe nie ponawiać, a 200 innej wysyłki tego nie odwołuje).
   */
  const relayPaused = new Map<ApnsEnvironment, number>();
  const apnsPaused = new Map<ApnsEnvironment, number>();
  const unavailable = new Map<ApnsEnvironment, string>();
  /** 200 przekaźnika w środowisku: obsługuje je — koniec niedostępności i jej pauzy. */
  const relayAnswered = (environment: ApnsEnvironment): void => {
    unavailable.delete(environment);
    relayPaused.delete(environment);
  };
  const silentUntil = (environment: ApnsEnvironment): number =>
    Math.max(relayPaused.get(environment) ?? 0, apnsPaused.get(environment) ?? 0);

  const call = async (request: RelayHttpRequest): Promise<Reply> => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    timer.unref();
    try {
      const response = await fetchImpl(`${origin}${request.path}`, {
        method: request.method,
        headers: { ...request.headers },
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Ciało spoza kontraktu (strona błędu proxy, pusta odpowiedź) — status mówi resztę.
      }
      return { status: response.status, body };
    } catch (err: unknown) {
      return { error: controller.signal.aborted ? 'timeout' : errorCode(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Kod błędu przekaźnika z ciała (`{v, error}`) albo `unknown`. */
  const errorOf = (body: unknown): { readonly code: string; readonly rule?: string } => {
    const parsed = relayErrorSchema.safeParse(body);
    if (!parsed.success) return { code: 'unknown' };
    const rule = word(parsed.data.rule);
    return rule === undefined ? { code: parsed.data.error } : { code: parsed.data.error, rule };
  };

  /** `503`: droga milczy 15 min; `since` zostaje z PIERWSZEJ odpowiedzi serii. */
  const markUnavailable = (environment: ApnsEnvironment): void => {
    relayPaused.set(environment, now() + RELAY_UNAVAILABLE_PAUSE_MS);
    if (!unavailable.has(environment)) {
      unavailable.set(environment, new Date(now()).toISOString());
      log?.(`push: relay ${environment} unavailable (503 environment-unavailable)`
        + ' — the route stays silent for 15 min');
    }
  };

  return {
    origin,

    async requestPass(input): Promise<RelayPassOutcome> {
      const reply = await call(relayPassRequest(input, clientVersion));
      if ('error' in reply) return { kind: 'failed', status: null, reason: reply.error };
      const { status, body } = reply;
      if (status === 200) {
        const parsed = relayPassResponseSchema.safeParse(body);
        if (!parsed.success) return { kind: 'failed', status, reason: 'unknown' };
        relayAnswered(input.environment);
        return { kind: 'issued', pass: { pass: parsed.data.pass, expiresAt: parsed.data.expiresAt } };
      }
      const error = errorOf(body);
      if (status === 422 && error.code === 'token-rejected') {
        const parsed = relayErrorSchema.parse(body);
        const fields = apnsResultOf(parsed.apnsStatus ?? 0, parsed.reason, parsed.timestamp);
        const reason = fields.kind === 'ok' ? 'unknown' : fields.reason;
        return {
          kind: 'token-rejected', apnsStatus: parsed.apnsStatus ?? 0, reason,
          ...(fields.kind === 'gone' && fields.invalidSince !== undefined ? { timestamp: fields.invalidSince } : {}),
        };
      }
      if (status === 401 && error.code === 'pass-invalid') return { kind: 'pass-invalid' };
      if (status === 503) markUnavailable(input.environment);
      return { kind: 'failed', status, reason: error.code };
    },

    async push(input): Promise<RelayPushOutcome> {
      const { environment } = input;
      if (silentUntil(environment) > now()) {
        return { result: { kind: 'failed', status: null, reason: 'paused' } };
      }
      const reply = await call(relayPushRequest(input, clientVersion));
      if ('error' in reply) {
        log?.(`push: relay ${environment} failed (${reply.error})`);
        return { result: { kind: 'failed', status: null, reason: reply.error } };
      }
      const { status, body } = reply;
      if (status === 200) {
        const parsed = relayPushResponseSchema.safeParse(body);
        if (!parsed.success) {
          log?.(`push: relay ${environment} failed (200 outside the contract)`);
          return { result: { kind: 'failed', status: null, reason: 'unknown' } };
        }
        relayAnswered(environment);
        const { apnsStatus, reason, timestamp, renewedPass } = parsed.data;
        const result = apnsResultOf(apnsStatus, reason, timestamp);
        if (result.kind === 'failed') {
          if (apnsStatus >= 500) {
            // Apple każe nie ponawiać przez 15 min — przekaźnik jest bezstanowy, więc pamięta to serwer.
            apnsPaused.set(environment, now() + APNS_SERVER_ERROR_PAUSE_MS);
            log?.(`push: relay ${environment} paused for 15 min (APNs ${String(apnsStatus)} ${result.reason})`);
          } else {
            log?.(`push: relay ${environment} — APNs failed (${String(apnsStatus)} ${result.reason})`);
          }
        }
        return renewedPass === undefined ? { result } : { result, renewedPass };
      }
      const error = errorOf(body);
      if (status === 401 && error.code === 'pass-invalid') {
        log?.(`push: relay ${environment} refused the pass (401 pass-invalid)`);
        return { result: { kind: 'failed', status: null, reason: 'pass-invalid' }, passInvalid: true };
      }
      if (status === 503) {
        markUnavailable(environment);
        return { result: { kind: 'failed', status, reason: error.code } };
      }
      log?.(`push: relay ${environment} failed (${String(status)} ${error.code}`
        + `${error.rule === undefined ? '' : `/${error.rule}`})`);
      return { result: { kind: 'failed', status, reason: error.code } };
    },

    unavailableSince(environment): string | null {
      return unavailable.get(environment) ?? null;
    },

    pausedUntil(environment): number {
      const until = silentUntil(environment);
      return until > now() ? until : 0;
    },
  };
}
