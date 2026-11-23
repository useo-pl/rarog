/**
 * Kontrakt kanału zgód (warstwa 1): nazwy, wartości i kształty, które hook, serwer, pliki w `dataDir`
 * i kontrakt z apką muszą pisać tak samo, w jednym miejscu.
 *
 * Kanał zgód to podpisany plik odpowiedzi, który hook `PermissionRequest` przyjmuje: hook rejestruje sekret na
 * gnieździe rejestracji ({@link CONSENT_SOCKET_FILENAME}), serwer po decyzji z urządzenia pisze
 * `consent/<sesja>/<klucz>.json` ({@link ConsentFile}) z podpisem HMAC tym sekretem, hook przejmuje plik `rename`
 * na `.claimed`, dopiero potem go weryfikuje i oddaje `allow`, gołe `deny` z `message` albo milczy (`release`).
 * „Zatwierdzono” na karcie pada dopiero z dowodu w transkrypcie; cykl każdego klucza zapisuje serwer w rekordzie
 * `consent-records/<sesja>/<klucz>.json`.
 *
 * Moduł niesie same stałe i typy, bez kodu. Biorą z niego podpis (`sign.ts`), rejestr sekretów (`registry.ts`),
 * gniazdo rejestracji (`auth/consent-socket.ts`) i gniazdo administracyjne (`auth/admin.ts`); spójność pilnuje
 * `server/test/layer1-granica.test.ts`. Hook nie importuje TypeScriptu, więc wartości, które zna, stoją w nim
 * literałem (tak jak przy `hook/contract.ts`). Opis: `docs/dialogs.md`, „Module map”.
 */

// ── Cykl decyzji (rekord `consent-records/`)

/**
 * Stany cyklu jednego klucza, w kolejności życia karty:
 *
 * - `pending` — karta z przyciskami: żywy zrzut, przyjęta rejestracja, zgodne skróty, pełna prezentacja;
 * - `deciding` — WEWNĘTRZNY: decyzja zapisana w rekordzie, pliku odpowiedzi jeszcze nie ma (na drucie jako
 *   {@link CONSENT_DECIDING_WIRE_STATE} bez przycisków);
 * - `sent` — plik odpowiedzi leży, hook go nie przejął;
 * - `claimed` — odpowiedź ODEBRANA: hook przejął plik i podpis jest ważny (`.claimed` bez odbioru to `.rejected`);
 * - `running` — odebrana, dialog zniknął, skutku w transkrypcie jeszcze nie ma;
 * - `applied` — skutek potwierdzony transkryptem (`permissionDecision.source: hook`), with the answer signed under the
 *   registration of the record's own call (the record's `signed` against its {@link CONSENT_CALL_FIELDS} and
 *   `dumpCardSha256`, `consentAnswerProven` in `proof.ts`); an `allow` also needs the hook's receipt (`POST`
 *   {@link CONSENT_CLAIM_ROUTE}, the record's `receipt`, `consentReceiptOf`), a `deny` is given without one;
 * - `settled-at-desk` — rozstrzygnięte klawiszem w terminalu (`user_*` w transkrypcie);
 * - `unknown` — wynik bez pewnego skutku (koniec tury bez skutku, wiązanie niejednoznaczne, obcy hook, `allow` hooka
 *   bez potwierdzenia odbioru, a hook answer signed under another call);
 * - `revoked` — karta zdjęta bez skutku z telefonu (odwołany plik, martwy hook, restart, wyłącznik);
 * - `released` — prośba zwolniona do terminala (`release`): hook wyszedł bez wyniku.
 */
export const CONSENT_CYCLE_STATES = [
  'pending', 'deciding', 'sent', 'claimed', 'running', 'applied', 'settled-at-desk', 'unknown', 'revoked',
  'released',
] as const;
export type ConsentCycleState = (typeof CONSENT_CYCLE_STATES)[number];

/**
 * Tabela przejść cyklu (W-d): jedyne przejścia, które cykl robi przez `moveTo` (`cycle.ts`, `assertConsentTransition`);
 * każde inne to błąd. Protokół zapisu decyzji (`pending`, a przy `release` po zgodzie także `sent`, → `deciding` →
 * `sent`, powrót do stanu sprzed zapisu przy odmowie albo porażce zapisu) idzie poza `moveTo`, w `writeDecision`.
 * Z `deciding` wychodzi `moveTo` tylko przy odzyskiwaniu po starcie. Stan końcowy nie ma wyjścia poza `revoked`:
 * klawisz przy biurku po zdjęciu karty (`settled-at-desk`) i wynik hooka związany z kluczem po odwołaniu
 * (`unknown`, a z potwierdzeniem odbioru `applied`). `pending` → `unknown`: wywołanie karty skończyło się bez naszej
 * odpowiedzi, a wynik nie mówi, kto je rozstrzygnął (obcy hook, inne źródło, dwa identyczne wywołania).
 */
