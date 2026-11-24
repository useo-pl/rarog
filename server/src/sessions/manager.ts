/**
 * Manager sesji — jedyne miejsce, w którym spotykają się driver, maszyna stanów, pending
 * decyzje, rejestr na dysku i broadcast do SSE.
 *
 * Kontrakt publiczny to `ManagerApi` (`manager-api.ts`) — router i SSE kodują
 * wyłącznie przeciw niemu. `createManager()` zwraca `Manager`, czyli `ManagerApi` poszerzone
 * o `ready` / `flush()` / `dispose()`, których potrzebują testy i cykl życia procesu.
 *
 * Reguły, które ten plik utrzymuje (spec):
 * - stan liczy WYŁĄCZNIE `transition()` — nigdzie indziej nie przypisujemy `state` ręcznie
 *   (jedyny wyjątek: seedy demo, które fabrykują przeszłość),
 * - domknięte eventy sesji dostają `seq` z ring buffera; delty mają `seq === null` i nie wchodzą
 *   do bufora (nie przesuwają `Last-Event-ID`),
 * - `state` i `session-changed` idą do scope `'global'` ORAZ do scope sesji,
 * - decyzje: first-wins (200 / 409 / 410); interrupt / close / restart wygasza pending
 *   z broadcastem `decision: 'expired'`,
 * - eventy drivera po zamknięciu sesji są odrzucane (wyścig „delta po done").
 */
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_MODEL_CHOICE, DIFF_BAD_PATH_ERROR, DIFF_FILE_NOT_FOUND_ERROR, FALLBACK_MODEL_CHOICES,
  MAX_ANSWER_TEXT_CHARS, MAX_RECENT_PROJECTS,
  MAX_RECENT_SESSIONS,
  EXIT_PLAN_MODE_TOOL,
  MAX_RESUMABLE_SESSIONS, MODEL_CHANGE_WARNING, ULTRACODE_CHANGE_NOTE, messageAttachments,
} from '@rarog/shared';
import type {
  Activity, CommandList, CreateSessionResponse, DiffFileList, DiffFilePatch,
  EffortLevel, FileAttachment,
  HerdrMode, HerdrStatus, MessageAttachment, ModelList, PermissionRequest,
  PermissionSubject, Question,
  ModeCycleTarget, QuestionRequest, RecentProject, ResumableSession, ServerEvent, SessionDiff,
  SessionModeResponse, SessionModelResponse, SessionSummary,
  TranscriptMessage, TranscriptNotice, WaitingFor,
} from '@rarog/shared';
import type { QueueTakeBackResponse, ServerSystem } from '@rarog/shared/rest';
import {
  type AnyText, type ForeignText, type OwnText, foreign, say,
  sentenceOfArglessRef,
} from '@rarog/shared/sentences';
import { isFallbackLabel, nextFallbackLabel } from './fallback-label.ts';
export { isFallbackLabel, nextFallbackLabel };
import type {
  CreateSessionOptions, ManagerApi, RestartOptions, SendMessageAck, SendMessageOptions,
} from './manager-api.ts';
import { MAX_TURNS_DETAIL, transition } from './state-machine.ts';
import type { SmEvent } from './state-machine.ts';
import type { NotifierLike } from '../notify/index.ts';
import { Session, wireStateDetail } from './session.ts';
import type { MessageExtra } from './session.ts';
import {
  BadRequestError, BadStateError, NotFoundError, TooManyRequestsError,
} from './errors.ts';
import { createSendRegistry, sendDigest } from './send-registry.ts';
import type { SendRegistry } from './send-registry.ts';
import {
  DECISION_STATES, DRIVER_ERROR_DETAIL,
  DRIVER_GONE_DETAIL, HERDR_ALLOW_MESSAGE, HERDR_CODEX_CLOSE_MESSAGE,
  HERDR_FOCUS_MESSAGE, HERDR_GONE_DETAIL, HERDR_HIDDEN_DETAIL, HERDR_LAUNCHING_DETAIL,
  HERDR_LAUNCH_OFF_MESSAGE, HERDR_LOST_PROMPT_MESSAGE, HERDR_MODEL_MESSAGE, HERDR_MODE_BYPASS_MESSAGE,
  HERDR_MODE_MESSAGE, HERDR_NOT_OWNED_MESSAGE, HERDR_NO_DRIVER_INTERRUPT_MESSAGE,
  HERDR_OUT_OF_SCOPE_MESSAGE, HERDR_READ_ONLY_MESSAGE,
  HERDR_RESUME_MESSAGE, HERDR_TERMINAL_UNAVAILABLE_MESSAGE,
  HERDR_THROTTLED_MESSAGE, HERDR_TRUST_PROMPT_MESSAGE, INTERRUPT_DETAIL,
  INTERRUPT_WORKING_GRACE_MS, LATE_TOOL_CALL_MS, LIVE_STATES, MODEL_BUSY_MESSAGE, MODEL_CHANGE_STATES,
  MODE_BUSY_MESSAGE, PROMPT_BLOCK_MARKER_MS, RESTART_BUSY_MESSAGE, RESTART_CODEX_MESSAGE,
  RESTART_EXIT_TIMEOUT_MS, RESTART_NO_PANEL_MESSAGE, RESTART_NO_UPDATE_MESSAGE,
  RESTART_RESEND_STALE_MESSAGE, RESTART_TASKS_MESSAGE, RESTART_UNSUPPORTED_MESSAGE,
  RESTART_WAITING_AGENT_MESSAGE, RESUME_WITHOUT_ULTRACODE_MESSAGE, SENDABLE_STATES,
  STREAMING_STATES, TURN_END_STATES, ULTRACODE_CLI_UNKNOWN_MESSAGE, WORKING_STATES,
  cwdDeniedSentence, herdrLaunchFailedDetail, inTurn,
  launchThrottledMessage, limitReachedDetail, nextTurnInput, noInputYet, pushStateDetail,
  restartFailedDetail, restartLaunchingDetail,
  seedDetailField, startsTurn, tallyTurnInput, toolsDecideSilence, ultracodeCliTooOldMessage, uncertainLaunch,
} from './state-sentences.ts';
import { DialogTimings } from './dialog-timing.ts';
import { ClaimWindows } from './claim-window.ts';
import * as seenMarks from './seen-marks.ts';
import * as heldEcho from './held-echo.ts';
import { type DiffMeasureClock, GIT_DIFF_FILE_LOG, GIT_DIFF_LIST_LOG, measureDiff } from './diff-measure.ts';
import { heldActivity, holdActivity, stampState } from './activity-clocks.ts';
import type { SeenMarkStore, SeenMarksDeps, SeenPickUp } from './seen-marks.ts';
import { PendingInteractions } from '../permissions.ts';
import type { ResolveResult } from '../permissions.ts';
import { classifyRisk } from '../risk.ts';
import { isInsideAnyRootReal, validateProjectCwd } from '../config.ts';
import { serverSystem } from '../version.ts';
import { GIT_NUMSTAT_BUDGET_MS, collectDiff, gitReadEnv, spawnGitArgs } from '../git-status.ts';
import { DiffError, collectDiffFile, collectDiffList, validateDiffPath } from '../git-diff.ts';
import type { GitRepoWatcher } from '../git-watch.ts';
import type { GitArgsRunner, GitStatusWatcher } from '../git-status.ts';
import { SessionGit } from './session-git.ts';
import { type PrStatusPort, SessionPrStatus } from './pr-status-link.ts';
import { HerdrLifecycle } from './herdr-lifecycle.ts';
import { LaunchGate } from './launch-gate.ts';
import type { LaunchOptions, PromptDisplay } from './launch-gate.ts';
import { SessionRestart, resumeUltracodeOf } from './session-restart.ts';
import { SessionTakeBack } from './session-take-back.ts';
import { applyAgentStateEvent, applyHistoryEvent, applyInitEvent } from './driver-events.ts';
import type { DriverEventsPort } from './driver-events.ts';
import { applyUsage } from './context-usage.ts';
import { applyConversationList, dropConversationLists } from './conversation-lists.ts';
import type { ConversationListsPort } from './conversation-lists.ts';
import type { ContextUsagePort } from './context-usage.ts';
import { createSessionListReader } from '../session-list.ts';
import type { SessionListReader } from '../session-list.ts';
import { createLiveSessionsReader } from '../live-sessions.ts';
import type { LiveSessionsReader } from '../live-sessions.ts';
import { labelFromPrompt, normalizeSessionLabel } from '../session-label.ts';
import { checkAnswerNotes, clipQuestionPreviews, withQuestionNotes } from './question-card.ts';
import { compareCliVersions, runningCliVersion } from '../cli-version.ts';
import type { CliVersionReader } from '../cli-version.ts';
import { CliRegistryState } from './cli-registry.ts';
import { InterruptWindows } from './interrupt-windows.ts';
import { AttachSlots } from './attach-slots.ts';
import { scanProjectRoots } from './project-scan.ts';
import { recentProjects } from './recent-projects.ts';
import * as companionScope from './companion-scope.ts';
import * as sessionScope from './session-scope.ts';
import { type FileDownloadAnswer, openSessionDownload } from '../files/session-download.ts';
import { type FileListingAnswer, type SessionFilesPort, listSessionFiles } from '../files/session-files.ts';
// Jedyny wartościowy import z `herdr/*` w tym pliku: czysta funkcja sklejająca prompt ze
// ścieżkami załączników. Zero gniazda, zero I/O — patrz komentarz przy re-eksporcie niżej.
import { appendAttachmentPaths } from '../herdr/uploads.ts';
import { ECHO_TTL_MS, ECHO_WINDOW, echoKey } from '../herdr/jsonl-follow.ts';
import type {
  DecisionOutcome, DriverEvent, InternalBlock, SessionDriver,
} from '../drivers/types.ts';
import { STALE } from '../drivers/types.ts';
// WYŁĄCZNIE typy: manager nie może zależeć od modułów integracji (socket, supervisor, driver,
// launcher). Implementacje wchodzą przez `ManagerConfig.herdrSupervisor` i `herdrDeps` —
// dzięki temu ten plik kompiluje się i testuje na atrapach, bez gniazda i bez `~/.claude`.
// JEDEN wyjątek jest wartością: zdanie o suficie paneli. `herdr/types.ts` to KONTRAKT tej
// warstwy (interfejsy, klasy błędów, copy), a nie jej implementacja — zero gniazda, zero I/O.
// Powód, dla którego stała stoi tam, a nie tu: mówi ją też `supervisor.status()` (patrz
// re-eksport niżej), a dwie kopie tego samego zdania rozjeżdżają się przy pierwszej poprawce.
import { HERDR_PANE_CAP_MESSAGE } from '../herdr/types.ts';
import { ULTRACODE_MIN_CLI } from '../herdr/ultracode.ts';
import { modeCycleStartAllowed } from '../herdr/mode-cycle.ts';
import { consentStep } from '../herdr/consent-step.ts';
import {
  HerdrCommandRefusedError, ULTRACODE_COMMANDS, commandListOf, promptBlockedField, promptBlockedText,
  registryCatalog,
} from '../herdr/commands/index.ts';
import type {
  CommandCatalog, SendSlotOptions, SendableOptions, SendableText,
} from '../herdr/commands/index.ts';
import type { ResumeSettings } from '../herdr/jsonl-pending.ts';
import type {
  HerdrAgent, HerdrLaunchHandle, HerdrSupervisor,
} from '../herdr/types.ts';
// Seedy demo ładują się dynamicznie (patrz `loadDemoModules`) — w procesie produkcyjnym nie
// mają prawa istnieć w pamięci. Typy importujemy statycznie: `import type` znika w kompilacji.
import type { Scheduler } from '../drivers/runtime.ts';
import { cardShowsAll, permissionSemantics, toolInputText } from '../drivers/tool-text.ts';
import {
  onlyWaitingAgents, tasksBlockRestart, tasksHoldingDonePush, waitingOnOwnCommand,
} from '../herdr/background/work.ts';
import { decisionText, waitingText } from './waiting-line.ts';
import type { ConsentCardView } from '../herdr/dialogs/layer1/cards.ts';
import type { ConsentDecision } from '../herdr/dialogs/layer1/contract.ts';
import { ConsentCards, consentRefusal } from './consent-cards.ts';
import type { ConsentManagerChannel } from './consent-cards.ts';
import type { DeviceDecision } from '../permissions.ts';
import type { DemoSeed } from '../demo/seeds.ts';
import { type DemoModules, loadDemoModules } from './demo-modules.ts';
import type { DemoContent } from '../demo/content/types.ts';

/** Wynik zwykłej wysyłki (bez `clientMessageId` albo pierwsze przyjęcie) */
const NOT_REPLAYED: SendMessageAck = Object.freeze({ replayed: false });

// ---------------------------------------------------------------------------
// Błędy (router mapuje je na kody HTTP)
// ---------------------------------------------------------------------------

/** Defined in `errors.ts`, so modules split out of the manager throw the same classes; importers keep this path. */
export {
  BadRequestError, BadStateError, GoneError, NotFoundError, TooManyRequestsError, UltracodeRefusedError,
} from './errors.ts';

// ---------------------------------------------------------------------------
// Frazy linii `server.log`, których człowiek szuka w logu (dokumenty je cytują)
// ---------------------------------------------------------------------------

/** Fraza linii logu o prompcie zablokowanym przez hook `UserPromptSubmit`. */
export const PROMPT_BLOCKED_LOG = 'rarog: prompt blocked by a hook';
/** Defined in `held-echo.ts` with the deferred echo; importers keep this path. */
export { HELD_FLUSHED_LOG, HELD_QUEUE_LOG } from './held-echo.ts';
/** Defined in `diff-measure.ts` with the line of a diff read; importers keep this path. */
export { GIT_DIFF_FILE_LOG, GIT_DIFF_LIST_LOG } from './diff-measure.ts';

/*
 * 409 na zakładanie sesji po osiągnięciu sufitu paneli Raroga.
 *
 * Definicja mieszka w `herdr/types.ts`, bo TO SAMO zdanie wysyła `supervisor.status().detail`
 * — czyli powód, którym klient wygasza „+" jeszcze przed tapnięciem. Re-eksport zostawia miejsce
 * importu tam, gdzie było (router, testy managera): jedna kopia tekstu, dwa wyjścia.
 */
export { HERDR_PANE_CAP_MESSAGE };

/*
 * Doklejanie ścieżek załączników do promptu ma DOKŁADNIE JEDNĄ implementację — w `herdr/uploads.ts`,
 * obok kodu, który te pliki zapisuje. Druga kopia tutaj byłaby tą, która realnie leci do herdr,
 * więc poprawka formatu w `herdr/uploads.ts` działałaby w testach drivera i nie działała na żywo.
 * Import jest wartościowy, a nie typowy, ale ten moduł
 * nie dotyka gniazda — to czyste sklejanie stringów.
 */
export { appendAttachmentPaths };

/** Re-exported for `index.ts`, which imports it from the manager; defined in `state-sentences.ts`. */
export { RESUME_UNREADABLE_MESSAGE } from './state-sentences.ts';

// ---------------------------------------------------------------------------
// Konfiguracja
// ---------------------------------------------------------------------------

/**
 * Czego manager potrzebuje od modułów herdr, których NIE jest właścicielem.
 *
 * Interfejs mieszka tutaj, a nie przy implementacjach, z dwóch powodów: manager musi się
 * kompilować i przechodzić testy, zanim `herdr/{identity,commands/guard,uploads}.ts` powstaną,
 * a testy sesji herdr mają chodzić na atrapach, nie na dysku i nie na gnieździe.
 *
 * Wszystkie te rzeczy są WYMAGANE do wysyłki: brak `herdrDeps` znaczy „sesje herdr są tylko
 * do odczytu" — nigdy „wysyłamy bez sanityzacji i bez throttle'a".
 */
export interface HerdrManagerDeps {
  /**
   * Deterministyczny `sessionId` Raroga z klucza agenta (UUIDv5, 5.8).
   *
   * Bez tego deep-link `/sessions/<uuid>` otwarty na telefonie umiera przy każdym restarcie
   * Raroga — a Rarog restartuje się przy każdym deployu.
   */
  sessionIdFor(key: string): string;
  /**
   * Znacznik „ten wynik obejrzałem Z TELEFONU".
   *
   * herdr gasi `done` wyłącznie fokusem panelu w terminalu, więc bez własnego
   * znacznika karta obejrzana na telefonie wracała do sekcji uwagi po każdym resyncu i po
   * każdym restarcie Raroga. Zapamiętujemy numer stanu, przy którym człowiek ją obejrzał;
   * NOWSZY wynik ma numer wyższy i przebija znacznik sam z siebie — zero mutacji w herdr.
   *
   * Opcjonalny: brak znaczy „znacznik żyje tylko w RAM".
   *
   * Drugi rodzaj wpisu pod tym samym adresem to ręczne „nieprzeczytane" z listy: `unseenSeq`
   * i `markUnseen`. Wpis jest jeden na panel, więc ostatnia decyzja wygrywa, a `seq` dla wpisu
   * „nieprzeczytane" nie oddaje niczego.
   */
  readonly seen?: SeenMarkStore;
  /**
   * Alias `engineSessionId → sessionId` („Data model: what does not exist” w `docs/architecture.md`) — to on trzyma obietnicę „ta sama karta
   * po wznowieniu". `key` po wznowieniu jest INNY (nowy panel), więc `sessionIdFor(key)`
   * dałby nowy adres; uuid silnika jest jedyną rzeczą, która przeżywa zmianę panelu.
   */
  aliasFor(engineSessionId: string): string | undefined;
  rememberAlias(engineSessionId: string, sessionId: string): void;
  /**
   * Walidacja `resumeFrom` po transkrypcie („Starting sessions from the phone: three powers” w `docs/security-model.md`) — lokalizacja pliku po uuid i `cwd` z niego.
   *
   * Opcjonalna, bo `herdr/transcript-path.ts` powstaje równolegle. Brak tej zależności NIE
   * otwiera furtki: `create({resumeFrom})` odmawia wtedy (`RESUME_UNVERIFIABLE_MESSAGE`),
   * bo sam regex uuida przepuściłby sesję z katalogu spoza korzeni — czyli cudzy transkrypt
   * na telefon i dopisywanie do niego dalej.
   */
  readonly resumeSource?: {
    locate(root: string, cwd: string, engineSessionId: string): Promise<string | null>;
    cwdOf(file: string): Promise<string | null>;
    /**
     * Model, effort i tryb, na których rozmowa skończyła. Opcjonalna: bez niej wznowienie
     * idzie bez flag, na tym, co przywróci samo CLI.
     */
    settingsOf?(file: string): Promise<ResumeSettings>;
  };
  /**
   * Wszystko, co musi być prawdą o tekście, ZANIM pójdzie do cudzego panelu (5.4): `assertSendable`
   * z `herdr/commands/guard.ts`. Zwraca tekst po sanityzacji z klasyfikacją komendy wobec katalogu
   * sesji albo rzuca błąd z komunikatem dla użytkownika (400). Wolny tekst wymaga `catalog`;
   * ścieżka WEWNĘTRZNA (`internalCommand`: `/model`, `/effort`) katalogu nie czyta.
   */
  assertSendable(text: string, opts: SendableOptions): SendableText;
  /**
   * Katalog komend sesji: migawka dla katalogu panelu i wersji CLI jego procesu (`null` = nie
   * wiadomo). Nieobecny (testy, demo) = migawka z samego rejestru, bez skilli z dysku.
   */
  commandCatalog?(cwd: string, cliVersion: string | null): CommandCatalog;
  /** Throttle wysyłki per panel + sufit godzinny (5.4). `false` = 429, nie 400. */
  takeSendSlot(key: string, opts?: SendSlotOptions): boolean;
  /** Zapis zdjęć do `<cwd>/.rarog-uploads/`; zwraca ścieżki bezwzględne (5.6). */
  writeUploads(cwd: string, images: readonly string[]): Promise<readonly string[]>;
  /**
   * Zapis ZAŁĄCZNIKÓW PLIKOWYCH do tego samego katalogu; zwraca ścieżki bezwzględne.
   *
   * Osobna metoda, a nie flaga przy `writeUploads`: to są dwa różne wejścia (string vs
   * nazwa + treść) i dwa różne komunikaty błędu. WYMAGANA, nie opcjonalna — atrapa, która
   * jej zapomni, ma się nie skompilować, zamiast po cichu gubić plik użytkownika.
   */
  writeUploadFiles(cwd: string, files: readonly FileAttachment[]): Promise<readonly string[]>;
  /** Sweep plików starszych niż 48 h — przy starcie Raroga, w tle (start na niego nie czeka) (5.6). */
  sweepUploads(roots: readonly string[]): Promise<void>;
}

/** Defined in `consent-cards.ts` with the consent channel cards; importers keep this path. */
export type { ConsentManagerCard, ConsentManagerChannel } from './consent-cards.ts';

export interface ManagerConfig {
  /** Tryb demo: mock nadzorcy herdr zamiast gniazda, seedy zamiast paneli, zero gita. */
  readonly demo: boolean;
  /**
   * Zestaw treści demo, ten sam, który dostają atrapa nadzorcy i notatki. W demo obowiązkowy: bez niego
   * `createManager` rzuca, zamiast cicho wziąć jeden język. Poza demo nieużywany.
   */
  readonly demoContent?: DemoContent;
  /** Katalog danych Raroga (lista ukrytych, aliasy, dziennik audytu). */
  readonly dataDir: string;
  /**
   * Allow-lista katalogów. Brak pola → w demo lista z seedów, poza demo skan `~/Projects`.
   * Akceptujemy `string` albo `{path, name}`, żeby kształt configu serwera nie był tu wiążący.
   */
  readonly projects?: readonly (string | { path: string; name?: string })[];
  /**
   * Korzenie projektów (`RAROG_PROJECT_ROOTS`). Poza demo z nich bierze się lista projektów
   * ORAZ druga linia obrony dla „innej ścieżki" — dowolny istniejący podkatalog roota.
   */
  readonly projectRoots?: readonly string[];
  /**
   * Czytnik listy sesji (oficjalne API CLI z SDK, które `index.ts` ładuje przy starcie); w demo podmieniany na fake
   * wpisy. Brak poza demo = pusta lista.
   */
  readonly resumableReader?: SessionListReader;
  /** Czytnik ŻYWYCH sesji CLI (`claude agents --json`); w demo i w testach podmieniany. */
  readonly liveSessionsReader?: LiveSessionsReader;
  /**
   * Czytnik wydania Claude Code: dowiązanie binarki + rejestr procesów CLI. Brak pola =
   * wyłączony — `cliUpdate` nigdy nie jedzie, klient milczy. Czytnik dysku podaje WYŁĄCZNIE
   * `index.ts` (poza demo): test, który go nie wstrzyknie, nie ma prawa czytać rejestru
   * procesów maszyny, na której akurat biegnie.
   */
  readonly cliVersionReader?: CliVersionReader;
  /**
   * Wykrycie dialogu z rejestru sesji CLI (`RAROG_CLI_WAITING`). `true` = szybki tik
   * `CLI_WAITING_POLL_MS` tym samym czytnikiem co wydania i szturchnięcia driverów; brak
   * pola albo `false` = zachowanie sprzed etapu C (brak tiku, stare zdanie bramki wysyłki).
   * Bez `cliVersionReader` nie robi nic — rejestru nie ma czym czytać.
   */
  readonly cliWaiting?: boolean;
  /** Odstęp szybkiego tiku — WYŁĄCZNIE seam testowy (domyślnie `CLI_WAITING_POLL_MS`). */
  readonly cliWaitingPollMs?: number;
  /**
   * Echo odroczone (`RAROG_QUEUE_ECHO`): `true` = prompt wysłany przez klienta
   * z `queueAware` w trakcie pracy staje w transkrypcie dopiero, gdy CLI go weźmie. Brak pola
   * albo `false` = echo od razu.
   */
  readonly queueEcho?: boolean;
  /**
   * Zegary restartu — WYŁĄCZNIE seam testowy, jak `launchThrottle`: ile czekamy na koniec
   * procesu po `/exit` (domyślnie {@link RESTART_EXIT_TIMEOUT_MS}), co ile pytamy i ile czeka odczyt dialogu wyjścia.
   */
  readonly restartTiming?: { exitTimeoutMs?: number; pollMs?: number; dialogReadMs?: number };
  /**
   * Log diagnostyczny. Brak = cisza (tak jest w testach i w demo).
   *
   * Jedyny dziś powód istnienia: zapisać KOREKTĘ stanu z herdr, czyli chwilę, w której Rarog
   * dowiaduje się, że sesja od jakiegoś czasu była w innym stanie, niż pokazywał. To zdarzenie
   * z definicji dzieje się wtedy, gdy nikt nie patrzy — bez śladu w logu następne zgłoszenie
   * znowu byłoby rekonstrukcją z pamięci.
   */
  readonly logger?: (line: string) => void;
  /**
   * Sufit ŻYWYCH paneli założonych przez Raroga (`RAROG_MAX_PANES`): `loadConfig()`
   * bez tej zmiennej ustawia DOMYŚLNY sufit `DEFAULT_MAX_PANES` (30), a nie brak sufitu —
   * sentinela „wyłącz" nie ma, bo górna granica ma istnieć zawsze (`config.ts`).
   *
   * Brak pola = bez limitu, dopuszczalne w testach i atrapach — tam nikt nie zakłada paneli
   * naprawdę. Sprawdzany w `create()` PRZED launcherem: po przekroczeniu odmawia zdaniem
   * `HERDR_PANE_CAP_MESSAGE`.
   */
  readonly maxPanes?: number;
  /** Korzeń magazynu CLI (`~/.claude/projects`) — do walidacji `resumeFrom`; testy podmieniają. */
  readonly transcriptRoot?: string;
  /**
   * Kanał powiadomień. Brak = Rarog nie pushuje (demo, testy, brak kompletu `RAROG_APNS_*`).
   *
   * Wstrzykiwany INTERFEJSEM, nie klasą, i to jest celowe: manager nie ma prawa wiedzieć,
   * że po drugiej stronie jest APNs, a testy nie mają prawa potrzebować sieci, żeby
   * sprawdzić zmianę stanu sesji.
   */
  readonly notifier?: NotifierLike;
  /**
   * Odczyt domyślnego modelu konta CLI (`~/.claude/settings.json`, pole `model`) — WYŁĄCZNIE
   * do zasiania pigułki sesji startującej bez `--model`. Wołany świeżo przy każdym `create()`,
   * bo `/model` w dowolnym panelu przestawia ten plik w trakcie życia serwera.
   */
  readonly accountDefaultModel?: () => string | undefined;
  /**
   * Odczyt domyślnego effortu konta CLI dla danego modelu (`~/.claude/settings.json`:
   * `modelSettings[<model>].effortLevel`, w drugiej kolejności globalne `effortLevel`) —
   * WYŁĄCZNIE do zasiania pigułki sesji startującej bez `--effort`. Ta sama umowa co przy
   * modelu: świeży odczyt przy każdym `create()`, wartość nigdy nie idzie do argv.
   */
  readonly accountDefaultEffort?: (model?: string) => EffortLevel | undefined;
  /**
   * Throttle zakładania paneli — WYŁĄCZNIE seam testowy.
   *
   * `loadConfig()` tego pola nie produkuje i nie ma jak go ustawić z env: liczby-bezpieczniki
   * mieszkają w `config.ts` („Configuration (`server/src/config.ts`)” w `docs/implementation-spec.md`) i mają tam zostać. Testowi wolno je poluzować z tego samego
   * powodu, dla którego wolno mu wstrzyknąć zegar — inaczej scenariusz „dwie sesje w jednym
   * teście" trwałby 5 sekund realnego czasu.
   */
  readonly launchThrottle?: { minIntervalMs?: number; hourlyCap?: number };
  /**
   * Katalogi, w których wolno odpalić `permissionMode: 'bypassPermissions'` (`RAROG_YOLO_ROOTS`).
   * Brak / pusta lista = nigdzie, bo to jest tryb, w którym `canUseTool` nigdy nie zapyta.
   */
  readonly yoloRoots?: readonly string[];
  /**
   * System maszyny serwera (`serverSystem` w `version.ts`, w demo fikcyjny Mac): z niego zdania z wariantami
   * `.mac`/`.vps` biorą słowo maszyny. Brak pola = `serverSystem()` procesu.
   */
  readonly system?: ServerSystem;
  /**
   * Wstrzykiwalne rozwiązywanie dowiązań dla bramek yolo (testy na ścieżkach zmyślonych
   * podają tożsamość; produkcja nie podaje nic i dostaje `realpathSync`). Granica
   * `RAROG_YOLO_ROOTS` jest porównywana po realpath — leksykalnie dowiązanie
   * `<yolo-root>/skrót -> /cudze/repo` uchodziłoby za „w yolo" (ta sama
   * klasa błędu co przy `validateProjectCwd`).
   */
  readonly realPath?: (candidate: string) => string;
  /** Zegar mock-drivera (testy z fake timerami). */
  readonly scheduler?: Scheduler;
  /** Wstrzykiwalne „teraz" w ms. */
  readonly now?: () => number;
  /**
   * Identyfikator nowej blokady promptu z przyciskiem (`SessionSummary.promptBlocked.id`). Brak pola =
   * `randomUUID()`; złote ramki podają stały, żeby plik ramki nie zmieniał się przy każdym przebiegu.
   */
  readonly promptBlockId?: () => string;
  /**
   * Środowisko BAZOWE procesów gita (`gitEnvBase` z `loadConfig`, lista `GIT_ENV_PASSTHROUGH`).
   *
   * Brak pola = pusta baza, czyli git bez `PATH` i `HOME`. To jest fail-closed z premedytacją:
   * jedyni wołający bez tego pola to testy, a one wstrzykują runnery i prawdziwego gita nie
   * odpalają. Produkcja dostaje je z rozwinięcia `...config` w `index.ts`.
   */
  readonly gitEnvBase?: Readonly<Record<string, string>>;
  /** Podmiana / wyłączenie (`null`) odczytu gita. W demo domyślnie wyłączony. */
  readonly gitStatus?: GitStatusWatcher | null;
  /**
   * Szczegóły plików w ramce `git-status` (`RAROG_GIT_FILE_DETAILS`). Brak pola albo `true` =
   * pole jedzie (z odczytu gita z licznikami, z drivera — tak, jak je podał); `false` = ramka
   * bez `fileDetails`, a domyślny odczyt gita nie pyta o liczniki.
   */
  readonly gitFileDetails?: boolean;
  /**
   * Fabryka obserwatora `.git` (`git-watch.ts`) albo `null` — wyłączony. Poza demo domyślnie
   * prawdziwy `fs.watch`. Fabryka, nie instancja: callback zmiany należy do managera.
   */
  readonly gitWatcher?: ((onChange: (cwds: readonly string[]) => void) => GitRepoWatcher) | null;
  /** Uruchamiacz gita dla `diff()` (testy). */
  readonly diffRunner?: GitArgsRunner;
  /**
   * Nadzorca żywych paneli herdr — JEDYNE źródło sesji.
   *
   * Brak nadzorcy znaczy „Rarog nie widzi i nie zakłada niczego": lista jest pusta, a UI
   * pokazuje baner. Formalnie pole jest opcjonalne, bo tak startuje Rarog z niedostępnym
   * gniazdem (fail-closed bez wywracania procesu) — nie dlatego, że integracja jest opcją.
   */
  readonly herdrSupervisor?: HerdrSupervisor;
  /** Tożsamość, guard, throttle i uploady dla sesji herdr. Brak = sesje tylko do odczytu. */
  readonly herdrDeps?: HerdrManagerDeps;
  /** Korzenie paneli w zasięgu (`RAROG_HERDR_ROOTS`) — sweep uploadów przy starcie. */
  readonly herdrRoots?: readonly string[];
  /** Kanał zapisu do paneli (`RAROG_HERDR_SEND`). `false` = Rarog widzi i nie rusza. */
  readonly herdrSend?: boolean;
  /** Karty kanału zgód (warstwa 1): decyzje, zwolnienie i migawka; brak = bez kanału. */
  readonly consent?: ConsentManagerChannel;
  /**
   * Czy `markSeen()` gasi też `done` PO STRONIE HERDR (`RAROG_HERDR_SEEN_FOCUS`).
   *
   * Brak pola = włączone. `false` zostawia wyłącznie znacznik lokalny, bez `agent.focus`.
   */
  readonly herdrSeenFocus?: boolean;
  /**
   * Czy ficzer terminala w ogóle istnieje (`RAROG_TERM`) — jedyny powód, dla którego manager
   * o tym wie.
   *
   * Karta agenta z terminala Raroga niesie `termId` tylko wtedy, gdy jest dokąd wejść: przy
   * `RAROG_TERM=0` terminal oddaje 404 i upgrade WS jest zrywany, więc link z karty prowadziłby
   * w martwy ekran (nigdy martwy przycisk). Brak pola = wyłączone (fail-closed):
   * jedynym wołającym bez niego są testy i atrapy, a tam terminala nie ma.
   */
  readonly termEnabled?: boolean;
  /**
   * Rejestr idempotentnych wysyłek — WYŁĄCZNIE seam testowy. Brak pola = rejestr
   * w `<dataDir>/outbox-ids.json` z zegarem `now` i logiem `logger` tego configu.
   */
  readonly sendRegistry?: SendRegistry;
  /** PR status tracker (`bootstrap/pr-status.ts`); missing = no `state` on PRs (`RAROG_PR_STATUS=0`). */
  readonly prStatus?: PrStatusPort;
}

