/**
 * Kontrakt hooka treści po stronie serwera: nazwy, które serwer i `scripts/hooks/rarog-pending.mjs` muszą pisać
 * tak samo, w jednym miejscu.
 *
 * Hook działa jako osobny proces Claude Code i nie importuje TypeScriptu, więc każda nazwa stoi dwa razy: tutaj
 * i jako literał w `.mjs`. Zgodności pilnuje `server/test/hook-contract.test.ts`, który czyta literały z pliku
 * hooka. Katalogu danych tu nie ma: jego reguła to osobny kontrakt (`shared/src/data-dir.mjs`, demo ma własny
 * katalog). Instalacja hooka (blok ustawień, znacznik „hook żyje”, korzenie) stoi w `herdr/hook-config.ts`.
 *
 * TRYB CIENIA. Hook przy `PermissionRequest` (poza `AskUserQuestion`) pisze zrzut PER WYWOŁANIE
 * (`pending/<sesja>/<klucz>.json`, {@link HookCallDump}) obok zrzutu per sesja i czyta `<dataDir>/alive.json`
 * ({@link HookAliveFile}). Czeka WYŁĄCZNIE, gdy `alive.json` jest świeży, tryb to {@link HOOK_CHANNEL_MODE_SHADOW},
 * `send` prawdziwy, sesja stoi na liście, a prośba nie ma `agent_id`; inaczej sprząta swój zrzut i kończy
 * jak dziś.
 * Czekający hook przejmuje plik cienia `<dataDir>/shadow/<sesja>/<klucz>.json` ({@link HookShadowFile})
 * `rename` na `<klucz>.claimed` i wychodzi BEZ WYNIKU (pusty stdout, kod 0); `<klucz>.revoked` (serwer odwołał)
 * też kończy czekanie bez wyniku. Cały cykl hook dopisuje do `<dataDir>/shadow.jsonl` ({@link HookShadowLogEntry}).
 * Opis: `docs/dialogs.md`, „Permission hook”, „Per-call dump and shadow mode”.
 *
 * KANAŁ ZGÓD (warstwa 1). W trybie `main` (prośba bez `agent_id`) albo `all` z {@link HOOK_ALIVE_MODES} hook
 * nie czeka na plik cienia, tylko rejestruje sekret na gnieździe kanału zgód i czeka na podpisany plik odpowiedzi
 * (`scripts/hooks/consent.mjs`; nazwy i podpis w `layer1/contract.ts`). Ten sam dziennik niesie cały cykl: linie
 * `odrzucony` za każdy przejęty plik nieważny i powody kanału z {@link HOOK_SHADOW_REASONS}.
 *
 * ZNACZNIK PROŚBY. Gdy `alive.json` niesie `markers: true` (i tryb `main` albo `all`), hook
 * przy tej samej prośbie zostawia `<dataDir>/markers/<sesja>/<nazwa>.json` ({@link HookMarkerFile}) PRZED wyborem
 * drogi i nigdy go nie kasuje: serwer wie z niego o prośbie także wtedy, gdy hook wyszedł bez czekania. Klucz per
 * wywołanie hook losuje raz, wspólny dla znacznika, zrzutu per wywołanie i rejestracji kanału zgód.
 *
 * W sesji programowej ({@link HOOK_PROGRAMMATIC_ENTRYPOINT}) hook nie robi nic z powyższego.
 *
 * Poza nazwami moduł ma dwie bramki trybu ({@link consentChannelOpen}, {@link consentSubagentsOpen}): jedyną
 * definicję tego, który tryb otwiera kanał zgód w serwerze (hook ma własne literały w `.mjs`), i wydanie CLI, na którym
 * zmierzono zachowanie hooka, od którego zależy reguła dowodu `channel` ({@link CONSENT_CHANNEL_MEASURED_CLI}).
 */
import type { HookSuggestions } from './suggestions.ts';

/**
 * Zdarzenie prośby o zgodę: odpala się, gdy CLI postanowi zapytać, ale nie czeka, aż dialog stanie
 * na ekranie (w kolejce „1 of 2” i u subagenta w tle odpala się dla każdej prośby od razu, `docs/dialogs.md`).
 * Jedyne, w którym hook czeka na odpowiedź z Raroga albo na plik cienia.
 */
