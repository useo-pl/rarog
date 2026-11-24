import Foundation
import RarogContract

// Inbox selectors: the visible cards in their order, the counter on the Inbox button, the decision a card can take and
// whether a removal can still be undone. When a card stands and what counts is decided in `InboxRules`. Owner: Inbox.

/// One card as the Inbox shows it.
public struct InboxItem: Sendable, Equatable, Identifiable {
  public let head: InboxHead
  public let session: SessionSummary
  /// The text of this head's version; `nil` while it loads.
  public let card: InboxCard?
  /// The card stays in place: the person acted on it in this visit of the Inbox.
  public let held: Bool

  public var id: String { head.sessionId }
}

extension InboxHead {
  /// A decision on a dialog in the pane without a card, by the head or by the text of its version (whichever came
  /// first). The card's footer and the transcript read of the Inbox use this one rule: the dismiss action needs the
  /// signature of the transcript's pane dialog card (`AppState.herdrDialogSignature`).
  public func paneDialog(card: InboxCard?) -> Bool {
    kind == .decision && (dialog == .panel || card?.dialog?.kind == .panel)
  }

  /// The card of `session` has a reply field (``InboxRules/takesReply(_:of:)``).
  public func takesReply(of session: SessionSummary) -> Bool { InboxRules.takesReply(self, of: session) }

  /// The card of `session` has the voice agent button (``InboxRules/takesVoice(_:of:)``).
  public func takesVoice(of session: SessionSummary) -> Bool { InboxRules.takesVoice(self, of: session) }
}

extension AppState {
  /// The server has an Inbox (`inbox` in `GET /api/version`).
  public var inboxAvailable: Bool { capabilities?.inbox == true }

  /// The visible cards, newest `at` first. A card that is not held stands by ``InboxRules/stands(_:of:)``. A held
  /// card stands in any state and keeps the `at` it had when holding began, so its new result changes the text
  /// without moving it; it shows the server's head while ``InboxRules/showsHead(_:of:)`` holds and otherwise the last
  /// head it took (``InboxHold``). A removal hides a card by ``InboxRules/removalHides(_:_:)``.
  public var inboxItems: [InboxItem] {
    let ids = Set(inbox.heads.keys).union(inbox.held.keys)
    let items = ids.compactMap { id -> (InboxItem, Date)? in
      guard let session = sessions[id] else { return nil }
      let standing = inbox.heads[id].flatMap { InboxRules.showsHead($0, of: session) ? $0 : nil }
      let text = { (head: InboxHead) in inbox.cards[id].flatMap { $0.version == head.version ? $0 : nil } }
      let item: InboxItem
      let at: String
      if let hold = inbox.held[id] {
        let head = standing ?? hold.head
        item = InboxItem(
          head: head, session: session, card: text(head) ?? (standing == nil ? hold.card : nil), held: true)
        at = hold.at
      } else if let head = inbox.heads[id], InboxRules.stands(head, of: session) {
        item = InboxItem(head: head, session: session, card: text(head), held: false)
        at = head.at
      } else {
        return nil
      }
      guard !InboxRules.removalHides(inbox.removals[id], item.head) else { return nil }
      return (item, ISOTime.parse(at) ?? .distantPast)
    }
    return items.sorted { a, b in
      a.1 != b.1 ? a.1 > b.1 : a.0.head.sessionId < b.0.head.sessionId
    }.map(\.0)
  }

  /// The number on the Inbox button: visible cards that count by ``InboxRules/counts(_:)`` (today all of them, the
  /// number the Inbox header shows). Zero = no number.
  public var inboxCount: Int {
    inboxItems.count(where: InboxRules.counts)
  }

  /// The decision of a visible `decision` card: the pending card of the session's transcript whose `permId` or `qId`
  /// is the card's `requestId`. The transcript is the one source of current dialogs for the session screen and the
  /// Inbox, with this device's requests in flight. `nil` = no decision buttons on the card: no `requestId`, a pane
  /// dialog without a card, the transcript not loaded yet, or its card gone.
  public func inboxDecision(_ sessionId: String) -> InboxDecision? {
    guard let item = inboxItems.first(where: { $0.id == sessionId }), item.head.kind == .decision,
      let dialog = item.card?.dialog, let view = transcripts[sessionId]
    else { return nil }
    switch dialog {
    case let .permission(_, requestId?):
      return view.pendingPermissions.first { $0.permId == requestId }.map {
        .permission($0, attempt: view.decisions[requestId])
      }
    case let .question(_, requestId?):
      return view.pendingQuestions.first { $0.qId == requestId }.map {
        .question($0, attempt: view.decisions[requestId])
      }
    case .permission, .question, .panel:
      return nil
    }
  }

  /// The head of this session's visible card when that card takes a reply; `nil` = no such card stands now (it hid
  /// because the session works, it is a decision or a stop, its session stands in a Rarog terminal, or it was
  /// removed). A reply goes out only while this head has the turn the person answered
  /// (``RarogStore/replyFromInbox(_:to:turnId:)``).
  public func inboxReplyTarget(_ sessionId: String) -> InboxHead? {
    guard let item = inboxItems.first(where: { $0.id == sessionId }), InboxRules.takesReply(item.head, of: item.session)
    else { return nil }
    return item.head
  }

  /// The head of this session's visible card when that card offers the voice agent; `nil` = no such card stands now
  /// (removed, hidden because the session works, a stop, or a session without a transcript). The conversation of a
  /// card ends when this goes.
  public func inboxVoiceTarget(_ sessionId: String) -> InboxHead? {
    guard let item = inboxItems.first(where: { $0.id == sessionId }), InboxRules.takesVoice(item.head, of: item.session)
    else { return nil }
    return item.head
  }

  /// A removal of this session's card that Undo can still take back at `now`.
  public func inboxUndoable(_ sessionId: String, now: Date, timing: CoreTiming = .production) -> Bool {
    guard let removal = inbox.removals[sessionId], removal.phase != .restoring else { return false }
    return now < removal.at.addingTimeInterval(timing.inboxUndoWindow.timeInterval)
  }
}
