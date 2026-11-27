// Copy of the old `BackgroundTask` decoder (`SessionSummary.swift`), from before the wait stage field
// (`ownCommandWait`). Copy rules and shared types: `LegacyContract.swift`.
@testable import RarogContract

extension OldApp {
  /// A background task as the old app decodes it. The field `ownCommandWait` is unknown to it.
  struct BackgroundTask: Sendable, Equatable, Decodable {
    var id: String
    var kind: BackgroundTaskKind
    var description: String?
    var command: String?
    var agentType: String?
    var model: String?
    var summary: String?
    var startedAt: String?
    var runId: String?
    var run: WorkflowRun?
    var waitingSince: String?
    var ownTasks: [AgentOwnTask]?

    enum CodingKeys: String, CodingKey {
      case id, kind, description, command, agentType, model, summary, startedAt, runId, run
      case waitingSince, ownTasks
    }

    init(from decoder: any Decoder) throws {
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
    }
  }
}
