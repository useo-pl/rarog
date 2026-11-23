import Foundation
import RarogContract

// Sterowanie żywą sesją z nagłówka: model i effort, tryb, restart na
// nowszym Claude Code i diff sesji (per plik) — stan, zdarzenia reduktora,
// wyniki akcji magazynu i selektory. Copy składa RarogUI. Właściciel: nagłówek.

/// Stan sterowania sesją. Logowanie go nie kasuje: lista modeli nie zależy od konta, a wpisy
/// w locie gasną same (termin trybu, koniec żądania restartu).
public struct SessionControlsState: Sendable, Equatable {
  /// Lista modeli z serwera (`GET /api/models`); `nil` = jeszcze nie przyszła.
  public internal(set) var models: [ModelChoice]?
  /// Przełączenia trybu w locie, po sesji.
  public internal(set) var modeToggles: [String: ModeToggle] = [:]
  /// Model changes in flight, per session: from the accepted Apply until the list shows the whole target
  /// (`settleModelChanges`) or the deadline passes.
  public internal(set) var modelChanges: [String: ModelChange] = [:]
  /// Restarty, których żądanie jeszcze nie wróciło — drugi tap nic nie wysyła.
  public internal(set) var restarting: Set<String> = []
  /// Restarts from the tap until the list shows how they ended (`settleRestarts`): the newer-CLI pill stays hidden
  /// meanwhile and only a spinner stands. A refused request, a failure sentence on the card or the limit ends one.
  public internal(set) var pendingRestarts: [String: PendingRestart] = [:]

  public init() {}
}

/// Przełączenie trybu w locie: cel i termin, do którego pigułka czeka na stopkę panelu.
///
/// 202 wraca od razu, a nowy tryb przynosi lista po odczycie ekranu — bez tej pamięci drugi tap
/// w tym oknie ustawiłby w kolejce panelu powrót. Blokada trwa do CELU, nie do pierwszej zmiany:
/// pętla serwera przechodzi przez tryby pośrednie.
public struct ModeToggle: Sendable, Equatable {
  public let target: ModeCycleTarget
  public let until: Date
}

/// A model change in flight: the sent body and the deadline until which the model pill shows the target set.
///
/// 202 comes back at once, and the server sends `/model`, `/effort` and ultracode one after another. The entry is a
/// latch, not a live comparison: it ends on the first list frame that shows every sent value. A live comparison would
/// bring the spinner back after the first turn, when the session reports the engine's model id (`claude-opus-5-5`)
/// instead of the sent alias (`opus[1m]`).
public struct ModelChange: Sendable, Equatable {
  /// Exactly the sent body: `nil` fields were not part of the change.
  public let target: SessionModelBody
  public let until: Date

  /// The session shows every sent value. Exact comparison: the server sets the field from the command it sent, and
  /// `ultracode: false` needs `false` on the card (a card without proof, `nil`, does not confirm it).
  func confirmed(by session: SessionSummary) -> Bool {
    if let model = target.model, session.model != model { return false }
    if let effort = target.effort, session.effort != effort { return false }
    if let ultracode = target.ultracode, session.ultracode != ultracode { return false }
    return true
  }
}

/// One restart in progress as the list shows it. The server runs it in phases: the old process exits (the card stays
/// live with the `restart.exiting` sentence), the card waits without a process (`resumable`), the new process starts
/// (`starting`) and the card is live again. Only then does the server read the new process's version, so the first
/// live frames can still carry the old `cliUpdate`.
public struct PendingRestart: Sendable, Equatable {
  /// Past this moment the pill offers the update again, whatever the list shows.
  public let until: Date
  /// The card's sentence code at the tap: a failure sentence of an earlier restart can still stand on it.
  public let codeAtStart: String?
  /// The card's pane at the tap: a new pane is proof of the relaunch even when the app missed the phases between
  /// (in the background, the list comes back as one snapshot).
  public let paneAtStart: String?
  /// The list showed this restart's own sentence (exiting or launching) or the relaunch.
  public internal(set) var progressed = false
  /// The list showed the card without its process or starting the new one.
  public internal(set) var relaunching = false
  /// The first live frame after the relaunch that still carried `cliUpdate`; the restart ends a grace later.
  public internal(set) var settledAt: Date?
}

