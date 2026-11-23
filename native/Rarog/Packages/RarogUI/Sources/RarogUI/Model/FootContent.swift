import Foundation
import RarogContract
import RarogCore

// Reguła stopy ekranu sesji: co stoi pod transkryptem — nic, karta stanu, karta decyzji albo pole
// wiadomości. Jedno miejsce zamiast osobnych warunków „karta stoi”
// w polu (`ComposerModel`), w przełączniku pola i karty stanu (`renderStateCard`) i w przygaszeniu
// transkryptu (`TranscriptReading`). Właściciel: karty.

/// Miejsce karty decyzji na ekranie sesji i los pola wiadomości przy niej.
///
/// Tryb wybiera jedna stała, ``mode``; powrót do każdego trybu to zmiana tej stałej i build:
/// - ``Mode/transcript`` (domyślny): karta stoi w transkrypcie jak przed dokiem, a pole wiadomości jest
///   schowane, dopóki karta czeka na decyzję — `DecisionDock.mode = .transcript`;
/// - ``Mode/dock``: karta stoi w stopie, w doku w miejscu pola — `DecisionDock.mode = .dock`;
/// - ``Mode/readOnlyComposer``: karta w transkrypcie, pole pod nią tylko do odczytu ze zdaniem
///   `composer.decisionOnCard` albo `composer.questionOnCard` — `DecisionDock.mode = .readOnlyComposer`.
///
/// ``FootContent/make(state:sessionId:ui:now:)`` liczy ``FootContent/decision(_:)`` zawsze; o miejscu karty
/// rozstrzygają ``placement(foot:snapshotLoaded:loading:mode:)`` i ``dims(foot:view:mode:)``. Obie biorą tryb
/// parametrem, a ekran sesji trzyma go we własnym polu (`SessionViewController.decisionMode`), więc test sprawdza
/// każdy tryb bez przebudowy.
public enum DecisionDock {
  /// Tryb ekranu sesji przy karcie decyzji.
  public enum Mode: Sendable, Equatable {
    /// Karta w transkrypcie, pole pod nią tylko do odczytu ze zdaniem.
    case readOnlyComposer
    /// Karta w doku, w miejscu pola wiadomości.
    case dock
    /// Karta w transkrypcie, pole schowane, dopóki karta czeka na decyzję.
    case transcript
  }

  /// Tryb, z którym startuje ekran sesji.
  public static let mode: Mode = .transcript

  /// Najniższy sufit karty w doku: nagłówek i stopka z przyciskami muszą się zmieścić także na niskim ekranie
  /// z wysuniętą klawiaturą (telefon w poziomie).
  public static let minimumCeiling: Double = 120
  /// Zapas nad dokiem, gdy liczy się miejsce nad klawiaturą: tyle transkryptu zostaje widać nad kartą.
  public static let transcriptReserve: Double = 120

  /// Co stoi w stopie: karta w doku (pierwsza z kolejki) albo zastępnik okresu łaski i czy pole jest schowane.
  public struct Placement: Sendable, Equatable {
    /// Karta w doku; `nil` = żadna (pole, karta stanu, zastępnik, pusty dok albo karta w transkrypcie).
    public var card: DecisionCard?
    /// Pole wiadomości schowane: w jego miejscu dok z kartą, zastępnik albo pusty dok przed pierwszą migawką; w trybie
    /// ``Mode/transcript`` stopa jest wtedy pusta, a karta i zastępnik stoją w transkrypcie.
    public var hidesComposer: Bool
    /// Liczba kart w doku i za nim (nagłówek „1 z N” przy więcej niż jednej); poza dokiem 0.
    public var total: Int
    /// W doku stoi zastępnik okresu łaski (`TranscriptRow.decisionPending`, ``DecisionGraceTiming``), nie wiersz ogona
    /// transkryptu: karta, która przyjdzie, stanie dokładnie w jego miejscu, bez klatki z polem pomiędzy.
    public var pending = false

    public static let none = Placement(card: nil, hidesComposer: false, total: 0)
  }

  /// Miejsce karty decyzji i pole.
  ///
  /// Dok (``Mode/dock``) bierze pierwszą kartę kolejki: zgodę, „dialog w terminalu”, pytanie (także formularz) i samo
  /// potwierdzenie odpowiedzi. Pusta kolejka w okresie łaski (`loading`, `AppState.decisionLoading`) stawia
  /// w doku zastępnik; poza nim przed pierwszą migawką transkryptu chowa pole (dok pusty), a po migawce bez karty pole
  /// ze zdaniem o terminalu zostaje (podmiana tylko przy karcie tej decyzji).
  ///
  /// W trybie ``Mode/transcript`` karta i zastępnik stoją w transkrypcie (`card == nil`, `pending == false`), a pole
  /// znika przy tych samych stopach co pod dokiem, z jednym wyjątkiem: samo trzymane potwierdzenie odpowiedzi pola nie
  /// chowa, bo sesja już ruszyła. W trybie ``Mode/readOnlyComposer`` pole stoi zawsze.
  public static func placement(
    foot: FootContent, snapshotLoaded: Bool, loading: Bool = false, mode: Mode = mode
  ) -> Placement {
    guard mode != .readOnlyComposer, let queue = foot.decisions else { return .none }
    if mode == .transcript {
      let hides = queue.isEmpty ? loading || !snapshotLoaded : queue.awaitsDecision
      return Placement(card: nil, hidesComposer: hides, total: 0)
    }
    guard let first = queue.first else {
      if loading { return Placement(card: nil, hidesComposer: true, total: 0, pending: true) }
      return Placement(card: nil, hidesComposer: !snapshotLoaded, total: 0)
    }
    return Placement(card: first, hidesComposer: true, total: queue.cards.count)
  }

