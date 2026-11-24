/**
 * `SessionDriver` przypięty do ŻYWEGO panelu `claude` w herdr.
 *
 * Sklejamy tu TRZY źródła, bo żadne samo nie wystarcza:
 *
 * - **herdr (uchwyt agenta)** wie, czy panel pracuje i czy CZEKA — w pliku jest wtedy cisza,
 * - **jsonl (follower)** wie, co dokładnie czeka: pełny `tool_input`, model, effort, zużycie
 *   okna i treść rozmowy — czego ekran, przycięty do szerokości panelu, nie odda,
 * - **ekran (`agent.read`)** wie jako jedyny, KTÓRA CYFRA odpowiada której opcji — i tego
 *   w jsonl nie ma i nie będzie.
 *
 * Podział ról jest twardy: **treść karty z jsonl, cyfry z ekranu, rozjazd = fail-closed**.
 * Kiedy ekran i plik mówią o różnych narzędziach, karta traci przyciski zatwierdzania i zostaje
 * przy „Odrzuć (Esc)" — bo dokładnie w takiej sytuacji nie wiadomo, co by się zatwierdziło.
 *
 * ZASADA NADRZĘDNA: `ownsProcess = false`. Proces po drugiej stronie należy do użytkownika i żyje
 * w jego terminalu. Rarog go OGLĄDA i, w wąskim zakresie, do niego PISZE — nigdy nie zamyka,
 * nie restartuje i nie przerywa przy sprzątaniu. Najważniejsza linia w całym module to ta, której
 * tu NIE MA: `dispose()` nie wysyła do herdr ani jednego bajtu (test `herdr-driver.test.ts`
 * pilnuje tego licznikiem wywołań, bo `dispose()` managera leci przy każdym SIGTERM — czyli przy
 * każdym deployu Raroga, dla WSZYSTKICH paneli naraz).
 *
 * Podział pracy z managerem: walidacja jest SYNCHRONICZNA i robi ją manager PRZED
 * przejściem stanu (400/429 ma wrócić jako odpowiedź na POST, a nie jako wiadomość w transkrypcie).
 * Driver dostaje tekst gotowy — ale i tak przepuszcza go przez `guard`, jeśli go dostał: strażnik
 * jest idempotentny (tekst po sanityzacji przechodzi własne reguły bez zmian), a cena pominięcia
 * to `/hooks` wpisane w cudzy panel. `send()` jest z kontraktu `void`, więc błędy z gniazda
 * raportujemy strumieniem, nigdy wyjątkiem.
 */
import type { ContextLimitState, FileAttachment, HerdrMode } from '@rarog/shared';
import type { MessageSource, ServerSystem } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import type { OwnText } from '@rarog/shared/sentences';
import {
  HERDR_BLOCKED_POLL_MS, HERDR_CONSENT_CARD_WAIT_MS, HERDR_PENDING_DEBOUNCE_MS,
  HERDR_PENDING_RETRY_MS, HERDR_SCREEN_CACHE_MS, HERDR_STALL_SETTLE_MS, HERDR_TURN_WATCHDOG_MS,
} from '../config.ts';
import type {
  BlockedLeftoverClear, CliProcessStart, DecisionOutcome, DriverEvent, HeldLeftover, HeldLeftoverItem, InternalBlock,
  QueueTakeBackResult, RestartProbe, SendCommand, SendOptions, SessionDriver,
} from './types.ts';
import { APPLIED, STALE, refused } from './types.ts';
import { AsyncEventQueue, systemScheduler } from './runtime.ts';
import type { Scheduler, TimerHandle } from './runtime.ts';
import type {
  HerdrAgentHandle, HerdrAgentStatus, HerdrClient, HerdrEngine, HerdrPaneEvent,
} from '../herdr/types.ts';
import { HerdrOutOfScopeError, reasonOfError } from '../herdr/types.ts';
import type { FollowEvent, JsonlFollower } from '../herdr/jsonl-follow.ts';
import { echoKey } from '../herdr/jsonl-follow.ts';
import { withoutCommandOutput } from '../herdr/history-steps.ts';
import type { PulseSample, SessionPulse } from '../herdr/session-pulse.ts';
import {
  PULL_REQUESTS_POLL_MS, SCHEDULED_TASKS_POLL_MS, TASKS_POLL_MS, createAgentFileReader, createPullRequestFilesReader,
  createScheduledTaskFileReader, createTasksState, createWorkflowRunReader, forgetSession, noteTasks, phaseCounts, runName,
  stopTasks,
} from '../herdr/background/index.ts';
import type {
  AgentFileReader, PullRequestFilesReader, PullRequestFilesReaderOptions, ScheduledTaskFileReader,
  ScheduledTaskFileReaderOptions, TasksDeps, TasksState, WorkflowRunReader,
} from '../herdr/background/index.ts';
import {
  BLOCKED_INTERRUPT_MESSAGE, BLOCKED_SEND_MESSAGE, CLI_DIALOG_SEND_MESSAGE, COMPOSER_CLEAR_ATTEMPTS,
  CONSENT_DIALOG_SEND_MESSAGE, ESC_SETTLE_MS, FORM_STANDS_SEND_MESSAGE,
  GONE_INTERRUPT_MESSAGE, INTERRUPT_DONE_MESSAGE, INTERRUPT_PROBE_DELAYS_MS, IN_TURN_COMMAND_ECHO_MS,
  MODEL_CONFIRM_ATTEMPTS, MODEL_CONFIRM_POLL_MS, READ_ONLY_INTERRUPT_MESSAGE, READ_ONLY_MESSAGE,
  RESTART_EXIT_COMMAND, STALLED_PROMPT_MESSAGE, commandDialogMatches, commandOutcomeLogLine, commandRefusedInline,
  commandResultInline, composerRegionState, composerRegionText, composerStateFrom, confirmModelSwitch,
  modelOutcomeMessage, modelSetEvent, screenHoldsNeedle, squashWhitespace, ultracodeCommandValue,
} from './herdr/commands.ts';
import type { ModelCommandOutcome } from './herdr/commands.ts';
import { HerdrCommandRefusedError, registryCatalog, sameSlash, silentInTurn } from '../herdr/commands/index.ts';
import type { CommandCatalog, SendableText, SlashCommand } from '../herdr/commands/index.ts';
import {
  NO_TRANSCRIPT_MESSAGE, createPulseEcho, metaInitEvent, openFollower, openPulse, pulseActivity,
  resetPulseEcho,
} from './herdr/transcript.ts';
import type { FollowerFactory, PulseFactory } from './herdr/transcript.ts';
import { createPullRequestPollState, schedulePullRequests } from './herdr/pull-request-poll.ts';
import type { PullRequestPollDeps, PullRequestPollState } from './herdr/pull-request-poll.ts';
import * as crons from './herdr/scheduled-task-poll.ts';
import { cliWaitsForPermission, noteConsentRegistryRead } from './herdr/consent-registry-read.ts';
import { PromptQueue, promptEntry } from './herdr/prompt-queue.ts';
import type { PromptQueueDeps, PromptQueuePort, SendTicket } from './herdr/prompt-queue.ts';
import { QueueTakeBack } from './herdr/queue-take-back.ts';
import type { QueueTakeBackDeps, QueueTakeBackPort } from './herdr/queue-take-back.ts';
import { ReturnedPrompt, type ReturnedPromptDeps } from './herdr/returned-prompt.ts';
import { TurnGuard } from './herdr/turn-guard.ts';
import type { TurnGuardPort } from './herdr/turn-guard.ts';
import { FormReserve } from './herdr/form-reserve.ts';
import type { FormReservePort } from './herdr/form-reserve.ts';
import { CliReserve } from './herdr/cli-reserve.ts';
import type { CliReservePort } from './herdr/cli-reserve.ts';
import { CommandDialogSettle } from './herdr/command-dialog-settle.ts';
import { ConsentChannel } from './herdr/consent-channel.ts';
import { ConsentNoHook } from './herdr/consent-no-hook.ts';
import type { ConsentNoHookSources } from './herdr/consent-no-hook.ts';
import type { ConsentObserveRequest } from './herdr/consent-channel.ts';
import { Layer2Cards, isLayer2Id, layer2HoldsKeys } from './herdr/layer2-card.ts';
import type { Layer2CardPort } from './herdr/layer2-card.ts';
import { Layer2Step } from './herdr/layer2-step.ts';
import type { Layer2Key, Layer2StepEntry, Layer2StepPort } from './herdr/layer2-step.ts';
import {
  approveContext, auditRefusal, layer2KeyRefusal, refuseDecision, refuseNote, refuseSend, reportStaleDecision,
} from './herdr/refusals.ts';
import type { RefusalPort } from './herdr/refusals.ts';
import {
  ANSWERED_HOOK_SHIELD_MS, CLI_WAITING_PROBES, DECIDED_SHIELD_MS,
  FORM_SUBMIT_CONFIRM_DELAY_MS, FORM_SUBMIT_GONE_MESSAGE, FORM_SUBMIT_KEY,
  HOOK_ANSWER_POLL_MS, HOOK_ANSWER_WAIT_MS, HOOK_PERMISSION_REQUEST_EVENT, MULTI_SELECT_MESSAGE,
  NOTE_NOT_ALLOWED_MESSAGE, NOTE_NO_CHANNEL_MESSAGE, NOTE_WRITE_FAILED_MESSAGE, NO_ANSWER_ON_SCREEN_MESSAGE,
  NO_DIGIT_MESSAGE, PAUSE_ESCAPE_MESSAGE, SCREEN_ANSWER_REARM_DELAYS_MS, SCREEN_CHANGED_MESSAGE, SCREEN_DIALOG_TOOL,
  TERMINAL_DIALOG_MESSAGE, TERMINAL_ONLY_MESSAGE, affirmativeOption, alwaysOption,
  admittedHook, applyMultiSelectOverride, blockCardRecord, confirmFormSubmit,
  decideCard, dialogShapeOf, measuredConsentHolds,
  evaluationReqId, fallbackSnippet, formSubmitAbortMessage, hookAnnotations, hookAnswerPartialMessage,
  besideAtDecision, hookPendingFor, hookPendingFrom, noteNotDeliveredMessage, optionPolicy, otherDialogDump,
  screenAnswerIndex,
  screenDialogCard, screenFormReqId, staleDumpProvesOther,
} from '../herdr/dialogs/index.ts';
import type {
  ActiveReq, CardOrigin, DecideAction, DecideInput, DecidedShield, DecisionCard, HookAnswerChannel,
  HookAnswerTarget, PendingHookTool, RefusalDumper,
} from '../herdr/dialogs/index.ts';
import type { JsonlMeta, PendingTool } from '../herdr/jsonl-pending.ts';
import type {
  AnswerShape, AuditCaseShape, AuditOnlyRefuseReason, HerdrRefuseReason,
} from '../herdr/audit.ts';
import { shadowAuditFields } from '../herdr/audit.ts';
import { diagnosisFields, originFields } from './herdr/audit-fields.ts';
import {
  ASK_USER_QUESTION_TOOL, SANDBOX_NETWORK_TOOL, SESSION_PAUSED_DIALOG, canonicalLabel, exitDialogTasks,
  matchKnownDialog, parseOptions, resolveOptions, sameDialogIdentity, sessionPausedDialog, standingConsentDialog,
} from '../herdr/dialogs/index.ts';
import { SHADOW_DEADLINE_MS, registryEvidenceFromSignal, shadowCardEligible } from '../herdr/dialogs/index.ts';
import type {
  DecisionResolution, DialogIdentityStamp, ExpectedDecision, KnownDialogId, Layer2Mark, ScreenConsentDialogId,
  ScreenDialog, ScreenOption, ShadowConsentChannel, ShadowOutcome,
} from '../herdr/dialogs/index.ts';
import type { ConsentEffectiveMode } from '../herdr/dialogs/layer1/mode.ts';
import type { ConsentDeskRelease } from '../herdr/dialogs/index.ts';
import { consentDigitRefused, consentModeNow, consentOnlyEvent } from '../herdr/dialogs/index.ts';
import { collapseFooterMode, parseModeFooter } from '../herdr/dialogs/screen/mode-footer.ts';
import type { HerdrFooterMode } from '../herdr/dialogs/screen/mode-footer.ts';
import { TRUST_DOWN_KEY, TRUST_ENTER_KEY, nextTrustStep } from '../herdr/dialogs/send/trust-step.ts';
import type { TrustStepVerdict } from '../herdr/dialogs/send/trust-step.ts';
import type { TrustArrowMark } from '../herdr/dialogs/cards/build.ts';
import os from 'node:os';
import {
  MODE_CYCLE_KEY, MODE_CYCLE_SETTLE_MS, modeCycleDoneMessage, modeCycleStoppedMessage,
  nextModeCycleStep,
} from '../herdr/mode-cycle.ts';
import type { ModeCycleTarget } from '../herdr/mode-cycle.ts';
import { UploadError, appendAttachmentPaths } from '../herdr/uploads.ts';
import type { HerdrUploads } from '../herdr/uploads.ts';
import type { CliDialogClass, CliWaitingSignal } from '../cli-version.ts';
import { serverSystem } from '../version.ts';

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

/**
 * Ile czekamy, zanim ze stanu herdr i z czekającego narzędzia z jsonl ulepimy kartę decyzji.
 *
 * Oba źródła opisują ten sam moment, ale przychodzą osobno i rozjeżdżają się o ~0,5 s
 * (zmierzone): herdr wykrywa `blocked` z EKRANU, a wpis `tool_use` ląduje w pliku wtedy, gdy
 * silnik go zapisze. Krótszy debounce (300 ms z v1) degradowałby kartę do „Odrzuć" regularnie,
 * bo w chwili odczytu jedno ze źródeł jeszcze nic nie wie.
 *
 * Wartości (razem z `HERDR_PENDING_RETRY_MS` — jednym i tylko jednym ponowieniem odczytu
 * ekranu przed spadkiem na fail-closed) mieszkają w `config.ts`, w jednym miejscu na liczby
 * z „Configuration (`server/src/config.ts`)” w `docs/implementation-spec.md`; tu są reeksportowane,
 * bo to driver je STOSUJE i to jego testy je skracają.
 */
export {
  HERDR_BLOCKED_POLL_MS, HERDR_PENDING_DEBOUNCE_MS, HERDR_PENDING_RETRY_MS, HERDR_SCREEN_CACHE_MS,
} from '../config.ts';

// ---------------------------------------------------------------------------
// Zależności wstrzykiwane (styk z modułami S-herdr)
// ---------------------------------------------------------------------------

/**
 * Jeden wpis dziennika wysyłek. Pełny tekst skraca `herdr/audit.ts` (sha256 + 200 znaków).
 *
 * Pola KSZTAŁTU przypadku (`AuditCaseShape`: `reqId`, `source`, identyfikatory wywołania, podpowód,
 * liczba opcji, nagłówek, wiersze panelu) niosą wpisy `approve`, `degrade` i `refuse`.
 */
export interface HerdrAuditEntry extends AuditCaseShape {
  at: string;
  sessionId?: string;
  key: string;
  paneId: string;
  cwd: string;
  /**
   * `model_change` jest osobną metodą, a nie `prompt` z flagą: po kradzieży telefonu
   * pytanie „czy ktoś przestawił model konta" ma mieć własny grep, a nie tonąć wśród zdań
   * użytkownika. Wpisy są dwa — wysłana komenda i zatwierdzająca ją cyfra.
   *
   * `answer-hook` to odpowiedź oddana KANAŁEM HOOKA, a nie cyfrą: żaden klawisz
   * nie poszedł, ale sesja dostała treść — bez własnej metody ta droga byłaby w dzienniku
   * niewidoczna.
   *
   * `refuse` jest odwrotnością reszty: to jedyna metoda, przy której do panelu NIE
   * poszedł ani jeden bajt. Wpisy odmów są całą odpowiedzią na pytanie „czy ścieżka cyfrowa
   * realnie zawodzi" — bez nich dziennik ma same wysyłki i zero danych o porażkach.
   *
   * `block-card` to karta zbudowana z samego ekranu („karta bloku wystawiona”): odcisk, kształt ekranu i werdykt
   * polityki, bez treści (`blockCardRecord` w `herdr/dialogs/cards/build.ts`).
   */
  method: 'prompt' | 'send_keys' | 'approve' | 'model_change' | 'answer-hook' | 'refuse' | 'degrade' | 'block-card'
  | 'layer2-episode' | 'layer2-verify';
  mode: HerdrMode;
  keys?: readonly string[];
  text?: string;
  /** Dla `refuse`/`degrade`: powód z zamkniętej listy — wpisy mają się sumować, nie opisywać. */
  reason?: HerdrRefuseReason | AuditOnlyRefuseReason;
  /** Dla `refuse` z `command-not-allowed`: sam pierwszy token odrzuconego tekstu. */
  command?: string;
  /** Dla `refuse` z odpowiedzi na pytanie: kształt odpowiedzi bez treści. */
  shape?: AnswerShape;
  /**
   * Co dokładnie zatwierdziła wysłana cyfra („Starting sessions from the phone: three powers” w `docs/security-model.md`).
   *
   * Dziennik ma odpowiadać na pytanie „co zatwierdzono", a nie „jaką cyfrę wysłano": `['1']`
   * bez kontekstu nie mówi nic, a `Bash` + `Yes` mówi wszystko. Pola są opcjonalne, bo niosą
   * je wyłącznie wpisy decyzji.
   */
  toolName?: string;
  optionLabel?: string;
  /**
   * Dla `approve`, `degrade` i `refuse` z kartą: klasa dialogu z rejestru sesji CLI, gdy w chwili wpisu
   * mówił `waiting` — suma odmów (`summarizeDegradeShapes` w `herdr/audit.ts`) ma z czego powiedzieć,
   * JAKICH dialogów Rarog nie czyta, a wpis decyzji — przy jakiej klasie poszła cyfra.
   */
  cliDialog?: CliDialogClass;
  /** Dla `answer-hook`: ile notatek pojechało w `annotations` — liczba, bez treści. */
  notes?: number;
  /** For `prompt`: who sent the message (`MessageBody.source`); absent = a message as any other. */
  sender?: MessageSource;
}

/** Append-only dziennik wszystkiego, co Rarog WYSŁAŁ do cudzego panelu. */
export interface HerdrAuditLog {
  log(entry: HerdrAuditEntry): void;
}

/** Część wpisu dziennika, którą zna miejsce wysyłki (reszta jest stała dla drivera). */
type AuditDetails = Pick<
  HerdrAuditEntry,
  'method' | 'keys' | 'text' | 'toolName' | 'optionLabel' | 'reason' | 'shape' | 'cliDialog'
  | 'notes' | 'command' | 'sender'
> & AuditCaseShape;

/**
 * Czego dotyczy nieudana mutacja — rozróżnienie potrzebne WYŁĄCZNIE zdaniom o błędzie.
 * Wszystkie pozostałe skutki (`detached`, wejście w `blocked`, dziennik) są dla obu takie same.
 */
type SendOp = 'message' | 'interrupt';

/**
 * `assertSendable` z `herdr/commands/guard.ts`: zwraca tekst po sanityzacji z klasyfikacją komendy
 * wobec katalogu sesji albo rzuca.
 */
export type PromptGuard = (
  text: string,
  opts: { mode: HerdrMode; cwd: string; yoloRoots: readonly string[]; catalog: CommandCatalog },
) => SendableText;

/**
 * `snippet` z `herdr/dialogs/screen/`: wycinek dialogu na KARTĘ.
 *
 * `hash` został w kontrakcie, choć nikt go tu nie czyta: służył deduplikacji
 * wycinków dopisywanych do transkryptu, a wycinek jest dziś polem karty i żyje tak długo,
 * jak ona. Zdejmowanie pola z funkcji w `herdr/dialogs/screen/` byłoby zmianą jej kontraktu
 * wyłącznie dla estetyki tej deklaracji.
 */
export type ScreenSnippet = (text: string) => { text: string; hash: string } | null;

/**
 * `resolveOptions` z `herdr/dialogs/screen/`: cross-check EKRANU z JSONL.
 *
 * Wstrzykiwane, choć domyślnie wskazuje na prawdziwą implementację — to jest jedyna funkcja
 * w tym pliku, której wynik decyduje o tym, czy karta dostanie przyciski, więc test musi umieć
 * podstawić za nią rozjazd i nieczytelny ekran bez budowania całego ekranu terminala.
 */
export type OptionResolver = (
  screenText: string, expected: ExpectedDecision | null,
) => DecisionResolution;

/** The channel observation's subagent pace and its input live in `drivers/herdr/consent-channel.ts`. */
export { CONSENT_SUBAGENT_OBSERVE_MS } from './herdr/consent-channel.ts';
export type { ConsentObserveRequest } from './herdr/consent-channel.ts';