export const HOOK_PERMISSION_REQUEST_EVENT = 'PermissionRequest';

/** Zdarzenie przed wywołaniem narzędzia: hook bierze je wyłącznie dla {@link HOOK_QUESTION_TOOL}. */
export const HOOK_PRE_TOOL_USE_EVENT = 'PreToolUse';

/** Narzędzie formularza pytania: jedyne z `PreToolUse`, z dłuższym TTL zrzutu i z kanałem odpowiedzi. */
export const HOOK_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Podkatalog `dataDir` ze zrzutami hooka: per sesja `<dataDir>/pending/<sesja>.json` i per wywołanie
 * `<dataDir>/pending/<sesja>/<klucz>.json`. Hook pisze, Rarog czyta.
 */
export const HOOK_PENDING_DIRNAME = 'pending';

/**
 * Ceiling of the serialized `tool_input` in the hook's dumps, in UTF-8 bytes (`TOOL_INPUT_MAX_BYTES` in the hook).
 * Above it every dump carries the truncation marker `{rarogTruncated: true, preview}` instead of the input.
 */
export const HOOK_TOOL_INPUT_MAX_BYTES = 1024 * 1024;

/** Podkatalog `dataDir` z plikami odpowiedzi (`<dataDir>/answers/<sesja>/`): Rarog pisze, hook czyta. */
export const HOOK_ANSWERS_DIRNAME = 'answers';

/**
 * Pola payloadu hooka (stdin), które czyta `rarog-pending.mjs`, z wersją CLI pomiaru. Hook bierze je
 * literałem `payload['…']`; zbiór literałów w hooku = wartości tego rejestru
 * (`server/test/hook-contract.test.ts`).
 * Po aktualizacji CLI pomiar wejścia hooka (`docs/dialogs.md`, „PermissionRequest hook behavior”) odświeża
 * wersję.
 */
export const HOOK_PAYLOAD_FIELDS = {
  event: { field: 'hook_event_name', cli: '2.1.311' },
  session: { field: 'session_id', cli: '2.1.311' },
  prompt: { field: 'prompt_id', cli: '2.1.311' },
  mode: { field: 'permission_mode', cli: '2.1.311' },
  tool: { field: 'tool_name', cli: '2.1.311' },
  input: { field: 'tool_input', cli: '2.1.311' },
  cwd: { field: 'cwd', cli: '2.1.311' },
  /** Tylko prośba SUBAGENTA; wątek główny pola nie ma. Obecność pola = hook nie czeka w trybie cienia. */
  agent: { field: 'agent_id', cli: '2.1.311' },
  /** Tylko `PreToolUse`; `PermissionRequest` pola nie ma. */
  toolUseId: { field: 'tool_use_id', cli: '2.1.251' },
  /**
   * Permission updates offered with the dialog (`PermissionRequest`; `ExitPlanMode` has none). The consent channel
   * carries them as data in the registration and the per-call dump (`hook/suggestions.ts`); only the MCP marker of an
   * empty list counts, and it only takes the allow button away.
   */
  suggestions: { field: 'permission_suggestions', cli: '2.1.322' },
} as const;

/**
 * Wydanie CLI, na którym zmierzono precyzję przycisku zgody z kanału bez wierzchu ekranu: późne
 * `allow` hooka po decyzji przy biurku (po „Yes”, po „No” i SIGTERM; `Bash`, `Write`) nic nie wykonuje. To nie literał
 * pliku hooka, tylko fakt o jego zachowaniu w CLI: sesja, której jedyny proces ma w odczycie rejestru tej obserwacji
 * wyższe wydanie, liczy dowód regułą `screen`, chyba że plik kanarka ma dla tego wydania `pass` (bramka wersji
 * `layer1/version-gate.ts`). Ta stała to baza z paczki: obowiązuje też bez pliku kanarka. Wersję podbija
 * dopiero pomiar późnego `allow` wątku głównego na nowym CLI z tym samym wynikiem (`docs/dialogs.md`,
 * „PermissionRequest hook behavior”).
 */