/** `ManagerApi` + rzeczy potrzebne procesowi i testom (router koduje przeciw `ManagerApi`). */
export interface Manager extends ManagerApi {
  /** Rozwiązuje się, gdy rejestr jest wczytany, a seedy demo założone. */
  readonly ready: Promise<void>;
  /** Czeka na dojście zapisu rejestru do dysku. */
  flush(): Promise<void>;
  /** Zamyka drivery i zapisuje rejestr (SIGTERM / koniec testu). */
  dispose(): Promise<void>;
  onTranscriptReset(cb: (sessionId: string) => void): void;
}

type EventListener = (scope: 'global' | string, seq: number | null, ev: ServerEvent) => void;

// ---------------------------------------------------------------------------
// Etykieta sesji (człon `sesja` w tytule `projekt · sesja`)
// ---------------------------------------------------------------------------

/*
 * `MAX_LABEL_LENGTH` i `labelFromPrompt` mieszkają w `../session-label.ts`, razem
 * z `normalizeSessionLabel`, którym czyści etykietę i karta (`#setLabel`), i tab w herdr
 * (`herdr/provenance.ts`) — a moduł herdr nie ma prawa importować managera. Reeksport zostaje:
 * „jak powstaje etykieta karty" jest pytaniem o managera.
 */
export { MAX_LABEL_LENGTH, labelFromPrompt } from '../session-label.ts';
/** State of a pane seen for the first time lives with the lifecycle events; tests ask the manager for it. */
export { herdrInitialState } from './herdr-lifecycle.ts';

// ---------------------------------------------------------------------------
// Implementacja
// ---------------------------------------------------------------------------

class RarogManager implements Manager {
  readonly #config: ManagerConfig;
  readonly #pending = new PendingInteractions();
  readonly #sessions = new Map<string, Session>();
  readonly #listeners: EventListener[] = [];
  readonly #transcriptResets: ((sessionId: string) => void)[] = [];
  readonly #conversations = new companionScope.ConversationListeners((line) => { this.#config.logger?.(line); });
  /** Git row of cards: reader, `.git` watcher, `git-status` frames and the cost window in the log. */
  readonly #git: SessionGit;
  readonly #prStatus: SessionPrStatus;
  /** Port of the conversation lists on a card (`conversation-lists.ts`). */
  readonly #conversationLists: ConversationListsPort;
  /** Emission of a session event and of `session-changed`, for the git row and the context window. */
  readonly #emit: ContextUsagePort = {
    emitSession: (session, event) => { this.#emitSession(session, event); },
    emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
  };

  /**
   * Środowisko procesów gita ODCZYTUJĄCYCH repo — zbudowane RAZ z `gitEnvBase` konfiguracji.
   *
   * Trzymamy je w polu, bo `diff()` spawnuje własne runnery przy każdym wywołaniu, a env ma
   * być tam DOKŁADNIE to samo co w watcherze (jedna granica sekretów, nie dwie).
   */
  readonly #gitEnv: NodeJS.ProcessEnv;
  readonly #resumableReader: SessionListReader;
  readonly #liveSessions: LiveSessionsReader;
  readonly #now: () => number;
  /** Idempotencja `POST …/messages` z `clientMessageId` — patrz `send-registry.ts`. */
  readonly #sendRegistry: SendRegistry;
  /**
   * Karty zgody, których Rarog NIE UMIE zatwierdzić (`input: null` — rozjazd nazw narzędzia
   * albo nieudane parsowanie ekranu po ponowieniu).
   *
   * Bez tego zbioru „Zatwierdź" na takiej karcie oddawałoby 200, a driver po cichu nic by nie
   * wysłał: użytkownik patrzyłby na kartę, która nie znika, i tapał ponownie. Fail-closed ma
   * być SŁYSZALNY.
   */
  readonly #undecidable = new Set<string>();
  /** Consent channel cards: wire, snapshot, device decisions and their end with the session. */
  readonly #consentCards: ConsentCards;
  /** Interrupt idempotency windows: "in flight" and debounce, per session. */
  readonly #interrupts: InterruptWindows;

  /**
   * `HerdrAgent.key` → `sessionId` Raroga. JEDYNY adres sesji herdr: ani `paneId` (zmienia go
   * `pane move`), ani `agentSessionId` (zmienia go `/clear`), ani `cwd` (dwa panele w jednym
   * katalogu to norma) nie są stabilne.
   */
  readonly #herdrByKey = new Map<string, string>();

  /**
   * Sesje, których bieżąca rozmowa ma nazwę z `/rename` (wpis `custom-title`). Pamięć serwera w RAM, nie
   * pole karty: przeżywa wymianę drivera, a gaśnie z nową rozmową w panelu (`init` z innym uuid) i z restartem
   * Raroga (follower nowego procesu czyta nazwę z pliku od nowa).
   */
  readonly #customTitled = new WeakSet<Session>();

  /**
   * `engineSessionId` → `sessionId` Raroga dla sesji NIETERMINALNYCH (blokada podwójnego
   * pisarza).
   *
   * Świadomie szerzej niż `LIVE_STATES`: dwóch pisarzy do jednego pliku jsonl to zgubione
   * wiadomości, a sesja `resumable`, `interrupted` czy `error` po stronie Raroga nadal może
   * być ŻYWYM panelem w terminalu.
   */
  readonly #byEngineSession = new Map<string, string>();

  /** Manager po `dispose()` — strumień nadzorcy herdr nie ma już prawa niczego zmieniać. */
  #disposed = false;
  /** CLI registry: release readings, both ticks and the registry signal of a card. */
  readonly #cli: CliRegistryState;

  /**
   * Prompty startowe, które czekają na koniec dialogu startowego (zaufanie katalogu).
   * Launcher oddaje `ready` od razu, gdy panel wstaje na dialogu (`interactiveReady: false`), więc `#finishLaunch`
   * czeka dalej tutaj: `true` = panel gotowy, `false` = oczekiwanie unieważnione, a zdanie już stoi w transkrypcie.
   */
  readonly #startWaits = new Map<Session, StartWait>();
  /** Karty, których driver wyszedł w czasie rezerwacji startu, zanim prompt startowy zaczął czekać (`#awaitStartReady`). */
  readonly #startExits = new WeakSet<Session>();
  /** Obietnica rejestru wysyłek → ta sama obietnica z `queued`, patrz `sendMessage`. */
  readonly #queuedAcks = new WeakMap<Promise<SendMessageAck>, Promise<SendMessageAck>>();
  /** Ogon kolejki wysyłek sesji herdr: kolejność slotów throttle'a = kolejność `driver.send`. */
  readonly #sendTail = new WeakMap<Session, Promise<void>>();
  /** Sesje silnika czekające na szturchnięcie kanału zgód ({@link #consentNudge}); odczyty się nie nakładają. */
  readonly #consentNudges = new Set<string>();
  #consentNudging = false;
  /** Karty, których ostatni `agent-state` z drivera to `blocked` (wejście w blokadę = pierwszy taki stan). */
  readonly #herdrBlocked = new Set<string>();
  /** Card timing of dialogs (`dialog-timing.ts`): herdr `blocked` and the first card of the same dialog. */
  readonly #timing: DialogTimings;
  /** Claim window (`claim-window.ts`): herdr `blocked` right after a hook's claim leaves the state alone. */
  readonly #claimWindows: ClaimWindows;

  /** Attach semaphore of herdr panes (5.10: 17 parallel history reads are a latency spike). */
  readonly #attach = new AttachSlots();
  /** herdr pane lifecycle: pump, event dispatch, new panes, restore quiet, `herdr-status` banner. */
  readonly #herdrLifecycle: HerdrLifecycle;
  /** Launch checks and launch slots of new herdr sessions. */
  readonly #launchGate: LaunchGate;
  /** Session restarts: restart records, the in-flight counter, `/exit` and the new process. */
  readonly #sessionRestart: SessionRestart;
  /** Port of the `init`, `history` and `agent-state` branches of `#handleDriverEvent` (`driver-events.ts`). */
  readonly #driverEvents: DriverEventsPort;
  /** Deferred echo: what `held-echo.ts` needs from the manager. */
  readonly #heldEcho: heldEcho.HeldEchoDeps;
  readonly #takeBack: SessionTakeBack;

  readonly ready: Promise<void>;

  /** Scenariusze demo — `null` poza trybem demo (i wtedy nikt po nie nie sięga). */
  readonly #demo: DemoModules | null;

