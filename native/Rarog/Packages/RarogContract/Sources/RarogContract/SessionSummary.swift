// Podsumowanie sesji (`SessionSummary`) i jego bloki — lustro `sessionSummarySchema` z
// `shared/src/protocol.ts`. Pola opcjonalne: brak = `nil`, `null` odrzuca ramkę. Liczby, które
// serwer liczy jako całkowite (licznik, `seq`, tokeny), są `Int`; ułamek odrzuca ramkę
// (świadome odstępstwo od `z.number()` — opis w `native/Rarog/README.md`).

/// Jedna sesja na liście (`sessions-snapshot`) albo jej zmiana (`session-changed`).
public struct SessionSummary: Sendable, Equatable, Codable, SentenceBearing {
  public var id: String
  public var cwd: String
  public var title: String
  public var label: String?
  public var state: SessionState
  public var stateDetail: String?
  /// Kod zdania `stateDetail` (przy limicie planu `stateDetail` to token `resetAt=<ISO>`, a godzina jedzie
  /// w argumencie) i etykiety o treści `session N` (`label`, także z promptu o tej treści); brak = tekst bez kodu
  /// zdania (agent, inny prompt, starszy serwer).
  public var stateDetailRef: SentenceRef?
  public var labelRef: SentenceRef?
  public var stateSince: String
  /// Start of the current turn (ISO), kept through permission and question inside the turn; `nil` = no turn or its
  /// start unknown (an older server too): the turn clock counts from `stateSince`.
  public var turnSince: String?
  public var createdAt: String
  public var lastActivityAt: String
  public var branch: String?
  public var dirtyCount: Int?
  public var ahead: Int?
  public var behind: Int?
  public var fileKinds: GitFileKinds?
  public var lastCommit: GitCommit?
  public var usage: SessionUsage?
  public var context: ContextLimitState?
  public var lastSummary: String?
  public var model: String?
  public var effort: EffortLevel?
  /// Ultracode tej sesji CLI, osobno od poziomu effortu: żądane do pierwszego dowodu, potem znaczniki
  /// z pliku rozmowy. `nil` = serwer nie wie (ustawienia Claude Code mogą je włączyć bez jego wiedzy).
  public var ultracode: Bool?
  public var launchedByRarog: Bool?
  public var paneId: String?
  public var seen: Bool?
  /// The human marked the result of the current turn unread by hand; the server sends it only while `seen`
  /// is not `true`. The list dot of such a result stands still.
  public var markedUnseen: Bool?
  /// The voice agent picked up the result, not a human; the server sends it only with `seen: true`, until a human
  /// opens the result.
  public var seenBy: SeenBy?
  public var stale: Bool?
  public var herdrMode: HerdrMode?
  public var herdrDialog: KnownDialogID?
  public var herdrDialogReason: RefuseReason?
  public var herdrDialogScreen: String?
  /// Klasa dialogu z rejestru CLI — tylko przy karcie bez decyzji.
  public var cliDialog: CliDialogClass?
  public var outOfScope: Bool?
  public var engine: Engine?
  public var termId: String?
  public var activity: Activity?
  public var backgroundTasks: [BackgroundTask]?
  /// Artefakty opublikowane w bieżącej rozmowie, najnowsza publikacja pierwsza. Brak = brak artefaktów
  /// albo brak odczytu; pusta lista nie jedzie na drut.
  public var artifacts: [SessionArtifact]?
  /// Pull requesty utworzone w bieżącej rozmowie, najnowszy pierwszy. Brak = brak PR-ów albo brak odczytu;
  /// pusta lista nie jedzie na drut.
  public var pullRequests: [SessionPullRequest]?
  /// Scheduled tasks (crons) the session has armed now, newest `createdAt` first. Absent = none or no read; an empty
  /// list does not travel.
  public var scheduledTasks: [SessionScheduledTask]?
  public var waitingFor: WaitingFor?
  public var cliUpdate: CliUpdate?
  /// Przycisk „Uruchom ponownie i wyślij” działa pod notką blokady o tym `seq`; ciało restartu odsyła `seq`
  /// i `id`. Pole ulotne serwera.
  public var promptBlocked: SessionPromptBlocked?