export const CONSENT_TRANSITIONS = {
  'pending': ['revoked', 'released', 'settled-at-desk', 'unknown'],
  'deciding': ['sent', 'claimed', 'released', 'revoked'],
  'sent': ['claimed', 'released', 'revoked'],
  'claimed': ['running', 'unknown', 'applied', 'settled-at-desk', 'revoked'],
  'running': ['unknown', 'applied', 'settled-at-desk'],
  'unknown': ['applied'],
  'applied': [],
  'settled-at-desk': [],
  'revoked': ['settled-at-desk', 'unknown', 'applied'],
  'released': [],
} as const satisfies Readonly<Record<ConsentCycleState, readonly ConsentCycleState[]>>;

/** Stany, których kontrakt z apką nie zna: serwer trzyma je tylko w rekordzie i w pamięci. */
export const CONSENT_INTERNAL_STATES = ['deciding'] as const satisfies readonly ConsentCycleState[];

/** Stany na drucie (`PermissionRequest.state`, `permission-settled.state`): cykl bez stanów wewnętrznych. */
export const CONSENT_WIRE_STATES = [
  'pending', 'sent', 'claimed', 'running', 'applied', 'settled-at-desk', 'unknown', 'revoked', 'released',
] as const satisfies readonly ConsentCycleState[];
export type ConsentWireState = (typeof CONSENT_WIRE_STATES)[number];

/**
 * Jak karta w stanie `deciding` jedzie na drucie: jako `sent` z `canAllow: false`. Zdarzenie `permission-settled`
 * idzie dopiero po zapisie `sent`, więc za przejście `deciding → sent` apka dostaje jedno zdarzenie.
 */
export const CONSENT_DECIDING_WIRE_STATE = 'sent' satisfies ConsentWireState;

/** Wersja rekordu cyklu `consent-records/<sesja>/<klucz>.json` (pole `v`). */
export const CONSENT_RECORD_VERSION = 1;

/** Stany końcowe cyklu: po nich klucz nie ma już karty ani pliku odpowiedzi do rozliczenia. */
export const CONSENT_FINAL_STATES = [
  'applied', 'settled-at-desk', 'revoked', 'released',
] as const satisfies readonly ConsentCycleState[];

/**
 * Stany na drucie, w których karta kanału trzyma dialog: hook czeka na plik odpowiedzi, więc karta z ekranu i jsonl
 * tego dialogu nie powstaje, a klawisz decyzji z ekranu nie idzie. Odpowiedź odebrana (`claimed`, `running`) i `unknown`
 * dialogu już nie trzymają. Jedna definicja dla portu drivera (`consentCardLive` w `server/src/index.ts`) i managera.
 */
export const CONSENT_HOLDING_STATES = ['pending', 'sent'] as const satisfies readonly ConsentWireState[];

/**
 * Przyczyny stanu `unknown` (koniec tury bez skutku albo bez jednoznacznego wiązania z wywołaniem):
 *
 * - `ambiguous-tool-use` — klucz ma kandydata, który nakładał się z innym wywołaniem tej samej nazwy i wejścia;
 * - `incomparable-input` — narzędzie spoza listy porównywalnych ({@link CONSENT_COMPARABLE_TOOLS});
 * - `no-tool-use` — w całej turze nie było wywołania, które mogłoby być tym kluczem;
 * - `no-effect` — odpowiedź odebrana, a związane wywołanie bez wyniku (MCP z interakcją, SIGKILL hooka po
 *   przejęciu, odpowiedź spóźniona wobec klawisza przy biurku) albo dialog stoi
 *   {@link CONSENT_CLAIMED_STANDING_MS} od odbioru: przy żywym hooku dowód „dialog stoi”, po wyjściu albo śmierci
 *   hooka świeży rejestr CLI `waiting` z klasą `permission` odczytany po odbiorze z zapasem rejestru i żaden inny
 *   żywy zrzut wątku głównego w sesji (`claimedDialogSignal` w `proof.ts`);
 * - `desk-unknown` — wynik związanego wywołania bez rozpoznanego źródła rozstrzygnięcia;
 * - `foreign-decision` — wynik ze źródłem `hook`, ale inną decyzją niż odebrana albo bez naszej odpowiedzi (inny
 *   hook `PermissionRequest`);
 * - `no-receipt` — wynik ze źródłem `hook` i odebranym `allow`, ale bez potwierdzenia odbioru od hooka (W-a):
 *   bez niego nie wiadomo, czy decyzję wykonała nasza odpowiedź (fail-closed, `consentReceiptOf` w `proof.ts`).
 *   An `allow` or `deny` also gets it when its answer is signed under a registration other than the call identity
 *   and card digest of the record's first dump, which binds the call, or the record lacks a field to compare
 *   (`consentAnswerProven`).
 */
export const CONSENT_UNKNOWN_CAUSES = [
  'ambiguous-tool-use', 'incomparable-input', 'no-tool-use', 'no-effect', 'desk-unknown', 'foreign-decision',
  'no-receipt',
] as const;

