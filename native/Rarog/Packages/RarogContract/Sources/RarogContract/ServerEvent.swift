// 20 typów ramek SSE — lustro `serverEventSchema` z `shared/src/protocol.ts`. Nieznany `type`
// ramki to odrzucenie (reguła forward-compat: stary klient ignoruje ramkę, której nie zna).

/// Ramka SSE po zdekodowaniu. Payload nie niesie pola `type` — wyznacza je przypadek.
///
/// Dekoduj przez ``EventDecoder``: goły `JSONDecoder` przyjmie te same ramki, ale zgubi listę
/// degradacji (linie `kontrakt:` w logu).
public enum ServerEvent: Sendable, Equatable, Codable {
  case hello(HelloEvent)
  case sessionsSnapshot(SessionsSnapshotEvent)
  case sessionChanged(SessionChangedEvent)
  case transcriptSnapshot(TranscriptSnapshotEvent)
  case message(MessageEvent)
  case delta(DeltaEvent)
  case activity(ActivityEvent)
  case permissionPending(PermissionPendingEvent)
  case permissionResolved(PermissionResolvedEvent)
  case permissionSettled(PermissionSettledEvent)
  case questionPending(QuestionPendingEvent)
  case questionResolved(QuestionResolvedEvent)
  case state(StateEvent)
  case gitStatus(GitStatusEvent)
  case usage(UsageEvent)
  case herdrStatus(HerdrStatusEvent)
  case notes(NotesEvent)
  case inboxHeads(InboxHeadsEvent)
  case inboxHead(InboxHeadEvent)
  case inboxRemoved(InboxRemovedEvent)

  /// Wartości pola `type` na drucie, po jednej na przypadek.
  public enum WireType: String, ContractEnum {
    case hello
    case sessionsSnapshot = "sessions-snapshot"
    case sessionChanged = "session-changed"
    case transcriptSnapshot = "transcript-snapshot"
    case message
    case delta
    case activity
    case permissionPending = "permission-pending"
    case permissionResolved = "permission-resolved"
    case permissionSettled = "permission-settled"
    case questionPending = "question-pending"
    case questionResolved = "question-resolved"
    case state
    case gitStatus = "git-status"
    case usage
    case herdrStatus = "herdr-status"
    case notes
    case inboxHeads = "inbox-heads"
    case inboxHead = "inbox-head"
    case inboxRemoved = "inbox-removed"
  }

  public var wireType: WireType {
    switch self {
    case .hello: .hello
    case .sessionsSnapshot: .sessionsSnapshot
    case .sessionChanged: .sessionChanged
    case .transcriptSnapshot: .transcriptSnapshot
    case .message: .message
    case .delta: .delta
    case .activity: .activity
    case .permissionPending: .permissionPending
    case .permissionResolved: .permissionResolved
    case .permissionSettled: .permissionSettled
    case .questionPending: .questionPending
    case .questionResolved: .questionResolved
    case .state: .state
    case .gitStatus: .gitStatus
    case .usage: .usage
    case .herdrStatus: .herdrStatus
    case .notes: .notes
    case .inboxHeads: .inboxHeads
    case .inboxHead: .inboxHead
    case .inboxRemoved: .inboxRemoved
    }
  }