  constructor(config: ManagerConfig, demo: DemoModules | null) {
    this.#config = config;
    this.#demo = demo;
    this.#now = config.now ?? (() => Date.now());
    this.#cli = new CliRegistryState(config, {
      sessions: this.#sessions, disposed: () => this.#disposed, now: () => this.#now(),
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
    });
    this.#interrupts = new InterruptWindows({
      sessions: this.#sessions, now: () => this.#now(), logger: (line) => { this.#config.logger?.(line); },
    });
    this.#timing = new DialogTimings({ now: () => this.#now(), logger: (line) => { this.#config.logger?.(line); } });
    this.#claimWindows = new ClaimWindows({
      sessions: this.#sessions, herdrBlocked: this.#herdrBlocked, now: () => this.#now(),
      logger: (line) => { this.#config.logger?.(line); },
      applyTransition: (session, event, detail) => this.#applyTransition(session, event, detail),
    });
    this.#sendRegistry = config.sendRegistry ?? createSendRegistry({
      dataDir: config.dataDir,
      now: () => this.#now(),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
    this.#gitEnv = gitReadEnv(config.gitEnvBase ?? {});
    this.#git = new SessionGit(config, {
      sessions: this.#sessions, now: () => this.#now(), gitEnv: this.#gitEnv, ...this.#emit,
    });
    this.#prStatus = new SessionPrStatus(config.prStatus, { sessions: this.#sessions, ...this.#emit });
    this.#conversationLists = {
      emitSessionChanged: this.#emit.emitSessionChanged, prStatus: this.#prStatus,
      quiet: (sessionId) => { this.#config.notifier?.quiet(sessionId); },
    };
    this.#herdrLifecycle = new HerdrLifecycle(config, {
      sessions: this.#sessions,
      herdrByKey: this.#herdrByKey,
      git: this.#git,
      prStatus: this.#prStatus,
      disposed: () => this.#disposed,
      now: () => this.#now(),
      setLabel: (session, raw) => { this.#setLabel(session, raw); },
      indexEngineSession: (session) => { this.#indexEngineSession(session); },
      emitState: (session) => { this.#emitState(session); },
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
      markStale: (session) => { this.#markStale(session); },
      notify: (scope, seq, event) => { this.#notify(scope, seq, event); },
      herdrGone: (key) => { this.#herdrGone(key); },
      herdrReattached: (supervisor, agent) => { this.#herdrReattached(supervisor, agent); },
      attachHerdrDriver: (supervisor, session, key) => this.#attachHerdrDriver(supervisor, session, key),
    });
    this.#launchGate = new LaunchGate(config, {
      now: () => this.#now(),
      cli: this.#cli,
      system: () => this.#system,
      liveSessions: (opts) => this.#liveSessions(opts),
      requireSupervisor: () => this.#requireSupervisor(),
      assertAllowedCwd: (cwd) => { this.#assertAllowedCwd(cwd); },
      assertPermissionMode: (cwd, mode) => { this.#assertPermissionMode(cwd, mode); },
      assertKnownModel: (model) => { this.#assertKnownModel(model); },
      commandCatalog: (cwd, cliVersion) => this.#commandCatalog(cwd, cliVersion),
      checkSendable: (text, key, cwd, opts) => this.#checkSendable(text, key, cwd, opts),
    });
    this.#driverEvents = {
      config, customTitled: this.#customTitled, herdrBlocked: this.#herdrBlocked, attach: this.#attach,
      herdrRestoreQuiet: this.#herdrLifecycle.herdrRestoreQuiet, claimWindows: this.#claimWindows,
      indexEngineSession: (session, previous) => { this.#indexEngineSession(session, previous); },
      applyTransition: (session, event, detail) => this.#applyTransition(session, event, detail),
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
      takeHeld: (session, token) => heldEcho.takeHeld(session, token),
      appendHeld: (session, held, at) => { heldEcho.appendHeld(session, held, this.#heldEcho, at); },
      appendMessage: (...args) => this.#appendMessage(...args),
      timingLeft: (session) => { this.#timing.timingLeft(session); },
      timingBlocked: (session) => { this.#timing.timingBlocked(session); },
      consentNudge: (engineSessionId) => { this.#consentNudge(engineSessionId); },
      conversationChanged: (sessionId, engineSessionId) => {
        this.#conversations.notify(sessionId, engineSessionId);
      },
      settleStartWait: (session) => { this.#settleStartWait(session); },
      inWorkingGrace: (session) => this.#inWorkingGrace(session),
    };
    this.#heldEcho = {
      config, system: () => this.#system, now: () => this.#now(), sessions: this.#sessions,
      restarting: (id) => this.#sessionRestart.restarts.has(id),
      appendMessage: (...args) => this.#appendMessage(...args),
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
      noteTurnInput: (session) => { this.#noteTurnInput(session); },
    };
    this.#takeBack = new SessionTakeBack({ ...this.#heldEcho, assertWritable: () => { this.#assertHerdrWritable(); } });
    this.#resumableReader = this.#defaultResumableReader();
    /*
     * Demo nie odpala procesów potomnych — i nie ma czego odsiewać, bo jego wpisy są fikcyjne.
     * `null` znaczy „nie wiem", czyli dokładnie to, czym jest wiedza demo o cudzych sesjach.
     */
    this.#liveSessions = this.#config.liveSessionsReader
      ?? (this.#config.demo ? () => Promise.resolve(null) : createLiveSessionsReader());
    this.#sessionRestart = new SessionRestart(config, {
      cli: this.#cli, launchGate: this.#launchGate, liveSessions: this.#liveSessions,
    }, {
      sessions: this.#sessions,
      disposed: () => this.#disposed,
      now: () => this.#now(),
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
      appendMessage: (session, role, blocks) => { this.#appendMessage(session, role, blocks); },
      herdrGone: (key) => { this.#herdrGone(key); },
      recreate: (session, opts, slotTaken) => this.#recreate(session, opts, slotTaken),
      assertPermissionMode: (cwd, mode) => { this.#assertPermissionMode(cwd, mode); },
    });
    this.#consentCards = new ConsentCards(config, {
      sessions: this.#sessions,
      herdrByKey: this.#herdrByKey,
      liveSession: (engineSessionId) => this.#liveSession(engineSessionId),
      hasPending: (sessionId) => this.#pending.hasPending(sessionId),
      ...this.#emit, claimWindows: this.#claimWindows,
      applyTransition: (session, event) => this.#applyTransition(session, event),
      note: (session, event) => { this.#note(session, event); },
      timingCard: (session, kind) => { this.#timing.timingCard(session, kind); },
      dropScreenPermissions: (session) => { this.#dropScreenPermissions(session); },
      assertHerdrWritable: () => { this.#assertHerdrWritable(); },
    });
    this.ready = this.#init();
  }

  /**
   * Czytnik listy „Wznów istniejącą".
   *
   * Demo NIE dotyka `~/.claude/projects` — dostaje deterministyczne wpisy z seedów,
   * tak samo jak resztę scenariusza.
   */
  #defaultResumableReader(): SessionListReader {
    const injected = this.#config.resumableReader;
    if (injected !== undefined) return injected;
    if (!this.#config.demo) return createSessionListReader();
    const demo = this.#requireDemo();
    return ({ dir }) => {
      // Bez `dir` (lista „Ostatnie sesje") demo nie ma jednego katalogu, o który pytamy —
      // oddaje więc wpisy KAŻDEGO projektu demo. Wcześniej szło tu `''`, przez co wpisy miały
      // pusty `cwd`, wypadały na allow-liście i ekran był w demie wiecznie pusty.
      const dirs = dir !== undefined ? [dir] : this.projects().map((project) => project.path);
      return Promise.resolve(dirs.flatMap((cwd) => demo.demoResumable(cwd, this.#now())));
    };
  }

  /**
   * Moduły demo albo twardy błąd. Niedostępne są wyłącznie wtedy, gdy ktoś ominął
   * `createManager()` (jedyne miejsce, które je ładuje) — to błąd programisty, nie użytkownika.
   */
  #requireDemo(): DemoModules {
    if (this.#demo === null) {
      throw new Error('Tryb demo bez załadowanych scenariuszy — użyj createManager().');
    }
    return this.#demo;
  }

  /**
   * Start managera.
   *
   * Rejestru sesji NIE MA i nie wraca: źródłem prawdy o tym, jakie sesje istnieją,
   * jest `agent.list` z herdr, a nie plik sprzed restartu. Zostawiony `sessions.json` byłby
   * listą kart-widm z ostatnim znanym stanem — dlatego przy starcie zmieniamy mu nazwę
   * i mówimy o tym w logu, zamiast go czytać albo po cichu kasować.
   */
  async #init(): Promise<void> {
    this.#retireRegistryFile();
    if (this.#config.demo) this.#applySeeds();
    this.#startHerdr();
    this.#cli.startCliVersionPoll();
  }

  /** Jednorazowe `sessions.json` → `sessions.json.bak`. Błąd = jedna linia w logu. */
  #retireRegistryFile(): void {
    const file = join(this.#config.dataDir, 'sessions.json');
    try {
      renameSync(file, `${file}.bak`);
      console.warn(
        `rarog: session registry is no longer used — ${file} moved to ${file}.bak`,
      );
    } catch {
      // Brak pliku (normalny stan po pierwszym starcie) albo brak praw — jedno i drugie
      // nie ma prawa zablokować startu Raroga.
    }
  }

  /**
   * Podpina się pod nadzorcę herdr (jeśli jest) i zaczyna konsumować cykl życia paneli.
   *
   * Uploads sweep in the background: `<cwd>/.rarog-uploads/` files live 48 h and start is the only sure moment to
   * clean them, but `ready` (and `listen`) never waits for a disk walk that can hang on a macOS privacy prompt.
   * Order against the first attach is free: the sweep deletes only files older than the TTL.
   */
  #startHerdr(): void {
    const supervisor = this.#config.herdrSupervisor;
    if (supervisor === undefined) return;
    const deps = this.#config.herdrDeps;
    const roots = this.#config.herdrRoots ?? [];
    if (deps !== undefined && roots.length > 0) {
      void deps.sweepUploads(roots).catch((error: unknown) => {
        console.warn(`rarog: herdr uploads sweep failed: ${describeError(error)}`);
      });
    }
    void this.#herdrLifecycle.pumpHerdr(supervisor);
  }

  // -------------------------------------------------------------------------
  // ManagerApi — odczyt
  // -------------------------------------------------------------------------

  list(): SessionSummary[] {
    return [...this.#sessions.values()]
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .map((session) => this.#summaryOf(session));
  }

  get(id: string): SessionSummary | undefined {
    const session = this.#sessions.get(id);
    return session === undefined ? undefined : this.#summaryOf(session);
  }

  /**
   * Summary WZBOGACONE o ulotną aktywność — jedyne miejsce, które składa kształt dla klienta.
   *
   * `Session.summary()` zna wyłącznie stan trwały; aktywność żyje w RAM managera i ma ten sam
   * warunek co w `transcript-snapshot`: niesiemy ją TYLKO dla sesji, która naprawdę pracuje.
   * Zapamiętane „myśli…" nad sesją, która w międzyczasie stanęła, byłoby kłamstwem na liście.
   * Dzięki temu `sessions-snapshot` po reconnekcie odtwarza wiersze bez czekania na event.
   */
  #summaryOf(session: Session): SessionSummary {
    const summary = session.summary();
    this.#prStatus.overlay(summary);
    const activity = heldActivity(session, this.#now());
    if (activity !== undefined && WORKING_STATES.includes(session.state)) summary.activity = activity;
    // Na co czeka sesja stojąca na decyzji — liczone TU, z kolejki, nigdy trzymane w `Session`.
    const waitingFor = this.#waitingFor(session);
    if (waitingFor !== undefined) summary.waitingFor = waitingFor;
    const cliUpdate = this.#cli.cliUpdateOf(session);
    if (cliUpdate !== undefined) summary.cliUpdate = cliUpdate;
    // Przycisk „Uruchom ponownie i wyślij”: `seq` notki i `id` blokady — ładunek wysyłki zostaje w RAM.
    if (session.promptBlocked !== undefined) {
      summary.promptBlocked = { seq: session.promptBlocked.seq, id: session.promptBlocked.id };
    }
    return summary;
  }

  /**
   * Przyjęta rejestracja hooka kanału zgód w sesji silnika `engineSessionId` — z gniazda rejestracji
   * (`server/src/index.ts`). Szturchnięcie kanału ({@link #consentNudge}): karta kanału nie czeka na takt rejestru.
   * A new registration also ends the claim window of the conversation (`claim-window.ts`): a new request comes.
   */
  noteConsentRegistration(engineSessionId: string): void {
    this.#claimWindows.registration(engineSessionId);
    this.#consentNudge(engineSessionId);
  }

  /**
   * Szturchnięcie kanału zgód: świeży odczyt rejestru CLI poza taktem i jego sygnał dla driverów tej
   * sesji silnika ({@link SessionDriver.noteConsentNudge}). Driver obserwuje tylko przy `waiting: permission`, a wtedy
   * obserwacja kanału czyta ekran i zrzuty od razu, zamiast czekać do 1,5 s na takt. Wyzwalacze: przyjęta rejestracja
   * hooka i wejście panelu w blokadę przy kanale zgód. Odczyty idą po kolei, a szturchnięcia z czasu odczytu łączą się
   * w jeden następny. Odczyt nieudany nie zmienia niczego; starszy niż przyjęty sygnalizuje stan już przyjęty. Inne
   * drivery dostaną ten sam odczyt dopiero z taktu: szturchnięcie nie zużywa ich prób oceny ekranu.
   */
  #consentNudge(engineSessionId: string | undefined): void {
    if (engineSessionId === undefined || engineSessionId === '' || this.#disposed) return;
    if (this.#config.cliWaiting !== true || this.#config.cliVersionReader === undefined) return;
    this.#consentNudges.add(engineSessionId);
    if (!this.#consentNudging) void consentStep('nudge', this.#config.logger, () => this.#runConsentNudges());
  }

  async #runConsentNudges(): Promise<void> {
    const reader = this.#config.cliVersionReader;
    if (reader === undefined) return;
    this.#consentNudging = true;
    try {
      while (this.#consentNudges.size > 0 && !this.#disposed) {
        const targets = new Set(this.#consentNudges);
        this.#consentNudges.clear();
        const snapshot = await reader({ registryOnly: true }).catch(() => null);
        if (this.#disposed) return;
        if (snapshot === null || snapshot.registry === null) continue;
        this.#cli.acceptCliRegistry(snapshot);
        for (const session of this.#sessions.values()) {
          if (session.engineSessionId === undefined || !targets.has(session.engineSessionId)) continue;
          session.driver?.noteConsentNudge?.(this.#cli.cliWaitingOf(session));
        }
      }
    } finally {
      this.#consentNudging = false;
    }
  }

  /**
   * Skrót stojącej decyzji dla LISTY — fakty, nie gotowy napis.
   *
   * Liczony z `#pending` przy każdym `#summaryOf` i nigdzie nie zapamiętywany: wpis znika
   * razem z kartą (`permission-cleared`, `#expirePending`, odpowiedź), więc nie ma kodu,
   * który musiałby to pole kasować — a takiego kodu nikt nie wywoła w ścieżce, o której
   * zapomniał. Pierwsza karta w kolejce, bo SDK potrafi zgłosić kilka naraz, a linia karty
   * ma jeden wiersz; kolejne widać po wejściu w sesję.
   *
   * Dialog z ekranu (`herdrDialog`) świadomie NIE ma tu wpisu: jego rodzaj jedzie kanałem
   * globalnym własnym polem, więc drugi opis tej samej rzeczy byłby dwoma źródłami
   * prawdy o jednym dialogu.
   */
  #waitingFor(session: Session): WaitingFor | undefined {
    if (!DECISION_STATES.includes(session.state)) return undefined;
    // Karta kanału zgód liczy się jako „czeka na człowieka” wyłącznie w stanie `pending`.
    const permission = this.#pending.permissionsFor(session.id)[0]
      ?? this.#consentCards.consentRequests(session).find((request) => request.state === 'pending');
    if (permission !== undefined) {
      const text = waitingText(decisionText(permission));
      return {
        kind: 'permission',
        tool: permission.toolName,
        ...(text === '' ? {} : { text }),
        // Lista mówi „plan" z tego pola, nie z nazwy `ExitPlanMode`.
        subject: permission.subject ?? permissionSubject(permission.toolName),
      };
    }
    const question = this.#pending.questionsFor(session.id)[0];
    if (question === undefined) return undefined;
    const text = waitingText(question.questions[0]?.question ?? '');
    return {
      kind: 'question',
      ...(text === '' ? {} : { text }),
      // „1" nie jest informacją: numeracja na karcie ma sens dopiero od dwóch pytań.
      ...(question.questions.length > 1 ? { count: question.questions.length } : {}),
    };
  }

  /**
   * Nieznane id → pusty transkrypt (router i tak sprawdza `get()` i odpowiada 404). `peek` = odczyt bez skutku
   * otwarcia transkryptu (odświeżenia gita i ponowienia ramki `git-status`), patrz {@link ManagerApi.transcript}.
   */
  transcript(id: string, opts?: { peek?: boolean }): {
    messages: TranscriptMessage[];
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
    activity?: Activity;
  } {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return { messages: [], pendingPermissions: [], pendingQuestions: [] };
    }
    // Karty kanału zgód w bieżącym stanie, po kartach z ekranu: reconnect widzi każdą raz. Karta, którą
    // urządzenie zna tylko z migawki (np. odtworzona przy starcie), dostaje potem `permission-settled` przy zmianie
    // i `permission-resolved` w stanie końcowym, a nie drugie `permission-pending`.
    const consentCards = this.#consentCards.consentRequests(session);
    this.#consentCards.noteShown(session, consentCards);
    const result: {
      messages: TranscriptMessage[];
      pendingPermissions: PermissionRequest[];
      pendingQuestions: QuestionRequest[];
      activity?: Activity;
    } = {
      messages: session.recentMessages(),
      pendingPermissions: [...this.#pending.permissionsFor(id), ...consentCards],
      pendingQuestions: this.#pending.questionsFor(id),
    };
    // Aktywność tylko dla sesji, która PRACUJE: zapamiętany „myśli…" nad sesją, która
    // w międzyczasie stanęła, byłby kłamstwem.
    const activity = heldActivity(session, this.#now());
    if (activity !== undefined && WORKING_STATES.includes(session.state)) result.activity = activity;
    // Otwarcie transkryptu = ktoś patrzy na wiersz gita — lista plików ma być z TERAZ,
    // a nie z ostatniego tool-calla sprzed godziny (throttle per sesja/katalog zostaje).
    // Gdy throttle odczyt pominie, klient dostaje OSTATNI znany status (`#replayGitStatus` w `session-git.ts`).
    if (opts?.peek !== true) this.#git.requestGitStatus(session, false, true);
    return result;
  }

  eventsSince(id: string, seq: number | null): {
    tooOld: boolean;
    events: { seq: number | null; event: ServerEvent }[];
  } {
    const session = this.#sessions.get(id);
    // Brak sesji w RAM = kursor nie ma do czego wrócić → snapshot.
    if (session === undefined) return { tooOld: true, events: [] };
    // Brak kursora: klient dostaje snapshot + live, nie replay.
    if (seq === null) return { tooOld: false, events: [] };
    if (session.ring.tooOld(seq)) return { tooOld: true, events: [] };
    return {
      tooOld: false,
      events: session.ring.entriesSince(seq).map((entry) => ({
        seq: entry.seq,
        event: entry.value,
      })),
    };
  }

  onEvent(cb: EventListener): void {
    this.#listeners.push(cb);
  }

  onTranscriptReset(cb: (sessionId: string) => void): void {
    this.#transcriptResets.push(cb);
  }

  projects(): { path: string; name: string }[] {
    const configured = this.#config.projects;
    if (configured !== undefined) {
      return configured.map((entry) => (typeof entry === 'string'
        ? { path: entry, name: basename(entry) }
        : { path: entry.path, name: entry.name ?? basename(entry.path) }));
    }
    if (this.#config.demo) return this.#requireDemo().demoProjects();
    return scanProjectRoots(this.#roots());
  }

  /**
   * Korzenie projektów; brak konfiguracji = `~/Projects` (default ze speca).
   *
   * Pusta TABLICA jest znacząca i celowo NIE wpada na default: oznacza „żadnych korzeni",
   * czyli allow-listę zawężoną wyłącznie do `projects` (tak chodzą testy).
   */
  #roots(): readonly string[] {
    return this.#config.projectRoots ?? [join(homedir(), 'Projects')];
  }

  /** System maszyny serwera do słowa maszyny w zdaniach `.mac`/`.vps` ({@link ManagerConfig.system}). */
  get #system(): ServerSystem {
    return this.#config.system ?? serverSystem();
  }

  async resumable(cwd: string): Promise<ResumableSession[]> {
    // Ta sama allow-lista co przy zakładaniu sesji: lista transkryptów zdradza treść
    // pierwszych promptów, więc nie wolno jej czytać dla dowolnej ścieżki z requestu.
    this.#assertAllowedCwd(cwd);
    // Awaria magazynu (brak katalogu, brak uprawnień) to pusta lista, nie błąd 500 —
    // magazyn należy do CLI i Rarog nie ma nad nim kontroli.
    /*
     * `limit` PODAJEMY jawnie: `MAX_RESUMABLE_SESSIONS` jest kontraktem tej listy (20 wpisów),
     * a sufit czytnika (`ENGINE_SESSION_FETCH_CAP`) to zupełnie inna liczba — zabezpieczenie
     * pobrania, nie długość listy. Bez tego katalog z setką sesji rysował 300 wierszy.
     */
    const entries = await this.#resumableReader({ dir: cwd, limit: MAX_RESUMABLE_SESSIONS })
      .catch(() => []);
    // Magazyn CLI to płaski katalog plików i nie wie, co jest OTWARTE w terminalu. Wie to
    // wyłącznie manager: wpis żywy w herdr zostaje na liście, ale wyszarzony — bo
    // wznowienie go znaczyłoby dwóch pisarzy do jednego pliku jsonl.
    /*
     * Druga linia obrony po `includeWorktrees: false`: wpis o INNYM katalogu nie ma prawa
     * stanąć na liście tego katalogu. Kosztuje jedno porównanie ścieżek i chroni przed
     * zmianą domyślnych opcji po tamtej stronie — cena pomyłki to pokazanie pierwszego zdania
     * rozmowy spoza allow-listy.
     */
    const here = resolve(cwd);
    return entries.filter((entry) => resolve(entry.cwd) === here).map((entry) => {
      const live = this.#liveSession(entry.engineSessionId);
      // Etykieta idzie TYLKO z karty, którą i tak musieliśmy odnaleźć dla `liveInHerdr` —
      // żadnego pytania herdr, żadnego dodatkowego I/O.
      const label = live?.label;
      return {
        ...entry,
        liveInHerdr: live !== null,
        // Cel „przejdź do otwartej rozmowy”: apka bez tego zgadywała kartę po katalogu.
        ...(live !== null ? { sessionId: live.id } : {}),
        ...(label !== undefined && label !== '' ? { title: label } : {}),
      };
    });
  }

  /**
   * Ostatnie sesje JEDNEGO projektu do wznowienia (`GET /api/resumable/recent?cwd=…`).
   *
   * Różnica wobec `resumable()` jest jedna i jest nią PYTANIE. Tamta lista mówi „oto historia
   * tego katalogu, wybierz" — pokazuje wszystko, a sesje otwarte oznacza. Ta mówi „wróć do
   * tego, co tu robiłeś" — więc wpisy otwarte z niej WYPADAJĄ (nie ma czego wznawiać, a stoją
   * o ekran wyżej, w sekcji AGENCI) i zostaje najwyżej `MAX_RECENT_SESSIONS` najświeższych.
   *
   * Źródłem prawdy o tym, co otwarte, jest `claude agents --json` — jako jedyne widzi także
   * `claude` uruchomionego w gołym tmuxie, o którym herdr nie wie. Cisza tego czytnika („nie
   * wiem") NIE odsiewa niczego: lepszy wiersz za dużo, który po tapnięciu dostanie 409, niż
   * pusta lista przy każdej awarii komendy.
   */
  async recentResumable(
    cwd: string, limit: number = MAX_RECENT_SESSIONS,
  ): Promise<ResumableSession[]> {
    this.#assertAllowedCwd(cwd);
    // Pobieramy z zapasem: wpisy otwarte odpadają PO odczycie, więc pytanie o dokładnie
    // `limit` oddawałoby krótszą listę dokładnie wtedy, gdy w projekcie coś żyje.
    const entries = await this.#resumableReader({ dir: cwd, limit: limit * 4 }).catch(() => []);
    const live = await this.#liveSessions();
    const here = resolve(cwd);
    const out: ResumableSession[] = [];
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (resolve(entry.cwd) !== here) continue;
      if (live?.has(entry.engineSessionId) === true) continue;
      if (this.#liveSession(entry.engineSessionId) !== null) continue;
      out.push(entry);
    }
    return out;
  }

  /** Recent projects (`GET /api/projects/recent`); the rule lives in `recent-projects.ts`, open = live pane. */
  async recentProjects(limit: number = MAX_RECENT_PROJECTS): Promise<RecentProject[]> {
    return recentProjects({
      readSessions: (opts) => this.#resumableReader(opts), isAllowedCwd: (cwd) => this.#isAllowedCwd(cwd),
      openSessions: () => [...this.#sessions.values()].filter((s) => s.driver !== null), now: () => this.#now(),
    }, limit);
  }

  /** Allow-lista jako pytanie, nie wyjątek — dla list, na których obcy wpis ma po prostu wypaść. */
  #isAllowedCwd(cwd: string): boolean {
    try {
      this.#assertAllowedCwd(cwd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Karta sesji z ŻYWYM panelem dla tej sesji silnika — albo `null`.
   *
   * To jest PODPOWIEDŹ DLA UI („Otwórz sesję" zamiast „Wznów"), a nie bramka bezpieczeństwa:
   * indeks w RAM gubi panele ukryte, a ukryty panel dalej pisze. Bramką jest
   * `#assertResumable` w `launch-gate.ts`, które pyta o to `agent.list`.
   */
  #liveSession(engineSessionId: string): Session | null {
    const sessionId = this.#byEngineSession.get(engineSessionId);
    if (sessionId === undefined) return null;
    const session = this.#sessions.get(sessionId);
    return session !== undefined && session.driver !== null ? session : null;
  }

  /**
   * Wpisuje sesję do indeksu `engineSessionId → sessionId`.
   *
   * Indeks trzyma WYŁĄCZNIE sesje nieterminalne: `done` nikomu już nie pisze, a zajmowanie
   * przez nią identyfikatora blokowałoby wznowienie tej samej sesji silnika na zawsze.
   */
  #indexEngineSession(session: Session, previous?: string): void {
    if (previous !== undefined && this.#byEngineSession.get(previous) === session.id) {
      this.#byEngineSession.delete(previous);
    }
    const id = session.engineSessionId;
    if (id === undefined || session.state === 'done') return;
    this.#byEngineSession.set(id, session.id);
  }

  /** Zdejmuje sesję z indeksu (stan terminalny, `gone`, ukrycie, eksmisja). */
  #unindexEngineSession(session: Session): void {
    const id = session.engineSessionId;
    if (id === undefined) return;
    if (this.#byEngineSession.get(id) === session.id) this.#byEngineSession.delete(id);
  }

  /**
   * Stan integracji herdr do ramki `sessions-snapshot` (jedyne źródło banera w kliencie).
   *
   * `undefined` znaczy „integracja wyłączona" — a to co innego niż „herdr niedostępny",
   * bo przy wyłączonej integracji baner ma w ogóle nie istnieć.
   */
  herdrStatus(): HerdrStatus | undefined {
    // `detailRef` niesie sam nadzorca (zdanie z `say()` obok tekstu), manager go nie dopasowuje.
    return this.#config.herdrSupervisor?.status();
  }

  // -------------------------------------------------------------------------
  // ManagerApi — cykl życia sesji
  // -------------------------------------------------------------------------

  /**
   * Zakłada NOWY PANEL w herdr i oddaje `202` z prawdziwym `sessionId` — nie czekając na
   * gotowość agenta.
   *
   * Kolejność sprawdzeń jest tu całą treścią funkcji i jest kolejnością RYZYKA: wszystko, co
   * może odmówić, dzieje się ZANIM cokolwiek powstanie po drugiej stronie. Panel, którego
   * Rarog nie umie dokończyć, jest gorszy niż odmowa (reguła 11.9).
   *
   * `agent.start` kończy się w 1,4 ms, ale `interactive_ready` przychodzi po ~5 s. Blokujący
   * POST na te 5 s ginie przy zgaszeniu ekranu iOS i zostawia telefon ze spinnerem przy ŻYWYM
   * panelu — dlatego uchwyt wraca teraz, a reszta startu jedzie po SSE (`#finishLaunch`).
   */
  async create(opts: CreateSessionOptions): Promise<CreateSessionResponse> {
    return this.#launch(opts, false);
  }

  /**
   * `create()` z jednym przełącznikiem: `slotTaken` — slot throttle'a zajął już restart
   * przed `/exit`, więc drugie naliczenie odmówiłoby 429 PO zabiciu procesu.
   */
  async #launch(opts: LaunchOptions, slotTaken: boolean): Promise<CreateSessionResponse> {
    const supervisor = this.#requireSupervisor();
    const deps = this.#requireHerdrDeps();
    // Every check that can refuse, then the launch slot and the start prompt guard (`launch-gate.ts`).
    const admitted = await this.#launchGate.admitLaunch(supervisor, opts, slotTaken);
    opts = admitted.opts;
    const { resumeModelSeed, ultracodeDropped, prompt } = admitted;

    const ultracode = opts.ultracode === true;
    const request = {
      cwd: opts.cwd,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(ultracode ? { ultracode: true } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.resumeFrom !== undefined ? { resumeFrom: opts.resumeFrom } : {}),
      ...(opts.fork === true ? { fork: true } : {}),
    };
    // Chwila żądania ultracode PRZED startem procesu: znacznik z pliku młodszy od niej mówi o tym panelu.
    const ultracodeRequestedAt = this.#now();
    const handle = await supervisor.launch(request);

    const at = this.#iso();
    /*
     * Model rozwiązany PRZED kartą, bo effort domyślny zależy od modelu: CLI trzyma go
     * w `modelSettings[<model>].effortLevel`, więc pytanie „jaki effort" ma sens dopiero
     * wtedy, gdy wiadomo, na czym panel wstanie.
     */
    // Wznowienie bez `--model` wstaje na modelu rozmowy (CLI przywraca go sam), nie na modelu konta.
    const model = opts.model ?? resumeModelSeed ?? this.#config.accountDefaultModel?.();
    // Liczona PRZED kartą: `#labelFor` numeruje `session N` po kartach projektu, a ta jeszcze
    // nie stoi w mapie.
    // Ponowna wysyłka używa słów z dymka: tekst dla CLI niesie ścieżki załączników.
    const label = this.#labelFor(
      opts.cwd, opts.promptDisplay !== undefined ? textOfBlocks(opts.promptDisplay.blocks) : prompt?.text ?? null,
    );
    const session = new Session({
      // Alias wygrywa z `sessionIdFor(key)`: wznowienie tej samej sesji silnika ma zostać
      // TĄ SAMĄ kartą, także po restarcie Raroga („Data model: what does not exist” w `docs/architecture.md`).
      id: opts.sessionId
        ?? deps.aliasFor(handle.agentSessionId)
        ?? deps.sessionIdFor(handle.key),
      cwd: opts.cwd,
      title: basename(opts.cwd),
      state: 'starting',
      stateDetail: HERDR_LAUNCHING_DETAIL,
      stateSince: at,
      createdAt: at,
      lastActivityAt: at,
      permissionMode: opts.permissionMode,
      /*
       * Do pierwszego `init` z jsonl pokazujemy to, co wybrał użytkownik; silnik odeśle
       * identyfikator rozwiązany i wtedy pigułka pokaże prawdę. Brak wyboru = „domyślny
       * konta" — i to NIE jest zgadywanie: argv składamy sami, więc wiemy, że flagi
       * `--model` nie ma, a panel wstanie na tym, co stoi w `~/.claude/settings.json`.
       * Bez tego seedu pigułka sesji założonej „+"-em stałaby na „model?" aż do pierwszej
       * odpowiedzi silnika.
       *
       * Effort chodzi tą samą drogą i z tego samego powodu. Panel bez `--effort` wstaje na `effortLevel`
       * z tego samego pliku, więc milczenie pigułki było stratą informacji, nie ostrożnością.
       */
      model,
      // Flaga `--effort ultracode` ustawia poziom `xhigh` (docs), więc karta pokazuje go od startu.
      effort: ultracode ? 'xhigh' : opts.effort ?? this.#config.accountDefaultEffort?.(model),
      // Ultracode ŻĄDANE do pierwszego dowodu z pliku rozmowy; bez flagi pola nie ma (nie znamy ustawień CLI).
      ...(ultracode ? { ultracode: true } : {}),
      // Zapas bramki wersji zmiany w locie, póki rejestr procesów CLI nie ma wpisu tego panelu.
      ...(this.#cli.cliVersion.installed !== null ? { cliVersionAtLaunch: this.#cli.cliVersion.installed } : {}),
      engineSessionId: handle.agentSessionId,
      paneId: handle.paneId,
      herdrKey: handle.key,
      launchedByRarog: true,
      ringStartSeq: opts.continuesRing?.lastSeq,
    });
    // Etykieta karty → etykieta taba w herdr. Launcher założył tab z nazwą katalogu;
    // nadzorca przemianuje go, gdy panel dostanie etykietę pochodzenia.
    this.#setLabel(session, label);
    this.#sessions.set(session.id, session);
    // A card under an existing id: the open transcript streams get a snapshot before the first frame of the new card.
    for (const listener of opts.continuesRing === undefined ? [] : this.#transcriptResets) {
      try { listener(session.id); } catch { /* A broken listener must not fail the launch. */ }
    }
    this.#herdrByKey.set(handle.key, session.id);
    this.#indexEngineSession(session);
    this.#git.watch(session);
    deps.rememberAlias(handle.agentSessionId, session.id);

    // Przed podpięciem drivera: jego pierwsze zdarzenia (historia pliku, `idle`) przychodzą przed gotowością.
    session.launchPending = true;
    this.#startExits.delete(session);
    this.#attachDriver(session, supervisor.attach(handle.key));
    /*
     * Chwila żądania to odcięcie historii, póki rejestr nie poda startu procesu. Reguła pierwszej tury:
     * odpowiedź bez znacznika włączenia po tym żądaniu = CLI ultracode nie włączyło. Tylko nowa rozmowa: po
     * `--resume` z flagą (restart, „Wznów”) CLI ultracode włącza, ale pierwsza tura załącznika nie ma, bo stoi on
     * już w historii (pomiar 2.1.318, `ultracode/wznowienie-z-flaga.jsonl`); reguła dałaby tam `false`. Fork niesie
     * tę samą historię, więc też idzie bez reguły (niezmierzone). Karta zostaje wtedy przy żądanym `true` do
     * pierwszego znacznika.
     */
    if (ultracode) session.driver?.noteUltracodeRequest?.(ultracodeRequestedAt, opts.resumeFrom === undefined);
    /*
     * Katalog bez zaufania: to OSTRZEŻENIE, nie odmowa. Panel wstanie
     * na dialogu zaufania, a ten jest na zamkniętej liście sygnatur — czyli da się go
     * potwierdzić z telefonu. Zdanie idzie i do odpowiedzi (arkusz w kliencie), i do transkryptu:
     * odpowiedź widzi jedno urządzenie przez chwilę, transkrypt — każde i zawsze.
     */
    const trustPrompt = handle.trustPrompt === true;
    if (trustPrompt) {
      this.#appendMessage(session, 'system', [{ type: 'text', text: HERDR_TRUST_PROMPT_MESSAGE }]);
    }
    if (ultracodeDropped) {
      this.#appendMessage(session, 'system', [{ type: 'text', text: RESUME_WITHOUT_ULTRACODE_MESSAGE }]);
    }
    this.#emitState(session);
    this.#emitSessionChanged(session);
    // 202 wraca TERAZ; `ready` rozstrzyga się w tle i jedzie po SSE.
    void this.#finishLaunch(session, handle, prompt, opts.promptDisplay);
    return trustPrompt
      ? { sessionId: session.id, state: 'starting', trustPrompt: true }
      : { sessionId: session.id, state: 'starting' };
  }

  /**
   * Druga połowa zakładania sesji — po odpowiedzi HTTP.
   *
   * Prompt startowy leci `driver.send()`, czyli tym samym kanałem co każda inna wysyłka:
   * przez throttle, audyt i `agent.prompt`. NIGDY przez argv („Starting sessions from the phone: three powers” w `docs/security-model.md`) — `agent.start` wpisuje
   * argumenty do powłoki panelu, więc zdanie człowieka nie ma prawa się tam znaleźć.
   *
   * Restart kończy się tu w OBU gałęziach: bez promptu po gotowości, z promptem (ponowna wysyłka
   * promptu zablokowanego przez hook) dopiero PO wysyłce — rezerwacja trzyma kartę, więc zwykła
   * wysyłka z telefonu nie wejdzie przed ten prompt. Notka restartu staje przed jego dymkiem.
   *
   * @param display dymek promptu startowego (zdanie bez ścieżek i wizytówki załączników); brak =
   *   dymek z samego tekstu
   */
  async #finishLaunch(
    session: Session, handle: HerdrLaunchHandle,
    start: (SendableText & { catalog: CommandCatalog }) | null, display?: PromptDisplay,
  ): Promise<void> {
    const prompt = start?.text ?? null;
    let interactiveReady: boolean;
    try {
      ({ interactiveReady } = await handle.ready);
    } catch (error: unknown) {
      session.launchPending = false;
      // Sesja mogła w międzyczasie zostać ukryta albo zamknięta.
      if (this.#sessions.get(session.id) !== session) {
        this.#sessionRestart.restarts.delete(session.id);
        return;
      }
      this.#detachDriver(session);
      const restart = this.#sessionRestart.restarts.get(session.id);
      if (restart !== undefined) this.#sessionRestart.restarts.delete(session.id);
      /*
       * Start PO restarcie padł definitywnie (proces nie wstał: „No conversation found",
       * odmowa herdr) — karta czeka na „Wznów" z tymi samymi opcjami. Wynik NIEPEWNY (zgubiona
       * odpowiedź, brak gotowości w oknie) idzie zwykłą drogą `error`: proces mógł wstać,
       * a karta „wznawialna" zapraszałaby do drugiego pisarza.
       */
      if (restart !== undefined && !uncertainLaunch(error)) {
        this.#applyTransition(
          session, { type: 'backend-restart' }, restartFailedDetail(error),
        );
        return;
      }
      this.#applyTransition(
        session, { type: 'driver-exit', ok: false },
        herdrLaunchFailedDetail(error),
      );
      return;
    }
    /*
     * Start stanął na dialogu (zaufanie katalogu): launcher oddaje wtedy `ready` od razu, z `interactiveReady:
     * false`. To nie jest gotowość: prompt wysłany teraz herdr odrzuca `agent_blocked` i zdanie przepada. Rezerwacja
     * (`launchPending`) trzyma kartę do `idle` panelu po dialogu, więc zwykła wysyłka nie wyprzedzi promptu
     * startowego. Dotyczy tylko startu z promptem: pusta sesja wstaje bez czekania.
     */
    if (prompt !== null && !interactiveReady && !(await this.#awaitStartReady(session, prompt, display))) {
      // Unieważnione (panel zniknął, proces wyszedł, karta zamknięta): zdanie stoi już w transkrypcie.
      session.launchPending = false;
      this.#sessionRestart.restarts.delete(session.id);
      return;
    }
    // Panel gotowy: od teraz karta wychodzi ze `starting` jak każda; niżej prompt startowy albo tura zerowa.
    session.launchPending = false;
    // Sesja zniknęła spod nóg (ukryta albo zamknięta) — nie ma komu i po co pisać.
    // Rezerwacja restartu gaśnie razem z nią, inaczej blokowałaby następną kartę o tym id.
    if (this.#sessions.get(session.id) !== session) {
      this.#sessionRestart.restarts.delete(session.id);
      return;
    }
    /*
     * Panel wstał, ale driver już się odpiął — a w ręku mamy ZDANIE UŻYTKOWNIKA, którego nie
     * ma jak wysłać. Cicha odmowa jest tu najgorszą możliwą odpowiedzią: telefon pokazywałby
     * pustą, działającą sesję i wyglądałoby to na „prompt poszedł" (reguła 11.9). Zdanie
     * zostaje w transkrypcie razem z wyjaśnieniem, żeby dało się je wkleić ponownie.
     */
    if (session.driver === null) {
      this.#sessionRestart.restarts.delete(session.id);
      if (prompt !== null) this.#lostStartPrompt(session, prompt, display);
      return;
    }
    session.stateDetail = undefined;
    const restart = this.#sessionRestart.restarts.get(session.id);
    if (prompt === null) {
      // Pusta sesja: panel stoi i czeka na pierwszą wiadomość. `waiting-input` jest tu prawdą,
      // a `starting` bez końca byłoby dokładnie tym UI, które kłamie.
      session.emptyStart = true;
      this.#settleEmptyStart(session);
      if (restart !== undefined) await this.#sessionRestart.finishRestart(session, restart);
      return;
    }
    if (restart !== undefined) {
      // Notka restartu PRZED dymkiem ponownej wysyłki; rezerwacja wciąż trzyma kartę.
      await this.#sessionRestart.noteRestart(session, restart);
      if (this.#sessions.get(session.id) !== session || this.#sessionRestart.restarts.get(session.id) !== restart) {
        if (this.#sessionRestart.restarts.get(session.id) === restart) this.#sessionRestart.restarts.delete(session.id);
        return;
      }
      if (session.driver === null) {
        this.#sessionRestart.restarts.delete(session.id);
        this.#lostStartPrompt(session, prompt, display);
        return;
      }
    }
    const blocks = display?.blocks ?? userBlocks(prompt);
    const attachments = display?.attachments ?? [];
    // Slot throttle'a bierzemy tak samo jak przy zwykłej wysyłce — nie po to, żeby odmówić
    // (panel jest świeży, slot zawsze wolny), tylko żeby licznik godzinny znał tę wysyłkę.
    this.#config.herdrDeps?.takeSendSlot(session.herdrKey ?? session.id);
    this.#appendMessage(session, 'user', blocks, undefined, attachments.length > 0 ? attachments : undefined);
    // Zwykle bez skutku: rachunek świeżo podpiętej sesji jest niepełny do końca pierwszej tury.
    this.#noteTurnInput(session);
    // Prompt startowy też może zablokować hook (pierwszy wpis świeżej sesji przychodzi z historii); znacznik
    // tury otwartej wysyłką ustawia się jak przy zwykłej wysyłce — także po restarcie z ponowną wysyłką.
    this.#noteSend(session, prompt, blocks, attachments);
    // Klasyfikacja z bramki przed `launch()` jedzie z wysyłką: driver nie zgaduje komendy z tekstu.
    session.driver.send(prompt, undefined, undefined, start === null ? undefined : {
      command: { catalog: start.catalog, slash: start.slash },
    });
    this.#applyTransition(session, { type: 'turn-start' });
    this.#emitSessionChanged(session);
    if (restart !== undefined) {
      // Prompt już w kolejce drivera: dopiero teraz karta przyjmuje inne akcje.
      if (this.#sessionRestart.restarts.get(session.id) === restart) this.#sessionRestart.restarts.delete(session.id);
      await this.#sessionRestart.closeRestartTab(session, restart);
    }
  }

  /**
   * Panel wstał, ale driver już się odpiął — a w ręku mamy ZDANIE UŻYTKOWNIKA (prompt startowy albo ponowna
   * wysyłka po blokadzie). Zdanie zostaje w transkrypcie razem z wyjaśnieniem, żeby dało się je wkleić.
   */
  #lostStartPrompt(session: Session, prompt: string, display?: PromptDisplay): void {
    const attachments = display?.attachments ?? [];
    this.#appendMessage(
      session, 'user', display?.blocks ?? userBlocks(prompt), undefined,
      attachments.length > 0 ? attachments : undefined,
    );
    this.#appendMessage(session, 'system', [{ type: 'text', text: HERDR_LOST_PROMPT_MESSAGE }]);
    this.#emitSessionChanged(session);
  }

  /**
   * Czekanie promptu startowego na koniec dialogu startowego. Gotowość to `idle` panelu
   * po dialogu: zdarzenie drivera (`#settleStartWait`) albo stan bieżący nadzorcy w chwili założenia oczekiwania,
   * bo `idle` mogło przyjść, zanim `ready` się rozstrzygnęło. Wymiana drivera (`claude` po decyzji uruchamia się od
   * nowa, nadzorca ogłasza `re-attached`) oczekiwania nie przerywa; unieważnia je `#dropStartWait`.
   *
   * @returns `true` = dalej zwykłą drogą `#finishLaunch` (panel gotowy albo karta bez panelu, którą obsłuży ta
   *   droga); `false` = unieważnione, zdanie już w transkrypcie
   */
  #awaitStartReady(session: Session, prompt: string, display?: PromptDisplay): Promise<boolean> {
    const key = session.herdrKey;
    // Karta zapomniana albo panel zniknął przed rozstrzygnięciem startu: zdanie odda zwykła droga (brak drivera).
    if (this.#sessions.get(session.id) !== session || key === undefined || this.#herdrByKey.get(key) !== session.id) {
      return Promise.resolve(true);
    }
    /*
     * Driver wyszedł (`exit`), zanim `ready` się rozstrzygnęło: oczekiwania jeszcze nie było, więc `#dropStartWait`
     * nie miał czego unieważnić. Zdanie wraca do transkryptu tak samo jak przy wyjściu w trakcie oczekiwania. Sam
     * brak drivera tego nie rozstrzyga: `re-attached` podpina nowy driver asynchronicznie (kolejka slotów).
     */
    if (this.#startExits.delete(session)) {
      this.#lostStartPrompt(session, prompt, display);
      return Promise.resolve(false);
    }
    if (session.driver !== null && this.#paneReady(key, 'current')) return Promise.resolve(true);
    this.#config.logger?.(`herdr: start ${session.id} on a dialog, the start prompt waits for the pane to be ready`);
    return new Promise<boolean>((resolve) => {
      this.#startWaits.set(session, { prompt, display, settle: resolve });
    });
  }

  /**
   * Gotowość panelu według nadzorcy. `current` (stan bieżący przy zakładaniu oczekiwania): `idle` i
   * `interactive_ready`; bez wpisu nadzorcy nic nie wiadomo, więc czekamy. `event` (driver właśnie zgłosił `idle`):
   * wystarczy, że nadzorca nie mówi „nie gotowy”, bo `agent.prompt` oddałby wtedy `agent_not_ready`.
   */
  #paneReady(key: string, mode: 'current' | 'event'): boolean {
    const agent = this.#config.herdrSupervisor?.agentFor?.(key);
    if (agent === undefined) return mode === 'event';
    return mode === 'current' ? agent.status === 'idle' && agent.interactiveReady : agent.interactiveReady;
  }

  /** Driver zgłosił `idle`: czekający prompt startowy rusza, gdy nadzorca nie mówi „nie gotowy”. */
  #settleStartWait(session: Session): void {
    const wait = this.#startWaits.get(session);
    const key = session.herdrKey;
    if (wait === undefined || key === undefined || !this.#paneReady(key, 'event')) return;
    this.#startWaits.delete(session);
    wait.settle(true);
  }

  /**
   * Unieważnia czekający prompt startowy: panel zniknął (także po „No, exit” na dialogu zaufania), driver wyszedł
   * albo karta została zamknięta. Zdanie trafia do transkryptu teraz, póki karta jeszcze jest (`#lostStartPrompt`,
   * z załącznikami dymka); przy zamykaniu Raroga tylko gaśnie.
   */
  #dropStartWait(session: Session): void {
    const wait = this.#startWaits.get(session);
    if (wait === undefined) return;
    this.#startWaits.delete(session);
    if (!this.#disposed) this.#lostStartPrompt(session, wait.prompt, wait.display);
    wait.settle(false);
  }

  /** Nadzorca albo twardy błąd — bez niego Rarog nie ma z czego zrobić sesji. */
  #requireSupervisor(): HerdrSupervisor {
    const supervisor = this.#config.herdrSupervisor;
    if (supervisor === undefined) throw new BadStateError(HERDR_LAUNCH_OFF_MESSAGE);
    return supervisor;
  }

  /**
   * Kolejna tura użytkownika — zawsze do ŻYWEGO PANELU w herdr.
   *
   * Zwraca `Promise`, bo PRZED przejściem stanu trzeba odczytać tryb panelu i zapisać
   * załączniki na dysk. Router czeka na wynik, więc 400/429 wraca jako odpowiedź na POST,
   * a nie jako wiadomość w transkrypcie.
   *
   * `clientMessageId`: rejestr wysyłek idzie PRZED wszystkimi bramkami poniżej — lookup
   * i kontrola skrótu treści, powtórka przyjętej albo dołączenie do wysyłki w toku, rezerwacja,
   * i dopiero potem `track` (`session-restart.ts`) z bramkami stanu, zasięgu i throttle'a. Dlatego powtórka przy
   * karcie zgody (`waiting-permission`) oddaje 202 `replayed`, a nie 409, i nie zjada slotu.
   */
  sendMessage(
    id: string, text: string, images?: readonly string[], files?: readonly FileAttachment[],
    clientMessageId?: string, opts: SendMessageOptions = {},
  ): Promise<SendMessageAck> {
    if (clientMessageId === undefined) {
      return this.#sessionRestart.track(id, () => this.#sendMessage(id, text, images, files, undefined, opts))
        .then(() => NOT_REPLAYED);
    }
    const outcome = this.#sendRegistry.run(
      { clientMessageId, sessionId: id, digest: sendDigest(text, images, files) },
      () => this.#sessionRestart.track(
        id, () => this.#sendMessage(id, text, images, files, clientMessageId, opts),
      ),
    );
    // Dołączenie do wysyłki w toku dostaje TĘ SAMĄ obietnicę — także po dołożeniu `queued`.
    let ack = this.#queuedAcks.get(outcome);
    if (ack === undefined) {
      ack = outcome.then((result) => this.#withQueued(id, clientMessageId, result));
      this.#queuedAcks.set(outcome, ack);
    }
    return ack;
  }

  /**
   * `queued` w 202 liczone PO rejestrze wysyłek, z tego, co faktycznie czeka: jedna reguła
   * dla pierwszej wysyłki, dołączenia do wysyłki w toku i powtórki przyjętej. Echo już
   * podstawione albo spłukane = bez pola, a klient zgasił swój wpis echem.
   */
  #withQueued(id: string, clientMessageId: string, ack: SendMessageAck): SendMessageAck {
    const held = this.#sessions.get(id)?.heldEchoes.some((h) => h.clientMessageId === clientMessageId);
    return held === true ? { ...ack, queued: true } : ack;
  }

  #sendMessage(
    id: string, text: string, images?: readonly string[], files?: readonly FileAttachment[],
    clientMessageId?: string, opts: SendMessageOptions = {},
  ): Promise<void> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    // Panel z Raroga przed gotowością odmawia w każdym stanie karty: stan bywa w tym czasie stanem
    // dialogu startowego, a `agent.prompt` przed gotowością kończy się `agent_not_ready`.
    if (session.launchPending || !SENDABLE_STATES.includes(session.state) || session.driver === null) {
      throw new BadStateError(
        say('session.not-accepting-messages', { id, state: session.state }),
      );
    }
    /*
     * Znaczniki przerwania gasną NA WEJŚCIU, ale WRACAJĄ, gdy wysyłka zostanie odrzucona.
     *
     * Gaszenie na wejściu (przed pierwszym `await`) jest wymagane, bo bramek z `#sendToHerdr`
     * jest kilka i bywają długie (`#freshMode` czyta stopkę ekranu, `writeUploads` przy
     * zdjęciach to sekundy), a przez cały ten czas karta stoi jeszcze w `waiting-input`:
     * karencja zjadłaby push `working` tury, którą człowiek WŁAŚNIE wysłał, a okna
     * idempotencji połknęłyby Esc, który dotyczy już TEJ wysyłki.
     *
     * Przywracanie jest drugą połową tej samej reguły: dopóki bramka odmawia, żadna tura nie
     * ruszyła i gasić nie ma czego. Szczegóły w `InterruptWindows.suspendInterruptWindows`.
     */
    const restore = this.#interrupts.suspendInterruptWindows(session);
    return this.#sendToHerdr(session, text, images, files, clientMessageId, opts).catch((err: unknown) => {
      restore();
      throw err;
    });
  }

  /** The queue take-back (`session-take-back.ts`), counted as a mutation of the card like a send. */
  takeBackQueue(id: string, operationId: string): Promise<QueueTakeBackResponse> {
    return this.#sessionRestart.track(id, () => this.#takeBack.take(id, operationId));
  }

  /**
   * Miejsce w kolejce wysyłek sesji: `previous` rozstrzyga się, gdy wcześniejsza wysyłka oddała prompt
   * driverowi albo odpadła. Ogon czeka na obie, więc wysyłka, która odpadła przy zapisie załączników
   * (zwolniona przed poprzednią), nie przepuszcza następnej przed poprzednią.
   */
  #takeSendTurn(session: Session): { previous: Promise<void>; release: () => void } {
    const previous = this.#sendTail.get(session) ?? Promise.resolve();
    let release = (): void => {};
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.#sendTail.set(session, previous.then(() => mine));
    return { previous, release };
  }

  /**
   * Wysyłka do ŻYWEGO panelu w herdr.
   *
   * Kolejność jest tu całą treścią funkcji: WSZYSTKO, co może odmówić, dzieje się PRZED
   * `#appendMessage` i przed `turn-start`. Odwrotna kolejność dawała transkrypt z wiadomością
   * użytkownika, której nikt nigdy nie wysłał, i sesję w stanie `running`, w której nic nie
   * pracuje — czyli dokładnie to UI, które kłamie.
   *
   * Guard, throttle i uploady wykonuje MANAGER, a nie driver (5.11): tylko stąd wyjątek wraca
   * jako 400/429 na POST-a z telefonu.
   */
  async #sendToHerdr(
    session: Session, text: string,
    images?: readonly string[], files?: readonly FileAttachment[], clientMessageId?: string,
    opts: SendMessageOptions = {},
  ): Promise<void> {
    const deps = this.#requireHerdrDeps();
    const key = session.herdrKey ?? session.id;
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#assertHerdrWritable();

    // 0. ŚWIEŻY tryb panelu. Wpisy `permission-mode` w jsonl powstają dopiero PO turze,
    //    więc `shift+tab` naciśnięty przy biurku między turami nie jest w nich widoczny —
    //    jedynym świeżym źródłem jest stopka ekranu, czytana na żądanie.
    const mode = await this.#freshMode(session);
    const yoloRoots = this.#config.yoloRoots ?? [];
    /*
     * Reguła 11.7: nie znasz trybu → traktuj jak `bypass`. Nieudany odczyt stopki znaczy,
     * że Rarog nie wie, czy po drugiej stronie ktokolwiek zapyta o zgodę — a wysyłka „w ciemno"
     * do panelu, który może być w trybie bez pytań, jest dokładnie tym, czego zakazuje „Starting sessions from the phone: three powers” w `docs/security-model.md`.
     * Gdy rejestr sesji CLI mówi `waiting`, zdanie nazywa przyczynę — stopkę zasłania dialog;
     * bez rejestru zostaje zdanie ogólne.
     */
    if (mode === 'unknown' && !this.#inYolo(session.cwd, yoloRoots)) {
      throw new BadRequestError(this.#cli.modeUnknownMessage(session));
    }

    // 1. Guard tekstu (rozmiar, prefiks `!`, allow-lista slash-komend z katalogu sesji, tryb
    //    bypass). Idzie PIERWSZY z rzeczy, które mogą odrzucić treść, żeby zablokowana komenda nie
    //    zjadała slotu throttle'a. Klasyfikacja jest JEDNA na wysyłkę: jej wynik jedzie do drivera.
    //    Sam załącznik bez tekstu przechodzi: prompt złożą `(załącznik)` i ścieżki z kroku 3.
    const catalog = this.#sessionCatalog(session);
    const withAttachments = (images?.length ?? 0) + (files?.length ?? 0) > 0;
    const { text: clean, slash } = this.#checkSendable(text, key, session.cwd, {
      mode, cwd: session.cwd, yoloRoots, catalog, withAttachments,
      ...(this.#config.realPath !== undefined ? { realPath: this.#config.realPath } : {}),
    });
    // 2. Throttle: 429, nie 400 — to jest „poczekaj", a nie „nigdy". A prompt counts only toward the hourly cap:
    //    the send queue below keeps the order, so a quick second prompt waits instead of bouncing.
    if (!deps.takeSendSlot(key, { spaced: false })) throw new TooManyRequestsError(HERDR_THROTTLED_MESSAGE);
    // Kolejka wysyłek sesji: zapis załączników niżej trwa, a następny prompt może wziąć slot już
    // sekundę później — bez kolejki wyprzedziłby wcześniejszy prompt ze zdjęciem.
    // Zwolnienie w `finally` przed resztą metody jest bezpieczne, bo reszta do
    // `driver.send` włącznie jest synchroniczna: następny ruszy dopiero po niej.
    const turn = this.#takeSendTurn(session);
    let imagePaths: readonly string[];
    let filePaths: readonly string[];
    try {
      // 3. Załączniki na dysk. Błąd zapisu leci do routera jako 400 — NIGDY cicha wysyłka
      //    samego tekstu bez nich, bo prompt „zobacz ten zrzut" bez zrzutu (albo „przejrzyj
      //    ten log" bez logu) jest gorszy niż brak wysyłki.
      //
      //    Zdjęcia idą pierwsze, pliki po nich, wszystko w JEDNYM bloku ścieżek: prompt ma mieć
      //    tę samą kolejność co miniatury i chipy, które użytkownik widział, naciskając „Wyślij".
      imagePaths = images !== undefined && images.length > 0
        ? await deps.writeUploads(session.cwd, images)
        : [];
      filePaths = files !== undefined && files.length > 0
        ? await deps.writeUploadFiles(session.cwd, files)
        : [];
      await turn.previous;
      // A running take-back decides which held messages stay: the flush and the echo below wait for its answer.
      const takingBack = heldEcho.whenTakeBackSettles(session);
      if (takingBack !== null) await takingBack;
    } finally {
      turn.release();
    }
    const finalText = appendAttachmentPaths(clean, [...imagePaths, ...filePaths]);

    // Sesja mogła w międzyczasie zniknąć (panel zamknięty w trakcie zapisu zdjęć).
    if (this.#sessions.get(session.id) !== session || session.driver === null) {
      throw new BadStateError(say('session.no-longer-accepting', { id: session.id }));
    }
    companionScope.assertSendConversation(session, opts.conversation); // From here to `driver.send` no `await`.

    /*
     * Lokalne echo ZOSTAJE (kontrakt z klientem): tylko ono gasi optymistyczny „wpis w locie",
     * a wpis, którego nikt nie zgasi, po chwili pokazuje „Nie potwierdzono. [Ponów]" —
     * czyli zachętę do wysłania drugi raz slash-komendy, która się już wykonała.
     * Duplikat od strony jsonl eliminuje `dropEcho` w followerze (5.9).
     *
     * W transkrypcie zapisujemy tekst PO sanityzacji, ale BEZ bloku ścieżek: ścieżki są
     * hydrauliką promptu, a użytkownik ma zobaczyć swoje zdanie i miniatury zdjęć.
     */
    /*
     * Sesja założona bez promptu startuje z fallbackiem `session N`. Pierwsza wiadomość
     * użytkownika JEST jej pierwszym promptem, więc etykieta przejmuje z niej słowa — inaczej
     * karta zostałaby na „sesja 4" na zawsze. Warunek jest podwójny (fallback + pusty
     * transkrypt), żeby nazwa nie zmieniała się przy każdej kolejnej turze.
     */
    // Nazwa z `/rename` wygrywa także z pierwszym promptem, nawet gdy brzmi jak fallback.
    if (session.messageCount === 0 && isFallbackLabel(session.label) && !this.#customTitled.has(session)) {
      const fromPrompt = labelFromPrompt(clean);
      if (fromPrompt !== null) this.#setLabel(session, fromPrompt);
    }
    /*
     * Echo niesie WIZYTÓWKI załączników, nie ich bajty: `{ kind, name, bytes, mime }`
     * w polu `attachments`, w tej samej kolejności co blok ścieżek promptu (zdjęcia, potem
     * pliki). Zdjęcia i pliki mają wreszcie jeden mechanizm — wcześniej obrazek jechał
     * pełnym `dataUrl` (megabajty w RAM i w każdym `transcript-snapshot`), a plik nie jechał
     * wcale, więc podpis echa musiał udawać, że plików nie było (styk W-files).
     *
     * Listę składa `messageAttachments` z protokołu i to NIE jest wygoda: tę samą listę liczy
     * klient (apka: `EchoMatching.signature`).
     * Rozjazd tej arytmetyki o bajt znaczyłby wiadomość wiszącą na „Nie potwierdzono. [Ponów]".
     */
    const attachments = withUploadFiles(messageAttachments(images, files), imagePaths);
    // Niewzięte wstrzymane wiadomości przed nowym echem, a odczyt ich pola w kolejce drivera przed tą wysyłką.
    heldEcho.flushHeldBeforeSend(session, session.driver, this.#heldEcho);
    /*
     * Echo odroczone: prompt wysłany w trakcie pracy staje w transkrypcie dopiero, gdy CLI
     * go weźmie — wtedy ma `seq` z chwili przetworzenia, a odpowiedź na niego idzie pod nim. Do
     * tego czasu wiadomość czeka tutaj, a klient trzyma swój wpis kolejki na dole transkryptu.
     */
    const echo = heldEcho.defersEcho(
      session, clean, slash, attachments.length > 0, clientMessageId, opts.queueAware === true, this.#heldEcho,
    )
      ? randomUUID() : undefined;
    if (echo !== undefined && clientMessageId !== undefined) {
      session.heldEchoes.push({
        token: echo, blocks: userBlocks(clean, attachments), text: finalText, clientMessageId, heldAtMs: this.#now(),
      });
    } else {
      // Echo niesie identyfikator wysyłki — klient gasi po nim wpis „w locie", a podpis
      // treści (tekst + wizytówki) zostaje zapasem dla wysyłek bez identyfikatora.
      this.#appendMessage(
        session, 'user', userBlocks(clean, attachments), undefined, attachments,
        clientMessageId !== undefined ? { clientMessageId } : {},
      );
    }
    // Prompt z Raroga liczy się TU i drugi raz, gdy CLI zapisze go w pliku rozmowy (follower gasi
    // echo i zgłasza `turn-input`). Prompt wysłany w trakcie tury CLI potrafi wykonać dopiero
    // w następnej; jedno liczenie przypisałoby go wtedy złej turze, w którąkolwiek stronę. Gdy CLI
    // wchłonie go w trwającą turę, w pliku stoi jako załącznik kolejki i follower robi to samo (kolejka
    // zmierzona na 2.1.299).
    this.#noteTurnInput(session);
    // Prompt zablokowany przez hook: pierścień wysyłek, znacznik tury otwartej wysyłką i koniec przycisku
    // poprzedniej blokady — synchronicznie z `turn-start` niżej.
    this.#noteSend(session, finalText, userBlocks(clean, attachments), attachments);
    // Driver dostaje gotowy tekst i ZERO załączników: uploady i guard są już wykonane, a
    // powtórzenie ich w driverze zapisałoby te same pliki drugi raz.
    session.driver.send(finalText, undefined, undefined, {
      ...(echo !== undefined ? { echo } : {}), command: { catalog, slash }, source: opts.source,
    });
    // Tura z Raroga w trakcie ładowania `--resume` ma swój prawdziwy koniec.
    this.#herdrLifecycle.herdrRestoreQuiet.delete(session.id);
    this.#applyTransition(session, { type: 'turn-start' });
    this.#emitSessionChanged(session);
    await session.driver?.queueSaved?.(); // The paste queue is on disk before the 202.
  }

  /**
   * Tryb panelu potwierdzony świeżym odczytem stopki; `'unknown'`, gdy nie da się go ustalić.
   *
   * Odczyt robi supervisor (`ensureFreshMode`) i tylko wtedy, gdy poprzedni jest starszy niż
   * `HERDR_MODE_FRESH_MS` — to nie jest odświeżanie cykliczne, tylko koszt płacony w chwili,
   * w której naprawdę o coś pytamy. Wynik wraca też do karty, żeby chip nie kłamał.
   */
  async #freshMode(session: Session): Promise<HerdrMode> {
    const supervisor = this.#config.herdrSupervisor;
    const key = session.herdrKey;
    if (supervisor === undefined || key === undefined) return session.herdrMode ?? 'unknown';
    const mode = await supervisor.ensureFreshMode(key).catch(() => 'unknown' as HerdrMode);
    if (mode !== session.herdrMode) {
      session.herdrMode = mode;
      this.#emitSessionChanged(session);
    }
    return mode;
  }

  /** Zależności herdr albo twardy błąd — sesja herdr bez nich jest tylko do odczytu. */
  #requireHerdrDeps(): HerdrManagerDeps {
    const deps = this.#config.herdrDeps;
    if (deps === undefined) throw new BadRequestError(HERDR_READ_ONLY_MESSAGE);
    return deps;
  }

  /**
   * Czy kanał ZAPISU do paneli jest otwarty?
   *
   * Dwa niezależne wyłączniki: `RAROG_HERDR_SEND=0` (decyzja człowieka) i `readOnly`
   * z nadzorcy (nieznany protokół herdr). Oba znaczą to samo dla użytkownika: „widzę,
   * nie ruszam" — i oba mają odmówić TUTAJ, a nie dopiero na gnieździe.
   */
  #assertHerdrWritable(): void {
    if (this.#config.herdrSend === false) throw new BadRequestError(HERDR_READ_ONLY_MESSAGE);
    if (this.#config.herdrSupervisor?.status().readOnly === true) {
      throw new BadRequestError(HERDR_READ_ONLY_MESSAGE);
    }
  }

  resolvePermission(
    id: string, permId: string, decision: DeviceDecision, by: string,
    message?: string,
  ): Promise<ResolveResult> {
    return this.#sessionRestart.track(id, () => this.#resolvePermission(id, permId, decision, by, message));
  }

  async #resolvePermission(
    id: string, permId: string, decision: DeviceDecision, by: string,
    message?: string,
  ): Promise<ResolveResult> {
    const session = this.#sessions.get(id);
    if (session === undefined) return { outcome: 'gone' };
    this.#sessionRestart.assertNotRestarting(id);
    /*
     * Karta kanału zgód: decyzja idzie do cyklu (plik odpowiedzi dla hooka), nigdy do drivera. `release`
     * wolno wyłącznie tu; na każdej innej karcie (także adresowanej sesją) to 422 bez klawisza.
     */
    const consentCard = this.#consentCards.consentCardOf(session, permId);
    if (consentCard !== null) return this.#consentCards.resolveConsent(session, consentCard, decision);
    if (decision === 'release') {
      // 422 tylko na istniejącej karcie spoza kanału (karta z ekranu albo dialog adresowany sesją); nieznana = wygasła.
      const known = permId === id || this.#pending.permissionsFor(id).some((p) => p.permId === permId);
      return known ? consentRefusal(422, 'not-channel', 'dialogs.refuse.terminal-only') : { outcome: 'gone' };
    }
    /*
     * Dialog, którego Rarog NIE ZNA z jsonl (zaufanie katalogu, zgoda MCP, wyjście z trybu
     * plan), nie ma `permId` — bo Rarog nigdy go nie zarejestrował. Adresem jest wtedy SAMA
     * SESJA i po tym go rozpoznajemy (`POST /api/sessions/:id/permission`).
     *
     * Rozpoznanie po „braku wpisu w pending" byłoby błędem: druga decyzja o TEJ SAMEJ karcie
     * też nie ma wpisu (pierwsza go zdjęła), więc zamiast 409 „już rozstrzygnięte" poszedłby
     * `escape` do panelu, który właśnie ruszył dalej.
     */
    if (permId === id && !this.#pending.permissionsFor(id).some((p) => p.permId === permId)) {
      return this.#decideHerdrDialog(session, decision);
    }
    // Karta z jsonl, ale bez cyfr z ekranu (rozjazd nazw narzędzia albo nieudane parsowanie
    // po ponowieniu): driver nie ma czym zatwierdzić, więc mówimy to WPROST zamiast oddawać
    // 200 na akcję, która nic nie zrobi (fail-closed).
    if (decision !== 'deny' && this.#undecidable.has(permId)) {
      throw new BadStateError(HERDR_ALLOW_MESSAGE);
    }
    /*
     * Bramki „poza zasięgiem" i „widzę, nie ruszam" — WYŁĄCZNIE dla `allow`: zatwierdzenie
     * kończy się cyfrą do panelu, więc przy zamkniętym kanale ma odmówić TUTAJ, a nie oddać
     * 200 z wpisem w dzienniku o wysyłce, która nie wyszła. `deny` przechodzi zawsze —
     * to także lokalne sprzątnięcie karty (`#undecidable` blokuje tylko `allow` z tego
     * samego powodu); bramka na `deny` robiłaby z killswitcha RAROG_HERDR_SEND=0 generator
     * kart nie do zdjęcia z telefonu do końca awarii.
     */
    if (decision !== 'deny') {
      if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
      this.#assertHerdrWritable();
    }
    const result = await this.#pending.resolvePermission(id, permId, decision, message);
    /*
     * Odmowa drivera NIE zużywa pendingu (kontrakt `DecisionOutcome`): karta zostaje na
     * telefonie, bo dialog stoi dalej w terminalu. Odbudową karty zajmuje się driver —
     * to jedna ścieżka, nie druga równoległa mechanika w managerze.
     */
    if (result.outcome !== 'ok') return result;
    this.#undecidable.delete(permId);

    this.#emitSession(session, {
      type: 'permission-resolved', sessionId: id, permId, decision, by,
    });
    /*
     * Wyjście z `waiting-*` należy się DOPIERO, gdy sesja nie ma już żadnej nierozstrzygniętej
     * decyzji: SDK woła `canUseTool` równolegle dla kilku bloków `tool_use` z jednej wiadomości.
     * Bezwarunkowe przejście raportowałoby `running` sesji, która wciąż czeka na człowieka —
     * czyli wypychałoby ją z pasa uwagi glance'u.
     */
    const moved = !this.#pending.hasPending(id)
      && this.#applyTransition(session, { type: 'permission-resolved' });
    // Bez zmiany stanu ramka i tak MUSI pójść: `waitingFor` liczy się z kolejki,
    // a kolejka właśnie się zmieniła — patrz `#emitSessionChanged` przy `answerQuestion`.
    if (!moved) this.#emitSessionChanged(session);
    return { outcome: 'ok' };
  }

  /** A consent channel card changed in the cycle (`layer1/cycle.ts`, `onCard`); rules in `consent-cards.ts`. */
  applyConsentCard(view: ConsentCardView, decision: ConsentDecision | null): void {
    this.#consentCards.applyConsentCard(view, decision);
  }

  /**
   * Jedna karta na dialog: karta kanału zgód zastępuje karty zgody z ekranu i jsonl tej sesji. Driver nie dostaje
   * odmowy (`escape` zamknąłby dialog, na który odpowiada hook), urządzenia dostają `permission-resolved` z `expired`.
   * Pytania i dialog adresowany sesją zostają.
   */
  #dropScreenPermissions(session: Session): void {
    for (const permId of this.#pending.expirePermissions(session.id)) {
      this.#undecidable.delete(permId);
      this.#emitSession(session, {
        type: 'permission-resolved', sessionId: session.id, permId, decision: 'expired', by: 'system',
      });
    }
  }

  /**
   * Dialog, którego Rarog nie zna z jsonl — decyzja adresowana SAMĄ SESJĄ.
   *
   * Taka karta nie ma wpisu w `PendingInteractions` (stan `waiting-permission` bez pending),
   * bo nie ma z czego jej złożyć: `permId` pochodzi z `tool_use.id` w transkrypcie, a tego
   * dialogu w transkrypcie nie ma. Zwykła ścieżka first-wins oddałaby tu `gone`.
   *
   * `deny` (`escape`) wolno ZAWSZE — anuluje, nigdy nie zatwierdza (wyjątki w driverze: pauza „Session
   * paused” i karta warstwy 2 — odmowa `refused` jak każda inna). `allow` wolno WYŁĄCZNIE
   * dla dialogu rozpoznanego z zamkniętej listy sygnatur: dopiero wtedy Rarog
   * wie, co zatwierdza, a cyfrę składa driver z TEKSTU opcji twierdzącej. Dla wszystkiego
   * innego zostaje 409 z radą „zatwierdź w terminalu" — i to jest granica, za którą Rarog
   * przestałby być narzędziem, a stałby się klikaczem w cudze menu.
   */
  async #decideHerdrDialog(
    session: Session, decision: 'allow' | 'allow-always' | 'deny',
  ): Promise<ResolveResult> {
    /*
     * Dialog z zamkniętej listy sygnatur (trust/model) nie niesie `alwaysLabel`, więc UI nie
     * ma skąd wysłać `allow-always` — a gdyby wysłał (stary bundle, ręczny POST), odmowa jest
     * jedyną uczciwą odpowiedzią: nie ma opcji, którą to zatwierdza.
     */
    if (decision === 'allow-always') throw new BadStateError(HERDR_ALLOW_MESSAGE);
    if (decision === 'allow' && session.herdrDialog === undefined) {
      throw new BadStateError(HERDR_ALLOW_MESSAGE);
    }
    // Panel spoza zasięgu odmawia TUTAJ, a nie dopiero w driverze: `HerdrOutOfScopeError`
    // nie ma odpowiednika w `managerErrorStatus`, więc wracałby do telefonu jako 500
    // („Błąd serwera.") zamiast zdania, które mówi, co się stało.
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#assertHerdrWritable();
    /*
     * Rozpoznanie gaśnie PRZED wysłaniem cyfry, a nie po przemalowaniu ekranu — i musi zgasnąć
     * przed `await`, bo ta karta nie ma wpisu w `#pending`, więc nie chroni jej blokada
     * równoległych prób stamtąd. Drugie tapnięcie w „Zatwierdź" (dwa urządzenia, powtórzony
     * tap) w oknie, w którym driver czyta ekran, wysłałoby DRUGĄ cyfrę do panelu, który
     * zdążył już ruszyć dalej — czyli w środek następnego dialogu.
     *
     * Po `refused` rozpoznanie wraca WYŁĄCZNIE dla `send-failed` — warunki przy samym
     * przywróceniu niżej.
     */
    const dialog = session.herdrDialog;
    if (decision === 'allow') {
      session.herdrDialog = undefined;
      this.#emitSessionChanged(session);
    }
    // `reqId` jest dla drivera herdr nieznaczący (nie ma prośby o zgodę, jest dialog na
    // ekranie), ale kontrakt `SessionDriver` go wymaga — przekazujemy id sesji. Driver
    // rozpoznaje po tym kartę ekranową i szuka cyfry u siebie, nie po `reqId`.
    const outcome = await (session.driver?.respondPermission(session.id, decision)
      ?? Promise.resolve<DecisionOutcome>(STALE));
    if (outcome.kind === 'refused') {
      /*
       * Rozpoznanie WRACA tylko po `send-failed`: to jedyna odmowa, przy której z Raroga nie
       * wyszedł ani jeden bajt, driver karty nie wycofał (`refuseSend` świadomie nie woła ani
       * `#clearActive`, ani `#scheduleEvaluate`) i dialog na pewno stoi dalej na ekranie.
       *
       * Pozostałe powody (`screen-changed`, `no-digit`, `multi-select`, `terminal-only`,
       * `form-submit`) idą przez `#clearActive`, czyli przez zdarzenie `permission-cleared`,
       * po którym handler niżej zeruje `herdrDialog` — i to zerowanie jest PRAWDĄ NOWSZĄ niż
       * migawka sprzed `await`. Bezwarunkowe przywracanie cofało je i zostawiało „Zatwierdź"
       * dla dialogu, którego driver się przed chwilą wyparł. Odbudowę karty robi
       * `#scheduleEvaluate()` w driverze — jedna ścieżka, nie druga mechanika tutaj;
       * kosztem jest przycisk znikający na jeden debounce oceny.
       *
       * Warunek `herdrDialog === undefined` domyka drugą stronę: gdyby w oknie `await`
       * wszedł ŚWIEŻY `screen-dialog`, migawka sprzed decyzji nadpisałaby nowe rozpoznanie.
       */
      if (decision === 'allow' && outcome.reason === 'send-failed'
        && session.herdrDialog === undefined) {
        session.herdrDialog = dialog;
        this.#emitSessionChanged(session);
      }
      return { outcome: 'refused', reason: outcome.reason };
    }
    if (outcome.kind === 'stale') return { outcome: 'gone' };
    return { outcome: 'ok' };
  }

  answerQuestion(
    id: string, qId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<ResolveResult> {
    return this.#sessionRestart.track(id, () => this.#answerQuestion(id, qId, answers, notes));
  }

  async #answerQuestion(
    id: string, qId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<ResolveResult> {
    const session = this.#sessions.get(id);
    if (session === undefined) return { outcome: 'gone' };
    this.#sessionRestart.assertNotRestarting(id);
    /*
     * Panel poza zasięgiem nie przyjmuje odpowiedzi — tak samo jak nie przyjmuje wysyłki,
     * decyzji i przerwania (te bramki stoją od dawna). Tu jej wcześniej nie było i była
     * nieszkodliwa: karty pytań powstają wyłącznie z jsonl albo z ekranu, a jednego i drugiego
     * dla sesji `outOfScope` Rarog nie czyta, więc `qId` i tak nie miałby adresata. Bramka
     * stoi, bo obietnica „wpis Codexa niczego nie odpowiada" ma stać
     * W KODZIE, a nie wynikać z tego, że pustej kolejki nie da się trafić.
     */
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    /*
     * Wielokrotny wybór zostaje w terminalu — ale WYŁĄCZNIE na karcie odpowiadanej
     * CYFRĄ: jedna cyfra wybiera i zatwierdza jedną opcję, a wysłanie kilku po kolei byłoby
     * zgadywaniem, jak dialog zareaguje na drugą.
     *
     * Karta z kanału hooka tego ograniczenia nie ma i mieć nie może:
     * odpowiedź jedzie plikiem jako TEKST (`"Posypka, Polewa"`, zmierzone), do panelu nie
     * idzie ani jeden klawisz, a `multiSelect` pochodzi wprost od autora pytania.
     */
    const request = this.#pending.questionsFor(id).find((entry) => entry.qId === qId);
    if (request?.channel !== 'hook' && answers.some((group) => group.length > 1)) {
      throw new BadStateError(say('session.answer-multi-select'));
    }
    /*
     * Sufit długości obowiązuje w OBU kanałach. Schemat ciała odcina to samo
     * przy 400, ale bramka stoi też tutaj: `answerQuestion` woła nie tylko router, a wolny tekst
     * z pola „Własna odpowiedź" jedzie plikiem prosto do `updatedInput.answers`.
     */
    if (answers.some((group) => group.some((value) => value.length > MAX_ANSWER_TEXT_CHARS))) {
      throw new BadRequestError(
        say('session.answer-too-long', { max: MAX_ANSWER_TEXT_CHARS }),
      );
    }
    /*
     * WOLNY TEKST przechodzi WYŁĄCZNIE kanałem hooka. Na kanale `keys`
     * odpowiedź jedzie cyfrą wybranej opcji, a cyfra nie umie nic napisać w TUI: wartość spoza
     * etykiet ekranu byłaby tam obietnicą bez pokrycia (driver i tak odmówiłby `no-digit`, ale
     * dopiero po wysłaniu żądania). Bramka pyta o KANAŁ, nie o kształt wartości — i milczy, gdy
     * pytania już nie ma, żeby `resolveQuestion` mogło oddać uczciwe 409.
     */
    if (request !== undefined && request.channel !== 'hook') {
      const known = request.questions.map(
        (question) => new Set(question.options.map((option) => option.label)),
      );
      const obce = answers.some(
        (group, index) => group.some((value) => known[index]?.has(value) !== true),
      );
      if (obce) {
        throw new BadRequestError(
          say('session.answer-own-text'),
        );
      }
    }
    /*
     * NOTATKI — reguły w `checkAnswerNotes`: tylko pytanie z `notes: true`, jedna
     * opcja z listy, sufity Raroga. Łamanie ich to 400 tutaj, a nie odmowa drivera:
     * żądanie, które nigdy nie miało prawa wyjść z telefonu, nie dotyka panelu ani pliku.
     */
    const checked = checkAnswerNotes(request, answers, notes);
    if ('error' in checked) throw new BadRequestError(checked.error);
    const result = await this.#pending.resolveQuestion(
      id, qId, answers, checked.notes === null ? undefined : checked.notes,
    );
    // Jak przy zgodzie: `refused` zostawia pytanie na ekranie razem z powodem (422).
    if (result.outcome !== 'ok') return result;

    this.#emitSession(session, { type: 'question-resolved', sessionId: id, qId });
    // Ta sama reguła co przy zgodach: dopóki wisi kolejna decyzja, sesja nadal czeka na człowieka.
    const moved = !this.#pending.hasPending(id)
      && this.#applyTransition(session, { type: 'question-resolved' });
    /*
     * Ramka LISTY leci także wtedy, gdy stan się nie zmienił. `waitingFor` liczy
     * się z kolejki `#pending`, a ta właśnie się zmieniła — bez rozgłoszenia karta w sidebarze
     * zostaje z treścią decyzji, której już nie ma. Dwie drogi tu wchodzą i obie są zwykłe:
     * druga karta w kolejce (przejścia w ogóle nie próbujemy, bo sesja NADAL czeka) oraz sesja
     * herdr stojąca w `waiting-permission` od `agent-blocked` — dla niej `question-resolved`
     * prowadzi wyłącznie z `waiting-question`, czyli jest TOŻSAMOŚCIĄ, a `#applyTransition`
     * wychodzi wtedy przed rozgłoszeniem. Ten sam powód i ta sama poprawka co przy
     * `permission-request`/`question-request`.
     */
    if (!moved) this.#emitSessionChanged(session);
    return { outcome: 'ok' };
  }

  /**
   * Esc to the session. Returns the driver's promise ("the key went"), NOT the moment the request was accepted.
   *
   * The order in this method is binding: `interruptedAtMs` and the `interrupt-requested` transition run SYNCHRONOUSLY,
   * because the POST answer with a fresh `SessionSummary` stands on them, the only truth when `EventSource` died
   * silently. Not `async` for the same reason as in the driver: the refusals below throw on the call. Idempotency
   * stands HERE, not in the client: requests also come from a second device and from network retries. The two windows
   * are disjoint: "in flight" (before delivery) and debounce (after), each on its own field.
   */
  interrupt(id: string): Promise<boolean> {
    return this.#sessionRestart.track(id, () => this.#interrupt(id));
  }

  /** {@link ManagerApi.returnedPrompt}: the driver's field read after the last delivered `escape`. */
  returnedPrompt(id: string): Promise<string | null> {
    return this.#sessions.get(id)?.driver?.returnedPrompt?.() ?? Promise.resolve(null);
  }

  #interrupt(id: string): Promise<boolean> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    // `interrupt` to `escape` do ŻYWEGO panelu — czyli mutacja, więc podlega temu samemu
    // wyłącznikowi co wysyłka i temu samemu ograniczeniu zasięgu.
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#assertHerdrWritable();
    // Mechanisms A and B: a repeat inside the in-flight or debounce window sends no second `escape`.
    const answered = this.#interrupts.answerFromWindows(id);
    if (answered !== undefined) return answered;
    /*
     * Bramka „nie ma czym przerwać" stoi ZA mechanizmami A i B, a przed przejściem stanu.
     * Za nimi, bo obie odpowiadają na pytanie o klawisz, który JUŻ poszedł — driver odpięty
     * po fakcie nie unieważnia tamtej prawdy. Przed przejściem, bo sesja, której nie ma czym
     * zatrzymać, nie ma też prawa zameldować „przerwana": to kłamałoby na karcie listy.
     */
    const driver = session.driver;
    if (driver === null) throw new BadStateError(HERDR_NO_DRIVER_INTERRUPT_MESSAGE);
    this.#expirePending(session, true);
    // Karty kanału zgód: przerwanie z telefonu to zwolnienie do terminala, nigdy cyfra.
    this.#consentCards.releaseConsentCards(session);
    const delivered = driver.interrupt();
    // Echo odroczone: Esc NIE spłukuje. CLI przerywa turę i od razu bierze prompt z kolejki jako
    // nową turę (zmierzone na CLI 2.1.299) — wpis z tokenem przyjdzie z pliku,
    // a zapasem jest spłukanie 10 s po wyjściu z tury.
    // Start karencji dla spóźnionego pusha `working` — patrz `INTERRUPT_WORKING_GRACE_MS`.
    session.interruptedAtMs = this.#now();
    // Esc gasi też koniec tury czekający na spóźnione wywołanie narzędzia (`#noteToolCalls`): wywołanie,
    // które dojdzie po nim, nie ma prawa uzbroić „gotowe" sprzed Esc.
    session.quietTurnEnd = undefined;
    // Przejście ląduje w `waiting-input`, nie w `interrupted`: Esc znaczy „przerwij i pisz
    // dalej" (jak w terminalowym Claude Code), więc następnym ruchem JEST wiadomość. Detail
    // zostaje na karcie listy do pierwszego kolejnego przejścia.
    if (!this.#applyTransition(session, { type: 'interrupt-requested' }, INTERRUPT_DETAIL)) {
      /*
       * Przejście-tożsamość (sesja już w `waiting-input`, a telefon pokazywał jeszcze turę) nie
       * woła `#note`, a harmonogram ma się o przerwaniu dowiedzieć i tak: Esc z Raroga gasi
       * zaległe „gotowe". Bez tego cisza w tle
       * po wyjściu z Raroga dosłałaby „gotowe" o wyniku sprzed Esc. Ten sam wzorzec co przy
       * `permission-requested`: zdarzenie ciche, więc zdejmuje też to, co czekało.
       */
      this.#note(session, { type: 'interrupt-requested' });
    }
    return this.#interrupts.trackInterrupt(id, delivered);
  }

  /**
   * „Zamknij" ma DWA znaczenia i to jest jedyne miejsce, w którym się rozchodzą.
   *
   * Bez `closePanel` — UKRYCIE karty w Rarogu; panel w terminalu żyje dalej. Z `closePanel`
   * — `tab.close` KAŻDEGO panelu, także nie założonego przez Raroga („× ma zamykać, bez
   * znaczenia czyja sesja"). Odmowa zostaje tylko
   * dla sesji bez panelu (409, np. demo) — nie ma czego adresować.
   */
  async close(id: string, opts: { closePanel?: boolean } = {}): Promise<void> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    if (opts.closePanel === true) {
      // Panel Codexa zamyka się w herdr, nie z karty. Bramka stoi PRZED wszystkim innym:
      // to jedyna władza, jaką wpis Codexa mógłby dać, a obiecaliśmy sam stan.
      if (session.engine === 'codex') throw new BadStateError(HERDR_CODEX_CLOSE_MESSAGE);
      const key = session.herdrKey;
      if (key === undefined) {
        throw new BadStateError(HERDR_NOT_OWNED_MESSAGE);
      }
      /*
       * KARTA HISTORYCZNA NIE STERUJE NASTĘPCĄ.
       *
       * `herdrKey` zostaje na karcie po `gone`, a następca w tym samym panelu dostaje TEN SAM
       * klucz (`freshKey(paneId)` w nadzorcy). Stara karta Claude — po tym, jak w jej panelu
       * odpalono Codexa — przechodziła więc bramkę na `engine` (sama codeksem nie jest)
       * i zamykała tab, w którym siedział cudzy, żywy agent. Właścicielem klucza jest ZAWSZE
       * ta karta, którą wskazuje `#herdrByKey`; każda inna opisuje panel, którego już nie ma.
       *
       * Zamiar użytkownika („ta karta ma zniknąć") spełnia samo jej zapomnienie — dokładnie
       * to, co robi niżej gałąź `HerdrGoneError`, żeby szara karta nie była nieusuwalna.
       * Nie ma tu ani jednego RPC, więc ścieżka nie pyta o gniazdo
       * ani o `RAROG_HERDR_SEND`: martwa karta musi dać się zdjąć także przy padniętym herdr.
       */
      if (this.#herdrByKey.get(key) !== session.id) {
        this.#expirePending(session, false);
        // Zamknięcie z telefonu zwalnia karty kanału zgód do terminala (podpisany `release`), także karty historycznej.
        this.#consentCards.releaseConsentCards(session);
        this.#detachDriver(session);
        this.#applyTransition(session, { type: 'closed' });
        this.#forgetHerdrSession(session);
        this.#emitSessionsSnapshot();
        return;
      }
      const supervisor = this.#requireSupervisor();
      /*
       * Pre-check dostępności gniazda stoi PRZED pierwszą mutacją i to jest jego druga
       * robota (pierwsza: 409 ze zdaniem zamiast 500 „Błąd serwera.").
       * Bez niego `tab.close` w martwe gniazdo rzuciłoby `HerdrUnavailableError` już PO
       * `#expirePending` i `#detachDriver`: pending decyzje przepadłyby z eventem `expired`,
       * a karta zostałaby bez drivera do najbliższego obrotu resyncu. Odmowa przed
       * czymkolwiek zostawia kartę nietkniętą — „×" po powrocie herdr zadziała.
       */
      if (!supervisor.status().available) {
        throw new BadStateError(HERDR_TERMINAL_UNAVAILABLE_MESSAGE);
      }
      this.#assertHerdrWritable();
      this.#expirePending(session, false);
      /*
       * Zamknięcie z telefonu: karty kanału zgód zwolnione (`release`) przed zamknięciem tabu, hook wychodzi bez wyniku;
       * odpowiedzi już odebrane rozlicza koniec tury, bo proces kończy się razem z tabem. Karty do zdjęcia liczą się
       * PRZED odpięciem drivera, póki ta karta obsługuje rozmowę: po odpięciu rozmowę obsługiwałby drugi żywy panel
       * i dostałby je razem z ich zmianami z cyklu. Dokładnie te karty schodzą z urządzeń i dostają pole zdjęcia na
       * dysku PRZED zamknięciem tabu (`retireConsentCards`, zapis doczekany): restart serwera w trakcie RPC ich nie
       * przywraca. Błąd zamknięcia tabu też nie: zamiar użytkownika rozstrzyga, karty `pending` i `sent` są już
       * zwolnione, a odebrane bez przycisków nie wracają na panel, który przeżył. Karta zgłoszona później idzie
       * zwykłą drogą.
       */
      this.#consentCards.releaseConsentCards(session);
      this.#consentCards.consentTurnEnded(session);
      const retiring = this.#consentCards.holdConsentCards(session);
      this.#detachDriver(session);
      await this.#consentCards.retireConsentCards(session, retiring);
      try {
        await supervisor.closeTab(key);
      } catch (err) {
        /*
         * Panel już nie istnieje w herdr (zamknięty ręcznie w terminalu, `claude` wyszedł) —
         * `launchedByRarog` zostaje jednak na karcie, więc UI dalej wysyła `closePanel: true`,
         * a `closeTab` odpowiada `HerdrGoneError`. Bez tej gałęzi szara karta byłaby NIEUSUWALNA:
         * każde „×" kończyłoby się 410 aż do restartu serwera. Zamiar
         * użytkownika — „ta karta ma zniknąć" — spełnia samo zapomnienie karty; wpis „ukryta"
         * byłby widmem na liście „Ukryte", bo panelu, który miałby wrócić, już nie ma. Gdyby
         * `gone` okazało się fałszywe (wyścig z resynciem), panel wróci jako `appeared` —
         * uczciwiej pokazać go znów niż zgubić na zawsze. Duck-typing po `code`, bo manager
         * importuje z `herdr/*` wyłącznie typy (patrz nagłówek importów).
         */
        if ((err as { code?: unknown } | null)?.code !== 'herdr-gone') throw err;
      }
      this.#applyTransition(session, { type: 'closed' });
      this.#forgetHerdrSession(session);
      this.#emitSessionsSnapshot();
      return;
    }
    // Ukrycie: panel i hook żyją dalej, karty kanału zgód zostają w cyklu i wracają z kartą sesji.
    this.#expirePending(session, session.driver !== null);
    this.#detachDriver(session);
    this.#hideHerdrSession(session);
    /*
     * Świeża lista DO WSZYSTKICH telefonów. `#forgetHerdrSession` zdejmuje sesję z RAM, ale
     * klient wciąż trzyma ją w swojej mapie — protokół nie zna zdarzenia „sesja usunięta",
     * a `session-changed` na `done` zostawiłby kartę i pigułkę siostry na ekranie aż do najbliższego pełnego
     * snapshotu (reconnect SSE). Ramka snapshotu jest tania i mówi całą prawdę naraz.
     */
    this.#emitSessionsSnapshot();
  }

  /** Pełna lista sesji do strumienia globalnego — jedyny sposób „odjęcia" karty na żywo. */
  #emitSessionsSnapshot(): void {
    const snapshot: Extract<ServerEvent, { type: 'sessions-snapshot' }> = {
      type: 'sessions-snapshot', sessions: this.list(),
    };
    const herdrStatus = this.herdrStatus();
    if (herdrStatus !== undefined) snapshot.herdrStatus = herdrStatus;
    this.#notify('global', null, snapshot);
  }

  /**
   * „Zamknięcie" sesji herdr BEZ `closePanel` = zdjęcie karty. Panel w terminalu ŻYJE dalej.
   *
   * `#detachDriver` już się wykonał i — bo `ownsProcess === false` — nie wysłał do panelu
   * ani jednego bajtu. Listy ukrytych nie ma, więc żywy panel WRÓCI przy najbliższym
   * resyncu jako `appeared`; UI tej ścieżki używa tylko dla sesji `resumable`
   * (bez żywego panelu), gdzie nie ma czemu wracać.
   */
  #hideHerdrSession(session: Session): void {
    const key = session.herdrKey;
    // Tylko WŁASNY wpis indeksu: po zmianie silnika w panelu klucz
    // trzyma już karta następcy, a ślepe `delete` zdejmowałoby ją z indeksu — z nadzorcy
    // przyszedłby wtedy drugi `appeared` na ten sam panel i lista miałaby dwie karty.
    if (key !== undefined && this.#herdrByKey.get(key) === session.id) {
      this.#herdrByKey.delete(key);
    }
    // `closed` → `done` jest tu jedynym sposobem powiedzenia klientowi „tej karty już nie ma":
    // protokół nie zna zdarzenia „sesja usunięta", a milczenie zostawiłoby kartę do restartu.
    this.#applyTransition(session, { type: 'closed' }, HERDR_HIDDEN_DETAIL);
    this.#forgetHerdrSession(session);
  }

  /**
   * Zapamiętuje, w których indeksach stoi ta karta, i oddaje funkcję COFAJĄCĄ `#forget…`.
   *
   * Odtwarzamy dokładnie to, co było — a nie „co powinno być": `#indexEngineSession` pomija
   * sesje `done`, więc bezwarunkowe wołanie go po rollbacku dokładałoby wpis, którego przed
   * kasowaniem nie było. Jedyne, czego nie wskrzeszamy, to czekający z `AttachSlots`: to obietnice
   * czekających na podpięcie drivera, a po nieudanym wznowieniu nie ma do czego ich podpiąć.
   * Nowa karta pod tym samym id (gdyby `create()` zdążył ją wstawić) ma pierwszeństwo.
   */
  #snapshotIndexes(session: Session): () => void {
    const key = session.herdrKey;
    const engineSessionId = session.engineSessionId;
    const hadKey = key !== undefined && this.#herdrByKey.get(key) === session.id;
    const hadEngine = engineSessionId !== undefined
      && this.#byEngineSession.get(engineSessionId) === session.id;
    return () => {
      if (this.#sessions.has(session.id)) return;
      this.#sessions.set(session.id, session);
      this.#prStatus.sync(session);
      this.#git.watch(session);
      if (hadKey && key !== undefined) this.#herdrByKey.set(key, session.id);
      if (hadEngine && engineSessionId !== undefined) this.#byEngineSession.set(engineSessionId, session.id);
    };
  }

  /** Usuwa sesję herdr z RAM i ze wszystkich indeksów (ukrycie albo zniknięcie panelu). */
  #forgetHerdrSession(session: Session): void {
    // Karta zamknięta albo ukryta w czasie dialogu startowego: zdanie do transkryptu, zanim karta zniknie z RAM.
    this.#dropStartWait(session);
    this.#unindexEngineSession(session);
    const key = session.herdrKey;
    if (key !== undefined && this.#herdrByKey.get(key) === session.id) {
      this.#herdrByKey.delete(key);
    }
    this.#attach.dropAttachWaiter(session.id);
    // Okna przerwania są RAM-owe i per karta — karta znika, więc znikają razem z nią.
    // Bez tego rollback `#snapshotIndexes` wskrzeszałby sesję ze stęchłym oknem debounce'u.
    this.#interrupts.resetInterruptWindows(session.id);
    this.#herdrLifecycle.herdrRestoreQuiet.delete(session.id);
    this.#herdrBlocked.delete(session.id);
    this.#timing.forget(session.id);
    this.#claimWindows.forget(session.id);
    this.#sessions.delete(session.id);
    this.#prStatus.forget(session.id);
    this.#git.unwatch(session);
    /*
     * Bez tego czekające powiadomienie obudziłoby się po minucie i zapytało o sesję, której
     * nie ma. Samo w sobie nieszkodliwe (harmonogram odpytuje `look` i milknie), ale timer
     * wiszący na ukrytej karcie to wyciek — a paneli znikających i wracających jest w herdr
     * kilkanaście dziennie.
     */
    this.#config.notifier?.forget(session.id);
  }

  /**
   * Ponowne otwarcie panelu, który zniknął z herdr — TA SAMA karta, nowy panel.
   *
   * Sesja z ŻYWYM panelem nie ma czego wznawiać: proces należy do terminala użytkownika
   * i działa niezależnie od Raroga (409). Sesja, której panel zamknięto, ma zapamiętany
   * `engineSessionId`, więc wznowienie to zwykłe `create()` z `resumeFrom` — tyle że
   * z WYMUSZONYM `sessionId`, żeby deep-link z telefonu i `Last-Event-ID` dalej działały.
   */
  async resume(id: string): Promise<SessionSummary> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    if (session.driver !== null) throw new BadStateError(HERDR_RESUME_MESSAGE);
    const engineSessionId = session.engineSessionId;
    if (engineSessionId === undefined) {
      throw new BadStateError(say('rest.bad-state'));
    }
    /*
     * Model i tryb wracają z ROZMOWY, nie ze startu karty: model przywraca samo CLI (alias rodziny zwinąłby
     * starszy model do bieżącego), a tryb `#launch` czyta z pliku — tryb startu karty przegrywałby z tym, co
     * człowiek przełączył w panelu potem. Tryb karty zostaje ZAPASEM na plik bez trybu (np. tryb
     * odczytany z ekranu przy nieudanym restarcie). Wyjątek to bypass: karta dostała go od bramki yolo przy
     * starcie, a z pliku Rarog go nie przenosi nigdy. Effort karty idzie za driverem, więc jest aktualny.
     */
    const opts: LaunchOptions = {
      cwd: session.cwd,
      resumeFrom: engineSessionId,
      sessionId: session.id,
      ...(session.effort !== undefined ? { effort: session.effort } : {}),
      ...resumeUltracodeOf(session),
      ...(session.permissionMode === 'bypassPermissions'
        ? { permissionMode: session.permissionMode }
        : session.permissionMode !== undefined ? { permissionModeFallback: session.permissionMode } : {}),
    };
    await this.#recreate(session, opts, false);
    const created = this.#sessions.get(id);
    if (created === undefined) throw new BadStateError(say('rest.bad-state'));
    return this.#summaryOf(created);
  }

  /**
   * Nowy panel dla karty `session` pod TYM SAMYM id — wspólna część `resume()` i restartu.
   *
   * Stara karta znika z map ZANIM powstanie nowa — inaczej `#sessions.set` na tym samym id
   * zostawiłby w indeksach wpisy wskazujące na obiekt, którego nikt już nie czyta.
   */
  async #recreate(session: Session, opts: LaunchOptions, slotTaken: boolean): Promise<void> {
    const restore = this.#snapshotIndexes(session);
    this.#forgetHerdrSession(session);
    try {
      // The new card numbers on after the old one; `#launch` sends the open streams of this id a snapshot.
      await this.#launch({ ...opts, continuesRing: session.ring }, slotTaken);
    } catch (error: unknown) {
      /*
       * Wznowienie odbite (400 z `#assertResumable` w `launch-gate.ts`, 429 z throttle'a, padnięty `launch`) —
       * bez tego karta ZNIKAŁA z listy na zawsze, choć nic się nie zmieniło: `resume()`
       * skasował ją z map, a `create()` nie zdążył postawić nowej. Użytkownik widział
       * komunikat błędu i pustą listę, a jedynym odzyskaniem był restart serwera.
       */
      restore();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Restart sesji na nowszym Claude Code
  // -------------------------------------------------------------------------

  async restart(id: string, opts: RestartOptions = {}): Promise<{ sessionId: string }> {
    const session = this.#require(id);
    // A. Bramki synchroniczne i rezerwacja — PRZED pierwszym `await`, żeby dwa tapnięcia
    //    (albo restart i wysyłka) nie przeszły obok siebie przez odczyty z pkt B.
    if (session.engine === 'codex') throw new BadStateError(RESTART_CODEX_MESSAGE);
    this.#sessionRestart.assertNotRestarting(id);
    /*
     * „Uruchom ponownie i wyślij”: `seq` i `id` z ciała mają wskazywać blokadę, której przycisk
     * działa — inaczej 409 PRZED rezerwacją i slotem. The `seq` alone is not enough: numbering starts from 1 again
     * in a new server process, so a late tap from before a server restart could name a new notice under the same
     * number. The block `id` decides.
     * Ładunek (tekst dla CLI, dymek, wizytówki) bierzemy z serwera, nigdy z ciała: klient podaje wyłącznie,
     * KTÓRĄ blokadę tapnięto.
     */
    const blocked = opts.resend === undefined ? undefined : session.promptBlocked;
    if (opts.resend !== undefined && (blocked?.seq !== opts.resend.seq || blocked.id !== opts.resend.id)) {
      throw new BadStateError(RESTART_RESEND_STALE_MESSAGE);
    }
    const driver = session.driver;
    const key = session.herdrKey;
    if (driver === null || key === undefined || this.#herdrByKey.get(key) !== id) {
      throw new BadStateError(RESTART_NO_PANEL_MESSAGE);
    }
    if (driver.restartProbe === undefined || driver.requestExit === undefined) {
      throw new BadStateError(RESTART_UNSUPPORTED_MESSAGE);
    }
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    // Zasięg obserwacji (`RAROG_HERDR_ROOTS`) bywa szerszy niż allow-lista zakładania —
    // `#launch` odmówiłby katalogu dopiero po `/exit`.
    this.#assertAllowedCwd(session.cwd);
    const supervisor = this.#requireSupervisor();
    if (!supervisor.status().available) throw new BadStateError(HERDR_TERMINAL_UNAVAILABLE_MESSAGE);
    this.#assertHerdrWritable();
    if ((this.#sessionRestart.inFlight.get(id) ?? 0) > 0) throw new BadStateError(RESTART_BUSY_MESSAGE);
    const agent = supervisor.agentFor?.(key);
    this.#sessionRestart.assertCanRelaunch(supervisor, agent?.launchedByRarog === true);
    const update = this.#cli.cliUpdateOf(session);
    const engineSessionId = session.engineSessionId;
    // Restart bez aktualizacji wolno wyłącznie z ponowną wysyłką zablokowanego promptu.
    const send = blocked?.send;
    if ((update === undefined && send === undefined) || engineSessionId === undefined) {
      throw new BadStateError(RESTART_NO_UPDATE_MESSAGE);
    }
    if (
      !MODEL_CHANGE_STATES.includes(session.state) || session.herdrDialog !== undefined
      || this.#pending.permissionsFor(id).length > 0 || this.#pending.questionsFor(id).length > 0
    ) {
      throw new BadStateError(RESTART_BUSY_MESSAGE);
    }
    if (tasksBlockRestart(session.backgroundTasks)) {
      throw new BadStateError(
        onlyWaitingAgents(session.backgroundTasks) ? RESTART_WAITING_AGENT_MESSAGE : RESTART_TASKS_MESSAGE,
      );
    }
    /*
     * Suchy strażnik ładunku — ten sam, którym `#launch` sprawdzi prompt startowy nowego procesu:
     * tryb `unknown`, katalog komend dla wydania ZAINSTALOWANEGO. Odmowa (400) przychodzi teraz, przed
     * rezerwacją i przed `/exit`, a nie po zabiciu procesu.
     */
    if (send !== undefined) {
      this.#checkSendable(send.raw, key, session.cwd, {
        mode: 'unknown', cwd: session.cwd, yoloRoots: this.#config.yoloRoots ?? [],
        catalog: this.#commandCatalog(session.cwd, this.#cli.cliVersion.installed),
        ...(this.#config.realPath !== undefined ? { realPath: this.#config.realPath } : {}),
      });
    }
    const slotAt = this.#launchGate.takeLaunchSlotAt();
    if (slotAt === null) throw new TooManyRequestsError(launchThrottledMessage(this.#system));
    // B and C (reservation, reading checks, `/exit`, the new process) live in `session-restart.ts`.
    return this.#sessionRestart.restart(session, {
      driver, supervisor, key, agent, update, engineSessionId, send, slotAt,
    });
  }

  // -------------------------------------------------------------------------
  // Model i effort
  // -------------------------------------------------------------------------

  /**
   * Lista modeli do wyboru — WBUDOWANA i jedyna.
   *
   * Panel `claude` w herdr nie wystawia listy modeli konta żadnym kanałem, więc udawanie,
   * że Rarog ją zna, byłoby zmyślaniem. TODO: dochodzi pozycja „model domyślny konta"
   * (pusty `value` = zero flagi `--model`) jako pierwsza i domyślna.
   *
   * Pole `ultracode` pozycji listy mówi, przy których modelach apka pokazuje przełącznik: serwer wykonuje
   * go flagą startu ({@link create}) i komendą w żywej sesji ({@link setModel}). W demo lista jest ta sama.
   */
  models(): ModelList {
    return { models: [DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES] };
  }

  /**
   * Lista slash-komend sesji dla podpowiedzi apki (`GET /api/sessions/:id/commands`):
   * TA SAMA migawka katalogu, którą {@link #sendToHerdr} sprawdza wysyłkę ({@link #sessionCatalog}), więc
   * pozycja z listy przechodzi strażnika, a `revision` w obu miejscach jest ta sama.
   * Zasięg: `inCommandScope` w `companion-scope.ts` (nieznana sesja 404, poza zasięgiem 400 ze zdaniem wysyłki).
   */
  commands(id: string): CommandList {
    const session = this.#require(id);
    if (!companionScope.inCommandScope(session, this.#config)) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    return commandListOf(this.#sessionCatalog(session));
  }

  companionTarget(id: string): ReturnType<typeof companionScope.companionEntryOf> {
    return companionScope.companionEntryOf(this.#require(id), this.#config);
  }

  onConversationChange(cb: companionScope.ConversationListener): () => void {
    return this.#conversations.add(cb);
  }

  /**
   * Zmiana modelu / effortu ŻYWEJ sesji — JEDYNA droga do `/model` w całym Rarogu.
   *
   * Wolny tekst `/model` zostaje zablokowany na deny-liście („Model, effort and permission mode” w `docs/implementation-spec.md`) i to nie jest
   * niekonsekwencja, tylko cała konstrukcja tej funkcji: komendę składa serwer z wartości ze
   * SWOJEJ allow-listy, przepuszcza ją przez guard jawną ścieżką wewnętrzną i oddaje wraz
   * z ostrzeżeniem o skutku globalnym. Zdanie wpisane w composer nie ma żadnej z tych trzech
   * rzeczy — dlatego arkusz z ostrzeżeniem da się ominąć tylko wtedy, gdy `/model` przechodzi
   * jako tekst.
   *
   * Kolejność sprawdzeń jest kolejnością RYZYKA i kończy się dokładnie tam, gdzie zaczyna się
   * panel: wszystko, co może odmówić (stan, zasięg, killswitch, wersja CLI dla ultracode, tryb,
   * kształt komendy, throttle), dzieje się PRZED pierwszym bajtem do gniazda.
   *
   * `ultracode` dokłada na końcu paczki `/effort ultracode` albo `/effort ultracode off` (formy rejestru).
   * Paczka z samym ultracode dostaje `ULTRACODE_CHANGE_NOTE` zamiast ostrzeżenia o ustawieniach konta.
   *
   * @returns ostrzeżenie do pokazania człowiekowi; router oddaje je jako 202
   */
  setModel(
    id: string, patch: { model?: string; effort?: EffortLevel | null; ultracode?: boolean },
  ): Promise<SessionModelResponse> {
    return this.#sessionRestart.track(id, () => this.#setModel(id, patch));
  }

  async #setModel(
    id: string, patch: { model?: string; effort?: EffortLevel | null; ultracode?: boolean },
  ): Promise<SessionModelResponse> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    const deps = this.#requireHerdrDeps();
    const driver = session.driver;
    // Brak drivera = panel zniknął albo sesja jest ukryta: nie ma dokąd wysłać komendy.
    // `sendCommands` może nie istnieć (driver demo) — wtedy też odmawiamy JAWNIE.
    if (driver === null || driver.sendCommands === undefined) {
      throw new BadRequestError(HERDR_MODEL_MESSAGE);
    }
    this.#assertKnownModel(patch.model);
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#assertHerdrWritable();
    if (patch.ultracode !== undefined) this.#assertUltracodeChange(session);
    /*
     * Tura i stojący dialog blokują TAK SAMO, choć z różnych powodów: w środku tury komenda
     * wpadłaby w kolejkę promptów, a przy otwartym dialogu tekst poszedłby do dialogu (albo
     * herdr odrzuciłby go jako `agent_blocked`). Jedno i drugie kończy się „nic się nie stało",
     * a użytkownik ma prawo wiedzieć dlaczego.
     */
    if (!MODEL_CHANGE_STATES.includes(session.state)) {
      throw new BadStateError(MODEL_BUSY_MESSAGE);
    }

    const yoloRoots = this.#config.yoloRoots ?? [];
    const mode = await this.#freshMode(session);
    if (mode === 'unknown' && !this.#inYolo(session.cwd, yoloRoots)) {
      throw new BadRequestError(this.#cli.modeUnknownMessage(session));
    }
    /*
     * Driver bierzemy PONOWNIE po odczycie stopki i to nie jest nadgorliwość: w tym oknie
     * panel mógł zniknąć albo zostać podpięty na nowo (`re-attached` po powrocie gniazda),
     * a komenda wysłana przez stary uchwyt trafiłaby w driver, którego nikt już nie czyta.
     */
    const live = this.#sessions.get(id) === session ? session.driver : null;
    if (live === null || live.sendCommands === undefined) {
      throw new BadStateError(HERDR_MODEL_MESSAGE);
    }

    /*
     * Komendy budujemy TUTAJ, z wartości, które przeszły allow-listę — driver dostaje gotowy
     * tekst i nie ma go jak zinterpretować inaczej. Guard z flagą `internalCommand` sprawdza
     * jeszcze KSZTAŁT: cokolwiek innego niż „slash, nazwa, jedna wartość" odpada, więc ta
     * ścieżka nie da się użyć do przemycenia zdania z telefonu.
     */
    // Ścieżka wewnętrzna nie czyta katalogu komend: `/model` i `/effort` przechodzą tylko w kształcie
    // `INTERNAL_COMMAND_PATTERN` albo w formach ultracode z rejestru i tylko z flagą, a wolny tekst idzie przez
    // `#sendToHerdr`.
    const commands = modelCommands(patch).map((command) => deps.assertSendable(command, {
      mode, cwd: session.cwd, yoloRoots, internalCommand: true,
    }).text);
    if (commands.length === 0) throw new BadRequestError(say('model.change-empty'));
    // Throttle ten sam co dla wysyłki: `/model` jest wysyłką do cudzego panelu jak każda inna.
    if (!deps.takeSendSlot(session.herdrKey ?? id)) {
      throw new TooManyRequestsError(HERDR_THROTTLED_MESSAGE);
    }
    /*
     * Od tej chwili wszystko jedzie w tle (202): dialog potwierdzenia trzeba przeczytać
     * z ekranu, a to sekundy — czyli dokładnie tyle, ile gubi zgaszony ekran iOS. Wynik
     * wraca kanałem, który użytkownik i tak ma otwarty: wiadomością systemową w transkrypcie.
     */
    live.sendCommands(commands);
    // Ostrzeżenie mówi o tym, co poszło: `/model` i `/effort <poziom>` zapisują ustawienia konta, a sama komenda
    // ultracode działa w tej sesji i kosztuje więcej tokenów.
    const ultracodeOnly = patch.ultracode !== undefined && commands.length === 1;
    const warning = ultracodeOnly ? ULTRACODE_CHANGE_NOTE : MODEL_CHANGE_WARNING;
    return { ok: true, warning: warning.text, warningRef: warning.ref };
  }

  /**
   * Bramka wersji zmiany ultracode w ŻYWEJ sesji: liczy się wersja PROCESU, nie zainstalowana.
   * Źródło jak przy notatkach ({@link CliRegistryState.cliAcceptsNotes}): rejestr szybkiego tiku, zapasem migawka
   * wersji Claude Code, a gdy żaden nie zna procesu — wersja zainstalowana z chwili, w której Rarog sam
   * uruchomił panel (`cliVersionAtLaunch`), żeby świeży panel bez wpisu w rejestrze nie dostał odmowy. Demo
   * bramki nie ma (czytnika wersji tam nie ma).
   *
   * @throws {BadRequestError} wersja nieznana albo niższa niż {@link ULTRACODE_MIN_CLI}
   */
  #assertUltracodeChange(session: Session): void {
    if (this.#config.demo) return;
    const registry = this.#cli.cliRegistry ?? this.#cli.cliVersion.registry;
    const running = runningCliVersion(registry, session.engineSessionId) ?? session.cliVersionAtLaunch;
    if (running === undefined) throw new BadRequestError(ULTRACODE_CLI_UNKNOWN_MESSAGE);
    if (compareCliVersions(running, ULTRACODE_MIN_CLI) < 0) {
      throw new BadRequestError(ultracodeCliTooOldMessage(running));
    }
  }

  /**
   * Zmiana trybu uprawnień ŻYWEJ sesji `plan` ↔ `auto` — JEDYNA droga do `shift+tab`.
   *
   * Te same bramki co przy `/model` i w tej samej kolejności ryzyka (kanał, zasięg, killswitch,
   * stan, tryb startowy, throttle) — wszystko PRZED pierwszym bajtem do gniazda. Dwie różnice:
   * tryb startowy musi być ZNANY (pętla porównuje odczyty, a nie liczy naciśnięcia) i nie może
   * być `bypass` (Rarog nie odkręca decyzji z biurka). Panel, który już stoi w celu, dostaje
   * 202 jak każdy inny — driver zamelduje „0× shift+tab" w transkrypcie.
   */
  setMode(id: string, patch: { mode: ModeCycleTarget }): Promise<SessionModeResponse> {
    return this.#sessionRestart.track(id, () => this.#setMode(id, patch));
  }

  async #setMode(id: string, patch: { mode: ModeCycleTarget }): Promise<SessionModeResponse> {
    const session = this.#require(id);
    this.#sessionRestart.assertNotRestarting(id);
    const deps = this.#requireHerdrDeps();
    const driver = session.driver;
    if (driver === null || driver.setMode === undefined) {
      throw new BadRequestError(HERDR_MODE_MESSAGE);
    }
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#assertHerdrWritable();
    if (!MODEL_CHANGE_STATES.includes(session.state)) {
      throw new BadStateError(MODE_BUSY_MESSAGE);
    }
    const mode = await this.#freshMode(session);
    if (mode === 'unknown') throw new BadRequestError(this.#cli.modeUnknownMessage(session));
    if (!modeCycleStartAllowed(mode)) throw new BadStateError(HERDR_MODE_BYPASS_MESSAGE);
    // Ten sam powód, co przy `/model`: w oknie odczytu stopki panel mógł zostać podpięty na nowo.
    const live = this.#sessions.get(id) === session ? session.driver : null;
    if (live === null || live.setMode === undefined) throw new BadStateError(HERDR_MODE_MESSAGE);
    if (!deps.takeSendSlot(session.herdrKey ?? id)) {
      throw new TooManyRequestsError(HERDR_THROTTLED_MESSAGE);
    }
    // Od tej chwili wszystko jedzie w tle (202): klawisz, pauza, odczyt stopki — sekundy.
    live.setMode(patch.mode);
    return { ok: true };
  }

  /**
   * „Pokaż w herdr" (`agent.focus`) — jedyna akcja Raroga, która ŚWIADOMIE kasuje `done`.
   *
   * Znacznik `done` w herdr znaczy „wynik, którego nikt nie widział", a przełączenie panelu
   * na wierzch znaczy „idę to obejrzeć" — więc skasowanie jest tu prawdą, a nie efektem
   * ubocznym. To dlatego Rarog NIE woła `agent.focus` mimochodem (żadnego preloadu, żadnego
   * „na wszelki wypadek"): jedynym wywołaniem jest tapnięcie człowieka.
   *
   * Panel spoza `RAROG_HERDR_ROOTS` też wolno pokazać: to jedyna akcja, która nie pisze do
   * panelu ani nie czyta jego treści, a dla sesji poza zasięgiem bywa JEDYNYM sensownym
   * wyjściem („nie mogę tego prowadzić — otwórz to na Macu").
   */
  async focus(id: string): Promise<void> {
    const session = this.#require(id);
    const key = session.herdrKey;
    if (key === undefined) throw new BadStateError(HERDR_FOCUS_MESSAGE);
    const supervisor = this.#requireSupervisor();
    // `agent.focus` w martwe gniazdo
    // skończyłoby się `HerdrUnavailableError`, a tego kodu `managerErrorStatus` nie zna
    // — telefon dostałby 500 „Błąd serwera." zamiast 409 z polskim zdaniem.
    if (!supervisor.status().available) {
      throw new BadStateError(HERDR_TERMINAL_UNAVAILABLE_MESSAGE);
    }
    // `agent.focus` jest w `MUTATING_METHODS`, więc podlega temu samemu killswitchowi
    // co wysyłka — inaczej `RAROG_HERDR_SEND=0` przepuszczałby przestawianie cudzego
    // terminala.
    this.#assertHerdrWritable();
    await supervisor.focus(key);
    /*
     * W TRAKCIE tury znacznika NIE ruszamy (ta sama bramka co w `markSeen`):
     * `seen` znaczy dziś „wynik BIEŻĄCEJ tury odebrał człowiek", a wyniku jeszcze nie ma —
     * zapalony tutaj chowałby świeży wynik w zwiniętym ogonie „bezczynni" i gasił push
     * „Skończył" (`resultSeen`). Panel pracujący i tak nie ma w herdr badge'a `done`, więc
     * nie ma tu czego odzwierciedlać; sam fokus (wyżej) leci bez zmian.
     */
    if (WORKING_STATES.includes(session.state)) return;
    // Karta ma przestać stać w sekcji uwagi w tej samej chwili, w której panel wyszedł na
    // wierzch: herdr skasował `done`, więc `seen` w Rarogu musi to odzwierciedlić od razu,
    // a nie dopiero po najbliższym resyncu (do 30 s).
    const changed = session.seen !== true || session.seenBy !== undefined;
    // Człowiek patrzy na ten panel na Macu — to jest odbiór wyniku, a nie lustro statusu herdr.
    seenMarks.noteHumanReceipt(session);
    /*
     * Odbiór trwały, jak przy `markSeen()`. Adopcja panelu `idle` i tak daje `seen: true`, ale ręczne
     * „nieprzeczytane" stoi w magazynie pod tym samym numerem stanu
     * i bez nadpisania wracałoby na niebiesko przy pierwszym restarcie Raroga.
     */
    seenMarks.rememberSeenMark(session, this.#config.herdrDeps?.seen);
    if (changed) this.#emitSessionChanged(session);
  }

  /** „Obejrzałem to na telefonie" or the voice agent's pick-up: the rule lives in {@link seenMarks.markSeen}. */
  markSeen(id: string, pickUp?: SeenPickUp): void {
    seenMarks.markSeen(this.#require(id), this.#seenMarksDeps(), pickUp);
  }

  /** „Oznacz jako nieprzeczytane": the rule lives in {@link seenMarks.markUnseen}. */
  markUnseen(id: string): void {
    seenMarks.markUnseen(this.#require(id), this.#seenMarksDeps());
  }

  /** Manager configuration as seen-mark dependencies, read at call time. */
  #seenMarksDeps(): SeenMarksDeps {
    const config = this.#config;
    return {
      store: config.herdrDeps?.seen,
      notifier: config.notifier,
      herdrSeenFocus: config.herdrSeenFocus, herdrSend: config.herdrSend,
      herdrSupervisor: config.herdrSupervisor,
      logger: config.logger,
      emitSessionChanged: (session) => { this.#emitSessionChanged(session); },
      decisionStands: (session) => this.#consentCards.decisionStands(session),
    };
  }


  /**
   * Druga linia obrony dla allow-listy modeli (pierwsza jest w routerze).
   *
   * Dowolny string z requestu trafiłby do flagi `--model` uruchamianego procesu, więc
   * przepuszczamy wyłącznie to, co Rarog zna: listę wbudowaną. `undefined` przechodzi —
   * to jest „model domyślny konta", czyli ZERO flagi w argv.
   */
  #assertKnownModel(model: string | undefined): void {
    if (model === undefined) return;
    if (isKnownModel(model)) return;
    throw new BadRequestError(say('model.not-in-list', { model }));
  }

  // -------------------------------------------------------------------------
  // Git: diff sesji
  // -------------------------------------------------------------------------

  /** Port of the diff gate (`diffSession` in `session-scope.ts`): the session lookup and the configuration. */
  #diffSessionPort(): sessionScope.DiffSessionPort {
    return { require: (id) => this.#require(id), config: this.#config };
  }

  async diff(id: string): Promise<SessionDiff> {
    const session = sessionScope.diffSession(id, this.#diffSessionPort());
    if (session === null) return this.#requireDemo().demoDiff();
    const runner = this.#config.diffRunner ?? spawnGitArgs(this.#gitEnv);
    return collectDiff(session.cwd, { run: runner });
  }

  async diffFiles(id: string): Promise<DiffFileList> {
    const session = sessionScope.diffSession(id, this.#diffSessionPort());
    if (session === null) return this.#requireDemo().demoDiffFiles();
    const injected = this.#config.diffRunner;
    return measureDiff(GIT_DIFF_LIST_LOG, this.#diffClock, () => collectDiffList(session.cwd, {
      run: injected ?? spawnGitArgs(this.#gitEnv),
      // Liczniki mają WŁASNY budżet (jak w ramce `git-status`): lista nie czeka na nie dłużej.
      runNumstat: injected ?? spawnGitArgs(this.#gitEnv, GIT_NUMSTAT_BUDGET_MS),
    }));
  }

  filesPort(): SessionFilesPort {
    return {
      ...this.#diffSessionPort(), run: this.#config.diffRunner ?? spawnGitArgs(this.#gitEnv),
      demoEntries: (rel) => this.#requireDemo().demoFileEntries(rel),
    };
  }

  listFiles(id: string, dir: string, maxBytes: number): Promise<FileListingAnswer> {
    return listSessionFiles(id, dir, maxBytes, this.filesPort());
  }

  openFile(id: string, rel: string, maxBytes: number): Promise<FileDownloadAnswer> {
    return openSessionDownload(id, rel, maxBytes, {
      ...this.#diffSessionPort(), demoFile: (file) => this.#requireDemo().demoFileBytes(file),
    });
  }

  async diffFile(id: string, path: string): Promise<DiffFilePatch> {
    const session = sessionScope.diffSession(id, this.#diffSessionPort());
    // Walidacja wstępna stoi PRZED gałęzią demo: `?path=../x` to 400 także tam, jak na produkcji.
    if (validateDiffPath(path) === null) throw new DiffError(DIFF_BAD_PATH_ERROR);
    if (session === null) {
      const patch = this.#requireDemo().demoDiffFile(path);
      if (patch === null) throw new DiffError(DIFF_FILE_NOT_FOUND_ERROR);
      return patch;
    }
    const run = this.#config.diffRunner ?? spawnGitArgs(this.#gitEnv);
    return measureDiff(GIT_DIFF_FILE_LOG, this.#diffClock, () => collectDiffFile(session.cwd, path, { run }));
  }

  /** Clock and logger of the diff read lines (`diff-measure.ts`), read at the time of each line. */
  readonly #diffClock: DiffMeasureClock = {
    now: () => this.#now(), log: (line) => { this.#config.logger?.(line); },
  };

  // -------------------------------------------------------------------------
  // Cykl życia procesu
  // -------------------------------------------------------------------------

  /**
   * Domknięcie zapisów w toku.
   *
   * Rejestru SESJI nie ma, a lista ukrytych, aliasy (`herdr-hidden.json`) i dziennik
   * audytu mają własnych pisarzy. Manager pisze jedną rzecz: rejestr idempotentnych
   * wysyłek (`outbox-ids.json`, `send-registry.ts`) — i na jego łańcuch zapisów czeka ta metoda.
   * Testy i cykl życia procesu wołają ją na końcu.
   */
  flush(): Promise<void> {
    return this.#sendRegistry.flush();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#cli.stopCliVersionPoll();
    for (const session of this.#sessions.values()) {
      this.#expirePending(session, session.driver !== null);
      // Kluczowe dla sesji herdr: `#detachDriver` NIE woła `interrupt()` dla drivera, który
      // nie jest właścicielem procesu. Bez tego SIGTERM Raroga słałby `ctrl+c` do wszystkich
      // paneli na Macu — czyli restart deployu przerywałby cudzą pracę.
      this.#detachDriver(session);
      this.#dropStartWait(session);
    }
    this.#claimWindows.dispose();
    this.#git.close();
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Driver
  // -------------------------------------------------------------------------

  #attachDriver(session: Session, driver: SessionDriver): void {
    /*
     * Wymiana drivera MUSI sprzątnąć poprzednika: koniec strumienia
     * drivera herdr zostawia karty zgody w `#pending` ŚWIADOMIE (`#markStale` — krótkie
     * mrugnięcie socketa nie ma gasić decyzji), ale ich callbacki są domknięte na STARYM
     * driverze. Po podmianie bez sprzątnięcia tapnięcie w taką kartę szłoby w martwy obiekt
     * i ginęło bez śladu — karta wyglądałaby na żywą, decyzja nie wychodziłaby nigdy. Nowy
     * driver po podpięciu sam oceni panel i wystawi ŚWIEŻĄ kartę, jeśli dialog wciąż stoi.
     */
    // Karty kanału zgód zostają: odpowiada na nie hook, nie driver, a nowy driver dalej obserwuje kanał.
    if (session.driver !== null && session.driver !== driver) {
      this.#expirePending(session, false);
      this.#detachDriver(session);
    }
    session.driver = driver;
    /*
     * Nowy driver = rachunek wiadomości tury NIEPEŁNY. Follower
     * zaczyna od historii, a historii nie liczymy: przy podpięciu w trakcie tury jej prompt stoi
     * właśnie tam, więc notka o postoju dopisana na żywo wyglądałaby na jedyną przyczynę tury
     * i wyciszyła „gotowe" po zadaniu człowieka. Rachunek wraca przy pierwszym końcu tury, który
     * manager zobaczy na tym driverze.
     */
    session.turnInput = undefined;
    void this.#pump(session, driver);
  }

  /**
   * Domyka „turę zerową" sesji bez promptu OD RAZU po podpięciu drivera — nie przy `init`.
   *
   * Sonda na realnym SDK: w streaming input mode silnik NIE emituje `system/init`,
   * dopóki nie dostanie pierwszej wiadomości użytkownika. Czekanie na `init` oznaczało więc
   * „startuje" bez końca dla pustej sesji, wznowienia i zmiany modelu. `waiting-input` jest tu
   * prawdą: proces silnika stoi i czeka na człowieka; pierwsza wiadomość uruchamia `turn-start`,
   * a spóźniony `init` trafia już w stan, którego nie rusza.
   */
  #settleEmptyStart(session: Session): void {
    if (!session.emptyStart) return;
    session.emptyStart = false;
    this.#applyTransition(session, { type: 'driver-init' });
    // Bez „gotowe”: karta dalej wstaje (`awaitingFirstTurn`), więc to nie koniec tury.
    this.#applyTransition(session, { type: 'result', subtype: 'success' });
    // „Tura zerowa" nie jest turą: rachunek wiadomości zostaje niepełny do końca pierwszej
    // prawdziwej.
    session.turnInput = undefined;
  }

  #detachDriver(session: Session): void {
    const driver = session.driver;
    if (driver === null) return;
    session.driver = null;
    // Przycisk ponownej wysyłki po blokadzie hooka należał do tego drivera (jego pole promptu, jego echo).
    session.promptBlocked = undefined;
    session.turnOpenedBySend = undefined;
    /*
     * Echo odroczone: nowy driver ma nowe okno echa, więc tokenów wstrzymanych wiadomości
     * nie zna — idą na koniec transkryptu teraz. NIE przy zamykaniu Raroga: RAM i tak ginie,
     * a echo z `clientMessageId` wysłane tuż przed restartem zgasiłoby w apce wpis promptu, który
     * dalej czeka w CLI (po starcie przyjdzie z pliku i zgaśnie po podpisie).
     */
    if (this.#disposed) {
      session.heldEchoes = [];
      heldEcho.disarmHeldFlush(session);
    } else {
      heldEcho.flushHeld(session, 'driver detached', this.#heldEcho);
    }
    // Driver, który NIE jest właścicielem procesu, nie ma prawa go przerwać: `interrupt()`
    // dla sesji przypiętej do cudzego panelu znaczy `ctrl+c` wysłany do żywego terminala
    // użytkownika, a `dispose()` managera woła to dla WSZYSTKICH sesji przy SIGTERM —
    // czyli restart Raroga przerwałby pracę każdego panelu na Macu.
    // `void`: sprzątanie nie czeka na potwierdzenie klawisza — driver zaraz i tak leci do kosza.
    if (driver.ownsProcess) void driver.interrupt();
    driver.dispose();
  }

  /** Jedyny konsument strumienia drivera. Kończy się razem z driverem albo jego wymianą. */
  async #pump(session: Session, driver: SessionDriver): Promise<void> {
    try {
      for await (const event of driver.events) {
        // Driver wymieniony (resume) albo odpięty (close) — stary strumień nas nie obchodzi.
        if (session.driver !== driver) return;
        this.#handleDriverEvent(session, driver, event);
      }
    } catch (error) {
      this.#failSession(session, error);
      return;
    }
    if (session.driver !== driver) return;
    /*
     * Koniec strumienia drivera, który NIE jest właścicielem procesu, znaczy „Rarog stracił
     * kontakt", a nie „silnik padł". Panel w terminalu żyje dalej, więc karta ma zostać
     * w swoim stanie i tylko zblednąć (`stale`). Domyślna ścieżka (`driver-exit ok:false`
     * → `error`) byłaby tu kłamstwem, które przestawia 17 kart do sekcji błędów.
     */
    if (!driver.ownsProcess) {
      // Strumień skończony: plik nie przyniesie już wpisów wstrzymanych promptów.
      heldEcho.flushHeld(session, 'driver stream ended', this.#heldEcho);
      this.#markStale(session);
      return;
    }
    // Strumień skończył się bez `exit` — traktujemy jak nagłe wyjście silnika.
    if (LIVE_STATES.includes(session.state)) {
      this.#expirePending(session, false);
      this.#consentCards.endConsentSession(session);
      this.#applyTransition(session, { type: 'driver-exit', ok: false }, DRIVER_GONE_DETAIL);
    }
  }

  /**
   * Źródło prawdy o tej sesji jest chwilowo nieosiągalne.
   *
   * To NIGDY nie jest przejście stanu (reguła 11.4): stan zostaje ostatni znany, UI wygasza
   * kartę i pokazuje baner. Awaria nadzorcy nie ma prawa przestawić kart między sekcjami.
   */
  #markStale(session: Session): void {
    if (session.stale === true) return;
    session.stale = true;
    // Karty kanału zgód zostają, jak karty z ekranu: odpowiedź idzie plikiem do hooka, nie przez panel, a śmierć
    // hooka widzi obserwacja cyklu. Po powrocie kontaktu następna obserwacja ocenia je od nowa.
    this.#emitSessionChanged(session);
  }

  #handleDriverEvent(session: Session, driver: SessionDriver, event: DriverEvent): void {
    if (session.heldEchoes.length > 0) heldEcho.expireHeld(session, this.#heldEcho);
    switch (event.type) {
      // Trzy duże gałęzie (`init`, `history`, `agent-state`) żyją w `driver-events.ts`, każda z wąskim portem.
      case 'init':
        applyInitEvent(session, event, this.#driverEvents);
        this.#prStatus.sync(session); // `/clear` drops the list of the previous conversation
        return;

      /*
       * Panel przyjął `/model` albo `/effort` — pigułka ma się zmienić od razu, a nie po
       * następnej turze (komendy lokalne CLI nie zostawiają w jsonl wpisu asystenta, więc
       * `init` z meta bez tego zdarzenia przychodził dopiero z pierwszą odpowiedzią).
       * `init` pozostaje źródłem prawdy: rozwiązany identyfikator z meta nadpisze alias.
       */
      case 'model-set': {
        if (session.state === 'done') return;
        let changed = false;
        if (event.model !== undefined && event.model !== '' && session.model !== event.model) {
          session.model = event.model;
          changed = true;
        }
        if (event.effort !== undefined && session.effort !== event.effort) {
          session.effort = event.effort;
          changed = true;
        }
        if (event.ultracode !== undefined && session.ultracode !== event.ultracode) {
          session.ultracode = event.ultracode;
          changed = true;
        }
        if (changed) this.#emitSessionChanged(session);
        return;
      }

      case 'delta':
        // Wyścig „delta po done" i „delta po Esc": poza turą strumienia nie ma.
        if (!STREAMING_STATES.includes(session.state)) return;
        this.#emitSession(session, { type: 'delta', sessionId: session.id, text: event.text });
        return;

      case 'activity': {
        // Kanał ULOTNY, dokładnie jak `delta`: zero `#appendMessage`, zero przejścia stanu.
        // Sesja, która nie pracuje, nie ma czego pokazywać.
        if (!WORKING_STATES.includes(session.state)) return;
        this.#emitActivity(session, activityOf(event));
        return;
      }

      // `role` obejmuje teraz też `'user'` (prompt wpisany przez człowieka w terminalu).
      // Ścieżka jest ta sama: to nadal jedna domknięta wiadomość transkryptu.
      case 'message': {
        if (session.state === 'done') return;
        // Wpis z pliku po wysyłce: odpowiedź asystenta albo wpis `user` (prompt przy Macu, wstrzymane echo)
        // znaczą, że tura ruszyła albo ktoś inny wysłał prompt — blokada hooka nie zdejmie już sesji
        // z „pracuje”, a przycisk ponownej wysyłki traci sens po wpisie `user`. Notka `system` niczego nie gasi.
        if (event.role !== 'system') session.turnOpenedBySend = undefined;
        // Przycisk znika z karty ramką `session-changed` — ścieżka echa niżej jej nie zawsze daje.
        const buttonGone = event.role === 'user' && session.promptBlocked !== undefined;
        if (event.role === 'user') session.promptBlocked = undefined;
        if (event.echoToken !== undefined) {
          heldEcho.placeHeld(session, event.echoToken, this.#heldEcho);
          if (buttonGone) this.#emitSessionChanged(session);
          return;
        }
        this.#appendMessage(
          session, event.role, event.blocks, undefined, undefined,
          event.notice !== undefined ? { notice: event.notice } : {},
        );
        // Prompt wpisany w terminalu albo notka harnessu: jedno i drugie mogło wywołać turę.
        if (event.role === 'user') this.#noteTurnInput(session, event.notice);
        // Wywołania narzędzi głównego agenta: czy tura po samym meldunku o artefakcie coś zrobiła.
        else if (event.role === 'assistant') this.#noteToolCalls(session, event.blocks);
        this.#emitSessionChanged(session);
        this.#git.maybeGitStatus(session, event.blocks);
        return;
      }

      /*
       * Wejście roli `user`, którego ten strumień nie niesie jako wiadomości: wiadomość od subagenta i zaplanowane
       * wybudzenie (`isHiddenTurnInput`) oraz prompt wysłany z Raroga w chwili, w której stanął w pliku (follower
       * zgasił jego echo). Nie trafia na ekran i niczego nie rozgłasza — służy tylko do ustalenia przyczyny tury:
       * tura, w której było cokolwiek poza meldunkiem o postoju subagenta, kończy się zwykłym „gotowe". A compaction
       * boundary (`kind: 'compaction'`) only counts: it is no prompt, so no send and no prompt block end with it.
       */
      case 'turn-input':
        if (session.state === 'done') return;
        if (event.kind === 'compaction') return this.#noteTurnInput(session, undefined, true);
        // Wejście tury z pliku (także echo własnego promptu): prompt doszedł, blokady tej wysyłki nie będzie.
        session.turnOpenedBySend = undefined;
        if (session.promptBlocked !== undefined) {
          session.promptBlocked = undefined;
          // Przycisk „Uruchom ponownie i wyślij” znika z karty.
          this.#emitSessionChanged(session);
        }
        // Follower stracił ciągłość pliku (nowa rozmowa, skrócenie, przeskok): wejścia tury
        // mogły go ominąć, więc z rachunku nie wolno wnioskować do następnego końca tury.
        if (event.lost === true) {
          session.turnInput = undefined;
          // Okno echa wyzerowane razem z ciągłością pliku: wpisy wstrzymanych promptów mogły
          // przepaść w luce, a nowe okno ich tokenów nie zna.
          heldEcho.flushHeld(session, 'gap in the transcript file', this.#heldEcho);
        } else {
          this.#noteTurnInput(session);
        }
        return;

      case 'prompt-blocked':
        this.#onPromptBlocked(session, event);
        return;

      // Echo odroczone nie dostanie podstawienia z pliku — wiadomość idzie na koniec teraz.
      case 'echo-refused':
        heldEcho.flushHeld(session, 'send did not reach the pane', this.#heldEcho, event.token);
        return;
      case 'echo-dropped':
        heldEcho.flushHeld(session, 'entry fell out of the echo window', this.#heldEcho, event.token);
        return;

      case 'history':
        applyHistoryEvent(session, event, this.#driverEvents);
        return;

      /*
       * Auto-tytuł panelu (np. `/rename` w terminalu) → etykieta karty, także po pierwszym
       * zobaczeniu panelu, żeby zmiana nazwy w herdr dojechała do Raroga.
       */
      case 'title': {
        /*
         * Nazwa z wpisu `custom-title` (`/rename`) wygrywa z tytułem terminala, dopóki panel pisze tę samą
         * rozmowę. Tytuł herdr działa tylko przy nazwie nieznanej.
         */
        if (event.source === 'custom-title') this.#customTitled.add(session);
        else if (this.#customTitled.has(session)) return;
        const fromTitle = labelFromPrompt(event.title);
        // `#setLabel` porównuje etykietę PO czyszczeniu — ten sam tytuł nie woła nikogo drugi raz.
        if (fromTitle === null || !this.#setLabel(session, fromTitle)) return;
        this.#emitSessionChanged(session);
        return;
      }
      case 'agent-state':
        applyAgentStateEvent(session, event, this.#driverEvents);
        return;

      /*
       * Driver stracił kontakt ze swoim źródłem, ale silnik ŻYJE dalej (padł socket herdr).
       * To nie jest `exit` i nie jest przejście stanu — patrz `#markStale`.
       */
      case 'detached': {
        this.#markStale(session);
        this.#attach.settleAttach(session);
        return;
      }

      case 'permission-request': {
        /*
         * Karta BEZ `input` to karta, której Rarog nie rozumie: rozjazd nazwy
         * narzędzia między jsonl a ekranem albo nieudane parsowanie opcji po ponowieniu.
         * Dostaje `red` BEZ pytania klasyfikatora — bo klasyfikator nie ma czego czytać,
         * a „nie wiem, co to jest" nie może wyglądać na kartę zieloną. Zatwierdzenia dla
         * niej nie ma (`#undecidable`); zostaje „Odrzuć (Esc)".
         */
        // Jedna karta na dialog: przy żywej karcie kanału zgód karta z ekranu nie powstaje (także gdy driver wystawił
        // ją, zanim zobaczył kartę kanału).
        if (this.#consentCards.consentCardStands(session)) return;
        const undecidable = event.input === null;
        // Treść bez przycisku zgody (tryb kanału zgód `main`, tekst niepełny dla oka): `allow` odmawia jak wyżej.
        const noAllow = undecidable || event.canAllow === false || !cardShowsAll(event.displayText, event.truncation);
        if (noAllow) this.#undecidable.add(event.reqId);
        // Powód degradacji, wycinek ekranu i klasa z rejestru CLI na karcie SESJI („Refusal diagnostics” w `docs/dialogs.md`)
        // — zwykła zgoda ich nie niesie, więc to samo przypisanie czyści to, co zostało
        // po poprzednim dialogu.
        session.herdrDialogReason = event.reason;
        session.herdrDialogScreen = event.screen;
        session.cliDialog = event.cliDialog;
        const request: PermissionRequest = {
          permId: event.reqId,
          sessionId: session.id,
          toolName: event.toolName,
          displayText: event.displayText,
          // Kod zdania karty (tylko karta zdegradowana) i ucięcie tekstu stopką — z budowniczego karty bez zmian.
          ...(event.displayTextRef === undefined ? {} : { displayTextRef: event.displayTextRef }),
          ...(event.truncation === undefined ? {} : { truncation: { ...event.truncation } }),
          risk: undecidable ? 'red' : classifyRisk(riskSource(event), event.toolName),
          cwd: session.cwd,
          createdAt: this.#iso(),
          subject: permissionSubject(event.toolName),
          // `shell` tylko dla dosłownej komendy powłoki; karta `undecidable` (`input: null`),
          // z ekranu, plan i komenda ucięta stopką pola nie dostają.
          ...permissionSemantics(event.input, event.displayText),
          // Etykieta „Yes, and don't ask again…" — WYŁĄCZNIE gdy driver ją rozpoznał;
          // karta bez zatwierdzania (`undecidable`) nie ma prawa jej nieść.
          ...(event.alwaysLabel !== undefined && !noAllow
            ? { alwaysLabel: event.alwaysLabel } : {}),
          // Ta sama prawda, co `#undecidable`, tylko podana telefonowi WPROST: bez niej UI
          // rysowałoby „Zatwierdź", które zawsze kończy się 409. Przycisk bez pokrycia jest
          // gorszy niż jego brak (reguła 11.1).
          canAllow: !noAllow,
          ...(noAllow && !undecidable && event.unavailable !== undefined ? { unavailable: event.unavailable } : {}),
        };
        this.#pending.addPermission(
          request,
          (decision, message) => driver.respondPermission(event.reqId, decision, message),
        );
        this.#emitSession(session, { type: 'permission-pending', request });
        this.#timing.timingCard(session, undecidable ? 'screen' : 'jsonl');
        this.#claimWindows.dialogCard(session, undecidable ? 'screen' : 'jsonl');
        /*
         * Powiadomienie leci TAKŻE przy przejściu-tożsamości: sesja herdr jest już
         * w `waiting-permission` z `agent-blocked`, a dopiero TERAZ wiadomo, czego dialog
         * dotyczy — `#notifyDetail` czyta świeżo dodany wpis pending.
         *
         * Tym samym trybem jedzie `session-changed`: karta listy niesie od tej
         * pory `waitingFor`, a przy tożsamości `#applyTransition` wychodzi PRZED rozgłoszeniem,
         * więc bez tej linii pole nie dojeżdżałoby do sidebara w chwili, w której powstaje —
         * czyli dokładnie wtedy, gdy jest potrzebne. Kolejność jak w `#applyTransition`:
         * najpierw ramka, potem powiadomienie.
         */
        if (!this.#applyTransition(session, { type: 'permission-requested' })) {
          this.#emitSessionChanged(session);
          this.#note(session, { type: 'permission-requested' });
        }
        return;
      }

      /*
       * Dialog stojący w PANELU, którego nie ma w jsonl („Dialogs and cards in a herdr pane” w `docs/implementation-spec.md`).
       *
       * Nie zakładamy karty w `#pending` i to jest cała różnica wobec zgody: nie ma `permId`,
       * bo nie ma wpisu w transkrypcie, z którego dałoby się ją złożyć. Zostaje stan
       * `waiting-permission` (agent NAPRAWDĘ czeka) plus jedno pole na karcie sesji, które
       * mówi telefonowi, czy wolno pokazać „Zatwierdź". Treść, którą widzi człowiek, to
       * wycinek ekranu — driver dopisał go do transkryptu chwilę wcześniej.
       */
      case 'screen-dialog': {
        session.herdrDialog = event.knownDialog;
        // Powód odmowy, wycinek ekranu i klasa z rejestru CLI jadą kartą, a nie osobnym
        // kanałem („Refusal diagnostics” w `docs/dialogs.md`): przypisanie BEZWARUNKOWE, bo nowa karta bez nich (dialog
        // rozpoznany) musi skasować to, co niosła poprzednia.
        session.herdrDialogReason = event.reason;
        session.herdrDialogScreen = event.screen;
        session.cliDialog = event.cliDialog;
        /*
         * `agent-blocked`, a nie `permission-requested`: to drugie prowadzi WYŁĄCZNIE
         * z `running`, a panel z dialogiem bywa w Rarogu w `waiting-input` (dialog
         * zaufania staje zaraz po starcie, zanim ruszy pierwsza tura). Przejście jest
         * idempotentne, więc zwykła kolejność (`agent-state: blocked` → `screen-dialog`)
         * nic tu nie zmienia — a odwrotna albo brak `blocked` przestaje gubić stan.
         */
        this.#applyTransition(session, { type: 'agent-blocked' });
        this.#emitSessionChanged(session);
        this.#timing.timingCard(session, 'dialog');
        this.#claimWindows.dialogCard(session, 'dialog');
        return;
      }

      case 'question-request': {
        const request: QuestionRequest = {
          qId: event.reqId,
          sessionId: session.id,
          // Podgląd opcji jedzie do klientów PRZYCIĘTY — oryginał zostaje w driverze,
          // który oddaje go CLI przy odpowiedzi z notatką. Pole „Notatka" wyznacza serwer:
          // kanał hooka (plik, nie cyfra) i proces CLI od 2.1.288, które przyjęło `annotations`.
          questions: withQuestionNotes(
            clipQuestionPreviews(withOptionRoles(event.questions)),
            event.channel === 'hook' && this.#cli.cliAcceptsNotes(session),
          ),
          createdAt: this.#iso(),
          // Kanał jedzie DALEJ, nie zostaje w driverze: bramka wielokrotnego wyboru stoi
          // tutaj (`answerQuestion`), a telefon rysuje z niej listę do zaznaczania.
          ...(event.channel === undefined ? {} : { channel: event.channel }),
          // Wolny tekst przechodzi WYŁĄCZNIE kanałem hooka (plik, nie cyfra) — regułę liczy
          // serwer, żeby klient nie decydował po kanale dostarczenia.
          customAnswer: event.channel === 'hook',
          // Wstępu z ekranu tu nie ma: decyzja wycofana, bo tekst tury
          // stoi w jsonl jeszcze przed dialogiem. Pole zostaje w protokole, nieużywane.
        };
        this.#pending.addQuestion(
          request,
          (answers, notes) => (notes === undefined
            ? driver.answerQuestion(event.reqId, answers)
            : driver.answerQuestion(event.reqId, answers, notes)),
        );
        this.#emitSession(session, { type: 'question-pending', request });
        this.#timing.timingCard(session, 'question');
        this.#claimWindows.dialogCard(session, 'question');
        // To samo co przy zgodzie — patrz komentarz wyżej, `#note` i `waitingFor`.
        if (!this.#applyTransition(session, { type: 'question-requested' })) {
          this.#emitSessionChanged(session);
          this.#note(session, { type: 'question-requested' });
        }
        return;
      }

      /*
       * Klasa z rejestru CLI dla STOJĄCEJ karty bez decyzji zmieniła się po jej wystawieniu.
       * Tylko pole karty sesji: bez pendingu, bez przejścia stanu i bez pusha. Klasa
       * wchodzi wyłącznie przy stojącej decyzji — spóźnione zdarzenie po wyjściu z blokady nie
       * ma prawa wskrzesić pola, które `agent-state` właśnie skasował.
       */
      case 'cli-dialog': {
        if (event.cliDialog !== undefined && !DECISION_STATES.includes(session.state)) return;
        if (session.cliDialog === event.cliDialog) return;
        session.cliDialog = event.cliDialog;
        this.#emitSessionChanged(session);
        return;
      }

      /*
       * Odświeżony wycinek STOJĄCEJ karty bloku warstwy 2 (`RAROG_DIALOG_LAYER2=1`): ta sama karta, inny widok pod nią.
       * Tak jak `cli-dialog`: samo pole karty sesji, bez pendingu, przejścia stanu i pusha. Porównanie PEŁNEGO
       * tekstu, nie długości: zakładka `/status` potrafi mieć wycinek tej samej długości co poprzednia. Spóźnione
       * zdarzenie po zdjęciu karty (stan poza decyzją albo karta bez wycinka) nie wskrzesza pola.
       */
      case 'dialog-screen': {
        if (!DECISION_STATES.includes(session.state) || session.herdrDialogScreen === undefined) return;
        if (session.herdrDialogScreen === event.screen) return;
        session.herdrDialogScreen = event.screen;
        this.#emitSessionChanged(session);
        return;
      }

      case 'git-status':
        this.#git.applyGitStatus(session, event);
        return;

      case 'usage':
        applyUsage(session, event.context, this.#emit);
        return;

      // Lists of the conversation (background tasks, artifacts, pull requests, crons): `conversation-lists.ts`.
      case 'background-tasks':
      case 'artifacts':
      case 'pull-requests':
      case 'scheduled-tasks':
        applyConversationList(session, event, this.#conversationLists);
        return;

      /*
       * Czekające narzędzie przestało czekać — człowiek odpowiedział w terminalu albo agent
       * ruszył dalej. Bez tego karta zgody z telefonu wisiałaby po decyzji podjętej przy biurku
       * i pierwsze tapnięcie w nią wysłałoby cyfrę do dialogu, którego już nie ma.
       */
      case 'permission-cleared': {
        // `false`: driver JUŻ wie, że karta jest nieaktualna — odbijanie decyzji z powrotem
        // do niego wysłałoby `escape` do panelu, który właśnie ruszył dalej. Karty kanału zgód zostają: ich stan
        // ocenia następna obserwacja kanału (zrzut, proces hooka, rejestr CLI).
        this.#expirePending(session, false);
        // To samo dotyczy dialogu z ekranu: driver gasi kartę tym samym zdarzeniem, więc
        // rozpoznanie MUSI zniknąć razem z nią. Zostawione przeżyłoby dialog i dałoby
        // „Zatwierdź" dla czegoś, czego już nie ma na ekranie.
        session.herdrDialog = undefined;
        session.herdrDialogReason = undefined;
        session.herdrDialogScreen = undefined;
        session.cliDialog = undefined;
        this.#emitSessionChanged(session);
        return;
      }

      case 'result': {
        if (event.summary !== undefined) session.lastSummary = event.summary;
        const detail = event.subtype === 'error_max_turns'
          ? MAX_TURNS_DETAIL
          : (event.subtype === 'error' ? DRIVER_ERROR_DETAIL : undefined);
        this.#applyTransition(session, { type: 'result', subtype: event.subtype }, detail);
        this.#emitSessionChanged(session);
        return;
      }

      case 'limit-reached': {
        this.#applyTransition(session, { type: 'limit-reached' }, limitReachedDetail(event.resetAt));
        return;
      }

      case 'exit': {
        this.#expirePending(session, false);
        this.#consentCards.endConsentSession(session);
        this.#applyTransition(
          session,
          { type: 'driver-exit', ok: event.ok },
          event.ok ? undefined : (event.reason ?? DRIVER_ERROR_DETAIL),
        );
        this.#detachDriver(session);
        if (session.launchPending && !this.#startWaits.has(session)) this.#startExits.add(session);
        this.#dropStartWait(session);
        return;
      }

      default: {
        // Nowy typ zdarzenia drivera bez gałęzi tutaj nie przejdzie typechecku.
        const unhandled: never = event;
        return unhandled;
      }
    }
  }

  #failSession(session: Session, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    // Ta sama reguła co przy końcu strumienia: driver bez własnego procesu nie ma jak
    // „zakończyć się błędem" — to Rarog stracił kontakt z cudzym panelem.
    if (session.driver !== null && !session.driver.ownsProcess) {
      this.#detachDriver(session);
      this.#markStale(session);
      return;
    }
    this.#expirePending(session, false);
    this.#consentCards.endConsentSession(session);
    this.#detachDriver(session);
    // Treść wyjątku w dopisku stanu: zdanie błędu silnika z treścią wyjątku jako argumentem `text`.
    this.#applyTransition(
      session, { type: 'driver-exit', ok: false },
      reason === '' ? DRIVER_ERROR_DETAIL : say('state.driver-error.reason', { reason }),
    );
  }

  // -------------------------------------------------------------------------
  // Nadzorca herdr — cykl życia paneli
  // -------------------------------------------------------------------------
  // Pump, event dispatch, a new pane, the terminal token, restore quiet and the `herdr-status` banner live in
  // `herdr-lifecycle.ts`; the paths that touch consent cards, dialog cards and restarts stay here.

  /**
   * Znany panel wrócił po awarii socketu.
   *
   * Osobno od `appeared`, bo `appeared` na znanym kluczu utworzyłby DRUGĄ sesję Raroga na
   * tym samym panelu. Stan zostaje ten, który był — poprawi go najbliższy `agent-state`.
   */
  #herdrReattached(supervisor: HerdrSupervisor, agent: HerdrAgent): void {
    const sessionId = this.#herdrByKey.get(agent.key);
    const session = sessionId !== undefined ? this.#sessions.get(sessionId) : undefined;
    if (session === undefined) {
      this.#herdrLifecycle.herdrAppeared(supervisor, agent);
      return;
    }
    /*
     * Kanał zgód: okres utraty dowodu otwarty przed odpięciem starego drivera, w tym samym kroku synchronicznym (bez
     * `await` między nimi). Żadna obserwacja nowego drivera go nie wyprzedzi, a stary po odpięciu nie zaczyna już
     * obserwacji, więc okres kończy dopiero obserwacja nowego followera (`layer1/observe.ts`).
     */
    this.#consentCards.consentReattached(session, agent);
    /*
     * Odpięcie starego drivera unieważnia jego karty: callbacki decyzji
     * są domknięte na driverze, więc karta pozostawiona po wymianie wyglądałaby na żywą, ale
     * tapnięcie szłoby w martwy obiekt i ginęło bez śladu. Gasimy je tu JAWNIE — nowy driver
     * po podpięciu sam oceni panel i wystawi świeżą kartę, jeśli dialog wciąż stoi.
     */
    this.#expirePending(session, false);
    this.#detachDriver(session);
    session.stale = false;
    session.herdrMode = agent.mode;
    // Dla Codexa `inScope` jest `false` NA SZTYWNO (`scopeOf` w nadzorcy), więc ta linia
    // trzyma `outOfScope` prawdziwe także wtedy, gdy panel w międzyczasie wszedł pod korzeń.
    session.outOfScope = !agent.inScope;
    /*
     * Zadania w tle i artefakty należą do rozmowy, z której przyszły (`engineSessionId`). Zostają tylko
     * przy tej samej rozmowie w zasięgu: listy nadpisze pierwsza wypłata nowego followera (także pusta), bez
     * migotania pigułki i sekcji. Znikają przed rozesłaniem karty, gdy panel wypadł poza zasięg (followera nie
     * dostanie, bezpieczeństwo pkt 6) albo pisze już inną rozmowę (`/clear`, `/resume` w czasie przerwy gniazda
     * herdr): nowy follower może nie wypłacić nic, póki pliku tej rozmowy nie da się przeczytać.
     * Zadania poprzedniej rozmowy blokowałyby inaczej restart i push „gotowe”.
     */
    if (session.outOfScope || agent.agentSessionId !== session.engineSessionId) {
      dropConversationLists(session, this.#conversationLists);
    }
    /*
     * `termId` liczony jeszcze raz, bo reattach przebudowuje kartę od migawki. Zmianę
     * samego tokenu między migawkami niesie osobne zdarzenie nadzorcy (`term-changed`,
     * `HerdrLifecycle.#herdrTermChanged`): restart serwera herdr odtwarza Claude w panelu terminala, zanim
     * terminal odzyska token z etykiety panelu (`reconcile`).
     */
    session.termId = this.#herdrLifecycle.termIdField(agent).termId;
    session.launchedByRarog = agent.launchedByRarog;
    this.#emitSessionChanged(session);
    void this.#attachHerdrDriver(supervisor, session, agent.key);
  }

  /**
   * Panel zamknięty w terminalu — karta ZOSTAJE, ale jako domknięta.
   *
   * Świadomie NIE kasujemy jej z RAM (tak robi dopiero „Ukryj"): sesja ma zapamiętany
   * `engineSessionId`, więc `POST /api/sessions/:id/resume` potrafi ją otworzyć w NOWYM
   * panelu pod tym samym adresem. Karta, która znika w chwili zamknięcia panelu, zabiera
   * ze sobą jedyną drogę powrotu do tej rozmowy z telefonu.
   */
  #herdrGone(key: string): void {
    const sessionId = this.#herdrByKey.get(key);
    const session = sessionId !== undefined ? this.#sessions.get(sessionId) : undefined;
    this.#herdrByKey.delete(key);
    if (session === undefined) return;
    // Znacznik ciszy po odtworzeniu należy do TEJ rozmowy w TYM panelu: karta Claude po `gone` zostaje w RAM
    // (`done`), a nowa rozmowa pod tym samym kluczem panelu dostałaby to samo id karty.
    this.#herdrLifecycle.herdrRestoreQuiet.delete(session.id);
    this.#expirePending(session, false);
    // Panel zniknął razem z procesem: karty kanału zgód schodzą z urządzeń (`permission-resolved`, `expired`
    // od `system`), w cyklu odwołane (`hook-dead`); karta sesji zostaje w RAM jako `done` bez kart kanału.
    this.#consentCards.endConsentSession(session);
    this.#detachDriver(session);
    // Panel zniknął przed gotowością (np. „No, exit” na dialogu zaufania): prompt startowy wraca do transkryptu.
    this.#dropStartWait(session);
    this.#unindexEngineSession(session);
    this.#attach.dropAttachWaiter(session.id);
    /*
     * Karta Codexa ZNIKA razem z panelem — i to jest jedyne miejsce, w którym zamknięty
     * panel Codexa różni się od zamkniętego panelu Claude. Powód jest ten sam, dla którego
     * karta Claude zostaje: ona ma `engineSessionId`, więc `resume` potrafi otworzyć tę samą
     * rozmowę w nowym panelu. Codex nie ma czego wznawiać (Rarog nie zna jego rolloutu i nie
     * uruchamia Codexa), więc zostawiona karta byłaby wierszem, który nic nie robi i którego
     * nie da się zdjąć inaczej niż restartem serwera.
     */
    if (session.engine === 'codex') {
      /*
       * To jest `#hideHerdrSession` rozpisane na dwie linie, a nie jego wywołanie, z jednego
       * powodu: tamta metoda wstawia detail `HERDR_HIDDEN_DETAIL` (panel zostaje w herdr), a tu
       * jest dokładnie odwrotnie — panel zniknął. Ramka `closed → done` mówi otwartym
       * klientom „ta karta jest domknięta", ale sama nie zdejmuje wiersza z ich map
       * (protokół nie zna „sesja usunięta") — to robi dopiero snapshot.
       */
      this.#herdrLifecycle.rememberGoneIdle(session);
      this.#applyTransition(session, { type: 'closed' }, HERDR_GONE_DETAIL);
      this.#forgetHerdrSession(session);
      this.#emitSessionsSnapshot();
      return;
    }
    /*
     * Restart na nowszym Claude Code: proces zniknął, bo Rarog wysłał `/exit`. Karta NIE
     * idzie w `done` (stan terminalny, bez „Wznów"), tylko w `resumable` — ten sam uuid zaraz
     * wstanie w nowym tabie, a gdyby start padł, „Wznów" jest drogą powrotu.
     */
    const restart = this.#sessionRestart.restarts.get(session.id);
    if (restart !== undefined) {
      /*
       * Dwa panele, jedna reguła: zniknął STARY (to był nasz `/exit`) albo NOWY, zanim zgłosił
       * gotowość (proces padł zaraz po starcie). W obu przypadkach `done` byłoby terminalne
       * i zjadłoby późniejsze `backend-restart` z `#finishLaunch`.
       */
      this.#applyTransition(
        session, { type: 'backend-restart' },
        restart.key === key
          ? restartLaunchingDetail(restart.update?.installed)
          : say('restart.failed.panel-gone'),
      );
      return;
    }
    /*
     * Spóźnione `gone` karty, która JUŻ czeka na „Wznów" (nieudany restart): zamknięcie
     * zabrałoby jedyną drogę powrotu do tej rozmowy z telefonu. Klucz zdjęty wyżej wystarczy.
     */
    if (session.state === 'resumable') return;
    /*
     * Claude uruchomiony ręcznie w terminalu Raroga znika z listy razem
     * z procesem, jak wpis Codexa. Klient nie pokazuje takiej karcie ekranu sesji (jej ekranem
     * jest terminal), więc domknięta karta nie miałaby ani transkryptu, ani „Wznów” — zostałby
     * wiersz prowadzący do gołej powłoki. Rozmowę wznawia się tam, gdzie się ją prowadziło
     * (`claude --resume` w terminalu), albo z listy „Wznów” formularza nowej sesji.
     */
    if (session.termId !== undefined) {
      this.#herdrLifecycle.rememberGoneIdle(session);
      this.#applyTransition(session, { type: 'closed' }, HERDR_GONE_DETAIL);
      this.#forgetHerdrSession(session);
      this.#emitSessionsSnapshot();
      return;
    }
    this.#herdrLifecycle.rememberGoneIdle(session);
    this.#applyTransition(session, { type: 'closed' }, HERDR_GONE_DETAIL);
  }

  // --- Kolejka podpięć (5.10: 17 równoległych odczytów historii to skok latencji) ---

  async #attachHerdrDriver(
    supervisor: HerdrSupervisor, session: Session, key: string,
  ): Promise<void> {
    await this.#attach.acquireAttachSlot();
    try {
      // Zanim kolejka do nas doszła, panel mógł zniknąć albo użytkownik mógł ukryć kartę.
      if (this.#sessions.get(session.id) !== session || this.#disposed) return;
      this.#attachDriver(session, supervisor.attach(key));
      await this.#attach.waitForAttach(session);
    } catch (error: unknown) {
      // `attach()` rzuca, gdy panel zniknął między resyncem a podpięciem — to nie jest
      // błąd Raroga, tylko normalne życie terminala.
      console.warn(`rarog: failed to attach pane ${key}: ${describeError(error)}`);
      this.#markStale(session);
    } finally {
      this.#attach.releaseAttachSlot();
    }
  }

  // -------------------------------------------------------------------------
  // Stan, broadcast, zapis
  // -------------------------------------------------------------------------

  /**
   * Jedno zdanie na baner powiadomienia — czego ta sprawa dotyczy.
   *
   * GRANICA PRYWATNOŚCI. Dla spraw blokujących jedzie WYŁĄCZNIE nazwa narzędzia, nigdy
   * `displayText`. Powód jest konkretny: `displayText` to pełna komenda, czyli dokładnie ten
   * string w całym systemie, który najczęściej niesie sekret (`export KEY=…`, `curl -H
   * "Authorization: …"`, treść `.env`). Baner ląduje na ekranie blokady i w historii
   * Notification Center, czytelnych dla postronnych (transport jest szyfrowany, ekran nie),
   * a „Bash" wystarczy, żeby wiedzieć, co czeka — po szczegóły i tak trzeba wejść do apki,
   * gdzie karta zgody pokazuje wszystko.
   *
   * Reszta klas niesie treść, którą hooki wysyłały już wcześniej: zdanie wyniku i tekst błędu.
   */
  #notifyDetail(session: Session, event: SmEvent): AnyText | undefined {
    // Nazwa narzędzia, pytanie i zdanie wyniku pochodzą od agenta (`foreign`); dopisek stanu to zdanie Raroga.
    const agent = (text: string | undefined): ForeignText | undefined => (text === undefined ? undefined : foreign(text));
    switch (event.type) {
      case 'permission-requested':
      case 'agent-blocked': {
        const requests = this.#pending.permissionsFor(session.id);
        return agent(requests[requests.length - 1]?.toolName);
      }
      case 'question-requested': {
        // Pytanie zapasowe karty z ekranu to zdanie Raroga (`questionRef`): jedzie z własnym kodem.
        const question = this.#pending.questionsFor(session.id).at(-1)?.questions[0];
        const own = question?.questionRef === undefined ? undefined : sentenceOfArglessRef(question.questionRef);
        return own ?? agent(question?.question);
      }
      case 'result':
        return event.subtype === 'success' ? agent(session.lastSummary) : pushStateDetail(session.stateDetail);
      case 'limit-reached':
        return pushStateDetail(session.stateDetail);
      case 'agent-idle':
        return agent(session.lastSummary);
      default:
        return undefined;
    }
  }

  /**
   * Jedyne miejsce zmiany stanu sesji.
   *
   * @returns `true`, gdy stan faktycznie się zmienił (i poszedł broadcast `state`).
   */
  #applyTransition(session: Session, event: SmEvent, detail?: OwnText): boolean {
    let next = transition(session.state, event);
    /*
     * Panel z Raroga przed gotowością (`Session.launchPending`) nie wchodzi do stanu wysyłki, bo
     * wiadomość przyjęta przed gotowością trafiłaby w `agent_not_ready`. Ze `starting` to tożsamość: `init`
     * z historii pliku wznawianej rozmowy i `idle`/`working` herdr (model z `init` i tak trafia na kartę).
     * Z dialogu startowego (zaufanie katalogu: `starting → waiting-permission`) karta po jego zamknięciu
     * wraca do `starting`, a nie do `waiting-input`/`running`, bo apka blokuje pole po samym stanie
     * (`sendBlock`). To dalej wstawanie karty, nie koniec tury: „karta wstaje” wraca, a powiadomienie
     * dostaje `afterStart` (bez „gotowe”). Wyjścia bez wysyłki (dialog, porażka, restart backendu) idą jak
     * zwykle. Kartę ze `starting` zdejmuje `#finishLaunch` po gotowości: prompt startowy (`turn-start`) albo
     * tura zerowa. Tożsamość stoi przed zgaszeniem „karta wstaje”: zatrzymane `working` nie zaczęło tury.
     */
    const rewound = session.launchPending && SENDABLE_STATES.includes(next);
    if (rewound) {
      if (session.state === 'starting') return false;
      next = 'starting';
    }
    // Start tury gasi „karta wstaje” PRZED wyjściem przy tożsamości: `working` z herdr albo wysyłka z Raroga
    // do karty, którą `init` z historii pliku przestawił już na `running`, też zaczyna turę.
    if (startsTurn(event)) session.awaitingFirstTurn = false;
    if (rewound) session.awaitingFirstTurn = true;
    if (next === session.state) return false;
    // Koniec tury w rozumieniu managera: sesja wychodzi ze stanów tury (praca albo stojąca
    // decyzja) do dowolnego innego. Po nim rachunek wejść tury liczy się od nowa — niżej.
    const from = session.state;
    const leavesTurn = inTurn(from) && !inTurn(next);
    /*
     * Sesja WSTAJE, a nie kończy tury (`Session.awaitingFirstTurn`): pierwsze wyjście z tury karty, która
     * powstała w `starting`, zanim cokolwiek zaczęło turę. Drogi: pierwsze `idle` panelu zastanego
     * w `unknown`, to samo po `init` z historii pliku (`driver-init`, `starting → running`),
     * i tura zerowa sesji bez promptu (nowa pusta sesja, wznowienie, restart). Sesja z Raroga stoi
     * w `starting` do gotowości panelu (`Session.launchPending`), więc wstaje turą zerową albo promptem;
     * powrót z dialogu startowego do `starting` (`rewound`) też jest wstawaniem. Jedna definicja dla
     * rachunku wiadomości (nie domyka go) i harmonogramu (bez „gotowe”): inaczej „✅ Skończył”
     * z dźwiękiem kafla wychodziłby przed pierwszym promptem.
     */
    const started = rewound || (leavesTurn && (from === 'starting' || session.awaitingFirstTurn));
    if (leavesTurn) session.awaitingFirstTurn = false;
    // Receipt BEFORE the clearing below: no owed `done` push, also after `done → idle` from herdr.
    const resultSeen = session.seen === true;
    /*
     * START TURY zeruje „wynik odebrany". `seen` znaczy „wynik BIEŻĄCEJ
     * tury odebrał człowiek", a nie „panel był kiedyś na wierzchu w herdr": bez tego zerowania
     * znacznik z poprzedniego `idle` przeżyłby całą turę i świeży wynik lądowałby od razu
     * w zwiniętym ogonie „bezczynni".
     *
     * Lista ZDARZEŃ, nie kształt `next`: do `running` prowadzą też `permission-resolved`,
     * `question-resolved` i `driver-init`, a te wracają do tury, która już trwa. Powtórki
     * `agent-working` z resyncu niczego nie ruszają — funkcja wyszła wyżej przy tożsamości.
     * `agent-blocked` jest na liście, choć NIE prowadzi do `running`: stojący dialog znaczy
     * „ktoś przy biurku wznowił turę i agent czeka na decyzję" (komentarz przy
     * `AGENT_BLOCKED_FROM`), a tura zaczęta od dialogu potrafi skończyć się herdrowym `idle`
     * bez ani jednego `working` po drodze — wtedy bez zerowania wynik wpadałby prosto
     * w zwinięty ogon „bezczynni". `resumed` w produkcji dziś nikt nie emituje (`resume()`
     * zakłada nową kartę), ale zostaje, żeby przyszłe wznowienie nie odziedziczyło błędu.
     *
     * Zerowane są WSZYSTKIE TRZY pola odbioru. `herdrSeen` (pamięć badge'a `done`) dlatego,
     * że start tury gasi badge po stronie herdr — `false` sprzed tury zamieniało poturniowe
     * `idle` w fałszywy odbiór, czyli dokładnie w objaw „karty nie widać wcale".
     */
    if (startsTurn(event)) seenMarks.clearReceipt(session);
    seenMarks.carrySeenAcrossTurn(session, event, from, leavesTurn, resultSeen, this.#config.herdrDeps?.seen);
    // Koniec pracy (result / zgoda / interrupt / limit / driver-exit) MUSI zgasić wskaźnik:
    // bez tego telefon zostaje z „uruchamia: Bash" nad sesją, która już nic nie robi.
    if (WORKING_STATES.includes(session.state) && !WORKING_STATES.includes(next)) {
      this.#emitActivity(session, { kind: 'idle' });
    }
    /*
     * Koniec TURY odświeża wiersz gita z pominięciem obu throttle'i. Seria edycji pod koniec
     * tury wpadała w throttle, a wejście w sesję w ciągu 30 s od ostatniego odczytu też:
     * karta „gotowe" pokazywała liczby sprzed ostatnich Editów.
     *
     * Koniec tury = wejście w stan KOŃCOWY (`TURN_END_STATES`) ze stanu, który końcowy nie
     * był. Nie „wyjście z `running`": dialog zgody w środku tury też wychodzi z `running`
     * (do `waiting-permission`), a tura z dwudziestoma zgodami dawałaby dwadzieścia
     * wymuszonych odczytów; z kolei tura kończąca się ze stojącego dialogu (odmowa, Esc)
     * z `running` nie wychodzi wcale. `starting` celowo nie liczy się jako tura — przy
     * starcie Raroga dwadzieścia paneli przechodzi `starting → waiting-input` naraz,
     * a gałąź zasiał już `HerdrLifecycle.herdrAppeared`.
     */
    if (
      session.state !== 'starting'
      && !TURN_END_STATES.includes(session.state)
      && TURN_END_STATES.includes(next)
    ) {
      this.#git.requestGitStatus(session, true);
    }
    // Karty kanału zgód: wejście w stan końcowy tury (także ze `starting`) to koniec tury bez wpisu w transkrypcie.
    // Bez ukrycia i zamknięcia karty (`closed`): ukryty panel pracuje dalej, a zamknięcie z telefonu zgłasza koniec
    // tury samo.
    const consentTurnEnds = event.type !== 'closed'
      && !TURN_END_STATES.includes(session.state) && TURN_END_STATES.includes(next);
    session.state = next;
    if (consentTurnEnds) this.#consentCards.consentTurnEnded(session);
    // Echo odroczone: wyjście z tury (praca ALBO decyzja — karta zgody kolejki nie
    // spłukuje) uzbraja spłukanie, powrót do tury je kasuje.
    if (leavesTurn) heldEcho.armHeldFlush(session, this.#heldEcho);
    else if (inTurn(next)) heldEcho.disarmHeldFlush(session);
    // Sesja domknięta przestaje być pisarzem do swojego pliku jsonl — indeks musi ją puścić,
    // inaczej „Wznów istniejącą" byłoby zablokowane na zawsze przez sesję, która nie żyje.
    if (next === 'done') this.#unindexEngineSession(session);
    session.stateDetail = detail;
    stampState(session, from, this.#iso());
    this.#emitState(session);
    this.#emitSessionChanged(session);
    this.#note(session, event, resultSeen, session.turnInput, started);
    /*
     * PO `#note`: harmonogram ma dostać rachunek tury, która się właśnie skończyła, a następna
     * zaczyna od zera. Zerowanie stoi na KOŃCU tury, nie na jej starcie, bo kolejność „notka
     * z jsonl" i „`working` z herdr" nie jest gwarantowana: notka o postoju przychodzi z pliku
     * od razu, a `working` z herdr dopiero po karencji `HERDR_WORKING_GRACE_MS` (1,5 s). Start
     * tury zerowałby więc wiadomość, która tę turę wywołała.
     */
    if (leavesTurn) {
      // Cisza po samym meldunku o artefakcie stoi na braku narzędzi, a wpis wywołania mógł jeszcze
      // nie dojść z pliku: koniec tury czeka na niego chwilę (`#noteToolCalls`).
      session.quietTurnEnd = toolsDecideSilence(session.turnInput, event)
        ? { event, turn: session.turnInput, atMs: this.#now() } : undefined;
      session.turnInput = nextTurnInput(session.turnInput, started);
    }
    return true;
  }

  /**
   * Wiadomość roli `user` trafiła do sesji — do rachunku przyczyn bieżącej tury.
   *
   * Notka o postoju subagenta (`outcome: 'waiting'`) i notka o końcu obserwacji artefaktu (`kind: 'artifact-watch'`)
   * liczą się osobno od wszystkiego innego: tura, w której od poprzedniego końca tury były
   * WYŁĄCZNIE takie notki, bywa turą bez wyniku i nie daje „gotowe" (`noResultTurn` w `notify/policy.ts` — tam zapada
   * decyzja, tu jest samo liczenie). Rodzaj notki rozpoznaje `notice.ts` z rejestru `CLI_SHAPES`; tu tylko się go
   * czyta. A compaction boundary (`turn-input` of kind compaction) counts the same way; the sum is in
   * `tallyTurnInput` (`state-sentences.ts`).
   *
   * Wołane z trzech miejsc, po jednym na drogę, którą wiadomość `user` wchodzi do rachunku: prompt z Raroga
   * (`sendMessage`), wiadomość z jsonl (prompt z terminala, notka harnessu) i wejście, którego strumień nie niesie jako
   * wiadomości (`turn-input`). Prompt z Raroga liczy się dwa razy, przy wysyłce i przy zapisie w pliku; dla reguły
   * ważne jest tylko, czy „czegoś innego" było zero. Historia NIE liczy się, a rachunek niepełny (`undefined`) zostaje
   * niepełny do końca tury; prompt startowy sesji założonej z Raroga trafia zwykle właśnie w taki, bo jej driver
   * podpiął się chwilę wcześniej.
   */
  #noteTurnInput(session: Session, notice?: TranscriptNotice, compaction = false): void {
    // Wejście następnej tury: to, co przyjdzie po nim z pliku, należy już do niej.
    session.quietTurnEnd = undefined;
    const turn = session.turnInput;
    if (turn !== undefined) session.turnInput = tallyTurnInput(turn, notice, compaction);
  }

  /**
   * Wiadomość głównego agenta z pliku rozmowy (zdarzenie `message` roli `assistant`) — jej bloki
   * `tool-call` do rachunku bieżącej tury.
   *
   * Tura po samym meldunku o artefakcie (albo po samej kompakcji) jest bez wyniku tylko wtedy, gdy agent nie użył
   * w niej żadnego narzędzia (`noResultTurn` w `notify/policy.ts`). Bloki daje import wpisu `assistant`
   * (`assistantBlocksFrom` w `transcript-import.ts`: każdy `tool_use`, wpisy subagentów odpadają), a wpis wywołania
   * stoi w pliku, zanim narzędzie ruszy. Ta sama granica i ta sama niepełność co wiadomości `user`: historia się nie
   * liczy, rachunek niepełny zostaje niepełny.
   *
   * Stać w pliku przed końcem tury to nie to samo co dojść do managera przed nim: plik czyta
   * follower (zwykle 0,1 s po zapisie, po zgubionym zdarzeniu systemu plików do 2 s), a koniec tury melduje herdr,
   * niezależnie. Wywołanie, które przychodzi, zanim bieżący rachunek ma jakiekolwiek wejście, należy więc do tury,
   * która już się skończyła (follower oddaje wpisy w kolejności pliku, a wejście tury stoi w nim przed jej narzędziami)
   * i do bieżącego rachunku nie wchodzi. Gdy tamta tura była cicha tylko dlatego, że narzędzi nie było
   * (`Session.quietTurnEnd`), sesja stoi już poza turą i od końca minęło najwyżej {@link LATE_TOOL_CALL_MS}, manager
   * podaje harmonogramowi jej koniec drugi raz, z poprawionym rachunkiem: zwykłe „gotowe" i zaległość jak po każdej
   * turze z pracą.
   */
  #noteToolCalls(session: Session, blocks: readonly InternalBlock[]): void {
    const turn = session.turnInput;
    if (turn === undefined) return;
    const calls = blocks.filter((block) => block.type === 'tool-call').length;
    if (calls === 0) return;
    if (!noInputYet(turn)) {
      session.turnInput = { ...turn, toolCalls: turn.toolCalls + calls };
      return;
    }
    const quiet = session.quietTurnEnd;
    if (quiet === undefined || inTurn(session.state) || this.#now() - quiet.atMs > LATE_TOOL_CALL_MS) return;
    session.quietTurnEnd = undefined;
    seenMarks.dropCarriedSeen(session, this.#seenMarksDeps());
    this.#config.logger?.(
      `push: ${session.title} — tool call arrived after the turn end that followed an artifact task notification `
      + 'or a context compaction; turn end handed to the scheduler again',
    );
    this.#note(session, quiet.event, false, { ...quiet.turn, toolCalls: quiet.turn.toolCalls + calls });
  }

  /**
   * Zdarzenie → harmonogram powiadomień.
   *
   * Wołane z DWÓCH miejsc, a nie tylko przy FAKTYCZNEJ zmianie stanu: `#applyTransition` wychodzi
   * przed tym blokiem, gdy przejście jest tożsamością — i właśnie takie są `permission-requested`
   * i `question-requested` dla KAŻDEJ sesji herdr: karta powstaje 1–2 s po tym, jak nadzorca
   * wprowadził sesję w `waiting-permission` zdarzeniem `agent-blocked`, a `transition()`
   * prowadzi je wyłącznie z `running`. Bez drugiego miejsca powstanie karty zgody ani pytania nie
   * wywołałoby powiadomienia, a jedyny push (ten z `agent-blocked`) leciałby w chwili, gdy
   * pending jest jeszcze pusty — czyli bez nazwy narzędzia i bez treści pytania; jeśli tamten
   * wyciszyła obecność, sprawa milkłaby na zawsze.
   *
   * Wołane PO `stateDetail`, bo `#notifyDetail` z niego czyta, i celowo bez `await`:
   * kanał jest best-effort i nie ma prawa spowolnić ani wywrócić zmiany stanu.
   *
   * @param started przejście sesji, która wstaje (`started` w `#applyTransition`) — nie koniec tury
   */
  #note(
    session: Session, event: SmEvent, resultSeen = false, turnInput = session.turnInput, started = false,
  ): void {
    const notifier = this.#config.notifier;
    if (notifier === undefined) return;
    const detailText = this.#notifyDetail(session, event);
    notifier.note({
      sessionId: session.id,
      event,
      backgroundTasks: tasksHoldingDonePush(session.backgroundTasks),
      // Subagent w postoju z żywą własną komendą wstrzymuje zaległe „gotowe" po turze z samym
      // postojem; regułę trzyma `notify/policy.ts`.
      ...(waitingOnOwnCommand(session.backgroundTasks) ? { waitingOnOwnCommand: true } : {}),
      // Co wywołało turę: sam meldunek o postoju subagenta nie daje „gotowe". Rachunek
      // niepełny nie jedzie wcale — harmonogram zachowuje się wtedy jak przed tą regułą.
      ...(turnInput === undefined ? {} : { turnInput }),
      // Wynik poprzedniej tury odebrany przed tym przejściem: nie ma zaległego „gotowe".
      ...(resultSeen ? { resultSeen: true } : {}),
      project: session.title,
      ...(session.label === undefined ? {} : { label: session.label }),
      ...(detailText === undefined ? {} : { detail: detailText }),
      // Pierwsze `idle` karty odtworzonej po restarcie herdr to nie koniec tury.
      ...(event.type === 'agent-idle' && this.#herdrLifecycle.restoreQuietLive(session.id)
        ? { afterHerdrRestore: true } : {}),
      // Sesja wstała, żadna tura się nie skończyła: bez „gotowe”.
      ...(started ? { afterStart: true } : {}),
      // Terminal Raroga pod wpisem (także Claude): baner ma
      // prowadzić tam, gdzie prowadzi wiersz listy, a nie na ekran sesji, którego klient nie pokazuje.
      ...(session.termId === undefined ? {} : { termId: session.termId }),
    });
  }

  /**
   * @param at czas wiadomości; brak (albo pusty) = „teraz". Jawny czas podaje wyłącznie import
   *           historii z magazynu CLI — tam wiadomości są sprzed godzin i mają zachować swoje daty.
   */
  #appendMessage(
    session: Session, role: TranscriptMessage['role'], blocks: readonly InternalBlock[], at?: string,
    attachments?: readonly MessageAttachment[], extra: MessageExtra = {},
  ): number {
    const appended = session.appendMessage(
      role, blocks, at !== undefined && at !== '' ? at : this.#iso(), attachments, extra,
    );
    this.#notify(session.id, appended.seq, appended.event);
    return appended.seq;
  }

  // -------------------------------------------------------------------------
  // Prompt zablokowany przez hook `UserPromptSubmit` (`docs/dialogs.md`, „Prompt blocked by a hook”)
  // -------------------------------------------------------------------------

  /**
   * Wysyłka z Raroga — tuż przed `driver.send`: wpis pierścienia `recentSends` (jedyne źródło ładunku
   * ponownej wysyłki), znacznik tury otwartej wysyłką (sesja nie pracowała → nowy; sesja w „pracuje” z żywym
   * znacznikiem, czyli turą, której nic jeszcze nie potwierdziło → dopisanie; inaczej znacznika nie ma), koniec
   * przycisku poprzedniej blokady i koniec karencji po niej.
   */
  #noteSend(
    session: Session, finalText: string, blocks: InternalBlock[], attachments: readonly MessageAttachment[],
  ): void {
    const now = this.#now();
    const key = echoKey(finalText);
    session.recentSends = session.recentSends.filter((send) => now - send.atMs < ECHO_TTL_MS);
    if (key !== '') {
      session.recentSends.push({ key, raw: finalText, blocks, attachments: [...attachments], atMs: now });
      const over = session.recentSends.length - ECHO_WINDOW;
      if (over > 0) session.recentSends.splice(0, over);
    }
    const marker = session.turnOpenedBySend;
    const idle = session.state === 'waiting-input' || session.state === 'starting';
    const unconfirmed = marker !== undefined && session.state === 'running'
      && now - marker.atMs <= PROMPT_BLOCK_MARKER_MS;
    if (key !== '' && idle) session.turnOpenedBySend = { keys: [key], atMs: now };
    else if (key !== '' && unconfirmed) session.turnOpenedBySend = { keys: [...marker.keys, key], atMs: now };
    else session.turnOpenedBySend = undefined;
    session.promptBlocked = undefined;
    session.blockedAtMs = undefined;
  }

  /**
   * Prompt zablokowany przez hook (zdarzenie drivera).
   *
   * Zawsze notka `system` z polem `promptBlocked`: tytuł i powód, a przy blokadzie bez echa wysyłki z Raroga
   * także cytat (prompt z terminala nie ma dymka). Dymka `user` z cytatem nie ma nigdy: prompt z Raroga stoi
   * od wysyłki, a wstrzymany (`token` — obrona; zmierzone: kolejka wpisu blokady nie dostaje)
   * staje tu przed notką.
   *
   * Stan zmienia tylko blokada rozstrzygnięta przez driver (`decided`) wysyłki ze znacznika tury otwartej
   * wysyłką (`turnOpenedBySend`, ten sam klucz, ≤ {@link PROMPT_BLOCK_MARKER_MS}) — znacznik, nie rachunek
   * tury, bo ten po podpięciu drivera i po historii bywa `undefined`. Blokada zdejmuje swój klucz; dopiero gdy
   * znacznik nie ma już żadnej niezamkniętej wysyłki, sesja w `starting`/`running` przechodzi
   * zdarzeniem `prompt-blocked` do `waiting-input`; sesja już w `waiting-input` (herdr `idle` był pierwszy)
   * cofa w harmonogramie koniec tury (`retractTurnEnd`). W obu przypadkach rusza karencja na spóźniony
   * `working` z herdr (`INTERRUPT_WORKING_GRACE_MS`, `blockedAtMs`): herdr miga `working` po wpisie blokady.
   */
  #onPromptBlocked(session: Session, event: Extract<DriverEvent, { type: 'prompt-blocked' }>): void {
    if (session.state === 'done') return;
    if (event.token !== undefined) {
      const held = heldEcho.takeHeld(session, event.token);
      if (held !== undefined) heldEcho.appendHeld(session, held, this.#heldEcho);
    }
    const quote = event.echoed ? undefined : event.prompt;
    // Pole na drut przycięte jak notka: pełny cytat z pliku ominąłby sufit wiadomości.
    const promptBlocked = promptBlockedField(event.reason, quote);
    const blocks: InternalBlock[] = [{ type: 'text', text: promptBlockedText(event.reason, quote) }];
    const seq = this.#appendMessage(session, 'system', blocks, undefined, undefined, { promptBlocked });
    this.#config.logger?.(
      `${PROMPT_BLOCKED_LOG} (session ${session.id}, from Rarog: ${event.echoed ? 'yes' : 'no'})`,
    );
    let moved = false;
    // Blokada promptu spoza Raroga: człowiek przy Macu wysłał coś po naszym prompcie, więc przycisk ponownej
    // wysyłki starego promptu przepada — jak przy wpisie `user` z pliku.
    if (!event.echoed) session.promptBlocked = undefined;
    if (event.echoed && event.decided && event.key !== undefined) {
      const key = event.key;
      const send = session.recentSends.findLast((candidate) => candidate.key === key);
      // Nowy `id` przy każdej blokadzie: `seq` powtarza się po restarcie karty.
      session.promptBlocked = send === undefined
        ? undefined : { seq, id: (this.#config.promptBlockId ?? randomUUID)(), send };
      const marker = session.turnOpenedBySend;
      const live = marker !== undefined && this.#now() - marker.atMs <= PROMPT_BLOCK_MARKER_MS;
      const at = live ? marker.keys.indexOf(key) : -1;
      if (marker !== undefined && at !== -1) {
        const keys = marker.keys.filter((_, index) => index !== at);
        session.turnOpenedBySend = keys.length > 0 ? { keys, atMs: marker.atMs } : undefined;
      }
      if (marker !== undefined && at !== -1 && session.turnOpenedBySend === undefined) {
        session.blockedAtMs = this.#now();
        if (session.state === 'starting' || session.state === 'running') {
          moved = this.#applyTransition(session, { type: 'prompt-blocked' });
        } else if (session.state === 'waiting-input') {
          this.#config.notifier?.retractTurnEnd?.(session.id);
        }
      }
    }
    // Przejście samo rozgłasza kartę; bez niego karta dostaje świeże `lastActivityAt` po notce.
    if (!moved) this.#emitSessionChanged(session);
  }

  /** Karencja po blokadzie hooka albo po przerwaniu: spóźniony `working` z herdr nie wskrzesza „pracuje”. */
  #inWorkingGrace(session: Session): boolean {
    const now = this.#now();
    return (session.interruptedAtMs !== undefined && now - session.interruptedAtMs < INTERRUPT_WORKING_GRACE_MS)
      || (session.blockedAtMs !== undefined && now - session.blockedAtMs < INTERRUPT_WORKING_GRACE_MS);
  }

  // -------------------------------------------------------------------------
  // Command catalog
  // -------------------------------------------------------------------------

  /**
   * Katalog komend sesji dla katalogu panelu i wersji CLI jego procesu. Bez fabryki w zależnościach
   * (testy, demo) — migawka z samego rejestru: dalej allow-lista, tylko bez skilli z dysku.
   */
  #commandCatalog(cwd: string, cliVersion: string | null): CommandCatalog {
    return this.#config.herdrDeps?.commandCatalog?.(cwd, cliVersion) ?? registryCatalog();
  }

  /**
   * Migawka katalogu ŻYWEJ sesji: jej katalog i wersja CLI jej procesu z rejestru CLI. Jedna definicja dla
   * strażnika wysyłki i listy apki ({@link commands}) — wspólna `revision` stoi na tym, że obie biorą ją stąd.
   */
  #sessionCatalog(session: Session): CommandCatalog {
    return this.#commandCatalog(
      session.cwd, runningCliVersion(this.#cli.cliVersion.registry, session.engineSessionId) ?? null,
    );
  }

  /**
   * Bramka tekstu wolnego z wpisem odmowy komendy w dzienniku (`refuse`, `command-not-allowed`).
   * Wpis niesie sam pierwszy token — treść wiadomości nie trafia do dziennika.
   */
  #checkSendable(text: string, key: string | null, cwd: string, opts: SendableOptions): SendableText {
    const deps = this.#requireHerdrDeps();
    try {
      return deps.assertSendable(text, opts);
    } catch (error: unknown) {
      if (error instanceof HerdrCommandRefusedError) {
        this.#config.herdrSupervisor?.logCommandRefusal?.(key, cwd, error.command);
      }
      throw error;
    }
  }

  #expirePending(session: Session, notifyDriver: boolean): void {
    const expired = this.#pending.expireSession(session.id, notifyDriver);
    for (const permId of expired.permIds) {
      // Zbiór kart bez cyfr rośnie razem z kartami — i ma z nimi znikać, żeby nie przeciekał
      // przez cały czas życia procesu.
      this.#undecidable.delete(permId);
      this.#emitSession(session, {
        type: 'permission-resolved',
        sessionId: session.id,
        permId,
        decision: 'expired',
        by: 'system',
      });
    }
    for (const qId of expired.qIds) {
      this.#emitSession(session, { type: 'question-resolved', sessionId: session.id, qId });
    }
  }

  #emitState(session: Session): void {
    const event: ServerEvent = {
      type: 'state',
      sessionId: session.id,
      state: session.state,
      since: session.stateSince,
    };
    // Ten sam helper co `Session.summary()`: token limitu i `ref` zdania w obu ujściach stanu.
    const { stateDetail, stateDetailRef } = wireStateDetail(session.stateDetail);
    if (stateDetail !== undefined) event.detail = stateDetail;
    if (stateDetailRef !== undefined) event.detailRef = stateDetailRef;
    this.#emitBoth(session, event);
  }

  #emitSessionChanged(session: Session): void {
    this.#emitBoth(session, { type: 'session-changed', session: this.#summaryOf(session) });
  }

  /** Event trafia i do strumienia sesji (z `seq`), i do globalnego (bez `seq`). */
  #emitBoth(session: Session, event: ServerEvent): void {
    const seq = session.pushEvent(event);
    this.#notify(session.id, seq, event);
    this.#notify('global', null, event);
  }

  #emitSession(session: Session, event: ServerEvent): void {
    const seq = session.pushEvent(event);
    this.#notify(session.id, seq, event);
  }

  /**
   * Wysyła sygnał aktywności i zapamiętuje go w sesji.
   *
   * Pamięć jest tu po to, żeby telefon podłączający się w ŚRODKU tury dostał aktualny stan
   * w `transcript-snapshot` — eventy `activity` są ulotne i nie ma ich w replayu.
   *
   * Idzie `#emitBoth`, a nie `#emitSession`: LISTA słucha wyłącznie kanału globalnego, więc
   * przy samym strumieniu sesji wiersz pracującej sesji nie miał skąd wiedzieć, CO się dzieje —
   * treść widział tylko ten, kto miał otwarty transkrypt. Ring buffer się nie zmienia:
   * `pushEvent` dalej zwraca `null` dla ulotnych, więc replay po reconnekcie nic nie powtórzy.
   */
  #emitActivity(session: Session, activity: Activity): void {
    // Wskaźnik gaszą DWA niezależne źródła: `result` ze sterownika i wyjście ze stanów żywych
    // w `#applyTransition` (celowo — pas i szelki). Bez tego zamka telefon dostawał dwa
    // identyczne `idle` w tym samym tiku; drugie jest już bez treści, więc go nie wysyłamy.
    if (activity.kind === 'idle' && session.activity === null) return;
    holdActivity(session, activity.kind === 'idle' ? null : activity, this.#now());
    this.#emitBoth(session, { type: 'activity', sessionId: session.id, ...activity });
  }

  #notify(scope: 'global' | string, seq: number | null, event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(scope, seq, event);
      } catch {
        // Zepsuty odbiorca (np. zamknięty strumień SSE) nie może wywrócić managera.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Seedy demo
  // -------------------------------------------------------------------------

  /**
   * Sesje demo — jedyne miejsce, w którym karta powstaje bez udziału herdr.
   *
   * Ziarna niosą historię, wiersz gita i czekającą zgodę, czyli rzeczy, których `HerdrAgent`
   * nie ma i mieć nie może. Driver dla nich daje MOCK NADZORCY (`demo/mock-herdr.ts`) przez
   * `attach(key)` — dzięki temu demo chodzi tą samą ścieżką co produkcja i żaden scenariusz
   * (zgoda, pytanie, limit, błąd, git) nie ginie.
   */
  #applySeeds(): void {
    const supervisor = this.#config.herdrSupervisor;
    const now = this.#now();

    const demo = this.#requireDemo();
    for (const seed of demo.demoSeeds(now)) {
      const session = new Session({
        id: seed.id,
        cwd: seed.cwd,
        title: seed.title,
        // Panel „Raroga" także w demo: dzięki temu da się przeklikać ścieżkę „Zamknij panel"
        // (i jej potwierdzenie), a nie tylko „Ukryj".
        herdrKey: seed.id,
        paneId: `w0:${seed.id}`,
        launchedByRarog: true,
        // Seed niesie gotową etykietę; gdyby jej nie miał, liczymy ją z pierwszego promptu
        // dokładnie tak, jak przy prawdziwym `create()`.
        label: seed.label ?? this.#labelFor(seed.cwd, seedPrompt(seed)),
        state: seed.state,
        ...seedDetailField(seed),
        stateSince: this.#iso(now - seed.stateSinceAgoMs),
        createdAt: this.#iso(now - seed.createdAtAgoMs),
        lastActivityAt: this.#iso(now - seed.lastActivityAgoMs),
        branch: seed.branch,
        dirtyCount: seed.dirtyCount,
        ahead: seed.ahead,
        behind: seed.behind,
        lastSummary: seed.lastSummary,
        model: seed.model,
        effort: seed.effort,
        ultracode: seed.ultracode,
        engineSessionId: seed.engineSessionId,
      });

      for (const message of seed.messages) {
        session.appendMessage(
          message.role, demo.demoBlocks(message.blocks), this.#iso(now - message.agoMs), message.attachments,
          message.notice === undefined ? {} : { notice: message.notice },
        );
      }
      // `appendMessage` przesuwa `lastActivityAt` — seed decyduje o nim sam.
      session.lastActivityAt = this.#iso(now - seed.lastActivityAgoMs);
      this.#sessions.set(session.id, session);
      this.#herdrByKey.set(seed.id, session.id);
      this.#indexEngineSession(session);

      if (seed.live !== undefined && supervisor !== undefined) {
        // Mock nadzorcy zna scenariusz każdego ziarna po jego kluczu — model i effort też
        // stamtąd, żeby pigułka w composerze pokazywała w demo realne warianty.
        this.#attachDriver(session, supervisor.attach(seed.id));
      }

      const permission = seed.permission;
      if (permission !== undefined) {
        const request: PermissionRequest = {
          permId: permission.permId,
          sessionId: session.id,
          toolName: permission.toolName,
          displayText: permission.displayText,
          risk: classifyRisk(permission.displayText, permission.toolName),
          cwd: session.cwd,
          createdAt: this.#iso(now - permission.agoMs),
          subject: permissionSubject(permission.toolName),
          // Ta sama reguła co na żywo — seed z komendą powłoki niesie jej input.
          ...permissionSemantics(permission.input, permission.displayText),
        };
        this.#pending.addPermission(request, async (decision, message) => {
          // Sesja seeda bez drivera nie ma czym wysłać decyzji — `stale` jest tu prawdą
          // (karta nie reprezentuje niczego żywego), a nie odmową do pokazania na ekranie.
          const driver = session.driver;
          if (driver === null) return STALE;
          return driver.respondPermission(permission.permId, decision, message);
        });
        // Do bufora (żeby replay transkryptu był spójny), bez broadcastu — nikt jeszcze nie słucha.
        session.pushEvent({ type: 'permission-pending', request });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drobiazgi
  // -------------------------------------------------------------------------

  #require(id: string): Session {
    const session = this.#sessions.get(id);
    if (session === undefined) throw new NotFoundError(say('rest.session-not-found'));
    return session;
  }

  /**
   * JEDYNE miejsce, w którym etykieta karty sesji herdr powstaje albo się zmienia.
   *
   * Cztery wejścia — `#launch` (nowa sesja z Raroga), `HerdrLifecycle.herdrAppeared` (panel zastany, także po
   * restarcie Raroga), pierwszy prompt po fallbacku `session N` i `title` (auto-tytuł panelu) —
   * idą przez tę metodę, bo etykieta TABA w herdr ma iść za kartą, a piąta droga obok niej
   * zostawiłaby tab ze starą nazwą. Nadzorca dostaje SUROWĄ etykietę karty: czyści ją sam
   * (`sanitizeTabLabel`, ten sam limit co karta), odkłada pracę i sam decyduje o prawie do
   * `tab.rename` — manager nie zna ani etykiet paneli, ani tabów.
   *
   * Etykieta przechodzi `normalizeSessionLabel`: karta i tab mają nieść
   * TEN SAM napis, więc znaki sterujące nie zostają na karcie, a tab nie dostaje osobnego
   * ucięcia. Pusty wynik = nazwa katalogu, jak fallback karty z panelu zastanego.
   *
   * @returns `true`, gdy etykieta karty się zmieniła — tylko wtedy nadzorca dostaje sygnał
   */
  #setLabel(session: Session, raw: string): boolean {
    const clean = normalizeSessionLabel(raw);
    const label = clean === '' ? basename(session.cwd) : clean;
    if (label === session.label) return false;
    session.label = label;
    const key = session.herdrKey;
    if (key !== undefined) this.#config.herdrSupervisor?.syncTabLabel?.(key, label);
    return true;
  }

  /**
   * Etykieta nowej sesji: słowa promptu albo kolejne `session N` w tym katalogu.
   *
   * Numerację liczymy po WSZYSTKICH sesjach projektu — także zamkniętych i wznawialnych —
   * bo one nadal zajmują swój numer (spec: zamknięcie środkowej nie przenumerowuje reszty).
   */
  #labelFor(cwd: string, prompt: string | null): string {
    if (prompt !== null) {
      const fromPrompt = labelFromPrompt(prompt);
      if (fromPrompt !== null) return fromPrompt;
    }
    const inProject = [...this.#sessions.values()]
      .filter((session) => session.cwd === cwd)
      .map((session) => session.label);
    return nextFallbackLabel(inProject);
  }

  /**
   * Druga linia obrony dla allow-listy katalogów (pierwsza jest w routerze).
   *
   * Przechodzi katalog z listy projektów ALBO — poza demo — istniejący podkatalog korzenia
   * (`RAROG_PROJECT_ROOTS`), bo formularz pozwala wpisać „inną ścieżkę". Świadomie
   * fail-closed: pusta allow-lista i brak korzeni = nie da się założyć sesji nigdzie.
   */
  #assertAllowedCwd(cwd: string): void {
    if (this.projects().some((project) => project.path === cwd)) return;
    if (!this.#config.demo) {
      const check = validateProjectCwd(cwd, this.#roots());
      if (check.ok) return;
      throw new BadRequestError(cwdDeniedSentence(cwd, check.sentence));
    }
    throw new BadRequestError(say('session.cwd-outside-allow-list', { cwd }));
  }

  /**
   * `bypassPermissions` wyłącza `canUseTool`, czyli JEDYNĄ granicę bezpieczeństwa Raroga
   * (risk.ts: „granicą bezpieczeństwa jest zgoda użytkownika na KAŻDE użycie narzędzia").
   * Wolno go włączyć wyłącznie w katalogu z `RAROG_YOLO_ROOTS` — brak listy = nigdzie.
   */
  #assertPermissionMode(cwd: string, mode: string | undefined): void {
    if (mode !== 'bypassPermissions') return;
    const roots = this.#config.yoloRoots ?? [];
    if (this.#inYolo(cwd, roots)) return;
    throw new BadRequestError(
      say('session.bypass-outside-yolo-roots'),
    );
  }

  /**
   * Bramki yolo liczą przynależność po REALPATH (`SessionManagerConfig.realPath`) —
   * dowiązanie wewnątrz yolo-roota wskazujące na cudze repo nie jest yolo, choć
   * leksykalnie leży „w środku". Fail-closed: ścieżka nie do rozwiązania odpada.
   */
  #inYolo(cwd: string, roots: readonly string[]): boolean {
    const realPath = this.#config.realPath;
    return realPath === undefined
      ? isInsideAnyRootReal(cwd, roots)
      : isInsideAnyRootReal(cwd, roots, realPath);
  }

  #iso(ms: number = this.#now()): string {
    return new Date(ms).toISOString();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Przedmiot zgody: wyjście z trybu planu albo zwykłe narzędzie. Jedyne miejsce, w którym
 * nazwa `ExitPlanMode` staje się faktem dla klienta — telefon buduje kartę planu z pola
 * `subject`, a nazwy narzędzia CLI nie zna.
 */