/** Decisions of a desk key for the devices (`permission-resolved` of a `settled-at-desk` card, `deskDecision`). */
export const CONSENT_DESK_DECISIONS = ['allow', 'allow-always', 'deny'] as const;
export type ConsentDeskDecision = (typeof CONSENT_DESK_DECISIONS)[number];
export type ConsentUnknownCause = (typeof CONSENT_UNKNOWN_CAUSES)[number];

/**
 * Przyczyny stanu `revoked` (karta zdjęta bez skutku z telefonu):
 *
 * - `claim-timeout` — plik odpowiedzi leżał {@link CONSENT_CLAIM_TIMEOUT_MS} bez przejęcia (także proces hooka
 *   zatrzymany `SIGSTOP`);
 * - `signature` — hook odłożył plik jako `.rejected`, a nowego pliku nie ma;
 * - `hook-dead` — proces hooka nie żyje albo rejestr go zapomniał;
 * - `dialog-gone` — sygnał negatywny: dialogu prośby już nie ma (rejestr CLI, transkrypt); serwer zwalnia wtedy hook
 *   podpisanym `release` (`releaseHook` w `cycle.ts`);
 * - `turn-ended` — tura skończyła się przed decyzją z telefonu; hook zwolniony jak przy `dialog-gone`;
 * - `restart` — restart serwera przed odbiorem;
 * - `off` — wyłącznik kanału (`dialogs off`);
 * - `write-failed` — zwolnienie odwołało nieprzejęty plik, a pliku `release` nie dało się zapisać (pełny dysk):
 *   hook czeka dalej, dialog zostaje w terminalu, a zapis `release` ponawia następna obserwacja z żywym zrzutem.
 */
export const CONSENT_REVOKE_CAUSES = [
  'claim-timeout', 'signature', 'hook-dead', 'dialog-gone', 'turn-ended', 'restart', 'off', 'write-failed',
] as const;
export type ConsentRevokeCause = (typeof CONSENT_REVOKE_CAUSES)[number];

/** Przyczyna w rekordzie: stanu `unknown` albo `revoked`. */
export type ConsentCause = ConsentUnknownCause | ConsentRevokeCause;

/**
 * Przyczyna powrotu prośby do biurka podpisanym `release` od serwera, w osobnym polu rekordu
 * `releaseCause` (`records.ts`), które zostaje po odbiorze przez hook i po restarcie serwera:
 *
 * - `desk-fallback` — przy trybie `all` prośba subagenta przez {@link CONSENT_SUBAGENT_GRACE_MS} bez dowodu;
 * - `desk-timeout` — nazwa zarezerwowana dla prośby z dowodem ukrytym bez decyzji z telefonu; serwer jej
 *   nie pisze;
 * - `mcp-interaction` — MCP tool with user interaction (empty `permission_suggestions`): a plain `allow` does not close
 *   its dialog (CLI 2.1.322), so the request goes back at once and the phone answers the dialog with the measured screen
 *   card.
 */
export const CONSENT_RELEASE_CAUSES = ['desk-fallback', 'desk-timeout', 'mcp-interaction'] as const;
export type ConsentReleaseCause = (typeof CONSENT_RELEASE_CAUSES)[number];

// ── Wiązanie klucza z wywołaniem (`tool_use.id`)

/**
 * Wiązanie klucza hooka z wywołaniem w transkrypcie (`PermissionRequest` nie niesie `tool_use_id`):
 *
 * - `open` — jeszcze nierozstrzygnięte (tura trwa albo przegląd transkryptu nie skończył);
 * - `bound` — w całej turze wątku klucz ma jedno wywołanie, które z żadnym innym tej samej nazwy i wejścia się
 *   nie nakładało (rekord niesie `toolUseId`);
 * - `ambiguous-tool-use` — kandydat klucza nakładał się z innym (dwa otwarte naraz), także po wyniku jednego;
 * - `incomparable-input` — narzędzie, którego wejścia hooka i transkryptu nie da się porównać.
 *
 * Dowód `applied` i `settled-at-desk` daje wyłącznie wynik wywołania `bound`.
 */
export const CONSENT_CORRELATIONS = ['open', 'bound', 'ambiguous-tool-use', 'incomparable-input'] as const;
export type ConsentCorrelation = (typeof CONSENT_CORRELATIONS)[number];

/**
 * Narzędzia porównywalne (CLI 2.1.314; `NotebookEdit` i `WebSearch` pomiar na CLI 2.1.322):
 * wejście hooka równa się zapisanemu `input` wpisu `tool_use` (`canonicalSha256` po obu stronach), więc kandydat
 * musi mieć ten sam skrót wejścia. Do tego każde narzędzie MCP ({@link CONSENT_COMPARABLE_TOOL_PREFIX}).
 * `Workflow` and `Artifact`: measured on live sessions (CLI 2.1.322, hook hash equal to the `tool_use` hash, result
 * with `permissionDecision` from `hook`).
 */
