/**
 * Ręczny router HTTP (node:http, bez frameworka — endpointów jest ~14).
 *
 * Warstwy obrony wykonywane w tej kolejności:
 * 1. POST, PUT i DELETE → nagłówek `Origin` musi przejść regułę `originAllowed` (CSRF; `auth/origin.ts`: TCP
 *    lista `RAROG_ORIGINS`, gniazdo iroh wyłącznie `IROH_ORIGIN`),
 * 2. wszystko poza `/health`, `/api/login` i `/api/pair` → ważny klucz urządzenia z nagłówka
 *    `Authorization: Rarog-Device …` (401, `authenticate`); `/api/login` odpowiada stałym 410
 *    `login-retired`, bo logowania tokenem serwer nie ma,
 * 3. ciało requestu ≤ 64 kB (413) — wyjątkiem jest `/messages`, gdzie limit to 12 MB
 *    ze względu na obrazki — poprawny JSON + schemat zod (400).
 *
 * W trybie recenzji demo (`config.demoReview`) między poświadczeniami a routingiem stoi klasa trasy
 * (`demo/review-routes.ts`): ścieżka bez klasy `allow` albo `retired` nie dochodzi do obsługi.
 *
 * Logi przechodzą przez `redact()` — nigdy nie logujemy nagłówków Cookie/Authorization ani wartości
 * tokenów.
 *
 * Route groups live in `routes/` (one module per area); `handle` calls them only after the three checks above,
 * so no group repeats them. The groups take the response and body helpers from this module, and this module
 * takes the groups: an import cycle that is safe because neither side uses the other while it loads.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UploadImage } from './herdr/uploads.ts';
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  DIFF_BAD_PATH_ERROR,
  DIFF_FILE_NOT_FOUND_ERROR,
  DIFF_GIT_FAILED_ERROR,
  DIFF_SESSION_NOT_FOUND_ERROR,
} from '@rarog/shared';
import type {
  CommandList, CreateSessionResponse, DecisionRefusedBody, DiffFileList, DiffFilePatch, DirEntry, DirListing, ModelList,
  NotesConflictBody, NotesDoc, SessionModeResponse, SessionModelResponse, SessionSummary, TermOpenResponse,
  VoiceToken, interruptResponseSchema, notesPutResponseSchema, resumableListSchema, termHistoryResponseSchema,
} from '@rarog/shared';
import {
  type AnyText, type OwnText, isAnyText, isServerSentence, say, textOf,
} from '@rarog/shared/sentences';
import {
  CLIENT_ID_CONFLICT_ERROR, DEMO_REVIEW_ERROR, DEVICE_REVOKED_ERROR, DEVICE_UNKNOWN_ERROR, ULTRACODE_REFUSED_ERROR,
} from '@rarog/shared/rest';
import type {
  ApnsStatusResponse, CompanionAsk, CompanionSessions, CompanionSpeechToken, CompanionToken, CompanionTurns, DeviceList,
  DeviceMe, DeviceRevokedBody, ErrorBody,
  MessageAccepted, OkAck, PairResponse, PairingIssued, PlanUsageResponse, QueueTakeBackResponse, RestartResponse,
  ResumeResponse, ServerIroh, ServerSystem, TermListResponse, VersionResponse,
} from '@rarog/shared/rest';
import {
  type AuthRefusal, type DeviceRecord, type DeviceStore, type LoginLimiter, type Pairing, type Principal,
  ORIGIN_CHECKED_METHODS, authenticate, createLoginLimiter, loginPeer, originAllowed, redact,
} from './auth/index.ts';
import { noteIrohRefusal } from './iroh/socket.ts';
import type { CompanionFeature } from './companion/ask.ts';
import { type CompanionTurnsReader, assembleCompanionTurns } from './companion/turns.ts';
import { fileNotes } from './notes/store.ts';
import type { NotesBackend } from './notes/store.ts';
import { VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, logSecrets } from './config.ts';
import type { TermFeature } from './term/index.ts';
import type { RarogConfig } from './config.ts';
import { classifyReviewRoute } from './demo/review-routes.ts';
import { NO_HEALTH_PROBES, cacheProbe } from './health.ts';
import type { HealthProbes, healthPayload } from './health.ts';
import type { ManagerApi } from './sessions/manager-api.ts';
import type { Presence } from './notify/presence.ts';
import type { ApnsDeviceStore } from './notify/apns-devices.ts';
import type { ApnsSink } from './notify/apns-sink.ts';
import type { LiveActivityController } from './notify/live-activity.ts';
import type { RelayPasses } from './notify/relay-pass.ts';
import type { PushSender } from './notify/sender.ts';
import type { SseHub } from './sse.ts';
import { type UsageProvider, createUsageProvider } from './usage.ts';
import { serverSystem } from './version.ts';
import type { MacStats } from './mac-stats.ts';
import { COMPANION_SPEECH_KEY, type SpeechKeyMinter, type VoiceMinter, createVoiceMinter } from './voice/soniox.ts';
import { type CompanionTokenMinter, createCompanionTokenMinter } from './companion/openai-token.ts';
import type { RouteContext, RouteGroup, RouteRequest } from './routes/context.ts';
import { handleDemoPairing, routeDevices } from './routes/devices.ts';
import { routeLimits } from './routes/limits.ts';
import { routeNotes } from './routes/notes.ts';
import { routeProjects } from './routes/projects.ts';
import { createTestCooldown, routePush } from './routes/push.ts';
import { INTERRUPT_WAIT_MS, routeSessions } from './routes/sessions.ts';
import { routeSystem } from './routes/system.ts';
import { routeTerminal } from './routes/terminal.ts';

export { checkCwd } from './routes/projects.ts';
export { PUSH_TEST_COOLDOWN_MS } from './routes/push.ts';
export { INTERRUPT_WAIT_MS, checkModel } from './routes/sessions.ts';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => { console.log(message); },
  error: (message) => { console.error(message); },
};

export interface RouterDeps {
  readonly config: RarogConfig;
  readonly manager: ManagerApi;
  readonly hub: SseHub;
  readonly serverStartId: string;
  /**
   * Odczyt ZDJĘCIA z `<cwd>/.rarog-uploads/` do miniatury — `HerdrUploads.read`.
   * Brak (testy bez uploadów) = `GET …/uploads/:file` zawsze 404; demo czyta zdjęcia pokazu z RAM.
   */
  readonly readUpload?: (cwd: string, name: string) => Promise<UploadImage | null>;
  /** Znacznik startu procesu (Date.now()) — do uptime w /health. */
  readonly startedAtMs: number;
  /**
   * Sondy readiness dla `/health`: ping gniazda herdr i stan złożenia terminala.
   * Brak pola (testy, awaria składania integracji) = oba boole `false` — health nie ma
   * prawa obiecywać integracji, o której nic nie wie.
   */
  readonly health?: HealthProbes;
  /** Termin ważności wyniku sondy herdr; domyślnie `HEALTH_PROBE_TTL_MS` (testy skracają). */
  readonly healthProbeTtlMs?: number;
  /**
   * Ile `POST /:id/interrupt` czeka na dostarczenie `escape`, zanim odpowie
   * `delivered: 'pending'`; domyślnie `INTERRUPT_WAIT_MS` (testy skracają).
   */
  readonly interruptWaitMs?: number;
  readonly logger?: Logger;
  /**
   * Nazwa tailnetu dla nagłówka AGENCI (`GET /api/version`). Brak pola
   * (testy, serwer bez Tailscale'a) = `null`, czyli klient nagłówka nie dopisze. Wołanie jest
   * z terminem ważności (`tailnetReader`), więc endpoint nie spawnuje procesu per request.
   */
  readonly tailnet?: () => Promise<string | null>;
  /** Limity planu Claude dla `GET /api/usage` i `GET /api/usage/details`; wstrzykiwany w testach. */
  readonly usage?: UsageProvider;
  /**
   * Bieżący odczyt WSPÓLNEGO próbnika obciążenia Maca dla `GET /api/mac` — `index.ts` zakłada
   * jeden próbnik dla tej trasy i Live Activity (demo: stała atrapa). Brak pola (testy, harness) =
   * `{}`, czyli „brak odczytu": router sam próbnika nie zakłada, bo ten żyje z timerami i `sysctl`.
   */
  readonly mac?: () => MacStats;
  /**
   * Magazyn notatek projektu. Brak pola = pliki w `<dataDir>/notes/` (`fileNotes`); demo podaje
   * magazyn w pamięci procesu (`demo/notes.ts`), ten sam, z którego `SseHub` liczy `notesCwds`.
   */
  readonly notes?: NotesBackend;
  /**
   * Minter kluczy tymczasowych Soniox. Domyślnie budowany z `config`; wstrzykiwany
   * wyłącznie w testach — produkcja nie ma powodu podawać innego niż ten z env.
   */
  readonly voice?: VoiceMinter;
  /**
   * Dławik nieudanych prób parowania i nieznanych kluczy. Domyślnie świeży, globalny dla procesu;
   * wstrzykiwany w testach, które potrzebują własnego budżetu albo zegara.
   */
  readonly loginLimiter?: LoginLimiter;
  /**
   * Terminal PTY albo `undefined`, gdy ficzeru NIE MA — `RAROG_TERM` wyłączony
   * albo nieudane złożenie modułu. Brak pola jest jedynym stanem „wyłączony": router nie zna
   * innego, więc nie da się przez pomyłkę wystawić endpointu bez działającego rejestru.
   */
  readonly term?: TermFeature;
  /**
   * Voice agent: questions about a session through `claude -p`. Missing = the module is not there
   * (`RAROG_COMPANION=0`, demo): `POST /api/sessions/:id/companion/ask` answers 503 `companion-disabled` and
   * `GET /api/version` says `companionEnabled: false`.
   */
  readonly companion?: Pick<CompanionFeature, 'ask'>;
  /** Reader of a session's last turns (mode across sessions). Built from `config` by default; injected in tests. */
  readonly companionTurns?: CompanionTurnsReader;
  /** Token of an engine conversation in the session catalog; default the server process's. Fixed only in tests. */
  readonly conversationToken?: (agentSessionId: string | undefined) => string;
  /**
   * Minter of short-lived OpenAI keys for the voice agent. Built from `config` by default; injected only in
   * tests, which give it a `fetch` stand-in.
   */
  readonly companionToken?: CompanionTokenMinter;
  /**
   * Minter of temporary Soniox speech keys for the voice agent. Built from `config` by default, with its own
   * throttle and with the gate of the voice agent; injected only in tests.
   */
  readonly companionSpeechToken?: SpeechKeyMinter;
  /**
   * Rejestr obecności klientów albo `undefined`, gdy Rarog nie pushuje (nie ma kanału APNs).
   *
   * Brak pola nie wyłącza endpointu, tylko czyni go no-opem: apka wysyła beacon zawsze,
   * bo nie ma powodu wiedzieć, czy serwer ma akurat kanał powiadomień — a endpoint, który raz
   * jest, a raz go nie ma, zamieniłby to w 404 do zdiagnozowania na telefonie.
   */
  readonly presence?: Presence;
  /**
   * Kanał APNs apki natywnej albo `undefined`, gdy go nie ma (brak kompletu `RAROG_APNS_*`,
   * `RAROG_PUSH=0`, demo). Tak jak przy `presence`, brak pola NIE wyłącza tras: `status` mówi
   * `enabled: false`, reszta to 204 no-op — nigdy 404 do zdiagnozowania na telefonie.
   */
  readonly apns?: ApnsFeature;
  /**
   * Tożsamość urządzeń: magazyn kluczy, parowanie kodem i powiadomienie o nowym urządzeniu.
   * Brak (testy bez parowania) = `POST /api/pair` i trasy `/api/pairings`, `/api/devices*` oddają 404,
   * a każdy nagłówek `Authorization` to 401 `device-unknown`.
   */
  readonly devices?: DeviceIdentity;
  /**
   * Serwer iroh: EndpointId i relay nasłuchu, znane przed pierwszym żądaniem (`index.ts` otwiera endpoint
   * przed `listen`). Niesie je `GET /api/version` i `PairResponse.server`. Brak albo `null` = serwer bez nasłuchu.
   */
  readonly iroh?: ServerIroh | null;
  /**
   * System maszyny serwera dla `GET /api/version` (`system`): `index.ts` podaje `serverSystem()` z `process.platform`,
   * demo stałe `macos` (`demo/mac.ts`), producent złotych odpowiedzi stałą wartość (CI jedzie na Linuksie). Brak
   * pola (testy) = system procesu testu.
   */
  readonly system?: ServerSystem;
}