export function permissionSubject(toolName: string): PermissionSubject {
  return toolName === EXIT_PLAN_MODE_TOOL ? 'plan' : 'tool';
}

/**
 * Rola KAŻDEJ opcji na karcie pytania — serwer nadaje ją zawsze.
 *
 * Klasyfikację po brzmieniu chrome CLI robi driver (`optionRole` w `herdr/dialogs/cards/roles.ts`),
 * bo tylko on wie, które opcje przyszły z EKRANU, a które z payloadu autora. Tutaj zostaje
 * domknięcie kontraktu: opcja bez roli (mock-driver, payload) to zwykła odpowiedź — tak samo
 * czyta brak pola klient.
 */
function withOptionRoles(questions: readonly Question[]): Question[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option) => (
      option.role === undefined ? { ...option, role: 'answer' as const } : option
    )),
  }));
}

/**
 * Czy model wolno podać we fladze `--model`?
 *
 * Jedynym źródłem prawdy jest lista wbudowana: silnika nie ma o co zapytać, a każdy string
 * spoza niej trafiłby do argv procesu uruchamianego na Macu.
 */
export function isKnownModel(model: string): boolean {
  return FALLBACK_MODEL_CHOICES.some((choice) => choice.value === model);
}

/** Prompt startowy, który czeka na koniec dialogu startowego (`#awaitStartReady`); `display` jak w `LaunchOptions`. */
interface StartWait {
  prompt: string;
  display: PromptDisplay | undefined;
  settle(ready: boolean): void;
}