  enum CodingKeys: String, CodingKey { case type }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.type)
    guard let type = WireType.wire(raw) else { throw UnknownEventType(type: raw) }
    switch type {
    case .hello: self = .hello(try HelloEvent(from: decoder))
    case .sessionsSnapshot: self = .sessionsSnapshot(try SessionsSnapshotEvent(from: decoder))
    case .sessionChanged: self = .sessionChanged(try SessionChangedEvent(from: decoder))
    case .transcriptSnapshot: self = .transcriptSnapshot(try TranscriptSnapshotEvent(from: decoder))
    case .message: self = .message(try MessageEvent(from: decoder))
    case .delta: self = .delta(try DeltaEvent(from: decoder))
    case .activity: self = .activity(try ActivityEvent(from: decoder))
    case .permissionPending: self = .permissionPending(try PermissionPendingEvent(from: decoder))
    case .permissionResolved: self = .permissionResolved(try PermissionResolvedEvent(from: decoder))
    case .permissionSettled: self = .permissionSettled(try PermissionSettledEvent(from: decoder))
    case .questionPending: self = .questionPending(try QuestionPendingEvent(from: decoder))
    case .questionResolved: self = .questionResolved(try QuestionResolvedEvent(from: decoder))
    case .state: self = .state(try StateEvent(from: decoder))
    case .gitStatus: self = .gitStatus(try GitStatusEvent(from: decoder))
    case .usage: self = .usage(try UsageEvent(from: decoder))
    case .herdrStatus: self = .herdrStatus(try HerdrStatusEvent(from: decoder))
    case .notes: self = .notes(try NotesEvent(from: decoder))
    case .inboxHeads: self = .inboxHeads(try InboxHeadsEvent(from: decoder))
    case .inboxHead: self = .inboxHead(try InboxHeadEvent(from: decoder))
    case .inboxRemoved: self = .inboxRemoved(try InboxRemovedEvent(from: decoder))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case let .hello(event): try event.encode(to: encoder)
    case let .sessionsSnapshot(event): try event.encode(to: encoder)
    case let .sessionChanged(event): try event.encode(to: encoder)
    case let .transcriptSnapshot(event): try event.encode(to: encoder)
    case let .message(event): try event.encode(to: encoder)
    case let .delta(event): try event.encode(to: encoder)
    case let .activity(event): try event.encode(to: encoder)
    case let .permissionPending(event): try event.encode(to: encoder)
    case let .permissionResolved(event): try event.encode(to: encoder)
    case let .permissionSettled(event): try event.encode(to: encoder)
    case let .questionPending(event): try event.encode(to: encoder)
    case let .questionResolved(event): try event.encode(to: encoder)
    case let .state(event): try event.encode(to: encoder)
    case let .gitStatus(event): try event.encode(to: encoder)
    case let .usage(event): try event.encode(to: encoder)
    case let .herdrStatus(event): try event.encode(to: encoder)
    case let .notes(event): try event.encode(to: encoder)
    case let .inboxHeads(event): try event.encode(to: encoder)
    case let .inboxHead(event): try event.encode(to: encoder)
    case let .inboxRemoved(event): try event.encode(to: encoder)
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(wireType, forKey: .type)
  }
}

/// Nieznany `type` ramki — klient ją pomija (forward-compat), nie degraduje.
struct UnknownEventType: Error {
  let type: String
}

/// Przywitanie strumienia GLOBALNEGO. `minClientBuild` — próg zgodności apki; brak = bez bramki.
/// `heartbeatMs` is the server ping interval in ms, any positive integer; absent = heartbeat off or an older server.
/// Only `validHeartbeatMs` applies the range the app trusts.
public struct HelloEvent: Sendable, Equatable, Codable {
  public var protocolVersion: Int
  public var serverStartId: String
  public var minClientBuild: Int?
  public var heartbeatMs: Int?

  /// Range of `heartbeatMs` the app treats as valid (`HELLO_HEARTBEAT_MS` in `shared/src/protocol.ts`).
  public static let heartbeatRange = 1000...60000

  /// `heartbeatMs` inside `heartbeatRange`, otherwise `nil`: a value outside it means the same as no field.
  public var validHeartbeatMs: Int? {
    heartbeatMs.flatMap { Self.heartbeatRange.contains($0) ? $0 : nil }
  }

  enum CodingKeys: String, CodingKey { case protocolVersion, serverStartId, minClientBuild, heartbeatMs }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    protocolVersion = try c.required(.protocolVersion)
    serverStartId = try c.required(.serverStartId)
    minClientBuild = try c.optional(.minClientBuild)
    // Kontrakt: całkowita ≥ 1 (serwer waliduje `RAROG_MIN_CLIENT_BUILD` przy starcie).
    if let minClientBuild, minClientBuild < 1 {
      throw contractViolation(c.codingPath + [CodingKeys.minClientBuild], "minClientBuild < 1")
    }
    heartbeatMs = try c.optional(.heartbeatMs)
    // Contract: a positive integer. The range is not checked here, so another interval never rejects `hello`.
    if let heartbeatMs, heartbeatMs < 1 {
      throw contractViolation(c.codingPath + [CodingKeys.heartbeatMs], "heartbeatMs < 1")
    }
  }
}

/// Pełny stan listy (ramka startowa strumienia globalnego i po zamknięciu sesji).
public struct SessionsSnapshotEvent: Sendable, Equatable, Codable {
  public var sessions: [SessionSummary]
  public var herdrStatus: HerdrStatus?
  /// Brak pola = serwer o notatkach nie mówi (gaś wszystkie ikony); pusta tablica = żaden
  /// projekt z TEJ ramki notatki nie ma.
  public var notesCwds: [String]?