export const CONSENT_CHANNEL_MEASURED_CLI = { cli: '2.1.325' } as const;

/**
 * Programmatic Claude Code sessions: the environment variable the hook inherits from the CLI process, and the
 * values at which the hook exits right after reading stdin, without a trace (no dump, `hook-seen.json`,
 * `shadow.jsonl`, `guard.jsonl`, waiting or guard refusal). The variable is neither in the payload nor in the Claude
 * Code docs. Measured on CLI `cli`: `claude -p` without the variable or with an inherited `cli` gives the hook
 * `sdk-cli`, an interactive session gives `cli`, and an interactive session keeps an inherited `sdk-cli`. `sdk-ts`
 * and `sdk-py` (Agent SDK clients) are unmeasured. After a CLI update the measurement (`docs/dialogs.md`,
 * "PermissionRequest hook behavior") refreshes the version. The hook takes the name and the values as literals;
 * `server/test/hook-contract.test.ts` checks they are equal.
 */
export const HOOK_PROGRAMMATIC_ENTRYPOINT = {
  env: 'CLAUDE_CODE_ENTRYPOINT',
  values: ['sdk-cli', 'sdk-ts', 'sdk-py'],
  cli: '2.1.314',
} as const;

/**
 * Plik życia serwera: `<dataDir>/alive.json`, {@link HookAliveFile}. Serwer pisze (co 10 s i przy każdej zmianie
 * trybu, `send` albo listy sesji), hook czyta przy KAŻDYM odpytaniu. Brak, uszkodzony albo stęchły plik = hook nie
 * czeka (fail-closed).
 */
export const HOOK_ALIVE_FILENAME = 'alive.json';

/** Wiek `ts` w `alive.json`, powyżej którego (w obie strony zegara) hook nie czeka i przestaje czekać. */
export const HOOK_ALIVE_MAX_AGE_MS = 30_000;

/**
 * `phase` of {@link HookAliveFile}: a server process from its first write until its first write with a session after
 * its effective mode is resolved, only with a restart grace. A hook that starts on it waits for the channel
 * ({@link HOOK_RESTART_GRACE_DEFAULT_MS} from the file's `ts`) instead of taking the shadow path (`docs/dialogs.md`,
 * "Restart break").
 */
export const HOOK_ALIVE_PHASE_STARTING = 'starting';

/**
 * Restart grace G: how long after a server stop a hook that starts in the break waits for the next server's
 * channel. The default of `RAROG_CONSENT_RESTART_GRACE` (twice the longest measured stop-to-session-list window,
 * 22.4 s) and the hook's G when it sees only {@link HOOK_ALIVE_PHASE_STARTING}, without the old server's `stop`.
 */
export const HOOK_RESTART_GRACE_DEFAULT_MS = 45_000;

/** Ceiling of G: the server refuses a larger `RAROG_CONSENT_RESTART_GRACE`, the hook ignores a larger `stop`. */
export const HOOK_RESTART_GRACE_MAX_MS = 600_000;

/**
 * Odstęp odpytywania hooka (plik odpowiedzi, plik cienia, `alive.json`): zwolnienie trwa najwyżej tyle plus
 * odczyt.
 */
export const HOOK_POLL_MS = 250;

/** Tryb kanału zgód: hook nie czeka nigdy (domyślny; tak samo brak `alive.json`). */
export const HOOK_CHANNEL_MODE_OFF = 'off';

/** Tryb kanału zgód: hook czeka na plik cienia dla prośby wątku głównego i wychodzi bez wyniku. */
export const HOOK_CHANNEL_MODE_SHADOW = 'shadow';

/**
 * Tryb kanału zgód: kanał (podpisany plik odpowiedzi) dla prośby wątku głównego, bez `agent_id`; prośba subagenta
 * zostaje w terminalu. Serwer wpisuje go w `alive.json` wyłącznie jako tryb EFEKTYWNY (`layer1/mode.ts`), czyli
 * przy komplecie warunków; konfiguracja `main` bez nich daje `shadow`.
 */
export const HOOK_CHANNEL_MODE_MAIN = 'main';