/**
 * Komendy sterujące dla `POST /api/sessions/:id/model`.
 *
 * Osobna, czysta funkcja, bo to jest JEDYNE miejsce w Rarogu, w którym powstaje tekst
 * `/model …` — i chcemy je mieć pod testem bez managera. Kolejność jest istotna: `/model`
 * przestawia model i otwiera dialog potwierdzenia, więc `/effort` musi iść PO nim (inaczej
 * trafiłby w otwarty dialog).
 *
 * `model: ''` znaczy „model domyślny konta" (pierwsza pozycja listy) i NIE jest komendą —
 * `/model` bez argumentu otwiera w CLI interaktywny wybór, czyli dialog, którego Rarog nie
 * umie obsłużyć. Puste wejście daje pustą listę i 400 u wołającego.
 *
 * Komenda ultracode idzie NA KOŃCU, z form rejestru (`ULTRACODE_COMMANDS`): od 2.1.284 wybór poziomu
 * ultracode nie wyłącza, ale CLI starsze robiło to przy `/effort <poziom>`, więc ostatnie słowo ma przełącznik.
 */
export function modelCommands(
  patch: { model?: string; effort?: EffortLevel | null; ultracode?: boolean },
): string[] {
  const commands: string[] = [];
  if (patch.model !== undefined && patch.model !== '') commands.push(`/model ${patch.model}`);
  // `effort: null` = „wróć do domyślnego": Rarog nie wysyła na to komendy. Docs (`model-config.md`,
  // „Set the effort level”): goły `/effort` otwiera suwak (dialog), a `/effort auto`
  // czyści zapisany poziom aktywnego modelu; czy Rarog ma je wysyłać, czeka na decyzję. Kasowanie
  // effortu zostaje przy zakładaniu nowej sesji.
  if (patch.effort !== undefined && patch.effort !== null) {
    commands.push(`/effort ${patch.effort}`);
  }
  if (patch.ultracode !== undefined) commands.push(patch.ultracode ? ULTRACODE_COMMANDS.on : ULTRACODE_COMMANDS.off);
  return commands;
}

