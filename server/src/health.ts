/**
 * /health — jedyny endpoint bez auth (watchdog na VPS pyta o niego co 5 min, `restart.sh`
 * kończy nim każdy start).
 *
 * Beyond "the process lives" it carries two booleans: `herdr` (the socket answers `ping`) and `term` (the PTY
 * terminal is assembled). Without them "OK" after a restart would only mean that Node started — Rarog without herdr
 * shows an empty list and a banner, an emergency state a green health must not hide. `hook` says whether the content
 * hook is REGISTERED in the Claude Code settings and when it last fired: a consent card falling back to the screen
 * version after a reinstall of the herdr integration (the same settings file) is silent otherwise. It also says
 * whether the executed COPY in `~/.claude/hooks/rarog/` matches `scripts/hooks/` in the repo (`stale` when not).
 *
 * `authStore` says whether the device key store (`devices.json`) loaded (`broken` = the file and its copy are
 * unreadable, every device pairs again — `rarog doctor` shows it).
 *
 * `sdk` mówi, czy SDK Claude, z którego idzie lista „Ostatnie sesje”, załadował się przy starcie (`install/sdk.ts`):
 * bez niego apka widzi pustą listę bez wyjaśnienia, więc sygnał ma `/health`, log startu i `rarog doctor`.
 *
 * `consent` to tryb kanału zgód (`herdr/dialogs/layer1/mode.ts`): skonfigurowany, efektywny i powód, bez chwili
 * zmiany. Stan konfiguracji i startu jak `hook`, a nie aktywność: zmienia się tylko przy rozstrzygnięciu po starcie
 * gniazd i przy wyłączniku (`rarog dialogs off`).
 *
 * The fields go only to a loopback caller ({@link fullHealthAllowed}): a TCP request whose `Host` names the
 * loopback address on the server's own port and which carries no proxy header. Every other caller (iroh, a foreign
 * `Host` after DNS rebinding, a peer through a proxy) learns only that the server runs, `{"ok":true}`, and no probe
 * runs for it. `/health` stays outside the device key, so the watchdog and the CLI read it without one.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { ConsentModeState } from './herdr/dialogs/layer1/mode.ts';
import type { SdkState } from './install/sdk.ts';
import { isIrohSocket } from './iroh/socket.ts';

/**
 * Stan rejestracji hooka treści — słownik ten sam, co w `pnpm run hooks:doctor`:
 * `ok` (zainstalowany blok jest dokładnie tym, który drukuje `hooks:print`, a kopia kodu hooka
 * zgadza się z repo), `missing` (ani jednego wpisu Raroga), `mismatch` (wpis jest, ale INNY —
 * ścieżka do innego checkoutu, brak `timeout`, matcher z poprzedniej wersji) i `stale`
 * (wpis poprawny, ale kopia w `~/.claude/hooks/rarog/` różna od repo, brakująca, dowiązana albo
 * nieczytelna; naprawia ją `pnpm run hooks:install`). Fail-closed: czego nie umiemy
 * przeczytać, tego nie ogłaszamy jako `ok`.
 */
export type HookStatus = 'ok' | typeof HOOK_STATUS_MISSING | 'mismatch' | 'stale';

/**
 * Stan `missing` z {@link HookStatus}: wartość pola `hook` w `/health` i w `hooks doctor`. Producenci (sonda, doctor)
 * i czytelnicy w kodzie (`rarog doctor`, `rarog setup`) biorą ją stąd.
 */
export const HOOK_STATUS_MISSING = 'missing';

/** Odpowiedź sondy hooka: stan rejestracji + wiek ostatniego zrzutu (`null` = nigdy). */
export interface HookHealth {
  readonly status: HookStatus;
  /** Sekundy od ostatniego odpalenia hooka (znacznik `hook-seen.json`). */
  readonly seenAgo: number | null;
  /**
   * Sekundy od ostatniego odpalenia per plik wejściowy kopii (`hook-seen.<plik>.json`); brak pola = brak
   * znaczników per plik. Tak jak `seenAgo` żyje wyłącznie za uwierzytelnieniem (`GET /api/version`), nigdy w `/health`.
   */
  readonly seenAgoByFile?: Readonly<Record<string, number>>;
}