/**
 * Tryb kanału zgód: kanał dla każdej prośby, także z `agent_id`. Te same warunki trybu efektywnego co
 * {@link HOOK_CHANNEL_MODE_MAIN}; prośba subagenta bez dowodu wraca do biurka podpisanym `release`
 * (`layer1/cycle.ts`).
 */
export const HOOK_CHANNEL_MODE_ALL = 'all';

/** Tryby, które przyjmuje konfiguracja serwera (`config.ts`) i które serwer wpisuje w `alive.json`. */
export const HOOK_CHANNEL_MODES = [
  HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODE_SHADOW, HOOK_CHANNEL_MODE_MAIN, HOOK_CHANNEL_MODE_ALL,
] as const;
export type HookChannelMode = (typeof HOOK_CHANNEL_MODES)[number];

/**
 * Tryby, które ta wersja hooka rozumie w `alive.json`: te same co {@link HOOK_CHANNEL_MODES}. Każdy inny napis
 * w `mode` = hook nie czeka (`tryb-nieznany`).
 */
export const HOOK_ALIVE_MODES = [
  HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODE_SHADOW, HOOK_CHANNEL_MODE_MAIN, HOOK_CHANNEL_MODE_ALL,
] as const;
export type HookAliveMode = (typeof HOOK_ALIVE_MODES)[number];

/**
 * Bramka trybu (5.1): kanał zgód jest otwarty dla prośby wątku głównego (`main` albo `all`). Jedyne
 * miejsce, w którym kod porównuje tryb z `main`; każda bramka kanału w serwerze idzie przez tę funkcję albo
 * {@link consentSubagentsOpen}. Napis spoza listy, `null` i brak = zamknięty.
 */
export function consentChannelOpen(mode: string | null | undefined): boolean {
  return mode === HOOK_CHANNEL_MODE_MAIN || mode === HOOK_CHANNEL_MODE_ALL;
}

/** Bramka trybu (5.1): kanał zgód jest otwarty także dla prośby subagenta (wyłącznie `all`). */
export function consentSubagentsOpen(mode: string | null | undefined): boolean {
  return mode === HOOK_CHANNEL_MODE_ALL;
}

/** Podkatalog `dataDir` z plikami cienia (`<dataDir>/shadow/<sesja>/<klucz>.json`): serwer pisze, hook przejmuje. */
export const HOOK_SHADOW_DIRNAME = 'shadow';

/** Przyrostek pliku cienia po przejęciu przez hook (`rename` `<klucz>.json` → `<klucz>.claimed`). */
export const HOOK_SHADOW_CLAIMED_SUFFIX = '.claimed';

/** Przyrostek pliku cienia odwołanego przez serwer (`rename` na `<klucz>.revoked`); hook kończy czekanie. */
export const HOOK_SHADOW_REVOKED_SUFFIX = '.revoked';

/**
 * Dziennik cyklu hooka w trybie cienia: `<dataDir>/shadow.jsonl`, linia = {@link HookShadowLogEntry}. Hook tylko
 * DOPISUJE (jeden zapis `O_APPEND` na linię, jak `guard.jsonl`); rotacja należy do serwera. Bez treści
 * `tool_input`.
 */
export const HOOK_SHADOW_LOG_FILENAME = 'shadow.jsonl';

/** Długość nonce'a klucza per wywołanie W BAJTACH: klucz = `<prompt_id>-<32 znaki hex>`. */
export const HOOK_CALL_NONCE_BYTES = 16;

/**
 * Wzorzec klucza per wywołanie: `prompt_id` (wzorzec identyfikatora sesji, do 128 znaków), `-`, 32 znaki hex.
 * Klucz jest NAZWĄ PLIKU zrzutu i pliku cienia; serwer sprawdza go tym wzorcem przed `join`.
 */
export const HOOK_CALL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}-[0-9a-f]{32}$/;

/**
 * Podkatalog `dataDir` ze znacznikami prośby: `<dataDir>/markers/<sesja>/<nazwa>.json`, {@link HookMarkerFile}. Hook
 * pisze (plik 0600 w katalogu 0700, plik tymczasowy i `rename`) i nigdy nie kasuje; sprząta serwer.
 */
export const HOOK_MARKERS_DIRNAME = 'markers';