  enum CodingKeys: String, CodingKey {
    case id, cwd, title, label, state, stateDetail, stateSince, turnSince, createdAt, lastActivityAt
    case branch, dirtyCount, ahead, behind, fileKinds, lastCommit, usage, context, lastSummary
    case model, effort, ultracode, launchedByRarog, paneId, seen, markedUnseen, seenBy, stale, herdrMode, herdrDialog
    case herdrDialogReason, herdrDialogScreen, cliDialog, outOfScope, engine, termId, activity
    case backgroundTasks, artifacts, pullRequests, waitingFor, cliUpdate, promptBlocked, stateDetailRef, labelRef
    case scheduledTasks
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.required(.id)
    cwd = try c.required(.cwd)
    title = try c.required(.title)
    label = try c.optional(.label)
    state = try c.lenient(.state, degrade: .state)
    stateDetail = try c.optional(.stateDetail)
    stateSince = try c.required(.stateSince)
    turnSince = try c.optional(.turnSince)
    createdAt = try c.required(.createdAt)
    lastActivityAt = try c.required(.lastActivityAt)
    branch = try c.optional(.branch)
    dirtyCount = try c.optional(.dirtyCount)
    ahead = try c.optional(.ahead)
    behind = try c.optional(.behind)
    fileKinds = try c.optional(.fileKinds)
    lastCommit = try c.optional(.lastCommit)
    usage = try c.optional(.usage)
    context = try c.tolerantOptional(.context)
    lastSummary = try c.optional(.lastSummary)
    model = try c.optional(.model)
    effort = try c.lenientOptional(.effort, degrade: .effort)
    ultracode = try c.optional(.ultracode)
    launchedByRarog = try c.optional(.launchedByRarog)
    paneId = try c.optional(.paneId)
    seen = try c.optional(.seen)
    markedUnseen = try c.optional(.markedUnseen)
    // The contract allows only `true` or no field (`z.literal(true)`), like `placeholder` of an image block.
    guard markedUnseen != false else {
      throw contractViolation(c.codingPath + [CodingKeys.markedUnseen], "markedUnseen other than true")
    }
    seenBy = try c.lenientOptional(.seenBy, degrade: .seenBy)
    stale = try c.optional(.stale)
    herdrMode = try c.lenientOptional(.herdrMode, degrade: .herdrMode)
    herdrDialog = try c.lenientOptional(.herdrDialog, degrade: .herdrDialog)
    herdrDialogReason = try c.lenientOptional(.herdrDialogReason, degrade: .herdrDialogReason)
    herdrDialogScreen = try c.optional(.herdrDialogScreen)
    cliDialog = try c.lenientOptional(.cliDialog, degrade: .cliDialog)
    outOfScope = try c.optional(.outOfScope)
    engine = try c.lenientOptional(.engine, degrade: .engine)
    termId = try c.optional(.termId)
    activity = try c.tolerantOptional(.activity)
    backgroundTasks = try c.optional(.backgroundTasks)
    artifacts = try c.optional(.artifacts)
    pullRequests = try c.optional(.pullRequests)
    scheduledTasks = try c.optional(.scheduledTasks)
    waitingFor = try c.tolerantOptional(.waitingFor)
    cliUpdate = try c.optional(.cliUpdate)
    promptBlocked = try c.optional(.promptBlocked)
    stateDetailRef = try c.optional(.stateDetailRef)
    labelRef = try c.optional(.labelRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    label = label.map { render($0, labelRef) }
    stateDetail = stateDetail.map { render($0, stateDetailRef) }
  }
}

/// Stan integracji herdr w ramce startowej (`sessions-snapshot.herdrStatus`). `detailRef` = kod zdania `detail`.
public struct HerdrStatus: Sendable, Equatable, Codable, SentenceBearing {
  public var available: Bool
  public var agentCount: Int
  public var readOnly: Bool
  public var canLaunch: Bool
  public var version: String?
  public var `protocol`: Int?
  public var detail: String?
  public var detailRef: SentenceRef?

  enum CodingKeys: String, CodingKey {
    case available, agentCount, readOnly, canLaunch, version, `protocol`, detail, detailRef
  }

  public init(
    available: Bool, agentCount: Int, readOnly: Bool, canLaunch: Bool,
    version: String? = nil, protocol: Int? = nil, detail: String? = nil, detailRef: SentenceRef? = nil
  ) {
    self.available = available
    self.agentCount = agentCount
    self.readOnly = readOnly
    self.canLaunch = canLaunch
    self.version = version
    self.protocol = `protocol`
    self.detail = detail
    self.detailRef = detailRef
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    available = try c.required(.available)
    agentCount = try c.required(.agentCount)
    readOnly = try c.required(.readOnly)
    canLaunch = try c.required(.canLaunch)
    version = try c.optional(.version)
    `protocol` = try c.optional(.protocol)
    detail = try c.optional(.detail)
    detailRef = try c.optional(.detailRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    detail = detail.map { render($0, detailRef) }
  }
}

/// Brudne pliki po rodzajach (`+3 ~5 −1`).
public struct GitFileKinds: Sendable, Equatable, Codable {
  public var added: Int
  public var modified: Int
  public var deleted: Int

