import Foundation
import RarogContract
import RarogCore

/// Pole wiadomości: czy czynne i dlaczego nie. Pole gaśnie DOKŁADNIE wtedy, gdy serwer
/// by odmówił — o tym decyduje rdzeń (`sendBlock`), tu tylko zdanie.
public struct ComposerModel: Sendable, Equatable {
  public let editable: Bool
  public let reason: String?
  /// Wysyłka przechodzi. W starcie agenta (``SendBlock/starting``) pole przyjmuje tekst, ale „Wyślij”, Return
  /// i wysyłka z dyktowania czekają na gotowość; start widać w wierszu aktywności nad polem, nie pod nim.
  public let sendable: Bool

  public init(editable: Bool, reason: String?, sendable: Bool? = nil) {
    self.editable = editable
    self.reason = reason
    self.sendable = sendable ?? editable
  }

  /// `ui`: stan kart ekranu (trzymane potwierdzenia pytań); pusty = karty wyłącznie ze stanu serwera.
  public static func make(
    state: AppState, sessionId: String, ui: TranscriptUIState = TranscriptUIState(), now: Date = Date()
  ) -> ComposerModel {
    let session = state.sessions[sessionId]
    // Tryb czytania przy niezgodności wersji: zmiana i tak dostałaby odmowę.
    switch state.compat {
    case .tooOld, .protocolMismatch:
      return ComposerModel(editable: false, reason: UICopy.banner(.incompatible(state.compat)))
    case .unknown, .ok:
      break
    }
    // Lista z pamięci podręcznej: zero akcji do świeżego stanu (`Selectors+Stale`).
    if state.sessionStale(sessionId) { return ComposerModel(editable: false, reason: UICopy.staleComposer) }
    guard let block = state.sendBlock(for: sessionId) else { return ComposerModel(editable: true, reason: nil) }
    if block == .starting { return ComposerModel(editable: true, reason: nil, sendable: false) }
    // Karta tej decyzji stoi (reguła stopy, `FootContent`): zdanie odsyła do karty, nie do terminalu. Karta
    // „dialog w terminalu" też jest kartą tej decyzji. Bez doku (`DecisionDock`) pole
    // przy `.decision` stoi tylko do odczytu, a karta w transkrypcie nad nim.
    let foot = FootContent.make(state: state, sessionId: sessionId, ui: ui, now: now)
    // Zastępnik okresu łaski stoi tam, gdzie stanie karta: zdanie od razu odsyła do karty i nie skacze po terminie.
    let cardShown = (foot.decisions?.hasCard(for: session?.state) ?? false)
      || state.decisionLoading(for: sessionId, now: now)
    return ComposerModel(editable: false, reason: UICopy.sendBlock(block, session: session, cardShown: cardShown))
  }
}

/// Co zrobić z tekstem po nieudanej wysyłce. Zależy od tego, czy ekran sesji,
/// z którego wyszła wiadomość, wciąż żyje: tekst nie może trafić do odłączonego pola, a wpis
/// kolejki nie może zniknąć, zanim tekst nie trafi tam, gdzie człowiek go zobaczy.
public enum SendRecovery: Sendable, Equatable {
  /// Ekran żyje: tekst wraca do pola, a wpis kolejki (jeśli jest) znika — dwie kopie byłyby mylące.
  case restoreToField(discard: UUID?)
  /// Ekranu już nie ma, a wpis jest: ZOSTAJE w trwałej kolejce jako odmowa z treścią
  /// („Ponów"/„Odrzuć" po powrocie, także po zabiciu apki).
  case keepEntry
  /// Ekranu nie ma i wpisu nie ma (blokada przed wysyłką, dysk odmówił): tekst do szkicu sesji.
  case saveDraft
  /// Nothing to recover: accepted, not confirmed or stopped in the progress ring (the entry stands in the transcript
  /// with Retry), or empty.
  case none