/** Nic nie wiemy o hooku = nie ma go. Ta sama zasada, co przy sondach herdr/term. */
export const HOOK_HEALTH_UNKNOWN: HookHealth = { status: HOOK_STATUS_MISSING, seenAgo: null };

export interface HealthPayload {
  ok: true;
  version: string;
  /** Uptime procesu serwera w sekundach (zaokrąglony w dół). */
  uptime: number;
  /** Gniazdo herdr odpowiedziało na `ping` (w limicie czasu). Demo i brak integracji: `false`. */
  herdr: boolean;
  /**
   * Terminal PTY jest złożony: `RAROG_TERM=1` ORAZ moduł terminala się załadował
   * (backend = panel herdr). Policzony RAZ przy starcie (to wynik `loadTerm` z entry),
   * nie per request — te warunki nie zmieniają się bez restartu procesu.
   */
  term: boolean;
  /**
   * Rejestracja hooka treści w `~/.claude/settings.json` — STAN KONFIGURACJI, stały
   * między restartami tak samo jak `herdr` i `term`.
   *
   * Wieku ostatniego odpalenia (`hookSeenAgo`) tu NIE MA i mieć nie może:
   * `/health` jest w `PUBLIC_PATHS`, a znacznik `hook-seen.json` pisze się przy KAŻDYM dialogu
   * w każdej sesji Claude pod korzeniami Raroga — także przy biurku i w projektach, których
   * Rarog nie pokazuje. Rozdzielczość 1 s dawała nieuwierzytelnionemu peerowi tailnetu profil
   * „kiedy i jak gęsto ten człowiek zatwierdza narzędzia". Pole żyje za kluczem urządzenia,
   * w `GET /api/version`.
   */
  hook: HookStatus;
  /**
   * Magazyn kluczy urządzeń: `ok` albo `broken` (oba pliki nieczytelne przy starcie — pusty
   * magazyn). Stan z chwili startu, stały do restartu.
   */
  authStore: AuthStoreStatus;
  /**
   * SDK Claude listy sesji (`ok`, `stale`, `missing`, `error`; {@link SdkState}): stan z chwili startu, stały do
   * restartu. Demo SDK nie ładuje: `missing`.
   */
  sdk: SdkState;
  /**
   * Tryb kanału zgód ({@link ConsentHealth}); brak pola = serwer bez źródła trybu (testy, router bez sondy) albo
   * sonda rzuciła. Nigdy chwila zmiany: `since` zostaje w pamięci serwera.
   */
  consent?: ConsentHealth;
}

/** Tryb kanału zgód w `/health`: skonfigurowany, efektywny i powód (`layer1/mode.ts`). */
export type ConsentHealth = Pick<ConsentModeState, 'configured' | 'effective' | 'reason'>;

/** Stan magazynu kluczy urządzeń w `/health`. */
export type AuthStoreStatus = 'ok' | 'broken';

/** Sondy wstrzykiwane przez entry; router bez nich (testy, brak integracji) mówi `false`. */
export interface HealthProbes {
  /**
   * Ping gniazda herdr — herdr żyje i umiera niezależnie od Raroga, więc wynik ma TERMIN
   * WAŻNOŚCI, a nie jest liczony raz przy starcie. Router NIE woła tego per request:
   * opakowuje sondę w {@link cacheProbe}, patrz {@link HEALTH_PROBE_TTL_MS}.
   */
  herdr(): Promise<boolean>;
  /** Wynik złożenia terminala z chwili startu (patrz {@link HealthPayload.term}). */
  term: boolean;
  /**
   * Rejestracja hooka treści — czyta pliki, więc jest OPCJONALNA i wołający ma ją
   * opakować w cache (`/health` jest publiczny). Brak sondy = `missing`, tak jak brak pingu
   * herdr znaczy `false`. Wyjątek sondy jest łapany w {@link healthPayload}: health ma
   * odpowiadać ZAWSZE, a niedostępny plik ustawień nie jest awarią serwera.
   */
  hook?: () => HookHealth;
  /** Stan magazynu kluczy urządzeń; brak sondy = `ok` (serwer bez magazynu nie ma czego zepsuć). */
  authStore?: () => AuthStoreStatus;
  /** Stan SDK z chwili startu; brak = `missing` (nic nie wiemy = nic nie obiecujemy). */
  sdk?: SdkState;
  /** Tryb kanału zgód teraz (`ConsentModeSource.current`); brak sondy albo wyjątek = brak pola `consent`. */
  consent?: () => ConsentModeState;
}