  /// Transkrypt przygasa. Karta w transkrypcie (``Mode/readOnlyComposer``, ``Mode/transcript``): według kart
  /// z treścią (`DecisionQueue.pending`), także przy karcie zamkniętej i karcie kanału po decyzji.
  /// Z dokiem według stopy: przy decyzji, która czeka na człowieka (samo trzymane potwierdzenie odpowiedzi nie
  /// przygasza).
  public static func dims(foot: FootContent, view: TranscriptState?, mode: Mode = mode) -> Bool {
    guard mode == .dock else { return !DecisionQueue.pending(in: view).isEmpty }
    return foot.decisions?.awaitsDecision ?? false
  }

  /// Sufit karty w doku (`decisionDockCeiling`): `min(0,5 × wysokość ekranu sesji, miejsce nad klawiaturą − 120 pt)`,
  /// nie niżej niż ``minimumCeiling``.
  public static func ceiling(screenHeight: Double, aboveKeyboard: Double) -> Double {
    max(minimumCeiling, min(0.5 * screenHeight, aboveKeyboard - transcriptReserve))
  }

  /// Podział sufitu karty w układzie zwartym (nagłówek, przewijany środek, zamknięcie z przyciskami), wysokości
  /// naturalne na wejściu. Środek dostaje to, co zostaje po częściach przypiętych. Gdy same części przypięte nie mieszczą
  /// się pod sufitem (duże pismo, niski sufit, długi komunikat), środek i nagłówek trzymają po swojej wysokości,
  /// ale nie więcej niż trzecią część sufitu, zamknięcie z przyciskami bierze resztę (całe, jeśli się zmieści),
  /// a nagłówek i środek dostają to, co zostaje po nim. Karta nigdy nie jest wyższa niż sufit, a środek (opcje,
  /// „Własna odpowiedź”) nigdy nie spada do 0; część przypięta niższa niż jej treść przewija się sama
  /// (`dockPinned`), więc każda część karty jest osiągalna przy każdym suficie.
  public static func compactHeights(
    header: Double, middle: Double, closing: Double, ceiling: Double
  ) -> (header: Double, middle: Double, closing: Double) {
    let ceiling = max(0, ceiling)
    let headerFloor = min(max(0, header), ceiling / 3)
    let middleFloor = min(max(0, middle), ceiling / 3)
    let closing = min(max(0, closing), ceiling - headerFloor - middleFloor)
    let header = min(max(0, header), ceiling - closing - middleFloor)
    let middle = min(max(0, middle), ceiling - closing - header)
    return (header, middle, closing)
  }
}

/// Jedna karta decyzji w kolejce stopy — adres, nie model: model karty składa ogon transkryptu
/// (`TranscriptRows.tail`), a dok bierze go po tym samym adresie.
public enum DecisionCard: Sendable, Equatable {
  /// Karta zgody (z ekranu albo kanału zgód), także z decyzją w locie.
  case permission(permId: String)
  /// Karta pytania czekającego na odpowiedź (także z odpowiedzią w drodze).
  case question(qId: String)
  /// Trzymane potwierdzenie odpowiedzi: pytania już nie ma w kolejce serwera, karta stoi do końca okna.
  case heldQuestion(qId: String)
  /// Karta „dialog w terminalu”, adresem czekania (`HerdrDialogCards.identity`).
  case herdrDialog(identity: String)
}

/// Karty decyzji tej sesji w kolejności ogona transkryptu: zgody, pytania czekające, trzymane potwierdzenia
/// pytań, karta „dialog w terminalu”. Dok pokazuje pierwszą.
public struct DecisionQueue: Sendable, Equatable {
  public var cards: [DecisionCard]

  public init(_ cards: [DecisionCard] = []) {
    self.cards = cards
  }

  public var first: DecisionCard? { cards.first }
  public var isEmpty: Bool { cards.isEmpty }

  /// W kolejce stoi karta, która czeka na człowieka: zgoda, pytanie albo „dialog w terminalu”. Samo trzymane
  /// potwierdzenie odpowiedzi to już nie decyzja — sesja ruszyła.
  public var awaitsDecision: Bool {
    cards.contains { card in
      if case .heldQuestion = card { return false }
      return true
    }
  }