export const CONSENT_COMPARABLE_TOOLS = [
  'Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'NotebookEdit', 'WebSearch', 'Workflow', 'Artifact',
] as const;

/** Prefiks nazw narzędzi MCP: porównywalne jak {@link CONSENT_COMPARABLE_TOOLS}. */
export const CONSENT_COMPARABLE_TOOL_PREFIX = 'mcp__';

/**
 * Narzędzia wiązane po samej nazwie: CLI przekształca wejście między hookiem a wpisem (`ExitPlanMode`: plan
 * w wejściu modelu albo w pliku planu). Każde inne narzędzie to `incomparable-input`, dopóki pomiar go nie dopisze.
 */
export const CONSENT_NAME_ONLY_TOOLS = ['ExitPlanMode'] as const;

// ── Czasy cyklu

/** `sent` bez przejęcia przez tyle ms = plik odwołany, `revoked` (`claim-timeout`); tak samo po restarcie. */
export const CONSENT_CLAIM_TIMEOUT_MS = 60_000;

/** Dialog stoi tyle ms po odbiorze odpowiedzi = odbiór bez skutku, `unknown` (`no-effect`). */
export const CONSENT_CLAIMED_STANDING_MS = 30_000;

/**
 * Reguły dowodu „dialog stoi” karty wątku głównego (`RAROG_CONSENT_PROOF`, domyślnie `channel`):
 *
 * - `channel` — przycisk zgody z kanału: żywy hook z przyjętą rejestracją, pełna treść karty i świeży rejestr CLI
 *   `waiting` z klasą `permission`, bez wierzchu ekranu; termin dowodu = odczyt rejestru + `REGISTRY_MAX_AGE_MS`
 *   (`shadow/evidence.ts`). Narzędzia MCP i prośby subagentów zostają przy `screen` (`consentKeyRule` w `proof.ts`);
 * - `screen` — dowód z wierzchu ekranu: zrzut sam na wierzchu, termin {@link CONSENT_PROOF_TTL_MS} od
 *   odczytu ekranu.
 *
 * Przy `channel` bramka wersji (`version-gate.ts`) wyznacza regułę osobno dla wątku głównego i subagentów: wydanie
 * Claude Code nowsze niż zmierzone bez `pass` w pliku kanarka, wydanie nieznane albo `fail` w pliku kanarka = `screen`.
 */
export const CONSENT_PROOF_RULES = ['channel', 'screen'] as const;
export type ConsentProofRule = (typeof CONSENT_PROOF_RULES)[number];

/**
 * Termin dowodu „dialog stoi” z wierzchu ekranu (reguła `screen`) i dowodu ukrytego od chwili ROZPOCZĘCIA odczytu
 * ekranu (albo faktów) obserwacji: takt rejestru managera (`CLI_WAITING_POLL_MS` = 1,5 s w `sessions/manager.ts`)
 * i 500 ms zapasu na sufit `ps` (200 ms) i sam odczyt. Termin równy taktowi dawałby w każdym takcie lukę między
 * wygaśnięciem a następnym werdyktem. Po terminie karta nie ma przycisku zgody (`no-proof`), a `decide(allow)`
 * dostaje `card-changed`. Dowód reguły `channel` ma termin od odczytu rejestru ({@link CONSENT_PROOF_RULES}).
 */
export const CONSENT_PROOF_TTL_MS = 2_000;

/**
 * Powrót do biurka: przy trybie `all` rekord prośby subagenta w `pending`, który tyle nie miał dowodu
 * „dialog stoi”, licząc od przyjęcia rejestracji albo od utraty ostatniego dowodu, dostaje od serwera podpisane
 * `release` (`releaseCause: desk-fallback`). Czas nie biegnie, póki świeży rejestr CLI sesji mówi `waiting:
 * permission` (w sesji stoi dialog zgody, więc sesja i tak czeka przy biurku). Wartość końcowa z pomiaru na CLI
 * 2.1.319 (`docs/dialogs.md`, „`PermissionRequest` hook behavior”): wynik `async_launched` był w pliku głównym przed
 * startem hooka w 10 próbach z 10, 1,6–2,0 s wcześniej, więc reguła „2 × najdłuższe opóźnienie + 2 s” nie wchodzi;
 * gdyby weszła, dałaby 6,01 s, mniej niż 10 s.
 */
export const CONSENT_SUBAGENT_GRACE_MS = 10_000;

/**
 * Sufit puli sesji (zrzuty per wywołanie widziane w procesie, `cycle.ts`): następny kandydat ponad nim zostawia sesję
 * bez dowodu do restartu procesu. Kandydatów się nie wyrzuca, bo każdy wyrzucony mógłby stać na wierzchu ekranu.
 */
export const CONSENT_POOL_MAX = 1024;