/**
 * Przedrostek nazwy znacznika prośby bez klucza per wywołanie (`prompt_id` nie nadaje się na nazwę pliku): nazwa
 * `anon-<pid>-<startedAt>` (PID i start procesu hooka, epoch ms), pole `key: null`.
 */
export const HOOK_MARKER_ANON_PREFIX = 'anon-';

/**
 * Wzorzec nazwy znacznika bez klucza (bez `.json`). Nie pasuje do {@link HOOK_CALL_KEY_PATTERN} (koniec to cyfry
 * dziesiętne startu, nie 32 znaki hex), więc nazwa znacznika jednoznacznie mówi, czy jest klucz.
 */
export const HOOK_MARKER_ANON_PATTERN = /^anon-[1-9][0-9]{0,9}-[0-9]{1,16}$/;

/**
 * Rodzaje linii {@link HOOK_SHADOW_LOG_FILENAME}: każdy cykl ma jedną `start` i (poza SIGKILL) jedną `wyjscie`.
 * `odrzucony` pisze wyłącznie kanał zgód, raz na każdy przejęty plik odpowiedzi, który nie przeszedł weryfikacji.
 * `pauza`: the hook started in a restart break and waits for the channel (at most once per cycle, before the route),
 * or a registered hook saw a break while it waited and pauses (once per break). After such a pause a registration the
 * next server resumed gives another `czekam` with that server's `bootId`.
 */
export const HOOK_SHADOW_LOG_EVENTS = [
  'start', 'pauza', 'czekam', 'bez-czekania', 'odbior', 'odrzucony', 'sygnal', 'wyjscie',
] as const;
export type HookShadowLogEvent = (typeof HOOK_SHADOW_LOG_EVENTS)[number];

/**
 * Powody w polu `powod` linii `bez-czekania` i `wyjscie`:
 *
 * - `straznik` — odmowa formy strażnika wysokości (bez zrzutu per wywołanie, bez czekania);
 * - `klucz` — brak `prompt_id` o kształcie identyfikatora (klucz niepoliczalny, bez zrzutu per wywołanie);
 * - `skrot` — moduł `canon.mjs` nie załadował się albo rzucił (bez zrzutu per wywołanie);
 * - `zrzut` — zapis zrzutu per wywołanie nie powiódł się;
 * - `obciety` — `tool_input` ponad sufit zrzutu (zrzut z markerem przycięcia);
 * - `subagent` — prośba z `agent_id`;
 * - `alive-brak`, `alive-zly`, `alive-ts` — `alive.json` nie ma, ma zły kształt albo `ts` poza
 *   {@link HOOK_ALIVE_MAX_AGE_MS};
 * - `tryb-off`, `tryb-nieznany` — w trybie cienia tryb inny niż {@link HOOK_CHANNEL_MODE_SHADOW}; `tryb-nieznany`
 *   także w kanale zgód, gdy w czasie czekania `mode` wypadnie z {@link HOOK_ALIVE_MODES};
 * - `send` — `send` nie jest `true` (killswitch wysyłki);
 * - `sesja` — sesji nie ma na liście `sessions`;
 * - `modul` — kanał zgód: moduł `consent.mjs` nie załadował się albo rzucił (bez zrzutu per wywołanie);
 * - `rejestracja` — kanał zgód: gniazdo nie przyjęło sekretu (brak gniazda, odmowa, termin; zrzut bez czekania);
 * - `podpis`, `karta-inna` — tylko w linii `odrzucony`: przejęty plik odpowiedzi ma zły kształt, pole `message`,
 *   zły podpis, obce powiązanie albo stary `at` (`podpis`) albo inne `inputSha256` lub `cardSha256` (`karta-inna`);
 * - `release` — kanał zgód: ważny plik `release`, wyjście bez decyzji (tylko `wyjscie`);
 * - `restart` — kanał zgód: `bootId` w `alive.json` inny niż w odpowiedzi rejestracji (tylko `wyjscie`); after a
 *   pause in a restart break also a second registration the next server did not resume (`szczegol`: its HTTP status,
 *   `accepted` without `resumed`);
 * - `tryb-nizszy` — kanał zgód: tryb spadł poniżej tego, w którym hook się zarejestrował (`off`, `shadow` albo
 *   `main` przy prośbie z `agent_id`; tylko `wyjscie`);
 * - `odbior` — hook przejął plik cienia albo ważny plik odpowiedzi kanału zgód z decyzją (tylko `wyjscie`);
 * - `potwierdzenie` — consent channel: a valid `allow` without the server's receipt (`POST /claim`: a refusal, the
 *   deadline, a server or module without the route); exit without a decision (only `wyjscie`, with `szczegol`);
 * - `przerwa` — the restart break ended without the next server's channel (`stop.ts` plus G passed; a hook that
 *   started in it exits after the per-session dump, without a per-call dump), or a registered hook's pauses reached
 *   2G together;
 * - `odwolane` — leży `<klucz>.revoked` (tylko `wyjscie`);
 * - `sufit` — minął czas z `--answer-wait` (tylko `wyjscie`);
 * - `sygnal` — SIGTERM, SIGINT albo SIGHUP (tylko `wyjscie`);
 * - `blad` — wyjątek poza przewidzianymi ścieżkami (tylko `wyjscie`).
 */
