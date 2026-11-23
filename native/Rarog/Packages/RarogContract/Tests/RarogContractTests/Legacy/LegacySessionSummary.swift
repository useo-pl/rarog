// Kopia starego dekodera `SessionSummary` (`SessionSummary.swift`). Zasady kopii i typy wspólne: `LegacyContract.swift`.
@testable import RarogContract

extension OldApp {
  /// Podsumowanie sesji w kształcie starej apki. Pola `stateDetailRef` i `labelRef` są dla niego nieznane.
  struct SessionSummary: Sendable, Equatable, Decodable {
    var id: String
    var cwd: String
    var title: String
    var label: String?
    var state: SessionState
    var stateDetail: String?
    var stateSince: String
    var createdAt: String
    var lastActivityAt: String
    var branch: String?
    var dirtyCount: Int?
    var ahead: Int?
    var behind: Int?
    var fileKinds: GitFileKinds?
    var lastCommit: GitCommit?
    var usage: SessionUsage?
    var context: ContextLimitState?
    var lastSummary: String?
    var model: String?
    var effort: EffortLevel?
    var ultracode: Bool?
    var launchedByRarog: Bool?
    var paneId: String?
    var seen: Bool?
    var stale: Bool?
    var herdrMode: HerdrMode?
    var herdrDialog: KnownDialogID?
    var herdrDialogReason: RefuseReason?
    var herdrDialogScreen: String?
    var cliDialog: CliDialogClass?
    var outOfScope: Bool?
    var engine: Engine?
    var termId: String?
    var activity: Activity?
    var backgroundTasks: [BackgroundTask]?
    var artifacts: [SessionArtifact]?
    var waitingFor: WaitingFor?
    var cliUpdate: CliUpdate?
    var promptBlocked: SessionPromptBlocked?

    enum CodingKeys: String, CodingKey {
      case id, cwd, title, label, state, stateDetail, stateSince, createdAt, lastActivityAt
      case branch, dirtyCount, ahead, behind, fileKinds, lastCommit, usage, context, lastSummary
      case model, effort, ultracode, launchedByRarog, paneId, seen, stale, herdrMode, herdrDialog
      case herdrDialogReason, herdrDialogScreen, cliDialog, outOfScope, engine, termId, activity
      case backgroundTasks, artifacts, waitingFor, cliUpdate, promptBlocked
    }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      id = try c.required(.id)
      cwd = try c.required(.cwd)
      title = try c.required(.title)
      label = try c.optional(.label)
      state = try c.lenient(.state, degrade: .state)
      stateDetail = try c.optional(.stateDetail)
      stateSince = try c.required(.stateSince)
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
      waitingFor = try c.tolerantOptional(.waitingFor)
      cliUpdate = try c.optional(.cliUpdate)
      promptBlocked = try c.optional(.promptBlocked)
    }
  }
}