  enum CodingKeys: String, CodingKey { case added, modified, deleted }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    added = try c.required(.added)
    modified = try c.required(.modified)
    deleted = try c.required(.deleted)
  }
}

/// Ostatni commit gałęzi (`git log -1`).
public struct GitCommit: Sendable, Equatable, Codable {
  public var hash: String
  public var subject: String
  public var at: String

  enum CodingKeys: String, CodingKey { case hash, subject, at }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    hash = try c.required(.hash)
    subject = try c.required(.subject)
    at = try c.required(.at)
  }
}

/// Zużycie okna kontekstu tury.
public struct SessionUsage: Sendable, Equatable, Codable {
  public var contextTokens: Int
  public var contextLimit: Int

  enum CodingKeys: String, CodingKey { case contextTokens, contextLimit }

  public init(contextTokens: Int, contextLimit: Int) {
    self.contextTokens = contextTokens
    self.contextLimit = contextLimit
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    contextTokens = try c.required(.contextTokens)
    contextLimit = try c.required(.contextLimit)
  }
}

/// Okno kontekstu ZNANE albo NIEZNANE — trzeciej możliwości nie ma.
public enum ContextLimitState: Sendable, Equatable, Codable, TolerantDecodable {
  case unknown(tokens: Int, atLeast: Int?)
  case known(tokens: Int, limit: Int, source: ContextSource)

  enum CodingKeys: String, CodingKey { case kind, tokens, atLeast, limit, source }

  private enum Kind: String, ContractEnum { case unknown, known }

  /// Nieznany `kind` → obiekt znika (degradacja `context.kind`).
  static func decodeTolerant(from decoder: any Decoder) throws -> ContextLimitState? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.kind)
    guard Kind.wire(raw) != nil else {
      c.degrade(.kind, raw: raw)
      return nil
    }
    return try ContextLimitState(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let kind: Kind = try c.strict(.kind)
    switch kind {
    case .unknown:
      self = .unknown(tokens: try c.required(.tokens), atLeast: try c.optional(.atLeast))
    case .known:
      self = .known(
        tokens: try c.required(.tokens),
        limit: try c.required(.limit),
        source: try c.lenient(.source, degrade: .contextSource)
      )
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .unknown(tokens, atLeast):
      try c.encode(Kind.unknown, forKey: .kind)
      try c.encode(tokens, forKey: .tokens)
      try c.encodeIfPresent(atLeast, forKey: .atLeast)
    case let .known(tokens, limit, source):
      try c.encode(Kind.known, forKey: .kind)
      try c.encode(tokens, forKey: .tokens)
      try c.encode(limit, forKey: .limit)
      try c.encode(source, forKey: .source)
    }
  }
}

/// Ostatnia znana aktywność agenta (pole ulotne podsumowania i ramka `activity`).
public struct Activity: Sendable, Equatable, Codable, TolerantDecodable {
  public var kind: ActivityKind
  public var toolName: String?
  public var summary: String?
  /// The tool's own words about the call (`description` of its input); only on `tool` of `Bash`.
  public var description: String?
  public var elapsedSeconds: Int?
  public var agents: Int?
  public var agentsDone: Int?
  public var workflow: String?
  public var phases: [ActivityPhase]?
  public var delegation: Delegation?

  enum CodingKeys: String, CodingKey {
    case kind, toolName, summary, description, elapsedSeconds, agents, agentsDone, workflow, phases, delegation
  }

  /// W podsumowaniu i w `transcript-snapshot`: nieznany `kind` → aktywność znika.
  static func decodeTolerant(from decoder: any Decoder) throws -> Activity? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.kind)
    guard ActivityKind.wire(raw) != nil else {
      c.degrade(.kind, raw: raw)
      return nil
    }
    return try Activity(from: decoder)
  }

  /// Ścisły `kind` (ulotna ramka `activity` nie ma czego pokazać zamiast siebie).
  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    kind = try c.strict(.kind)
    toolName = try c.optional(.toolName)
    summary = try c.optional(.summary)
    description = try c.optional(.description)
    elapsedSeconds = try c.optional(.elapsedSeconds)
    agents = try c.optional(.agents)
    agentsDone = try c.optional(.agentsDone)
    workflow = try c.optional(.workflow)
    phases = try c.optional(.phases)
    delegation = try c.lenientOptional(.delegation, degrade: .activityDelegation)
  }
}