/** Pierwszy prompt użytkownika z seeda demo (do etykiety) albo `null`, gdy seed go nie ma. */
function seedPrompt(seed: DemoSeed): string | null {
  for (const message of seed.messages) {
    // Notka harnessu nie jest promptem człowieka — rola efektywna, nie `role`.
    if (message.role !== 'user' || message.notice !== undefined) continue;
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.trim() !== '') return block.text;
    }
  }
  return null;
}

/**
 * Tekst, na którym liczymy ryzyko prośby o zgodę.
 *
 * Bierzemy PEŁNY input narzędzia, a nie `displayText` — ten drugi jest przycięty do limitu
 * prezentacji, więc czerwona fraza za progiem byłaby dla klasyfikatora niewidzialna.
 * `displayText` dokładamy obok, bo drivery bez ustrukturyzowanego
 * inputu (mock, seedy) niosą treść wyłącznie tam. Klasyfikator jest OR-em po regułach,
 * więc szersze wejście może tylko dodać czerwoności — nigdy jej nie ująć.
 */
function riskSource(event: { toolName: string; input: unknown; displayText: string }): string {
  return `${event.displayText}\n${toolInputText(event.toolName, event.input)}`;
}

/** `DriverEvent` aktywności → sam ładunek protokołu (bez dyskryminatora). */
function activityOf(event: Extract<DriverEvent, { type: 'activity' }>): Activity {
  const { type: _type, ...activity } = event;
  return activity;
}

