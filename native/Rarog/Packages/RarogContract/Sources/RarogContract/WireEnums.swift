// Wyliczenia z drutu — wartości DOKŁADNIE jak w `shared/src/protocol.ts`. Wartownik
// `unsupported` (wartość zapasowa z `DEGRADATIONS`) istnieje tylko tam, gdzie tabela go wstawia.

/// `SessionState` + wartownik „ta wersja klienta tego stanu nie zna" (karta bez akcji).
public enum SessionState: String, ContractEnum {
  case starting
  case running
  case waitingInput = "waiting-input"
  case waitingPermission = "waiting-permission"
  case waitingQuestion = "waiting-question"
  case limitReached = "limit-reached"
  case error
  case interrupted
  case done
  case resumable
  case unsupported

  public static var clientSentinel: SessionState? { .unsupported }
}

/// `EFFORT_LEVELS` + wartownik.
public enum EffortLevel: String, ContractEnum {
  case low, medium, high, xhigh, max
  case unsupported

  public static var clientSentinel: EffortLevel? { .unsupported }
}

/// Tryb uprawnień panelu. `unknown` to wartość PROTOKOŁU („trybu nie odczytano"), nie wartownik.
public enum HerdrMode: String, ContractEnum {
  case manual, plan, auto, bypass, unknown
}

/// `KNOWN_DIALOG_IDS` — dialogi spoza jsonl, dla których serwer wystawia przyciski.
public enum KnownDialogID: String, ContractEnum {
  case trust, model
}

/// `CLI_DIALOG_CLASSES` — jaki dialog stoi w terminalu według rejestru sesji Claude Code.
/// Fakt semantyczny z serwera; dosłownych nazw klas z pliku rejestru CLI apka nie zna i nie ma znać.
public enum CliDialogClass: String, ContractEnum {
  case permission, input, sandbox, worker, dialog, goal, other
}

/// `PULL_REQUEST_STATES` — PR state on GitHub (`SessionPullRequest.state`); `draft` is an open PR marked as a draft.
/// An unknown state drops the field (`DegradationKey.pullRequestsState`), so the app shows the row without a state.
public enum PullRequestState: String, ContractEnum {
  case open, draft, merged, closed
}

/// `SeenBy` — who picked up a result when it was not a human (`SessionSummary.seenBy`, `SeenBody.by`). An unknown
/// picker drops the field (`DegradationKey.seenBy`), so the received result reads as a human's.
public enum SeenBy: String, ContractEnum {
  case voiceAgent = "voice-agent"
}

/// `REFUSE_REASONS` — powód, dla którego karta nie ma przycisków (informacyjnie).
public enum RefuseReason: String, ContractEnum {
  case mismatch
  case unreadable
  case noJsonl = "no-jsonl"
  case multiSelect = "multi-select"
  case noDigit = "no-digit"
  case terminalOnly = "terminal-only"
  case screenChanged = "screen-changed"
  case staleCard = "stale-card"
  case formSubmit = "form-submit"
  case sendFailed = "send-failed"
  case inFlight = "in-flight"
  case consentDialog = "consent-dialog"
}

/// Silnik panelu. Brak pola = Claude; nieznany silnik NIGDY nie jest czytany jak Claude.
public enum Engine: String, ContractEnum {
  case codex
  case unsupported

  public static var clientSentinel: Engine? { .unsupported }
}

/// Źródło znanego limitu okna kontekstu.
public enum ContextSource: String, ContractEnum {
  case compactBoundary = "compact-boundary"
  case model
  case statusline
  case unsupported

  public static var clientSentinel: ContextSource? { .unsupported }
}

/// Rodzaj aktywności agenta. W ulotnej ramce `activity` ŚCISŁY (nieznany = ramka wypada).
public enum ActivityKind: String, ContractEnum {
  case thinking, tool, waiting, idle
}

/// Delegacja pracy (pole semantyczne kontraktu): subagenci albo workflow.
public enum Delegation: String, ContractEnum {
  case agents, workflow
}

/// Na co czeka sesja stojąca na decyzji.
public enum WaitingKind: String, ContractEnum {
  case permission, question
}

/// Przedmiot zgody (pole semantyczne kontraktu): zwykłe narzędzie albo plan.
public enum DecisionSubject: String, ContractEnum {
  case tool, plan
}

/// Rodzaj zadania w tle + wartownik.
public enum BackgroundTaskKind: String, ContractEnum {
  case command, agent, workflow, monitor
  case unsupported

  public static var clientSentinel: BackgroundTaskKind? { .unsupported }
}