/** Fail-closed dla brakujących sond: nic nie wiemy = nic nie obiecujemy. */
export const NO_HEALTH_PROBES: HealthProbes = {
  herdr: () => Promise.resolve(false),
  term: false,
};

/**
 * Sufit czasu na ping herdr. Zdrowy herdr odpowiada w pojedynczych milisekundach; sufit jest
 * na przypadek half-open (gniazdo istnieje, serwer nie odpowiada) — health ma odpowiadać
 * szybko i mówić `false`, a nie wisieć do timeoutu socketu (2 s connect + 5 s request),
 * bo `restart.sh` odpytuje go z własnym `-m` i uciąłby połączenie w połowie.
 */
export const HEALTH_HERDR_TIMEOUT_MS = 1_500;

/**
 * Termin ważności wyniku pingu herdr — bariera między `/health` a gniazdem, które steruje WSZYSTKIMI panelami tmux
 * użytkownika. Only a loopback caller runs the probe at all; the TTL bounds what a local loop costs.
 *
 * `/health` stoi w `PUBLIC_PATHS` (watchdog na VPS pyta o niego co 5 min bez poświadczeń), a jego
 * obsługa woła `supervisor.ping()`. Bez terminu każdy nieuwierzytelniony
 * GET otwierałby jedno nowe połączenie do `herdr.sock` („jedno żądanie na połączenie", nagłówek
 * `herdr/socket.ts`). Wywrócenia integracji z tego nie byłoby (`MAX_INFLIGHT = 8` ogranicza liczbę
 * gniazd niezależnie od ruchu HTTP), ale zostałaby amplifikacja „tani GET = connect do demona"
 * i head-of-line blocking własnych odczytów Raroga w kolejce `waiting`, którą peer z tailnetu
 * dosięga bez żadnego poświadczenia (`docs/security-model.md`, „Emergency runbook”, akapit o `/health`).
 *
 * 2 s to kompromis z `restart.sh`: pętla health odpytuje co sekundę, więc nieświeży wynik
 * kosztuje najwyżej jeden dodatkowy obrót, a `herdr` przestaje być zaproszeniem do sondowania.
 */
export const HEALTH_PROBE_TTL_MS = 2_000;

/**
 * Sonda z terminem ważności i pojedynczym lotem.
 *
 * Dwa niezależne mechanizmy, oba potrzebne: TTL ścina ruch rozłożony w czasie, a wspólna
 * obietnica (`inFlight`) ścina SZCZYT — sto równoległych żądań daje jeden ping, nie sto.
 * Błąd sondy nie jest cache'owany jako wynik dłużej niż TTL, bo `probeWithTimeout` zamienia
 * go na `false`, a `false` też ma prawo się zestarzeć (herdr wraca po restarcie).
 */
export function cacheProbe(
  probe: () => Promise<boolean>,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<boolean> {
  const ttlMs = opts.ttlMs ?? HEALTH_PROBE_TTL_MS;
  const now = opts.now ?? ((): number => Date.now());
  let value: boolean | null = null;
  let freshUntil = 0;
  let inFlight: Promise<boolean> | null = null;
  return async (): Promise<boolean> => {
    if (value !== null && now() < freshUntil) return value;
    inFlight ??= probe().then(
      (result) => {
        value = result;
        freshUntil = now() + ttlMs;
        inFlight = null;
        return result;
      },
      (error: unknown) => {
        // Wyjątek NIE zostaje w cache'u: `probeWithTimeout` wyżej i tak zamieni go na `false`,
        // a zapamiętanie porażki na TTL opóźniłoby powrót herdr o dwie sekundy bez powodu.
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };
}

/**
 * Wyścig sondy z zegarem: timeout i WYJĄTEK sondy znaczą to samo — „herdr nie odpowiada".
 * Timer jest sprzątany w `finally`, żeby nie trzymać pętli zdarzeń po szybkiej odpowiedzi.
 */
async function probeWithTimeout(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false); }, timeoutMs);
  });
  try {
    return await Promise.race([probe().catch(() => false), clock]);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer of `/health` to a caller without the fields: the server runs, nothing more. */
export const HEALTH_ALIVE = { ok: true } as const;

/**
 * Headers a proxy adds. `Host` is the client's to write and a proxy may pass it on unchanged (Tailscale serve, read
 * from its source, not measured), so a request with any of them, or with any `Tailscale-*` header, came from elsewhere
 * whatever its `Host` says.
 */
const PROXY_HEADERS: ReadonlySet<string> = new Set(['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip']);
const PROXY_HEADER_PREFIX = 'tailscale-';

/** What {@link fullHealthAllowed} reads of a request; an `IncomingMessage` fits. */
export interface HealthRequest {
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly localPort?: number | undefined };
}