/**
 * Bloki wiadomości użytkownika: SAM TEKST.
 *
 * Bajtów załącznika tu nie ma i nie będzie. Wcześniej każdy obrazek wchodził tu jako blok
 * `image` z pełnym `dataUrl` — do 5 × 1,5 MB na wiadomość, mimo że plik leżał już
 * w `.rarog-uploads` — a `transcript-snapshot` z tego RAM-u leci na telefon przy każdym
 * wejściu w transkrypt. Wizytówki załączników (nazwa, waga, mime) jadą osobnym polem
 * `TranscriptMessage.attachments` (`messageAttachments` w protokole).
 *
 * Pusty tekst z załącznikami NIE dostaje pustego bloku tekstowego — inaczej transkrypt
 * pokazywałby pustą linię nad chipami. Wiadomość bez niczego zostaje pustym tekstem,
 * żeby tura użytkownika była widoczna w historii.
 */
export function userBlocks(text: string, attachments?: readonly MessageAttachment[]): InternalBlock[] {
  if (text === '' && attachments !== undefined && attachments.length > 0) return [];
  // Zdanie człowieka: treść obca (`foreign`), nigdy nie dostaje kodu.
  return [{ type: 'text', text: foreign(text) }];
}

/** Tekst bloków dymka (bez obrazków i wywołań); pusty = `null` — źródło etykiety karty. */
function textOfBlocks(blocks: readonly InternalBlock[]): string | null {
  const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text.text] : [])).join('\n');
  return text === '' ? null : text;
}