  public static func plan(_ outcome: SendOutcome, screenAttached: Bool) -> SendRecovery {
    switch outcome {
    case .accepted, .unconfirmed, .ignored, .empty, .refused(_, OutboxEntry.RefusalCode.cancelled?, _): .none
    case let .refused(id, _, _): screenAttached ? .restoreToField(discard: id) : .keepEntry
    case .blocked, .notPersisted: screenAttached ? .restoreToField(discard: nil) : .saveDraft
    }
  }
}

/// Pamięć połączenia dla dyskretnego „łączę…" i baneru „Serwer nie odpowiada".
///
/// Pętla strumienia przeplata `offline` (przerwa) i `connecting` (próba) — sam bieżący stan dawałby
/// baner, który gaśnie przy każdej próbie. Pamięć trzyma dwa fakty od ostatniego `online`: od kiedy
/// nie ma połączenia i czy próba już raz padła.
public struct ConnectionMemory: Sendable, Equatable {
  public private(set) var notOnlineSince: Date?
  public private(set) var failedSinceOnline = false
  /// Brak połączenia zaczął się od żywego strumienia (`online` → `offline` albo `connecting`): zerwanie w trakcie
  /// pracy apki, nie start i nie powrót z tła (tło zatrzymuje strumienie, więc łączenie po nim idzie od `idle`).
  public private(set) var droppedWhileOnline = false
  /// An attempt failed, the red card's condition. A drop of a live stream is no attempt: the loop reconnects right
  /// after it. Only a failure ``connectingCardDelay`` or more after the gap began counts. The first attempt after a
  /// return often runs on the tunnel that died in the background and fails at once; a VPN interface that blinks for
  /// a moment makes iOS report a network change, the store starts a new loop and its first attempt fails the same
  /// way. In both cases the next attempt connects within a few seconds.
  public private(set) var attemptFailed = false
  /// Some attempt failed in this gap, however quickly; unlike ``failedSinceOnline`` the drop of a live stream itself
  /// does not count. Only the gap trace in `client.log` reads it.
  public private(set) var anyAttemptFailed = false
  /// Ostatni obserwowany status to `online` — następny brak połączenia jest zerwaniem.
  private var lastOnline = false
  /// When this memory saw the stream come online; `nil` while it is not online. The viewed session's stream counts
  /// its card delay from this moment too, so a return from the background does not show the card when the session
  /// arrives a moment after the list.
  public private(set) var onlineSince: Date?

  public init() {}

  public mutating func observe(_ status: ConnectionStatus, now: Date) {
    let wasOnline = lastOnline
    lastOnline = status == .online
    onlineSince = status == .online ? (wasOnline ? onlineSince : now) : nil
    switch status {
    case .online, .idle:
      // `idle` = strumienia nikt nie prowadzi (tło, wylogowanie) — to nie jest awaria.
      notOnlineSince = nil
      failedSinceOnline = false
      droppedWhileOnline = false
      attemptFailed = false
      anyAttemptFailed = false
    case let .connecting(since):
      if notOnlineSince == nil {
        notOnlineSince = min(since, now)
        droppedWhileOnline = wasOnline
      }
    case let .offline(since):
      if notOnlineSince == nil {
        notOnlineSince = min(since, now)
        droppedWhileOnline = wasOnline
      }
      failedSinceOnline = true
      if !wasOnline { anyAttemptFailed = true }
      if !wasOnline, now.timeIntervalSince(notOnlineSince ?? now) >= Self.connectingCardDelay {
        attemptFailed = true
      }
    }
  }