/// Faza przebiegu workflow.
public struct ActivityPhase: Sendable, Equatable, Codable {
  public var title: String
  public var agents: Int
  public var done: Int

  enum CodingKeys: String, CodingKey { case title, agents, done }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    title = try c.required(.title)
    agents = try c.required(.agents)
    done = try c.required(.done)
    guard agents >= 0, done >= 0 else {
      throw contractViolation(c.codingPath, "liczba agentów fazy ujemna")
    }
  }
}

/// Na co czeka sesja stojąca na decyzji (linia „na co czeka").
public struct WaitingFor: Sendable, Equatable, Codable, TolerantDecodable {
  public var kind: WaitingKind
  public var tool: String?
  public var text: String?
  public var count: Int?
  public var subject: DecisionSubject?

  enum CodingKeys: String, CodingKey { case kind, tool, text, count, subject }

  static func decodeTolerant(from decoder: any Decoder) throws -> WaitingFor? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.kind)
    guard WaitingKind.wire(raw) != nil else {
      c.degrade(.kind, raw: raw)
      return nil
    }
    return try WaitingFor(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    kind = try c.strict(.kind)
    tool = try c.optional(.tool)
    text = try c.optional(.text)
    count = try c.optional(.count)
    subject = try c.lenientOptional(.subject, degrade: .waitingForSubject)
    if let count, count <= 0 {
      throw contractViolation(c.codingPath + [CodingKeys.count], "licznik musi być dodatni")
    }
  }
}

/// Żywe zadanie w tle widziane w transkrypcie.
public struct BackgroundTask: Sendable, Equatable, Codable {
  public var id: String
  public var kind: BackgroundTaskKind
  public var description: String?
  public var command: String?
  public var agentType: String?
  public var model: String?
  public var summary: String?
  public var startedAt: String?
  public var runId: String?
  public var run: WorkflowRun?
  /// Od kiedy subagent stoi i czeka na własne zadanie w tle (ISO). Obecne = skończył turę, ale jego własna
  /// komenda jeszcze leci: nie pracuje i nie skończył. Brak = pracuje. Tylko rodzaj `agent`.
  public var waitingSince: String?
  /// Otwarte własne komendy subagenta w tle (puścił je on, nie główny agent). Tylko rodzaj `agent`.
  public var ownTasks: [AgentOwnTask]?
  /// How long the subagent has waited on its own command, by the server clock. Present only with `waitingSince` and
  /// a non-empty `ownTasks`; the app reads the stage from here and never derives it.
  public var ownCommandWait: OwnCommandWait?

  enum CodingKeys: String, CodingKey {
    case id, kind, description, command, agentType, model, summary, startedAt, runId, run
    case waitingSince, ownTasks, ownCommandWait
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.nonEmpty(.id)
    kind = try c.lenient(.kind, degrade: .backgroundTasksKind)
    description = try c.optional(.description)
    command = try c.optional(.command)
    agentType = try c.optional(.agentType)
    model = try c.optional(.model)
    summary = try c.optional(.summary)
    startedAt = try c.optional(.startedAt)
    runId = try c.optional(.runId)
    run = try c.optional(.run)
    waitingSince = try c.optional(.waitingSince)
    ownTasks = try c.optional(.ownTasks)
    ownCommandWait = try c.lenientOptional(.ownCommandWait, degrade: .backgroundTasksOwnCommandWait)
  }
}

/// Jedna otwarta komenda, którą subagent sam puścił w tle (`BackgroundTask.ownTasks`): na nią czeka agent
/// z `waitingSince`. Brak `command` albo `startedAt` = serwer ich nie zna; apka niczego nie dopowiada.
public struct AgentOwnTask: Sendable, Equatable, Codable {
  public var id: String
  public var command: String?
  public var startedAt: String?

  enum CodingKeys: String, CodingKey { case id, command, startedAt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.nonEmpty(.id)
    command = try c.optional(.command)
    startedAt = try c.optional(.startedAt)
  }
}

/// Artefakt (strona na claude.ai) opublikowany w bieżącej rozmowie sesji. Adres to na drucie zawsze
/// `https://claude.ai/artifact/<id>`, ale apka i tak sprawdza go przed otwarciem (gramatyka w RarogUI);
/// dekoder sprawdza tylko typy, żeby jeden zły adres nie zabrał całej listy sesji.
public struct SessionArtifact: Sendable, Equatable, Codable {
  public var url: String
  /// Tytuł z ostatniej publikacji (czysty, przycięty na serwerze).
  public var title: String
  /// Chwila ostatniej publikacji (ISO).
  public var publishedAt: String
  /// Artefakt usunięty na claude.ai. Na drucie literał `true` albo brak pola — `false` odrzuca ramkę.
  public var gone: Bool