export const HOOK_SHADOW_REASONS = [
  'straznik', 'klucz', 'skrot', 'zrzut', 'obciety', 'subagent', 'alive-brak', 'alive-zly', 'alive-ts', 'tryb-off',
  'tryb-nieznany', 'send', 'sesja', 'odbior', 'odwolane', 'sufit', 'sygnal', 'blad', 'modul', 'rejestracja', 'podpis',
  'karta-inna', 'release', 'restart', 'tryb-nizszy', 'potwierdzenie', 'przerwa',
] as const;
export type HookShadowReason = (typeof HOOK_SHADOW_REASONS)[number];

/**
 * `<dataDir>/alive.json` — pisze serwer, czyta hook. Pola poza `markers` wymagane; brak któregoś z nich albo inny
 * kształt = `alive-zly`.
 */
export interface HookAliveFile {
  /** Epoch ms zapisu. */
  readonly ts: number;
  /** Identyfikator startu serwera (niepusty napis); hook tylko go loguje. */
  readonly bootId: string;
  /** Tryb kanału zgód ({@link HOOK_ALIVE_MODES}; inny napis = hook nie czeka). */
  readonly mode: string;
  /** Killswitch wysyłki (`RAROG_HERDR_SEND`); hook czeka tylko przy `true`. */
  readonly send: boolean;
  /** `session_id` sesji obserwowanych przez serwer; sesja spoza listy nie czeka. */
  readonly sessions: readonly string[];
  /**
   * Znaczniki prośby ({@link HookMarkerFile}): hook pisze je wyłącznie przy dosłownym `true`. Pole opcjonalne: brak
   * (serwer bez znaczników, hook sprzed znaczników go nie czyta) albo inna wartość to „bez znacznika”, nie
   * `alive-zly`.
   */
  readonly markers?: boolean;
  /**
   * Restart break, written only with a restart grace G above 0 (`RAROG_CONSENT_RESTART_GRACE`): the stop write of a
   * normal server stop carries `{ts, graceMs}` (the stop time and G in ms). A hook that starts before `ts + graceMs`
   * waits for the channel until then instead of exiting; a `rarog dialogs off` or a server without a grace writes no
   * field, so hooks exit as before. Optional: an older hook does not read it.
   */
  readonly stop?: { readonly ts: number; readonly graceMs: number };
  /**
   * {@link HOOK_ALIVE_PHASE_STARTING} from the process's first write until its first write with a session after its
   * effective mode is resolved, only with a grace G above 0; a hook that starts on it waits like on `stop`. No field
   * otherwise.
   */
  readonly phase?: typeof HOOK_ALIVE_PHASE_STARTING;
}

/**
 * Zrzut per wywołanie `<dataDir>/pending/<sesja>/<klucz>.json` — pisze hook (0600, katalog 0700, tmp + `rename`),
 * kasuje ten sam hook przy każdym wyjściu (best effort). Istnieje więc, dopóki żyje proces, który go napisał.
 */
