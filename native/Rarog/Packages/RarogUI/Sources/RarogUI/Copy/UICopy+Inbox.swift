import Foundation
import RarogCore

// Texts of the Inbox: the button on the list, the screen, its cards, the removal toast and the new-cards pill.
// Owner: Inbox.
extension UICopy {
  static var inboxTitle: String { L("inbox.title") }
  /// The separator between the project and the session, and between the state word and the clock.
  static var inboxDot: String { L("app.list.dot") }
  /// The number on the Inbox button for VoiceOver: "4 new".
  static func inboxCountSpoken(_ count: Int) -> String { L("inbox.count.spoken", count) }
  /// The number after the title of the Inbox screen for VoiceOver: "7 cards".
  static func inboxCardsSpoken(_ count: Int) -> String { L("inbox.cards.spoken", count) }
  static var inboxEmptyTitle: String { L("inbox.empty.title") }
  static var inboxEmptyBody: String { L("inbox.empty.body") }
  static var inboxOpenSession: String { L("inbox.openSession") }
  static var inboxRemove: String { L("inbox.remove") }
  static var inboxSwipeRemove: String { L("inbox.swipeRemove") }
  /// The fold row of a long card: "14 more lines · Show all".
  static func inboxShowAll(_ hidden: Int) -> String { L("inbox.showAll", hidden) }
  static var inboxShowLess: String { L("inbox.showLess") }
  static var inboxLoading: String { L("inbox.loading") }
  static var inboxTruncated: String { L("inbox.truncated") }
  /// The toast after a removal: "Removed “background recording”".
  static func inboxRemoved(_ name: String) -> String { L("inbox.removed", name) }
  static var inboxUndo: String { L("inbox.undo") }
  static var inboxRemoveOffline: String { L("inbox.removeOffline") }
  static var inboxRemoveChanged: String { L("inbox.removeChanged") }
  static var inboxRemoveFailed: String { L("inbox.removeFailed") }
  static var inboxUndoFailed: String { L("inbox.undoFailed") }
  static var inboxReplyPlaceholder: String { L("inbox.reply.placeholder") }
  static var inboxReplySend: String { L("inbox.reply.send") }
  /// The mic in a result card's reply row: dictation into the field.
  static var inboxReplyMic: String { L("inbox.reply.mic") }
  /// Under the reply field: the card no longer showed the turn the person answered, so nothing went out.
  static var inboxReplyCardChanged: String { L("inbox.reply.cardChanged") }
  /// The voice strip of a card while the app reads the prompt block aloud.
  static var inboxVoiceReadingPrompt: String { L("inbox.voice.readingPrompt") }
  /// The label on top of the prompt block, and while the person edits it.
  static var inboxPromptLabel: String { L("inbox.prompt.label") }
  static var inboxPromptEdited: String { L("inbox.prompt.edited") }
  static var inboxPromptEdit: String { L("inbox.prompt.edit") }
  static var inboxPromptCancel: String { L("inbox.prompt.cancel") }
  static var inboxPromptSend: String { L("inbox.prompt.send") }

  /// The sentence after a removal that did not happen; `nil` = no sentence (removed, or nothing to say).
  static func inboxRemoveMessage(_ outcome: InboxRemoveOutcome) -> String? {
    switch outcome {
    case .removed, .notAllowed, .loggedOut: nil
    case .offline: inboxRemoveOffline
    case .changed: inboxRemoveChanged
    case .failed: inboxRemoveFailed
    }
  }

  /// The sentence after Undo that did not bring the card back; `nil` = it is back, or nothing to say.
  static func inboxUndoMessage(_ outcome: InboxUndoOutcome) -> String? {
    switch outcome {
    case .restored, .notRemoved, .changed, .expired, .loggedOut: nil
    case .offline: inboxRemoveOffline
    case .failed: inboxUndoFailed
    }
  }

  /// The pill over the Inbox when new cards came above the visible part: the head "2 new ↑" and the states of
  /// the new cards ("1 waiting, 1 unread"), in the list pill's words and colors.
  static func inboxNewPillSegments(_ side: ListJumpPill.Side) -> [ListJumpPill.Segment] {
    var segments = [ListJumpPill.Segment(L("inbox.newPill", side.count), .plain)]
    let parts = listJumpStateParts(side, language: .current)
    guard !parts.isEmpty else { return segments }
    segments.append(ListJumpPill.Segment(L("app.list.dot"), .plain))
    for (index, part) in parts.enumerated() {
      if index > 0 { segments.append(ListJumpPill.Segment(L("app.list.comma"), .plain)) }
      segments.append(part)
    }
    return segments
  }

  /// The pill for VoiceOver: "2 new cards above".
  static func inboxNewPillSpoken(_ count: Int) -> String { L("inbox.newPill.spoken", count) }
  static var inboxNewPillHint: String { L("inbox.newPill.hint") }
}
