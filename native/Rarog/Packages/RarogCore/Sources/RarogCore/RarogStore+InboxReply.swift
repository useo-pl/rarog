import Foundation
import RarogContract

// The reply from an Inbox card: an ordinary send of the person, as from the session screen (no sender pair), to the
// card's session, also one never opened. Before anything goes out the card must still stand with the turn the person
// answered (`InboxHead.takesReply(of:)`, the visible cards of `inboxItems`): a session that started working, changed
// its conversation, stopped on a dialog or moved into a Rarog terminal in between gets nothing. The entry follows the
// send's deadlines, which wait while the session's stream can open and is not open (`AppState.waitsForOpenStream`).
// Owner: Inbox; the send belongs to the send area.

/// How a reply from an Inbox card ended.
public enum InboxReplyOutcome: Sendable, Equatable {
  /// The card no longer stands with the turn the person answered (gone, another turn, a decision): nothing went out.
  case cardChanged
  /// The ordinary send's outcome (``RarogStore/send(text:attachments:to:)``).
  case sent(SendOutcome)
}

extension RarogStore {
  /// Sends `text` to the session of a visible result card whose turn is `turnId`. The check and the hold run before
  /// the first `await`, so the card the person answered stays in place while the session starts working on it.
  public func replyFromInbox(_ text: String, to sessionId: String, turnId: String) async -> InboxReplyOutcome {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .sent(.empty) }
    guard state.inboxReplyTarget(sessionId)?.turnId == turnId else { return .cardChanged }
    // A refusal the send would give anyway (a dialog that came before the card did) does not hold the card.
    if let block = state.sendBlock(for: sessionId) { return .sent(.blocked(block)) }
    holdInboxCard(sessionId)
    return .sent(await send(text: text, to: sessionId))
  }
}
