import Foundation
import RarogContract
import RarogCore

// `read_sessions` of the voice conversation across sessions: the arguments, the sessions a filter picks, the text of
// the result and the record of each read. Owner: voice agent. The host (`VoiceAgentSessionsHost`) fetches the turns
// (`GET /api/sessions/<id>/companion/turns`) and keeps the records.
//
// The result is plain text: per session a header with the handle, project, name, state and minutes, a
// note when the read starts inside a turn or has no turns, and the turns in the session projection's form
// (`RealtimeProjector.render`). Every line passes the secret mask before the budget counts it; the budget of one call
// is split evenly between the sessions, and inside a session's share the oldest turns give way to a note
// (`RealtimeProjector.fit`).

/// A filter of `read_sessions`: the app picks the sessions, newest first by the state change.
enum VoiceAgentReadFilter: String, Sendable, CaseIterable {
  case finished
  case asksOwner = "asks_owner"
}

/// The arguments of one `read_sessions` call.
struct VoiceAgentReadRequest: Sendable, Equatable {
  enum Target: Sendable, Equatable {
    case handles([String])
    case filter(VoiceAgentReadFilter)
  }

  /// `nil` = neither handles nor a known filter.
  let target: Target?
  /// Turns per session, 1…3 (default 3).
  let turns: Int

  init(arguments: String) {
    let object =
      (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any] ?? [:]
    var turns = VoiceAgentSessionReads.turnsMax
    if let number = object[VoiceAgentSessionsTool.turnsField] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue == number.doubleValue.rounded()
    {
      turns = min(VoiceAgentSessionReads.turnsMax, max(1, number.intValue))
    }
    self.turns = turns
    var handles: [String] = []
    for handle in (object[VoiceAgentSessionsTool.handlesField] as? [Any] ?? []).compactMap({ $0 as? String })
    where !handles.contains(handle) {
      handles.append(handle)
    }
    if !handles.isEmpty {
      target = .handles(handles)
    } else if let raw = object[VoiceAgentSessionsTool.filterField] as? String,
      let filter = VoiceAgentReadFilter(rawValue: raw)
    {
      target = .filter(filter)
    } else {
      target = nil
    }
  }
}

/// What the host keeps of one session read in the conversation: the turns answer's `conversation` and `readMark` as
/// the server sent them, and whether it had messages (a read without messages names no read, so it gives no pick-up).
/// The newest read of a session replaces the older one.
struct VoiceAgentSessionRead: Sendable, Equatable {
  let sessionId: String
  let handle: String
  let conversation: String
  let readMark: String
  let hadMessages: Bool
}

enum VoiceAgentSessionReads {
  /// Characters of one `read_sessions` result, split evenly between the sessions read.
  static let budget = 15_000
  /// Sessions a filter picks at most.
  static let filterMax = 3
  /// Turns per session at most (the turns route's `count`).
  static let turnsMax = 3

  /// The sessions `filter` picks from the list: newest state change first, at most ``filterMax``.
  static func pick(_ filter: VoiceAgentReadFilter, from rows: [VoiceAgentSessionRow]) -> [VoiceAgentSessionRow] {
    let matching = rows.filter { row in
      switch filter {
      case .finished: row.state == .finished
      case .asksOwner: row.asksOwner
      }
    }
    return Array(matching.sorted { ($0.since ?? .distantPast) > ($1.since ?? .distantPast) }.prefix(filterMax))
  }

  /// The text of a `read_sessions` result: the sessions in the given order, each in its share of ``budget``.
  static func text(_ reads: [(row: VoiceAgentSessionRow, turns: CompanionTurns)], count: Int) -> String {
    guard !reads.isEmpty else { return "" }
    let share = budget / reads.count
    return reads.map { part($0.row, $0.turns, count: count, share: share) }.joined(separator: "\n\n")
  }

  /// One session: the header, a note at an incomplete window or without turns, and the last `count` turns in
  /// `share` characters.
  static func part(_ row: VoiceAgentSessionRow, _ answer: CompanionTurns, count: Int, share: Int) -> String {
    var lines = ["## \(row.handle) · \(row.project) · \(row.name) · \(row.state.rawValue), \(row.minutes) min ago"]
    let turns = RealtimeProjector.render(answer.messages, firstNumber: 1, continuation: nil)
      .map { turn in
        var prepared = turn
        prepared.lines = turn.lines.map(VoiceAgentSessionsText.prepare)
        return prepared
      }
      .suffix(count)
    if turns.isEmpty {
      lines.append("[No turns in this conversation yet.]")
      return lines.joined(separator: "\n")
    }
    if !answer.complete || turns.first?.continued == true {
      lines.append("[Incomplete: the window starts in the middle of a turn; you see only its end.]")
    }
    let room = max(0, share - lines.joined(separator: "\n").count - 1)
    lines.append(RealtimeProjector.fit(Array(turns), budget: room, windowFull: false, note: omittedNote).text)
    return lines.joined(separator: "\n")
  }

  /// The note in place of the oldest turns that do not fit the read's share.
  static func omittedNote(_ first: Int, _ last: Int) -> String {
    "[Omitted: turns \(first)–\(last) (over the size budget of this read). "
      + "Ask \(VoiceAgentSessionsTool.askSession.rawValue) about them.]"
  }
}