/**
 * Sufit dodatkowych sprawdzeń `ps` w jednej obserwacji (`observe.ts`): hooki kandydatów subagenta ze znacznikiem
 * prośby, których śmierci pula jeszcze nie widziała, najdawniej sprawdzane najpierw (`hookWatch` w `cycle.ts`); reszta
 * czeka na następne obserwacje, które idą po liście w koło. Tyle samo co sufit zrzutów jednej sesji, więc obserwacja
 * pyta `ps` najwyżej o dwa razy tyle procesów co bez znaczników.
 */
export const CONSENT_HOOK_CHECKS_MAX = 64;

/** Koniec tury bez wpisu w transkrypcie: tyle ms bezczynności sesji bez otwartych wywołań. */
export const CONSENT_IDLE_TURN_END_MS = 30_000;

/** Co tyle ms przegląd transkryptu dla rekordów niedomkniętych (`claimed`, `running`, `unknown`). */
export const CONSENT_EVIDENCE_SCAN_INTERVAL_MS = 30_000;

/** Sufit bajtów jednego przebiegu przeglądu; następny przebieg zaczyna od ostatniej pełnej linii poprzedniego. */
export const CONSENT_EVIDENCE_SCAN_MAX_BYTES = 16 * 1024 * 1024;

/** Retencja rekordów `consent-records/` (jak `decisions/` trybu cienia). */
export const CONSENT_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Punkt startu przeglądu transkryptu dla rekordu niedomkniętego: plik wątku głównego, jego `inode` i bajt POCZĄTKU
 * pełnej linii, od której przegląd czyta turę (pierwsza linia tury albo `0`). Inny plik, inny `inode` albo plik
 * krótszy niż `lineStart` = przegląd od początku pliku.
 */
export interface ConsentCheckpoint {
  readonly file: string;
  readonly sessionId: string;
  readonly inode: number;
  readonly lineStart: number;
}

// ── Karta bez przycisku zgody

/**
 * Powody karty kanału bez przycisku zgody (`PermissionRequest.unavailable`):
 *
 * - `no-channel` — brak rejestracji albo żywego zrzutu dla tej prośby;
 * - `truncated` — zrzut przycięty przez hook albo prezentacja dłuższa niż {@link CONSENT_DISPLAY_MAX};
 * - `no-content` — zrzut z pustym `tool_input` (poza MCP: narzędzie MCP bez argumentów to pełna treść);
 * - `hidden-chars` — prezentacja ze znakiem ukrytym na karcie (`CARD_HIDDEN_RANGES` w `server/src/hidden-chars.ts`):
 *   kierunek pisma, zerowa szerokość, sterujące poza nową linią i tabulatorem;
 * - `card-mismatch` — `cardSha256` liczony serwerem z pełnego zrzutu różni się od rejestracji;
 * - `key-blocked` — druga rejestracja klucza z innym sekretem (fail-closed);
 * - `hook-dead` — proces hooka nie żyje;
 * - `no-proof` — brak dowodu, że dialog stoi;
 * - `server-restart` — karta sprzed restartu serwera;
 * - `terminal-only` — prośba subagenta przy trybie kanału tylko dla wątku głównego: odpowiedź w terminalu.
 */
export const CONSENT_UNAVAILABLE_REASONS = [
  'no-channel', 'truncated', 'no-content', 'card-mismatch', 'key-blocked', 'hook-dead', 'no-proof', 'server-restart',
  'terminal-only', 'hidden-chars',
] as const;
export type ConsentUnavailable = (typeof CONSENT_UNAVAILABLE_REASONS)[number];

// ── Plik odpowiedzi (`consent/`) i jego podpis

