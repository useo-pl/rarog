import Foundation
import RarogContract
import RarogCore

// The session list of the voice conversation across sessions: one row per session of the voice agent's catalog that
// the app knows, with a handle the app gives for the conversation. Owner: voice agent. The host
// (`VoiceAgentSessionsHost`) puts the list into the instructions and into the `list_sessions` result.
//
// What a row carries is all the model learns of a session before it reads it: the handle, the project, the name, the
// state from the same selectors as the list dot, minutes since the state change, `asks_owner` from the catalog and, at
// a standing dialog, its kind and first line. The server's session id never goes into a row's text. Names, the
// project and the dialog line pass the secret mask, and a data block tag written into them is neutralized.

/// The state of a list row, read from the dot of the session list (`SessionSummary.statusTone`,
/// `AppState.freshResult`).
enum VoiceAgentListState: String, Sendable, CaseIterable {
  /// A result nobody has taken: the dot pulses (or would, on a frozen row).
  case finished
  /// A result the human marked unread by hand: the dot stands still.
  case markedUnread = "marked-unread"
  case seen
  /// The voice agent picked the result up, not a human (`seenBy`).
  case seenByVoice = "seen-by-voice"
  case working
  /// The turn is over, but a background task works (the dot has the working tone).
  case workingBackground = "working-background"
  /// A permission or a question waits.
  case dialog
  case failed
  /// Anything else: done, resumable, interrupted, unsupported.
  case other

  static func of(_ session: SessionSummary, in state: AppState) -> Self {
    switch session.statusTone {
    case .working:
      return session.state == .running || session.state == .starting ? .working : .workingBackground
    case .waiting:
      return session.state == .waitingPermission || session.state == .waitingQuestion ? .dialog : .other
    case .failed:
      return .failed
    case .unread:
      if state.freshResult(session) { return .finished }
      // A still blue dot: marked unread by hand, or a frozen row (stale data) whose result nobody has taken.
      let marked = session.markedUnseen == true || state.turnControl.manualUnread.contains(session.id)
      return marked ? .markedUnread : .finished
    case .quiet, .backgroundWait, .backgroundWaitLong:
      guard session.state == .waitingInput, session.resultSeen else { return .other }
      return session.seenBy == .voiceAgent ? .seenByVoice : .seen
    }
  }
}

/// One row of the session list. `sessionId` and `since` stay in the app; the rest is what the model gets.
struct VoiceAgentSessionRow: Sendable, Equatable {
  struct Dialog: Sendable, Equatable {
    /// `permission`, `plan`, `question`, or `dialog` when the server names no card.
    let kind: String
    /// The first line of what the dialog asks; `nil` = unknown.
    let line: String?
  }

  let sessionId: String
  let handle: String
  let project: String
  let name: String
  let state: VoiceAgentListState
  let minutes: Int
  let asksOwner: Bool
  let dialog: Dialog?
  /// The session's `stateSince`: "newest first" of the read filters.
  let since: Date?