export interface HookCallDump {
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  /**
   * PID procesu hooka i jego start (epoch ms, `Date.now() − uptime`): para odróżnia proces od PID-u użytego
   * ponownie.
   */
  readonly pid: number;
  readonly startedAt: number;
  /** Tylko prośba subagenta. */
  readonly agentId?: string;
  readonly permissionMode?: string;
  readonly toolName: string;
  /** `tool_input` albo marker przycięcia `{rarogTruncated: true, preview}` (jak w zrzucie per sesja). */
  readonly toolInput: unknown;
  readonly cwd: string;
  /** Epoch ms zapisu zrzutu. */
  readonly at: number;
  /** Pełny sha256 kanonicznego `tool_input` z payloadu (także przy przycięciu: skrót całości, nie podglądu). */
  readonly inputSha256: string;
  /**
   * `permission_suggestions` after the server's check (`parseHookSuggestions`). The file carries the stdin value; no
   * field when stdin had none, the hook dropped it over its ceiling (an older hook, shadow mode too) or the check
   * dropped it. Data only.
   */
  readonly permissionSuggestions?: HookSuggestions;
  /**
   * The MCP marker (`mcpEmptySuggestions` in `hook/suggestions.ts`): an MCP tool with an empty suggestion list. A raw
   * fact of the hook's stdin, without a conclusion about the dialog; the card has no allow button with it.
   */
  readonly mcpEmptySuggestions?: true;
}

/**
 * Znacznik prośby `<dataDir>/markers/<sesja>/<nazwa>.json` . Hook pisze go przy
 * `PermissionRequest` narzędzia innego niż {@link HOOK_QUESTION_TOOL}, po walidacji `session_id`, `cwd` i korzeni
 * i po skrócie kanonu, PRZED wyborem drogi: strażnik wysokości, tryb cienia, kanał zgód, rejestracja, przycięcie
 * i każde wyjście bez czekania. Bramka: `alive.json` w poprawnym kształcie ze świeżym `ts`, sesja na liście, tryb
 * `main` albo `all` i `markers: true` ({@link HookAliveFile}); inaczej znacznika nie ma.
 *
 * Nazwa = klucz per wywołanie ({@link HOOK_CALL_KEY_PATTERN}), ten sam co w zrzucie per wywołanie i w rejestracji
 * kanału zgód; bez klucza `anon-<pid>-<startedAt>` ({@link HOOK_MARKER_ANON_PATTERN}). Hook znacznika nigdy nie
 * kasuje, a błąd zapisu połyka. Znacznik nie mówi, że dialog stoi: hook pisze go przed strażnikiem, więc także dla
 * prośby, której dialogu nie będzie. Pola jak w {@link HookCallDump}, bez `permissionMode`.
 */
export interface HookMarkerFile {
  /** Klucz per wywołanie; `null` przy nazwie `anon-…` (taki kandydat nigdy nie ma dowodu własnego). */
  readonly key: string | null;
  readonly sessionId: string;
  /** `prompt_id` prośby z kluczem; `null` przy nazwie `anon-…`. */
  readonly promptId: string | null;
  /** PID procesu hooka i jego start (epoch ms), jak w zrzucie per wywołanie. */
  readonly pid: number;
  readonly startedAt: number;
  /** Tylko prośba subagenta (niepusty napis), jak w zrzucie per wywołanie. */
  readonly agentId?: string;
  readonly toolName: string;
  /** `tool_input` albo marker przycięcia `{rarogTruncated: true, preview}`, z tym samym sufitem co zrzut. */
  readonly toolInput: unknown;
  readonly cwd: string;
  /** Epoch ms zapisu znacznika. */
  readonly at: number;
  /** Pełny sha256 kanonicznego `tool_input` (całości, także przy przycięciu); `null` przy błędzie `canon.mjs`. */
  readonly inputSha256: string | null;
}