/** Decyzje w pliku odpowiedzi. `release` = hook wychodzi bez wyniku, dialog zostaje w terminalu. */
export const CONSENT_DECISIONS = ['allow', 'deny', 'release'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/**
 * Treść `message` gołego `deny` z telefonu: model kończy turę i czeka na wiadomość użytkownika
 * (`docs/dialogs.md`, „`PermissionRequest` hook behavior”). Ta sama odmowa idzie do rodzeństwa z tej samej
 * wiadomości modelu.
 */
export const CONSENT_DENY_MESSAGE = 'The user denied this from the phone. Stop and wait for the user\'s message.';

/**
 * Zamknięta lista `reasonId` pliku odpowiedzi: decyzja, do której powód należy, i tekst `message`, który hook
 * oddaje CLI. Plik niesie sam `reasonId` (w podpisie), nigdy tekstu: pole `message` w pliku czyni go nieważnym.
 * Hook trzyma te teksty literałem; lista literałów w hooku = ta lista.
 *
 * - `allow` — zgoda z urządzenia;
 * - `allow-always` — "always" from the device (`always.ts`): `allow` with `updatedPermissions` equal to the
 *   `permission_suggestions` of the hook's own stdin, whose digest the file carries ({@link CONSENT_ALWAYS_MAC_FIELDS});
 * - `phone-deny` — „Odrzuć” z urządzenia;
 * - `phone-deny-siblings` — odmowa bez karty dla kolejnej prośby tej samej sesji z tym samym `prompt_id`
 *   i `agent_id` po „Odrzuć” (rodzeństwo z jednej wiadomości modelu);
 * - `release` — zwolnienie do terminala z urządzenia albo komendą `dialogs release` na gnieździe
 *   administracyjnym.
 */
export const CONSENT_REASONS = {
  'allow': { decision: 'allow', message: null },
  'allow-always': { decision: 'allow', message: null },
  'phone-deny': { decision: 'deny', message: CONSENT_DENY_MESSAGE },
  'phone-deny-siblings': { decision: 'deny', message: CONSENT_DENY_MESSAGE },
  'release': { decision: 'release', message: null },
} as const satisfies Readonly<Record<string, { readonly decision: ConsentDecision; readonly message: string | null }>>;
export type ConsentReasonId = keyof typeof CONSENT_REASONS;

/**
 * Podkatalog `dataDir` z plikami odpowiedzi kanału: `<dataDir>/consent/<sesja>/<klucz>.json`. Serwer pisze
 * atomowo, hook przejmuje.
 */
export const CONSENT_DIRNAME = 'consent';

/**
 * Przyrostek pliku odpowiedzi po przejęciu przez hook (`rename` `<klucz>.json` → `<klucz>.claimed`). Przejęcie
 * idzie PRZED odczytem i weryfikacją: hook wykonuje wyłącznie treść przejętego pliku.
 */
export const CONSENT_CLAIMED_SUFFIX = '.claimed';

/** Przyrostek pliku odpowiedzi odwołanego przez serwer (`rename` na `<klucz>.revoked`). */
export const CONSENT_REVOKED_SUFFIX = '.revoked';

/**
 * Przyrostek przejętego pliku, którego podpis albo skróty się nie zgadzają: hook odkłada go `rename` na
 * `<klucz>.<n>.rejected` i czeka dalej, a serwer może zapisać pod tym kluczem kolejny plik.
 */
export const CONSENT_REJECTED_SUFFIX = '.rejected';

/**
 * Prefiks domeny podpisu: `mac = HMAC-SHA256(secret, CONSENT_MAC_PREFIX + pola {@link CONSENT_MAC_FIELDS}
 * złączone '|')`. Prefiks oddziela ten podpis od każdego innego użycia sekretu.
 */
export const CONSENT_MAC_PREFIX = 'rarog-consent-v1|';

/** Pola pliku odpowiedzi w wiadomości podpisu, w tej kolejności. */
export const CONSENT_MAC_FIELDS = [
  'sessionId', 'key', 'decision', 'reasonId', 'inputSha256', 'cardSha256', 'at',
] as const satisfies readonly (keyof ConsentFile)[];

/**
 * Fields of an `allow-always` answer file in the signature message, in this order: {@link CONSENT_MAC_FIELDS} and the
 * digest of the permission updates (`permissionsSha256`). A file carries the digest exactly when its `reasonId` is
 * `allow-always`, so a file of one shape never verifies as the other.
 */
export const CONSENT_ALWAYS_MAC_FIELDS = [
  ...CONSENT_MAC_FIELDS, 'permissionsSha256',
] as const satisfies readonly (keyof ConsentFile)[];

/** Długość sekretu hooka w bajtach; w ciele rejestracji jako hex (64 znaki). */
export const CONSENT_SECRET_BYTES = 32;

/**
 * Plik odpowiedzi `<dataDir>/consent/<sesja>/<klucz>.json`. Bez pola `message`: plik z nim jest nieważny.
 */
export interface ConsentFile {
  readonly key: string;
  readonly sessionId: string;
  readonly decision: ConsentDecision;
  readonly reasonId: ConsentReasonId;
  /** Pełny sha256 kanonicznego `tool_input` (jak w zrzucie per wywołanie). */
  readonly inputSha256: string;
  /** sha256 kanonicznej postaci {@link ConsentCardFields}: skrót całej karty, którą pokazał telefon. */
  readonly cardSha256: string;
  /** Epoch ms decyzji. */
  readonly at: number;
  /**
   * `allow-always` only: sha256 of the canonical `permission_suggestions` of the registration (`always.ts`), the
   * updates the hook writes. Any other `reasonId` has no such field.
   */
  readonly permissionsSha256?: string;
  /** HMAC-SHA256 hex, wiadomość według {@link CONSENT_MAC_PREFIX} i {@link CONSENT_MAC_FIELDS}. */
  readonly mac: string;
}

/**
 * Pola, z których hook i serwer liczą `cardSha256` (kanoniczna postać jak przy `inputSha256`): podmiana zrzutu
 * poza `tool_input` (inne `cwd`, tryb, subagent) zmienia skrót karty.
 */
export interface ConsentCardFields {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd: string;
  readonly agentId: string | null;
  readonly permissionMode: string | null;
}

// ── Gniazda

/**
 * Gniazdo rejestracji `<dataDir>/run/consent.sock`, w tym samym katalogu `run/` (`0o700`) co gniazdo
 * administracyjne, plik `0o600`. Ma WYŁĄCZNIE trasy {@link CONSENT_SOCKET_ROUTES}: proces z tym gniazdem może
 * najwyżej zablokować kartę obcą rejestracją, nigdy zatwierdzić ani zwolnić. Potwierdzenie odbioru
 * ({@link CONSENT_CLAIM_ROUTE}) wymaga podpisu sekretem żywego hooka i niczego nie zatwierdza: pozwala tylko hookowi
 * oddać `allow`, które serwer już podpisał. Dostęp do gniazda administracyjnego to władza właściciela.
 */
export const CONSENT_SOCKET_FILENAME = 'consent.sock';

/**
 * Trasa rejestracji na gnieździe rejestracji: `POST`, ciało {@link ConsentRegistration} do
 * {@link CONSENT_REGISTER_BODY_MAX_BYTES}. Odpowiedź {@link ConsentRegisterAccepted} albo odmowa: 409
 * (`key-blocked`, klucz zajęty innym sekretem), 429 (limity), 503 (tryb kanału albo lista sesji nie pozwala).
 * Bez przyjęcia (także bez gniazda albo trasy) hook nie czeka.
 */
export const CONSENT_REGISTER_ROUTE = '/register';

/**
 * Receipt route of the registration socket (W-a): `POST`, body {@link ConsentClaim} up to
 * {@link CONSENT_CLAIM_BODY_MAX_BYTES}. The hook sends it after it has taken and verified a signed `allow`, and gives
 * `allow` to the CLI only on {@link ConsentClaimConfirmed}. The server confirms only the record's live `allow` with
 * the same `decisionAt` and a receipt signed with the secret of the hook's live registration; the answer does not tell
 * whether the key exists when the signature is wrong. `deny` and `release` take no receipt.
 */
export const CONSENT_CLAIM_ROUTE = '/claim';

/** Wszystkie trasy gniazda rejestracji. */
export const CONSENT_SOCKET_ROUTES = [CONSENT_REGISTER_ROUTE, CONSENT_CLAIM_ROUTE] as const;

/** Trasa gniazda administracyjnego: `POST` {@link ConsentAdminRelease}, zwolnienie kart kanału do terminala. */
export const CONSENT_ADMIN_RELEASE_ROUTE = '/api/admin/dialogs/release';

/** Trasa gniazda administracyjnego: `POST`, tryb kanału `off` do restartu serwera, bez zmiany konfiguracji. */
export const CONSENT_ADMIN_OFF_ROUTE = '/api/admin/dialogs/off';

/** Trasy kanału na gnieździe administracyjnym. */
export const CONSENT_ADMIN_ROUTES = [CONSENT_ADMIN_RELEASE_ROUTE, CONSENT_ADMIN_OFF_ROUTE] as const;

/**
 * Ciało rejestracji. Hook rejestruje PRZED zapisem zrzutu z kluczem i przed linią dziennika z kluczem.
 * Sekret nie trafia nigdy do argv, env, zrzutu, dziennika, pliku ani odpowiedzi gniazda.
 */
export interface ConsentRegistration {
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  /** {@link CONSENT_SECRET_BYTES} bajtów jako hex. */
  readonly secret: string;
  readonly inputSha256: string;
  readonly cardSha256: string;
  /** PID procesu hooka i jego start (epoch ms), jak w zrzucie per wywołanie. */
  readonly pid: number;
  readonly startedAt: number;
  /** Tylko prośba subagenta. */
  readonly agentId?: string;
  /**
   * `permission_suggestions` from the hook's stdin as it carries them (up to its ceiling); the registry keeps them
   * checked (`hook/suggestions.ts`) and decides nothing on them.
   */
  readonly permissionSuggestions?: unknown;
  /**
   * Version of the "always" answer file the hook knows (`CONSENT_ALWAYS_VERSION` in `always.ts`); the hook sends it
   * only with `permissionSuggestions`. No field = a hook copy without "always": its card has no "always" option.
   */
  readonly alwaysVersion?: number;
}

/** Odpowiedź na przyjętą rejestrację. Zmiana `bootId` w `alive.json` znaczy restart serwera. */
export interface ConsentRegisterAccepted {
  readonly accepted: true;
  readonly bootId: string;
  /**
   * The second registration of a call that a record recovered after a server restart expected, equal to it in every
   * field (`expectResume` in `registry.ts`): the hook keeps waiting under the new `bootId`. No field = a first
   * registration; a hook that registered with an earlier server process then exits without a decision.
   */
  readonly resumed?: true;
}

/**
 * Body of {@link CONSENT_CLAIM_ROUTE}: the key, the `at` of the taken answer file and the receipt signature `mac`
 * (HMAC-SHA256 hex with the hook's secret over {@link CONSENT_RECEIPT_MAC_PREFIX} and
 * {@link CONSENT_RECEIPT_MAC_FIELDS}). Never the secret and never the answer file's own `mac`.
 */
export interface ConsentClaim {
  readonly key: string;
  readonly at: number;
  readonly mac: string;
}

/** Answer to a confirmed receipt: the hook may give `allow`. */
export interface ConsentClaimConfirmed {
  readonly confirmed: true;
}

/**
 * Domain prefix of the receipt signature: `mac = HMAC-SHA256(secret, CONSENT_RECEIPT_MAC_PREFIX + fields
 * {@link CONSENT_RECEIPT_MAC_FIELDS} joined with '|')`. Other than {@link CONSENT_MAC_PREFIX}, so neither signature
 * stands for the other.
 */
export const CONSENT_RECEIPT_MAC_PREFIX = 'rarog-consent-receipt-v1|';

/** Fields of the receipt signature, in this order: the session from the registration, the key and the file's `at`. */
export const CONSENT_RECEIPT_MAC_FIELDS = ['sessionId', 'key', 'at'] as const;

/** Ciało `dialogs/release`: wszystkie karty kanału sesji albo jedna po kluczu. */
export interface ConsentAdminRelease {
  readonly sessionId: string;
  readonly key?: string;
}

// ── Limity

/**
 * Ceiling of the registration body in bytes: the fields of {@link ConsentRegistration} with `permissionSuggestions` up
 * to `HOOK_SUGGESTIONS_MAX_BYTES` (`hook/suggestions.ts`) and a margin.
 */
export const CONSENT_REGISTER_BODY_MAX_BYTES = 32 * 1024;

/** Termin odpowiedzi gniazda rejestracji po stronie hooka; po nim hook nie czeka. */
export const CONSENT_REGISTER_DEADLINE_MS = 500;

/** Ceiling of the `/claim` body in bytes (the body has under 200). */
export const CONSENT_CLAIM_BODY_MAX_BYTES = 1024;

/** Hook-side deadline of the `/claim` answer; after it the hook gives no `allow`. */
export const CONSENT_CLAIM_DEADLINE_MS = 500;

/** Żywe rejestracje na sesję. */
export const CONSENT_REGISTRATIONS_PER_SESSION_MAX = 64;

/** Żywe rejestracje razem. */
export const CONSENT_REGISTRATIONS_MAX = 1024;

/**
 * Zapas ponad `timeout` hooka (`HOOK_ANSWER_TIMEOUT_S`): tyle po nim żyje rejestracja bez śmierci procesu
 * i tyle mają pliki `consent/` przed sprzątaniem przy starcie.
 */
export const CONSENT_TTL_MARGIN_MS = 10 * 60_000;

/**
 * Ceiling of the channel card's presentation in UTF-8 bytes: the hook's input ceiling (`HOOK_TOOL_INPUT_MAX_BYTES`
 * in `hook/contract.ts`, 1 MiB of compact JSON) plus 64 KiB for the card's indentation and field names, so every input
 * the hook carries whole reaches the phone whole (decision 4). A presentation over this ceiling (an input that
 * indentation inflates, such as a long array of numbers) is `truncated` and its text does not leave the server.
 * The card shows all input fields in full or has no approve button.
 */
export const CONSENT_DISPLAY_MAX = 1024 * 1024 + 64 * 1024;

// ── Rekordy cyklu

/**
 * Podkatalog `dataDir` z rekordami cyklu: `<dataDir>/consent-records/<sesja>/<klucz>.json`, pole `v` =
 * {@link CONSENT_RECORD_VERSION}. Osobny od rekordów trybu cienia, więc czytnik cienia ich nie widzi. Bez
 * `tool_input` i sekretu.
 */
export const CONSENT_RECORDS_DIRNAME = 'consent-records';

/**
 * The call identity a record takes from its first dump, as record field names: the turn (`promptId`,
 * `agentId`), the hook process (`pid`, and `hookStartedAt`, before which `bind.ts` drops results) and the input
 * digest. The binding to a transcript call reads them, and a dump is not authenticated, while the hook's registration
 * is. So a decision keeps the registration's value of each field (the record's `signed`) and `applied` needs each one
 * equal to the record's (`consentAnswerProven` in `proof.ts`). The key and the session are the registration's by the
 * registry lookup the signature needs, and the tool name is attested by the first dump's card digest
 * (`dumpCardSha256`). A field the record takes from a dump joins this list
 * (`server/test/layer1-binding-registration.test.ts` checks it).
 */
export const CONSENT_CALL_FIELDS = ['promptId', 'agentId', 'pid', 'hookStartedAt', 'inputSha256'] as const;
export type ConsentCallField = (typeof CONSENT_CALL_FIELDS)[number];