/** To, co router musi wiedzieć o kluczach urządzeń i parowaniu. */
export interface DeviceIdentity {
  readonly store: DeviceStore;
  readonly pairing: Pairing;
  /** Nazwa serwera w odpowiedzi parowania (host Maca bez `.local`). */
  readonly serverName: string;
  /**
   * Po WYSŁANIU odpowiedzi `/api/pair` (zdarzenie `finish`): push `device-paired` do pozostałych
   * urządzeń. Wolny APNs nie ma prawa opóźnić odpowiedzi, więc wołany po niej; nie rzuca.
   */
  readonly onPaired?: (record: DeviceRecord) => void;
  /** Zegar parowania i list; wstrzykiwany w testach (opóźnione ciało na granicy terminu). */
  readonly now?: () => number;
}

/**
 * To, co router musi wiedzieć o APNs: rejestr urządzeń (upsert, status, wyrejestrowanie),
 * sink do pusha próbnego do JEDNEGO tokenu, status drogi wpisu i czekanie pushu próbnego na drogę (nadajnik
 * złożony), przepustki przekaźnika (zamówienie po odpowiedzi trasy) i sterownik Live Activity (token
 * aktywności, koniec, koniec przy wyrejestrowaniu).
 */
export interface ApnsFeature {
  readonly devices: ApnsDeviceStore;
  readonly sink: Pick<ApnsSink, 'sendTo'>;
  readonly sender: Pick<PushSender, 'statusOf' | 'awaitRoute' | 'awaitPending'>;
  readonly liveActivity: Pick<LiveActivityController, 'register' | 'end' | 'forgetDevice'>;
  /** Przepustki przekaźnika; brak = serwer bez `RAROG_PUSH_RELAY_URL`. */
  readonly passes?: Pick<RelayPasses, 'ensure'>;
  /**
   * Temat serwera (`RAROG_APNS_TOPIC`, bez klucza — temat apki przekaźnika): rejestracja z innym `topic` to 400
   * {@link APNS_TOPIC_MISMATCH_ERROR}. Wysyłki biorą temat z wpisu, nie stąd.
   */
  readonly topic: string;
  /** Zegar dławika pushy próbnych; wstrzykiwany w testach, domyślnie `Date.now`. */
  readonly now?: () => number;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

// ---------------------------------------------------------------------------
// Pomocnicze: odpowiedzi
// ---------------------------------------------------------------------------

/**
 * Ciało błędu na drucie. Powstaje wyłącznie w {@link errorBody} (przez {@link sendError} albo {@link errorBodyOf}):
 * tekst `message` bierze się zawsze ze zdania, nigdy z gołego napisu.
 */
type ErrorBodyOut = ErrorBody | DecisionRefusedBody | NotesConflictBody | DeviceRevokedBody;

/** Pola ciała błędu poza `error` i `message`: powód odmowy decyzji, aktualne notatki, data odpięcia urządzenia. */
type ErrorExtra =
  | Pick<DecisionRefusedBody, 'reason'>
  | Pick<NotesConflictBody, 'current'>
  | Pick<DeviceRevokedBody, 'revokedAt' | 'revokedBy'>;

/**
 * Ciała odpowiedzi 2xx, które router wysyła — typy kontraktu z `rest.ts` i `protocol.ts` (albo typy zwracane przez
 * moduły, które je składają). Ciało spoza tej unii się nie kompiluje, więc błąd z `message` nie przejdzie przez
 * {@link sendJson} bokiem, z pominięciem {@link errorBodyOf}.
 */
type ResponseBody =
  | OkAck
  | MessageAccepted
  | VersionResponse
  | PlanUsageResponse
  | ResumeResponse
  | RestartResponse
  | ApnsStatusResponse
  | PairResponse
  | QueueTakeBackResponse
  | PairingIssued
  | DeviceList
  | DeviceMe
  | TermListResponse
  | TermOpenResponse
  | z.infer<typeof termHistoryResponseSchema>
  | z.infer<typeof interruptResponseSchema>
  | z.infer<typeof resumableListSchema>
  | z.infer<typeof notesPutResponseSchema>
  | ModelList
  | CommandList
  | SessionModelResponse
  | SessionModeResponse
  | CreateSessionResponse
  | DirListing
  | DirEntry
  | DiffFileList
  | DiffFilePatch
  | NotesDoc
  | MacStats
  | VoiceToken
  | CompanionAsk
  | CompanionTurns
  | CompanionSessions
  | CompanionToken
  | CompanionSpeechToken
  | Awaited<ReturnType<typeof healthPayload>>
  | Awaited<ReturnType<UsageProvider['details']>>
  | Awaited<ReturnType<ManagerApi['diff']>>
  | { readonly projects: ReturnType<ManagerApi['projects']> }
  | { readonly projects: Awaited<ReturnType<ManagerApi['recentProjects']>> }
  | { readonly sessionId: string; readonly session: SessionSummary }
  // Trasy bez schematu w `shared`: `POST /api/client-log` (liczba zapisanych zdarzeń), kod parowania demo z linkiem
  // (testy UI) i puste `{}` zamknięcia terminala.
  | (OkAck & { readonly written: number })
  | (PairingIssued & { readonly link: string | null })
  | Record<string, never>;

/** Jedyne miejsce, które pisze JSON do odpowiedzi; woła je {@link sendJson} (2xx) i {@link sendError} (błędy). */
function writeJson(res: ServerResponse, status: number, body: ResponseBody | ErrorBodyOut): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    // Odpowiedzi API nigdy nie są cache'owane — stan sesji zmienia się co sekundę.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Odpowiedź poprawna z ciałem kontraktu. Błąd idzie przez {@link sendError} albo {@link sendFailure}. */
export function sendJson(res: ServerResponse, status: 200 | 202, body: ResponseBody): void {
  writeJson(res, status, body);
}

/**
 * 204 bez ciała — dla żądań, z których klient nie ma czego przeczytać.
 *
 * Beacon obecności leci co 25 s przy otwartej apce, więc każdy bajt odpowiedzi jest bajtem
 * przez LTE bez powodu; trasy APNs dostają to samo — apka po rejestracji i wyrejestrowaniu
 * nie ma z odpowiedzi czego przeczytać.
 */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * Ciało błędu ze zdania: jedyny literał `{error, message}` w routerze. Zdanie z `say()` dokłada `messageRef` (kod
 * i argumenty dla apki); tekst obcy wychodzi samym `message`.
 */
function errorBody(error: string, sentence: AnyText): ErrorBody {
  const ref = isServerSentence(sentence) ? { messageRef: sentence.ref } : {};
  return { error, message: textOf(sentence), ...ref };
}

/**
 * Błąd ze zdaniem trasy. Przyjmuje wyłącznie zdanie własne (`say`), więc goły napis ani tekst obcy się nie
 * kompiluje; `extra` to pola ciał odmów z kontraktu, dopisane po `message`.
 */
export function sendError(
  res: ServerResponse, status: number, error: string, sentence: OwnText, extra?: ErrorExtra,
): void {
  writeJson(res, status, { ...errorBody(error, sentence), ...extra });
}

/** Błąd z wyjątku: status od wołającego, ciało wyłącznie z {@link errorBodyOf}. */
export function sendFailure(res: ServerResponse, status: number, err: unknown, policy: ErrorPolicy = 'generic'): void {
  writeJson(res, status, errorBodyOf(status, err, policy));
}

// ---------------------------------------------------------------------------
// Pomocnicze: ciało requestu
// ---------------------------------------------------------------------------

type BodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too-large' | 'io-error' };

/**
 * Twardy sufit czasu na odebranie CAŁEGO ciała requestu.
 *
 * `server.requestTimeout` jest wyzerowany, bo obejmuje też GET-y SSE (te mają wisieć godzinami),
 * więc limit musi siedzieć tam, gdzie faktycznie czytamy ciało. Bez niego jeden POST dosyłany
 * po bajcie trzymałby gniazdo bez końca — a po 413 serwer w nieskończoność zasysałby i wyrzucał
 * ciało, które już odrzucił.
 *
 * 180 s to zapas na REALNĄ wysyłkę z kiepskiego LTE (≈1 Mb/s to ~20 MB), a nie na „kiedyś się
 * doczyta". Sufit ciała (120 MB) jest DUŻO wyższy niż to, co zdąży
 * dojść po 1 Mb/s — i tak ma być: on chroni pamięć procesu przed jednym wielkim żądaniem,
 * a nie obiecuje, że każde żądanie tej wielkości dojedzie po dowolnym łączu. Wysyłka ucięta
 * po czasie kończy się jawnym błędem na POST, nigdy cichą wiadomością bez załącznika.
 */
export const BODY_TIMEOUT_MS = 180_000;

export function readBody(
  req: IncomingMessage, maxBytes: number, timeoutMs = BODY_TIMEOUT_MS,
): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let draining = false;
    const timer = setTimeout(() => {
      // Ani 413, ani 400 nie mają tu sensu: klient nie domówił żądania, więc nie ma czego
      // odrzucać — zrywamy gniazdo, żeby nie trzymało wątku I/O w nieskończoność.
      finish({ ok: false, reason: 'io-error' });
      req.destroy();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(result: BodyResult): void {
      if (settled) return;
      settled = true;
      // Timer zdejmujemy dopiero, gdy nie zostaje nic do dopilnowania: po 413 wciąż odsączamy
      // resztę ciała i to sączenie musi mieć swój koniec.
      if (!draining) clearTimeout(timer);
      resolve(result);
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Zwalniamy to, co już zebraliśmy, i dalsze bajty tylko wyrzucamy (`resume`).
        // Nie zrywamy gniazda — klient ma dostać 413, a nie ECONNRESET — ale sączenie
        // jest ograniczone tym samym timerem co całe czytanie.
        chunks.length = 0;
        draining = true;
        finish({ ok: false, reason: 'too-large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('close', () => { clearTimeout(timer); });
    req.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false, reason: 'io-error' });
    });
  });
}

