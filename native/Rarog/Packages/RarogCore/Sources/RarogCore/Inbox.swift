import Foundation
import RarogContract

// Inbox model: the heads of the server's cards (global stream opened with `inbox=1`), their texts
// (`GET /api/inbox`), removals made on this device with their Undo, and the cards held in place. Changed only by
// `Reducer+Inbox`; read through `Selectors+Inbox`; actions and reads in `RarogStore+Inbox`; when a card stands and
// what counts in `InboxRules`. Owner: Inbox.

/// What the app knows about the server's Inbox cards.
public struct InboxState: Sendable, Equatable {
  /// The last head of each session's card from the global stream. `inbox-heads` replaces them all.
  public internal(set) var heads: [String: InboxHead] = [:]
  /// The last text read for each session's card. A card shows it only while its `version` equals the head's, so a
  /// new head never shows the text of an older version as its own.
  public internal(set) var cards: [String: InboxCard] = [:]
  /// The Inbox is open (navigation enters it and leaves it). Texts and decision transcripts load only while it is
  /// open, so a card's text reaches only the screen that shows it. Not reset with the data: it mirrors navigation.
  public internal(set) var open = false
  /// Held cards, by session. A held card stays visible and in its place while its session works and when its new
  /// result comes; leaving the Inbox ends every hold.
  public internal(set) var held: [String: InboxHold] = [:]
  /// Removals made on this device, by session, until their Undo window ends.
  public internal(set) var removals: [String: InboxRemoval] = [:]
  /// Decision transcripts loaded for the Inbox: session → the head version they were loaded for.
  public internal(set) var transcriptVersions: [String: String] = [:]

  public init() {}
}

/// A card held in place. While its session works, the server's card is the last turn that ended with a result, or
/// none (after a decision in the first turn it sends `inbox-removed`), so the held card shows the last head it took
/// and that head's text until the session stands again with a card of its own. A head in a visible state (a new
/// result or a new decision) replaces the held head and its text, so the session working again shows that card.
public struct InboxHold: Sendable, Equatable {
  /// The order key: the card's `at` when the hold began; a head taken over later keeps it.
  public let at: String
  public internal(set) var head: InboxHead
  /// The text of `head`'s version; filled in when it arrives after the head was taken.
  public internal(set) var card: InboxCard?
}

/// A card removed on this device. It keeps the head (`turnId` and `version` go back in the restore) and the text, so
/// Undo can show the card again after `inbox-removed` dropped its head. It concerns that card only: another head of
/// the session, also of the same turn (the next decision, or its result), has another `version` and stays visible.
public struct InboxRemoval: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    /// The removal request is in flight; the card is hidden.
    case removing
    /// The server removed the card.
    case removed
    /// Undo sent the restore; the card shows again.
    case restoring
  }

  public let head: InboxHead
  public let card: InboxCard?
  /// When the removal started; Undo is offered until `at` + ``CoreTiming/inboxUndoWindow``.
  public let at: Date
  public internal(set) var phase: Phase

  /// The card stays hidden: removal in flight or done, not being restored.
  var hides: Bool { phase != .restoring }

  /// The removed card is this one: same turn and same version. The client cannot rebuild the server's removal key
  /// (the head carries no dialog identity), and every other card of the turn has another version.
  func isOf(turnId: String, version: String) -> Bool {
    head.turnId == turnId && head.version == version
  }

  func isOf(_ head: InboxHead) -> Bool { isOf(turnId: head.turnId, version: head.version) }
}

/// How a removal ended, as the reducer records it.
public enum InboxRemoveResult: Sendable, Equatable {
  /// 200, also with `receipt: "skipped"`.
  case done
  /// 409 `inbox-card-changed`: nothing happened on the server; the card comes back and its text is read again.
  case stale
  /// Any other failure: nothing happened on the server (or it is unknown); the card comes back.
  case failed
}

/// Inbox events of the reducer. Frames go through `CoreEvent.frame`; these come from the store.
public enum InboxEvent: Sendable, Equatable {
  /// The Inbox opened (`true`) or the person left it (`false`; ends every hold).
  case opened(Bool)
  /// The person answered, decided or sent a voice prompt from this card: it stays in place.
  case held(sessionId: String)
  /// `GET /api/inbox` answered.
  case cardsRead([InboxCard])
  /// `GET /api/inbox/<id>` answered; `nil` = the session has no visible card now.
  case cardRead(sessionId: String, card: InboxCard?)
  case removeStarted(sessionId: String, at: Date)
  case removeFinished(sessionId: String, turnId: String, version: String, result: InboxRemoveResult)
  case restoreStarted(sessionId: String)
  /// `restored == false`: the card stays removed.
  case restoreFinished(sessionId: String, turnId: String, version: String, restored: Bool)
  /// The Undo window of the removal that started at `at` ended.
  case undoExpired(sessionId: String, at: Date)
  /// The session's transcript arrived for the head version `version` (a decision card's buttons).
  case transcriptLoaded(sessionId: String, version: String)
}

/// The answer to a removal from the Inbox.
public enum InboxRemoveOutcome: Sendable, Equatable {
  /// The server removed the card; `receiptSkipped` = its result was not marked as received.
  case removed(receiptSkipped: Bool)
  /// The card changed in the meantime; it is back with its new text.
  case changed
  /// No connection: nothing went out, the card stays.
  case offline
  /// No visible card, or a removal of it is already in flight.
  case notAllowed
  case failed
  case loggedOut
}

/// The answer to Undo of a removal.
public enum InboxUndoOutcome: Sendable, Equatable {
  /// The server restored the card.
  case restored
  /// The removal did not happen, so the card is back already.
  case notRemoved
  /// The card changed on the server; the Inbox shows its current state.
  case changed
  /// The Undo window ended, or there is no removal to take back.
  case expired
  case offline
  case failed
  case loggedOut
}

/// The decision a visible `decision` card can take without opening its session: the pending card of the session's
/// transcript with the card's `requestId`, and this device's request in flight for it.
public enum InboxDecision: Sendable, Equatable {
  case permission(PermissionRequest, attempt: DecisionAttempt?)
  case question(QuestionRequest, attempt: DecisionAttempt?)
}