/// Zdarzenie sterowania sesją — jedna pozycja `CoreEvent.session`, gałęzie w `Reducer+Session`.
public enum SessionControlEvent: Sendable, Equatable {
  case modelsLoaded([ModelChoice])
  case modeToggleStarted(sessionId: String, target: ModeCycleTarget, until: Date)
  /// Odmowa (serwer, bramka, sieć) — pigułka wraca do stanu tapowalnego. Gaśnie wyłącznie wpis
  /// tej próby (`until` z jej startu): spóźniona odmowa starszej nie zdejmuje blokady nowszej.
  case modeToggleSettled(sessionId: String, until: Date)
  /// Termin minął — gaśnie wyłącznie wpis z tym terminem (nowszy tap zostaje).
  case modeToggleExpired(sessionId: String, until: Date)
  /// The model request goes out: the pill shows the target set until the list brings it or `until` passes.
  case modelChangeStarted(sessionId: String, target: SessionModelBody, until: Date)
  /// A refusal (server, gate, network) removes only the entry of this attempt (`until` from its start).
  case modelChangeSettled(sessionId: String, until: Date)
  /// The deadline passed: only the entry with this deadline goes.
  case modelChangeExpired(sessionId: String, until: Date)
  /// The confirmed tap: the request goes out and the restart counts as in progress until `until`.
  case restartStarted(sessionId: String, until: Date)
  case restartFinished(sessionId: String)
  /// The server refused the restart or the request failed: the pill offers the update again at once. `uncertain`: the
  /// reply was lost (network, limit) — the restart stays in progress when the list already showed its progress.
  case restartRefused(sessionId: String, uncertain: Bool)
  /// The limit of the restart started with `until` passed.
  case restartExpired(sessionId: String, until: Date)
  /// The grace after the card stood live again passed with `cliUpdate` still on it: the update did not apply.
  case restartGraceEnded(sessionId: String, settledAt: Date)
}

/// Stałe czasu sterowania (lustro PWA).
public enum SessionControlTiming {
  /// Ile pigułka trybu czeka na odczyt nowego trybu po tapnięciu (`MODE_TOGGLE_WAIT_MS`).
  public static let modeToggleWait: TimeInterval = 8
  /// How long the model pill waits for the list to show the whole target. Three commands without an early result
  /// sleep 14.4 s on the server, plus the screen reads.
  public static let modelChangeWait: TimeInterval = 20
  /// The longest restart: the server waits 10 s for the old process to exit and 60 s for the new one to be ready.
  public static let restartLimit: TimeInterval = 90
  /// How long a live card may still carry the old `cliUpdate` after a restart: the server reads the new process's
  /// version right after the card stands live again.
  public static let restartSettleGrace: TimeInterval = 5
}

/// Dlaczego zmiana modelu jest teraz niemożliwa (`modelSheetBlock` w PWA). `nil` = można.
///
/// Dwie różne przeszkody: `busy` to stan SESJI (tura, decyzja — serwer odbije 409), reszta to stan
/// KANAŁU do panelu (komenda nie miałaby którędy pojechać). Jedno „nie teraz" kosztowałoby
/// wyprawę do Maca po odpowiedź „to kiedy?".
public enum ModelChangeBlock: Sendable, Equatable {
  case busy
  case codex
  case unsupported
  case outOfScope
  case herdrUnavailable
  case herdrReadOnly
}

/// Wynik mutacji sterowania (model, tryb, restart). Zdania składa RarogUI.
public enum SessionControlOutcome: Sendable, Equatable {
  case accepted
  /// Ta sama akcja tej sesji już leci — nic nie wysłano.
  case inFlight
  /// Zmiana niemożliwa z tego stanu (bez żądania): tryb bez celu (`bypass`, nieznany), blokada modelu.
  case notAllowed
  /// Odmowa bramki klienta albo serwera (400/409/429) — zdanie do pokazania wprost.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}

/// Wynik odczytu diffa sesji.
public enum SessionDiffOutcome: Sendable, Equatable {
  case loaded(SessionDiff)
  /// Odmowa serwera (Codex: 400, sesji nie ma: 404) — zdanie serwera.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}

/// Odmowa trasy diffa per plik: status i kod serwera obok zdania. Okno diffa rozróżnia po nich przypadki,
/// których samo zdanie nie niesie.
public struct DiffRefusal: Sendable, Equatable {
  /// Status HTTP; `nil` = odmówiła bramka klienta, żądanie nie wyszło.
  public let status: Int?
  /// Kod z pola `error` (`bad-path`, `diff-file-not-found`, `session-not-found`, `git-failed`…).
  public let code: String?
  /// Zdanie serwera po polsku.
  public let message: String?