export interface HerdrDriverDeps extends Pick<PromptQueueDeps, 'promptStore'>, Pick<QueueTakeBackDeps, 'takeBackPopWaitMs'>,
  Pick<ReturnedPromptDeps, 'returnedPromptWaitMs' | 'fieldReadBeforeEscapeMs'> {
  client: HerdrClient;
  audit: HerdrAuditLog;
  /**
   * Bez tego `send` z załącznikami rzuca — zdjęcie i plik mają dojść albo nie dojść JAWNIE,
   * nigdy po cichu (prompt „przeczytaj ten log" bez logu jest gorszy niż brak wysyłki).
   */
  uploads?: HerdrUploads;
  /** Strażnik tekstu. Nieobecny = wołający gwarantuje, że tekst jest już zwalidowany. */
  guard?: PromptGuard;
  /**
   * Katalog komend sesji dla wysyłki BEZ klasyfikacji managera (`SendOptions.command`) — tylko
   * strażnik go czyta. Nieobecny = migawka z samego rejestru (`registryCatalog`): skille z dysku dostają
   * wtedy odmowę, nigdy przepuszczenie.
   */
  commandCatalog?: (cwd: string) => CommandCatalog;
  /** System maszyny serwera do słowa maszyny w zdaniach (Mac albo VPS). Nieobecny = `serverSystem()`. */
  system?: ServerSystem;
  yoloRoots: readonly string[];
  now: () => number;
  /** Parser ekranu (S-herdr). Nieobecny = wbudowany minimalny wycinek. */
  snippet?: ScreenSnippet;
  /** Cross-check ekran ↔ jsonl. Nieobecny = `resolveOptions` z `herdr/dialogs/screen/`. */
  resolveOptions?: OptionResolver;
  /** Start karencji `idle` w supervisorze po udanej wysyłce (`HerdrSupervisor.markSent`). */
  markSent?: (key: string) => void;
  /**
   * WYMUSZONY odczyt stopki trybu przez nadzorcę — po każdym `shift+tab` w pętli
   * `setMode`. Nadzorca jest właścicielem trybu (jego wpis karmi bramkę wysyłki), więc odczyt
   * ma iść przez niego, a nie obok. Nieobecny = driver czyta ekran sam (`parseMode`).
   */
  refreshMode?: () => Promise<HerdrFooterMode>;
  /**
   * „W tym panelu stoi (albo właśnie stał) dialog ZAUFANIA KATALOGU"
   *
   * Po zatwierdzeniu zaufania `claude` RE-EKSEKUUJE się: herdr na moment gubi agenta, a nadzorca
   * bez tej wiedzy ogłosiłby `gone` i zamknął kartę sesji, która za sekundę wraca. Driver jest
   * jedynym miejscem, które wie, CO stoi na ekranie — więc to on melduje, a karencję zniknięcia
   * trzyma nadzorca. Brak zależności = natychmiastowe `gone`.
   */
  markTrustDialog?: () => void;
  /** Identyfikator sesji Raroga — tylko do dziennika (driver nie zna managera). */
  sessionId?: string;
  /**
   * Limit okna kontekstu, gdy RAROG sam podał `--model` z `KNOWN_CONTEXT_LIMITS`
   * („Session fields and herdr frames” w `docs/implementation-spec.md`).
   * Brak = okno `unknown` do pierwszej automatycznej kompakcji — nigdy zgadywane.
   */
  knownContextLimit?: number;
  /** Fabryka followera transkryptu (testy podstawiają katalog tymczasowy). */
  follow?: FollowerFactory;
  /** Fabryka pulsu katalogu sesji (S-live) — driver włącza go tylko na czas tury. */
  pulse?: PulseFactory;
  /**
   * Fabryka czytnika rozkładu workflow. Trzecie źródło obok followera i pulsu: czyta
   * skrypt i journal przebiegu, ale dopiero gdy follower zobaczył start z `runId`.
   */
  workflowRuns?: (opts: { cwd: string; agentSessionId: string }) => WorkflowRunReader;
  /**
   * Fabryka czytnika plików subagentów. Czwarte źródło: plik `subagents/agent-<id>.jsonl`
   * każdego OTWARTEGO subagenta, z którego wynika, że agent w postoju sam ruszył.
   */
  agentFiles?: (opts: { cwd: string; agentSessionId: string }) => AgentFileReader;
  /**
   * Czy wolno czytać pliki rozmów subagentów (`RAROG_AGENT_FILES`). `false` = czytnik nie
   * powstaje wcale, jak dla panelu poza zasięgiem: żaden plik subagenta nie jest otwierany, agent
   * po postoju stoi na „czeka" do wznowienia albo końca i nie ma `ownTasks`. Nieobecne = wolno.
   */
  readAgentFiles?: boolean;
  /**
   * Rozpoznanie promptu zablokowanego przez hook `UserPromptSubmit` (`RAROG_PROMPT_BLOCK`). `false` = follower
   * pomija wpis blokady, więc driver nie dostaje zdarzenia i żadnej flagi blokady nie ustawia: stall-guard,
   * watchdog i czyszczenie pola jak przed rozpoznaniem. Nieobecne = włączone.
   */
  promptBlock?: boolean;
  /**
   * Flaga warstwy 2 dialogów (`RAROG_DIALOG_LAYER2`), przeczytana raz przy starcie serwera (`config.dialogLayer2`).
   * Driver podaje ją decyzji polem `DecideInput.layer2`. `true` = karta ekranu bez opcji z cyframi niesie blok
   * z sufitem warstwy 2, ta sama karta z innym blokiem odświeża wycinek (`refresh`, zdarzenie `dialog-screen`), a wpis
   * `block-card` dostaje `layer2` i `layer2Why`. Nieobecne albo `false` = driver bez warstwy 2.
   */
  dialogLayer2?: boolean;
  /**
   * Odstęp odczytu plików obok transkryptu: rozkładów workflow i plików subagentów (testy
   * skracają do milisekund). Domyślnie `TASKS_POLL_MS`.
   */
  tasksPollMs?: number;
  /**
   * Fabryka czytnika plików rozmowy pod kątem pull requestów (`docs/pull-requests.md`). Piąte źródło:
   * plik główny i, za zgodą `readAgentFiles`, pliki subagentów i agentów workflow, wszystkie, także po końcu
   * agenta. Testy podstawiają katalog tymczasowy.
   */
  pullRequestFiles?: (opts: PullRequestFilesReaderOptions) => PullRequestFilesReader;
  /** Odstęp odczytu plików rozmowy pod kątem PR-ów po sygnale (testy skracają). Domyślnie `PULL_REQUESTS_POLL_MS`. */
  pullRequestsPollMs?: number;
  /** Factory of the main file reader for scheduled tasks (`docs/scheduled-tasks.md`); tests give a temporary store. */
  scheduledTaskFiles?: (opts: ScheduledTaskFileReaderOptions) => ScheduledTaskFileReader;
  /** Delay of a scheduled task read after a signal (tests shorten it). Default `SCHEDULED_TASKS_POLL_MS`. */
  scheduledTasksPollMs?: number;
  /**
   * Czytnik zrzutu hooka `PreToolUse` (warstwa 1 uniwersalnej karty).
   *
   * jsonl NIE ZNA stojącego dialogu zgody (wpis `tool_use` powstaje po decyzji), ale pasywny
   * hook zrzuca czekające narzędzie do pliku ZANIM dialog stanie — Rarog dostaje wtedy pełny
   * `tool_input` na kartę, a nie tylko treść z ekranu. Nieobecny (hook niezainstalowany —
   * to świadoma decyzja operatora przy biurku, patrz `docs/security-model.md`) = karta
   * ekranowa z warstwy 2. Cross-check nazwy narzędzia z ekranem obowiązuje tak samo jak dla
   * jsonl: stęchły zrzut z cudzym narzędziem kończy się rozjazdem, nigdy złą cyfrą.
   */
  readPendingHook?: (engineSessionId: string) => PendingHookTool | null;
  /**
   * Sprzątnięcie zrzutu hooka po wysłanej decyzji — plik nie ma przeżyć dialogu.
   *
   * `answerKey` zawęża kasowanie do JEDNEJ generacji zrzutu: po odpowiedzi plikiem
   * kasujemy dokładnie ten zrzut, na który odpowiadaliśmy, a nie „plik tej sesji" — hook zapisuje
   * następne pytanie tej samej tury natychmiast i bezwarunkowe kasowanie zabierało mu treść.
   * Bez klucza (Esc, cyfra) zostaje kasowanie bezwarunkowe: tam dialog już nie stoi.
   */
  clearPendingHook?: (engineSessionId: string, answerKey?: string) => void;
  /**
   * Kanał ODPOWIEDZI na `AskUserQuestion` — kierunek odwrotny niż
   * `readPendingHook`: Rarog pisze plik, a śpiący hook `PermissionRequest` oddaje go CLI jako
   * `allow` z `updatedInput.answers`.
   *
   * Nieobecny = odpowiedź idzie CYFRĄ z ekranu i tak zostaje dla każdej
   * sesji bez hooka. Fabryka jest też miejscem killswitcha (`RAROG_HERDR_SEND=0`): kanał
   * omija klienta herdr, więc bramka „widzę, nie ruszam" musi stać U ŹRÓDŁA, a nie na gnieździe.
   */
  hookAnswers?: HookAnswerChannel;
  /**
   * Kanał cienia (`RAROG_CONSENT_CHANNEL=shadow`, `docs/dialogs.md`, „Server in shadow mode”): przed klawiszem
   * zgody albo odmowy z telefonu plik cienia pod kluczem prośby z dowodem „dialog stoi”. Brak = tryb `off`:
   * driver nie czyta zrzutów per wywołanie i nie pisze plików cienia. Kanał nie zmienia ani klawisza, ani jego
   * kolejności — błąd albo sufit czasu kroku daje wynik `error` w dzienniku, a klawisz idzie jak przy `off`.
   */
  shadow?: ShadowConsentChannel;
  /**
   * Tryb efektywny kanału zgód (`layer1/mode.ts`, `ConsentModeSource.current().effective`), czytany przy każdym
   * kroku. Kanał cienia ({@link shadow}) działa wyłącznie przy `shadow`; przy `main` i `all` klasa
   * `permission`/`sandbox` nie dostaje cyfry na żadnej ścieżce (`consentDigitBlocked`), a karta zgody z ekranu albo
   * jsonl idzie bez przycisku zgody. Wyjątek źródła = tryb nieznany, liczony jak `main` dla cyfry i cienia (bez cyfry,
   * bez cienia), a obserwacji kanału nie ma. Brak pola = kanał cienia działa, gdy jest, i cyfra jak przy `off`.
   */
  consentMode?: () => ConsentEffectiveMode;
  /**
   * Kanał zgód (warstwa 1) przy efektywnym `main` albo `all`: obserwacja zrzutów per wywołanie sesji w rytmie
   * odczytu rejestru (co 1,5 s), z sygnałami dowodu trybu cienia (rejestr, otwarte `tool_use`, ekran) i ostatnimi
   * zamkniętymi `tool_use` (czy transkrypt poszedł dalej niż prośba). Cykl zakłada z nich karty kanału i zdejmuje
   * je sygnałem. Nie rzuca i nie czeka: wynik idzie do cyklu. Brak = bez kanału.
   */
  consentObserve?: (request: ConsentObserveRequest) => Promise<void>;
  /**
   * Status rejestru sesji silnika `engineSessionId` bez `waiting: permission` z chwilą jego odczytu `at`: cykl
   * zdejmuje od razu dowód z kanału z odczytów rejestru nie późniejszych, także gdy obserwacja z takim odczytem trwa.
   * Wołany przy każdym takim odczycie, w każdym trybie: z taktu ({@link SessionDriver.noteCliWaiting}), ze
   * szturchnięcia i z odczytu obserwacji ({@link consentRegistryRead}, przed dalszą obserwacją). Wyjątek nic nie zmienia.
   */
  consentRegistryNotWaiting?: (engineSessionId: string, at: number) => void;
  /**
   * Czy w sesji silnika czeka prośba subagenta (rekord kanału z `agentId` w `pending`, `ConsentCycle.subagentPending`).
   * Przy trybie efektywnym `all` driver obserwuje wtedy kanał co najwyżej co {@link CONSENT_SUBAGENT_OBSERVE_MS},
   * także bez `waiting: permission`, a każda obserwacja czyta rejestr od nowa ({@link consentRegistryRead}).
   * Wyjątek = nie czeka. Brak = bez tej obserwacji (rytm odczytu rejestru managera jak przy `main`).
   */
  consentSubagentPending?: (engineSessionId: string) => boolean;
  /**
   * Odczyt rejestru sesji CLI dla obserwacji kanału przy czekającej prośbie subagenta i trybie `all`
   * ({@link consentSubagentPending}): sygnał rozmowy z odczytu rozpoczętego przy wywołaniu (ten sam czytnik co szybki
   * tik managera). Wyjątek albo brak = ostatni sygnał od managera z chwilą jego nadejścia. Ten sam świeży odczyt
   * sprawdza wysyłka w trakcie tury przed wklejeniem i przed Enterem: tik managera bywa
   * starszy o 1,5 s, a rejestr pokazuje dialog najszybciej ze wszystkich sygnałów (pomiar 0a).
   * A message to a Claude pane herdr reports idle reads it too, to choose that path (`PromptQueue.registryInTurn`).
   */
  consentRegistryRead?: (engineSessionId: string) => Promise<CliWaitingSignal>;
  /** Linia `server.log` wysyłki w trakcie tury. Brak = bez linii (testy). */
  logger?: (line: string) => void;
  /** Sufit czekania na wklejony tekst w polu promptu (testy go skracają; domyślnie {@link PROMPT_FIELD_WAIT_MS}). */
  promptFieldWaitMs?: number;
  /** Odstęp odczytów pola po wklejeniu (testy go skracają; domyślnie {@link PROMPT_FIELD_POLL_MS}). */
  promptFieldPollMs?: number;
  /** Odstęp ponownej próby wiadomości czekającej na koniec dialogu (domyślnie {@link PROMPT_RETRY_MS}). */
  promptRetryMs?: number;
  /** Sufit czekania na rozstrzygnięcie poprzedniego Entera z kolejki (domyślnie {@link PROMPT_SUBMIT_SETTLE_MS}). */
  promptSubmitSettleMs?: number;
  /**
   * Czy dialog sesji silnika trzyma karta kanału zgód (`pending`, `sent`: hook czeka na plik odpowiedzi). Wtedy karta
   * zgody z ekranu albo jsonl nie idzie do managera („jedna karta na dialog”), a klawisz decyzji z ekranu (`escape`
   * odmowy, cyfra zgody) nie idzie do panelu. Wyjątek = brak karty, poza cyfrą zgody (bez zgody przy wątpliwości).
   * Wysyłka w trakcie tury liczy taką kartę jak czekającą prośbę hooka: bez wklejenia i bez Entera;
   * wyjątek liczy jak kartę.
   */
  consentCardLive?: (engineSessionId: string) => boolean;
  /**
   * Chwila przyjęcia (ms epoki) najnowszej żywej rejestracji kanału zgód sesji silnika, która nie ma jeszcze karty
   * kanału; `null` = takiej nie ma. Karta zgody bez przycisku zgody (z ekranu albo jsonl) czeka wtedy na kartę kanału,
   * najwyżej {@link HERDR_CONSENT_CARD_WAIT_MS} od tej chwili, więc dialog nie dostaje najpierw karty „tylko Odrzuć”,
   * którą karta kanału zaraz zdejmuje. Wyjątek portu = karta nie czeka. Wysyłka w trakcie tury liczy taką rejestrację
   * w tym samym sufice jak czekającą prośbę hooka; wyjątek liczy jak rejestrację.
   */
  consentCardAwaited?: (engineSessionId: string) => number | null;
  /**
   * Whether the engine session has a live channel registration without a channel card, a subagent's too and of any age
   * (`registrationWithoutCard`, `layer1/registry.ts`): the "Yes" digit of a measured consent dialog does not go
   * out then (`PromptQueue.keyHookWaits`). An exception counts as waiting; absent = only a channel card blocks it.
   */
  consentRegistrationWaits?: (engineSessionId: string) => boolean;
  /**
   * What the desk release of a subagent request kept (`ConsentCycle.deskRelease`), by the per-call key of the hook dump
   * a card came from: the reason of a consent card without the approve button (`screen-unavailable.ts`). Absent or an
   * exception = no release known (`no-channel`).
   */
  consentDeskRelease?: (engineSessionId: string, key: string) => ConsentDeskRelease | null;
  /** Sources of the consent-without-hook detector (`drivers/herdr/consent-no-hook.ts`); absent = no `no hook` line. */
  consentNoHook?: ConsentNoHookSources;
  /** Sufit czekania na kartę kanału (testy skracają go; domyślnie {@link HERDR_CONSENT_CARD_WAIT_MS}). */
  consentCardWaitMs?: number;
  /** Ile czekamy na zużycie pliku odpowiedzi przez hook (testy skracają do zera). */
  hookAnswerWaitMs?: number;
  /** Odstęp sprawdzania pliku odpowiedzi (testy skracają go). */
  hookAnswerPollMs?: number;
  /**
   * Zrzut diagnostyczny odmowy („Refusal diagnostics” w `docs/dialogs.md`) — tekst ekranu i stan obu źródeł treści, na dysk.
   *
   * Nieobecny (albo wyłączony przez `RAROG_REFUSAL_DUMPS=0`) = zostaje sam wpis w dzienniku:
   * powód bez ani jednego znaku z ekranu, po którym dałoby się
   * odtworzyć, CO Rarogowi nie wyszło.
   */
  dumpRefusal?: RefusalDumper;
  scheduler?: Scheduler;
  /** Okno uzgadniania jsonl ↔ herdr (testy skracają je do milisekund). */
  pendingDebounceMs?: number;
  /** Odstęp przed JEDYNYM ponownym odczytem ekranu. */
  pendingRetryMs?: number;
  /** Termin ważności zrzutu ekranu stojącego dialogu (testy skracają do zera). */
  screenCacheMs?: number;
  /** Odstęp ponownej oceny STOJĄCEGO dialogu (testy skracają go). */
  blockedPollMs?: number;
  /** Odstęp między próbami odczytu dialogu potwierdzenia `/model` (testy skracają go). */
  modelConfirmPollMs?: number;
  /** Pauza `shift+tab` → odczyt stopki w pętli zmiany trybu (testy skracają ją). */
  modeCycleSettleMs?: number;
  /** Odstęp „stalled → decyzja o ponowieniu" (testy skracają go). */
  stallSettleMs?: number;
  /** Pauza po parze `esc esc` czyszczącej composer (testy skracają ją). */
  escSettleMs?: number;
  /** Watchdog tury po wysyłce (testy skracają go). */
  turnWatchdogMs?: number;
  /** Life of the echo of a command sent inside a turn (`IN_TURN_COMMAND_ECHO_MS`; tests shorten it). */
  inTurnCommandEchoMs?: number;
  /** Opóźnienia sondy stanu po przerwaniu (testy skracają je albo dają `[]`). */
  interruptProbeDelaysMs?: readonly number[];
  /** Odstępy ponownej oceny po cyfrze w dialog z ekranu (testy skracają je). */
  screenAnswerRearmDelaysMs?: readonly number[];
  /** Termin osłony po własnej decyzji (`DECIDED_SHIELD_MS`; testy go skracają). */
  decidedShieldMs?: number;
  /**
   * Pauza cyfra → odczyt weryfikujący w formularzu z preview, a w dialogu zaufania bez cyfr `down` → odczyt przed
   * `enter`. Testy skracają ją do zera.
   */
  formSubmitConfirmDelayMs?: number;
  /** Katalog domowy do rozwinięcia `~` w folderze dialogu zaufania; domyślnie `os.homedir()`. */
  homeDir?: string;
  /** Ile wpis `degrade` czeka na wiersze panelu (`HERDR_PANE_ROWS_WAIT_MS`; testy go skracają). */
  paneRowsWaitMs?: number;
  /** Ponowienia wejścia w rezerwę formularza (testy skracają je albo dają `[]`). */
  formFallbackRetryDelaysMs?: readonly number[];
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

/**
 * Kod błędu herdr — po `code`, nie po `instanceof`.
 *
 * Klasy błędów przychodzą z modułu klienta, a ten w teście bywa inną instancją modułu niż
 * w produkcji. `code` jest częścią kontraktu (3.4) i nie kłamie przy podwójnym ładowaniu.
 */
function herdrCode(err: unknown): string {
  const value = (err as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : '';
}

/**
 * Czy `herdr-stalled` przyszedł z PRAWDZIWEGO `agent_prompt_stalled`, czy z dopasowania po
 * treści komunikatu (`HerdrStallSource`) — czytane po polu, nie po `instanceof`, z tego samego
 * powodu co `herdrCode`.
 *
 * Ma znaczenie tam, gdzie stall jest POŁYKANY jako sukces. Gałąź tekstowa w `client.ts`
 * powstała dla `agent.prompt` z `wait`; `send_keys` (Esc) `wait`-a nie używa, więc każdy
 * NIEZNANY błąd, którego komunikat zawiera „timed out waiting for agent", zostałby tam
 * zamieniony w fałszywe „przerwane" i trwały wpis w transkrypcie.
 */
function stalledByRemoteCode(err: unknown): boolean {
  const value = (err as { stallSource?: unknown } | null)?.stallSource;
  // Brak pola = starsza (albo cudza) instancja błędu — trzymamy się dotychczasowego znaczenia.
  return value === undefined || value === 'remote-code';
}

/**
 * Mapowanie statusu herdr na stan dla managera; `unknown` → `null` (nie zgadujemy końca pracy).
 *
 * Pole `seen` jest tu SUROWYM odbiciem statusu panelu — `idle` → `true` znaczy „herdr zszedł
 * z badge'a `done`", a nie „człowiek odebrał wynik". O odbiorze decyduje manager
 * (`Session.herdrSeen`: odbiorem jest wyłącznie przejście `done → idle`), bo panel sfokusowany
 * na Macu w chwili końca tury nie dostaje `done` wcale. Mapowanie zostaje bez zmian.
 */
export function driverStateFor(
  status: HerdrAgentStatus,
): { state: 'working' | 'idle' | 'blocked'; seen?: boolean; detail?: OwnText } | null {
  switch (status) {
    case 'working':
      return { state: 'working' };
    // `idle` = panel bez badge'a `done` (manager uzna to za odbiór tylko po `done`)…
    case 'idle':
      return { state: 'idle', seen: true };
    // …a `done` = skończył i badge stoi w herdr (karta ląduje w sekcji uwagi).
    // BEZ detail „nowy wynik": tę informację niesie już `seen` (błękitne
    // „gotowe" na karcie), a dopisek zostawał na karcie także PO odczytaniu wyniku.
    case 'done':
      return { state: 'idle', seen: false };
    case 'blocked':
      return { state: 'blocked' };
    case 'unknown':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class HerdrDriver implements SessionDriver {
  /**
   * Panel należy do użytkownika — odpięcie drivera NIE MOŻE go dotknąć.
   * `#detachDriver` w managerze pomija na tej podstawie `interrupt()`.
   */
  readonly ownsProcess = false;

  readonly #queue = new AsyncEventQueue<DriverEvent>();
  readonly #deps: HerdrDriverDeps;
  readonly #scheduler: Scheduler;
  readonly #snippet: ScreenSnippet;
  readonly #resolveOptions: OptionResolver;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  /** Termin ważności zrzutu ekranu. */
  readonly #screenCacheMs: number;
  /** Odstęp ponownej oceny stojącego dialogu. */
  readonly #blockedPollMs: number;
  /** Sufit czekania karty zgody na kartę kanału ({@link HerdrDriverDeps.consentCardAwaited}). */
  readonly #consentCardWaitMs: number;
  readonly #stallSettleMs: number;
  readonly #unsubscribe: () => void;
  readonly #follower: JsonlFollower | null;
  /** Puls katalogu sesji (S-live); `null` = panel poza zasięgiem, żadnych plików nie oglądamy. */
  readonly #pulse: SessionPulse | null;
  /** Czytnik rozkładu workflow; `null` = panel poza zasięgiem. */
  readonly #runReader: WorkflowRunReader | null;
  /** Czytnik plików subagentów; `null` = panel poza zasięgiem albo `RAROG_AGENT_FILES=0`. */
  readonly #agentReader: AgentFileReader | null;
  /** Stan zadań w tle i nakładek — mieszka w `herdr/background/merge.ts`, fasada go tylko trzyma. */
  readonly #tasks: TasksState = createTasksState();
  readonly #tasksPollMs: number;
  /**
   * Conversation file reader for pull requests and the list refresh state; it lives in
   * `drivers/herdr/pull-request-poll.ts`, the facade only holds it.
   */
  readonly #pullRequests: PullRequestPollState;
  readonly #crons: crons.ScheduledTaskPollState;
  readonly #inScope: boolean;
  readonly #key: string;
  readonly #cwd: string;
  /** Silnik panelu z uchwytu: wklejenie z osobnym Enterem dotyczy wyłącznie `claude`. */
  readonly #engine: HerdrEngine;
  /** Kolejka wklejeń w trakcie tury: `drivers/herdr/prompt-queue.ts`. */
  readonly #promptQueue: PromptQueue;
  /** Taking both prompt queues back for the app: `drivers/herdr/queue-take-back.ts`. */
  readonly #takeBack: QueueTakeBack;
  readonly #returnedPrompt: ReturnedPrompt;

  #paneId: string;
  #mode: HerdrMode;
  #lastTitle: string | null = null;

  #status: HerdrAgentStatus;
  /**
   * Ostatni znany `state_change_seq` panelu — jedziemy z nim w każdym `agent-state`.
   *
   * Manager potrzebuje go do znacznika „widziane z telefonu": zapisuje numer stanu, przy którym
   * człowiek obejrzał wynik, i przebija go dopiero NOWSZY `done` (wyższy numer). Bez numeru
   * znacznik musiałby wygasać po czasie, czyli zgadywać.
   */
  #stateChangeSeq: number;
  /** Po `ctrl+c` tekst wisi w polu panelu — następna wysyłka musi je najpierw wyczyścić. */
  #needsEscape = false;
  /** Unieważnia sondę stanu po przerwaniu, gdy w międzyczasie ruszyła nowsza wysyłka. */
  #interruptProbeToken = 0;
  #disposed = false;
  /** Serializacja wysyłek: dwie tury nie mogą przeplatać czyszczącego `escape` z `prompt`. */
  #chain: Promise<void> = Promise.resolve();

  /*
   * Decyzje. Stan „czeka na decyzję" liczymy z DWÓCH faktów: ostatniego statusu z herdr
   * i ostatniego czekającego narzędzia z jsonl. Żaden sam nie wystarcza — herdr nie wie, CO
   * czeka, a jsonl nie wie, czy ktoś na to jeszcze patrzy.
   */
  #pending: PendingTool | null = null;
  /** Licznik WEJŚĆ w `blocked` — daje stabilny `reqId` dialogowi, którego w jsonl nie ma. */
  #blockedSeq = 0;
  /**
   * Raw herdr status changes into `blocked`, also under a hold that already stands (unlike {@link #blockedSeq}): with
   * `cliHoldStarts` the generation of the paste queue's `status` hold (`DriverHold`).
   */
  #blockedStarts = 0;
  /**
   * Numer blokady, na którą poszła NASZA cyfra — okno wyciszenia karty-fallback.
   * Dopóki trwa ta sama blokada, pusta ocena ekranu po własnej odpowiedzi to niemal na
   * pewno przemalowanie TUI po zamknięciu dialogu, nie nowy dialog (patrz `#evaluateDecision`).
   */
  #answeredSeq = -1;
  /**
   * Kiedy poszła ostatnia WŁASNA cyfra (`#rearmAfterScreenAnswer`) — koniec osłony rezerwy formularza.
   *
   * `#answeredSeq` trwa do końca blokady, a rezerwa potrzebuje osłony z terminem: Esc przy
   * biurku po naszej cyfrze zamyka formularz bez `working`, a stęchły zrzut hooka trzymałby
   * klucz formularza — bez terminu karta wisiałaby przy bezczynnym panelu.
   */
  #answeredAt = 0;
  /**
   * Klucz zrzutu, dla którego kanał odpowiedzi hooka OKAZAŁ SIĘ MARTWY.
   *
   * Ustawia go jedyny dostępny dowód: plik odpowiedzi, którego nikt nie zużył w kilka sekund
   * (hook po timeoucie, zabity albo wyprzedzony przez biurko). Od tej chwili ten sam formularz
   * dostaje karty CYFROWE — jedna zakładka naraz — bo karta z kompletem pytań dla nieżyjącego
   * czytelnika kończyłaby się w kółko tą samą, nieskuteczną wysyłką. Jeden klucz wystarcza:
   * zrzuty w sesji są sekwencyjne, a nowy formularz przynosi nowy klucz.
   */
  #deadAnswerKey: string | null = null;
  /**
   * Wywołanie `AskUserQuestion`, na które poszła ODPOWIEDŹ plikiem hooka.
   *
   * `allow` domyka całe wywołanie, ale `tool_result` dochodzi do jsonl z opóźnieniem, a od CLI
   * 2.1.267 `tool_use` stoi w pliku od chwili postawienia dialogu — bez tego znacznika ocena
   * budowała w tym oknie kartę z pytaniami, na które człowiek właśnie odpowiedział.
   *
   * Znacznik stoi od ZAPISU pliku, a nie od potwierdzenia jego zużycia:
   * samo czekanie na zużycie trwa do kilku sekund i ocena trafiona w to
   * okno widziała wpis z jsonl bez osłony. Gdy hook pliku nie odebrał, `#answerViaHook`
   * znacznik WYCOFUJE — odpowiedź pojedzie cyfrą, zakładka po zakładce.
   *
   * Wywołanie rozpoznajemy po TREŚCI pytań z karty, nie po `tool_use.id` — follower bywa
   * o ułamek sekundy do tyłu (patrz `DecideInput.answeredHookCall`). Osłona ma przez to trzy
   * końce, bo sama treść nie odróżnia dwóch identycznych pytań jednej tury: nowa blokada
   * (`seq` jest tu WŁASNY, nie `#answeredSeq` — ten przestawia też cyfra), świeży zrzut hooka
   * o innym `answerKey` (`key`, nonce w kluczu odpowiedzi) i wygaśnięcie po
   * `ANSWERED_HOOK_SHIELD_MS` (`at`, liczone zegarem drivera — patrz {@link #answeredHookShield}).
   * Ścieżka CYFROWA znacznika NIE ustawia, bo tam jedna cyfra zamyka jedno pytanie i zakładki
   * 2..n mają dostać własne karty.
   */
  #answeredHookCall: {
    questions: readonly string[]; seq: number; key: string; at: number;
  } | null = null;
  /**
   * Karta rozstrzygnięta WŁASNĄ decyzją — cyfrą (`#sendDigit`) albo `escape` (`respondPermission`) —
   * z terminem `DECIDED_SHIELD_MS`. Bliźniak {@link #answeredHookCall} dla ścieżki cyfrowej.
   *
   * Po decyzji herdr jeszcze chwilę melduje `blocked`, wpis jsonl nie ma `tool_result`, a ekran (cache
   * sprzed cyfry albo panel przed przemalowaniem) pokazuje dialog. Bez tej osłony ocena w tym oknie
   * zbudowałaby tę samą kartę od nowa i telefon dostałby ją z powrotem na ~2 s.
   * Osłonę zdejmuje nowa blokada, nowy wpis jsonl i termin — patrz `DecideInput.decided`.
   */
  #decided: (DecidedShield & { at: number }) | null = null;
  /** Kiedy weszliśmy w bieżącą blokadę — bez tego „dialog spoza jsonl" bywa przedwczesny. */
  #blockedAt = 0;
  /** Ostatnio przeczytany ekran; `null` = trzeba przeczytać. Ważny przez `#screenCacheMs`. */
  #screenText: string | null = null;
  /** Kiedy powstał {@link #screenText} — cache dialogu ma TERMIN WAŻNOŚCI. */
  #screenAt = 0;
  /**
   * Numer blokady, w której ostatni odczyt ekranu pokazał pauzę „Session paused” (`#pauseBlocksEscape`);
   * `null` = żaden. Przeżywa odmowę Esc, zgaszoną kartę i odczyt bez dialogu (przemalowanie); zdejmuje go
   * dopiero odczyt z INNYM czytelnym dialogiem, a koniec blokady albo nowa blokada go unieważniają.
   */
  #pauseSeq: number | null = null;
  /** Zegar ponownej oceny stojącego dialogu; `null` = panel nie jest zablokowany. */
  #blockedTimer: TimerHandle | null = null;
  /**
   * Karta, o której manager już wie. `null` = nic nie wisi.
   *
   * `screen: true` znaczy „dialog spoza jsonl" — taka karta nie ma `permId` po stronie
   * managera (adresem decyzji jest SESJA), więc `reqId` z decyzji nigdy nie trafi w ten
   * z ekranu i porównywanie ich byłoby wyłącznie sposobem na zignorowanie każdej decyzji.
   *
   * `seq` = numer blokady, w której karta ostatnio potwierdziła się ekranem. NIE jest
   * testem świeżości: zamroziłby ocenę na całą blokadę, więc dialog podmieniony
   * w miejscu nie dostałby własnej karty. Świeżość rozstrzyga TREŚĆ (`screenFormReqId`);
   * `seq` służy oknu po własnej cyfrze (`#rearmAfterScreenAnswer`) i diagnostyce.
   */
  #activeReq: ActiveReq | null = null;
  /**
   * Dialog ZGODY CLI stojący w panelu, którego herdr NIE widzi jako blokady. Dopóki jest
   * ustawiony, stan sesji jedzie jako `blocked`, karta „zgoda CLI" wisi, a wysyłki są
   * wstrzymane. Gaśnie: gdy ekran przestaje go pokazywać (nadzorca albo odczyt przed wysyłką),
   * po udanym `escape` z karty i z wejściem panelu w turę.
   */
  #consentDialog: ScreenConsentDialogId | null = null;
  #consentSeq = 0;
  /** The form fallback: `drivers/herdr/form-reserve.ts`. */
  readonly #formReserve: FormReserve;
  /** The CLI registry fallback: `drivers/herdr/cli-reserve.ts`. */
  readonly #cliReserve: CliReserve;
  /** Consent without a hook and cards without the approve button, in the log: `drivers/herdr/consent-no-hook.ts`. */
  readonly #noHook: ConsentNoHook;
  /** The port of the refusals and their audit funnel: `drivers/herdr/refusals.ts`. */
  readonly #refusals: RefusalPort;
  /** The wait behind a command dialog the driver confirmed: `drivers/herdr/command-dialog-settle.ts`. */
  readonly #commandSettle: CommandDialogSettle;
  /** The layer 2 card with buttons (`docs/dialog-card.md`): `drivers/herdr/layer2-card.ts`. */
  readonly #layer2Cards: Layer2Cards;
  /** The key from a layer 2 card, after its proof: `drivers/herdr/layer2-step.ts`. */
  readonly #layer2Step: Layer2Step;
  /** Zwalnianie sierot trybu cienia w toku — następny odczyt rejestru nie zaczyna drugiego. */
  #shadowReleasing = false;
  /** The consent channel as the driver sees it: `drivers/herdr/consent-channel.ts`. */
  readonly #consentChannel: ConsentChannel;
  /**
   * Karta BEZ decyzji, która stoi teraz, i klasa z rejestru, którą poniosła.
   *
   * Tik rejestru (co 1,5 s) bywa wolniejszy niż ocena po herdr `blocked`, więc karta staje
   * często PRZED pierwszym `waiting`, a ten sam ekran przy kolejnych ocenach to `KEEP` — nowej
   * karty już nie będzie. Zmianę klasy przy stojącej karcie driver
   * dosyła więc zdarzeniem `cli-dialog`. Wpis jest ważny wyłącznie dla TEGO `#activeReq`:
   * karta zdjęta albo podmieniona kończy go bez sprzątania w każdej ścieżce osobno.
   */
  #undecided: { active: ActiveReq; cliDialog: CliDialogClass | null } | null = null;
  #evalTimer: TimerHandle | null = null;
  #evaluating = false;
  #evaluateAgain = false;
  /** Turn watchdog, local command and send numbers: `drivers/herdr/turn-guard.ts`. */
  readonly #turnGuard: TurnGuard;
  /**
   * Kiedy jsonl ostatnio dał znak życia (dowolne zdarzenie followera) — początek CISZY.
   *
   * Startuje od chwili podpięcia, a nie od zera: inaczej pierwszy puls policzyłby ciszę od
   * początku epoki i zameldował „myśli od 1 787 000 000 s".
   */
  #lastFollowAt: number;
  /** Sygnatura ostatniego wiersza Z PULSU (bez licznika) i moment jej wysłania — dedup SSE. */
  /** Dedup wiersza z pulsu — jawny stan modułu `herdr/transcript.ts`. */
  readonly #pulseEcho = createPulseEcho();
  /** Bieżąca sesja silnika (zmienia ją `/clear`) — potrzebna do `init` z metadanych jsonl. */
  #agentSessionId: string;

  constructor(handle: HerdrAgentHandle, deps: HerdrDriverDeps) {
    this.#deps = deps;
    this.#scheduler = deps.scheduler ?? systemScheduler;
    this.#snippet = deps.snippet ?? fallbackSnippet;
    this.#resolveOptions = deps.resolveOptions ?? resolveOptions;
    this.#debounceMs = deps.pendingDebounceMs ?? HERDR_PENDING_DEBOUNCE_MS;
    this.#retryMs = deps.pendingRetryMs ?? HERDR_PENDING_RETRY_MS;
    this.#screenCacheMs = deps.screenCacheMs ?? HERDR_SCREEN_CACHE_MS;
    this.#blockedPollMs = deps.blockedPollMs ?? HERDR_BLOCKED_POLL_MS;
    this.#consentCardWaitMs = deps.consentCardWaitMs ?? HERDR_CONSENT_CARD_WAIT_MS;
    this.#stallSettleMs = deps.stallSettleMs ?? HERDR_STALL_SETTLE_MS;
    this.#turnGuard = new TurnGuard({
      deps, scheduler: this.#scheduler, key: handle.agent.key,
      turnWatchdogMs: deps.turnWatchdogMs ?? HERDR_TURN_WATCHDOG_MS,
    }, this.#turnGuardPort());
    this.#tasksPollMs = deps.tasksPollMs ?? TASKS_POLL_MS;
    this.#key = handle.agent.key;
    this.#cwd = handle.agent.cwd;
    this.#paneId = handle.agent.paneId;
    this.#mode = handle.agent.mode;
    this.#status = handle.agent.status;
    this.#stateChangeSeq = handle.agent.stateChangeSeq;
    this.#inScope = handle.agent.inScope;
    this.#engine = handle.agent.engine;
    this.#agentSessionId = handle.agent.agentSessionId;
    const reservePort = this.#reservePort();
    this.#formReserve = new FormReserve({ deps, scheduler: this.#scheduler }, reservePort);
    this.#cliReserve = new CliReserve({ inScope: this.#inScope, form: this.#formReserve }, reservePort);
    this.#refusals = this.#refusalPort();
    this.#commandSettle = new CommandDialogSettle({ pollMs: deps.modelConfirmPollMs ?? MODEL_CONFIRM_POLL_MS }, {
      disposed: () => this.#disposed,
      readScreen: () => this.#deps.client.readScreen(this.#paneId, 'detection').then((s) => s.text, () => null),
      cliHold: () => this.#cliReserve.cliHold, blockedSeq: () => this.#blockedSeq,
      sleep: (ms) => this.#sleep(ms), now: () => this.#scheduler.now(),
    });
    const layer2 = { enabled: deps.dialogLayer2 === true, engine: this.#engine };
    this.#layer2Cards = new Layer2Cards({ ...layer2, shieldMs: deps.decidedShieldMs }, this.#layer2CardPort());
    this.#layer2Step = new Layer2Step({
      ...layer2, key: this.#key, cards: this.#layer2Cards, registryRead: deps.consentRegistryRead,
    }, this.#layer2StepPort());

    // Panel poza zasięgiem: karta pokazuje stan i projekt, ale transkryptu nie ma. Transkrypt
    // realnej pracy jest gęstszy sekretami niż sesja założona z telefonu — to nie ta sama klasa
    // danych, więc followera po prostu nie tworzymy (a nie: tworzymy i filtrujemy).
    this.#follower = this.#inScope ? this.#createFollower(handle.agent.agentSessionId) : null;
    this.#consentChannel = new ConsentChannel({
      deps, scheduler: this.#scheduler, inScope: this.#inScope, cliReserve: this.#cliReserve, follower: this.#follower,
      consentCardWaitMs: this.#consentCardWaitMs,
    }, {
      disposed: () => this.#disposed,
      agentSessionId: () => this.#agentSessionId,
      readDialog: (force) => this.#readDialog(force),
      evaluate: () => this.#evaluate(),
    });
    this.#promptQueue = new PromptQueue({
      deps, scheduler: this.#scheduler, key: this.#key, cwd: this.#cwd, consentCardWaitMs: this.#consentCardWaitMs,
      follower: this.#follower, inScope: this.#inScope, fieldHeld: () => this.#takeBack.holdsField(),
    }, this.#promptQueuePort());
    this.#takeBack = new QueueTakeBack({
      deps, scheduler: this.#scheduler, key: this.#key, consentCardWaitMs: this.#consentCardWaitMs,
      follower: this.#follower, claude: this.#engine === 'claude' && this.#inScope, queue: this.#promptQueue,
    }, this.#takeBackPort());
    this.#returnedPrompt = new ReturnedPrompt({ deps, scheduler: this.#scheduler, key: this.#key }, { paneId: () => this.#paneId });
    this.#noHook = new ConsentNoHook({ deps, scheduler: this.#scheduler, inScope: this.#inScope, cwd: this.#cwd }, {
      disposed: () => this.#disposed, agentSessionId: () => this.#agentSessionId, blockedNow: () => this.#blockedNow(),
      blockedSeq: () => this.#blockedSeq, blockedAt: () => this.#blockedAt, answeredAt: () => this.#answeredAt,
      cliWaiting: () => this.#cliReserve.cliWaiting, screenText: () => this.#screenText,
      cliVersion: () => (this.#cliReserve.cliSignal?.kind === 'unknown' ? null : this.#cliReserve.cliSignal?.version ?? null),
      permissionMode: () => (this.#mode === 'unknown' ? null : this.#mode),
    });
    this.#promptQueue.restore(this.#engine === 'claude', () => ++this.#turnGuard.sendGeneration);
    if (this.#follower !== null) void this.#pumpFollower(this.#follower);
    this.#lastFollowAt = this.#scheduler.now();
    this.#pulse = this.#inScope ? this.#createPulse(handle.agent.agentSessionId) : null;
    // Panel może być podpięty W ŚRODKU tury (restart Raroga) — puls musi wtedy ruszyć od razu.
    this.#syncPulse();
    this.#runReader = this.#inScope
      ? (deps.workflowRuns ?? createWorkflowRunReader)({
        cwd: this.#cwd, agentSessionId: handle.agent.agentSessionId,
      })
      : null;
    // Ta sama bramka zasięgu co wyżej: plik subagenta to transkrypt, tylko że podagenta.
    // Do tego preferencja `RAROG_AGENT_FILES`: wyłączona gasi odczyt u źródła.
    this.#agentReader = this.#inScope && deps.readAgentFiles !== false
      ? (deps.agentFiles ?? createAgentFileReader)({
        cwd: this.#cwd, agentSessionId: handle.agent.agentSessionId,
      })
      : null;
    // PR-y sesji: ta sama bramka zasięgu; pliki agentów tylko za zgodą `RAROG_AGENT_FILES`.
    this.#pullRequests = createPullRequestPollState(this.#inScope
      ? (deps.pullRequestFiles ?? createPullRequestFilesReader)({
        cwd: this.#cwd, agentSessionId: handle.agent.agentSessionId, subagents: deps.readAgentFiles !== false,
        // Ten sam plik, który czyta follower: bez drugiego globu po magazynie i z jego relokacją.
        locate: () => this.#follower?.transcriptOffset?.()?.file ?? null,
      })
      : null, deps.pullRequestsPollMs ?? PULL_REQUESTS_POLL_MS);
    this.#schedulePullRequests(0);
    // Scheduled tasks: the same scope gate, the main file only, the file the follower reads.
    this.#crons = crons.createScheduledTaskPollState(this.#inScope
      ? (deps.scheduledTaskFiles ?? createScheduledTaskFileReader)({
        cwd: this.#cwd, agentSessionId: handle.agent.agentSessionId,
        locate: () => crons.followerFileLocation(this.#follower),
      })
      : null, deps.scheduledTasksPollMs ?? SCHEDULED_TASKS_POLL_MS);
    crons.scheduleScheduledTasks(this.#crons, this.#cronsDeps, 0);

    this.#unsubscribe = handle.subscribe((ev) => { this.#onPaneEvent(ev); });

    /*
     * Panel podpięty JUŻ ZABLOKOWANY.
     *
     * Ścieżka decyzji startowała wyłącznie z PRZEJŚCIA w `blocked` (`#onStatus`), a panel
     * założony w świeżym katalogu jest zablokowany od pierwszej chwili: dialog zaufania stoi,
     * zanim manager zdąży podpiąć drivera. Zdarzenia zmiany statusu już nie będzie (status się
     * nie zmienia), a jsonl nie powstanie (agent nie ruszył) — więc nie było czego uzgadniać
     * i karta NIGDY się nie pokazywała. To samo dotyczy restartu Raroga w chwili, gdy panel
     * czeka na zgodę: karta wracała pusta.
     *
     * Uzbrojenie jest tu identyczne jak w `#onStatus`: numer blokady, znacznik czasu i odczyt
     * ekranu. Jedna droga wejścia w blokadę, dwa wyzwalacze.
     */
    if (this.#status === 'blocked') {
      this.#blockedSeq += 1;
      this.#blockedAt = this.#scheduler.now();
      this.#reportBlocked();
      this.#syncBlockedPoll();
    }
  }

  get events(): AsyncIterable<DriverEvent> {
    return this.#queue;
  }

  /** Adres panelu używany w kolejnych wywołaniach (zmienia go `pane move`). */
  get paneId(): string {
    return this.#paneId;
  }

  /**
   * Czy pole promptu trzyma NASZ prompt zablokowany przez hook ({@link TurnGuard.blockedLeftover}) — zgoda na jego
   * wyczyszczenie przed restartem sesji. Odczyt bez skutków.
   */
  get blockedLeftover(): boolean {
    return this.#turnGuard.blockedLeftover !== null;
  }

  /** The engine conversation the pane runs now (`SessionDriver.agentSessionId`); it moves at `session-changed`. */
  get agentSessionId(): string {
    return this.#agentSessionId;
  }

  // -------------------------------------------------------------------------
  // SessionDriver
  // -------------------------------------------------------------------------

  /**
   * Echo odroczone ma sens tylko z plikiem rozmowy (bez niego wpis promptu nie przyjdzie
   * nigdy i wiadomość czekałaby do spłukania) i tylko dla promptu, który follower rozpozna w pliku:
   * slash-komenda staje tam jako `<command-name>`, a tekst z pustym kluczem echa nie rejestruje
   * się w oknie wcale. Komendę rozpoznał manager (`slash` z bramki).
   */
  defersEcho(text: string, slash: SlashCommand | null): boolean {
    return this.#follower?.hasTranscript() === 'yes' && slash === null && echoKey(text) !== '';
  }

  send(
    text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions,
  ): void {
    this.#assertInScope();
    if (this.#disposed) return;
    // Nowsza wysyłka unieważnia sondę stanu po przerwaniu: jej `idle` odczytany tuż przed
    // startem nowej tury nie ma prawa zgasić optymistycznego `running` tej tury.
    this.#interruptProbeToken += 1;
    // Z tego samego powodu numer wysyłki: koniec komendy lokalnej sprzed tej wysyłki nie gasi jej `running`.
    const generation = ++this.#turnGuard.sendGeneration;
    const echo = opts?.echo;
    const command = opts?.command;
    const ticket = this.#promptQueue.expectSend(opts?.source); // The session now, the sender and the `202`'s wait.
    this.#enqueue(async () => {
      // Echo odroczone: każda droga, która kończy zadanie bez promptu w panelu, oddaje
      // token przez `#refuseEcho` — jawnie PRZED ostrzeżeniem (ma stać pod dymkiem), a `finally`
      // jest siatką dla dróg bez ostrzeżenia. Drugie oddanie tego samego tokenu manager pomija.
      let delivered = false;
      try {
        await this.#sendTask(text, images, files, echo, command, generation, () => { delivered = true; }, ticket);
      } finally {
        if (!delivered) this.#refuseEcho(echo);
        ticket.chosen(); // The net: a task that ended before choosing a path does not hold the `202`.
      }
    });
  }

  /** The last `send()` has its path and, if it parked, its entry on disk: the manager's `202` waits. */
  readonly queueSaved = (): Promise<void> => this.#promptQueue.saved();

  /** The queue take-back ({@link QueueTakeBack.run}) as a step of the chain; a step that threw refuses. */
  async takeBackQueue(onFirstKey?: () => void): Promise<QueueTakeBackResult> {
    return await this.#enqueue(() => this.#takeBack.run(onFirstKey)) ?? { refused: 'unknown' };
  }

  /**
   * Odmowa wysyłki z wyjątku (strażnik tekstu, wgrywanie załączników): echo wraca, a użytkownik dostaje zdanie
   * „nie wysłano” z powodem. Wspólna dla przyjęcia wiadomości i strażnika przed klawiszem wpisu z kolejki wklejeń.
   */
  #refuseMessage(err: unknown, echo: string | undefined): void {
    if (err instanceof HerdrCommandRefusedError) {
      this.#audit({ method: 'refuse', reason: 'command-not-allowed', command: err.command });
    }
    this.#refuseEcho(echo);
    // Powód własny Raroga bez argumentów (odmowa strażnika) jedzie kodem; z argumentami i obcy tekstem
    // w ramie „nie wysłano”, żeby było widać, że wiadomość nie poszła.
    const reason = reasonOfError(err);
    this.#system('code' in reason ? say('commands.send-refused', { reason: reason.code })
      : say('commands.send-failed', { reason: reason.text }));
  }

  async #sendTask(
    text: string, images: readonly string[] | undefined, files: readonly FileAttachment[] | undefined,
    echo: string | undefined, command: SendCommand | undefined, generation: number, onDelivered: () => void,
    ticket: SendTicket,
  ): Promise<void> {
    // Zadanie następnej wysyłki (w kolejce, nie przy przyjęciu) kończy zgodę na czyszczenie pola sprzed niej.
    this.#turnGuard.blockedLeftover = null;
    let finalText = text;
    // Komenda rozpoznana przez managera. Bez strażnika driver jej NIE zgaduje z tekstu: wtedy
    // wołający gwarantuje walidację, a tekst bez klasyfikacji jedzie jak prompt (ze stall-guardem).
    let slash: SlashCommand | null = command?.slash ?? null;
    // Migawka katalogu strażnika: wiadomość w kolejce wklejeń przechodzi go jeszcze raz z aktualnym trybem.
    let catalog: CommandCatalog | undefined;
    try {
      const hasImages = images !== undefined && images.length > 0;
      const hasFiles = files !== undefined && files.length > 0;
      if (hasImages || hasFiles) {
        const uploads = this.#deps.uploads;
        if (uploads === undefined) {
          // Zdanie własne bez argumentów: catch niżej wysyła je podkodem ramy „nie wysłano”.
          throw new UploadError(say('uploads.module-missing'));
        }
        // Zdjęcia PRZED plikami i jednym blokiem: kolejność ścieżek w promptcie jest tą samą
        // kolejnością, w której użytkownik widzi miniatury i chipy nad polem tekstowym.
        const paths = [
          ...(hasImages ? await uploads.write(this.#cwd, images) : []),
          ...(hasFiles ? await uploads.writeFiles(this.#cwd, files) : []),
        ];
        finalText = appendAttachmentPaths(finalText, paths);
      }
      const guard = this.#deps.guard;
      if (guard !== undefined) {
        // Drugi strażnik: ta sama migawka katalogu co w managerze i ponowna klasyfikacja tekstu
        // po sanityzacji. Rozjazd z klasyfikacją managera = odmowa (fail-closed), bo od niej zależy,
        // czy tekst ominie stall-guard.
        catalog = command?.catalog ?? this.#deps.commandCatalog?.(this.#cwd) ?? registryCatalog();
        const checked = guard(finalText, {
          mode: this.#mode, cwd: this.#cwd, yoloRoots: this.#deps.yoloRoots, catalog,
        });
        finalText = checked.text;
        if (command !== undefined && !sameSlash(command.slash, checked.slash)) {
          // Powód własny Raroga: jedzie kodem (podkod), żeby apka przetłumaczyła całe zdanie.
          this.#refuseEcho(echo);
          this.#system(say('commands.send-refused', { reason: 'commands.command-mismatch' }));
          return;
        }
        slash = checked.slash;
      }
    } catch (err) {
      // Tu jesteśmy tylko wtedy, gdy manager NIE zwalidował tekstu przed przejściem stanu
      // (poprawna ścieżka: 400/429 wraca na POST). Wysyłki nie ma i użytkownik ma to widzieć.
      this.#refuseMessage(err, echo);
      return;
    }

    if (this.#disposed) return;
    // The wait behind a command dialog the driver confirmed comes before the path: every premise below is read after it.
    const dialogStands = await this.#commandSettle.settle();
    if (this.#disposed) return;
    /*
     * Panel Claude w trakcie tury (albo z wiadomością, która już czeka, albo zaraz po Enterze takiej wiadomości,
     * którego skutku driver jeszcze nie zna): wklejenie, sprawdzenie i osobny Enter
     * ({@link PromptQueue.drainPrompts}). Bramki odmowy niżej tej drogi nie dotyczą: dialog, który stoi, wstrzymuje wiadomość do
     * swojego końca, zamiast ją odrzucać. Pozostałość w polu czyści próba wpisu, po sprawdzeniu, że nic nie stoi
     * (`PromptQueue`). Slash-komenda zostaje przy `agent.prompt`, ale za czekającą wiadomością nie
     * idzie: jej tekst może stać w polu, a komenda dopisana za nim wysłałaby go.
     * A message herdr does not show mid-turn yet asks a fresh registry read (`PromptQueue.registryInTurn`); the
     * premises are read again after it, because a `working` status may arrive while the read is pending. A wait that
     * ended on a dialog holds the message the same way.
     */
    const queued = (): boolean => dialogStands || this.#midTurn || this.#promptQueue.prompts.length > 0
      || this.#promptQueue.submitUnsettled() || this.#takeBack.holdsField();
    if (this.#engine === 'claude' && (queued() || (slash === null && (await this.#promptQueue.registryInTurn() || queued())))) {
      if (this.#disposed) return;
      if (slash === null) {
        this.#promptQueue.parkPrompt(finalText, echo, generation, catalog, onDelivered, ticket);
        await this.#promptQueue.drainPrompts();
        return;
      }
      if (this.#promptQueue.prompts.length > 0) {
        this.#refuseEcho(echo);
        this.#system(CLI_DIALOG_SEND_MESSAGE);
        return;
      }
      if (this.#takeBack.holdsField()) {
        // A command typed after the taken text would send that text with it.
        this.#refuseEcho(echo);
        this.#system(STALLED_PROMPT_MESSAGE);
        return;
      }
    }
    ticket.chosen(); // Not the paste queue: nothing of this message is on disk, the `202` may go.
    if (await this.#consentDialogStands()) {
      this.#refuseEcho(echo);
      this.#system(CONSENT_DIALOG_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    if (await this.#formReserve.formStandsNow()) {
      this.#refuseEcho(echo);
      this.#system(FORM_STANDS_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    // A command or another engine's message never goes past the dialog the wait ended on.
    if (dialogStands || await this.#cliReserve.cliDialogStandsNow()) {
      this.#refuseEcho(echo);
      this.#system(CLI_DIALOG_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    // Po bramkach wyżej, nie przed nimi: blokada hooka poprzedniej wysyłki, która przyjdzie w ich trakcie,
    // ustawia `#needsEscape` i tu jeszcze zdąży wyczyścić pole z tamtego promptu.
    // A move during the clearing stops it before its next Esc pair; the check right below refuses the message.
    if (this.#promptQueue.sessionMoved(ticket.session, echo) || !(await this.#clearLeftovers(echo, ticket.away))) return;

    // Last SYNCHRONOUS checks before `prompt`: while the field cleared, a registry hold or a new conversation came.
    if (this.#cliReserve.cliHold) {
      this.#refuseEcho(echo);
      this.#system(CLI_DIALOG_SEND_MESSAGE);
      return;
    }
    if (this.#promptQueue.sessionMoved(ticket.session, echo)) return;
    const midTurn = this.#midTurn;
    /*
     * A command the CLI runs inside the turn without a call or output entry: no output to wait for, and its echo lives
     * only briefly. The turn can end before the Enter, and then the CLI writes the call as in idle, which the echo
     * clears (CLI 2.1.325, `IN_TURN_COMMAND_ECHO_MS`).
     */
    const silent = midTurn && slash !== null && silentInTurn(slash);
    // Rejestracja echa PRZED `prompt`: plik jsonl potrafi urosnąć szybciej, niż wróci
    // odpowiedź z gniazda, a echo zarejestrowane po fakcie już niczego nie wycina.
    // Numer wysyłki we wpisie okna: wpis blokady hooka (~350 ms po `prompt`) wskaże dokładnie tę wysyłkę.
    this.#follower?.dropEcho(finalText, echo, generation,
      silent ? this.#deps.inTurnCommandEchoMs ?? IN_TURN_COMMAND_ECHO_MS : undefined);
    this.#turnGuard.executedGeneration = generation;
    // Z tego samego powodu PRZED `prompt` czekamy na wynik komendy lokalnej.
    this.#turnGuard.localCommand = slash?.kind === 'local' && !silent
      ? { name: slash.name.toLowerCase(), followAt: this.#lastFollowAt, output: false, armed: false, generation }
      : null;
    /*
     * Slash-komenda z katalogu sesji (`/compact`, `/clear`…) jedzie BEZ `wait` — nie startuje
     * tury, więc detekcja stalla dałaby fałszywy alarm. Tak samo wysyłka do panelu W ŚRODKU
     * TURY innego silnika niż Claude: CC kolejkuje dopisany tekst i albo
     * wchłonie go w trwającą turę, albo wyśle po niej (oba losy zmierzone), ale przejścia
     * `idle→working` nie będzie, więc `wait` kończyłby się timeoutem herdr
     * i fałszywym „Wysyłka nie powiodła się" przy dostarczonej wiadomości. Cała reszta
     * przechodzi przez stall-guard: `wait` + jedno ponowienie po potwierdzeniu ekranem.
     */
    const outcome = slash !== null || midTurn
      ? (await this.#send(
        () => this.#deps.client.prompt(this.#paneId, finalText),
        promptEntry(finalText, ticket.source),
        'message', echo,
      ) ? 'sent' : 'failed')
      : await this.#promptWithStallGuard(finalText, echo, generation, ticket);
    if (outcome === 'failed') {
      this.#turnGuard.localCommand = null;
      return;
    }
    // Prompt doszedł do panelu — także zablokowany przez hook: odmowę niesie notka, nie ostrzeżenie wysyłki.
    onDelivered();
    if (outcome === 'sent' && slash === null && !midTurn) this.#returnedPrompt.noteSent(finalText);
    this.#turnGuard.afterSubmit(outcome === 'blocked', slash, echo, generation, silent);
  }

  /**
   * Pozostałość w polu przed wysyłką: `#needsEscape` (tekst zostawił Rarog) albo niewzięty wstrzymany prompt —
   * para Esc tylko na potwierdzone pełne pole ({@link #clearComposer}). `false` = wysyłka nie idzie (klawisze nie
   * poszły albo `dispose()`); echo oddał już `#send` albo zrobi to siatka w `send()`. `away` (the ticket's
   * conversation check) runs after every field read, right before each Esc pair, and stops the clearing without a key.
   */
  async #clearLeftovers(echo: string | undefined, away: () => boolean): Promise<boolean> {
    if (this.#needsEscape) {
      // Pole i tak czyści cała para — pozostałość wstrzymanego promptu razem z resztą.
      this.#promptQueue.heldLeftover = null;
      // Kolejność jest istotna: najpierw czyścimy pole, potem czekamy, dopiero potem piszemy.
      const cleared = await this.#clearComposer(echo, away);
      return cleared && !this.#disposed;
    }
    if (this.#promptQueue.heldLeftover !== null) {
      // Niewzięty wstrzymany prompt: para Esc tylko wtedy, gdy pole DALEJ trzyma dokładnie jego treść.
      const leftover = this.#promptQueue.heldLeftover;
      this.#promptQueue.heldLeftover = null;
      if (await this.#fieldHoldsExactly(leftover)) {
        const cleared = await this.#clearComposer(echo, away);
        if (!cleared) return false;
      }
    }
    return !this.#disposed;
  }

  /** Port kolejki wklejeń: stan drivera, który kolejka czyta, i kroki, które zostają w fasadzie. */
  #promptQueuePort(): PromptQueuePort {
    const driver = this;
    return {
      disposed: () => this.#disposed,
      paneId: () => this.#paneId,
      mode: () => this.#mode,
      agentSessionId: () => this.#agentSessionId,
      driverHold: () => {
        if (this.#consentDialog !== null || this.#formReserve.formFallback !== null) return { kind: 'driver' };
        if (this.#status !== 'blocked' && !this.#cliReserve.cliHold) return null;
        // Both counters only grow, so the sum changes whenever either hold begins.
        return { kind: 'status', generation: this.#blockedStarts + this.#cliReserve.cliHoldStarts };
      },
      consentCardStands: () => this.#consentChannel.consentCardStands(true),
      cliWaiting: () => this.#cliReserve.cliWaiting !== null,
      send: (call, entry, op, echo) => this.#send(call, entry, op, echo),
      enqueue: (step) => this.#enqueue(step),
      refuseMessage: (err, echo) => { this.#refuseMessage(err, echo); },
      refuse: (echo, sentence) => { this.#refuseEcho(echo); this.#system(sentence); },
      leftover: {
        get needsEscape(): boolean { return driver.#needsEscape; },
        set needsEscape(value: boolean) { driver.#needsEscape = value; },
      },
      beforeSubmit: (generation) => {
        this.#turnGuard.executedGeneration = generation;
        this.#turnGuard.localCommand = null;
      },
      afterSubmit: (echo, generation) => { this.#turnGuard.afterSubmit(false, null, echo, generation); },
    };
  }

  /** Port of the queue take-back: the gates' view of the driver, the audit line and the chain. */
  #takeBackPort(): QueueTakeBackPort {
    const { disposed, paneId, agentSessionId, driverHold, consentCardStands, cliWaiting } = this.#promptQueuePort();
    return {
      disposed, paneId, agentSessionId, driverHold, consentCardStands, cliWaiting,
      audit: (entry) => { this.#audit(entry); },
      enqueue: (step) => this.#enqueue(step),
    };
  }

  /** Port of the turn guard: driver state it reads and steps that stay in the facade. */
  #turnGuardPort(): TurnGuardPort {
    const driver = this;
    return {
      disposed: () => this.#disposed,
      status: () => this.#status,
      blockedNow: () => this.#blockedNow(),
      lastFollowAt: () => this.#lastFollowAt,
      paneId: () => this.#paneId,
      emitState: (status) => { this.#emitState(status); },
      emit: (event) => { this.#emit(event); },
      system: (text) => { this.#system(text); },
      refuseEcho: (echo) => { this.#refuseEcho(echo); },
      leftover: {
        get needsEscape(): boolean { return driver.#needsEscape; },
        set needsEscape(value: boolean) { driver.#needsEscape = value; },
      },
      expectTranscript: () => { this.#follower?.expectTranscript(); },
      enqueue: (step) => this.#enqueue(step),
      clearComposer: (echo, stop) => this.#clearComposer(echo, stop),
    };
  }

  /** Port of the layer 2 card: the CLI class and episode, the lock, a fresh read and the episode audit line. */
  #layer2CardPort(): Layer2CardPort {
    return {
      cliClass: () => this.#cliReserve.cliWaiting,
      cliEpisode: () => this.#cliReserve.cliEpisode,
      cliHold: () => this.#cliReserve.cliHold,
      engineSession: () => this.#agentSessionId,
      activeReqId: () => this.#activeReq?.reqId ?? null,
      blockedSeq: () => this.#blockedSeq,
      readFresh: () => this.#readDialog(true),
      screenCached: () => this.#screenCached(),
      sleep: (ms) => this.#sleep(ms),
      now: () => this.#scheduler.now(),
      live: () => !this.#disposed && this.#blockedNow(),
      audit: (fields) => { this.#audit({ method: 'layer2-episode', ...fields }); },
    };
  }

  #layer2StepPort(): Layer2StepPort {
    return {
      live: () => !this.#disposed && this.#blockedNow(),
      disposed: () => this.#disposed,
      keyShield: () => this.#promptQueue.keyShield('dialog'),
      keyHookWaits: () => this.#promptQueue.keyHookWaits(),
      engineSession: () => this.#agentSessionId,
      readFresh: () => this.#readDialog(true),
      sendKey: (key, entry, denied) => this.#layer2SendKey(key, entry, denied),
      audit: (entry) => { this.#audit(entry); },
      system: (text) => { this.#system(text); },
      reevaluate: () => { this.#scheduleEvaluate(); },
      sleep: (ms) => this.#sleep(ms),
      enqueue: (step) => this.#enqueue(step),
      warn: (line) => { this.#deps.logger?.(line); },
    };
  }

  /** The key of a layer 2 card with today's cycle after it; snapshot of the decided shield before the key. */
  async #layer2SendKey(key: Layer2Key, entry: Layer2StepEntry, denied: boolean): Promise<boolean> {
    const answered = this.#activeReq;
    if (answered === null) return false;
    const [seq, hookAt, pendingAt, text] = [this.#blockedSeq, this.#hookGeneration(), this.#pending, this.#screenText];
    const shot = { bodyPrint: parseOptions(text ?? '')?.bodyPrint ?? null, screenReqId: this.#screenIdentity(text) };
    const { client } = this.#deps;
    const sent = await this.#send(() => (key.via === 'keys'
      ? client.sendKeys(this.#paneId, key.keys) : client.sendDialogKey(this.#paneId, key.key)), {
      ...entry, ...approveContext(this.#refusals),
    });
    if (!sent) return false;
    this.#noteDecided(answered, seq, hookAt, pendingAt, shot);
    // Only this card: a newer one that replaced it during the key has already reported it gone (`#applyDecision`).
    if (denied && this.#activeReq === answered) this.#clearActive('layer 2 deny');
    if (!this.#disposed) this.#rearmAfterScreenAnswer(answered);
    return true;
  }

  /** Port of the two fallbacks: each module types only its own part, at most 14 members. */
  #reservePort(): FormReservePort & CliReservePort {
    return {
      disposed: () => this.#disposed,
      status: () => this.#status,
      stateChangeSeq: () => this.#stateChangeSeq,
      agentSessionId: () => this.#agentSessionId,
      consentDialog: () => this.#consentDialog,
      pending: () => this.#pending,
      readDialog: (force) => this.#readDialog(force),
      screenAt: () => this.#screenAt,
      answerShieldUp: () => this.#answerShieldUp(),
      answeredAt: () => Math.max(this.#answeredAt, this.#answeredHookCall?.at ?? 0),
      blockedNow: () => this.#blockedNow(),
      newBlock: () => {
        this.#blockedSeq += 1;
        this.#blockedAt = this.#scheduler.now();
      },
      emitState: (status) => { this.#emitState(status); },
      syncBlockedPoll: () => { this.#syncBlockedPoll(); },
      clearActive: (reason) => { this.#clearActive(reason); },
      evaluate: () => this.#evaluate(),
    };
  }

  /** Port of the refusals: the card, screen and registry state they read and the steps that stay here. */
  #refusalPort(): RefusalPort {
    return {
      deps: this.#deps,
      scheduler: this.#scheduler,
      paneId: () => this.#paneId,
      agentSessionId: () => this.#agentSessionId,
      screenText: () => this.#screenText,
      activeReq: () => this.#activeReq,
      pending: () => this.#pending,
      cliWaiting: () => this.#cliReserve.cliWaiting,
      resolveOptions: (text, expected) => this.#resolveOptions(text, expected),
      audit: (entry, at) => { this.#audit(entry, at); },
      system: (text) => { this.#system(text); },
      clearActive: (reason) => { this.#clearActive(reason); },
      scheduleEvaluate: () => { this.#scheduleEvaluate(); },
    };
  }

  /**
   * Wysyłka z tokenem echa odroczonego nie doszła do panelu: wpis z okna echa wypada (inaczej
   * identyczny prompt wysłany potem trafiłby na sierotę), a manager dostaje `echo-refused` i spłukuje
   * wstrzymaną wiadomość. Wołane PRZED ostrzeżeniem, żeby to stało pod dymkiem.
   */
  #refuseEcho(echo: string | undefined): void {
    if (echo === undefined) return;
    this.#follower?.forgetEcho(echo);
    this.#emit({ type: 'echo-refused', token: echo });
  }

  /**
   * Prompt z detekcją zawieszenia.
   *
   * `agent_prompt_stalled` na ścieżce z `wait` znaczy „panel nie wszedł w `working`" — czyli
   * najpewniej Enter przepadł, a tekst wisi w composerze. Zanim jednak cokolwiek ponowimy,
   * dwie bramki fail-closed, bo cena pomyłki jest wyższa niż cena stalla:
   *
   * 1. **Znaki życia** (status `working`/`blocked` albo ruch w jsonl), sprawdzane dwa razy
   *    z odstępem: tura szybsza niż detekcja herdr wygląda z zewnątrz jak stall, a ponowienie
   *    wysłałoby wiadomość DRUGI raz.
   * 2. **Potwierdzenie ekranem**: composer musi trzymać początek naszego tekstu. Bez tego
   *    żadnego `escape` — Esc na pustym polu przybliża CC do rewinda (otwiera go PARA), a stall
   *    bez tekstu na ekranie znaczy „nie wiem, co się stało" (rozstrzyga watchdog, nie my).
   *
   * Ponowienie składa się WYŁĄCZNIE z operacji już dozwolonych (`escape`, `prompt`) — klawisz
   * `enter` celowo nie wchodzi na allow-listę (Enter nad dialogiem, który wjechał
   * w międzyczasie, zatwierdziłby podświetloną opcję po POZYCJI). Echo followera zarejestrował
   * już wołający i ma je zarejestrowane RAZ — druga rejestracja przy ponowieniu mogłaby zjeść
   * identyczną wiadomość wpisaną ręcznie w terminalu w oknie TTL.
   *
   * 3. **Blokada hooka** `UserPromptSubmit` rozstrzyga wysyłkę (`blocked`): wpis blokady w pliku też jest
   *    zdarzeniem followera, więc po nim `#turnAlive` dałoby fałszywe „żyje”, a ekran z promptem
   *    oddanym do pola — fałszywe „trzyma prompt” i drugi `prompt`, który hook zablokowałby znowu.
   *    Dlatego `blocked` sprawdzamy po KAŻDYM `await`, zawsze przed
   *    `#turnAlive` i odczytem ekranu: bez Esc, bez drugiego `prompt`, bez „prompt utknął”.
   *
   * 4. **The message's conversation** (`ticket.session`) is checked again before the clearing, after every field read
   *    inside it (right before each Esc pair) and right before the second `prompt`: a pane that moved to another
   *    conversation during the screen read or the clearing gets no key of this message. A move during the settle
   *    counts as a sign of life (the follower moved) and sends nothing.
   *
   * @returns `sent`, gdy prompt uznajemy za wysłany (także optymistycznie — watchdog domknie),
   *   `blocked`, gdy wysyłkę rozstrzygnęła blokada hooka, `failed` przy każdej porażce
   */
  async #promptWithStallGuard(
    text: string, echo: string | undefined, generation: number, ticket: SendTicket,
  ): Promise<'sent' | 'blocked' | 'failed'> {
    const { source } = ticket;
    const moved = (): boolean => this.#promptQueue.sessionMoved(ticket.session, echo);
    const followAt = this.#lastFollowAt;
    const first = await this.#promptAttempt(text, echo, source);
    if (this.#disposed) return 'failed';
    if (this.#turnGuard.sendBlocked(generation)) return 'blocked';
    if (first !== 'stalled') return first === 'ok' ? 'sent' : 'failed';
    if (this.#turnAlive(followAt)) return 'sent';
    await this.#sleep(this.#stallSettleMs);
    if (this.#disposed) return 'failed';
    if (this.#turnGuard.sendBlocked(generation)) return 'blocked';
    if (this.#turnAlive(followAt)) return 'sent';
    const holds = await this.#screenHoldsPrompt(text);
    if (this.#disposed) return 'failed';
    if (this.#turnGuard.sendBlocked(generation)) return 'blocked';
    if (!holds) {
      // Ekran NIE trzyma naszego tekstu: prompt mógł wejść tuż przed odczytem — traktujemy
      // jak wysłany i zostawiamy rozstrzygnięcie watchdogowi. Zgłoszenie „nie wysłano" przy
      // wysłanym promptcie skończyłoby się ręcznym duplikatem od użytkownika.
      return 'sent';
    }
    if (moved()) return 'failed';
    // Stall potwierdzony: wyczyść composer tą samą drogą co `#needsEscape` — para Esc
    // weryfikowana ekranem (pojedynczy Esc NICZEGO nie czyści — zmierzone). Blokada,
    // która przyjdzie w trakcie odczytu pola, zatrzymuje czyszczenie PRZED parą Esc; so does a move to another
    // conversation, checked after every field read.
    const cleared = await this.#clearComposer(echo, () => this.#turnGuard.sendBlocked(generation) || ticket.away());
    if (this.#disposed) return 'failed';
    if (this.#turnGuard.sendBlocked(generation)) return 'blocked';
    if (!cleared || moved()) return 'failed';
    const second = await this.#promptAttempt(text, echo, source);
    if (this.#disposed) return 'failed';
    if (this.#turnGuard.sendBlocked(generation)) return 'blocked';
    if (second !== 'stalled') return second === 'ok' ? 'sent' : 'failed';
    if (this.#turnAlive(followAt)) return 'sent';
    this.#refuseEcho(echo);
    // Never for another conversation's field: a move since `followAt` moved `#lastFollowAt`, so `#turnAlive` held.
    this.#turnGuard.reportStalledPrompt();
    return 'failed';
  }

  /** Jedna próba `prompt` z `wait` + wpis dziennika; błędy inne niż stall lecą do transkryptu. */
  async #promptAttempt(text: string, echo?: string, source?: MessageSource): Promise<'ok' | 'stalled' | 'failed'> {
    try {
      await this.#deps.client.prompt(this.#paneId, text, true);
      this.#audit(promptEntry(text, source));
      return 'ok';
    } catch (err) {
      // Dziennik dostaje PRÓBĘ, nie sukces — jak w `#send`.
      this.#audit(promptEntry(text, source));
      if (herdrCode(err) === 'herdr-stalled') return 'stalled';
      this.#refuseEcho(echo);
      this.#reportSendError(err);
      return 'failed';
    }
  }

  /**
   * Czy panel jest W TURZE — jedno miejsce na ten warunek, bo czytają go trzy decyzje:
   * ścieżka wysyłki (bez stall-guarda w środku tury), znaki życia i wpis po przerwaniu.
   *
   * `blocked` liczy się jak `working`: agent stoi na dialogu W ŚRODKU tury, więc jest co przerwać.
   */
  get #midTurn(): boolean {
    return this.#status === 'working' || this.#status === 'blocked';
  }

  /** Znaki życia tury od migawki `followAt`: panel ruszył albo jego pliki mówią. */
  #turnAlive(followAt: number): boolean {
    return this.#midTurn || this.#lastFollowAt > followAt;
  }

  /**
   * Odczyt ekranu pod stall-guard: samo pytanie o obraz panelu, regułę liczy `herdr/commands.ts`.
   *
   * Błąd odczytu = brak potwierdzenia (fail-closed: bez ponowienia).
   */
  async #screenHoldsPrompt(text: string): Promise<boolean> {
    let screen: string;
    try {
      screen = (await this.#deps.client.readScreen(this.#paneId, 'detection')).text;
    } catch {
      return false;
    }
    if (this.#disposed) return false;
    return screenHoldsNeedle(screen, text);
  }

  /**
   * Czy CAŁE pole promptu (obszar między liniami ramki) trzyma dokładnie tę treść (bez białych znaków) — warunek
   * pary Esc przed wysyłką po niewziętym wstrzymanym prompcie. Błąd odczytu i pole nieczytelne = `false`.
   */
  async #fieldHoldsExactly(squashed: string): Promise<boolean> {
    try {
      const region = composerRegionText((await this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi')).text);
      return region !== null && squashWhitespace(region) === squashed;
    } catch {
      return false;
    }
  }

  /**
   * Stan composera z ekranu — parsowanie w `herdr/commands.ts`; błąd odczytu = `unknown`.
   *
   * Odczyt Z ATRYBUTAMI (`visible` + `ansi`), nie z `detection`: parser odróżnia treść od
   * przyciemnionej podpowiedzi CLI po SGR, a `detection` jest zawsze odarte z sekwencji.
   * Odmowa gniazda (także starszy herdr bez `format`) = `unknown` = zero klawiszy — pomyłka
   * w drugą stronę (para Esc na pustym polu) otwiera rewind, patrz `#clearComposer`.
   */
  async #readComposer(): Promise<'filled' | 'empty' | 'unknown'> {
    try {
      return composerStateFrom(
        (await this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi')).text,
      );
    } catch {
      return 'unknown';
    }
  }

  /**
   * Czyszczenie composera przed wysyłką (mechanizm `#needsEscape` i ponowienie stalla).
   *
   * Semantyka Esc w CC zmierzona na żywym panelu:
   * - pojedynczy Esc na niepustym polu NIC nie czyści — pokazuje tylko „Esc again to clear",
   *   a podpowiedź wygasa po ~1 s;
   * - para `esc esc` w JEDNYM `send_keys` czyści niepuste pole w całości;
   * - para na PUSTYM polu otwiera rewind, który zjada kolejne wysyłki.
   * Dlatego: czytamy composer z ekranu i parę wysyłamy WYŁĄCZNIE na potwierdzone niepuste
   * pole, z ponowną weryfikacją po każdej parze (najwyżej `COMPOSER_CLEAR_ATTEMPTS` par).
   * `empty`/`unknown` = zero klawiszy.
   *
   * @param stop sprawdzane po każdym odczycie pola, PRZED parą Esc: `true` kończy czyszczenie bez klawiszy
   *   (stall-guard — blokada hooka rozstrzygnęła wysyłkę w trakcie odczytu; a send's clearing: the pane moved to
   *   another conversation); wołający sprawdza powód sam
   * @returns `false` wyłącznie przy nieudanej wysyłce klawiszy albo `dispose()` w trakcie
   */
  async #clearComposer(echo?: string, stop?: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < COMPOSER_CLEAR_ATTEMPTS; attempt += 1) {
      const composer = await this.#readComposer();
      if (this.#disposed) return false;
      if (stop?.() === true) return true;
      if (composer !== 'filled') return true;
      const sent = await this.#send(
        () => this.#deps.client.sendKeys(this.#paneId, ['escape', 'escape']),
        { method: 'send_keys', keys: ['escape', 'escape'] },
        'message', echo,
      );
      if (!sent || this.#disposed) return false;
      await this.#sleep(this.#deps.escSettleMs ?? ESC_SETTLE_MS);
      if (this.#disposed) return false;
    }
    // Po wyczerpaniu prób i tak piszemy: kolejne odmowy wyglądałyby jak martwy composer.
    return true;
  }

  /**
   * Decyzja o czekającym narzędziu.
   *
   * `deny` nie potrzebuje ani cyfr, ani zgodnego `reqId`: `escape` na dialogu zgody to odmowa, a odmowa nie daje
   * narzędziu żadnego prawa. Esc nie wszędzie jest jednak tylko odmową: na dialogu zaufania katalogu zamyka
   * `claude` (pomiar na CLI 2.1.299), a na pauzie „Session paused” (`#pauseBlocksEscape`) nie nazywa
   * go żadna stopka, więc przy blokadzie pauzy decyduje świeży ekran. `allow` przechodzi tylko
   * wtedy, gdy karta pochodzi z udanego cross-checku ekran ↔ jsonl i ma DOKŁADNIE jedną opcję
   * „tak, ten jeden raz" — inaczej jest no-opem z wyjaśnieniem w transkrypcie.
   */
  /*
   * Metoda NIE JEST `async` z tego samego powodu co `interrupt()`: bramka zasięgu
   * (`#assertInScope`) ma rzucić NA WYWOŁANIU, a nie odrzuconą obietnicą — 400 dla panelu
   * poza `RAROG_HERDR_ROOTS` wraca właśnie tą drogą.
   */
  respondPermission(
    reqId: string, decision: 'allow' | 'allow-always' | 'deny', message?: string,
  ): Promise<DecisionOutcome> {
    void message;
    this.#assertInScope();
    if (this.#disposed) return Promise.resolve(STALE);
    if (decision === 'deny') {
      // Bound to the card standing now, before the queue: a layer 2 card takes it only through its step.
      const bound = this.#layer2Step.bindEscape(this.#activeReq);
      const step = this.#enqueue(async () => {
        // Tryb cienia: plik cienia PRZED klawiszem, reszta kroku bez zmian (bez kanału `shadow` = `null`).
        const shadow = this.#shadowChannel() === undefined ? null : await this.#shadowStep('deny', this.#activeReq);
        // Jedyny wyjątek od „deny zawsze”: pauza „Session paused” — świeży ekran tuż przed klawiszem.
        const pause = await this.#pauseBlocksEscape();
        if (pause.blocks) {
          this.#shadowKeySent(shadow, false);
          if (this.#disposed) return STALE;
          return refuseDecision(
            this.#refusals, PAUSE_ESCAPE_MESSAGE, 'Esc na pauzie „Session paused”', 'terminal-only',
          );
        }
        if (this.#disposed) {
          this.#shadowKeySent(shadow, false);
          return STALE;
        }
        // Dialog przejęła karta kanału zgód (hook czeka na plik odpowiedzi), także w trakcie świeżego odczytu wyżej:
        // `escape` zamknąłby dialog, na który odpowiada hook. Bez klawisza; karta z ekranu wygasa (410).
        if (this.#consentChannel.consentCardStands()) {
          this.#shadowKeySent(shadow, false);
          return STALE;
        }
        // The layer 2 occurrence bound above, or a layer 2 card issued since: never today's Esc below.
        const layer2 = this.#layer2Step.escapeBound(bound);
        if (layer2 !== null) {
          this.#shadowKeySent(shadow, false);
          return layer2;
        }
        // Migawka osłony po decyzji PRZED klawiszem: `escape` zamyka dialog, który stoi
        // TERAZ, a w czasie `await` wysyłki mogą przyjść nowa blokada, nowa karta albo zrzut następnego.
        const denied = this.#activeReq;
        const seq = this.#blockedSeq;
        const hookAt = this.#hookGeneration();
        const pendingAt = this.#pending;
        // Ekran, w który idzie `escape` (świeży odczyt bramki pauzy): po klawiszu mówi, który dialog zamknięto.
        const resolvedText = pause.text;
        const ok = await this.#send(
          () => this.#deps.client.sendKeys(this.#paneId, ['escape']),
          { method: 'send_keys', keys: ['escape'], ...shadowAuditFields(shadow) },
        );
        this.#shadowKeySent(shadow, ok);
        // Odmowa zużywa zrzut hooka tak samo jak zgoda: po Esc
        // dialog już nie stoi, a plik żyłby dalej do TTL (10 min) i następny dialog INNEGO
        // narzędzia czytałby stary `tool_input`. Cross-check nazwy i tak by go odrzucił, ale
        // przy TYM SAMYM narzędziu (drugi `Bash` zaraz po odrzuconym) podstawiłby treść
        // poprzedniego wywołania. Sprzątamy wyłącznie po UDANEJ wysyłce — gdy `escape` nie
        // doszło, dialog stoi dalej i zrzut wciąż jest jego prawdziwym opisem. Wyjątek ten sam co po cyfrze:
        // zrzut `Bash` INNEGO dialogu, który czeka w kolejce za zamkniętym (`#clearHookAfterDecision`).
        if (!ok) return refuseSend(this.#refusals);
        const keptHookAt = this.#clearHookAfterDecision(this.#readHookFile(), resolvedText, denied);
        /*
         * Osłona po własnej decyzji także po `escape`. Karta BEZ przycisków jest
         * oceniana dalej, a skasowany zrzut zmienia bazę karty z przyciskami (`T~hook` → `T`) — ekran sprzed
         * przemalowania dałby wtedy kartę z przyciskami albo kartę bez przycisków zamykanego dialogu.
         *
         * Przy zostawionym zrzucie innego dialogu (`otherDialogDump`) odrzucona karta
         * przestaje być kartą, która stoi, jak po cyfrze (`#rearmAfterScreenAnswer`). Inaczej bramka „ta sama
         * karta" kończyłaby ocenę przed odczytem ekranu, dopóki źródła się nie zmienią, a zgoda subagenta w kolejce
         * za odrzuconym dialogiem nie dostałaby karty. Rozstrzygnięty dialog na ekranie zatrzymuje osłona. To karta
         * z wpisu albo zrzutu (`command`), więc manager zdjął ją już po `applied`; karta z ekranu gaśnie zwykłą drogą.
         */
        if (denied !== null) {
          this.#noteDecided(denied, seq, hookAt, pendingAt, {
            // Odcisk ekranu, w który poszedł `escape`, jak po cyfrze: ten sam dialog przed przemalowaniem trzyma osłona,
            // także przy karcie bez przycisków, która własnego odcisku nie ma.
            bodyPrint: resolvedText === null ? null : parseOptions(resolvedText)?.bodyPrint ?? null,
            screenReqId: this.#screenIdentity(resolvedText),
          }, keptHookAt);
          if (keptHookAt !== null && this.#activeReq === denied) this.#activeReq = null;
        }
        this.#dropScreen();
        // Esc zamyka też dialog zgody CLI — karta ma zgasnąć od razu, nie po tiku resyncu.
        if (this.#consentDialog !== null) await this.#noteConsentDialog(null);
        return APPLIED;
      });
      // `undefined` = krok wypadł z kolejki (driver zdążył pójść do `dispose`) — nie ma już
      // czego odrzucać ani czego zdejmować, więc to jest `stale`, nie odmowa.
      return step.then((outcome) => outcome ?? STALE);
    }

    const active = this.#activeReq;
    if (active === null) return Promise.resolve(STALE);
    /*
     * Zatwierdzenie musi trafić w TĘ kartę, w którą tapnięto — także ekranową. A gate that let any `reqId` through
     * to any `screen: true` card would land a hold started on a full consent card in the fallback card without
     * options that replaced it, ending in "which option, unknown" instead of the truth.
     *
     * Jedyny dozwolony rozjazd: adresowanie SESJĄ (`reqId` = id sesji, `#decideHerdrDialog`)
     * dla dialogu z zamkniętej listy sygnatur — taka karta nie ma wpisu w pending managera,
     * więc nie ma własnego `reqId`, a `allow` filtruje już manager (`herdrDialog` musi stać).
     * Każdy inny rozjazd to tapnięcie w kartę, której już nie ma — mówimy o tym GŁOŚNO,
     * dokładnie jak `answerQuestion`; cisza wyglądała jak „tapnąłem i nic".
     */
    if (active.reqId !== reqId) {
      const sessionAddressed = active.screen === true
        && active.toolName.startsWith(`${SCREEN_DIALOG_TOOL}:`);
      if (!sessionAddressed) return Promise.resolve(reportStaleDecision(this.#refusals));
    }
    const held = layer2KeyRefusal(this.#refusals);
    if (held !== null) return Promise.resolve(held);
    /*
     * Dialog z listy `TERMINAL_DIALOGS` nie ma opcji do zatwierdzenia z telefonu: każda jest
     * `terminalOnly`. Odmowa stoi przed szukaniem opcji, bo `affirmativeOption`/`alwaysOption` patrzą na
     * etykiety, nie na flagę — przyszła opcja „Yes…” w takim dialogu nie ma prawa stać się celem tapnięcia.
     */
    if (active.terminalDialog !== undefined) {
      return Promise.resolve(refuseDecision(this.#refusals,
        TERMINAL_DIALOG_MESSAGE, 'dialog z listy terminalowej', 'terminal-only',
      ));
    }
    /*
     * Lista opcji jest tu jedyną bramką i jest pusta wszędzie tam, gdzie Rarog nie wie, co
     * zatwierdza: karta po rozjeździe nazwy narzędzia i dialog spoza ZAMKNIĘTEJ listy
     * sygnatur dostają `[]`, więc „zatwierdź" kończy się zdaniem, a nie klawiszem.
     */
    /*
     * `allow-always` wybiera opcję eskalującą JAWNIE: opcja
     * „Yes, and don't ask again…" idzie z Raroga wyłącznie przez WŁASNY
     * przycisk z dosłowną etykietą, nigdy jako skutek zwykłego „Zatwierdź". Oba warianty
     * przechodzą przez ten sam `#sendDigit`, czyli przez świeży odczyt ekranu
     * (`#digitStillHolds`) i dziennik z etykietą tego, co naprawdę zatwierdzono.
     */
    // Dialog sieci sandboksa: tylko „Yes”, bez „zawsze”.
    // Karta nie niesie przycisku „zawsze", a ta bramka zamyka go też dla starego
    // albo obcego klienta — „don't ask again for <host>" zostaje do wybrania przy biurku.
    if (decision === 'allow-always' && active.toolName === SANDBOX_NETWORK_TOOL) {
      return Promise.resolve(refuseDecision(this.#refusals,
        TERMINAL_ONLY_MESSAGE, 'sieć sandboksa: tylko zgoda jednorazowa', 'terminal-only',
      ));
    }
    /*
     * Dialog zaufania BEZ cyfr: karta nie ma opcji, a zatwierdzenie idzie osobną ścieżką `down`/`enter`
     * po dowodzie ze świeżego ekranu. `allow-always` nie ma tu opcji, którą by wybierał.
     */
    if (active.trustArrow !== undefined && decision === 'allow') return this.#approveTrustArrow(active, active.trustArrow);
    const option = decision === 'allow-always'
      ? alwaysOption(active.options)
      : affirmativeOption(active.options);
    if (option === null) {
      return Promise.resolve(refuseDecision(this.#refusals,
        NO_DIGIT_MESSAGE,
        decision === 'allow-always'
          ? 'brak jednoznacznej opcji „nie pytaj więcej"'
          : 'zgoda bez jednoznacznej opcji „tak"',
        'no-digit',
      ));
    }
    return this.#sendDigit(option, active, true);
  }

  /**
   * Answer to `AskUserQuestion`: TWO channels, the same card.
   *
   * 1. **Hook channel**, when the card carries it: Rarog writes the answer file, and the sleeping
   *    `PermissionRequest` hook process hands it to the CLI as `allow` with `updatedInput.answers`
   *    (docs: hooks, "PermissionRequest decision control"). Not a SINGLE key goes to the pane, so
   *    there are no tabs, no `multiSelect` and no review screen here: the card carries the WHOLE set
   *    of the form's questions, and they all travel in one file.
   * 2. **Digit from the screen**: the older channel and the ONLY one for a session without the hook.
   *    The label TEXT picks the digit, never the position in the list: a choice by position could
   *    confirm something other than what the person sees on the card.
   *
   * The second channel is also the FALLBACK of the first: when nobody consumes the file within a few
   * seconds (the hook died, the session has none, the desk answered first), Rarog deletes the file and
   * sends the digit for the FIRST question, the only one standing on the screen. This gives no double
   * answer: the digit goes through `#digitStillHolds`, a fresh screen read, and a form settled in the
   * meantime refuses it by itself.
   *
   * The channel is used only with a COMPLETE set of answers (as many groups as questions, each
   * non-empty): `allow` closes the whole call, so a file with a gap would hand the model nothing for a
   * question nobody will ask again.
   */
  answerQuestion(
    reqId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<DecisionOutcome> {
    this.#assertInScope();
    if (this.#disposed) return Promise.resolve(STALE);
    if (isLayer2Id(reqId)) return this.#layer2Step.answer(reqId, answers);
    const active = this.#activeReq;
    if (active === null) return Promise.resolve(STALE);
    if (active.reqId !== reqId) return Promise.resolve(reportStaleDecision(this.#refusals));
    const target = active.hookAnswer;
    const complete = target !== undefined
      && answers.length === target.questions.length
      && answers.every((group) => group.length > 0);
    /*
     * NOTATKA jedzie WYŁĄCZNIE plikiem hooka (`annotations`). Cyfra notatki nie
     * dowiezie, więc odpowiedź z notatką NIGDY nie spada na tor cyfry: bez kanału — odmowa,
     * a karta zostaje ze szkicem człowieka (manager i tak przepuszcza notatkę tylko na kartach
     * z `notes: true`, czyli kanału hooka — to druga bramka, po stronie, która pisze).
     */
    const noted = notes?.some((note) => note !== null && note.trim() !== '') === true;
    if (noted && (target === undefined || !complete || this.#deps.hookAnswers === undefined)) {
      return Promise.resolve(refuseNote(this.#refusals, NOTE_NO_CHANNEL_MESSAGE));
    }
    if (target !== undefined && complete && this.#deps.hookAnswers !== undefined) {
      return this.#answerViaHook(active, target, answers, noted ? notes : undefined);
    }
    return this.#answerWithDigit(active, answers);
  }

  /**
   * Odpowiedź CYFRĄ z ekranu — ścieżka bez kanału hooka i fallback tego kanału.
   *
   * Z całej karty bierze DOKŁADNIE JEDNĄ grupę odpowiedzi: tę, której pytanie stoi na ekranie
   * ({@link screenAnswerIndex}). Karta jednozakładkowa ma ją pod zerem, karta kanału hooka —
   * pod indeksem dopasowanej zakładki; wybór po zerze zapisywałby odpowiedź na pytanie 1 jako
   * odpowiedź na pytanie 2 przy kolidujących etykietach.
   */
  #answerWithDigit(
    active: ActiveReq, answers: readonly (readonly string[])[],
  ): Promise<DecisionOutcome> {
    const index = active.hookAnswer === undefined
      ? 0
      : screenAnswerIndex(active.hookAnswer, active.question);
    // Kształt odpowiedzi do dziennika — same liczby, bez treści.
    const shape: AnswerShape = {
      channel: active.hookAnswer === undefined ? 'keys' : 'hook',
      hookTarget: active.hookAnswer !== undefined,
      answers: answers.length,
      target: active.hookAnswer?.questions.length ?? 0,
      index,
      groups: answers.map((group) => group.length),
    };
    if (index === -1) {
      return Promise.resolve(refuseDecision(this.#refusals,
        NO_DIGIT_MESSAGE, 'pytania z ekranu nie ma na karcie', 'no-digit', shape,
      ));
    }
    const first = answers[index] ?? [];
    /*
     * Formularz wielokrotnego wyboru ogłoszony przez AUTORA pytania nie przyjmuje cyfry
     * NIGDY: tam cyfra przełącza checkbox, a zatwierdza dopiero „Submit" + `enter`.
     * Bramka stoi tu, a nie tylko w `#digitStillHolds`, żeby powód odmowy mówił prawdę —
     * tamta oddaje `screen-changed`, choć ekran się nie zmienił.
     */
    if (active.multiSelect === true) {
      return Promise.resolve(
        refuseDecision(this.#refusals, MULTI_SELECT_MESSAGE, 'wielokrotny wybór', 'multi-select', shape),
      );
    }
    /*
     * PUSTA grupa to brak odpowiedzi na pytanie, które stoi w terminalu — nie wielokrotny
     * wybór. Jako `multi-select` człowiek czytałby
     * „Wielokrotny wybór zrób w terminalu" przy formularzu bez żadnego checkboxa.
     */
    if (first.length === 0) {
      return Promise.resolve(refuseDecision(this.#refusals,
        NO_ANSWER_ON_SCREEN_MESSAGE, 'brak odpowiedzi na pytanie z ekranu', 'no-digit', shape,
      ));
    }
    // Wielokrotny wybór wymagałby `space` + `enter`, czyli wyboru po POZYCJI.
    if (first.length !== 1) {
      return Promise.resolve(
        refuseDecision(this.#refusals, MULTI_SELECT_MESSAGE, 'wielokrotny wybór', 'multi-select', shape),
      );
    }
    const label = canonicalLabel(first[0] ?? '');
    /*
     * Werdykt OPUBLIKOWANEJ karty, przed szukaniem etykiety na ekranie: opcja, którą karta oznaczyła
     * `terminalOnly`, nie dostaje cyfry, choćby etykieta z ekranu znacznika nie miała. Karta z etykietami payloadu
     * liczy flagę na pełnej etykiecie, a opcje z ekranu są ucięte do `OPTION_LABEL_MAX_CHARS`. Porównanie idzie po
     * kluczu kanonicznym odpowiedzi, więc pełna etykieta i sam jej prefiks dostają tę samą odmowę.
     */
    if (active.terminalOnlyLabels?.includes(label) === true) {
      return Promise.resolve(
        refuseDecision(this.#refusals, TERMINAL_ONLY_MESSAGE, 'opcja tylko z terminala na karcie', 'terminal-only'),
      );
    }
    const option = active.options.find((candidate) => candidate.label === label);
    if (option === undefined) {
      return Promise.resolve(refuseDecision(this.#refusals,
        NO_DIGIT_MESSAGE, 'etykiety nie ma na żywej liście opcji', 'no-digit', shape,
      ));
    }
    /*
     * Bramka SERWEROWA, nie tylko UI: opcja eskalująca uprawnienia („always allow…") jest na
     * karcie widoczna, ale jej cyfra nie ma prawa wyjść z Raroga (jedno tapnięcie nie
     * zmienia trwale uprawnień). UI ją wyszarza, ale zaufanie do UI nie jest granicą — stary
     * albo obcy klient mógłby narysować przycisk mimo flagi.
     *
     * Etykietę z ekranu ocenia polityka opcji w kanale cyfry (`optionPolicy`), ta sama, która dała `terminalOnly`
     * karcie z ekranu; lista z karty z etykietami payloadu stoi wyżej. Wielokrotny wybór odpadł wyżej, przed
     * szukaniem etykiety, żeby powód odmowy mówił prawdę; otwartą notatkę widzi dopiero świeży odczyt
     * w `#digitStillHolds`. Zostaje więc eskalacja albo dialog z listy terminalowej.
     *
     * Flaga `terminalOnly` opcji z karty też blokuje: każdą stawia `optionPolicy` (`resolve.ts`,
     * `hookQuestionFrom`), w obu kanałach znaczy to samo co tutaj, a bywa liczona z danych, których ta bramka nie
     * ma (pełna etykieta payloadu, `terminalDialog` formularza).
     */
    const policy = optionPolicy({
      label: option.label, terminalDialog: active.terminalDialog ?? null, multiSelect: false, notesEditing: false,
    }, 'digit');
    if (policy.digitBlocked || option.terminalOnly === true) {
      // Karta dialogu z listy terminalowej: flagę ma KAŻDA opcja, a zdanie o uprawnieniach byłoby fałszem.
      return Promise.resolve(policy.why === 'terminal-dialog'
        ? refuseDecision(this.#refusals, TERMINAL_DIALOG_MESSAGE, 'dialog z listy terminalowej', 'terminal-only')
        : refuseDecision(this.#refusals, TERMINAL_ONLY_MESSAGE, 'opcja eskalująca uprawnienia', 'terminal-only'));
    }
    return this.#sendDigit(option, active);
  }

  /**
   * Odpowiedź KANAŁEM HOOKA: plik zamiast klawisza.
   *
   * Trzy kroki i żadnego zgadywania: zapis pliku (atomowy, `0600`), krótkie czekanie na jego
   * ZNIKNIĘCIE (hook kasuje go po odczycie — to jedyny dostępny dowód zużycia) i sprzątnięcie
   * zrzutu, bo `allow` domyka CAŁE wywołanie narzędzia.
   *
   * Wyścigu z biurkiem NIE ścigamy i nie musimy: przy `Esc` CLI zabija proces
   * hooka, więc `allow` w ogóle nie powstaje, a przy cyfrze z biurka spóźnione `allow` jest
   * ignorowane w ciszy. Jedyny obowiązek Raroga to SKASOWAĆ niezużyty plik — inaczej zadziałałby
   * przy następnym pytaniu.
   *
   * Niezużyty plik ZAMYKA kanał dla tego zrzutu (`#deadAnswerKey`): kolejne karty tego samego
   * formularza wracają na tor cyfry, czyli do jednej zakładki naraz. Bez tego Rarog rysowałby
   * w kółko kartę z kompletem pytań dla hooka, którego już nie ma, a odpowiedź na pytanie 1
   * trafiałaby w zakładkę 2 (etykiety sąsiednich pytań kolidują).
   */
  async #answerViaHook(
    active: ActiveReq, target: HookAnswerTarget, answers: readonly (readonly string[])[],
    notes?: readonly (string | null)[],
  ): Promise<DecisionOutcome> {
    const channel = this.#deps.hookAnswers;
    if (channel === undefined) {
      return notes === undefined
        ? this.#answerWithDigit(active, answers)
        : refuseNote(this.#refusals, NOTE_NO_CHANNEL_MESSAGE);
    }
    /*
     * Reguła „jedno tapnięcie nie zmienia trwale uprawnień” obowiązuje w KAŻDYM kanale: opcja eskalująca uprawnienia
     * jest na karcie widoczna, ale nie wychodzi z Raroga — ani cyfrą, ani plikiem. Bramka stoi po stronie serwera, bo
     * zaufanie do UI nie jest granicą. Lista zablokowanych etykiet jedzie z KARTĄ (`target.blocked`), bo
     * `active.options` opisuje tylko tę zakładkę, którą widać na ekranie — a karta niesie komplet pytań.
     */
    const escalating = answers.flat().some((raw) => target.blocked.includes(canonicalLabel(raw)));
    if (escalating) {
      return refuseDecision(this.#refusals,
        TERMINAL_ONLY_MESSAGE, 'opcja eskalująca uprawnienia', 'terminal-only',
      );
    }
    // Klucz mapy to DOSŁOWNA treść pytania z payloadu (po niej dopasowuje CLI), a wiele
    // wartości jedzie JEDNYM stringiem po przecinku — tak CLI czyta `multiSelect`.
    // Wartość nie jest walidowana względem etykiet, więc wolny tekst przechodzi dosłownie.
    // Słownik BEZ prototypu — kluczem jest treść pytania od autora (pytanie „__proto__" na
    // zwykłym obiekcie przestawiało prototyp i znikało z pliku).
    const map = Object.create(null) as Record<string, string>;
    target.questions.forEach((question, index) => {
      map[question] = (answers[index] ?? []).join(', ');
    });
    /*
     * NOTATKI: `annotations` z ORYGINAŁEM podglądu wybranej opcji. Notatki, której
     * nie da się przypiąć (pytanie jej nie przyjmuje, wybór nie jest jedną opcją z listy), nie
     * wysyłamy ani bez niej, ani cyfrą — odmowa, karta zostaje.
     */
    const annotations = notes === undefined ? null : hookAnnotations(target, answers, notes);
    if (notes !== undefined && annotations === null) return refuseNote(this.#refusals, NOTE_NOT_ALLOWED_MESSAGE);
    const noteCount = annotations === null ? 0 : Object.keys(annotations).length;
    /*
     * Zakaz fallbacku cyfrą wynika z ŻĄDANIA (niepuste notatki od człowieka), a nie z liczby
     * kluczy złożonego pliku: rozjazd tych dwóch wysyłał cyfrę
     * i gubił notatkę po cichu. Notatki, której nie przypięto, nie ma prawa być w żądaniu.
     */
    const noted = notes !== undefined;
    if (noted && noteCount === 0) return refuseNote(this.#refusals, NOTE_NOT_ALLOWED_MESSAGE);
    let path: string | null;
    try {
      path = channel.write(this.#agentSessionId, target.key, map, noteCount > 0 ? annotations : null);
    } catch {
      path = null;
    }
    /*
     * Zapis się nie udał albo killswitch zamknął kanał — bez notatek cyfra zostaje jedyną drogą;
     * z notatką odmawiamy (cyfra by ją zgubiła). Karty nie gasimy: nic nie wyszło, dialog stoi,
     * a człowiek ma swój szkic na telefonie.
     */
    if (path === null) {
      return noted
        ? refuseNote(this.#refusals, NOTE_WRITE_FAILED_MESSAGE)
        : this.#answerWithDigit(active, answers);
    }
    // Numer blokady sprzed osłony — do przywrócenia, gdy odpowiedź z notatką nie dojdzie.
    const answeredBefore = this.#answeredSeq;
    /*
     * OSŁONA PRZED FALLBACKIEM — uzbrojona TERAZ, a nie po czekaniu.
     *
     * Czekanie na zużycie pliku trwa do kilku sekund, a CLI zamyka formularz w jego środku:
     * zegar oceny trafia wtedy w przemalowanie, ekran parsuje się bez pytania (zakładka
     * wielokrotna, ramka w połowie) i Rarog wystawiał na telefon kartę „odpowiedz
     * w terminalu" — na sekundę, do przejścia panelu w `working`. Ścieżka cyfrowa tej dziury
     * nie ma, bo `#rearmAfterScreenAnswer` uzbraja osłonę tuż po klawiszu; tutaj robimy to
     * samo tuż po zapisie, bo to on JEST wysłaniem odpowiedzi. Karty NIE gasimy: gaszenie
     * należy do `#rearmAfterScreenAnswer` po potwierdzonym zużyciu, a przedwczesne zdjęłoby
     * człowiekowi treść, gdyby hook pliku nie odebrał i trzeba było wracać na cyfrę.
     *
     * Realnego NOWEGO dialogu to nie maskuje: osłona rozpada się przy każdym nowym numerze
     * blokady, a dialog, który stanął w tej samej, i tak parsuje się w całości i dostaje
     * kartę gałęziami stojącymi wyżej w `herdr/dialogs/decide/decide.ts`.
     */
    this.#answeredSeq = this.#blockedSeq;
    /*
     * OSŁONA WPISU Z JSONL — uzbrojona TERAZ, przed czekaniem.
     *
     * Od CLI 2.1.267 `tool_use` formularza stoi w jsonl od chwili postawienia dialogu, więc
     * przez całe okno czekania `pending` opisuje pytanie, na które odpowiedź WŁAŚNIE poszła.
     * Dopóki znacznik składał się dopiero po `await`, ocena trafiona w to okno miała `pending`
     * z jsonl i pustą osłonę: cross-check ekranu nie przechodził (formularz w środku
     * przemalowania), gałąź `pending === null` z osłoną `#answeredSeq` była pominięta,
     * a ocena kończyła kartą degradacji — fałszywa karta odmowy plus wpis w dzienniku.
     *
     * Granice zostają te same, więc wcześniejsze uzbrojenie niczego nie zakrywa na dłużej:
     * numer blokady (WŁASNY, bo `#answeredSeq` przestawia też cyfra), generacja zrzutu
     * (`target.key`) i czas. To one pilnują, żeby osłona nie złapała `tool_use` NASTĘPNEGO
     * pytania, gdy tura pójdzie dalej w środku czekania.
     */
    const answeredCall = {
      questions: target.questions,
      seq: this.#blockedSeq,
      key: target.key,
      at: this.#scheduler.now(),
    };
    this.#answeredHookCall = answeredCall;
    this.#audit({
      method: 'answer-hook',
      toolName: active.toolName,
      optionLabel: target.questions.map((question) => map[question] ?? '').join(' | '),
      // Ile notatek pojechało — sama liczba, treść notatki nie trafia do dziennika.
      ...(noteCount > 0 ? { notes: noteCount } : {}),
    });
    if (await this.#hookAnswerUsed(channel, path)) {
      // Kasujemy WYŁĄCZNIE zrzut o TYM kluczu: bezwarunkowe kasowanie zdejmowało
      // plik całej sesji bez patrzenia na generację, więc zrzut NASTĘPNEGO pytania — zapisany
      // przez hook w tej samej chwili, w której my domykaliśmy poprzednie — znikał razem z nim.
      this.#deps.clearPendingHook?.(this.#agentSessionId, target.key);
      /*
       * Osłona wpisu z jsonl stoi już od zapisu pliku (wyżej) i tu ZOSTAJE: wywołanie jest
       * rozliczone — `allow` domyka je w całości — ale `tool_result` dojdzie do jsonl dopiero
       * za chwilę, a `tool_use` stoi tam od CLI 2.1.267 od samego początku.
       */
      // Karta ma zgasnąć od razu: `allow` zamyka formularz bez mignięcia `agent_status`,
      // dokładnie jak cyfra w zakładce (ten sam, fail-closed mechanizm odbudowy).
      if (!this.#disposed) this.#rearmAfterScreenAnswer(active);
      return APPLIED;
    }
    channel.clear(path);
    this.#deadAnswerKey = target.key;
    /*
     * Hook pliku nie odebrał — osłonę WYCOFUJEMY.
     *
     * Uzbroiliśmy ją przed czekaniem, na wiarę, że odpowiedź poszła plikiem. Skoro nie poszła,
     * odpowiada CYFRA: wpis z jsonl opisuje pytanie wciąż nierozstrzygnięte, a osłona
     * zwracałaby na nim `KEEP` — nie byłoby ani karty na torze cyfry, ani kart dla zakładek
     * 2..n. Porównanie tożsamości chroni przed zdjęciem CUDZEJ osłony, gdyby w oknie czekania
     * poszła i domknęła się odpowiedź na inne pytanie.
     */
    if (this.#answeredHookCall === answeredCall) this.#answeredHookCall = null;
    /*
     * Odpowiedź Z NOTATKĄ nie spada na tor cyfry: cyfra dowiozłaby sam wybór,
     * a notatka przepadłaby po cichu. Odmowa jawna, z treścią notatki w transkrypcie — karta
     * zaraz odbuduje się na torze cyfry (kanał tego zrzutu jest martwy), więc pola notatki już
     * na niej nie będzie, a człowiek ma ją skąd przepisać do terminala. Osłona „okno po własnej
     * odpowiedzi" wraca do stanu sprzed zapisu: odpowiedź nie wyszła, karta ma prawo stanąć.
     */
    if (noted) {
      if (this.#answeredSeq === this.#blockedSeq) this.#answeredSeq = answeredBefore;
      const message = noteNotDeliveredMessage(Object.values(annotations ?? {}).map((entry) => entry.notes));
      /*
       * Karta podmieniona w oknie czekania (jak przy cyfrze niżej): nowa mówi prawdę o ekranie, więc odmowa
       * notatki jej nie gasi i oceny nie ponawia. Notatka nie doszła tak samo, więc zdanie z jej treścią idzie
       * do transkryptu, a dziennik dostaje nazwę narzędzia karty, na którą przyszła odpowiedź.
       */
      if (this.#activeReq !== null && this.#activeReq !== active) {
        return refuseNote(this.#refusals, message, active.toolName);
      }
      return refuseDecision(this.#refusals, message, 'notatka: hook nie odebrał pliku odpowiedzi', 'send-failed');
    }
    /*
     * Karta podmieniona w oknie czekania: nowy zrzut i nowy ekran wystawiły inną kartę, a odpowiedź
     * przyszła na tę sprzed czekania. Cyfra szłaby w dialog z nowej karty z opcją i listą `terminalOnlyLabels`
     * starej, a przy wspólnym początku etykiet ta sama cyfra trafiłaby w opcję, której człowiek nie widział.
     * Porównujemy tożsamość obiektu, jak `#confirmAndSubmitEnter`: ocena nie podmienia karty w miejscu (`KEEP`
     * zostawia ten sam obiekt), a pomocnicze `withOrigin`/`withIdentity` składają kartę przed wystawieniem. Brak
     * karty to normalny wyścig (cisza, jak na wejściu do `answerQuestion`); inna karta to odmowa jak przy
     * nieaktualnej decyzji, bez cyfry, a nowa karta zostaje.
     */
    if (this.#activeReq === null) return STALE;
    if (this.#activeReq !== active) return reportStaleDecision(this.#refusals);
    /*
     * Cyfra dowozi TYLKO pytanie stojące na ekranie — i wcale nie musi to być pierwsze
     * pytanie karty (zakładkę przełącza się przy biurku bez mignięcia `agent_status`).
     * Przy formularzu wielopytaniowym trzeba to powiedzieć wprost i NAZWAĆ pytanie:
     * człowiek zaznaczył trzy odpowiedzi, a pojedzie jedna — reszta wróci osobnymi kartami,
     * już bez kanału. Gdy pytania z ekranu na karcie nie ma (`-1`), zdania nie ma po co
     * pisać: `#answerWithDigit` zaraz odmówi i powie o tym sam.
     */
    const screenIndex = screenAnswerIndex(target, active.question);
    if (target.questions.length > 1 && screenIndex !== -1) {
      this.#system(hookAnswerPartialMessage(target.questions[screenIndex] ?? ''));
    }
    return this.#answerWithDigit(active, answers);
  }

  /** Czy hook zużył plik odpowiedzi? Polling do sufitu; `false` = wracamy na tor cyfry. */
  async #hookAnswerUsed(channel: HookAnswerChannel, path: string): Promise<boolean> {
    const pollMs = this.#deps.hookAnswerPollMs ?? HOOK_ANSWER_POLL_MS;
    const deadline = this.#scheduler.now() + (this.#deps.hookAnswerWaitMs ?? HOOK_ANSWER_WAIT_MS);
    for (;;) {
      if (!channel.pending(path)) return true;
      if (this.#disposed || this.#scheduler.now() >= deadline) return false;
      await this.#sleep(pollMs);
    }
  }

  /**
   * Jedna cyfra do panelu + wpis dziennika, który mówi CO zatwierdzono, a nie co wysłano.
   *
   * `consent` = zgoda na narzędzie z karty (`respondPermission`): w trybie cienia przed resztą kroku idzie plik
   * cienia (`#shadowStep`). Cyfra, kolejność i bramki zostają te same co przy `off`.
   *
   * `answered` to karta, z której wybrano `option`, podana JAWNIE, a nie czytana z `#activeReq`: świeży odczyt
   * (`#digitStillHolds`), dziennik i osłona po decyzji mają mówić o tej samej karcie co opcja. Odczyt w chwili
   * wywołania dawał kartę bieżącą, czyli po `await` (fallback kanału hooka) kartę podmienioną (review
   * Codexa).
   */
  #sendDigit(option: ScreenOption, answered: ActiveReq, consent = false): Promise<DecisionOutcome> {
    const { toolName } = answered;
    const step = this.#enqueue(async (): Promise<DecisionOutcome> => {
      if (this.#disposed) return STALE;
      // Tryb kanału (`main`): zgoda na narzędzie nie idzie cyfrą, także odpowiedź na potwierdzenie z ekranu.
      if (consentDigitRefused(this.#deps, this.#cliReserve.cliWaiting, answered, consent)) {
        return refuseDecision(
          this.#refusals, TERMINAL_ONLY_MESSAGE, 'consent channel main: no digit for a consent', 'terminal-only',
        );
      }
      const shadow = consent && this.#shadowChannel() !== undefined ? await this.#shadowStep('allow', answered) : null;
      // Digit that only the measured mark lets through: the send shield before the fresh read and the key.
      const mark = consent
        && consentDigitRefused(this.#deps, this.#cliReserve.cliWaiting, { ...answered, measuredConsent: undefined }, true)
        ? answered.measuredConsent : undefined;
      const shield = mark === undefined ? null : await this.#promptQueue.keyShield(mark.cliDialog);
      if (shield !== null) {
        return refuseDecision(this.#refusals, SCREEN_CHANGED_MESSAGE, `measured: ${shield}`, 'screen-changed');
      }
      const held = await this.#digitStillHolds(option, answered);
      if (!held.ok) {
        this.#shadowKeySent(shadow, false);
        return held.outcome;
      }
      // Zgoda z karty, a dialog przejęła karta kanału zgód (także w trakcie świeżego odczytu): cyfra trafiłaby
      // w dialog, na który odpowiada hook. Bez klawisza; karta z ekranu wygasa (410).
      if (consent && this.#consentChannel.consentCardStands(true)) {
        this.#shadowKeySent(shadow, false);
        return STALE;
      }
      // Measured digit: a hook registration without a card can come during the fresh read, after the shield.
      if (mark !== undefined && this.#promptQueue.keyHookWaits()) {
        return refuseDecision(this.#refusals, SCREEN_CHANGED_MESSAGE, 'measured: hook', 'screen-changed');
      }
      const live = held.dialog;
      // Odświeżamy meldunek o dialogu zaufania w chwili DECYZJI: to od niej liczy się karencja
      // zniknięcia, bo to ona wywołuje re-eksekucję `claude`. Meldunek idzie DOPIERO po
      // potwierdzeniu ekranem — decyzja, która nie wyszła, niczego nie re-eksekuuje.
      if (toolName === `${SCREEN_DIALOG_TOOL}:trust`) this.#deps.markTrustDialog?.();
      // Numer blokady ZAMROŻONY przed cyfrą: `enter` ma prawo wyjść wyłącznie w TĘ SAMĄ
      // blokadę — mignięcie statusu w międzyczasie znaczy „to już inny dialog".
      const seq = this.#blockedSeq;
      // Migawka osłony po decyzji — też PRZED klawiszem: generacja zrzutu, wpis jsonl i tożsamość
      // dialogu ze świeżego ekranu, który `#digitStillHolds` właśnie przeczytał i zostawił w cache'u.
      const hookAt = this.#hookGeneration();
      const pendingAt = this.#pending;
      // Ekran, w który idzie cyfra: po klawiszu mówi też, który dialog rozstrzygnięto (`#clearHookAfterDecision`).
      const resolvedText = this.#screenText;
      const shot = { bodyPrint: live.bodyPrint, screenReqId: this.#screenIdentity(resolvedText) };
      const sent = await this.#send(
        () => this.#deps.client.sendKeys(this.#paneId, [option.digit]),
        {
          // `approve`, nie `send_keys`: to jest ZATWIERDZENIE dialogu z kontekstem decyzji
          // (`toolName` + `optionLabel`), a runbook kradzieży (`docs/security-model.md`)
          // grepuje `"method":"approve"`; wpis `send_keys` dałby
          // najważniejszemu grepowi śledztwa pustkę.
          method: 'approve', keys: [option.digit], toolName, optionLabel: option.label,
          // Tożsamość i pochodzenie zatwierdzonej karty — spina wpis z `degrade`/`refuse`.
          ...originFields(answered.reqId, answered.origin),
          // Klasa CLI i werdykt rozdzielacza ze świeżego ekranu `#digitStillHolds` — tylko dziennik.
          ...approveContext(this.#refusals),
          // Wynik kroku trybu cienia i klucz pliku — tylko dziennik.
          ...shadowAuditFields(shadow),
        },
      );
      this.#shadowKeySent(shadow, sent);
      if (!sent) return refuseSend(this.#refusals);
      /*
       * Tryb zatwierdzania z ŻYWEGO odczytu, nie z karty: `preview` jest
       * własnością POJEDYNCZEGO pytania, a formularz przełącza zakładki bez mignięcia
       * statusu — karta z ekranu cache'owanego przy wejściu w `blocked` potrafi nieść
       * nieaktualny tryb w OBIE strony (cyfra bez entera zostawia dialog wiszący przy
       * wpisie `approve` w dzienniku; enter po cyfrze-zatwierdzeniu leciałby w kolejne
       * pytanie). Rozstrzyga ekran sprzed ułamka sekundy.
       */
      if (live.submit === 'digit-enter') {
        const submitted = await this.#confirmAndSubmitEnter(option, answered, toolName, seq);
        if (submitted.kind !== 'applied') return submitted;
      }
      const keptHookAt = this.#clearHookAfterDigit(live, resolvedText, answered);
      // Osłona po własnej decyzji: ta karta nie wraca, dopóki herdr nie zejdzie z `blocked`.
      this.#noteDecided(answered, seq, hookAt, pendingAt, shot, keptHookAt);
      /*
       * Ponowna ocena po WŁASNEJ cyfrze należy się KAŻDEJ karcie, nie tylko ekranowej.
       * Zakładkę formularza przełącza CLI bez mignięcia
       * `agent_status` niezależnie od tego, skąd wzięła się treść karty — a karta z hooka
       * czekałaby na zwykły zegar oceny, czyli do czterech sekund pustki na telefonie.
       * Mechanizm jest ten sam i tak samo fail-closed: pilnuje numeru blokady i zastępuje
       * WYŁĄCZNIE kartę bez opcji.
       */
      if (!this.#disposed) {
        this.#rearmAfterScreenAnswer(answered);
      }
      return APPLIED;
    });
    return step.then((outcome) => outcome ?? STALE);
  }

  /**
   * Zrzut hooka po WŁASNEJ cyfrze — kasujemy go dopiero wtedy, gdy jest ZUŻYTY.
   *
   * Formularz `AskUserQuestion` z kilkoma pytaniami przełącza zakładkę W MIEJSCU: jedna cyfra
   * zamyka JEDNO pytanie, nie cały dialog. Bezwarunkowe kasowanie
   * zabierało zakładkom 2..n jedyny komplet treści — karta spadała do „odpowiedz w terminalu"
   * sekundę po `approve` (łańcuch 14:04 w `herdr-audit.log`).
   *
   * Warunek jest z DWÓCH dowodów, nie z jednego: zrzut mówi o `AskUserQuestion` ORAZ ekran
   * sprzed cyfry (świeży — czytał go `#digitStillHolds`) jest formularzem pytania. Zrzut
   * stęchły po innym narzędziu znika. Zrzut zostawiony przy życiu sprząta TTL
   * (sufit hooka zgód, `dialogs/hook/dump.ts`) i nadpisanie przez hook przy następnym pytaniu, a przed
   * podpięciem pod CUDZY dialog broni cross-check treści (`hookQuestionFrom`: pytanie musi
   * zgadzać się co do słowa, z kompletem etykiet na ekranie).
   *
   * `escape` (odmowa) nie zostawia zrzutu formularza: zamyka CAŁY formularz, więc po nim zrzut
   * pytania nie opisuje już niczego, co stoi. Poza formularzem obie decyzje kasują zrzut tą samą
   * drogą ({@link #clearHookAfterDecision}).
   */
  #clearHookAfterDigit(live: ScreenDialog, resolvedText: string | null, answered: ActiveReq): number | null {
    const raw = this.#readHookFile();
    // Zrzut czytamy tak samo jak ocena (`hookPendingFrom`): marker przycięcia >64 kB nie jest
    // inputem, więc taki plik nie chroni zakładek 2..n i ginie jak każdy inny po decyzji.
    const form = live.kind === 'question' && hookPendingFrom(raw)?.toolName === ASK_USER_QUESTION_TOOL;
    if (form) return null;
    return this.#clearHookAfterDecision(raw, resolvedText, answered);
  }

  /**
   * Zrzut sesji po UDANEJ decyzji Raroga, cyfrze albo `escape`: kasowany, bo opisuje dialog, którego już nie ma.
   * Jedyny wyjątek to zrzut `Bash` INNEGO dialogu (`otherDialogDump`): ekran sprzed
   * klawisza (`resolvedText`) pokazuje całą ramkę komendy rozstrzygniętej karty, a zrzut ma inną komendę. To
   * zgoda subagenta w kolejce CLI za rozstrzygniętym dialogiem; hook odpala raz, więc skasowany zrzut zabrałby
   * jej treść i przyciski, gdy wychodzi na wierzch („2 of 2”).
   *
   * Zwraca generację zostawionego zrzutu (`null`, gdy kasuje). Zrzut czytamy PO klawiszu, więc bywa nowszy od
   * migawki osłony: doszedł w trakcie wysyłki. Dla osłony po decyzji nie jest nowym dialogiem (`keptHookAt`
   * w `#noteDecided`, `decidedShield` w `decide/decide.ts`).
   */
  #clearHookAfterDecision(
    raw: PendingHookTool | null, resolvedText: string | null, card: ActiveReq | null,
  ): number | null {
    if (raw !== null && otherDialogDump(raw, resolvedText, card?.command ?? null)) return raw.at;
    this.#deps.clearPendingHook?.(this.#agentSessionId);
    return null;
  }

  /** Surowy zrzut sesji, bez `admittedHook`: błąd czytnika to brak zrzutu, czyli kasowanie. */
  #readHookFile(): PendingHookTool | null {
    try {
      return this.#deps.readPendingHook?.(this.#agentSessionId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Drugi krok formularza z preview: dowód ze świeżego ekranu, potem `enter` — RAZ.
   *
   * Cyfra w tym wariancie tylko przesuwa podświetlenie, a `[cyfra, enter]`
   * w jednej ramce gubi cyfrę i zatwierdza opcję DOMYŚLNĄ — dlatego między klawiszami stoi
   * pauza, świeży odczyt i `confirmFormSubmit` (`form-submit.ts`): formularz musi wciąż stać
   * nad tym samym pytaniem, z DOKŁADNIE jednym `❯` na wybranej etykiecie, poza trybem notatki.
   * Każda odmowa jest końcem ścieżki (zero ponowień — drugi `enter` szedłby w ekran, którego
   * nikt nie widział): karta gaśnie, człowiek dostaje zdanie, ocena rusza od nowa.
   *
   * @returns `applied`, gdy `enter` wyszedł (formularz zatwierdzony); `refused` z powodem
   *          `form-submit` po każdej odmowie weryfikacji; `stale`, gdy driver zdążył zniknąć
   */
  async #confirmAndSubmitEnter(
    option: ScreenOption,
    answered: ActiveReq,
    toolName: string,
    seq: number,
  ): Promise<DecisionOutcome> {
    await this.#sleep(this.#deps.formSubmitConfirmDelayMs ?? FORM_SUBMIT_CONFIRM_DELAY_MS);
    const abort = (message: OwnText, reason: string): DecisionOutcome => {
      // Licznik odmów obejmuje TAKŻE ten krok: `abort` jest wspólną drogą obu ścieżek
      // odmowy (`gone()` też przez nią przechodzi), a wpis znaczy „cyfra poszła, `enter` NIE".
      auditRefusal(this.#refusals, 'form-submit', toolName);
      this.#system(message);
      // Gasimy WYŁĄCZNIE własną kartę: przy podmianie w oknie pauzy `#clearActive` trafiłby
      // w świeżą kartę postawioną przez ocenę panelu — a ona mówi prawdę o ekranie.
      if (this.#activeReq === answered) {
        this.#clearActive(reason);
        this.#scheduleEvaluate();
      }
      return refused('form-submit');
    };
    /*
     * Dialog przestał stać w tej samej blokadzie — najczęściej dlatego, że rozstrzygnęła go
     * WŁASNA cyfra (fałszywe trafienie detekcji preview) albo ktoś przy biurku. Komunikat
     * jest inny niż przy odmowie weryfikacji: „nic nie poszło" byłoby tu
     * kłamstwem — cyfra POSZŁA, nie wiemy tylko, czy domknęła formularz.
     */
    const gone = (): DecisionOutcome =>
      abort(FORM_SUBMIT_GONE_MESSAGE, 'dialog zniknął między cyfrą a enter');
    if (this.#disposed) return STALE;
    if (!this.#blockedNow() || this.#blockedSeq !== seq) return gone();
    // Karta podmieniona w oknie pauzy (ocena panelu nie chodzi przez kolejkę wysyłek, więc
    // `replaceActive` może wejść bez zmiany numeru blokady) — enter szedłby „w imieniu"
    // karty, której już nie ma.
    if (this.#activeReq !== answered) return gone();
    const text = await this.#readDialog(true);
    if (this.#disposed) return STALE;
    if (!this.#blockedNow() || this.#blockedSeq !== seq) return gone();
    if (this.#activeReq !== answered) return gone();
    const verdict = confirmFormSubmit(text, {
      option,
      question: answered.question ?? null,
      multiSelect: answered.multiSelect,
      labels: answered.options.map((candidate) => ({
        label: candidate.label, description: candidate.description,
      })),
    });
    if (!verdict.ok) {
      return abort(
        formSubmitAbortMessage(verdict.reason),
        `weryfikacja przed enter: ${verdict.reason}`,
      );
    }
    const sent = await this.#send(
      () => this.#deps.client.sendFormSubmit(this.#paneId),
      // Ten sam kontekst decyzji co przy cyfrze — dziennik ma mówić, CO zatwierdzono.
      {
        method: 'approve', keys: [FORM_SUBMIT_KEY], toolName, optionLabel: option.label,
        ...originFields(answered.reqId, answered.origin),
        ...approveContext(this.#refusals),
      },
    );
    return sent ? APPLIED : refuseSend(this.#refusals);
  }

  /**
   * Zatwierdzenie dialogu zaufania BEZ cyfr (wyjątek od drogi cyfrowej, wzorem drogi formularza).
   *
   * Świeży odczyt → `down` (tylko gdy `❯` stoi na „No”) → pauza i drugi świeży odczyt → `enter`. Przed każdym
   * klawiszem `nextTrustStep` dowodzi tego samego: dialog zaufania w pełnym renderze, odcisk bloku i folder z karty,
   * folder równy `cwd` sesji. Do tego karta jest dalej tą kartą, blokada ta sama co przy pierwszym odczycie,
   * a sesja silnika ta sama co przy karcie. Odczyt z `❯` już na „Yes” daje sam `enter`.
   *
   * Stan (karta, blokada, sesja silnika) sprawdza `holds()` dwa razy: po odczycie ekranu i drugi raz tuż przed
   * klawiszem, synchronicznie, bez żadnego `await` do wywołania klienta. Zdarzenie panelu (`session-changed`, status)
   * wchodzi tylko na `await`, także na wznowieniu po `await read(…)`, więc kontrola w samym odczycie nie wystarcza:
   * zmiana dostarczona między nią a klawiszem by go nie zatrzymała. `#send` woła klienta przed swoim pierwszym `await`.
   *
   * Każde inne odczytanie kończy ścieżkę bez dalszego klawisza (nigdy `escape`): odmowa `screen-changed`, karta
   * gaśnie i ocena buduje ją od nowa z ekranu. Błąd wysyłki to `send-failed` bez ponowienia; karta stoi, bo dialog
   * stoi dalej, a następne tapnięcie zaczyna od świeżego odczytu.
   */
  #approveTrustArrow(answered: ActiveReq, mark: TrustArrowMark): Promise<DecisionOutcome> {
    const { toolName } = answered;
    const expectedPrint = answered.bodyPrint;
    const step = this.#enqueue(async (): Promise<DecisionOutcome> => {
      if (this.#disposed) return STALE;
      const seq = this.#blockedSeq;
      const refuse = (why: string): DecisionOutcome => {
        auditRefusal(this.#refusals, 'screen-changed', toolName);
        this.#system(SCREEN_CHANGED_MESSAGE);
        // Gasimy WYŁĄCZNIE własną kartę: podmieniona w trakcie mówi prawdę o ekranie.
        if (this.#activeReq === answered) {
          this.#clearActive(`dialog zaufania: ${why}`);
          this.#scheduleEvaluate();
        }
        return refused('screen-changed');
      };
      /** Karta, blokada i sesja silnika dalej te z chwili karty; synchronicznie, więc ważne do najbliższego `await`. */
      const holds = (): boolean => this.#blockedNow() && this.#blockedSeq === seq && this.#activeReq === answered
        && this.#agentSessionId === mark.engineSessionId;
      const read = async (allowDown: boolean): Promise<TrustStepVerdict | null> => {
        const text = await this.#readDialog(true);
        if (this.#disposed) return null;
        if (!holds() || expectedPrint === undefined) return { ok: false, reason: 'not-trust' };
        return nextTrustStep(text, {
          bodyPrint: expectedPrint, folder: mark.folder, cwd: this.#cwd,
          home: this.#deps.homeDir ?? os.homedir(), allowDown,
        });
      };
      let verdict = await read(true);
      if (verdict === null) return STALE;
      if (!verdict.ok) return refuse(verdict.reason);
      const audit = {
        toolName, optionLabel: verdict.dialog.yesLabel,
        ...originFields(answered.reqId, answered.origin),
      };
      if (verdict.key === TRUST_DOWN_KEY) {
        // Kontrola tuż przed klawiszem: od niej do wywołania klienta w `#send` nie ma `await`.
        if (this.#disposed) return STALE;
        if (!holds()) return refuse('state');
        // `send_keys`, nie `approve`: `down` tylko przesuwa `❯`, niczego nie zatwierdza.
        const moved = await this.#send(
          () => this.#deps.client.sendTrustStep(this.#paneId, TRUST_DOWN_KEY),
          { method: 'send_keys', keys: [TRUST_DOWN_KEY], ...audit },
        );
        if (!moved) return refuseSend(this.#refusals);
        await this.#sleep(this.#deps.formSubmitConfirmDelayMs ?? FORM_SUBMIT_CONFIRM_DELAY_MS);
        verdict = await read(false);
        if (verdict === null) return STALE;
        if (!verdict.ok) return refuse(verdict.reason);
      }
      const enterKey = verdict.key;
      if (enterKey !== TRUST_ENTER_KEY) return refuse('cursor');
      // Kontrola tuż przed klawiszem, jak przed `down`.
      if (this.#disposed) return STALE;
      if (!holds()) return refuse('state');
      // Meldunek o dialogu zaufania w chwili decyzji, po dowodzie z ekranu i po kontroli stanu: od niej liczy się
      // karencja zniknięcia. Meldunek jest synchroniczny (zapis czasu u nadzorcy), więc kontroli nie unieważnia.
      this.#deps.markTrustDialog?.();
      const sent = await this.#send(
        () => this.#deps.client.sendTrustStep(this.#paneId, enterKey),
        { method: 'approve', keys: [enterKey], ...audit, ...approveContext(this.#refusals) },
      );
      if (!sent) return refuseSend(this.#refusals);
      this.#noteDecided(answered, seq, this.#hookGeneration(), this.#pending, {
        bodyPrint: expectedPrint ?? null, screenReqId: answered.reqId,
      });
      if (!this.#disposed) this.#rearmAfterScreenAnswer(answered);
      return APPLIED;
    });
    return step.then((outcome) => outcome ?? STALE);
  }

  /**
   * Krok trybu cienia przed klawiszem (`RAROG_CONSENT_CHANNEL=shadow`): kanał wybiera zrzut per wywołanie tej sesji
   * z dowodem „dialog stoi” pasujący do karty i pisze pod jego kluczem plik cienia. Bez kanału, bez karty i dla
   * karty spoza kanału zgody (dialog ekranowy, pytanie) = `null` i ani jednego odczytu. Sufit
   * {@link SHADOW_DEADLINE_MS}: po nim driver przestaje czekać, kanał już pliku nie pisze. Wyjątek kanału = wynik
   * `error`. Żadna z tych dróg nie zmienia klawisza — wołający wysyła go dokładnie tak jak przy `off`.
   */
  async #shadowStep(decision: 'allow' | 'deny', card: ActiveReq | null): Promise<ShadowOutcome | null> {
    const channel = this.#shadowChannel();
    if (channel === undefined || card === null || !shadowCardEligible(card.toolName)) return null;
    const engineSessionId = this.#agentSessionId;
    if (engineSessionId === '') return null;
    let abandoned = false;
    let timer: TimerHandle | null = null;
    // Zegar obok timera: synchroniczna część kanału (odczyty, dowód) blokuje pętlę, więc timer może nie zdążyć
    // odpalić, zanim kanał zapyta „piszę?” — po terminie odpowiedź brzmi „nie” także bez jego callbacku.
    const until = this.#scheduler.now() + SHADOW_DEADLINE_MS;
    try {
      const deadline = new Promise<ShadowOutcome>((resolve) => {
        timer = this.#scheduler.setTimeout(() => {
          abandoned = true;
          resolve({ result: 'error', detail: 'timeout' });
        }, SHADOW_DEADLINE_MS);
      });
      const work = channel.prepare({
        engineSessionId,
        decision,
        card: { toolName: card.toolName, callPrint: card.callPrint ?? null },
        registry: registryEvidenceFromSignal(this.#cliReserve.cliSignal, this.#cliReserve.cliSignalAt),
        screen: this.#screenText,
        transcript: this.#follower?.openToolUses?.() ?? null,
      }, () => abandoned || this.#scheduler.now() >= until);
      return await Promise.race([work, deadline]);
    } catch {
      return { result: 'error', detail: 'blad' };
    } finally {
      if (timer !== null) this.#scheduler.clearTimeout(timer);
    }
  }

  /**
   * Zwalnianie sierot trybu cienia w rytmie odczytu rejestru (co 1,5 s): hook wątku głównego, którego dialogu już
   * nie ma (decyzja przy biurku), dostaje znacznik `.revoked` i wychodzi bez wyniku
   * (`docs/dialogs.md`, „Server in shadow mode”). Bez kanału (`off`) nic. Nie czeka i nie rzuca: wynik idzie wyłącznie
   * do logu kanału.
   */
  #shadowRelease(): void {
    const channel = this.#shadowChannel();
    if (channel === undefined || this.#shadowReleasing || this.#agentSessionId === '') return;
    this.#shadowReleasing = true;
    let work: Promise<number>;
    try {
      work = channel.release({
        engineSessionId: this.#agentSessionId,
        registry: registryEvidenceFromSignal(this.#cliReserve.cliSignal, this.#cliReserve.cliSignalAt),
        transcript: this.#follower?.openToolUses?.() ?? null,
      });
    } catch {
      this.#shadowReleasing = false;
      return;
    }
    void work.catch(() => 0).finally(() => { this.#shadowReleasing = false; });
  }

  /**
   * Kanał cienia, gdy tryb efektywny to `shadow` (albo bez źródła trybu, gdy kanał jest). Konfiguracja `main`
   * zdegradowana do `shadow` dostaje cień tak samo jak konfiguracja `shadow`; `off` (przed rozstrzygnięciem trybu,
   * po wyłączniku) i `main` nie piszą plików cienia i nie zwalniają sierot.
   */
  #shadowChannel(): ShadowConsentChannel | undefined {
    const channel = this.#deps.shadow;
    if (channel === undefined || this.#deps.consentMode === undefined) return channel;
    return consentModeNow(this.#deps) === 'shadow' ? channel : undefined;
  }

  /** Czas klawisza do rekordu cyklu cienia; klawisz, który nie wyszedł, odwołuje plik. Nigdy nie rzuca. */
  #shadowKeySent(shadow: ShadowOutcome | null, sent: boolean): void {
    if (shadow === null) return;
    try {
      this.#deps.shadow?.keySent(shadow, sent);
    } catch {
      // Rekord cyklu to dziennik — klawisz już rozstrzygnięty.
    }
  }

  /**
   * Czy ta cyfra dalej znaczy TO SAMO na ŻYWYM ekranie?
   *
   * Karta powstaje z ekranu czytanego przy WEJŚCIU w `blocked` i cache'owanego na całą blokadę
   * (`#readDialog`), a formularz z kilkoma pytaniami przełącza zakładkę W MIEJSCU — bez ani
   * jednego mignięcia `agent_status` (zmierzone, patrz `SCREEN_ANSWER_REARM_DELAYS_MS`). Gdy
   * człowiek odpowie na pierwsze pytanie przy biurku, telefon dalej pokazuje starą kartę i nic
   * jej nie unieważnia: `#rearmAfterScreenAnswer` odpala się WYŁĄCZNIE po WŁASNEJ cyfrze Raroga.
   * Bez tego sprawdzenia tapnięcie wysyłało cyfrę wybraną z ekranu sprzed dowolnie długiego
   * czasu w dialog, którego nikt nie widział — a dziennik zapisywał etykietę starej karty,
   * czyli nieprawdę o tym, co poszło do panelu.
   *
   * Sprawdzenie jest tym samym, czym jest wybór: rozstrzyga ETYKIETA, nigdy pozycja.
   * Odczyt z pominięciem cache'u, ponowne sparsowanie opcji i asercja, że ta sama etykieta ma
   * dalej tę samą cyfrę. Każdy inny wynik — ekran nie do odczytania, brak spójnej listy opcji,
   * etykieta zniknęła, cyfra się przesunęła — jest fail-closed: zero klawiszy i zdanie do
   * człowieka. Kosztem jest jeden `agent.read` na DECYZJĘ (nie na obrót pętli), czyli ruch
   * na cudzym panelu dokładnie wtedy, gdy i tak zaraz do niego piszemy.
   *
   * @returns `{ok: true, dialog}` — żywy dialog, gdy cyfra dalej znaczy to samo; to Z NIEGO
   *          (nie z karty) wołający bierze tryb zatwierdzania (`preview` jest
   *          własnością POJEDYNCZEGO pytania, a zakładki przełączają się bez mignięcia
   *          statusu, więc karta z cache'u potrafi nieść nieaktualny tryb).
   *          `{ok: false}` = fail-closed: karta zgaszona, a `outcome` mówi managerowi, czy
   *          to odmowa (`screen-changed`, pending zostaje), czy zniknięty driver (`stale`).
   */
  async #digitStillHolds(
    option: ScreenOption, answered: ActiveReq | null,
  ): Promise<{ ok: true; dialog: ScreenDialog } | { ok: false; outcome: DecisionOutcome }> {
    const text = await this.#readDialog(true);
    if (this.#disposed) return { ok: false, outcome: STALE };
    /*
     * Override `multiSelect` z karty: ten sam, z którym powstała — inaczej formularz
     * uznany za wielokrotny wyłącznie przez glify ekranu przepadałby tu przy każdej cyfrze.
     *
     * Ale override `false` WYŁĄCZAŁBY jedyną bramkę multi-select tej ścieżki (warunek
     * `dialog?.multiSelect !== true` niżej), więc wolno go przyjąć DOPIERO po dowodzie, że
     * ekran stoi nad TYM SAMYM pytaniem, z którego powstała karta.
     * Bez tego dowodu formularz wielopytaniowy przełączony przy biurku na zakładkę
     * WIELOKROTNĄ (zakładki przełączają się bez mignięcia `agent_status`) przepuszczał cyfrę:
     * etykiety sąsiednich zakładek kolidują („Type something"/„Chat about this"), więc
     * samo dopasowanie etykiety do cyfry przechodziło, a dziennik zapisywał `approve`
     * z etykietą STAREJ zakładki — czyli nieprawdę o tym, co poszło do panelu.
     */
    // Etykiety karty prowadzą odtworzenie etykiet zawiniętych przez wąski panel —
    // bez nich świeży odczyt widziałby pierwszą linię i odmawiał `screen-changed`.
    const labels = (answered ?? this.#activeReq)?.options.map((candidate) => ({
      label: candidate.label, description: candidate.description,
    }));
    const raw = text === null ? null : parseOptions(text, { labels });
    const dialog = text === null ? null : applyMultiSelectOverride(text, raw, answered);
    const fresh = dialog?.options.find((candidate) => candidate.label === option.label) ?? null;
    /*
     * Dwa stany dyskwalifikują mimo zgodnej listy opcji — oba z tej samej reguły
     * „`question === null` znaczy: cyfra nie ma tu prawa wyjść":
     *
     * - `notesEditing` — cyfra wpisałaby się jako TEKST do pola, nie jako wybór
     *   (zmierzone: „Notes: 5");
     * - `multiSelect` — cyfra niczego nie zatwierdza, bo zaznaczenie i „Submit" to dwa
     *   osobne kroki. Ta bramka jest tu JEDYNA: ścieżka `answerQuestion` → `#sendDigit`
     *   nie woła `resolveOptions`, więc rozjazd `multi-select` stamtąd jej nie chroni,
     *   a karta z zakładki JEDNOKROTNEJ potrafi stać, gdy ekran pokazuje już zakładkę
     *   wielokrotną (zakładki przełączają się bez mignięcia `agent_status`) — etykiety
     *   sąsiednich pytań kolidują („Type something"/„Chat about this"), więc samo
     *   dopasowanie etykiety do cyfry przechodzi.
     */
    /*
     * Odcisk treści dialogu z ramką operacji: karta zapamiętała, CO stało na ekranie, gdy
     * powstała (komenda, diff, nagłówek). Inny dialog pod tą samą etykietą i cyfrą — komenda X
     * rozstrzygnięta przy biurku, a na ekranie już Y, zanim wynik X dotarł do pliku — daje inny
     * odcisk. Zmiana szerokości panelu między kartą a tapnięciem też go zmienia: odmowa i nowa
     * karta przy następnej ocenie, nigdy cyfra w nie ten dialog. Dialog planu (bez ramki) ma odcisk
     * z nazwy pliku planu w stopce: plan B w miejscu planu A pod tymi samymi opcjami to odmowa.
     */
    const card = answered ?? this.#activeReq;
    const expectedPrint = card?.bodyPrint;
    // Zrzut hooka, który dał karcie treść albo drugi dowód, musi być TEN SAM: przy ramce
    // uciętej u góry podmiana dialogu X na Y o wspólnym końcu nie zmienia odcisku ekranu, za to
    // każdy dialog zgody zapisuje nowy zrzut. Zrzut `Bash` starszy niż
    // 10 minut liczy się wyłącznie z dowodem na TYM świeżym ekranie (`admittedHook`):
    // karta z podwójnym dowodem przy ramce uciętej traci cyfrę.
    const proofHookAt = card?.proofHookAt;
    const sameHook = proofHookAt === undefined
      || admittedHook(
        this.#deps.readPendingHook?.(this.#agentSessionId) ?? null, text,
        (screen, expected) => this.#resolveOptions(screen, expected),
      )?.at === proofHookAt;
    /*
     * Dialog z listy terminalowej i pauza każdego wariantu nie przyjmują
     * cyfry z ŻADNEJ karty: stara karta pytania z etykietą „Switch to Opus 4.8" pod cyfrą 1 przechodziła
     * kontrolę etykiety, gdy na ekranie stała już pauza z tą samą opcją.
     */
    const terminal = dialog !== null && (dialog.terminalDialog !== null || sessionPausedDialog(dialog));
    /*
     * TOŻSAMOŚĆ dialogu z bloku: świeży odczyt musi dać ten sam rodzaj i tę samą `identity` co karta.
     * Etykieta „Yes" pod cyfrą 1 stoi w dialogu `model` i w zgodzie `Bash` jednakowo, więc bez tej bramki
     * karta `dialog:model` wysyłała cyfrę w zgodę na narzędzie, która zdążyła wjechać na ekran.
     * Z nazwą narzędzia nie porównujemy: dla poprawnej zgody MCP parser daje `toolName: null`, a karta
     * niesie nazwę kanoniczną z jsonl. Karta bez tożsamości i blok `ambiguous` nie dostają cyfry nigdy.
     */
    const expectedIdentity = card?.dialogIdentity;
    const sameIdentity = dialog !== null && expectedIdentity !== undefined
      && sameDialogIdentity(expectedIdentity, { kind: dialog.kind, identity: dialog.identity });
    if (
      dialog !== null && fresh !== null && fresh.digit === option.digit && !terminal
      && dialog.notesEditing !== true && dialog.multiSelect !== true
      && (expectedPrint === undefined || dialog.bodyPrint === expectedPrint)
      && sameHook
      && sameIdentity && measuredConsentHolds(card?.measuredConsent, text, option.digit)
      && this.#sameScreenPermission(text, answered)
    ) {
      return { ok: true, dialog };
    }
    auditRefusal(this.#refusals, 'screen-changed', this.#activeReq?.toolName);
    this.#system(SCREEN_CHANGED_MESSAGE);
    // Karta jest już nieprawdą — gasimy ją i każemy ocenie zbudować nową z tego, co stoi
    // TERAZ (świeży ekran siedzi po `#readDialog(true)` w cache'u tej blokady).
    this.#clearActive('ekran zmienił się przed wysłaniem decyzji');
    this.#scheduleEvaluate();
    return { ok: false, outcome: refused('screen-changed') };
  }

  /**
   * Karta zgody zbudowana Z EKRANU (bez wpisu w jsonl) — czy świeży ekran to WCIĄŻ ten dialog?
   *
   * Taka karta nie ma `tool_use.id`, a jej jedyną tożsamością jest odcisk treści
   * (`screenFormReqId`: nagłówek, pytanie, etykiety). Sama etykieta „Yes" pod cyfrą 1 nie
   * dowodzi niczego: CLI kolejkuje prompty, więc w tej samej blokadzie, bez mignięcia statusu,
   * dialog sieci dla `example.org` potrafi ustąpić dialogowi dla innego hosta — a zgoda z karty
   * starego poszłaby na nowy (odtworzone na atrapie herdr).
   * Karty z jsonl i pytania mają własne bramki, więc tu odpowiadamy `true`.
   */
  #sameScreenPermission(text: string | null, answered: ActiveReq | null): boolean {
    if (answered?.screen !== true || !answered.reqId.startsWith('screen:p:')) return true;
    if (text === null) return false;
    const resolution = resolveOptions(text, null);
    if (resolution.status !== 'no-jsonl' || resolution.questionForm?.kind !== 'tool') return false;
    return screenFormReqId('p', resolution.questionForm) === answered.reqId;
  }

  /**
   * Cyfra poszła w dialog Z EKRANU — panel przemaluje się BEZ mignięcia statusu herdr.
   *
   * Zmierzone (klatki ekranu co 400 ms): formularz `AskUserQuestion` z kilkoma
   * pytaniami po odpowiedzi przełącza zakładkę w miejscu, a `agent_status` zostaje `blocked`
   * bez przerwy — `#onStatus` nie strzela, więc bez tego mechanizmu karta DRUGIEGO pytania
   * nie powstałaby nigdy. Po własnej cyfrze Rarog ponawia ocenę sam: kasuje odpowiedzianą
   * kartę i cache ekranu, potem próbuje ponownie w dwóch odstępach (pierwszy potrafi trafić
   * w środek przemalowania TUI).
   *
   * Każda próba jest fail-closed wobec wyścigów: mignięcie statusu w międzyczasie (nowy numer
   * blokady) albo NOWA karta z opcjami oddają pole zwykłej ścieżce. Zastąpić wolno wyłącznie
   * kartę-fallback bez opcji — czyli dokładnie stan „Rarog nie wiedział, co stoi na ekranie".
   */
  #rearmAfterScreenAnswer(answered: ActiveReq): void {
    if (this.#activeReq === answered) this.#activeReq = null;
    // Ekran sprzed cyfry (`#digitStillHolds` czytał go z `force`) jest z definicji nieaktualny. Gdyby
    // cache kasowały dopiero timery niżej, ocena w pierwszej sekundzie po cyfrze
    // zbudowałaby kartę z dialogu, którego już nie ma.
    this.#dropScreen();
    const seq = this.#blockedSeq;
    this.#answeredSeq = seq;
    this.#answeredAt = this.#scheduler.now();
    const delays = this.#deps.screenAnswerRearmDelaysMs ?? SCREEN_ANSWER_REARM_DELAYS_MS;
    for (const delay of delays) {
      this.#scheduler.setTimeout(() => {
        if (this.#disposed || !this.#blockedNow() || this.#blockedSeq !== seq) return;
        const active = this.#activeReq;
        if (active !== null) {
          // A layer 2 card has no digit options either, but it is the next block of a series, not a misread repaint.
          const fallback = active.screen === true && active.options.length === 0 && !layer2HoldsKeys(active);
          if (!fallback) return;
          // Fallback „odpowiedz w terminalu" po naszej cyfrze to najpewniej odczyt trafiony
          // w przemalowanie — zdejmujemy go, żeby świeży ekran mógł dać prawdziwą kartę.
          this.#clearActive('ekran zmienił się po odpowiedzi');
        }
        this.#dropScreen();
        this.#scheduleEvaluate();
      }, delay);
    }
  }

  /**
   * Osłona po odpowiedzi plikiem — z TERMINEM WAŻNOŚCI.
   *
   * Osłona ma zakryć okno do przyjścia `tool_result` (ułamek sekundy plus debounce followera),
   * a kończy ją zwykle nowa blokada albo nowa generacja zrzutu (`key`). Gdy zrzut następnego
   * wywołania w ogóle nie powstanie (killswitch kanału, błąd zapisu), ani jedno, ani drugie
   * nie nastąpi — a osłona bez terminu trzymała telefon w ciszy do końca blokady. Po
   * `ANSWERED_HOOK_SHIELD_MS` znacznik gaśnie i ocena wraca do zwykłych gałęzi.
   */
  #answeredHookShield(): { questions: readonly string[]; seq: number; key: string } | null {
    const answered = this.#answeredHookCall;
    if (answered === null) return null;
    if (this.#scheduler.now() - answered.at >= ANSWERED_HOOK_SHIELD_MS) {
      this.#answeredHookCall = null;
      return null;
    }
    return { questions: answered.questions, seq: answered.seq, key: answered.key };
  }

  /** Osłona po własnej decyzji dla oceny — wygasła gaśnie tutaj (bliźniak `#answeredHookShield`). */
  #decidedShield(): DecidedShield | null {
    const decided = this.#decided;
    if (decided === null) return null;
    if (this.#scheduler.now() - decided.at >= (this.#deps.decidedShieldMs ?? DECIDED_SHIELD_MS)) {
      this.#decided = null;
      return null;
    }
    return {
      reqId: decided.reqId, callPrint: decided.callPrint, callId: decided.callId, pendingId: decided.pendingId,
      pendingYounger: decided.pendingYounger,
      bodyPrint: decided.bodyPrint, screenReqId: decided.screenReqId, hookAt: decided.hookAt,
      keptHookAt: decided.keptHookAt ?? null, seq: decided.seq,
    };
  }

  /**
   * Generacja zrzutu `PermissionRequest` przed decyzją — czytana PRZED jego skasowaniem, bo nowa generacja
   * po decyzji znaczy nowy dialog i zdejmuje osłonę (`decidedShield` w `herdr/dialogs/decide/decide.ts`).
   * Zrzut innego dialogu, który decyzja zostawia (`#clearHookAfterDecision`), osłony nie zdejmuje, także gdy doszedł
   * w trakcie wysyłki (`keptHookAt` w `#noteDecided`); jego dialog przechodzi ją inną tożsamością i odciskiem.
   */
  #hookGeneration(): number | null {
    const hook = this.#deps.readPendingHook?.(this.#agentSessionId) ?? null;
    return hook !== null && hook.hookEventName === HOOK_PERMISSION_REQUEST_EVENT ? hook.at : null;
  }

  /**
   * Tożsamość dialogu z EKRANU (`screenFormReqId`) — ta sama, którą dostałaby karta z ekranu. Niezależna od
   * źródła karty, więc osłona po decyzji łapie nią kartę ze zrzutu odbudowaną z ekranu.
   */
  #screenIdentity(text: string | null): string | null {
    if (text === null) return null;
    const resolution = this.#resolveOptions(text, null);
    if (resolution.status !== 'no-jsonl' || resolution.questionForm === null) return null;
    return screenFormReqId(resolution.questionForm.kind === 'tool' ? 'p' : 'q', resolution.questionForm);
  }

  /**
   * Zakłada osłonę po decyzji na kartę `card` — tylko po UDANEJ wysyłce. Migawka (`seq`, generacja zrzutu,
   * odciski ekranu) pochodzi sprzed klawisza: w czasie `await` wysyłki może
   * przyjść nowa blokada, nowy wpis jsonl albo zrzut NASTĘPNEGO dialogu, a osłona ma opisywać ten, który
   * Rarog rozstrzygnął.
   *
   * Wpis jsonl obok karty ze zrzutu (`pendingId`, `pendingYounger`) też jest z migawki (`pending`), nie z chwili
   * budowy karty (`besideAtDecision`): karta ze zrzutu `Bash` stoi pod tą samą tożsamością,
   * gdy agent główny zmienia wpis obok, a kotwica sprzed zmiany zdejmowała osłonę po klawiszu.
   *
   * Wyjątek od migawki: `keptHookAt`, generacja zrzutu INNEGO dialogu, który decyzja zostawiła, czytana po
   * klawiszu (`#clearHookAfterDecision`). Zrzut subagenta zapisany w trakcie wysyłki
   * miał inną generację niż migawka i zdejmował osłonę: rozstrzygnięty dialog, wciąż na ekranie, dostawał drugą
   * kartę z przyciskami. Osłona zna tę generację, a dialog zrzutu przechodzi ją innym odciskiem i tożsamością.
   */
  #noteDecided(
    card: ActiveReq, seq: number, hookAt: number | null, pending: PendingTool | null,
    screen: { bodyPrint: string | null; screenReqId: string | null } = { bodyPrint: null, screenReqId: null },
    keptHookAt: number | null = null,
  ): void {
    const beside = besideAtDecision(card, pending);
    this.#decided = {
      reqId: card.reqId,
      callPrint: card.callPrint ?? null,
      callId: card.callId ?? null,
      pendingId: beside.pendingId,
      pendingYounger: beside.pendingYounger,
      bodyPrint: screen.bodyPrint ?? card.bodyPrint ?? null,
      screenReqId: screen.screenReqId ?? (card.screen === true ? card.reqId : null),
      hookAt,
      keptHookAt,
      seq,
      at: this.#scheduler.now(),
    };
  }

  /**
   * Komendy sterujące panelu — dziś wyłącznie `/model` i `/effort`, w tym dwie formy ultracode.
   *
   * Tekst przychodzi GOTOWY: zbudował go manager z wartości ze swojej allow-listy i przepuścił
   * przez guard jawną ścieżką wewnętrzną
   * („Model, effort and permission mode” w `docs/implementation-spec.md`). Driver nie interpretuje go ponownie — robi
   * dokładnie dwie rzeczy, których manager zrobić nie może, bo nie ma dostępu do panelu:
   * wysyła komendę i obsługuje dialog potwierdzenia, którego herdr NIE WIDZI (pułapka 1).
   *
   * Komendy jadą przez tę samą kolejkę co wysyłki, więc `/model` nigdy nie przeplecie się
   * z promptem w środku tury.
   */
  sendCommands(commands: readonly string[]): void {
    this.#assertInScope();
    if (this.#disposed) return;
    for (const command of commands) {
      this.#enqueue(() => this.#runCommand(command));
    }
  }

  /** Jedna komenda sterująca: odczyt pola, wysyłka, potem próba potwierdzenia dialogu cyfrą. */
  async #runCommand(command: string): Promise<void> {
    const dialogStands = await this.#commandSettle.settle();
    if (this.#disposed) return;
    // The consent check's detection read is the screen before the send: the `/effort <level>` freshness baseline.
    let before: string | null = null;
    if (await this.#consentDialogStands((text) => { before = text; })) {
      this.#system(CONSENT_DIALOG_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    if (await this.#formReserve.formStandsNow()) {
      this.#system(FORM_STANDS_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    if (dialogStands || await this.#cliReserve.cliDialogStandsNow()) {
      this.#system(CLI_DIALOG_SEND_MESSAGE);
      return;
    }
    if (this.#disposed) return;
    if (!await this.#commandFieldReady(command)) return;
    // Echo rejestrujemy jak przy zwykłej wysyłce, tuż przed `prompt`: `/model` bywa w jsonl wpisem użytkownika,
    // a transkrypt na telefonie nie ma pokazywać komendy dwa razy. Komenda, która nie poszła, echa nie zostawia.
    this.#follower?.dropEcho(command);
    const ultracode = ultracodeCommandValue(command);
    // Chwila PRZED wysyłką: wynik komendy w pliku rozmowy nie może być starszy od żądania.
    const requestedAt = this.#scheduler.now();
    const sent = await this.#send(
      () => this.#deps.client.prompt(this.#paneId, command),
      { method: 'model_change', text: command },
    );
    if (!sent || this.#disposed) return;
    this.#deps.markSent?.(this.#key);
    // Żądane włączenie ultracode uzbraja regułę pierwszej tury czytelnika pliku rozmowy: tura człowieka po komendzie
    // bez załącznika włączenia znaczy, że CLI go nie włączyło (odmowa, komenda zgubiona).
    if (ultracode === true) this.#follower?.noteUltracodeRequest(requestedAt);
    const outcome = await this.#confirmCommandDialog(command, before);
    if (this.#disposed) return;
    if (outcome === 'confirmed') this.#noteCommandAnswer();
    this.#system(modelOutcomeMessage(command, outcome));
    // Panel PRZYJĄŁ komendę (dialog potwierdzony albo nie było czego potwierdzać) → pigułka
    // modelu ma się zmienić od razu, a nie po następnej turze (jsonl milczy po `/model`,
    // bo komendy lokalne CLI nie tworzą wpisu asystenta). Wynik
    // „obcy dialog" NIE emituje: nie wiadomo, co się stało, a pigułka nie ma prawa kłamać.
    // Ultracode emituje tylko przy wyniku w miejscu zgodnym z wysłaną wartością: komenda w trakcie tury
    // nie pisze wyniku, a stan i tak potwierdzi plik rozmowy.
    if (ultracode === null ? outcome !== 'foreign' : outcome === 'inline') this.#emitModelSet(command);
    this.#deps.logger?.(commandOutcomeLogLine(this.#key, command, outcome, this.#scheduler.now() - requestedAt));
  }

  /**
   * Own digit confirmed in a command dialog: the answer shield as after a digit from a card (the reserves do not take
   * the answered dialog for a new one), only for the block the digit went to ({@link CommandDialogSettle}).
   */
  #noteCommandAnswer(): void {
    this.#dropScreen();
    const seq = this.#commandSettle.answered();
    if (seq === null) return;
    this.#answeredSeq = seq;
    this.#answeredAt = this.#scheduler.now();
  }

  /**
   * Wysłana komenda sterująca → zdarzenie `model-set` (optymistyczna pigułka).
   *
   * Wartość pochodzi z TEKSTU komendy — dokładnie tego, co poszło do panelu (manager zbudował
   * go z własnej allow-listy). Aliasy (`opus`) zostają na pigułce tylko do pierwszej tury:
   * `init` z meta jsonl nadpisze je rozwiązanym identyfikatorem. Wartość spoza wzorca = brak
   * zdarzenia, nigdy wyjątek.
   */
  #emitModelSet(command: string): void {
    const event = modelSetEvent(command);
    if (event !== null) this.#emit(event);
  }

  /**
   * Bramka pola promptu przed komendą sterującą. `agent.prompt` dopisuje tekst do pola CLI i naciska Enter, więc
   * komenda wpisana za cudzym tekstem wysłałaby go razem z nią jako prompt (po przerwaniu CLI oddaje przerwany prompt
   * do pola, a zmiana effortu wysłałaby go drugi raz). Reguła: Rarog nigdy nie naciska Enter, gdy w polu stoi coś
   * poza jego komendą.
   *
   * - `#needsEscape` (tekst w polu zostawił Rarog: przerwanie, stall, blokada hooka) → `#clearComposer`, ta sama
   *   droga co przy wysyłce: para Esc tylko na potwierdzone `filled`. Szkic nie ginie: przerwany prompt apka sama
   *   oddaje do swojego pola.
   * - Potem odczyt CAŁEGO pola (`composerRegionState`, reguła bramki restartu): `empty` → komenda; `filled`
   *   albo `unknown` → zero klawiszy i zdanie w transkrypcie. Odczyt idzie przed KAŻDĄ komendą paczki, bo przy
   *   biurku ktoś mógł zacząć pisać między `/model` a `/effort`.
   *
   * Flaga `#needsEscape` schodzi dopiero przy polu potwierdzonym jako puste: pole dalej pełne po trzech parach Esc
   * zostaje do wyczyszczenia następnej wysyłce, jak dotąd.
   */
  async #commandFieldReady(command: string): Promise<boolean> {
    if (this.#needsEscape) {
      // Pole i tak czyści cała para — pozostałość wstrzymanego promptu razem z resztą.
      this.#promptQueue.heldLeftover = null;
      // A move to another conversation during a field read drops the flag: the pair must not go, and the read below
      // refuses the command on the new conversation's draft.
      const cleared = await this.#clearComposer(undefined, () => !this.#needsEscape);
      if (!cleared || this.#disposed) return false;
    }
    let field: 'filled' | 'empty' | 'unknown';
    try {
      field = composerRegionState((await this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi')).text);
    } catch {
      field = 'unknown';
    }
    if (this.#disposed) return false;
    // Ostatnia, SYNCHRONICZNA kontrola przed `prompt`, jak przy wysyłce: rezerwa z rejestru mogła wejść w trakcie
    // odczytu.
    if (this.#cliReserve.cliHold) {
      this.#system(CLI_DIALOG_SEND_MESSAGE);
      return false;
    }
    if (field === 'empty') {
      this.#needsEscape = false;
      return true;
    }
    const linux = (this.#deps.system ?? serverSystem()) === 'linux';
    this.#system(field === 'unknown'
      ? say('model.change-composer-unknown', { command })
      : say(linux ? 'model.change-unsent-prompt.vps' : 'model.change-unsent-prompt.mac', { command }));
    return false;
  }

  /**
   * Zmiana trybu uprawnień `plan` ↔ `auto`: pętla „`shift+tab` → odczyt stopki → porównaj".
   *
   * Jedzie tą samą kolejką co wysyłki i komendy, więc nigdy nie przeplecie się z promptem.
   * Manager sprawdził już stan, zasięg, killswitch i tryb startowy (`modeCycleStartAllowed`);
   * tu zostają dwie rzeczy, których manager zrobić nie może: klawisz i odczyt ekranu.
   */
  setMode(target: ModeCycleTarget): void {
    this.#assertInScope();
    if (this.#disposed) return;
    this.#enqueue(() => this.#runModeCycle(target));
  }

  /**
   * Pętla cyklu trybu uprawnień. Manager sprawdził stan PRZED zakolejkowaniem, ale kolejka i pauzy trwają sekundy:
   * w tym czasie panel mógł ruszyć z turą (prompt z biurka) albo stanąć na decyzji. Klawisz
   * cyklujący tryb w ŚRODKU tury zmieniałby uprawnienia wykonywanych właśnie poleceń — dlatego
   * stan (`#status`) sprawdzamy na starcie i przed KAŻDYM naciśnięciem, także po asynchronicznym
   * odczycie dialogu. `idle` to jedyny stan, w którym wolno nacisnąć.
   */
  async #runModeCycle(target: ModeCycleTarget): Promise<void> {
    // The mode key would move the selection in a command dialog the driver has just confirmed, or in one behind it.
    const dialogStands = await this.#commandSettle.settle();
    if (this.#disposed) return;
    if (dialogStands) {
      this.#system(CLI_DIALOG_SEND_MESSAGE);
      return;
    }
    const settleMs = this.#deps.modeCycleSettleMs ?? MODE_CYCLE_SETTLE_MS;
    let presses = 0;
    let current: HerdrFooterMode = this.#mode;
    for (;;) {
      const step = nextModeCycleStep(current, target, presses);
      if (step.kind === 'done') {
        // Zero naciśnięć = panel już tam stał (wyścig z biurkiem) — też warto to powiedzieć.
        this.#system(modeCycleDoneMessage(target, presses));
        return;
      }
      if (step.kind === 'stop') {
        this.#system(modeCycleStoppedMessage(target, step.reason, current, presses));
        return;
      }
      // Surowe `idle` nie wystarcza: formularz bez blokady herdr i dialog z rejestru
      // CLI też stoją przy `idle`, a `shift+tab` przełączałby w nich opcje.
      if (this.#status !== 'idle' || this.#formReserve.formFallback !== null || this.#cliReserve.cliHold) {
        this.#system(modeCycleStoppedMessage(target, 'busy', current, presses));
        return;
      }
      if (await this.#consentDialogStands()) {
        this.#system(CONSENT_DIALOG_SEND_MESSAGE);
        return;
      }
      if (this.#disposed) return;
      if (await this.#formReserve.formStandsNow()) {
        this.#system(FORM_STANDS_SEND_MESSAGE);
        return;
      }
      if (this.#disposed) return;
      if (await this.#cliReserve.cliDialogStandsNow()) {
        this.#system(CLI_DIALOG_SEND_MESSAGE);
        return;
      }
      if (this.#disposed) return;
      if (this.#status !== 'idle' || this.#formReserve.formFallback !== null || this.#cliReserve.cliHold) {
        this.#system(modeCycleStoppedMessage(target, 'busy', current, presses));
        return;
      }
      const sent = await this.#send(
        () => this.#deps.client.sendModeCycle(this.#paneId),
        { method: 'send_keys', keys: [MODE_CYCLE_KEY] },
      );
      if (!sent || this.#disposed) {
        if (!this.#disposed) {
          this.#system(modeCycleStoppedMessage(target, 'send-failed', current, presses));
        }
        return;
      }
      presses += 1;
      await this.#sleep(settleMs);
      if (this.#disposed) return;
      current = await this.#readModeAfterPress();
    }
  }

  /**
   * Świeży tryb po naciśnięciu: przez nadzorcę (właściciel trybu; zdarzenie `mode` odświeży
   * `#mode` i chip), a bez niego — z ekranu wprost. Błąd odczytu = `unknown`, czyli stop.
   */
  async #readModeAfterPress(): Promise<HerdrFooterMode> {
    try {
      if (this.#deps.refreshMode !== undefined) return await this.#deps.refreshMode();
      const screen = await this.#deps.client.readScreen(this.#paneId, 'visible');
      const exact = parseModeFooter(screen.text);
      const mode = collapseFooterMode(exact);
      if (mode !== 'unknown' && mode !== this.#mode) {
        this.#mode = mode;
        this.#emitState(this.#status);
      }
      return exact;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Dialog potwierdzenia komendy sterującej — jedyny dialog, który Rarog otwiera SAM z siebie.
   *
   * Reguła jest ta sama, co wszędzie indziej w decyzjach: cyfra pochodzi z TEKSTU opcji,
   * a dialog musi mówić o wysłanej komendzie (`commandDialogMatches`: sygnatura `model` z
   * zamkniętej listy ALBO klasa `confirm` z nazwą/wartością komendy w treści). Ekran
   * z czymkolwiek innym (zgoda na narzędzie, która wjechała w międzyczasie) kończy się ZERO
   * klawiszy i zdaniem w transkrypcie — Rarog nie klika w dialog, którego nie zamawiał.
   *
   * @returns symbol wyniku; zdanie do transkryptu składa `modelOutcomeMessage` z komendą,
   *   bo cisza po tapnięciu wygląda jak awaria
   */
  async #confirmCommandDialog(command: string, before: string | null): Promise<ModelCommandOutcome> {
    const pollMs = this.#deps.modelConfirmPollMs ?? MODEL_CONFIRM_POLL_MS;
    for (let attempt = 0; attempt < MODEL_CONFIRM_ATTEMPTS; attempt += 1) {
      await this.#sleep(pollMs);
      if (this.#disposed) return 'no-dialog';
      let text: string;
      try {
        // Świadomie NIE `#readDialog`: tamten cache'uje ekran bieżącej BLOKADY, a tu żadnej
        // blokady nie ma (herdr widzi panel jako `idle`) — zapisanie tam ekranu podkładałoby
        // nieaktualny widok pod następną prawdziwą kartę zgody.
        text = (await this.#deps.client.readScreen(this.#paneId, 'detection')).text;
      } catch {
        continue;
      }
      const dialog = parseOptions(text);
      /*
       * Bez dialogu o czytelnym kształcie — albo ekran nie ma cyfr wcale, albo ma je bez kształtu dialogu (`other`:
       * brak odgrodzonego regionu, pytania, narzędzia) i bez sygnatury z zamkniętej listy. To najczęściej numerowana
       * lista z odpowiedzi agenta w scrollbacku („1. Przeklikaj… 2. Zaloguj…" nad echem `/model`), która kończyłaby
       * się „nie rozpoznałem" i pigułką bez zmiany, choć panel model ustawił. Wtedy rozstrzyga wiersz wyniku „⎿ Set
       * model to …" (CLI 2.1.258 nie stawia już dialogu): jest = koniec czekania, nie ma = czekamy dalej. Dialog ma
       * PIERWSZEŃSTWO przed wierszem wyniku, bo starsze CLI rysowało oba naraz (`dialog-model-switch.txt`, 2.1.241:
       * wynik nad „Switch model?"). `foreign` zostaje dla PRAWDZIWEGO dialogu, który mówi o czym innym.
       */
      const shapeless = dialog === null
        || (dialog.kind === 'other' && matchKnownDialog(text, dialog) === null);
      // "Switch model?" under the status rule: confirmed from its block after the send shield (`commands.ts`). It also
      // runs when a consent question quoted in scrollback gives the old parser another kind.
      const { client } = this.#deps;
      // The wait of the next step is armed and the answered block read right before the key (`digitGoes`).
      const sendKeys = (keys: readonly string[]) => {
        this.#commandSettle.digitGoes(command);
        return client.sendKeys(this.#paneId, keys);
      };
      const switchBlock = () => confirmModelSwitch(command, text, {
        ...this.#layer2StepPort(), readScreen: () => client.readScreen(this.#paneId, 'detection'),
        sendDigit: (entry) => this.#send(() => sendKeys(entry.keys), entry),
      });
      if (shapeless) {
        const switched = await switchBlock();
        if (switched !== null) return switched;
        if (commandResultInline(command, text, before)) return 'inline';
        if (commandRefusedInline(command, text)) return 'refused';
        continue;
      }
      if (!commandDialogMatches(command, text, dialog)) return (await switchBlock()) ?? 'foreign';
      const option = affirmativeOption(dialog.options);
      if (option === null) return 'foreign';
      // Dziennik nazywa rozpoznanie, którym dialog przeszedł: `dialog:model` = sygnatura
      // z zamkniętej listy, `dialog:confirm` = klasa potwierdzeń (silnik dialogów).
      const known = matchKnownDialog(text, dialog);
      const ok = await this.#send(
        () => sendKeys([option.digit]),
        {
          method: 'model_change',
          keys: [option.digit],
          toolName: `${SCREEN_DIALOG_TOOL}:${known ?? 'confirm'}`,
          optionLabel: option.label,
        },
      );
      return ok ? 'confirmed' : 'foreign';
    }
    return 'no-dialog';
  }

  /**
   * Interrupts the turn with ONE `escape`, not `ctrl+c`: Esc is Claude Code's own interrupt, and a second one on an
   * empty field opens the rewind. Whether Esc handed the prompt back to the field: {@link returnedPrompt}. The promise
   * settles AFTER the key went (`true` = sent), as the interrupt waits in the send queue; the router builds `delivered`
   * from it. Not `async`: `#assertInScope()` must throw synchronously, or an out-of-scope refusal stops being a 400.
   */
  interrupt(): Promise<boolean> {
    this.#assertInScope();
    if (this.#disposed) return Promise.resolve(false);
    // Flaga PRZED wysyłką: nawet gdy `escape` nie dojdzie, następna wysyłka ma wyczyścić pole.
    this.#needsEscape = true;
    const session = this.#agentSessionId;
    // After Esc the field no longer surely holds the blocked prompt: it may hold the interrupted one.
    this.#turnGuard.blockedLeftover = null;
    const token = ++this.#interruptProbeToken;
    return this.#enqueue(async () => {
      const expected = await this.#returnedPrompt.beforeEscape(this.#engine === 'claude' && !this.#blockedNow()
        && this.#activeReq === null && this.#promptQueue.prompts.length === 0 && !this.#promptQueue.submitUnsettled()
        && !this.#takeBack.holdsField());
      /*
       * "Session paused": Esc from the app keyboard with focus outside the card comes here, not through "Deny", and Esc
       * on the pause stays a refusal (`#pauseBlocksEscape`): before any state change and after the field read above, so
       * no read follows the gate before the key. `refuseDecision` restores the card the manager took at the interrupt.
       */
      if ((await this.#pauseBlocksEscape()).blocks) {
        if (!this.#disposed) {
          refuseDecision(
            this.#refusals, PAUSE_ESCAPE_MESSAGE, 'przerwanie: Esc na pauzie „Session paused”', 'terminal-only',
          );
        }
        return false;
      }
      /*
       * Przerwanie unieważnia watchdog tury: pytanie „wysłane, a panel nie ruszył?" traci
       * sens, gdy to człowiek świadomie ubił turę — bez tego watchdog umiał po karencji
       * zgłosić fałszywe „wiadomość utknęła" nad turą przerwaną Esc. W ZADANIU, nie w metodzie
       * publicznej: kolejka gwarantuje, że wysyłka sprzed przerwania zdążyła się uzbroić.
       */
      this.#turnGuard.clearWatchdog();
      this.#turnGuard.localCommand = null;
      // Set again here: a send that was in flight when Esc came cleared the flag in `afterSubmit`, yet Esc may hand
      // that prompt back to its field (CLI 2.1.329), and the next send would type behind it. Not after a move to
      // another conversation: its field holds that conversation's text, not the prompt this interrupt was accepted for.
      if (this.#agentSessionId === session) this.#needsEscape = true;
      /*
       * Czy było CO przerywać — mierzone PRZED wysłaniem klawisza, bo po nim `#status` zdąży
       * już opisywać skutek Esc, a nie stan zastany. To jest jedyny warunek wpisu w transkrypcie
       * (patrz `INTERRUPT_DONE_MESSAGE`); klawisz idzie ZAWSZE, także nad stojącym panelem —
       * bramka na wysyłce połykałaby prawdziwe przerwania w karencji `waiting-input`.
       */
      const midTurn = this.#midTurn;
      const sent = await this.#send(
        async () => {
          try {
            await this.#deps.client.sendKeys(this.#paneId, ['escape']);
          } catch (err) {
            /*
             * `herdr-stalled` to fałszywy alarm, nie porażka: herdr nie doczekał się
             * potwierdzenia z ekranu, ale klawisz POSZEDŁ (ten sam wzorzec co
             * `#promptAttempt`). Dla `delivered` liczy się dostarczenie — przepuszczenie
             * tego jako błąd malowałoby w kliencie czerwony baner z „Pokaż w herdr" nad
             * przerwaniem, które zadziałało, i zachęcało do drugiego Esc (a ten na pustym
             * polu otwiera w CC rewind).
             *
             * WYŁĄCZNIE wariant z prawdziwego `agent_prompt_stalled` (`stalledByRemoteCode`):
             * rozpoznanie po treści komunikatu obsługuje `agent.prompt` z `wait`, a `send_keys`
             * `wait`-a nie używa — więc tutaj byłoby połknięciem nieznanej awarii.
             */
            if (herdrCode(err) !== 'herdr-stalled' || !stalledByRemoteCode(err)) throw err;
          }
        },
        { method: 'send_keys', keys: ['escape'] },
        'interrupt',
      );
      this.#returnedPrompt.start(sent ? expected : null,
        () => this.#disposed || token !== this.#interruptProbeToken || this.#agentSessionId !== session);
      if (sent && !this.#disposed) {
        /*
         * Ślad po geście pisze SERWER, a nie telefon: tylko on zna
         * wynik dostarczenia, a `#appendMessage` w managerze zapisuje wiadomość systemową
         * TRWALE — więc wpis widać z drugiego urządzenia i po powrocie do sesji.
         *
         * Wyłącznie sukces NAD TURĄ: każda odmowa ma już swoje zdanie z `⚠` i nazwaną przyczyną
         * w `#reportSendError` (`SendOp === 'interrupt'`), a dwa ostrzeżenia o jednym klawiszu
         * jedno pod drugim są szumem. Bez `midTurn` wpis kłamałby przy Esc do panelu, który
         * już stoi: żadnej tury nie było, a w Claude Code taki `escape` na pustym composerze
         * mógł otworzyć REWIND — o czym „Tura przerwana z Raroga" nie mówi ani słowa.
         */
        if (midTurn) this.#system(INTERRUPT_DONE_MESSAGE);
        this.#probeAfterInterrupt(token);
      }
      return sent;
    // Krok, który poległ, oddaje `undefined` — dla przerwania to znaczy „klawisz nie poszedł".
    }).then((sent) => sent ?? false);
  }

  /** {@link SessionDriver.returnedPrompt}: the field read after the last delivered `escape` (`returned-prompt.ts`). */
  returnedPrompt(): Promise<string | null> {
    return this.#returnedPrompt.answer();
  }

  /**
   * Sonda stanu po przerwaniu — poza kolejką wysyłek (nie blokuje kolejnych promptów).
   *
   * Emituje WYŁĄCZNIE spoczynek (`idle`/`done`): to on gasi wskrzeszony spinner. Każdy inny
   * odczyt zostawiamy zwykłym pushom — `working` z sondy mógłby pochodzić od tury, którą
   * użytkownik właśnie zaczął W TERMINALU, i wtedy pushe i tak przyjdą. Token unieważnia
   * sondę, gdy w międzyczasie ruszyła nowsza wysyłka albo kolejne przerwanie.
   */
  #probeAfterInterrupt(token: number): void {
    void (async () => {
      const delays = this.#deps.interruptProbeDelaysMs ?? INTERRUPT_PROBE_DELAYS_MS;
      for (const delay of delays) {
        await this.#sleep(delay);
        if (this.#disposed || token !== this.#interruptProbeToken) return;
        let status: HerdrAgentStatus;
        try {
          status = (await this.#deps.client.getAgent(this.#paneId)).status;
        } catch {
          // Zniknięcie panelu ogłosi resync supervisora; sonda nie ma tu nic do dodania.
          return;
        }
        if (this.#disposed || token !== this.#interruptProbeToken) return;
        if (status === 'idle' || status === 'done') {
          this.#status = status;
          this.#emitState(status);
          return;
        }
      }
    })();
  }

  /**
   * Fakty przed restartem sesji: świeże `agent.get`, cały obszar pola promptu i DOKŁADNY
   * tryb ze stopki. Trzy odczyty równolegle, żadnej wysyłki. Każdy błąd odczytu to „nie wiem"
   * (`null`/`unknown`) — manager odmawia restartu, zamiast zgadywać.
   */
  async restartProbe(): Promise<RestartProbe> {
    this.#assertInScope();
    const [agent, composer, mode] = await Promise.all([
      this.#deps.client.getAgent(this.#paneId).then(
        (info) => ({ agentSessionId: info.agentSessionId, status: info.status }),
        () => null,
      ),
      this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi').then(
        (screen) => composerRegionState(screen.text),
        () => 'unknown' as const,
      ),
      this.#readModeAfterPress(),
    ]);
    return { agent, composer, mode };
  }

  /**
   * `/exit` do panelu — tekst stały, ścieżką slash-komendy: `#send` bez `wait`, bez
   * stall-guarda i bez watchdoga tury. Stall-guard przy `/exit` zawsze by „zadziałał" (proces
   * wychodzi zamiast wejść w `working`) i posłał parę Esc do POWŁOKI. Wpis `prompt` w dzienniku
   * jak przy każdej slash-komendzie. W kolejce wysyłek, żeby nie wyprzedzić wysyłki sprzed chwili.
   */
  requestExit(): Promise<boolean> {
    this.#assertInScope();
    if (this.#disposed) return Promise.resolve(false);
    return this.#enqueue(async () => {
      const sent = await this.#send(
        () => this.#deps.client.prompt(this.#paneId, RESTART_EXIT_COMMAND),
        { method: 'prompt', text: RESTART_EXIT_COMMAND },
      );
      if (sent) this.#deps.markSent?.(this.#key);
      return sent;
    }).then((sent) => sent === true);
  }

  /** Task lines of the exit dialog after `/exit`, one screen read and no key: `exitDialogTasks`. */
  readExitTasks(): Promise<readonly string[] | null> {
    return this.#deps.client.readScreen(this.#paneId, 'detection').then((screen) => exitDialogTasks(screen.text));
  }
  /** Czyszczenie pola z NASZYM zablokowanym promptem przed restartem: {@link TurnGuard.clearBlockedLeftover}. */
  clearBlockedLeftover(engineSessionId: string): Promise<BlockedLeftoverClear> {
    this.#assertInScope();
    return this.#turnGuard.clearBlockedLeftover(engineSessionId);
  }

  /**
   * Odczyt pola po turze dla wstrzymanych promptów (`docs/dialogs.md`, „Prompt blocked by a hook”) — zadanie w
   * kolejce wysyłek, więc wysyłka dołożona zaraz za nim widzi już `heldLeftover` kolejki wklejeń i czyści pole, zanim
   * dopisze swój tekst. Zero klawiszy: jeden odczyt ekranu z atrybutami, werdykty liczy `herdr/commands.ts`
   * (`not-taken` tylko przy polu RÓWNYM tekstowi wiadomości albo sklejce kolejnych). Wiadomość z kolejki wklejeń,
   * której tekstu driver nie zobaczył w polu albo której pole opustoszało przy biurku przed Enterem
   * (`PromptQueue.unseen`), dostaje przy pustym albo nieczytelnym polu `unseen`.
   *
   * `valid()` jest pytane po odczycie, przed flagami: odczyt unieważniony przez wołającego (tura wróciła, nowszy
   * odczyt, rezerwacja restartu) nie ustawia `heldLeftover` kolejki wklejeń i nie rusza okna echa. `blockedLeftover`
   * (zgoda na czyszczenie przed restartem) nie powstaje nigdy: powodu odmowy CLI nigdzie nie zapisał.
   */
  checkHeldLeftover(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> | null {
    if (this.#disposed || !this.#readsHeldField) return null;
    return this.#enqueue(async (): Promise<ReadonlyMap<string, HeldLeftover> | null> => {
      if (this.#disposed) return null;
      let region: string | null;
      try {
        region = composerRegionText((await this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi')).text);
      } catch {
        region = null;
      }
      if (this.#disposed || !valid()) return null;
      const verdicts = this.#promptQueue.fieldVerdicts(items, region);
      for (const item of items) {
        if (verdicts.get(item.token) !== 'not-taken') continue;
        // CLI oddał prompt do pola: następna wysyłka czyści je, o ile pole dalej trzyma dokładnie tę treść.
        if (region !== null) this.#promptQueue.heldLeftover = squashWhitespace(region);
        // Token wstrzymanej wiadomości wypada z okna echa: wiadomość stoi już w transkrypcie, a identyczny
        // prompt wysłany potem przy Macu ma przyjść jako zwykły wpis, nie zginąć jako jej duplikat.
        this.#follower?.forgetEcho(item.token);
      }
      return verdicts;
    }).then((result) => result ?? null);
  }

  /**
   * Czy driver czyta pole po turze ({@link checkHeldLeftover}): panel w zasięgu i rozpoznanie blokady promptu włączone
   * (`RAROG_PROMPT_BLOCK`). Ten sam warunek pilnuje zapisu tokenów `unseen` kolejki: tokenu bez odczytu nikt nie użyje.
   */
  get #readsHeldField(): boolean {
    return this.#inScope && this.#deps.promptBlock !== false;
  }

  /**
   * Sygnał rejestru sesji CLI — z szybkiego tiku managera, przy KAŻDYM odczycie.
   *
   * Trzy przypadki:
   * - `waiting` przy panelu, który NIE stoi (herdr `working`/`idle`/`done`, bez rezerwy) —
   *   szturchnięcie: serializowana ocena (`#evaluate`), która czyta ekran i dopiero NA NIM
   *   opiera blokadę. Ponowienia przychodzą same z kolejnych tików, w budżecie
   *   {@link CLI_WAITING_PROBES} prób na epizod — tak długo, jak `waiting` trwa;
   * - `waiting` przy panelu, który już stoi — nic: zegar oceny stojącego dialogu robi swoje;
   * - koniec `waiting` — rezerwa z rejestru schodzi; przy `busy`/`idle` (rejestr MÓWI, że dialog
   *   zamknięto) schodzi też rezerwa formularza. „Nie wiem" (`unknown`: dwóch pisarzy, brak
   *   wpisu) to powrót do samego sygnału herdr, nie dowód zamknięcia.
   *
   * Klawisza ten sygnał nie daje nigdy: karta powstaje zwykłą drogą (`decideCard`), a cyfra
   * dalej wychodzi wyłącznie z ekranu, przez `#digitStillHolds`.
   *
   * Sygnał bez `waiting: permission` idzie też od razu do cyklu kanału zgód
   * ({@link HerdrDriverDeps.consentRegistryNotWaiting}), przed startem obserwacji: dowód z kanału z odczytów nie
   * późniejszych przestaje obowiązywać, także przy obserwacji w toku.
   */
  noteCliWaiting(signal: CliWaitingSignal): void {
    if (this.#disposed || !this.#inScope) return;
    this.#cliReserve.cliSignal = signal;
    this.#cliReserve.cliSignalAt = this.#deps.now();
    this.#cliReserve.cliSignalSession = this.#agentSessionId;
    this.#cliReserve.cliSignalGen += 1;
    noteConsentRegistryRead(this.#deps, this.#agentSessionId, signal, this.#cliReserve.cliSignalAt);
    this.#consentChannel.consentObserveStep();
    this.#shadowRelease();
    const waiting = signal.kind === 'waiting' ? signal.dialog : null;
    const was = this.#cliReserve.cliWaiting;
    this.#cliReserve.cliWaiting = waiting;
    this.#noHook.registrySignal(signal.kind === 'active');
    if (signal.kind === 'active') this.#cliReserve.cliActiveAt = this.#scheduler.now();
    if (waiting === null) {
      if (was !== null) this.#cliReserve.onCliWaitingEnd(signal.kind === 'active');
      this.#syncUndecidedClass();
      return;
    }
    // Nowy epizod = nowy budżet prób: wejście w `waiting` albo inna klasa (następny dialog).
    if (was !== waiting) this.#cliReserve.cliEpisode += 1;
    this.#syncUndecidedClass();
    if (this.#blockedNow() || this.#consentDialog !== null) return;
    // Osłona po WŁASNEJ odpowiedzi: rejestr stoi na `waiting` jeszcze chwilę po niej (a przy
    // pytaniu przez cały czas czekania hooka na plik) — to nie jest nowy dialog.
    if (this.#cliReserve.cliShieldUp() || !this.#cliReserve.cliProbeLeft()) return;
    void this.#evaluate();
  }

  /**
   * Szturchnięcie kanału zgód z managera: świeży odczyt rejestru zaraz po przyjętej rejestracji hooka tej sesji albo po
   * wejściu panelu w blokadę, bez czekania na takt. Przy `waiting: permission` to samo co odczyt z taktu
   * ({@link noteCliWaiting}: obserwacja z własnym odczytem ekranu), a obserwacja w toku dostaje po sobie jeszcze jedną.
   * Każdy inny sygnał zdejmuje od razu dowód z kanału z odczytów nie późniejszych ({@link noteConsentRegistryRead}),
   * ale obserwacji nie startuje: bez `waiting: permission` nie czyta ekranu, więc dałaby kartę bez przycisku zgody.
   */
  noteConsentNudge(signal: CliWaitingSignal): void {
    if (this.#disposed || !this.#inScope) return;
    noteConsentRegistryRead(this.#deps, this.#agentSessionId, signal, this.#deps.now());
    if (!cliWaitsForPermission(signal)) return;
    if (this.#consentChannel.consentObserving) this.#consentChannel.consentObserveAgain = true;
    this.noteCliWaiting(signal);
  }

  /**
   * Start jedynego procesu CLI tej rozmowy — z odczytu rejestru w managerze.
   *
   * Driver tylko podaje fakt followerowi, który trzyma maszynę stanów zadań w tle: to ona zamyka
   * subagentów sprzed restartu procesu (`herdr/background/reducer.ts`, reguła 10). Fakt o INNEJ
   * rozmowie niż ta, na której stoi panel (odczyt rejestru sprzed `/clear` albo `/resume`),
   * odpada: w nowej rozmowie mógłby zamknąć agentów, których pisze drugi proces. Powtórki tej
   * samej chwili gasi follower, więc tu nie ma żadnego stanu do pilnowania.
   */
  noteCliProcessStart(start: CliProcessStart): void {
    if (this.#disposed || start.sessionId !== this.#agentSessionId) return;
    this.#follower?.noteProcessStart(start.startedAt);
    crons.noteScheduledTasksProcessStart(this.#crons, this.#cronsDeps, start.startedAt);
  }

  /** Żądanie ultracode: odcięcie i regułę pierwszej tury trzyma czytelnik pliku rozmowy. */
  noteUltracodeRequest(atMs: number, firstTurn = true): void {
    if (this.#disposed) return;
    this.#follower?.noteUltracodeRequest(atMs, firstTurn);
  }

  /**
   * Odpięcie drivera.
   *
   * NIE WYSYŁA DO HERDR NICZEGO. Panel żyje dalej w terminalu użytkownika — zamyka follower
   * i odpina słuchacza uchwytu, i na tym koniec. Wszystko, co dodasz tu poniżej, wykona się
   * przy każdym restarcie Raroga razy liczba paneli.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#evalTimer !== null) {
      this.#scheduler.clearTimeout(this.#evalTimer);
      this.#evalTimer = null;
    }
    this.#turnGuard.clearWatchdog();
    this.#consentChannel.dispose();
    this.#noHook.dispose();
    stopTasks(this.#tasks, this.#scheduler);
    if (this.#blockedTimer !== null) {
      this.#scheduler.clearTimeout(this.#blockedTimer);
      this.#blockedTimer = null;
    }
    // Wiadomości z kolejki wklejeń zostają bez klawisza: wstrzymane echa spłukuje manager przy odpięciu.
    this.#promptQueue.release();
    this.#takeBack.release();
    this.#unsubscribe();
    this.#follower?.close();
    this.#pulse?.close();
    this.#runReader?.close();
    this.#agentReader?.close();
    if (this.#pullRequests.prTimer !== null) {
      this.#scheduler.clearTimeout(this.#pullRequests.prTimer);
      this.#pullRequests.prTimer = null;
    }
    this.#pullRequests.prReader?.close();
    crons.stopScheduledTasks(this.#crons, this.#scheduler);
    this.#queue.close();
  }

  // -------------------------------------------------------------------------
  // Uchwyt agenta
  // -------------------------------------------------------------------------

  #onPaneEvent(ev: HerdrPaneEvent): void {
    if (this.#disposed) return;
    switch (ev.type) {
      case 'status':
        this.#stateChangeSeq = ev.stateChangeSeq;
        // Tytuł jedzie w KAŻDYM zdarzeniu statusu (nadzorca emituje je też na samą zmianę
        // tytułu) — bez tego /rename w terminalu nie zmieniał etykiety karty w Rarogu.
        this.#noteTitle(ev.title);
        this.#onStatus(ev.status);
        return;
      case 'mode': {
        this.#mode = ev.mode;
        // Samo `mode` nie zmienia stanu — mapowanie w managerze wykona przejście na ten sam stan
        // (identyczność), a chip trybu na karcie dostanie świeżą wartość.
        this.#emitState(this.#status);
        return;
      }
      case 'session-changed': {
        this.#agentSessionId = ev.agentSessionId;
        this.#follower?.repoint(ev.agentSessionId);
        // Nowa sesja silnika = INNY katalog satelity; puls, który patrzy w stary, patrzy w przeszłość.
        this.#pulse?.repoint(ev.agentSessionId);
        this.#runReader?.repoint(ev.agentSessionId);
        this.#agentReader?.repoint(ev.agentSessionId);
        this.#pullRequests.prReader?.repoint(ev.agentSessionId);
        this.#schedulePullRequests(0);
        crons.repointScheduledTasks(this.#crons, this.#cronsDeps, ev.agentSessionId);
        forgetSession(this.#tasks);
        this.#lastFollowAt = this.#scheduler.now();
        // Pole nowej rozmowy nie trzyma promptu zablokowanego w poprzedniej ani tekstu oddanego po jej Enterze.
        this.#turnGuard.blockedLeftover = null;
        this.#returnedPrompt.conversationChanged();
        // The new conversation ran no send: a block entry of the old file still on its way decides none (notice only).
        this.#turnGuard.executedGeneration = 0;
        this.#promptQueue.heldLeftover = null;
        this.#promptQueue.submitted = null;
        // Nor text known to be Rarog's: the new field's text counts as a draft at the desk, which no Esc pair clears.
        this.#needsEscape = false;
        // Karta czekającej decyzji należała do POPRZEDNIEJ sesji silnika — po `/clear` nie ma
        // czego zatwierdzać, a wisząca karta zatwierdzałaby coś, czego już nie ma.
        this.#pending = null;
        this.#formReserve.formProbe = null;
        this.#formReserve.leaveFormFallback('nowa sesja silnika');
        // Sygnał rejestru dotyczył POPRZEDNIEJ rozmowy — nowy przyjdzie z najbliższego tiku.
        this.#cliReserve.leaveCliHold('nowa sesja silnika');
        this.#cliReserve.cliWaiting = null;
        this.#cliReserve.cliProbe = null;
        // Takt obserwacji kanału przy prośbie subagenta należał do poprzedniej sesji. `cliSignal` zostaje (ścieżki
        // cienia), a obserwacja kanału nowej sesji nie bierze go za swój rejestr (`ConsentChannel`).
        this.#consentChannel.clearConsentSubagentTimer();
        this.#clearActive('nowa sesja silnika');
        // `model: ''` jest bezpieczny: manager nadpisuje model tylko dla niepustej wartości,
        // a model przyjdzie zaraz z jsonl nowego pliku (`meta`).
        this.#emit({ type: 'init', engineSessionId: ev.agentSessionId, model: '' });
        return;
      }
      case 'consent-dialog':
        void this.#noteConsentDialog(ev.dialog);
        return;
      case 'pane-changed':
        // `pane move`: ten sam agent pod nowym adresem. Zero zdarzeń do managera — dla sesji
        // Raroga nic się nie zmieniło.
        this.#paneId = ev.paneId;
        return;
      case 'gone':
        // Panel zamknięty przez użytkownika. Strumień się kończy; `gone` cyklu życia (kanał
        // supervisor → manager) domknie sesję. Driver nie zgaduje stanu za managera.
        this.dispose();
        return;
    }
  }

  /** Zmieniony auto-tytuł → osobne zdarzenie (etykieta karty nie czeka na zmianę stanu). */
  #noteTitle(title: string | undefined): void {
    if (title === undefined || title === '' || title === this.#lastTitle) return;
    this.#lastTitle = title;
    this.#emit({ type: 'title', title });
  }

  #onStatus(status: HerdrAgentStatus): void {
    // `unknown` znaczy dokładnie „nie wiem": zostawiamy poprzedni stan, nigdy nie udajemy końca.
    if (status === 'unknown') return;
    if (status === 'working' || status === 'blocked') this.#turnGuard.turnEntries += 1;
    /*
     * Wejście liczymy z blokady EFEKTYWNEJ: herdr zgłaszający `blocked` nad formularzem,
     * który rezerwa już trzyma, to ta sama blokada — nowy numer rozbroiłby osłony po własnej
     * odpowiedzi i weryfikację `enter`, a gaszenie karty dałoby miganie i fałszywe `idle`.
     */
    const entering = status === 'blocked' && !this.#blockedNow();
    // Blokada (herdr albo rezerwa formularza) właśnie by zeszła — moment na wyjątek rejestru niżej.
    const leaving = status !== 'blocked'
      && (this.#status === 'blocked' || (this.#formReserve.formFallback !== null && status === 'working'));
    if (this.#formReserve.formFallback !== null && (status === 'working' || status === 'blocked')) {
      // Przejęcie (herdr sam widzi blokadę) albo ruszona tura — rezerwa schodzi PO CICHU,
      // bez `#clearActive` i bez emisji: resztę robi zwykła logika niżej (jedno przejście stanu).
      this.#formReserve.formFallback = null;
      this.#formReserve.formMisses = 0;
    }
    // herdr sam widzi blokadę — rezerwa z rejestru oddaje mu ją PO CICHU (ta sama blokada).
    // The block only changes hands, so the consent-without-hook episode goes on.
    if (status === 'blocked') this.#noHook.handover(() => { this.#cliReserve.dropCliHold(); });
    /*
     * Spóźniony herdr `working` (albo `idle`/`done`), a rejestr CLI dalej mówi `waiting`:
     * dialog sprzed chwili wciąż stoi, więc blokada przechodzi na rezerwę z rejestru — bez nowego
     * numeru blokady i bez gaszenia karty. Zdejmie ją rejestr (`busy`/`idle`) albo dwa odczyty
     * z polem promptu. Wyjątek nie działa w osłonie po WŁASNEJ odpowiedzi: wtedy `working` to
     * skutek naszej cyfry albo pliku, a rejestr po prostu jeszcze nie zdążył.
     */
    if (
      leaving && !this.#cliReserve.cliHold && this.#cliReserve.cliWaiting !== null
      && this.#inScope && this.#consentDialog === null && !this.#cliReserve.cliShieldUp()
    ) {
      this.#cliReserve.cliHold = true;
      this.#cliReserve.cliMisses = 0;
    }
    // Wejście w turę zeruje licznik ciszy: „myśli od 40 s" na starcie tury byłoby zdaniem
    // o poprzedniej turze.
    if (status === 'working' && this.#status !== 'working') {
      // Tura ruszyła = dialog zgody nie stoi (CLI nie startuje tury nad nim).
      this.#consentDialog = null;
      this.#lastFollowAt = this.#scheduler.now();
      // Agent PRACUJE, więc plik transkryptu ma prawo istnieć — także wtedy, gdy turę wywołał
      // człowiek przy biurku, a nie Rarog. To drugi z dwóch powodów uzbrojenia strażnika.
      this.#follower?.expectTranscript();
    }
    if (status === 'blocked' && this.#status !== 'blocked') this.#blockedStarts += 1;
    this.#status = status;
    this.#syncPulse();
    // Zegar ponownej oceny chodzi DOKŁADNIE tak długo, jak trwa blokada.
    this.#syncBlockedPoll();
    if (entering) {
      // Nowa blokada = nowy ekran i nowy identyfikator dialogu spoza jsonl.
      this.#blockedSeq += 1;
      this.#blockedAt = this.#scheduler.now();
      this.#dropScreen();
      this.#reportBlocked();
      return;
    }
    if (status !== 'blocked') this.#dropScreen();
    this.#emitState(status);
    // Wyjście z `blocked` gasi kartę: człowiek zdecydował przy biurku albo agent ruszył dalej.
    this.#scheduleEvaluate();
  }

  /**
   * Wejście w `blocked`: odczyt ekranu do pamięci, potem zmiana stanu.
   *
   * Ekran czytamy tutaj, w ocenie decyzji (`--source detection`) i przy panelu
   * `idle`/`done`, ale WYŁĄCZNIE gdy czeka `AskUserQuestion` (rezerwa formularza). Nic z niego nie
   * idzie do logów ani do pusha — ekran potrafi zawierać treść `.env`; na telefon jedzie
   * dopiero wycinkiem NA KARCIE dialogu. Odczyt jest WSPÓLNY z `#evaluate()`
   * (pole `#screenText`): dialog nie zmienia się między jednym a drugim, a każdy `agent.read`
   * to ruch na cudzym panelu — po to ten odczyt tu został, choć sam niczego już nie emituje.
   */
  #reportBlocked(): void {
    // Panel poza `RAROG_HERDR_ROOTS`: stan pokazujemy, ekranu NIE czytamy. Treść dialogu
    // to treść cudzego panelu (potrafi zawierać `.env`), a dla tych paneli Rarog świadomie
    // nie oddaje żadnej treści — ani z pliku, ani z ekranu.
    if (!this.#inScope) {
      this.#emitState('blocked');
      return;
    }
    void this.#readDialog(false)
      .catch(() => undefined)
      .finally(() => {
        // Stan leci ZAWSZE, także gdy ekranu nie dało się odczytać: „czeka na decyzję" jest
        // ważniejsze niż treść dialogu, a bez niego composer zostałby aktywny.
        if (this.#disposed) return;
        this.#emitState('blocked');
        this.#scheduleEvaluate();
      });
  }

  /**
   * Ekran dialogu — ze ŚWIEŻEJ pamięci albo z gniazda.
   *
   * The memory has an expiry ({@link HERDR_SCREEN_CACHE_MS}): a screen kept for the whole block would rest on
   * the assumption "the dialog does not change while herdr says `blocked`", which is false both ways. An
   * `AskUserQuestion` form switches questions in place, and a consent approved at the desk gives way to the next
   * one without a single `working` frame, so Rarog would show a card that DESCRIBES SOMETHING ELSE than the
   * terminal. The short window exists so that `#reportBlocked` and the nearest evaluation share ONE read.
   *
   * @param force pomija pamięć (ponowny odczyt po nieudanym parsowaniu, weryfikacja
   *   przed cyfrą)
   */
  async #readDialog(force: boolean): Promise<string | null> {
    if (!force && this.#screenCached()) return this.#screenText;
    try {
      const screen = await this.#deps.client.readScreen(this.#paneId, 'detection');
      if (this.#disposed) return null;
      this.#screenText = screen.text;
      this.#screenAt = this.#scheduler.now();
      this.#notePause(screen.text);
      return screen.text;
    } catch {
      // Zrzutu NIE kasujemy: nieudany odczyt to „nie wiem", a stojąca karta ma przeżyć
      // chwilową awarię gniazda. Wołający dostaje `null` i sam decyduje, co z tym zrobić.
      return null;
    }
  }

  /**
   * Czy `escape` trafiłby w pauzę „Session paused"?
   *
   * Esc zmierzono tylko na pauzie wywołanej atrapą API (CLI 2.1.322), bo prawdziwej pauzy nie wolno wywołać celowo
   * (to mechanizm bezpieczeństwa modelu), a pauza nie ma stopki, która by go nazywała. Dlatego „Odrzuć" i przerwanie
   * nie wysyłają na nią klawisza.
   *
   * Ekran czytamy ŚWIEŻO, tuż przed klawiszem (`#readDialog(true)` — ten sam ekran trafia do zrzutu odmowy),
   * przy każdej blokadzie (`#blockedNow`): karta i ostatni odczyt nie dowodzą, że pauzy nie ma — dialog
   * potrafi się podmienić w miejscu, zanim ocena przeczyta ekran. Bez blokady
   * i bez podejrzenia Esc idzie jak dotąd, bez odczytu (przerwanie zwykłej tury). Podejrzenie pauzy to karta
   * pauzy albo ślad pauzy z odczytu w tej blokadzie (`#pauseSeq`, przeżywa odmowę i zgaszoną kartę).
   * Odmowa, gdy:
   * - pauza stoi na świeżym ekranie (`sessionPausedDialog` — każdy wariant, także spoza listy);
   * - przy podejrzeniu: odczyt się nie udał albo ekran nie pokazuje żadnego dialogu (przemalowanie) —
   *   nie wiadomo, czy pauza zeszła.
   * Inny czytelny dialog = pauza zeszła (ślad gaśnie w `#notePause`), Esc idzie jak dotąd.
   *
   * @returns `blocks` = odmowa; `text` = świeży ekran tej bramki (`null` bez odczytu albo po nieudanym), z którego
   *          „Odrzuć” po klawiszu poznaje zamknięty dialog (`#clearHookAfterDecision`)
   */
  async #pauseBlocksEscape(): Promise<{ blocks: boolean; text: string | null }> {
    const suspected = this.#activeReq?.terminalDialog === SESSION_PAUSED_DIALOG
      || (this.#pauseSeq === this.#blockedSeq && this.#blockedNow());
    if (!suspected && !this.#blockedNow()) return { blocks: false, text: null };
    const text = await this.#readDialog(true);
    if (text === null) return { blocks: suspected, text: null };
    const fresh = parseOptions(text);
    return { blocks: fresh === null ? suspected : sessionPausedDialog(fresh), text };
  }

  /**
   * Ślad pauzy z KAŻDEGO odczytu ekranu dialogu (`#pauseSeq`): pauza zapisuje numer blokady, inny czytelny
   * dialog go zdejmuje, ekran bez dialogu (przemalowanie, odczyt w pół klatki) zostawia go bez zmian.
   */
  #notePause(text: string): void {
    const dialog = parseOptions(text);
    if (dialog === null) return;
    this.#pauseSeq = sessionPausedDialog(dialog) ? this.#blockedSeq : null;
  }

  /** Whether {@link #readDialog} without `force` returns the screen cache instead of reading. */
  #screenCached(): boolean {
    return this.#screenText !== null && this.#scheduler.now() - this.#screenAt < this.#screenCacheMs;
  }

  /** Unieważnia zrzut ekranu — następny `#readDialog` MUSI pójść po świeży. */
  #dropScreen(): void {
    this.#screenText = null;
    this.#screenAt = 0;
  }

  /**
   * Zegar ponownej oceny STOJĄCEGO dialogu.
   *
   * Sama ZMIANA statusu herdr nie wystarcza jako wyzwalacz oceny — dialog podmieniony
   * w miejscu jej nie wywołuje. Dopóki panel jest `blocked`, pytamy o ekran sami; wyjście
   * z blokady gasi zegar, bo wtedy nie ma czego oceniać.
   */
  #syncBlockedPoll(): void {
    // Blokada EFEKTYWNA: formularz trzymany przez rezerwę też stoi i też może się podmienić.
    const wanted = !this.#disposed && this.#inScope && this.#blockedNow();
    if (!wanted) {
      this.#noHook.blockEnded();
      if (this.#blockedTimer !== null) {
        this.#scheduler.clearTimeout(this.#blockedTimer);
        this.#blockedTimer = null;
      }
      return;
    }
    if (this.#blockedTimer !== null) return;
    this.#blockedTimer = this.#scheduler.setTimeout(() => {
      this.#blockedTimer = null;
      if (this.#disposed || !this.#blockedNow()) return;
      /*
       * Prosto do oceny, Z POMINIĘCIEM debounce'u. Debounce jest po to, żeby po ZMIANIE
       * (status z herdr, pending z jsonl) poczekać, aż oba źródła się dogadają — a zegar
       * żadnej zmiany nie zgłasza, tylko pyta „czy na ekranie stoi to samo, co na karcie".
       * Przez `#scheduleEvaluate` odstęp krótszy od debounce'u kasowałby własną ocenę
       * w kółko i nie doszłoby do niej NIGDY.
       */
      void this.#evaluate();
      this.#syncBlockedPoll();
    }, this.#blockedPollMs);
  }

  // -------------------------------------------------------------------------
  // Follower transkryptu
  // -------------------------------------------------------------------------

  #createFollower(agentSessionId: string): JsonlFollower {
    const opts: { cwd: string; agentSessionId: string; knownContextLimit?: number } = {
      cwd: this.#cwd, agentSessionId,
    };
    if (this.#deps.knownContextLimit !== undefined) {
      opts.knownContextLimit = this.#deps.knownContextLimit;
    }
    return openFollower(this.#deps.follow, this.#deps.promptBlock === false ? { ...opts, promptBlock: false } : opts);
  }

  async #pumpFollower(follower: JsonlFollower): Promise<void> {
    for await (const event of follower.events) {
      if (this.#disposed) return;
      this.#onFollowEvent(event);
    }
  }

  // -------------------------------------------------------------------------
  // Puls katalogu sesji (S-live)
  // -------------------------------------------------------------------------

  #createPulse(agentSessionId: string): SessionPulse {
    return openPulse(this.#deps.pulse, {
      cwd: this.#cwd,
      agentSessionId,
      onPulse: (sample) => { this.#onPulse(sample); },
    });
  }

  /**
   * Watcher żyje WYŁĄCZNIE w czasie tury.
   *
   * `working` i `blocked` to stany tury (`running` / `waiting-*` po stronie managera): w obu
   * czekamy na ruch po drugiej stronie. `idle`/`done` znaczy, że nie ma na co czekać — a 17
   * bezczynnych paneli z rekurencyjnym watcherem to koszt, którego nikt nie zamawiał.
   */
  #syncPulse(): void {
    const pulse = this.#pulse;
    if (pulse === null || this.#disposed) return;
    if (this.#status === 'working' || this.#status === 'blocked') pulse.start();
    else pulse.stop();
  }

  /**
   * Meldunek pulsu → wiersz aktywności; regułę i dedup liczy `herdr/transcript.ts`.
   *
   * Fazy dokładamy z CACHE'U rozkładu (`#tasks.runs`, odpytywanego co
   * `TASKS_POLL_MS`, dopóki follower widzi otwarte zadanie `Workflow`) — na ścieżce
   * pulsu nie ma ani jednego nowego odczytu dysku. Cache pusty (pierwsze sekundy przebiegu,
   * workflow bez wpisu w liście zadań) albo przebieg bez planu → `null`, czyli event bez pola:
   * klient liczy pasek z samych agentów, jak dotąd. Rozjazd id (puls widzi inny `wf_…` niż
   * lista zadań) kończy się tak samo — nigdy fazami cudzego przebiegu.
   *
   * Nazwa przebiegu: gdy puls jej nie zna (skrypt z `scriptPath` nie trafia do
   * `workflows/scripts/`), bierzemy ją z listy zadań po tym samym `runId` (`runName`). Bez tego
   * event szedł jako `Agent` bez nazwy i karta mówiła „subagent pracuje" o workflow, który
   * widok sesji pokazywał z nazwą i fazą.
   */
  #onPulse(sample: PulseSample): void {
    if (this.#disposed) return;
    const now = this.#scheduler.now();
    const run = sample.runId === undefined ? undefined : this.#tasks.runs.get(sample.runId)?.run;
    const known = sample.runId === undefined || sample.workflowName !== undefined
      ? undefined
      : runName(this.#tasks, sample.runId);
    const event = pulseActivity(
      this.#pulseEcho,
      known === undefined ? sample : { ...sample, workflowName: known },
      { now, silentFor: now - this.#lastFollowAt, openTools: this.#follower?.openToolUses?.() ?? null },
      run === undefined ? null : phaseCounts(run),
    );
    if (event !== null) this.#emit(event);
  }

  // -------------------------------------------------------------------------
  // Zadania w tle: rozkład workflow i pliki subagentów
  // -------------------------------------------------------------------------

  /**
   * Styk z `herdr/background/merge.ts` — składany przy każdym wywołaniu, bo sam nie trzyma stanu.
   *
   * Czytniki bierzemy przez `this`, a nie kopiujemy do pola: `session-changed` woła na nich
   * `repoint()`, a zamrożona referencja pokazywałaby pliki poprzedniej sesji silnika.
   */
  get #tasksDeps(): TasksDeps {
    return {
      reader: this.#runReader,
      agentReader: this.#agentReader,
      scheduler: this.#scheduler,
      pollMs: this.#tasksPollMs,
      disposed: () => this.#disposed,
      emit: (tasks) => {
        this.#emit({ type: 'background-tasks', tasks });
        // Zmiana listy zadań (start albo koniec agenta, rozkład workflow) bywa jedynym znakiem pracy, gdy plik
        // główny milczy: agent mógł właśnie utworzyć PR we własnym pliku.
        this.#schedulePullRequests();
      },
    };
  }

  /** Contact with `drivers/herdr/pull-request-poll.ts`, built at every call, like `#tasksDeps`. */
  get #pullRequestsDeps(): PullRequestPollDeps {
    return {
      scheduler: this.#scheduler,
      disposed: () => this.#disposed,
      emit: (pullRequests) => { this.#emit({ type: 'pull-requests', pullRequests }); },
    };
  }

  /** Contact with `drivers/herdr/scheduled-task-poll.ts`, built at every call. */
  get #cronsDeps(): crons.ScheduledTaskPollDeps {
    return {
      scheduler: this.#scheduler,
      disposed: () => this.#disposed,
      emit: (scheduledTasks) => { this.#emit({ type: 'scheduled-tasks', scheduledTasks }); },
    };
  }

  /** Orders a pull request read in `delayMs` (default: the delay after a signal); logic in `pull-request-poll.ts`. */
  #schedulePullRequests(delayMs?: number): void {
    schedulePullRequests(this.#pullRequests, this.#pullRequestsDeps, delayMs);
  }

  /**
   * Zdarzenie followera → zdarzenie managera.
   *
   * Warianty `history`, `message`, `activity` i `turn-input` mają kształt identyczny
   * z `DriverEvent` i lecą jeden do jednego. Reszta jest tłumaczona, bo manager nie zna pojęć
   * pliku jsonl (`pending`, `ContextLimitState`).
   */
  #onFollowEvent(event: FollowEvent): void {
    this.#promptQueue.followed(event.type, (note) => { this.#system(note); }); // Restore notes after the history.
    // Każde zdarzenie z pliku jest znakiem życia jsonl — od niego liczy się CISZA, którą dopiero
    // wypełnia puls. Także `usage`/`meta`/`pending`: one też znaczą „plik właśnie urósł".
    // Wpis echa odroczonego wypadł z okna — to nie jest znak życia pliku: przycięcie okna
    // zdarza się przy wysyłce, a nie przy odczycie. Manager spłukuje wiadomość od razu: token `unseen` kolejki schodzi.
    if (event.type === 'echo-dropped') {
      this.#promptQueue.unseen.delete(event.token);
      this.#emit(event);
      return;
    }
    /*
     * Artefakty sesji — przelot 1:1, bez drugiego filtra: follower wysyła tylko pierwszą wypłatę
     * i zmiany, a listy nikt poza nim nie uzupełnia (inaczej niż zadania, które driver łączy z rozkładem
     * workflow i plikami subagentów). To też nie jest znak życia pliku: pierwsza wypłata idzie także
     * BEZ pliku (pudło globu po uuid), a strażnik zawieszonej wysyłki i watchdog tury liczą ciszę od
     * prawdziwego przyrostu. Linia z publikacją daje i tak własne zdarzenia (czekające narzędzie).
     */
    if (event.type === 'artifacts') {
      this.#emit({ type: 'artifacts', artifacts: event.artifacts });
      // The follower has just opened the file or missed it: the scheduled task reader knows where to look now.
      crons.scheduleScheduledTasks(this.#crons, this.#cronsDeps, 0);
      return;
    }
    /*
     * Zadania w tle — do `merge.ts`, który dokłada rozkład workflow i pliki subagentów. Też nie są znakiem życia
     * pliku: pierwsza wypłata po podpięciu idzie także BEZ pliku (pudło globu), listę zmienia też start procesu
     * CLI z rejestru (`noteProcessStart`), a meldunek o końcu zadania przychodzi niezależnie od tury. Strażnik
     * zawieszonej wysyłki i watchdog tury liczą ciszę od pozostałych zdarzeń pliku (wiadomość, aktywność,
     * zużycie, czekające narzędzie, wejście tury).
     */
    if (event.type === 'tasks') {
      noteTasks(this.#tasks, this.#tasksDeps, event);
      this.#schedulePullRequests();
      return;
    }
    this.#lastFollowAt = this.#scheduler.now();
    // Plik główny urósł: PR mógł powstać w nim albo w pliku agenta, który właśnie oddał wynik.
    this.#schedulePullRequests();
    crons.scheduleScheduledTasks(this.#crons, this.#cronsDeps);
    resetPulseEcho(this.#pulseEcho);
    switch (event.type) {
      case 'history': {
        this.#returnedPrompt.noteHistory(event.messages);
        const { messages, output } = withoutCommandOutput(event.messages);
        // Wiadomość z kolejki wklejeń stoi w pliku bez Entera Raroga: wpis kolejki się kończy.
        for (const m of messages) if (m.echoToken !== undefined) this.#promptQueue.noteQueuedEcho(m.echoToken);
        this.#emit({ type: 'history', engineSessionId: this.#agentSessionId, messages });
        if (output !== undefined) this.#turnGuard.noteCommandOutput(output);
        return;
      }
      case 'message': {
        const { commandOutput, ...message } = event;
        // Wpis `user` z pliku (prompt przy Macu, wstrzymane echo, notka harnessu): pole nie trzyma już
        // zablokowanego promptu pewnie.
        if (event.role === 'user') this.#turnGuard.blockedLeftover = null;
        this.#returnedPrompt.noteFile([event]);
        if (event.role === 'user' && (this.#promptQueue.heldLeftover !== null || this.#promptQueue.submitted !== null)) {
          const sent = squashWhitespace(
            event.blocks.map((block) => (block.type === 'text' ? block.text.text : '')).join(''),
          );
          // Pozostałość wstrzymanego promptu albo wiadomości z kolejki wysłana: pole już jej nie trzyma.
          if (sent === this.#promptQueue.heldLeftover) this.#promptQueue.heldLeftover = null;
          // Wpis promptu z treścią ostatniego Entera z kolejki: CLI ją przyjął, następna wiadomość nie czeka.
          if (sent === this.#promptQueue.submitted?.text) this.#promptQueue.submitted = null;
        }
        // Wiadomość z kolejki wklejeń stoi w pliku bez Entera Raroga: wpis kolejki się kończy.
        if (event.echoToken !== undefined) this.#promptQueue.noteQueuedEcho(event.echoToken);
        this.#emit(message);
        // Najpierw notka z wynikiem, potem stan: na telefonie wynik stoi, zanim sesja wróci do „czeka”.
        if (commandOutput !== undefined) this.#turnGuard.noteCommandOutput(commandOutput);
        return;
      }
      case 'turn-input':
        // Wejście tury z pliku: ktoś wysłał prompt (także echo Raroga) — patrz wyżej.
        // A compaction boundary is no prompt: the blocked prompt stays in the field.
        if (event.kind !== 'compaction') this.#turnGuard.blockedLeftover = null;
        this.#emit(event);
        return;
      case 'activity':
        this.#emit(event);
        return;
      case 'prompt-blocked':
        this.#turnGuard.onPromptBlocked(event);
        return;
      case 'usage':
        this.#onUsage(event.context);
        return;
      case 'meta':
        this.#onMeta(event);
        return;
      case 'pending':
        this.#pending = event.pending;
        this.#scheduleEvaluate();
        return;
      case 'custom-title':
        /*
         * Nazwa z `/rename` z pliku rozmowy: etykieta karty i taba od razu, w tym samym odczycie pliku, bez
         * czekania na tytuł panelu w herdr. Pierwszeństwo przed tytułem herdr i etykietą z promptu ustala manager
         * (`source`), bo to on trzyma etykietę także po wymianie drivera.
         */
        this.#emit({ type: 'title', title: event.title, source: 'custom-title' });
        return;
      case 'relocated':
        /*
         * Plik zmienił adres (`EnterWorktree` — `rename(2)` do slugu worktree).
         *
         * Do managera nie idzie NIC: treść rozmowy jest ta sama, a follower czyta ją dalej od
         * tego samego offsetu. Zmiana dotyczy wyłącznie SATELITÓW — puls katalogu, czytnik
         * rozkładu workflow i czytnik plików subagentów trzymają własny cache katalogu obok
         * transkryptu i bez tego sygnału patrzyłyby w katalog, którego już nie ma (`readdir`
         * w `catch`, cisza do `/clear`).
         */
        this.#pulse?.relocated();
        this.#runReader?.relocated();
        this.#agentReader?.relocated();
        this.#pullRequests.prReader?.relocated();
        this.#schedulePullRequests(0);
        crons.relocateScheduledTasks(this.#crons, this.#cronsDeps);
        return;
      case 'error':
        // Nie jest przejściem stanu: panel żyje, tylko jego treści nie zobaczymy.
        this.#system(NO_TRANSCRIPT_MESSAGE);
        return;
    }
  }

  /**
   * Zużycie okna kontekstu.
   *
   * Przelot jeden do jednego, RAZEM ze stanem `unknown`: to manager i UI decydują, że bez
   * potwierdzonego limitu pokazuje się samą liczbę bez paska. Driver nie ma prawa ani zgadnąć
   * limitu, ani zamilczeć liczby — jedno kłamie paskiem, drugie kłamie brakiem.
   */
  #onUsage(context: ContextLimitState): void {
    this.#emit({ type: 'usage', context });
  }

  /** Model i effort z jsonl → `init`; regułę (i to, czego NIE przepuszcza) trzyma moduł. */
  #onMeta(meta: JsonlMeta): void {
    const event = metaInitEvent(meta, this.#agentSessionId);
    if (event === null) return;
    this.#emit(event);
    crons.scheduledTasksAfterInit(this.#crons, this.#cronsDeps);
  }

  // -------------------------------------------------------------------------
  // Karta decyzji: stan z herdr × czekające narzędzie z jsonl × cyfry z ekranu
  // -------------------------------------------------------------------------

  /**
   * Uzgodnienie po debouncie.
   *
   * Każda zmiana (status z herdr, pending z jsonl) restartuje zegar: interesuje nas stan PO
   * tym, jak oba źródła się dogadają, a nie każdy krok tego dogadywania z osobna.
   */
  #scheduleEvaluate(): void {
    if (this.#disposed) return;
    if (this.#evalTimer !== null) this.#scheduler.clearTimeout(this.#evalTimer);
    this.#evalTimer = this.#scheduler.setTimeout(() => {
      this.#evalTimer = null;
      void this.#evaluate();
    }, this.#debounceMs);
  }

  /** Serializacja ocen: druga zmiana w trakcie odczytu ekranu ma powtórzyć ocenę, nie ścigać się. */
  async #evaluate(): Promise<void> {
    if (this.#disposed || this.#evaluating) {
      this.#evaluateAgain = !this.#disposed;
      return;
    }
    this.#evaluating = true;
    try {
      do {
        this.#evaluateAgain = false;
        await this.#evaluateOnce();
      } while (this.#evaluateAgain && !this.#disposed);
    } finally {
      this.#evaluating = false;
    }
  }

  async #evaluateOnce(): Promise<void> {
    // Panel poza zasięgiem nie dostaje kart: `respondPermission` i tak by z niego rzuciło,
    // a karta z przyciskiem, który zawsze kończy się błędem, to UI, które kłamie.
    if (this.#disposed || !this.#inScope) return;
    if (this.#status !== 'blocked') {
      /*
       * Dialog, którego herdr nie widzi jako blokady: zgłoszony przez rejestr sesji CLI
       * albo formularz `AskUserQuestion` po `/rename`. Obecność dialogu
       * sprawdzamy TU, przed skrótem „ta sama karta" niżej — inaczej karta trzymana przez
       * rezerwę nie miałaby jak zgasnąć, gdy dialog zniknie z ekranu.
       */
      const verdict = await this.#cliReserve.unblockedVerdict();
      if (this.#disposed) return;
      // An evaluation the fallback ends here still writes the layer 2 episode (`docs/dialog-card.md`, "Episode line").
      this.#layer2Cards.noteFallback(verdict);
      if (verdict === 'wait') return;
      if (verdict === 'none') {
        // Karta dialogu zgody NIE należy do blokady herdr — gasi ją wyłącznie ekran.
        if (this.#consentDialog === null) this.#clearActive('agent nie czeka na decyzję');
        return;
      }
    }

    const pending = this.#pending;
    /*
     * „Dialog spoza jsonl" to WNIOSEK Z BRAKU, więc wymaga cierpliwości: herdr wykrywa `blocked`
     * z ekranu, a wpis `tool_use` ląduje w pliku około pół sekundy później. Bez tego okna
     * karencji zwykła zgoda na `Bash` pokazywałaby się najpierw jako karta bez przycisków,
     * a chwilę potem podmieniała na właściwą — czyli miganie dokładnie w sekundzie, w której
     * użytkownik podejmuje decyzję. Podwójny debounce jest tu tani: nic nie tracimy, czekając.
     */
    /*
     * …ale karencja ma sens WYŁĄCZNIE wtedy, gdy plik transkryptu w ogóle istnieje.
     *
     * Dialog zaufania katalogu stoi, ZANIM powstanie plik: agent jeszcze nie ruszył, więc
     * `tool_use`, na który czekamy, nie ma jak się pojawić — ani po 1,6 s, ani nigdy. Czekanie
     * było więc czystą zwłoką przed jedyną możliwą ścieżką (ekranową), a przy `follower === null`
     * (panel poza zasięgiem i tak nie dostaje kart) nie zmienia niczego.
     *
     * „Nie wiem" liczy się jak „możliwe": między podpięciem drivera
     * (albo `repoint()`) a końcem globu po uuid follower nie zna jeszcze ścieżki — a panel
     * podpięty już w `blocked` (restart Raroga nad stojącą zgodą) trafia dokładnie w to okno.
     * Traktowanie go jak „pliku nie ma" pomijało karencję i oceniało dialog na ekranie
     * czytanym w tej samej milisekundzie, w której TUI bywa w pół przemalowania. Czekanie
     * kosztuje jeden debounce; zła karta kosztuje decyzję użytkownika.
     */
    /*
     * ZRZUT HOOKA `PreToolUse` (warstwa 1) wchodzi tam, gdzie jsonl milczy: hook zrzuca czekające narzędzie ZANIM
     * dialog stanie, a wpis `tool_use` bywa spóźniony albo nie ma go wcale (przy zgodach na narzędzia zmierzone są
     * obie sytuacje). Dla formularza `AskUserQuestion` od CLI 2.1.267 oba źródła stoją naraz: wpis ląduje ~0,1 s
     * PRZED zrzutem, nad stojącym dialogiem. Zrzut jest źródłem TREŚCI karty (pełny `tool_input`), nigdy cyfr — te
     * dalej idą z ekranu, przez ten sam cross-check nazwy narzędzia co jsonl. Stęchły zrzut z cudzym narzędziem =
     * rozjazd = spadek na kartę ekranową warstwy 2, nigdy zła cyfra.
     */
    const hookFile = this.#deps.readPendingHook?.(this.#agentSessionId) ?? null;
    /*
     * Zrzut `Bash` starszy niż 10 minut (`stale`) wchodzi do oceny wyłącznie z dowodem
     * z ekranu (`admittedHook`), i to PRZED tożsamością oceny: zrzut bez dowodu nie trafia ani do karty, ani do
     * `reqId`, więc ocena i bramka „ta sama karta" niżej idą dokładnie tak jak bez zrzutu po 10 minutach
     * (karta z podwójnym dowodem przy ramce uciętej zmienia tożsamość i traci przyciski). Ekran czytamy tu tylko
     * przy takim zrzucie; ten sam odczyt (cache) dostaje zwykle `decideCard`, który dowód sprawdza jeszcze raz.
     */
    let hookRaw = hookFile;
    if (hookFile?.stale === true) {
      const proofText = await this.#readDialog(false);
      if (this.#disposed) return;
      hookRaw = admittedHook(
        hookFile, proofText, (dialogText, expected) => this.#resolveOptions(dialogText, expected),
      );
    }
    const hookPending = hookPendingFor(pending, hookRaw);
    const jsonlPossible = (this.#follower?.hasTranscript() ?? 'no') !== 'no';
    if (
      pending === null && hookPending === null && jsonlPossible
      && this.#scheduler.now() - this.#blockedAt < this.#debounceMs * 2
    ) {
      this.#scheduleEvaluate();
      return;
    }
    // Dialog spoza jsonl nie ma `tool_use.id` — bierzemy numer blokady (zrzut hooka niesie
    // własny stabilny id z chwili zapisu). To jest wyłącznie BAZA identyfikatora: każda karta
    // liczona z ekranu dokleja do niej odcisk TREŚCI dialogu (`screenFormReqId` dla kart
    // z opcjami, `screenFallbackReqId` dla karty bez nich) — i to on, nie numer blokady,
    // rozstrzyga ich świeżość.
    // Zrzut hooka IDZIE PRZED wpisem z jsonl: gdy oba opisują to samo wywołanie
    // `AskUserQuestion`, tożsamość karty liczy się z generacji zrzutu. Dzięki temu karta zbudowana
    // z samego wpisu (zrzut jeszcze nie doszedł) ma INNĄ bazę niż karta kanału hooka — bramka
    // „ta sama karta" niżej jej nie zamraża i karta przechodzi na kanał `hook`, gdy plik dojdzie.
    // Konkurujące źródła i `Bash` z podwójnym dowodem: tożsamość niesie oba źródła, żeby
    // zmiana któregokolwiek dała nową ocenę, a nie zatrzymała się na bramce „ta sama karta" niżej.
    const reqId = evaluationReqId(pending, hookPending, hookRaw, this.#blockedSeq);
    const active = this.#activeReq;
    /*
     * A screen card is not invalidated by the block number alone.
     *
     * A gate "a screen card in the SAME block is current by definition" would freeze the evaluation: a card once
     * shown would close the path for the whole block, so a second form question or a second consent in a row (both
     * without a status flicker) could not show. Freshness is decided by the screen CONTENT: the `reqId` of a screen
     * card is computed from it (`screenFormReqId`), so the same dialog gives the same id and the evaluation ends
     * without a single event, and ANOTHER dialog gives another id, that is a new card.
     *
     * The same holds for a card without options (`screenFallbackReqId`): with the block number alone as its id,
     * this gate would freeze the evaluation and no further question of the form would get a card after a
     * `multiSelect` tab. Only cards WITH BUTTONS from the jsonl and from the hook dump stop here, because the file
     * carries their identity. A card WITHOUT buttons from this path has the conclusion suffix (`degradedReqId`), so
     * the evaluation goes on and reads the screen; otherwise it would stand to the end of the block over a dialog
     * that became readable long ago (view scrolled up).
     *
     * Wyjątek: zrzut `Bash` starszy niż 10 minut, który ekran właśnie dowiódł
     * (`admittedHook` wyżej), opisuje komendę inną niż komenda stojącej karty (`staleDumpProvesOther`). Tak wygląda
     * decyzja przy biurku na dialogu przed nim w kolejce: blokada, wpis bez `tool_result` i zrzut stoją, więc
     * tożsamość oceny zostaje, choć dialog karty zniknął. Ocena idzie wtedy do `decideCard`, a ten wystawia kartę
     * dialogu zrzutu z tożsamością samego zrzutu. Ekran przy takim zrzucie jest już przeczytany, więc wyjątek
     * nie dokłada odczytu, a do tożsamości oceny ekranu nie dokładamy. Zrzut świeży tego wyjątku nie ma:
     * karta dialogu z wierzchu stoi wtedy do wyniku jego narzędzia (`docs/dialogs.md`, „Known gaps”).
     */
    if (active !== null && active.reqId === reqId && !staleDumpProvesOther(hookRaw, active)) return;

    /*
     * Wejście CZYSTEJ decyzji (`decideCard`) — wszystko, czego ona nie umie sobie wziąć.
     *
     * Budowane przy KAŻDYM wywołaniu, bo numery blokady czyta się świeżo: odczyt ekranu jest
     * awaitem, a `#blockedSeq` potrafi w jego trakcie urosnąć.
     */
    const decideInput = (screen: string | null, canRetry: boolean): DecideInput => ({
      pending,
      hookPending,
      text: screen,
      reqId,
      active,
      blockedSeq: this.#blockedSeq,
      answeredSeq: this.#answeredSeq,
      answeredHookCall: this.#answeredHookShield(),
      decided: this.#decidedShield(),
      hookAnswersEnabled: this.#deps.hookAnswers !== undefined,
      deadAnswerKey: this.#deadAnswerKey,
      canRetry,
      resolve: (dialogText, expected) => this.#resolveOptions(dialogText, expected),
      // Wycinek na kartę — ten sam parser, który wcześniej karmił transkrypt.
      excerpt: (dialogText) => this.#snippet(dialogText)?.text ?? null,
      // Zrzut z JEDNEGO odczytu na ocenę — ten sam, z którego powstał `hookPending`.
      hookRaw,
      layer2: this.#deps.dialogLayer2 === true,
      cwd: this.#cwd,
    });

    // Layer 2 counts a read only in the scope it began in, so the scope is taken before the read.
    let layer2Scope = this.#layer2Cards.scopeBeforeRead(false);
    let text = await this.#readDialog(false);
    if (this.#disposed) return;
    let action = decideCard(decideInput(text, true));
    /*
     * JEDEN ponowny odczyt — o to poprosiła decyzja (ekran nieczytelny albo pusty `no-jsonl`).
     * Ponowienie jest z `force`, czyli omija cache; poza nim nie zmieniamy tu żadnego stanu,
     * więc drugie pytanie idzie na tych samych danych plus świeży ekran.
     */
    if (action.kind === 'retry') {
      await this.#sleep(this.#retryMs);
      if (this.#disposed) return;
      if (!this.#blockedNow()) return;
      if ((this.#pending?.id ?? null) !== (pending?.id ?? null)) return;
      layer2Scope = this.#layer2Cards.scopeBeforeRead(true);
      text = await this.#readDialog(true);
      if (this.#disposed) return;
      action = decideCard(decideInput(text, false));
    }
    /*
     * No dialog preamble from the screen here: from CLI 2.1.267 the `text` block of the same turn stands in the
     * jsonl BEFORE the dialog, so a card would duplicate text the transcript already shows and cost one
     * `pane.read` per card.
     */
    /*
     * Blokada mogła zejść W TRAKCIE odczytu: rejestr powiedział
     * `busy`, rezerwa zeszła i zgasiła kartę, a spóźniony ekran z dialogiem postawiłby ją z powrotem
     * — przy panelu w turze, bez niczego, co by ją potem zdjęło, i z fałszywym pushem „czeka".
     * Ekran sprzed końca blokady nie ma prawa wystawić karty; przy herdr ocenę zamówiło już
     * samo zdarzenie statusu, przy rejestrze — `leaveCliHold`.
     */
    if (!this.#blockedNow()) return;
    // Layer 2 (`docs/dialog-card.md`): a card without buttons over a block with choices; a newer `pending` ends it.
    const decideLater = (screen: string | null, standing: ActiveReq | null, answeredSeq = this.#answeredSeq) => (
      (this.#pending?.id ?? null) === (pending?.id ?? null)
        ? decideCard({ ...decideInput(screen, false), active: standing, answeredSeq })
        : { kind: 'keep', touchSeq: false } as const);
    // Without a card also means without the window after an own key: the next block of a series gets its card.
    action = await this.#layer2Cards.settle(action, text, {
      now: (screen) => decideLater(screen, active), withoutCard: (screen) => decideLater(screen, null, -1),
    }, layer2Scope);
    if (this.#disposed || !this.#blockedNow()) return;
    this.#applyDecision(action, pending ?? hookPending);
  }

  /**
   * Wykonanie decyzji — jedyne miejsce ze SKUTKAMI ubocznymi oceny dialogu.
   *
   * Kolejność jest częścią kontraktu i była nią, zanim decyzja wyjechała do `herdr/dialogs/decide/decide.ts`:
   * audyt odmowy → zgaszenie starej karty → wystawienie nowej.
   *
   * Wycinka ekranu nie ma w tej kolejności: treść dialogu, którego nie ma
   * w jsonl, jedzie POLEM `screen` na samej karcie, a nie osobną wiadomością do transkryptu —
   * żyje więc dokładnie tak długo jak karta. Gaszenie jest LENIWE: karta
   * gaśnie dopiero, gdy wiadomo, co stanie w jej miejsce — gaszenie z góry + nieczytelny
   * ekran zamieniałyby stojącą od godzin kartę zgody w fallback „odpowiedz w terminalu",
   * a hold użytkownika lądowałby w pustce.
   */
  #applyDecision(action: DecideAction, source: PendingTool | null): void {
    if (action.kind === 'retry') return;
    if (action.kind === 'keep') {
      // `active.seq` przestawiamy wyłącznie po to, żeby karta wiedziała, w której blokadzie
      // ostatnio się potwierdziła — o świeżości rozstrzyga TREŚĆ ekranu.
      if (action.touchSeq && this.#activeReq !== null) this.#activeReq.seq = this.#blockedSeq;
      return;
    }
    if (action.kind === 'refresh') {
      this.#refreshScreenDialog(action);
      return;
    }
    // Karta bez decyzji postawiona przy OCENIE ekranu — degradacja, nie odmowa wysyłki.
    // Kształt przypadku i pochodzenie karty jadą z oceny.
    if (action.audit !== null) {
      auditRefusal(this.#refusals, action.audit, source?.toolName, 'degrade', undefined, {
        reqId: action.kind === 'card' ? action.card.active.reqId : action.reqId,
        origin: action.kind === 'card' ? action.card.active.origin : action.origin,
        // `decideCard` daje kształt przy każdym `audit`; zapas z cache'u ekranu, żeby wpis nie zniknął.
        diagnosis: action.diagnosis
          ?? { mismatchReason: null, ...dialogShapeOf(this.#screenText) },
      });
    }
    this.#clearActive('inna decyzja');
    if (action.kind === 'card') {
      this.#showCard(this.#withCliDialog(action.card));
      return;
    }
    this.#showScreenDialog(
      action.reqId, action.resolved, action.reason, action.screen, this.#cliReserve.cliWaiting, action.origin,
      action.layer2 ?? null,
    );
  }

  /**
   * Odświeżenie wycinka STOJĄCEJ karty bloku warstwy 2 (akcja `refresh`): ten sam `reqId`, inny blok pod kartą
   * (następna zakładka `/status`). Karta NIE gaśnie (bez `#clearActive`, więc bez `permission-cleared`), dziennik
   * nie dostaje wpisu, bo to nie jest nowa karta. Nowy odcisk ląduje w `ActiveReq.layer2`, a nowy wycinek jedzie do
   * managera zdarzeniem `dialog-screen`. Karta, która zdążyła się zmienić, nie dostaje cudzego wycinka.
   */
  #refreshScreenDialog(action: Extract<DecideAction, { kind: 'refresh' }>): void {
    const active = this.#activeReq;
    if (active === null || active.reqId !== action.reqId) return;
    active.seq = this.#blockedSeq;
    active.layer2 = action.layer2;
    this.#emit({ type: 'dialog-screen', screen: action.screen });
  }

  /**
   * Klasa dialogu z rejestru CLI na KARCIE ZDEGRADOWANEJ — jedzie na telefon polem
   * `SessionSummary.cliDialog`.
   *
   * Tylko karta bez decyzji (`input: null`) i tylko przy `waiting`: zwykła karta zgody ma pełną
   * treść z jsonl albo z ekranu, a klasa nie dołożyłaby do niej niczego.
   */
  #withCliDialog(card: DecisionCard): DecisionCard {
    const cliDialog = this.#cliReserve.cliWaiting;
    if (cliDialog === null || card.event.type !== 'permission-request' || card.event.input !== null) {
      return card;
    }
    return { ...card, event: { ...card.event, cliDialog } };
  }

  /**
   * Nowa karta: zapamiętujemy ją u siebie i meldujemy managerowi.
   *
   * Jedno miejsce na obie czynności, bo kartę BUDUJE `herdr/dialogs/cards/build.ts` (czysto, z ekranu
   * i zrzutu hooka), a WŁAŚCICIELEM stanu jest fasada — rozdzielenie tych dwóch kroków po
   * pięciu ścieżkach kończyłoby się kartą wysłaną bez zapamiętania (albo odwrotnie).
   */
  #showCard(card: DecisionCard): void {
    const event = consentOnlyEvent(card.event, card.active, this.#deps, this.#cliReserve.cliWaiting, {
      engineSessionId: this.#agentSessionId, cwd: this.#cwd,
    });
    this.#noHook.noteCard(card);
    if (event.type === 'permission-request' && event.canAllow === false) {
      // Jedna karta na dialog: przy żywej karcie kanału zgód karta zgody bez przycisku zgody nie idzie do managera.
      if (this.#consentChannel.consentCardStands()) {
        this.#activeReq = card.active;
        this.#undecided = null;
        return;
      }
      /*
       * Karta kanału jeszcze nie przyszła, ale rejestracja hooka tej sesji już jest: karta czeka bez `#activeReq`
       * (bramka „ta sama karta” nie zamraża oceny), a ocena na koniec czekania wystawia ją, jeśli karta kanału nie
       * przyszła.
       */
      if (this.#consentChannel.consentCardWait()) {
        this.#undecided = null;
        return;
      }
    }
    this.#activeReq = card.active;
    const undecided = (event.type === 'permission-request' && event.input === null)
      || (event.type === 'screen-dialog' && event.knownDialog === undefined);
    this.#undecided = undecided
      ? { active: card.active, cliDialog: 'cliDialog' in event ? event.cliDialog ?? null : null }
      : null;
    this.#noHook.cardShown(card, event);
    this.#emit(event);
    this.#auditBlockCard(card.active);
  }

  /**
   * Wpis „karta bloku wystawiona” (`block-card`) dla karty z samego ekranu: tożsamość, kształt ostatniego odczytu
   * ekranu (ten sam, z którego powstała karta), odcisk bloku i werdykt polityki. Bez treści ekranu i bez etykiet
   * opcji. Karta z wpisu jsonl albo ze zrzutu hooka wpisu nie dostaje. Wpis karty nie zmienia.
   */
  #auditBlockCard(active: ActiveReq): void {
    const record = blockCardRecord(active);
    if (record === null) return;
    const cliDialog = this.#cliReserve.cliWaiting;
    this.#audit({
      method: 'block-card',
      toolName: record.toolName,
      ...(cliDialog === null ? {} : { cliDialog }),
      ...originFields(record.reqId, active.origin),
      ...diagnosisFields({ mismatchReason: null, ...dialogShapeOf(this.#screenText) }),
      ...(record.print === undefined ? {} : { print: record.print }),
      verdict: record.verdict,
      // Karta warstwy 2 (`RAROG_DIALOG_LAYER2=1`): pola dopisane na końcu, przy fladze `0` wpis jest jak przed flagą.
      ...(record.layer2Why === undefined ? {} : { layer2: true, layer2Why: record.layer2Why }),
      ...(record.layer2 === true ? { layer2: true } : {}),
    });
  }

  /**
   * Klasa z rejestru CLI dla STOJĄCEJ karty bez decyzji — dosłana, gdy zmieniła się
   * po wystawieniu karty (patrz `#undecided`). Karta z decyzją, rozpoznany dialog i brak karty
   * nie dostają nic: klasa opisuje wyłącznie dialog, którego Rarog nie umie rozstrzygnąć.
   */
  #syncUndecidedClass(): void {
    const card = this.#undecided;
    if (card === null) return;
    if (card.active !== this.#activeReq) {
      this.#undecided = null;
      return;
    }
    if (card.cliDialog === this.#cliReserve.cliWaiting) return;
    card.cliDialog = this.#cliReserve.cliWaiting;
    this.#emit({ type: 'cli-dialog', ...(card.cliDialog === null ? {} : { cliDialog: card.cliDialog }) });
  }

  /**
   * Karta dialogu spoza jsonl — plus meldunek o dialogu ZAUFANIA.
   *
   * Dialog zaufania znaczy „za chwilę ten agent może zniknąć i wrócić": decyzja —
   * z telefonu albo przy biurku — re-eksekuuje `claude`. Meldujemy sam FAKT jego obecności,
   * bo karencja zniknięcia ma chronić także sesję zatwierdzoną w terminalu.
   */
  #showScreenDialog(
    reqId: string,
    resolved: {
      knownDialog: KnownDialogId | null; options: readonly ScreenOption[]; dialogIdentity?: DialogIdentityStamp | null;
    } | null,
    reason: HerdrRefuseReason | null = null,
    screen: string | null = null,
    cliDialog: CliDialogClass | null = null,
    origin: CardOrigin | null = null,
    layer2: Layer2Mark | null = null,
  ): void {
    const card = screenDialogCard(reqId, resolved, reason, screen, cliDialog, origin, layer2);
    // Sesja silnika z chwili karty: inna przed klawiszem ścieżki zaufania to odmowa („ten sam proces”).
    if (card.active.trustArrow !== undefined) card.active.trustArrow.engineSessionId = this.#agentSessionId;
    if (card.knownDialog === 'trust') this.#deps.markTrustDialog?.();
    this.#showCard(card);
  }

  /**
   * Czy w panelu stoi dialog ZGODY CLI — świeży odczyt ekranu przed KAŻDĄ wysyłką.
   *
   * Bez tej bramki tekst wpadałby w kolejkę CLI za dialogiem: herdr widzi `idle`, `agent.prompt`
   * z `wait` kończy się timeoutem, watchdog melduje „utknęła", a wiadomość wychodzi sama po
   * zgodzie przy biurku (zmierzone na dwóch sesjach). Błąd odczytu = `false`: wysyłka
   * i tak zaraz odbije się o to samo gniazdo, a stała odmowa przy chwilowej awarii zostawiłaby
   * telefon bez wysyłki na dobre.
   *
   * @param onScreen gets the text of a successful read (a control command keeps it as the screen before its send)
   */
  async #consentDialogStands(onScreen?: (text: string) => void): Promise<boolean> {
    let text: string;
    try {
      text = (await this.#deps.client.readScreen(this.#paneId, 'detection')).text;
    } catch {
      return false;
    }
    if (this.#disposed) return false;
    onScreen?.(text);
    const dialog = standingConsentDialog(text);
    await this.#noteConsentDialog(dialog, text);
    return dialog !== null;
  }

  /**
   * Zmiana obecności dialogu zgody CLI: karta „zgoda CLI" bez zatwierdzania albo jej
   * zgaszenie. Idempotentne — ten sam dialog dwa razy nie daje drugiej karty.
   *
   * @param screen ekran, z którego pochodzi rozpoznanie (wycinek na kartę); bez niego (zdarzenie
   *   nadzorcy niesie sam identyfikator) czytamy go tu, świeżo.
   */
  async #noteConsentDialog(
    dialog: ScreenConsentDialogId | null,
    screen: string | null = null,
  ): Promise<void> {
    if (this.#disposed || dialog === this.#consentDialog) return;
    this.#consentDialog = dialog;
    if (dialog === null) {
      this.#clearActive('dialog zgody CLI zniknął z ekranu');
      this.#emitState(this.#status);
      return;
    }
    let text: string | null;
    if (screen === null) {
      text = await this.#readDialog(true);
    } else {
      // Ekran z bramki wysyłki wchodzi do cache'u jak każdy odczyt dialogu — zrzut odmowy
      // (`refusalDump`) bierze go stamtąd.
      this.#screenText = screen;
      this.#screenAt = this.#scheduler.now();
      this.#notePause(screen);
      text = screen;
    }
    if (this.#disposed || this.#consentDialog !== dialog) return;
    this.#consentSeq += 1;
    const reqId = `consent:${dialog}:${String(this.#consentSeq)}`;
    const origin: CardOrigin = { source: 'screen' };
    // Karta bez zatwierdzania = odmowa w dzienniku: suma odmów ma ją policzyć
    // razem z resztą „odpowiedz w terminalu", a zrzut ekranu wyjaśnia, co stało.
    auditRefusal(this.#refusals, 'consent-dialog', `${SCREEN_DIALOG_TOOL}:${dialog}`, 'degrade', undefined, {
      reqId, origin, diagnosis: { mismatchReason: null, ...dialogShapeOf(text) },
    });
    this.#clearActive('dialog zgody CLI');
    this.#showScreenDialog(
      reqId,
      null,
      'consent-dialog',
      text === null ? null : this.#snippet(text)?.text ?? null,
      null,
      origin,
    );
    this.#emitState(this.#status);
  }

  // -------------------------------------------------------------------------
  // Fallbacks: the form herdr does not block and the CLI registry, `form-reserve.ts`, `cli-reserve.ts`
  // -------------------------------------------------------------------------

  /**
   * Blokada EFEKTYWNA: surowe `blocked` z herdr, formularz trzymany przez rezerwę albo
   * dialog trzymany przez rezerwę z rejestru CLI — ta ostatnia przy KAŻDYM statusie
   * herdr, bo nad formularzem z podglądem i „Exit plan mode?” herdr 0.9.3 melduje `working`.
   */
  #blockedNow(): boolean {
    return this.#status === 'blocked'
      || (this.#formReserve.formFallback !== null && (this.#status === 'idle' || this.#status === 'done'))
      || this.#cliReserve.cliHold;
  }

  /**
   * Okno tuż po WŁASNEJ odpowiedzi, w którym ekran bez formularza nie gasi rezerwy.
   *
   * Po cyfrze CLI przełącza zakładkę albo pokazuje przegląd, po pliku zamyka formularz —
   * w obu przypadkach odczyt trafia w przemalowanie. Koniec ogłosi `working` albo `tool_result`.
   * Termin jest ten sam co osłony kanału hooka: po nim pudła znów się liczą, więc formularz
   * zamknięty przy biurku (Esc, bez `working`) nie zostawia wiszącej karty.
   */
  #answerShieldUp(): boolean {
    if (this.#answeredHookShield() !== null) return true;
    return this.#answeredSeq === this.#blockedSeq
      && this.#scheduler.now() - this.#answeredAt < ANSWERED_HOOK_SHIELD_MS;
  }

  /** Karta przestała być aktualna — manager gasi ją u siebie (`#expirePending`). */
  #clearActive(reason: string): void {
    const active = this.#activeReq;
    if (active === null) return;
    this.#activeReq = null;
    this.#emit({ type: 'permission-cleared', reqId: active.reqId, reason });
  }

  // -------------------------------------------------------------------------
  // Wysyłka i mapowanie błędów
  // -------------------------------------------------------------------------

  /**
   * Jedno wywołanie mutujące + dziennik + tłumaczenie błędów na strumień.
   *
   * @returns `true`, gdy wywołanie się powiodło.
   */
  async #send(
    call: () => Promise<void>,
    entry: AuditDetails,
    op: SendOp = 'message',
    echo?: string,
  ): Promise<boolean> {
    if (this.#disposed) return false;
    try {
      await call();
      this.#audit(entry);
      return true;
    } catch (err) {
      // Dziennik dostaje PRÓBĘ, nie sukces: pytanie „co poszło do paneli z ukradzionego telefonu"
      // dotyczy też wysyłek, które herdr odrzucił.
      this.#audit(entry);
      // Echo odroczone oddajemy PRZED ostrzeżeniem — patrz `#refuseEcho`.
      this.#refuseEcho(echo);
      this.#reportSendError(err, op);
      return false;
    }
  }

  #reportSendError(err: unknown, op: SendOp = 'message'): void {
    switch (herdrCode(err)) {
      case 'herdr-blocked':
        // Wiadomość użytkownika jest już dopisana lokalnie — ostrzeżenie stoi bezpośrednio pod
        // nią i tak ma być. ZERO ponownych prób: herdr zachował się bezpiecznie.
        //
        // `#status` zostaje NIETKNIĘTY celowo: zaraz przyjdzie prawdziwe `status: blocked`
        // z uchwytu i ma je zobaczyć jako WEJŚCIE w blokadę, czyli odczytać ekran dialogu.
        this.#system(op === 'interrupt' ? BLOCKED_INTERRUPT_MESSAGE : BLOCKED_SEND_MESSAGE);
        this.#emitState('blocked');
        return;
      case 'herdr-stalled':
        // Fałszywy alarm slash-komendy: komenda się wykonała. Pokazanie błędu zachęcałoby
        // do wysłania jej drugi raz.
        //
        // Przy Esc tylko wtedy, gdy stall przyszedł PRAWDZIWYM kodem `agent_prompt_stalled`.
        // Rozpoznany po treści komunikatu jest nieznaną awarią wywołania BEZ `wait` i jako
        // taki leci do wspólnej gałęzi niżej (`stalledByRemoteCode`).
        if (op !== 'interrupt' || stalledByRemoteCode(err)) return;
        break;
      case 'herdr-gone':
        // Przerwanie mówi tu głośno, wysyłka nie: przy wysyłce wiadomość użytkownika stoi
        // w transkrypcie i sama pokazuje, czego zabrakło — po Esc nie zostaje nic.
        if (op === 'interrupt') this.#system(GONE_INTERRUPT_MESSAGE);
        this.#emit({ type: 'detached', reason: 'panel zniknął z herdr' });
        return;
      case 'herdr-read-only':
        this.#system(op === 'interrupt' ? READ_ONLY_INTERRUPT_MESSAGE : READ_ONLY_MESSAGE);
        return;
      default:
        break;
    }
    /*
     * Nieznana awaria jest jedyną, która nie nazywa DROGI WYJŚCIA sama z siebie (odmowa
     * herdr i tryb read-only mówią, co stoi na przeszkodzie). Telefon dopisuje
     * swoje „otwórz go w herdr" TYLKO przy odmowie panelu, a nie przy odmowie bramki Raroga —
     * więc rada musi jechać stąd, inaczej człowiek zostaje z samym tekstem wyjątku.
     */
    const reason = reasonOfError(err);
    if (op === 'interrupt') {
      // Słowo maszyny (Mac albo VPS) z systemu serwera. Zdanie własne bez argumentów jedzie podkodem na końcu
      // ramy (jego kropka kończy całe zdanie); tekst stoi w środku, więc kropkę z komunikatu wyjątku ucinamy:
      // część bibliotek kończy nią zdanie, a „padło.. Otwórz panel" wygląda jak literówka Raroga.
      const linux = (this.#deps.system ?? serverSystem()) === 'linux';
      if ('code' in reason) {
        this.#system(linux ? say('commands.interrupt-failed.vps.code', { reason: reason.code })
          : say('commands.interrupt-failed.mac.code', { reason: reason.code }));
        return;
      }
      const text = reason.text.replace(/[.\s]+$/, '');
      this.#system(linux ? say('commands.interrupt-failed.vps', { reason: text })
        : say('commands.interrupt-failed.mac', { reason: text }));
      return;
    }
    this.#system('code' in reason ? say('commands.panel-send-failed.code', { reason: reason.code })
      : say('commands.panel-send-failed', { reason: reason.text }));
  }

  /**
   * @param at czas zdarzenia (epoch ms); domyślnie teraz. Wpis `degrade` czeka na wiersze panelu
   *        z herdr, więc podaje czas oceny, a nie chwilę zapisu.
   */
  #audit(entry: AuditDetails, at: number = this.#deps.now()): void {
    const record: HerdrAuditEntry = {
      at: new Date(at).toISOString(),
      key: this.#key,
      paneId: this.#paneId,
      cwd: this.#cwd,
      method: entry.method,
      mode: this.#mode,
    };
    if (this.#deps.sessionId !== undefined) record.sessionId = this.#deps.sessionId;
    if (entry.keys !== undefined) record.keys = entry.keys;
    if (entry.text !== undefined) record.text = entry.text;
    if (entry.toolName !== undefined) record.toolName = entry.toolName;
    if (entry.optionLabel !== undefined) record.optionLabel = entry.optionLabel;
    if (entry.reason !== undefined) record.reason = entry.reason;
    if (entry.shape !== undefined) record.shape = entry.shape;
    if (entry.cliDialog !== undefined) record.cliDialog = entry.cliDialog;
    if (entry.notes !== undefined) record.notes = entry.notes;
    if (entry.command !== undefined) record.command = entry.command;
    if (entry.sender !== undefined) record.sender = entry.sender;
    // Kształt przypadku — walidację kształtu robi dziennik (`auditShapeFields`).
    if (entry.reqId !== undefined) record.reqId = entry.reqId;
    if (entry.source !== undefined) record.source = entry.source;
    if (entry.toolUseId !== undefined) record.toolUseId = entry.toolUseId;
    if (entry.promptId !== undefined) record.promptId = entry.promptId;
    if (entry.agentId !== undefined) record.agentId = entry.agentId;
    if (entry.mismatchReason !== undefined) record.mismatchReason = entry.mismatchReason;
    if (entry.headerVisible !== undefined) record.headerVisible = entry.headerVisible;
    if (entry.optionCount !== undefined) record.optionCount = entry.optionCount;
    if (entry.dialogTitle !== undefined) record.dialogTitle = entry.dialogTitle;
    if (entry.paneRows !== undefined) record.paneRows = entry.paneRows;
    if (entry.budgetSource !== undefined) record.budgetSource = entry.budgetSource;
    if (entry.hookPaneRows !== undefined) record.hookPaneRows = entry.hookPaneRows;
    if (entry.hookPaneCols !== undefined) record.hookPaneCols = entry.hookPaneCols;
    if (entry.blockVisible !== undefined) record.blockVisible = entry.blockVisible;
    if (entry.route !== undefined) record.route = entry.route;
    if (entry.routeReason !== undefined) record.routeReason = entry.routeReason;
    if (entry.shadow !== undefined) record.shadow = entry.shadow;
    if (entry.shadowKey !== undefined) record.shadowKey = entry.shadowKey;
    if (entry.shadowDetail !== undefined) record.shadowDetail = entry.shadowDetail;
    if (entry.print !== undefined) record.print = entry.print;
    if (entry.verdict !== undefined) record.verdict = entry.verdict;
    if (entry.layer2 !== undefined) record.layer2 = entry.layer2;
    if (entry.layer2Why !== undefined) record.layer2Why = entry.layer2Why;
    if (entry.episode !== undefined) record.episode = entry.episode;
    if (entry.layer2Verdict !== undefined) record.layer2Verdict = entry.layer2Verdict;
    if (entry.blockTitleSha !== undefined) record.blockTitleSha = entry.blockTitleSha;
    if (entry.layer2Key !== undefined) record.layer2Key = entry.layer2Key;
    if (entry.layer2Outcome !== undefined) record.layer2Outcome = entry.layer2Outcome;
    try {
      this.#deps.audit.log(record);
    } catch {
      // Dziennik jest do śledztwa, nie do autoryzacji — jego awaria nie blokuje wysyłki.
    }
  }

  // -------------------------------------------------------------------------
  // Wewnętrzne
  // -------------------------------------------------------------------------

  #assertInScope(): void {
    if (!this.#inScope) throw new HerdrOutOfScopeError(say('session.out-of-scope'));
  }

  /**
   * Krok do wspólnej kolejki wysyłek — zwraca wynik SWOJEGO kroku, nie stanu kolejki.
   *
   * Rozróżnienie jest istotne dla przerwania, które jako jedyne czeka na swój wynik:
   * `await this.#chain` po dołożeniu kroku oddałoby wynik wszystkiego, co dołożono
   * w międzyczasie — czyli Esc meldowałby się dopiero po cudzym promptcie.
   *
   * Wyjątek kroku dalej jest połykany (kolejka nie ma prawa zerwać się przez jedną nieudaną
   * wysyłkę) i wychodzi z niego `undefined` — „nie wiadomo, czy poszło". Pozostali wołający
   * wyniku nie czytają.
   */
  #enqueue<T>(step: () => Promise<T>): Promise<T | undefined> {
    const settled = this.#chain.then(step);
    this.#chain = settled.then(() => undefined, () => undefined);
    return settled.catch(() => undefined);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#scheduler.setTimeout(() => { resolve(); }, ms);
    });
  }

  /**
   * Zmiana stanu dla managera.
   *
   * Tryb uprawnień jedzie w KAŻDYM takim zdarzeniu (a nie tylko po `HerdrPaneEvent.mode`):
   * manager przypisuje go bezwarunkowo, a chip „bypass"/„auto" na karcie ma nie zależeć od tego,
   * czy akurat trafiliśmy w moment zmiany trybu.
   */
  #emitState(status: HerdrAgentStatus): void {
    // Dialog zgody CLI i formularz trzymany przez rezerwę: dla herdr panel jest
    // `idle`, dla człowieka CZEKA NA DECYZJĘ — i tak ma wyglądać na telefonie. Prawdziwą
    // blokadę ani turę tym nie nadpisujemy. Rezerwa z rejestru CLI nadpisuje też
    // `working`: to jest właśnie spóźniony (albo ślepy) `working` herdr nad stojącym dialogiem,
    // a manager gasi kartę przy każdym stanie innym niż `blocked`.
    const standing = this.#consentDialog !== null || this.#formReserve.formFallback !== null;
    const idleLike = status === 'idle' || status === 'done';
    const effective = (standing && idleLike) || (this.#cliReserve.cliHold && (idleLike || status === 'working'))
      ? 'blocked'
      : status;
    const mapped = driverStateFor(effective);
    if (mapped === null) return;
    const event: Extract<DriverEvent, { type: 'agent-state' }> = {
      type: 'agent-state',
      state: mapped.state,
      mode: this.#mode,
      // Numer stanu jedzie z KAŻDYM zdarzeniem: manager zapisuje przy nim znacznik
      // „widziane z telefonu" i przebija go dopiero wyższym numerem.
      stateChangeSeq: this.#stateChangeSeq,
    };
    if (mapped.seen !== undefined) event.seen = mapped.seen;
    if (mapped.detail !== undefined) event.detail = mapped.detail;
    this.#emit(event);
  }

  /** Notka `system` w transkrypcie; tekst Raroga, więc zdanie z rejestru (`say`). */
  #system(text: OwnText): void {
    const blocks: InternalBlock[] = [{ type: 'text', text }];
    this.#emit({ type: 'message', role: 'system', blocks });
  }

  #emit(event: DriverEvent): void {
    if (this.#disposed) return;
    this.#queue.push(event);
  }
}

/**
 * Fabryka drivera dla jednego panelu.
 *
 * Wywołuje ją supervisor w `attach(key)` — to on ma uchwyt, klienta i wie, którą sesję Raroga
 * driver obsługuje.
 */
export function createHerdrDriver(
  handle: HerdrAgentHandle, deps: HerdrDriverDeps,
): SessionDriver {
  return new HerdrDriver(handle, deps);
}