  /// Karty z treścią prosto ze stanu transkryptu: zgody i pytania czekające — bez trzymanych potwierdzeń (te żyją
  /// w stanie ekranu) i bez karty „dialog w terminalu” (ta wynika ze stanu sesji).
  public static func pending(in view: TranscriptState?) -> [DecisionCard] {
    guard let view else { return [] }
    return view.pendingPermissions.map { .permission(permId: $0.permId) }
      + view.pendingQuestions.map { .question(qId: $0.qId) }
  }

  /// Trzymane potwierdzenia: odpowiedzi z tego ekranu na pytania, których nie ma już w kolejce — w porządku
  /// `TranscriptRows.questionRows` (najpierw najwcześniej zdjęte).
  static func held(in view: TranscriptState, ui: TranscriptUIState) -> [DecisionCard] {
    let live = Set(view.pendingQuestions.map(\.qId))
    return ui.questions.flights.values
      .filter { !live.contains($0.card.qId) }
      .sorted { ($0.goneAt ?? .distantFuture, $0.card.qId) < ($1.goneAt ?? .distantFuture, $1.card.qId) }
      .map { .heldQuestion(qId: $0.card.qId) }
  }

  /// Pełna kolejka czekającej sesji — dokładnie karty decyzji, które składa `TranscriptRows.tail`.
  static func make(state: AppState, sessionId: String, ui: TranscriptUIState, now: Date = Date()) -> DecisionQueue {
    guard let view = state.transcripts[sessionId] else { return DecisionQueue() }
    var cards = pending(in: view) + held(in: view, ui: ui)
    // Karta „dialog w terminalu” nie staje, gdy odpowiedź na pytanie leci albo stoi jej potwierdzenie,
    // ani w okresie łaski (`AppState.decisionLoading`) — wtedy kolejka jest pusta, a dok stawia zastępnik.
    if !ui.questions.holdsDialogCard, state.herdrDialogShown(for: sessionId, now: now),
      let session = state.sessions[sessionId]
    {
      cards.append(.herdrDialog(identity: HerdrDialogCards.identity(session)))
    }
    return DecisionQueue(cards)
  }

  /// Stoi karta TEJ decyzji, na którą czeka sesja (zdanie pod polem): zgoda przy czekaniu na zgodę,
  /// pytanie przy czekaniu na odpowiedź; karta „dialog w terminalu” i trzymane potwierdzenie (stoi na miejscu karty
  /// dialogu) — przy każdym czekaniu.
  public func hasCard(for waiting: SessionState?) -> Bool {
    cards.contains { card in
      switch card {
      case .herdrDialog, .heldQuestion: true
      case .permission: waiting == .waitingPermission
      case .question: waiting == .waitingQuestion
      }
    }
  }
}

/// Co stoi w stopie ekranu sesji.
public enum FootContent: Sendable, Equatable {
  /// Sesji nie ma na liście: ani pola, ani karty.
  case none
  /// Karta stanu w miejscu pola (`StateCards.make`).
  case stateCard
  /// Sesja czeka na decyzję z tej apki albo stoi potwierdzenie odpowiedzi; pusta kolejka = przed pierwszą migawką
  /// transkryptu (kart jeszcze nie znamy).
  case decision(DecisionQueue)
  /// Pole wiadomości — czynne albo tylko do odczytu ze zdaniem (`ComposerModel`); także przy karcie zamkniętej
  /// (niezgodność wersji, lista z pamięci podręcznej, herdr niedostępny albo tylko do odczytu).
  case composer

  /// Kolejka decyzji albo `nil`, gdy stopa nie stoi przy decyzji.
  public var decisions: DecisionQueue? {
    if case let .decision(queue) = self { return queue }
    return nil
  }

  /// Reguła stopy. Kolejność: brak sesji, karta stanu, karta zamknięta (pole z powodem), czekanie na decyzję,
  /// trzymane potwierdzenie, pole.
  public static func make(state: AppState, sessionId: String, ui: TranscriptUIState, now: Date = Date()) -> FootContent {
    guard state.sessions[sessionId] != nil else { return .none }
    if StateCards.make(state: state, sessionId: sessionId) != nil { return .stateCard }
    // Niezgodność wersji i lista z pamięci podręcznej: zero akcji do świeżego stanu.
    switch state.compat {
    case .tooOld, .protocolMismatch: return .composer
    case .unknown, .ok: break
    }
    if state.sessionStale(sessionId) { return .composer }
    switch state.sendBlock(for: sessionId) {
    case .decisionPending?:
      return .decision(DecisionQueue.make(state: state, sessionId: sessionId, ui: ui, now: now))
    case nil, .starting?:
      // Sesja ruszyła, a potwierdzenie odpowiedzi stoi do końca swojego okna; karta kanału zgód w `claimed`
      // albo `running` zostaje w transkrypcie jako ślad i decyzją już nie jest.
      guard let view = state.transcripts[sessionId] else { return .composer }
      let held = DecisionQueue.held(in: view, ui: ui)
      return held.isEmpty ? .composer : .decision(DecisionQueue(held))
    default:
      // herdr niedostępny albo tylko do odczytu: karta stoi zamknięta, pole ze zdaniem.
      return .composer
    }
  }
}