  enum CodingKeys: String, CodingKey { case url, title, publishedAt, gone }

  public init(url: String, title: String, publishedAt: String, gone: Bool = false) {
    self.url = url
    self.title = title
    self.publishedAt = publishedAt
    self.gone = gone
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    url = try c.required(.url)
    title = try c.required(.title)
    publishedAt = try c.required(.publishedAt)
    let flag: Bool? = try c.optional(.gone)
    if flag == false {
      throw contractViolation(c.codingPath + [CodingKeys.gone], "gone jest literałem true")
    }
    gone = flag == true
  }

  /// Lustro drutu: `gone` tylko jako `true`, żywy artefakt bez pola.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(url, forKey: .url)
    try c.encode(title, forKey: .title)
    try c.encode(publishedAt, forKey: .publishedAt)
    if gone { try c.encode(true, forKey: .gone) }
  }
}

/// Pull request bieżącej rozmowy sesji: Claude Code powiązał go wpisem `pr-link`, autorem jest login `gh`,
/// a powstał po pierwszym wpisie rozmowy. Adres to na drucie zawsze `https://github.com/<owner>/<repo>/pull/<numer>`;
/// apka sprawdza go przed otwarciem sama, a dekoder sprawdza tylko typy, żeby jeden zły adres nie zabrał całej
/// listy sesji.
public struct SessionPullRequest: Sendable, Equatable, Codable {
  public var url: String
  /// `<owner>/<repo>` z adresu.
  public var repo: String
  public var number: Int
  /// Chwila pierwszego wpisu `pr-link` tego PR-a (ISO).
  public var createdAt: String
  /// Tytuł z GitHuba (czysty, przycięty na serwerze); brak = GitHub go (jeszcze) nie podał.
  public var title: String?
  /// PR state on GitHub; `nil` = unknown (not read, switched off, or a state this app does not know).
  public var state: PullRequestState?

  enum CodingKeys: String, CodingKey { case url, repo, number, createdAt, title, state }

  public init(
    url: String, repo: String, number: Int, createdAt: String, title: String? = nil, state: PullRequestState? = nil
  ) {
    self.url = url
    self.repo = repo
    self.number = number
    self.createdAt = createdAt
    self.title = title
    self.state = state
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    url = try c.required(.url)
    repo = try c.required(.repo)
    number = try c.required(.number)
    createdAt = try c.required(.createdAt)
    title = try c.optional(.title)
    state = try c.lenientOptional(.state, degrade: .pullRequestsState)
  }
}

/// Rozkład przebiegu workflow: fazy ze skryptu i agenci z journala.
public struct WorkflowRun: Sendable, Equatable, Codable {
  public var phases: [String]
  public var agents: [WorkflowAgent]

  enum CodingKeys: String, CodingKey { case phases, agents }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    phases = try c.required(.phases)
    agents = try c.required(.agents)
  }
}

/// Jeden agent przebiegu workflow.
public struct WorkflowAgent: Sendable, Equatable, Codable {
  public var id: String
  public var phase: String?
  public var label: String?
  public var done: Bool
  public var startedAt: String?

  enum CodingKeys: String, CodingKey { case id, phase, label, done, startedAt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.nonEmpty(.id)
    phase = try c.optional(.phase)
    label = try c.optional(.label)
    done = try c.required(.done)
    startedAt = try c.optional(.startedAt)
  }
}

/// Proces sesji na starszym wydaniu Claude Code niż zainstalowane.
public struct CliUpdate: Sendable, Equatable, Codable {
  public var running: String
  public var installed: String

  enum CodingKeys: String, CodingKey { case running, installed }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    running = try c.required(.running)
    installed = try c.required(.installed)
  }
}

/// Notka blokady promptu (hook `UserPromptSubmit`), której przycisk ponownej wysyłki działa: `seq`
/// wiadomości z polem `TranscriptMessage.promptBlocked` i `id` tej blokady. Ciało restartu niesie oba pola,
/// bo `seq` powtarza się po restarcie sesji. Tekst do wysłania trzyma serwer.
public struct SessionPromptBlocked: Sendable, Equatable, Codable {
  public var seq: Int
  public var id: String

  enum CodingKeys: String, CodingKey { case seq, id }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    seq = try c.required(.seq)
    id = try c.required(.id)
  }
}