  /// The row as JSON, keys in a fixed order.
  var json: String {
    var fields = [
      ("handle", VoiceAgentSessionsText.json(handle)), ("project", VoiceAgentSessionsText.json(project)),
      ("name", VoiceAgentSessionsText.json(name)), ("state", VoiceAgentSessionsText.json(state.rawValue)),
      ("minutes", String(minutes)), ("asks_owner", asksOwner ? "true" : "false"),
    ]
    if let dialog {
      let line = dialog.line.map(VoiceAgentSessionsText.json) ?? "null"
      fields.append(("dialog", #"{"kind":\#(VoiceAgentSessionsText.json(dialog.kind)),"line":\#(line)}"#))
    }
    return "{" + fields.map { #""\#($0.0)":\#($0.1)"# }.joined(separator: ",") + "}"
  }
}

/// Handles of one conversation: `s1`, `s2`… in the order the sessions first appear, never reused.
struct VoiceAgentHandles: Sendable, Equatable {
  private var bySession: [String: Int] = [:]
  private var next = 1

  mutating func handle(for sessionId: String) -> String {
    if let number = bySession[sessionId] { return "s\(number)" }
    bySession[sessionId] = next
    next += 1
    return "s\(next - 1)"
  }

  /// The number of a handle, for the order of the list.
  func number(_ sessionId: String) -> Int { bySession[sessionId] ?? Int.max }
}

enum VoiceAgentSessionList {
  /// The rows of the catalog sessions the app knows, in handle order. A catalog row of a session the app does not have
  /// gives no row (nothing to name it by); a session the app has outside the catalog gives none either. New sessions
  /// get the next handles in the order of the session list.
  static func rows(
    catalog: [CompanionSessions.Row], state: AppState, handles: inout VoiceAgentHandles, now: Date
  ) -> [VoiceAgentSessionRow] {
    let catalogById = Dictionary(catalog.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    // `#n` is the app list's rule counted over the sessions that get a row: counted over all the app's sessions, a
    // namesake outside the catalog would give a row `#1` or `#2` and tell the model that session exists.
    var listed = state
    listed.sessions = state.sessions.filter { catalogById[$0.key] != nil }
    let ordinals = listed.duplicateOrdinals
    var rows: [VoiceAgentSessionRow] = []
    for session in state.listOrder {
      guard let entry = catalogById[session.id] else { continue }
      let since = ServerTime.parse(session.stateSince)
      let listState = VoiceAgentListState.of(session, in: state)
      rows.append(
        VoiceAgentSessionRow(
          sessionId: session.id, handle: handles.handle(for: session.id),
          project: VoiceAgentSessionsText.prepare(session.title), name: name(session, ordinal: ordinals[session.id]),
          state: listState, minutes: since.map { max(0, Int((now.timeIntervalSince($0) / 60).rounded())) } ?? 0,
          asksOwner: entry.asksOwner, dialog: listState == .dialog ? dialog(session) : nil, since: since))
    }
    return rows.sorted { handles.number($0.sessionId) < handles.number($1.sessionId) }
  }

  /// The rows as the JSON array of the instructions and of the `list_sessions` result.
  static func text(_ rows: [VoiceAgentSessionRow]) -> String {
    "[" + rows.map(\.json).joined(separator: ",") + "]"
  }

  /// The session's name with `#n` for an identical project and name among the rows. Without a name the row says so:
  /// the list's fallback is a piece of the server's session id, which never goes to the model.
  private static func name(_ session: SessionSummary, ordinal: Int?) -> String {
    let label = (session.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let base = label.isEmpty ? "unnamed" : VoiceAgentSessionsText.prepare(label)
    return ordinal.map { "\(base) #\($0)" } ?? base
  }

  private static func dialog(_ session: SessionSummary) -> VoiceAgentSessionRow.Dialog {
    guard let waiting = session.waitingFor else { return .init(kind: "dialog", line: nil) }
    let kind =
      switch waiting.kind {
      case .question: "question"
      case .permission: waiting.subject == .plan ? "plan" : "permission"
      }
    let first = (waiting.text ?? "").split(whereSeparator: \.isNewline).first
      .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    return .init(kind: kind, line: first.isEmpty ? nil : VoiceAgentSessionsText.prepare(first))
  }
}

/// Text of the mode across sessions on its way to the model.
enum VoiceAgentSessionsText {
  /// The secret mask, then the block tags neutralized: what the character budget counts is what goes out.
  static func prepare(_ text: String) -> String { escape(RealtimeSecretMask.apply(text)) }

  /// Opening or closing a data block written into session content does not open or close a block of the
  /// instructions (`<sessions>` here, `<transcript>` and `<session-update>` at a session).
  static func escape(_ text: String) -> String {
    text.replacing(/<(\/?)(transcript|session-update|sessions)\b/.ignoresCase()) { match in
      "‹\(match.output.1)\(match.output.2)"
    }
  }

  /// A JSON string literal, slashes as they are.
  static func json(_ value: String) -> String {
    let options: JSONSerialization.WritingOptions = [.fragmentsAllowed, .withoutEscapingSlashes]
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: options) else { return "\"\"" }
    return String(decoding: data, as: UTF8.self)
  }
}