  public init(status: Int?, code: String? = nil, message: String? = nil) {
    self.status = status
    self.code = code
    self.message = message
  }

  /// 405: serwer sprzed tras per plik (nieznany `GET` pod `/api/sessions/<id>/…` wpada w strażnika metody,
  /// zanim router dojdzie do 404). Nowy serwer na `GET` tych tras 405 nie oddaje.
  public var serverOutdated: Bool { status == 405 }

  /// 404 `diff-file-not-found`: pliku nie ma na liście zmian z tego żądania — lista mogła się zmienić.
  public var fileGone: Bool { status == 404 && code == "diff-file-not-found" }

  /// 400 `bad-path`: ścieżka nie przeszła walidacji wstępnej serwera.
  public var badPath: Bool { status == 400 && code == "bad-path" }
}

/// Wynik odczytu listy zmian albo patcha jednego pliku. Odmowa niesie status i kod, nie samo zdanie:
/// po nich okno poznaje „serwer jest starszy niż apka" (405), „lista się zmieniła" (404 `diff-file-not-found`)
/// i „spróbuj ponownie" (503 `git-failed`).
public enum DiffFetchOutcome<Value: Sendable & Equatable>: Sendable, Equatable {
  case loaded(Value)
  case refused(DiffRefusal)
  case offline
  case timedOut
  /// Żądanie przerwane albo odpowiedź spoza kontraktu.
  case failed
  case loggedOut
}

extension ModeCycleTarget {
  /// Dokąd prowadzi tap w pigułkę trybu: `plan` → `auto`, `auto` i `manual` → `plan`
  /// (człowiek tapiący w pigułkę chce planowania). `bypass` i `unknown` = `nil`: bypass to decyzja
  /// z biurka, której Rarog nie odkręca, a nieznanego trybu nie da się przełączyć, bo pętla
  /// serwera porównuje odczyty stopki.
  public static func toggle(from mode: HerdrMode?) -> ModeCycleTarget? {
    switch mode {
    case .plan: .auto
    case .auto, .manual: .plan
    case .bypass, .unknown, nil: nil
    }
  }
}

extension AppState {
  /// Przełączenie trybu tej sesji czeka na odczyt stopki: wpis jest, termin nie minął, a lista
  /// nie przyniosła jeszcze celu. Sukces POST-a pigułki nie przestawia — robi to strumień.
  public func modeToggleInFlight(_ sessionId: String, now: Date) -> Bool {
    guard let toggle = sessionControls.modeToggles[sessionId], now < toggle.until else { return false }
    return sessions[sessionId]?.herdrMode != HerdrMode(rawValue: toggle.target.rawValue)
  }

  /// A model change of this session is in flight: the entry stands and its deadline has not passed. The reducer
  /// removes the entry when the list shows the target, so there is no comparison with the session here.
  public func modelChangeInFlight(_ sessionId: String, now: Date) -> Bool {
    modelChangeTarget(sessionId, now: now) != nil
  }

  /// The sent body of the model change in flight, or `nil`.
  public func modelChangeTarget(_ sessionId: String, now: Date) -> SessionModelBody? {
    guard let change = sessionControls.modelChanges[sessionId], now < change.until else { return nil }
    return change.target
  }

  /// A restart of this session is in progress: its request is out or the list has not shown its end yet.
  public func restartInProgress(_ sessionId: String) -> Bool {
    sessionControls.restarting.contains(sessionId) || sessionControls.pendingRestarts[sessionId] != nil
  }

  /// Przeszkoda zmiany modelu albo `nil`. Kanał jak przy wysyłce (`sendBlock`), a stan
  /// sesji osobno: tura, start i stojąca decyzja zamrażają model (przepięcie w środku tury
  /// zgubiłoby odpowiedź). Sesja nieznana liście też jest „zajęta" — nie wiemy o niej nic.
  public func modelChangeBlock(for sessionId: String) -> ModelChangeBlock? {
    guard let session = sessions[sessionId] else { return .busy }
    switch sendBlock(for: sessionId) {
    case .codex: return .codex
    case .unsupported: return .unsupported
    case .outOfScope: return .outOfScope
    case .herdrUnavailable: return .herdrUnavailable
    case .herdrReadOnly: return .herdrReadOnly
    case .decisionPending, .starting, .stateCard, nil: break
    }
    switch session.state {
    case .starting, .running, .waitingPermission, .waitingQuestion: return .busy
    default: return nil
    }
  }
}