  enum CodingKeys: String, CodingKey { case sessions, herdrStatus, notesCwds }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessions = try c.required(.sessions)
    herdrStatus = try c.optional(.herdrStatus)
    notesCwds = try c.optional(.notesCwds)
  }
}

/// Zmiana jednej sesji.
public struct SessionChangedEvent: Sendable, Equatable, Codable {
  public var session: SessionSummary

  enum CodingKeys: String, CodingKey { case session }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    session = try c.required(.session)
  }
}

/// Pełny stan transkryptu (wejście w sesję, kursor za stary). Ogon serwera: ≤ 500 wiadomości.
public struct TranscriptSnapshotEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var messages: [TranscriptMessage]
  public var pendingPermissions: [PermissionRequest]
  public var pendingQuestions: [QuestionRequest]
  public var activity: Activity?

  enum CodingKeys: String, CodingKey { case sessionId, messages, pendingPermissions, pendingQuestions, activity }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    messages = try c.required(.messages)
    pendingPermissions = try c.required(.pendingPermissions)
    pendingQuestions = try c.required(.pendingQuestions)
    activity = try c.tolerantOptional(.activity)
  }
}

/// Domknięta wiadomość (ma `id:` w strumieniu — przesuwa kursor).
public struct MessageEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var message: TranscriptMessage

  enum CodingKeys: String, CodingKey { case sessionId, message }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    message = try c.required(.message)
  }
}

/// Przyrost tekstu OTWARTEJ wiadomości agenta. Ulotny: bez `id:`, nie wraca w replayu.
public struct DeltaEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var text: String

  enum CodingKeys: String, CodingKey { case sessionId, text }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    text = try c.required(.text)
  }
}

/// Ulotny sygnał „agent coś robi". Pola aktywności leżą na wierzchu ramki (jak w TS).
public struct ActivityEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var activity: Activity

  enum CodingKeys: String, CodingKey { case sessionId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    activity = try Activity(from: decoder)
  }

  public func encode(to encoder: any Encoder) throws {
    try activity.encode(to: encoder)
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(sessionId, forKey: .sessionId)
  }
}

/// Nowa karta zgody.
public struct PermissionPendingEvent: Sendable, Equatable, Codable {
  public var request: PermissionRequest

  enum CodingKeys: String, CodingKey { case request }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    request = try c.required(.request)
  }
}

/// Zgoda rozstrzygnięta; `by` = etykieta urządzenia (z parowania; klient bez klucza — nagłówek `X-Rarog-Client`).
public struct PermissionResolvedEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var permId: String
  public var decision: PermissionResolution
  public var by: String

  enum CodingKeys: String, CodingKey { case sessionId, permId, decision, by }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    permId = try c.required(.permId)
    decision = try c.lenient(.decision, degrade: .permissionResolvedDecision)
    by = try c.required(.by)
  }
}

/// Zmiana stanu albo przycisków karty kanału zgód W MIEJSCU (ten sam `permId`). Klient bez karty o tym `permId`
/// ramkę pomija: spóźniona zmiana nie przywraca zdjętej karty.
public struct PermissionSettledEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var permId: String
  public var state: ConsentCardState
  public var canAllow: Bool
  public var unavailable: ConsentUnavailableReason?
  public var dialogVisible: Bool?
  public var at: String

  enum CodingKeys: String, CodingKey { case sessionId, permId, state, canAllow, unavailable, dialogVisible, at }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    permId = try c.required(.permId)
    state = try c.lenient(.state, degrade: .permissionState)
    canAllow = try c.required(.canAllow)
    unavailable = try c.lenientOptional(.unavailable, degrade: .permissionUnavailable)
    dialogVisible = try c.optional(.dialogVisible)
    at = try c.required(.at)
  }
}

/// Nowa karta pytania.
public struct QuestionPendingEvent: Sendable, Equatable, Codable {
  public var request: QuestionRequest

  enum CodingKeys: String, CodingKey { case request }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    request = try c.required(.request)
  }
}

/// Pytanie rozstrzygnięte.
public struct QuestionResolvedEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var qId: String

  enum CodingKeys: String, CodingKey { case sessionId, qId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    qId = try c.required(.qId)
  }
}

