import Foundation
import RarogContract
import RarogCore

// "Check" next to a subagent that waits long on its own background command: the message to the main agent and what
// the button shows. The message is an instruction for a model, so it is English and fixed, not in the catalog (like
// the `/rename` command of `SessionRename`). It names the subagent, its standby and each own command by its id and
// tools summary (`CommandTools.summary`), never by the command text: the message lies in the outbox on the device's
// disk until its echo, and that disk never holds commands. It does not say how to stop a command. Times are the
// server's (ISO, UTC) and the threshold comes from the stage, so nothing depends on the phone's clock. Text from the
// server goes in on one line and capped, so a description cannot add lines of its own to the message. The store
// sends it once per wait (`RarogStore.checkWait`). Pure functions, tested on macOS. Owner: header.

/// The message of Check for one wait of one subagent.
public struct WaitCheckMessage: Sendable, Equatable {
  /// The wait (`BackgroundTaskRules.waitKey`): the store's guard keeps one message per key.
  public let key: String
  public let text: String

  /// At most this many own commands get a line; the rest is one `… and N more` line.
  static let commandLimit = 5
  /// Caps of the server's text in the message, in characters.
  static let descriptionLimit = 120
  static let idLimit = 64

  /// `nil` below `long`, without a stage and without a key. `agent` is the task id, `description` its description,
  /// `since` its standby (`BackgroundTaskRow.standbySince`), `own` its own command rows.
  init?(
    key: String?, stage: OwnCommandWait?, agent: String, description: String?, since: Date?, own: [OwnTaskRow]
  ) {
    guard let key, let minutes = Self.minutes(stage) else { return nil }
    self.key = key
    let id = Self.identifier(agent)
    let named = description.map { Self.oneLine($0, limit: Self.descriptionLimit) }.flatMap { $0.isEmpty ? nil : $0 }
    let subagent = named.map { "Subagent \"\(Self.quoted($0))\" (\(id))" } ?? "Subagent \(id)"
    let standby = since.map { " since \(Self.iso($0))" } ?? ""
    var lines = [
      "[Rarog check] \(subagent) has been in standby\(standby), waiting on its own background command(s) for over"
        + " \(minutes) min:"
    ]
    lines += own.prefix(Self.commandLimit).map(Self.line)
    if own.count > Self.commandLimit { lines.append("- … and \(own.count - Self.commandLimit) more") }
    lines.append(
      "Check whether each command is still running and making progress. If one hangs, stop it, then collect the"
        + " subagent's report and carry on. Do not start the subagent's work again if it already finished.")
    text = lines.joined(separator: "\n")
  }

  /// "- task b7: pgrep (started 2026-11-26T07:58:00Z)"; without a summary no tools, without a start no parenthesis.
  private static func line(_ own: OwnTaskRow) -> String {
    var line = "- task \(identifier(own.ownId))"
    if let tools = own.rawCommand.flatMap(CommandTools.summary) { line += ": \(oneLine(tools, limit: descriptionLimit))" }
    if let started = own.startedAt { line += " (started \(iso(started)))" }
    return line
  }

  /// The threshold the stage has passed; `short` and no stage do not offer Check.
  private static func minutes(_ stage: OwnCommandWait?) -> Int? {
    switch stage {
    case .long?: 30
    case .stuck?: 60
    case .short?, nil: nil
    }
  }

  /// `2026-11-26T07:58:00Z`: the server's moment in UTC, whole seconds.
  private static func iso(_ date: Date) -> String {
    date.formatted(.iso8601)
  }

  /// A description inside the message's quotes: its own quote or backslash cannot close them and pass for the
  /// message's words.
  static func quoted(_ text: String) -> String {
    text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  }

  /// An id as the message names it: ASCII letters, digits and `-`, `_`, `.`, `:` only, capped; nothing left is `?`.
  static func identifier(_ text: String) -> String {
    let kept = String(text.unicodeScalars.filter { scalar in
      scalar.isASCII && (scalar.properties.isAlphabetic || ("0"..."9").contains(scalar) || "-_.:".unicodeScalars.contains(scalar))
    }.prefix(idLimit).map(Character.init))
    return kept.isEmpty ? "?" : kept
  }

  /// The server's text on one line: line breaks and control characters become spaces, runs of space one space, and
  /// past `limit` characters it ends in "…".
  static func oneLine(_ text: String, limit: Int) -> String {
    let scalars = text.unicodeScalars.map { scalar in
      scalar.properties.generalCategory == .control || CharacterSet.newlines.contains(scalar) ? " " : scalar
    }
    let flat = String(String.UnicodeScalarView(scalars)).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return flat.count > limit ? flat.prefix(limit).trimmingCharacters(in: .whitespaces) + "…" : flat
  }
}

/// What the Check button of one wait shows, from the store's answer (`AppState.waitCheck(_:in:)`).
public struct WaitCheckButtonModel: Sendable, Equatable {
  /// "Check", or "Sent · 21:40" once the server took the message.
  public let title: String
  /// The reader's label: the title, and for a sent message a full sentence with its time.
  public let spoken: String
  /// A tap does something: a new message, or the same entry again after Not confirmed or a refusal with Retry.
  public let enabled: Bool
  /// The message is being written or is in flight.
  public let busy: Bool
  /// The message went: the place shows text, not a button.
  public let sent: Bool

  /// `nil` = no button (the store's gate is closed).
  public init?(_ status: WaitCheckStatus?, timeZone: TimeZone = .current) {
    guard let status else { return nil }
    guard case let .sent(at) = status else {
      title = UICopy.waitCheck
      spoken = UICopy.waitCheck
      busy = status == .sending
      enabled = !busy
      sent = false
      return
    }
    let clock = ServerTime.clock(at, timeZone: timeZone)
    title = UICopy.waitCheckSent(clock)
    spoken = UICopy.waitCheckSentSpoken(clock)
    enabled = false
    busy = false
    sent = true
  }
}
