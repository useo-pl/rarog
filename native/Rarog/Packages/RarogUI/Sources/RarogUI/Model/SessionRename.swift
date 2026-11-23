import Foundation
import Observation
import RarogContract
import RarogCore

// Renaming a session in place on the list row: the field's rules, when the row offers the item, and the pending
// name the row shows until the server's label arrives. The view (`Views/List/SessionRenameField`) only draws.
// Owner: list.

/// Rules of the rename field and of its save. The save sends `/rename <name>` the ordinary way of a message to the
/// session; Claude Code writes the name to its transcript and the server takes it as the card label.
public enum SessionRename {
  /// Longest name the field takes, in UTF-16 units like the server: the server cuts a card label at this length.
  public static let maxLength = 28
  /// Words of a name the card keeps: the server builds the card label from at most this many words.
  public static let maxWords = 5
  /// How long the row shows the new name without the server's label before the old one comes back.
  public static let confirmWithin: Duration = .seconds(10)

  /// Outcome of Return in the field.
  public enum Save: Sendable, Equatable {
    /// Empty, or the name the row already has: nothing goes out.
    case cancel
    case send(name: String)
  }

  /// The row offers the item for a Claude Code session the app can write to, also during a turn (Claude Code renames
  /// at once and does not stop the turn). Codex, an agent in a terminal, a session without a send channel and the
  /// list from the cache get none.
  public static func available(_ session: SessionSummary, state: AppState) -> Bool {
    !state.listStale && session.engine == nil && session.termId == nil && state.sendBlock(for: session.id) == nil
  }

  /// What the field keeps of typed or pasted text: a line break becomes a space and nothing goes past `maxLength`
  /// (a character never splits in half).
  public static func fieldText(_ text: String) -> String {
    fitted(text, room: maxLength)
  }

  /// A keystroke or paste of `replacement` over `range` (UTF-16, as UIKit gives it) of `text`. The text around the
  /// range stays whole; the replacement loses its line breaks and keeps only what fits in the room left, so a full
  /// field refuses a character typed anywhere. Returns the new text and the caret after the inserted part.
  public static func edit(
    _ text: String, replacing range: NSRange, with replacement: String
  ) -> (text: String, caret: Int) {
    let source = text as NSString
    let start = min(max(range.location, 0), source.length)
    let end = min(max(start + range.length, start), source.length)
    let prefix = source.substring(to: start)
    let suffix = source.substring(from: end)
    let room = maxLength - prefix.utf16.count - suffix.utf16.count
    let inserted = fitted(replacement, room: room)
    return (prefix + inserted + suffix, prefix.utf16.count + inserted.utf16.count)
  }

  /// `text` with line breaks as spaces, cut to `room` UTF-16 units at a character boundary.
  private static func fitted(_ text: String, room: Int) -> String {
    var units = 0
    var kept = ""
    for character in text {
      let next: Character = character.isNewline ? " " : character
      let size = String(next).utf16.count
      guard units + size <= room else { break }
      units += size
      kept.append(next)
    }
    return kept
  }

  /// Return: the name with whitespace folded to single spaces. Empty or equal to `current` (the name the field
  /// started with) cancels.
  public static func save(_ draft: String, current: String) -> Save {
    let name = folded(fieldText(draft))
    guard !name.isEmpty, name != folded(current) else { return .cancel }
    return .send(name: name)
  }

  /// The message the save sends.
  public static func command(_ name: String) -> String { "/rename \(name)" }

  /// The hint under the field: Return and Esc with a hardware keyboard; without one the on-screen keyboard's check
  /// mark saves and a tap beside the field cancels, because touch has no Esc.
  public static func hint(hardwareKeyboard: Bool) -> String {
    hardwareKeyboard ? UICopy.renameHint : UICopy.renameHintTouch
  }

  /// The label the card gets from `name` (≤ `maxLength`): whitespace folded, at most `maxWords` words.
  public static func cardLabel(_ name: String) -> String {
    folded(name).split(separator: " ").prefix(maxWords).joined(separator: " ")
  }

  static func folded(_ text: String) -> String {
    text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
}

/// Which row is a field and which renamed rows wait for the server's label. One per list.
@MainActor
@Observable
public final class SessionRenamer {
  /// The session whose row is a field; `nil` — none.
  public private(set) var editing: String?
  /// The name the field started with: Return compares the draft with it, whatever the row shows meanwhile.
  public private(set) var editingName = ""
  /// Counts the openings of a field. The list may hand the next field of a row the text field view of the previous
  /// one; the view starts over when this number changes.
  public private(set) var edit = 0
  /// Names the rows show until the server's label arrives or the window ends.
  private var pending: [String: Pending] = [:]
  /// The latest save of each session: a save that a later one replaced ends without a word.
  @ObservationIgnored private var latest: [String: UUID] = [:]
  /// The confirmation window (`SessionRename.confirmWithin`); tests pass their own.
  @ObservationIgnored private let wait: @Sendable (Duration) async -> Void