  /// The connection card in the banner strip: gray "Connecting to the server…" until an attempt has failed
  /// (``attemptFailed``), then red "Server not responding" in the same place. A drop while the app is in use shows
  /// the gray card at once; a start and a return from the background only after ``connectingCardDelay`` (iOS drops
  /// the stream whenever the screen sleeps, and the card moves the list, so a short connect after unlocking does not
  /// flash). The activity row's "connecting…" threshold (``showsConnecting(now:delay:)``) stays separate.
  public var connectionCard: Banner? {
    guard let since = notOnlineSince else { return nil }
    if attemptFailed { return .serverUnreachable }
    return .connecting(visibleFrom: droppedWhileOnline ? since : since.addingTimeInterval(Self.connectingCardDelay))
  }

  /// The connecting card's delay after a start and a return from the background: after a few minutes in the
  /// background the iroh tunnel alone takes up to ~1.4 s to carry requests again, and the stream is online only from
  /// its first body byte, so a shorter delay lit the card on an ordinary return.
  public static let connectingCardDelay: TimeInterval = 3

  /// „łączę…" dopiero po ~1 s: krótkie łączenie nie mruga.
  public func showsConnecting(now: Date, delay: TimeInterval = 1) -> Bool {
    guard let since = notOnlineSince else { return false }
    return now.timeIntervalSince(since) >= delay
  }

  /// Baner brakującego serwera: próba padła, a połączenia dalej nie ma.
  public var showsServerUnreachable: Bool { failedSinceOnline && notOnlineSince != nil }

  /// The connecting card from the viewed session's stream (this memory) while the global stream is online: it stands
  /// once the session stream has not been online for ``sessionCardDelay``, counted from the later of the moment it
  /// started connecting and the global stream's ``onlineSince``. A failed attempt or a dropped stream gives the
  /// stalled transcript banner instead (one failure, one banner), and an idle stream gives nothing.
  public func sessionStreamCard(globalOnlineSince: Date?) -> Banner? {
    guard let since = notOnlineSince, let globalOnlineSince, !showsServerUnreachable else { return nil }
    return .connecting(visibleFrom: max(since, globalOnlineSince).addingTimeInterval(Self.sessionCardDelay))
  }

  /// The card the viewed session's stream gives in its gap, as the banner strip shows it: the stalled transcript
  /// banner after a failure, only while the global stream is online; else the gray card of ``sessionStreamCard``.
  public func sessionGapCard(globalOnlineSince: Date?) -> Banner? {
    if showsServerUnreachable { return globalOnlineSince == nil ? nil : .transcriptStalled }
    return sessionStreamCard(globalOnlineSince: globalOnlineSince)
  }

  /// How long the viewed session's stream may connect before the card stands: switching sessions takes a fraction of
  /// a second on a direct connection, and the card moves the list.
  public static let sessionCardDelay: TimeInterval = 3

  /// The scene came back from the background as `inactive`: the store resumes the streams only on `active`, so a
  /// visible window gets no data until then (the tunnel, too, leaves its background grace only on `active`). That
  /// counts as a connection starting now: the card after ``connectingCardDelay``, so the usual quick pass through
  /// `inactive` does not flash it. Going to the background again ends it like any stopped stream. Without a login
  /// no stream starts on `active` either, so there is nothing to wait for; a live stream (a second window) keeps
  /// its own statuses.
  public mutating func observeScene(
    _ phase: ScenePhase, from previous: ScenePhase, stream: ConnectionStatus, loggedIn: Bool, now: Date
  ) {
    guard stream == .idle else { return }
    switch phase {
    case .inactive where previous == .background && loggedIn:
      observe(.connecting(since: now), now: now)
    case .background:
      observe(.idle, now: now)
    case .inactive, .active:
      break
    }
  }
}

extension AppState {
  /// Banery kolumny listy (globalne) w kolejności z `Model/BannerSlots`; brak serwera z ``ConnectionMemory``.
  /// Reguły obu kolumn: ``banners(in:global:transcript:)`` (`Model/BannerSlots`).
  public func globalBanners(memory: ConnectionMemory) -> [Banner] {
    banners(in: .list, global: memory, transcript: ConnectionMemory())
  }
}