/// Zmiana stanu sesji.
public struct StateEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var state: SessionState
  public var detail: String?
  /// Kod zdania `detail`. Przy `state.limit-reached` `detail` zostaje tokenem `resetAt=<ISO>`.
  public var detailRef: SentenceRef?
  public var since: String

  enum CodingKeys: String, CodingKey { case sessionId, state, detail, detailRef, since }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    state = try c.lenient(.state, degrade: .state)
    detail = try c.optional(.detail)
    detailRef = try c.optional(.detailRef)
    since = try c.required(.since)
  }
}

extension StateEvent: SentenceBearing {
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    detail = detail.map { render($0, detailRef) }
  }
}

/// Stan gita katalogu sesji.
public struct GitStatusEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var branch: String
  public var dirtyCount: Int
  public var files: [String]
  public var ahead: Int?
  public var behind: Int?
  public var fileKinds: GitFileKinds?
  public var lastCommit: GitCommit?
  /// Pliki z rodzajem i licznikami linii, kolejność jak `files`. `nil` = ta ramka szczegółów nie
  /// niesie — i to jest cała prawda tej ramki, nie „zostaw poprzednie".
  public var fileDetails: [GitFileDetail]?

  enum CodingKeys: String, CodingKey {
    case sessionId, branch, dirtyCount, files, ahead, behind, fileKinds, lastCommit, fileDetails
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    branch = try c.required(.branch)
    dirtyCount = try c.required(.dirtyCount)
    files = try c.required(.files)
    ahead = try c.optional(.ahead)
    behind = try c.optional(.behind)
    fileKinds = try c.optional(.fileKinds)
    lastCommit = try c.optional(.lastCommit)
    fileDetails = try c.optional(.fileDetails)
  }
}

/// Jeden brudny plik: rodzaj zmiany i liczniki linii. Brak licznika = „nie wiem", nie zero;
/// `binary == true` = git linii tego pliku nie liczy.
public struct GitFileDetail: Sendable, Equatable, Codable {
  public var path: String
  public var kind: GitFileChangeKind
  public var linesAdded: Int?
  public var linesDeleted: Int?
  public var binary: Bool?

  enum CodingKeys: String, CodingKey { case path, kind, linesAdded, linesDeleted, binary }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    path = try c.required(.path)
    kind = try c.lenient(.kind, degrade: .fileDetailsKind)
    linesAdded = try c.optional(.linesAdded)
    linesDeleted = try c.optional(.linesDeleted)
    binary = try c.optional(.binary)
    // Kontrakt: liczniki to liczby całkowite ≥ 0 (`z.number().int().nonnegative()`).
    for (key, value) in [(CodingKeys.linesAdded, linesAdded), (.linesDeleted, linesDeleted)] {
      if let value, value < 0 {
        throw contractViolation(c.codingPath + [key], "ujemny licznik linii")
      }
    }
  }
}

/// Zużycie okna kontekstu.
public struct UsageEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var contextTokens: Int
  public var contextLimit: Int

  enum CodingKeys: String, CodingKey { case sessionId, contextTokens, contextLimit }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    contextTokens = try c.required(.contextTokens)
    contextLimit = try c.required(.contextLimit)
  }
}

/// Zmiana dostępności herdr na żywo. `canLaunch` nieobecne = „nie wiem" (zostaw poprzednią).
public struct HerdrStatusEvent: Sendable, Equatable, Codable {
  public var available: Bool
  public var agentCount: Int
  public var readOnly: Bool
  public var canLaunch: Bool?
  public var detail: String?
  /// Kod zdania `detail`.
  public var detailRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case available, agentCount, readOnly, canLaunch, detail, detailRef }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    available = try c.required(.available)
    agentCount = try c.required(.agentCount)
    readOnly = try c.required(.readOnly)
    canLaunch = try c.optional(.canLaunch)
    detail = try c.optional(.detail)
    detailRef = try c.optional(.detailRef)
  }
}

extension HerdrStatusEvent: SentenceBearing {
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    detail = detail.map { render($0, detailRef) }
  }
}

/// Notatki projektu się zmieniły — katalog i bit „pusty", zero treści.
public struct NotesEvent: Sendable, Equatable, Codable {
  public var cwd: String
  public var empty: Bool

  enum CodingKeys: String, CodingKey { case cwd, empty }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    cwd = try c.nonEmpty(.cwd)
    empty = try c.required(.empty)
  }
}