  private struct Pending {
    let token: UUID
    /// The card label the new name gets, folded.
    let label: String
    /// The session's label as last seen, folded; at Return the label the row had. The list hands over the label it
    /// already has when the row starts to wait, so only a change from this one confirms.
    var seen: String
    let window: Task<Void, Never>
  }

  public init(wait: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
    self.wait = wait
  }

  /// The row of `sessionId` becomes a field starting with `name`, the name the row shows (the context menu item or
  /// a double click with a pointer).
  public func begin(_ sessionId: String, name: String) {
    editing = sessionId
    editingName = name
    edit += 1
  }

  /// Esc, Cancel, losing focus, a tap elsewhere, another screen or the background: the field goes, nothing is sent.
  public func cancel(_ sessionId: String) {
    if editing == sessionId { editing = nil }
  }

  /// The name the row shows instead of the session's label; `nil` — the label.
  public func pendingName(_ sessionId: String) -> String? {
    pending[sessionId]?.label
  }

  /// The labels of the rows that wait for the server, by session: the list watches them and hands each change to
  /// `labelChanged`.
  public func awaitedLabels(in state: AppState) -> [String: String] {
    var labels: [String: String] = [:]
    for id in pending.keys { labels[id] = state.sessions[id]?.label ?? "" }
    return labels
  }

  /// The session's label changed. The new name arriving ends the wait at once: the row shows the label from now on,
  /// so a later rename from the terminal shows too, and no sentence follows. Another label, or the label the row had
  /// at Return handed over again, leaves the wait running.
  public func labelChanged(_ sessionId: String, to label: String?) {
    guard var waiting = pending[sessionId] else { return }
    let now = SessionRename.folded(label ?? "")
    guard now != waiting.seen else { return }
    guard now == waiting.label else {
      waiting.seen = now
      pending[sessionId] = waiting
      return
    }
    waiting.window.cancel()
    pending[sessionId] = nil
  }

  /// Return in the field of `sessionId`. A name to send goes out as `/rename <name>` and the row shows it at once.
  /// A refused send brings the old name back at once; otherwise the row waits for the server's label until
  /// `SessionRename.confirmWithin` after Return, however long the send takes, and without it the old name comes back
  /// too. Both post a sentence; a refusal that comes back after the window posts its own as well. A later rename of
  /// the same row replaces this one, which then ends without a word.
  public func save(
    _ draft: String, sessionId: String,
    send: (String) async -> SendOutcome,
    label: @escaping @MainActor () -> String?, notice: @escaping @MainActor (String) -> Void
  ) async {
    guard editing == sessionId else { return }
    let current = editingName
    cancel(sessionId)
    guard case let .send(name) = SessionRename.save(draft, current: current) else { return }
    let token = UUID()
    let wait = self.wait
    let window = Task { [weak self] in
      await wait(SessionRename.confirmWithin)
      guard !Task.isCancelled else { return }
      self?.windowEnded(sessionId, token: token, label: label, notice: notice)
    }
    pending[sessionId]?.window.cancel()
    latest[sessionId] = token
    pending[sessionId] = Pending(
      token: token, label: SessionRename.cardLabel(name), seen: SessionRename.folded(label() ?? ""), window: window)
    let outcome = await send(SessionRename.command(name))
    guard latest[sessionId] == token else { return }
    switch outcome {
    case .accepted, .unconfirmed:
      await window.value
    case let .refused(_, _, message):
      refused(sessionId, token: token)
      notice(UICopy.renameRefused(message))
    case .blocked, .notPersisted, .empty, .ignored:
      refused(sessionId, token: token)
      notice(UICopy.renameRefused(nil))
    }
  }

  /// The window of the save `token` ended: without the server's label the old name comes back with a sentence.
  private func windowEnded(
    _ sessionId: String, token: UUID, label: @MainActor () -> String?, notice: @MainActor (String) -> Void
  ) {
    guard let waiting = pending[sessionId], waiting.token == token else { return }
    pending[sessionId] = nil
    if SessionRename.folded(label() ?? "") != waiting.label { notice(UICopy.renameTimedOut) }
  }

  /// The send of the save `token` was refused: its name, if the row still shows it, goes at once.
  private func refused(_ sessionId: String, token: UUID) {
    guard let waiting = pending[sessionId], waiting.token == token else { return }
    waiting.window.cancel()
    pending[sessionId] = nil
  }
}