/** Etykieta limitu do komunikatu 413 (64 kB / 12 MB — bez ułamków, bo limity są okrągłe). */
function formatByteLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${String(Math.round(bytes / (1024 * 1024)))} MB`
    : `${String(Math.round(bytes / 1024))} kB`;
}

/**
 * Ponowne sprawdzenie poświadczenia PO odczycie ciała, per żądanie.
 *
 * Bramka routera sprawdza klucz urządzenia na wejściu, a ciało przychodzi potem — po kawałku, nawet
 * minutami (`BODY_TIMEOUT_MS`). Urządzenie odpięte w tym czasie nie może dokończyć „jeszcze jednej” akcji:
 * zarejestrować tokenu APNs z powrotem, zatwierdzić dialogu, wysłać promptu. Dlatego bramka rejestruje tu
 * sprawdzenie dla klienta `device`, a {@link readJsonBody} — JEDYNA droga, którą router czyta ciało
 * (wprost albo przez `readValidatedBody`) — woła je synchronicznie zaraz po ostatnim bajcie. Od tej chwili
 * do początku akcji trasy nie ma `await` (parsowanie i schemat są synchroniczne). `false` = odpowiedź
 * 401 już poszła.
 */
const bodyRechecks = new WeakMap<IncomingMessage, (res: ServerResponse, moment?: string) => boolean>();

/**
 * The same device check again, later in a route: after an `await` that may outlast a revocation (a short-lived key
 * from a foreign API). `false` = the 401 is already sent, and the route drops what it got. A public path has no check.
 */
export function recheckDevice(req: IncomingMessage, res: ServerResponse, moment: string): boolean {
  const recheck = bodyRechecks.get(req);
  return recheck === undefined || recheck(res, moment);
}

/**
 * Czyta ciało jako JSON. Przy błędzie sama wysyła odpowiedź (413/400, albo 401 przy kluczu urządzenia
 * odpiętym w trakcie odczytu ciała — {@link bodyRechecks}) i zwraca `null`.
 *
 * Zwracamy opakowany wynik, bo samo `null` byłoby nie do odróżnienia od ciała `null`.
 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<{ value: unknown } | null> {
  const body = await readBody(req, maxBytes);
  const recheck = bodyRechecks.get(req);
  if (recheck !== undefined && !recheck(res)) return null;
  if (!body.ok) {
    if (body.reason === 'too-large') {
      sendError(
        res, 413, 'payload-too-large', say('rest.payload-too-large', { limit: formatByteLimit(maxBytes) }),
      );
    } else {
      sendError(res, 400, 'bad-request', say('rest.body-unreadable'));
    }
    return null;
  }
  try {
    return { value: JSON.parse(body.text === '' ? '{}' : body.text) as unknown };
  } catch {
    sendError(res, 400, 'bad-json', say('rest.bad-json'));
    return null;
  }
}

/** Sprawdza kształt ciała schematem; niezgodność = 400 wysłane na miejscu. */
export function parseBody<S extends ZodType>(
  res: ServerResponse,
  schema: S,
  value: unknown,
): z.infer<S> | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    sendError(res, 400, 'bad-request', say('rest.body-contract'));
    return null;
  }
  return result.data;
}

/**
 * Czyta i waliduje ciało JSON. Przy błędzie sama wysyła odpowiedź (413/400) i zwraca null,
 * żeby handlery pozostały płaskie.
 */
export async function readValidatedBody<S extends ZodType>(
  req: IncomingMessage,
  res: ServerResponse,
  config: RarogConfig,
  schema: S,
  /** Własny sufit ciała — dziś tylko notatki (patrz `NOTES_BODY_MAX_BYTES`). */
  maxBytes = 0,
): Promise<z.infer<S> | null> {
  const body = await readJsonBody(req, res, maxBytes > 0 ? maxBytes : config.maxBodyBytes);
  if (body === null) return null;
  return parseBody(res, schema, body.value);
}

// ---------------------------------------------------------------------------
// Pomocnicze: błędy managera
// ---------------------------------------------------------------------------

/**
 * Mapuje wyjątek z managera na status HTTP.
 *
 * `ManagerApi` nie deklaruje klas błędów, więc rozpoznajemy je po `err.code` albo `err.name`
 * (manager rzuca `NotFoundError` / `BadStateError` / `BadRequestError`). Reszta to 500.
 */
export function managerErrorStatus(err: unknown): number {
  const e = err as { code?: unknown; name?: unknown } | null;
  // Odmowa bramki ultracode ma własny kod, z którego etykieta nie zgadnie statusu.
  if (e?.code === ULTRACODE_REFUSED_ERROR) return 400;
  const tag = String(e?.code ?? e?.name ?? '').toLowerCase().replace(/[_\s-]/g, '');
  if (tag.includes('notfound')) return 404;
  if (tag.includes('badrequest')) return 400;
  // Throttle wysyłki do panelu herdr: 429, a nie 400 — „poczekaj i wyślij to samo",
  // a nie „ta wiadomość nigdy nie przejdzie".
  if (tag.includes('toomanyrequests')) return 429;
  if (tag.includes('badstate') || tag.includes('conflict')) return 409;
  // Sesja zamknięta — 410 zamiast 409, bo klientowi nie ma sensu próbować ponownie.
  if (tag.includes('gone')) return 410;
  return 500;
}

/** Zdanie ogólne statusu (`rest.*`): gdy wyjątek nie niesie zdania albo trasa nie pokazuje treści wyjątku. */
function genericErrorBody(status: number): ErrorBody {
  if (status === 400) return errorBody('bad-request', say('rest.bad-request'));
  if (status === 404) return errorBody('not-found', say('rest.session-not-found'));
  if (status === 409) return errorBody('bad-state', say('rest.bad-state'));
  if (status === 410) return errorBody('gone', say('rest.session-closed'));
  if (status === 429) return errorBody('too-many-requests', say('rest.too-many-requests'));
  return errorBody('internal', say('rest.internal'));
}

/**
 * Jak trasa mówi o wyjątku managera:
 * - `generic` — tylko zdanie ogólne statusu (treść wyjątku nie wychodzi);
 * - `message` — wysyłka wiadomości, decyzje, cykl życia sesji: 400/409/410/429 niosą zdanie wyjątku;
 * - `model` — zmiana modelu i trybu: własne kody `busy` i `gone` arkusza modelu;
 * - `diff` — trasy diffa per plik: kody z {@link DIFF_FAILURES}, potem jak `message`.
 */
export type ErrorPolicy = 'generic' | 'message' | 'model' | 'diff';

/** Zdanie niesione przez wyjątek (pole `sentence` klas błędów) albo `undefined`, gdy go nie ma albo jest puste. */
function sentenceOf(err: unknown): AnyText | undefined {
  const sentence = (err as { sentence?: unknown } | null)?.sentence;
  return isAnyText(sentence) && textOf(sentence) !== '' ? sentence : undefined;
}

/**
 * JEDYNY budowniczy ciała błędu `{error, message}` z wyjątku.
 *
 * `message` wychodzi wyłącznie ze zdania wyjątku (pole `sentence`), nigdy z `err.message`: wyjątek bez zdania (Node,
 * biblioteka, nieznana klasa) dostaje zdanie ogólne statusu, więc treść wyjątku serwera nie wyjdzie do klienta.
 *
 * Polityka `message`: 400/409/429 niosą zdanie WPROST z managera, bo dla sesji herdr to jedyna droga, żeby człowiek
 * dowiedział się, DLACZEGO jego zdanie nie poszło do panelu („prefiks `!` jest zablokowany", „panel poza
 * RAROG_HERDR_ROOTS", „za szybko"). Ogólne „Request rejected." zostawiałoby użytkownika z pustym composerem i bez
 * wyjaśnienia. 404 i 500 idą ogólną ścieżką.
 *
 * Polityka `model`: 409 i 410 niosą zdanie managera („Agent pracuje — zmień model, gdy skończy turę."), bo arkusz
 * modelu pokazuje je dosłownie; 400 też jest copy dla człowieka („Model sesji herdr zmieniasz w terminalu."), a 429 to
 * ten sam throttle, co przy wysyłce (`/model` JEST wysyłką do panelu) — „poczekaj", a nie „nie wolno".
 */
export function errorBodyOf(status: number, err: unknown, policy: ErrorPolicy = 'generic'): ErrorBody {
  if (policy === 'generic') return genericErrorBody(status);
  const code = (err as { code?: unknown } | null)?.code;
  if (policy === 'diff') {
    const failure = diffFailureOf(err);
    if (failure !== undefined && typeof code === 'string') return errorBody(code, failure.sentence);
    if (status === 404) return errorBody(DIFF_SESSION_NOT_FOUND_ERROR, say('rest.session-not-found'));
  }
  const sentence = sentenceOf(err);
  if (policy === 'model') {
    if (status === 400 && sentence !== undefined) return errorBody('bad-request', sentence);
    if (status === 409) return errorBody('busy', sentence ?? say('rest.session-busy'));
    if (status === 410) return errorBody('gone', sentence ?? say('rest.session-closed'));
    if (status === 429 && sentence !== undefined) return errorBody('too-many-requests', sentence);
    return genericErrorBody(status);
  }
  if (sentence === undefined || status === 500 || status === 404) return genericErrorBody(status);
  // Zużyty `clientMessageId` ma WŁASNY kod — `bad-state` znaczy „spróbuj później", a ten
  // identyfikator nie przejdzie już nigdy (klient potrzebuje nowego).
  if (status === 409 && code === CLIENT_ID_CONFLICT_ERROR) return errorBody(CLIENT_ID_CONFLICT_ERROR, sentence);
  // Bramka startu z ultracode: własny kod, bo `bad-request` apka pokazuje przy polu ścieżki.
  if (status === 400 && code === ULTRACODE_REFUSED_ERROR) return errorBody(ULTRACODE_REFUSED_ERROR, sentence);
  return errorBody(genericErrorBody(status).error, sentence);
}

/**
 * Odmowy kolektorów diffa per plik: kod z wyjątku → status i zdanie dla człowieka.
 *
 * Tabela, a nie `managerErrorStatus`: tamta funkcja zgaduje status po fragmencie etykiety
 * (`diff-file-not-found` trafiłby w 404 przypadkiem, `git-failed` w 500), a te trasy mają
 * kontrakt na KOD — apka po nim odróżnia „lista się zmieniła" od „spróbuj ponownie".
 */
const DIFF_FAILURES: Readonly<Record<string, { status: number; sentence: OwnText }>> = {
  [DIFF_BAD_PATH_ERROR]: { status: 400, sentence: say('rest.diff-bad-path') },
  [DIFF_FILE_NOT_FOUND_ERROR]: {
    status: 404, sentence: say('rest.diff-file-not-found'),
  },
  [DIFF_GIT_FAILED_ERROR]: { status: 503, sentence: say('rest.diff-git-failed') },
};

function diffFailureOf(err: unknown): { status: number; sentence: OwnText } | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && Object.hasOwn(DIFF_FAILURES, code) ? DIFF_FAILURES[code] : undefined;
}

/**
 * Status błędu tras `GET …/diff/files` i `GET …/diff/file`; ciało składa {@link errorBodyOf} z polityką `diff`.
 *
 * Poza tabelą {@link DIFF_FAILURES} zostają błędy managera, wspólne z resztą tras sesji:
 * - nieznana sesja → 404 z WŁASNYM kodem `session-not-found`. Kod `not-found` zostaje dla
 *   odpowiedzi routera „Nie ma takiego endpointu.", więc klient nie pomyli braku sesji z brakiem
 *   trasy;
 * - wpis Codexa i sesja poza zasięgiem → 400 `bad-request` ze zdaniem managera, bo mówi
 *   ono, dlaczego ta karta diffa nie ma;
 * - reszta ogólną ścieżką — treść wyjątku 500 nie wychodzi do klienta.
 */
export function diffErrorStatus(err: unknown): number {
  return diffFailureOf(err)?.status ?? managerErrorStatus(err);
}

// ---------------------------------------------------------------------------
// Pomocnicze: etykieta urządzenia (pole `by` w permission-resolved)
// ---------------------------------------------------------------------------

/**
 * Krótka etykieta urządzenia do broadcastu „kto zatwierdził". Bez danych wrażliwych.
 *
 * Klient z kluczem urządzenia ma etykietę z PARowania (rekord `devices.json`) — nagłówek
 * `X-Rarog-Client` i `User-Agent` są wtedy pomijane, bo podpisuje go serwer, nie klient.
 */
export function clientLabel(req: IncomingMessage, principal?: Principal): string {
  if (principal?.kind === 'device') return principal.label.slice(0, 40);
  const explicit = req.headers['x-rarog-client'];
  const fromHeader = Array.isArray(explicit) ? explicit[0] : explicit;
  if (fromHeader !== undefined && fromHeader.trim() !== '') return fromHeader.trim().slice(0, 40);
  const ua = req.headers['user-agent'] ?? '';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'Mac';
  return 'another device';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Ścieżki dostępne bez poświadczeń. `/api/pair` jest publiczne, bo poświadczeniem JEST kod z ciała:
 * zły kod to 404 i porażka w dławiku, nigdy przejście dalej. `/api/login` jest publiczne, żeby
 * klient sprzed parowania dostał 410 `login-retired` ze zdaniem, a nie 401.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health', '/api/login', '/api/pair']);

/**
 * Kod parowania dla testów UI apki — trasa istnieje WYŁĄCZNIE w trybie demo (`config.demo`).
 * XCUITest nie ma dostępu do gniazda administracyjnego (`rarog pair`), więc demo wydaje kod „jak z Maca”: odpina
 * wszystkie urządzenia demo (każdy test paruje od zera) i oddaje `{code, expiresAt, link}`. Poza demo — 404 jak
 * każda nieznana ścieżka (za bramką poświadczeń).
 */
export const DEMO_PAIRING_PATH = '/api/demo/pairing';

export function createRouter(deps: RouterDeps): RequestHandler {
  const log = deps.logger ?? consoleLogger;
  const usageProvider = deps.usage
    ?? createUsageProvider({ logger: (line) => { log.info(line); } });
  const loginLimiter = deps.loginLimiter ?? createLoginLimiter();
  const interruptWaitMs = deps.interruptWaitMs ?? INTERRUPT_WAIT_MS;
  const { config, manager, hub, serverStartId, startedAtMs, presence, apns } = deps;
  const notes = deps.notes ?? fileNotes(config.dataDir);
  const system = deps.system ?? serverSystem();
  // Dławik pushy próbnych apki: klucz to token urządzenia.
  const apnsTestCooldown = createTestCooldown(apns?.now ?? Date.now);
  /*
   * `/health` jest PUBLICZNY (`PUBLIC_PATHS`), więc jego sonda nie może być zaproszeniem do
   * sondowania gniazda herdr: bez cache'u jeden nieuwierzytelniony GET = jedno nowe połączenie
   * do demona herdr, który steruje wszystkimi panelami. Cache jest tutaj, a nie w `supervisor`,
   * bo problem jest własnością POWIERZCHNI HTTP, nie integracji — i tutaj widzi go test routera.
   */
  const healthProbes: HealthProbes = {
    ...(deps.health ?? NO_HEALTH_PROBES),
    herdr: cacheProbe(
      () => (deps.health ?? NO_HEALTH_PROBES).herdr(),
      deps.healthProbeTtlMs === undefined ? {} : { ttlMs: deps.healthProbeTtlMs },
    ),
  };
  /*
   * Sekrety wymazywane z KAŻDEGO logowanego wyjątku (`logSecrets` w `config.ts`).
   *
   * Klucz Soniox, klucz OpenAI i klucz APNs są tej samej klasy co token aplikacji: jadą (albo podpisują to, co
   * jedzie) nagłówkiem do cudzego API, więc komunikat błędu biblioteki albo `fetch` potrafi je
   * wciągnąć do treści wyjątku razem z nagłówkiem. Klucz APNs jest na liście NIEZALEŻNIE od tego,
   * czy `pushEnabled` — wyciszony kanał (`RAROG_PUSH=0`) dalej ma klucz w configu, a to on jest tu
   * ryzykiem, nie wysyłka. Dla niego ta lista jest JEDYNĄ obroną: wymazywanie po nazwie klucza
   * (`SENSITIVE_KEY_PARTS` w `auth/redact.ts`) nie zaczepi tej nazwy.
   * Lista jest STATYCZNA, więc JWT APNs (nowy co 50 min) na niej nie ma — moduł APNs nie loguje
   * niczego poza kodem i powodem odpowiedzi.
   */
  const secrets = logSecrets(config);
  const voice = deps.voice ?? createVoiceMinter({
    apiKey: config.sonioxApiKey,
    apiHost: config.sonioxApiHost,
    enabled: config.voiceEnabled,
    minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS,
    hourlyCap: VOICE_TOKEN_HOURLY_CAP,
    system,
    log: (message) => { log.info(message); },
  });
  const companionToken = deps.companionToken ?? createCompanionTokenMinter({
    config, log: (message) => { log.info(message); },
  });
  /*
   * The voice agent works (`companionEnabled` in `GET /api/version`): the flag, the module, the OpenAI key and the
   * Soniox voice (a Soniox key from the EU region). It speaks only with the Soniox voice, so without it there is
   * no voice agent at all. The speech minter's switch holds the rest, and `companionSpeech` equals `companionEnabled`:
   * one gate for both fields and both key routes.
   */
  const companionBase = config.companionEnabled && deps.companion !== undefined && companionToken.available;
  const companionSpeechToken = deps.companionSpeechToken ?? createVoiceMinter({
    apiKey: config.sonioxApiKey,
    apiHost: config.sonioxApiHost,
    enabled: companionBase,
    minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS,
    hourlyCap: VOICE_TOKEN_HOURLY_CAP,
    system,
    log: (message) => { log.info(message); },
  }, COMPANION_SPEECH_KEY);
  const companionAvailable = companionBase && companionSpeechToken.available;
  const companionSessionsAvailable = companionAvailable && config.companionSessionsEnabled;
  const companionTurns = deps.companionTurns ?? assembleCompanionTurns(config);
  const ctx: RouteContext = {
    deps, config, manager, hub, serverStartId, startedAtMs, presence, apns, notes, system, voice, companionToken,
    companionAvailable, companionSessionsAvailable, companionTurns, companionSpeechToken, usageProvider,
    healthProbes, secrets, log, interruptWaitMs, apnsTestCooldown, loginLimiter,
  };
  const ROUTE_GROUPS: readonly RouteGroup[] = [
    routeSystem, routeTerminal, routeNotes, routeDevices, routeProjects, routeLimits, routePush, routeSessions,
  ];

  /**
   * Odmowa bramki: brak nagłówka `Authorization` (401 `unauthorized`), nieznany klucz urządzenia
   * (401 `device-unknown`, porażka w dławiku, przy wyczerpanym budżecie 429) albo klucz odpiętego
   * urządzenia (401 `device-revoked` z datą i przyczyną).
   */
  function refuse(req: IncomingMessage, res: ServerResponse, refusal: AuthRefusal): void {
    if (refusal.kind === 'missing') {
      sendError(res, 401, 'unauthorized', say('rest.device-key-missing'));
      return;
    }
    if (refusal.kind === 'device-revoked') {
      sendError(res, 401, DEVICE_REVOKED_ERROR, say('rest.device-revoked'), {
        revokedAt: refusal.revokedAt, revokedBy: refusal.revokedBy,
      });
      return;
    }
    const outcome = loginLimiter.fail(loginPeer(req), Date.now(), 'device key');
    if (outcome.logLine !== undefined) log.info(outcome.logLine);
    if (outcome.limited) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      sendError(res, 429, 'too-many-requests', say('rest.auth-rate-limited'));
      return;
    }
    sendError(res, 401, DEVICE_UNKNOWN_ERROR, say('rest.device-unknown'));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // `req.url` jest ścieżką względną; base jest sztuczny, bierzemy z niego tylko pathname.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const segments = pathname.split('/').filter((s) => s !== '');

    /*
     * --- 1. Origin check (żądania MUTUJĄCE; GET niczego nie zmienia, a bez nagłówka `Authorization` dostaje 401) ---
     *
     * `DELETE` jest tu, bo `DELETE /api/term/:id` zabija
     * powłokę, więc jest równie mutujący co POST i nie ma powodu, żeby stał poza bramką.
     * `PUT` z tej samej racji: `PUT /api/notes` nadpisuje cały dokument notatek.
     * Reguła i lista metod: `auth/origin.ts`. Odmowa na gnieździe iroh idzie do budżetu logów nasłuchu.
     */
    if (ORIGIN_CHECKED_METHODS.has(method) && !originAllowed(req, config)) {
      if (!noteIrohRefusal(req.socket, 'origin', `${method} ${pathname}`)) {
        log.info(`refused ${method} ${pathname}: origin outside the allow-list`);
      }
      sendError(res, 403, 'bad-origin', say('rest.bad-origin'));
      return;
    }

    // Demo (testy UI apki): kod parowania bez gniazda administracyjnego — przed bramką poświadczeń. Tryb
    // recenzji tej trasy nie ma: kod odpinałby wszystkich recenzentów (klasa `absent`, 404 za poświadczeniami).
    if (config.demo && config.demoReview === null && pathname === DEMO_PAIRING_PATH && deps.devices !== undefined) {
      if (method !== 'POST') {
        methodNotAllowed(res, 'POST');
        return;
      }
      await handleDemoPairing(ctx, res, deps.devices);
      return;
    }

    // --- 2. Auth (`authenticate`: ta sama granica co upgrade WebSocket terminala) ---
    let principal: Principal | undefined;
    if (!PUBLIC_PATHS.has(pathname)) {
      const auth = authenticate(req, deps.devices?.store);
      if (!auth.ok) {
        refuse(req, res, auth.refusal);
        return;
      }
      principal = auth.principal;
    }
    if (principal !== undefined) {
      const deviceId = principal.deviceId;
      bodyRechecks.set(req, (out, moment = 'while receiving the body of') => {
        const store = deps.devices?.store;
        if (store?.get(deviceId) !== undefined) return true;
        const tomb = store?.tombstone(deviceId);
        if (tomb !== undefined) {
          refuse(req, out, { kind: 'device-revoked', revokedAt: tomb.revokedAt, revokedBy: tomb.revokedBy });
        } else {
          sendError(out, 401, DEVICE_UNKNOWN_ERROR, say('rest.device-unknown'));
        }
        log.info(`devices: ${deviceId} unpaired ${moment} ${method} ${pathname} — 401`);
        return false;
      });
    }
    /** `deviceId` klucza, którym przyszło żądanie (rejestr połączeń, tokeny APNs); trasa publiczna = brak. */
    const owner = principal?.deviceId;

    /*
     * --- 2b. Tryb recenzji demo: klasa trasy (`demo/review-routes.ts`) ---
     *
     * Po poświadczeniach (bez klucza ścieżka spoza `PUBLIC_PATHS` ma już 401), przed jakąkolwiek obsługą. Domyślna
     * odmowa: przechodzą wyłącznie klasy `allow` i `retired`, a każda inna wartość, także ścieżka spoza tabeli, to
     * 404 jak nieznana. Trasa dopisana niżej bez wpisu w tabeli w trybie recenzji więc nie istnieje. Metody sprawdza
     * dalej obsługa trasy (405 jak dziś).
     */
    if (config.demoReview !== null) {
      const routeClass = classifyReviewRoute(pathname);
      if (routeClass === 'refuse') {
        sendError(res, 403, DEMO_REVIEW_ERROR, say('demo.review-refused'));
        return;
      }
      if (routeClass !== 'allow' && routeClass !== 'retired') {
        sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
        return;
      }
    }

    /*
     * --- 3. Routing: route groups of `routes/` ---
     *
     * Every group runs only here, after the Origin check (1), the credential (2) with the body recheck registered
     * for this request, and the review-mode class (2b). A group answers and returns `true`, or returns `false` for
     * a path it does not serve. The paths of different groups do not overlap, so the order is only for reading.
     */
    const rq: RouteRequest = { method, url, pathname, segments, principal, owner };
    for (const group of ROUTE_GROUPS) {
      if (await group(ctx, req, res, rq)) return;
    }

    sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
  }

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error(`unhandled router error: ${redact(err, secrets)}`);
      if (!res.headersSent) {
        sendError(res, 500, 'internal', say('rest.internal'));
      } else {
        res.end();
      }
    });
  };
}

/** 405 with `Allow`; returns `true`, so a route group can answer with `return methodNotAllowed(…)`. */
export function methodNotAllowed(res: ServerResponse, allow: string): true {
  res.setHeader('Allow', allow);
  sendError(res, 405, 'method-not-allowed', say('rest.method-not-allowed'));
  return true;
}

