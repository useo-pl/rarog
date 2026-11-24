import Foundation
import RarogContract

// Inbox rules: the one place in the app that says when a card shows and what counts on the Inbox button. The server
// decides each card's content (which turn, which kind) and the removals it keeps; the app only decides, from the
// heads and the sessions' live states, which of those cards stand and which carry the number. A new rule of that kind
// (for example, a result card that hides once its session was seen) is a change in this file only. `inboxItems`,
// `inboxCount` and the reducer's holding call these functions and keep only assembly, order and state changes.
// Owner: Inbox.

enum InboxRules {
  /// States in which a card stands. Working states hide it; a background command or a stopped subagent does not.
  static let visibleStates: Set<SessionState> = [
    .waitingInput, .waitingPermission, .waitingQuestion, .error, .limitReached, .interrupted,
  ]

  /// The session works on a turn: its card hides, and a held card keeps what it showed.
  static func works(_ session: SessionSummary) -> Bool {
    session.state == .starting || session.state == .running
  }

  /// The head is current enough to show on a card, held or not: it is in a visible state and its session does not
  /// work. The head is read about half a second after a state change, so at the end of a turn the session is already
  /// `waiting-input` while the head is still the previous turn's; a working session shows no head of its own.
  static func showsHead(_ head: InboxHead, of session: SessionSummary) -> Bool {
    visibleStates.contains(head.state) && !works(session)
  }

  /// A card that is not held stands for this head: the head shows and the session's live state is a visible one too,
  /// so a session out of the waiting states (`done`, `resumable`) hides its card at once while its head still waits.
  static func stands(_ head: InboxHead, of session: SessionSummary) -> Bool {
    showsHead(head, of: session) && visibleStates.contains(session.state)
  }

  /// A held card takes over a new head in a visible state: its new result or decision. The check reads the head's own
  /// state only, not the session's live state.
  static func holdTakesOver(_ head: InboxHead, from hold: InboxHold) -> Bool {
    head != hold.head && visibleStates.contains(head.state)
  }

  /// A removal on this device hides the removed card only (its turn and version): the session's next card shows,
  /// also the next decision or the result of the same turn.
  static func removalHides(_ removal: InboxRemoval?, _ head: InboxHead) -> Bool {
    guard let removal else { return false }
    return removal.hides && removal.isOf(head)
  }

  /// A card takes a reply from its field: its head is a result and its session has a transcript
  /// (``SessionSummary/showsTranscript``, the session screen's rule), whose stream brings the reply's echo. A session in
  /// a Rarog terminal is answered in its terminal, so its card only leads there, as a pane dialog's card does. A
  /// decision card has its decision instead, and a stop leads to its session.
  static func takesReply(_ head: InboxHead, of session: SessionSummary) -> Bool {
    head.kind == .result && session.showsTranscript
  }

  /// A card offers the voice agent: its head is a result or a decision and its session has a transcript
  /// (``SessionSummary/showsTranscript``), which the conversation reads and whose stream brings a prompt's echo. On a
  /// decision card the conversation talks and the prompt tool refuses, because the card has no reply field. A stop and
  /// a session without a transcript (a Rarog terminal) get no button.
  static func takesVoice(_ head: InboxHead, of session: SessionSummary) -> Bool {
    (head.kind == .result || head.kind == .decision) && session.showsTranscript
  }

  /// A visible card counts on the Inbox button. Every visible card counts, a received result and a held card of a
  /// working session too, so the button and the Inbox header show the same number. A narrower count (only cards that
  /// wait for the person) is a change here.
  static func counts(_ item: InboxItem) -> Bool { true }
}