/// `OWN_COMMAND_WAITS` — how long a subagent in standby has waited on its own command (`BackgroundTask.ownCommandWait`),
/// computed by the server. An unknown stage drops the field (`DegradationKey.backgroundTasksOwnCommandWait`), so the
/// task reads as one without a known wait.
public enum OwnCommandWait: String, ContractEnum {
  case short, long, stuck
}

/// Rola wiadomości transkryptu. Nieznana rola → `system` (nie udaje ani człowieka, ani agenta).
public enum MessageRole: String, ContractEnum {
  case user, assistant, system
}

/// Rodzaj szczegółu bloku narzędzia (dziś tylko diff).
public enum DetailKind: String, ContractEnum {
  case diff
}

/// Rodzaj wejścia narzędzia (pole semantyczne kontraktu): powłoka albo JSON.
public enum InputKind: String, ContractEnum {
  case shell, json
}

/// Rodzaj załącznika wiadomości.
public enum AttachmentKind: String, ContractEnum {
  case image, file
}

/// Rodzaj zmiany pliku w szczegółach gita (`GitFileDetail.kind`) — szufladki trójki `GitFileKinds`.
/// Nieznany → `modified` (wciąż zmiana pliku, nie dodanie ani usunięcie).
public enum GitFileChangeKind: String, ContractEnum {
  case added, modified, deleted
}

/// Ryzyko zgody. Nieznane → `red` (ostrożniej, nigdy łagodniej).
public enum Risk: String, ContractEnum {
  case normal, red
}

/// Rola opcji pytania (pole semantyczne kontraktu).
public enum OptionRole: String, ContractEnum {
  case answer, custom, exit
}

/// Kanał odpowiedzi na pytanie. Klient go DEKODUJE (kontrakt), ale nie decyduje po nim —
/// decyzje idą po `customAnswer` i `role` (pilnuje strażnik źródeł).
public enum QuestionChannel: String, ContractEnum {
  case hook, keys
}

/// `PERMISSION_CHANNELS` — kanał karty zgody; `hook` = karta kanału zgód, odpowiedź plikiem dla hooka.
public enum PermissionChannel: String, ContractEnum {
  case hook
}

/// `CONSENT_CARD_STATES` + wartownik (karta kanału bez przycisków: apka nie wie, w jakim stanie jest odpowiedź).
public enum ConsentCardState: String, ContractEnum {
  case pending, sent, claimed, running, applied
  case settledAtDesk = "settled-at-desk"
  case unknown, revoked, released
  case unsupported

  public static var clientSentinel: ConsentCardState? { .unsupported }
}

/// `CONSENT_UNAVAILABLE_REASONS` + `SCREEN_UNAVAILABLE_REASONS` + sentinel: why a permission card cannot be allowed
/// from the phone. The screen values (`settingsChanged`, `otherHook`, `unverifiedHooks`) come only on a card
/// without `channel`.
public enum ConsentUnavailableReason: String, ContractEnum {
  case noChannel = "no-channel"
  case truncated
  case noContent = "no-content"
  case cardMismatch = "card-mismatch"
  case keyBlocked = "key-blocked"
  case hookDead = "hook-dead"
  case noProof = "no-proof"
  case serverRestart = "server-restart"
  case terminalOnly = "terminal-only"
  case hiddenChars = "hidden-chars"
  case settingsChanged = "settings-changed"
  case otherHook = "other-hook"
  case unverifiedHooks = "unverified-hooks"
  case unsupported

  public static var clientSentinel: ConsentUnavailableReason? { .unsupported }
}

/// `CONSENT_ALWAYS_KINDS`: what an entry of the "always" option changes. Strict, like `zod` on the server: an
/// unknown kind rejects the frame, so a card never offers "always" with an update the app cannot describe.
public enum ConsentAlwaysKind: String, ContractEnum {
  case rule, mode, directory
}

/// `CONSENT_ALWAYS_DESTINATIONS`: where Claude Code writes the update. Strict, like ``ConsentAlwaysKind``.
public enum ConsentAlwaysDestination: String, ContractEnum {
  case session, localSettings
}

/// `CONSENT_NOTES` + wartownik — uwaga prezentacji, którą karta wyróżnia zdaniem.
public enum ConsentNote: String, ContractEnum {
  case sandboxDisabled = "sandbox-disabled"
  case unsupported

  public static var clientSentinel: ConsentNote? { .unsupported }
}

/// Rozstrzygnięcie zgody w ramce `permission-resolved` + wartownik (karta znika jak `expired`).
public enum PermissionResolution: String, ContractEnum {
  case allow
  case allowAlways = "allow-always"
  case deny
  case expired
  case unsupported

  public static var clientSentinel: PermissionResolution? { .unsupported }
}