/**
 * Plik cienia `<dataDir>/shadow/<sesja>/<klucz>.json` — pisze serwer przy decyzji z telefonu dla prośby, której
 * zrzut per wywołanie widzi. Hook przejmuje każdy plik pod swoim kluczem i wychodzi bez wyniku; pola porównuje
 * wyłącznie do dziennika (`zgodny` w linii `odbior`), bo w trybie cienia plik niczego nie rozstrzyga.
 *
 * Zapis atomowy: plik tymczasowy w tym samym katalogu (nazwa NIE kończy się na `.json`), potem `rename` na
 * `<klucz>.json`. Hook przejmuje plik `rename`-em od razu, więc plik pisany wprost mógłby zostać przejęty pusty.
 * Pliki `.claimed`, `.revoked` i nieprzejęte `.json` po wyjściu hooka sprząta serwer.
 */
export interface HookShadowFile {
  readonly key: string;
  readonly sessionId: string;
  /** Decyzja z telefonu; w dzienniku hooka inna wartość to `?`. */
  readonly decision: 'allow' | 'deny';
  /** Skrót treści, którą pokazała karta; równy `inputSha256` zrzutu = `zgodny`. */
  readonly inputSha256: string;
  /** Epoch ms zapisu. */
  readonly at: number;
}

/** Linia `<dataDir>/shadow.jsonl`. Pola poza `at`, `ev`, `pid`, `sessionId` zależą od rodzaju linii. */
export interface HookShadowLogEntry {
  readonly at: number;
  readonly ev: HookShadowLogEvent;
  readonly pid: number;
  readonly sessionId: string;
  /** Klucz per wywołanie, od chwili, gdy jest policzony. */
  readonly key?: string;
  /** `start`: nazwa narzędzia (wzorzec identyfikatora, inaczej `?`), `prompt_id`, czy subagent, tryb uprawnień. */
  readonly toolName?: string;
  readonly promptId?: string;
  readonly subagent?: boolean;
  readonly permissionMode?: string;
  /** `bez-czekania`, `wyjscie`, `odrzucony`. */
  readonly powod?: HookShadowReason;
  /** `czekam` w kanale zgód: tryb z `alive.json` ({@link HOOK_ALIVE_MODES}), w którym hook się zarejestrował. */
  readonly tryb?: string;
  /**
   * Kanał zgód: `odrzucony` — powód weryfikacji (`CONSENT_VERIFY_FAILURES` w `layer1/sign.ts`); `odbior` —
   * `reasonId` pliku; `bez-czekania` z powodem `rejestracja` — status HTTP odmowy, `socket`, `deadline` albo
   * `response`; `wyjscie` with the reason `potwierdzenie` — the receipt's HTTP status, `socket`, `deadline`,
   * `response` or `modul`; `wyjscie` with the reason `restart` after a pause — the second registration's HTTP
   * status or `accepted`; `pauza` — what started the break: `stop` or `starting`. Nigdy sekret.
   */
  readonly szczegol?: string;
  /** `odrzucony`: numer kolejny przejętego pliku nieważnego w tym cyklu (przyrostek `<klucz>.<n>.rejected`). */
  readonly n?: number;
  /**
   * `czekam` i `wyjscie` z weta `alive.json` (plik w poprawnym kształcie: `alive-ts`, `tryb-off`, `tryb-nieznany`,
   * `send`, `sesja`): `bootId` i `ts` odczytanego pliku. Przy `tryb-off` po czekaniu `aliveTs` to chwila zapisu
   * `mode: "off"`, więc `at − aliveTs` mierzy wyjście po zmianie flagi (audyt cienia).
   */
  readonly bootId?: string;
  readonly aliveTs?: number;
  /** `czekam`: sha256 kanonicznego `tool_input` (ten sam co w zrzucie per wywołanie). */
  readonly inputSha256?: string;
  /**
   * `odbior`: decyzja z pliku cienia (`allow`, `deny`, inaczej `?`) i zgodność klucza, sesji i skrótu; w kanale
   * zgód decyzja ważnego pliku (`allow`, `deny`, `release`), bez `zgodny`.
   */
  readonly decyzja?: string;
  readonly zgodny?: boolean;
  /** `odbior`, `sygnal`, `wyjscie`: ms od startu procesu hooka. */
  readonly ms?: number;
  /** `wyjscie`: czy hook czekał. */
  readonly czekal?: boolean;
  /** `sygnal`: nazwa sygnału. */
  readonly sygnal?: string;
}
