// A scheduled task (cron) of a session: a mirror of `sessionScheduledTaskSchema` in
// `shared/src/protocol/background.ts`, the field `SessionSummary.scheduledTasks`. Like the other blocks of the summary:
// a missing optional field is `nil`, `null` or a wrong type rejects the frame.

/// A task the session's Claude Code has armed with `CronCreate` and that is still armed, as the conversation file
/// shows it. Times are ISO strings; the cron pattern is in the Mac's local time, as the session wrote it.
public struct SessionScheduledTask: Sendable, Equatable, Codable {
  /// The job id from `CronCreate`; the decoder checks only the type.
  public var id: String
  /// Five-field cron pattern in the Mac's local time.
  public var cron: String
  /// `false` = runs once, at the next match of the pattern.
  public var recurring: Bool
  /// One line without control characters, trimmed on the server.
  public var prompt: String
  public var createdAt: String?
  /// The next run; `nil` once a later run of a recurring task made it stale.
  public var nextFireAt: String?
  /// The last run of a recurring task.
  public var lastFiredAt: String?
  /// A recurring task with a known `createdAt` expires 7 days after it.
  public var expiresAt: String?

  enum CodingKeys: String, CodingKey { case id, cron, recurring, prompt, createdAt, nextFireAt, lastFiredAt, expiresAt }

  public init(
    id: String, cron: String, recurring: Bool, prompt: String, createdAt: String? = nil, nextFireAt: String? = nil,
    lastFiredAt: String? = nil, expiresAt: String? = nil
  ) {
    self.id = id
    self.cron = cron
    self.recurring = recurring
    self.prompt = prompt
    self.createdAt = createdAt
    self.nextFireAt = nextFireAt
    self.lastFiredAt = lastFiredAt
    self.expiresAt = expiresAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.required(.id)
    cron = try c.required(.cron)
    recurring = try c.required(.recurring)
    prompt = try c.required(.prompt)
    createdAt = try c.optional(.createdAt)
    nextFireAt = try c.optional(.nextFireAt)
    lastFiredAt = try c.optional(.lastFiredAt)
    expiresAt = try c.optional(.expiresAt)
  }
}