/**
 * Dokleja do wizytówek ZDJĘĆ nazwę pliku z `.rarog-uploads/` — klucz miniatury z serwera.
 *
 * Sama NAZWA (`basename`), nigdy ścieżka: katalog zna serwer z `cwd` sesji, a transkrypt jedzie
 * na telefon i do cache'u klienta (`docs/security-model.md`, „herdr sessions”, reguła 12). Zdjęcia idą w tej samej
 * kolejności co `imagePaths` (`write` oddaje ścieżki w kolejności wejścia), pliki zostają bez
 * `file` — Rarog serwuje wyłącznie własne zdjęcia, nie cudze PDF-y.
 */
export function withUploadFiles(
  attachments: readonly MessageAttachment[], imagePaths: readonly string[],
): MessageAttachment[] {
  let imageIndex = 0;
  return attachments.map((attachment) => {
    if (attachment.kind !== 'image') return attachment;
    const path = imagePaths[imageIndex];
    imageIndex += 1;
    return path === undefined ? attachment : { ...attachment, file: basename(path) };
  });
}

/**
 * Buduje manager. Zwrócony obiekt spełnia `ManagerApi` (kontrakt dla routera) i dokłada `ready`,
 * `flush()` oraz `dispose()`.
 *
 * Funkcja jest asynchroniczna z jednego powodu: w trybie demo dociąga mock-driver i seedy
 * dynamicznym importem, żeby proces produkcyjny nigdy ich nie wczytał. Poza demo nie ma tu
 * żadnego I/O — `await` kosztuje jeden mikrotask.
 */
export async function createManager(config: ManagerConfig): Promise<Manager> {
  const content = config.demo ? config.demoContent : undefined;
  // Demo bez zestawu to błąd składania: domyślnego języka treści nie ma.
  if (config.demo && content === undefined) throw new Error('createManager: demo mode requires demoContent');
  const demo = content === undefined ? null : await loadDemoModules(content);
  /*
   * Demo bez nadzorcy dostaje MOCK NADZORCY, a nie drugą ścieżkę sesji („Demo mode (mock-driver + seeds)” w `docs/implementation-spec.md`).
   *
   * Po wycięciu SDK jedyną drogą, którą sesja dostaje drivera, jest `supervisor.attach()`.
   * Gdyby demo miało tu własny wyjątek, testowałoby kod, którego w produkcji nie ma — czyli
   * dokładnie tę klasę błędu, którą cały ten plan usuwa.
   */
  if (content !== undefined && config.herdrSupervisor === undefined) {
    const mock = (await import('../demo/mock-herdr.ts')).createMockHerdr(content);
    return new RarogManager(
      { ...config, herdrSupervisor: mock.supervisor, herdrDeps: mock.deps }, demo,
    );
  }
  return new RarogManager(config, demo);
}
