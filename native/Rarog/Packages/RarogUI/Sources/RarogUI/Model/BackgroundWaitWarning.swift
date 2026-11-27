import Foundation
import RarogContract
import RarogCore

// The warning of a subagent that has waited long on its own background command: the stage comes from the server
// (`BackgroundTaskRules.ownCommandWait(of:in:)`, `long` from 30 minutes, `stuck` from an hour); this file only says it.
// In the "in the background" section the warning takes the place of the row's state line ("waiting 47m on: pgrep,
// sleep"), and the background pill gets the warning mark of the strongest wait. Pure functions, tested on macOS.
// Owner: header.

/// The warning line of one subagent row: how long the subagent has stood and on which tools, in the tone of its stage.
public struct BackgroundWaitWarning: Sendable, Equatable {
  /// `.backgroundWaitLong` at `long`, `.waiting` at `stuck`: the session row's tones of the same stages.
  public let tone: StatusTone
  /// The start of the standby (`BackgroundTaskRow.standbySince`); `nil` = the server's time is not a time.
  public let since: Date?
  /// The tools summaries of the subagent's own commands (`CommandTools.summary`), each once, in list order.
  public let tools: String

  /// `nil` below `long` and without a stage. Without own commands to name the tools are the word "command".
  init?(_ stage: OwnCommandWait?, since: Date?, own: [OwnTaskRow]) {
    guard let tone = Self.tone(stage) else { return nil }
    self.tone = tone
    self.since = since
    var seen = Set<String>()
    // Only the tools summary: a command the summary does not recognize is the word "command", never its text.
    let names = own.map { $0.rawCommand.flatMap(CommandTools.summary) ?? UICopy.backgroundKind(.command) }
      .filter { seen.insert($0).inserted }
    tools = names.isEmpty ? UICopy.backgroundKind(.command) : UICopy.list(names, .comma)
  }

  /// The tone of a stage that warns; `short` and no stage do not warn.
  static func tone(_ stage: OwnCommandWait?) -> StatusTone? {
    switch stage {
    case .long?: .backgroundWaitLong
    case .stuck?: .waiting
    case .short?, nil: nil
    }
  }

  /// The SF Symbol before the line: the session row's mark of the same tone, so `long` and `stuck` differ by shape.
  public var mark: String { StateGlyph.mark(tone) ?? "exclamationmark" }

  /// "waiting 47m on: pgrep, sleep"; the counter runs from the standby, like the row's own counter.
  public func text(now: Date) -> String {
    UICopy.waitWarning(since: since.map { RelativeTime.short(since: $0, now: now) }, tools: tools)
  }

  /// "waiting a long time on: pgrep, sleep, for 47 minutes", "stuck on: pgrep, sleep, for 1 hour".
  public func spoken(now: Date) -> String {
    UICopy.waitWarningSpoken(
      stuck: tone == .waiting, tools: tools, since: since.map { RelativeTime.spokenSince(since: $0, now: now) })
  }
}