/**
 * The request may read the fields of `/health`: not an iroh socket, `Host` (any case) exactly
 * `127.0.0.1:<port>` or `localhost:<port>` for the socket's own local port (on port 80 also without the port, which
 * `fetch` leaves out), and no proxy header. A foreign `Host` (DNS rebinding, a tailnet name) or no `Host` at all is
 * not the loopback caller. A proxy that rewrites `Host` to the loopback address and adds none of the headers passes;
 * the security model names that remainder.
 */
export function fullHealthAllowed(req: HealthRequest): boolean {
  if (isIrohSocket(req.socket)) return false;
  const port = req.socket.localPort;
  const host = req.headers.host?.toLowerCase();
  if (port === undefined || host === undefined) return false;
  const loopback = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  if (port === 80) loopback.push('127.0.0.1', 'localhost');
  if (!loopback.includes(host)) return false;
  return !Object.keys(req.headers).some((name) => {
    const lower = name.toLowerCase();
    return PROXY_HEADERS.has(lower) || lower.startsWith(PROXY_HEADER_PREFIX);
  });
}

/**
 * @param version wersja serwera (`config.version`)
 * @param startedAtMs znacznik startu procesu (Date.now() z entry)
 * @param probes sondy readiness; domyślnie {@link NO_HEALTH_PROBES}
 * @param opts zegar i sufit pingu — wstrzykiwane, żeby test nie zależał od zegara
 */
export async function healthPayload(
  version: string,
  startedAtMs: number,
  probes: HealthProbes = NO_HEALTH_PROBES,
  opts: { nowMs?: number; herdrTimeoutMs?: number } = {},
): Promise<HealthPayload> {
  const nowMs = opts.nowMs ?? Date.now();
  const uptime = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const herdr = await probeWithTimeout(
    () => probes.herdr(), opts.herdrTimeoutMs ?? HEALTH_HERDR_TIMEOUT_MS,
  );
  // Sonda hooka czyta pliki (ustawienia Claude Code, znacznik w `dataDir`) — brak praw,
  // zepsuty JSON albo znikający plik nie mają prawa zamienić `/health` w 500.
  const hook = readHookHealth(probes);
  const consent = readConsentHealth(probes);
  return {
    ok: true,
    version,
    uptime,
    herdr,
    term: probes.term,
    hook: hook.status,
    authStore: probes.authStore?.() ?? 'ok',
    sdk: probes.sdk ?? 'missing',
    ...(consent === null ? {} : { consent }),
  };
}

/** Tryb kanału zgód z sondy bez chwili zmiany; brak sondy albo wyjątek = `null`. */
function readConsentHealth(probes: HealthProbes): ConsentHealth | null {
  try {
    const state = probes.consent?.();
    return state === undefined ? null : { configured: state.configured, effective: state.effective, reason: state.reason };
  } catch {
    return null;
  }
}

/**
 * Sonda hooka opakowana tak, żeby wyjątek nigdy nie wyszedł na zewnątrz — ta sama zasada, co
 * w {@link healthPayload}: niedostępny plik ustawień nie jest awarią serwera.
 *
 * Osobna funkcja, bo `hookSeenAgo` żyje ZA AUTH (`GET /api/version`), a `hook`
 * dalej na publicznym `/health` — jedno źródło prawdy dla obu czytelników.
 */
export function readHookHealth(probes: HealthProbes): HookHealth {
  try {
    return probes.hook?.() ?? HOOK_HEALTH_UNKNOWN;
  } catch {
    return HOOK_HEALTH_UNKNOWN;
  }
}
