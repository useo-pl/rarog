import Foundation
import RarogContract

// Reducer branches of the Inbox: frames of the global stream, text reads, removals and Undo, holding. The main
// `apply` hands them over in one line each. Owner: Inbox.

extension AppState {
  /// `inbox-heads`, `inbox-head` and `inbox-removed`, only from the global stream (the only stream that carries them).
  mutating func applyInboxFrame(_ frame: ServerEvent, source: FrameSource) {
    guard source == .global else { return }
    switch frame {
    case let .inboxHeads(event):
      // The full list after `sessions-snapshot` (reconnect, server switch): the heads it lacks are gone.
      inbox.heads = Dictionary(event.heads.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, last in last })
      inbox.cards = inbox.cards.filter { inbox.heads[$0.key] != nil }
      inbox.held = inbox.held.filter { inbox.heads[$0.key] != nil || sessionWorks($0.key) }
      inbox.transcriptVersions = inbox.transcriptVersions.filter { inbox.heads[$0.key] != nil }
      for sessionId in inbox.held.keys { renewInboxHold(sessionId) }
    case let .inboxHead(event):
      inbox.heads[event.head.sessionId] = event.head
      renewInboxHold(event.head.sessionId)
    case let .inboxRemoved(event):
      // Only the card of that turn: a late frame does not remove the next turn's card.
      guard inbox.heads[event.sessionId]?.turnId == event.turnId else { return }
      // A held card whose session works after a decision in its first turn: the server has no card for it now, but
      // the card stays in place with what it showed (``InboxHold``).
      if inbox.held[event.sessionId] != nil, sessionWorks(event.sessionId) {
        inbox.heads[event.sessionId] = nil
        inbox.cards[event.sessionId] = nil
        return
      }
      forgetInboxCard(event.sessionId)
    default:
      return
    }
  }

  mutating func applyInbox(_ event: InboxEvent) {
    switch event {
    case let .opened(open):
      inbox.open = open
      // Leaving the Inbox ends every hold; opening starts from none.
      inbox.held = [:]
    case let .held(sessionId):
      guard inbox.held[sessionId] == nil else { return }
      if let item = inboxItems.first(where: { $0.id == sessionId }) {
        inbox.held[sessionId] = InboxHold(at: item.head.at, head: item.head, card: item.card)
      } else if let head = inbox.heads[sessionId] {
        // A card hidden by its working session (a reply sent a moment ago) comes back held.
        let card = inbox.cards[sessionId].flatMap { $0.version == head.version ? $0 : nil }
        inbox.held[sessionId] = InboxHold(at: head.at, head: head, card: card)
      }
    case let .cardsRead(cards):
      for card in cards where inbox.heads[card.sessionId] != nil { noteInboxText(card) }
    case let .cardRead(sessionId, card):
      if let card {
        noteInboxText(card)
      } else if !holdsCurrentInboxText(sessionId) {
        // A late empty answer does not take the text of the current head; `inbox-removed` drops a card that went.
        inbox.cards[sessionId] = nil
      }
    case let .removeStarted(sessionId, at):
      guard let item = inboxItems.first(where: { $0.id == sessionId }) else { return }
      inbox.removals[sessionId] = InboxRemoval(head: item.head, card: item.card, at: at, phase: .removing)
      inbox.held[sessionId] = nil
    case let .removeFinished(sessionId, turnId, version, result):
      guard inbox.removals[sessionId]?.isOf(turnId: turnId, version: version) == true else { return }
      switch result {
      case .done:
        inbox.removals[sessionId]?.phase = .removed
      case .stale, .failed:
        // Nothing happened on the server: the card stands again (unless its head left meanwhile).
        inbox.removals[sessionId] = nil
      }
    case let .restoreStarted(sessionId):
      guard var removal = inbox.removals[sessionId] else { return }
      removal.phase = .restoring
      inbox.removals[sessionId] = removal
      // `inbox-removed` may have dropped the head already: the card shows again at once, before the server's head.
      if inbox.heads[sessionId] == nil {
        inbox.heads[sessionId] = removal.head
        if let card = removal.card { inbox.cards[sessionId] = card }
      }
    case let .restoreFinished(sessionId, turnId, version, restored):
      guard inbox.removals[sessionId]?.isOf(turnId: turnId, version: version) == true else { return }
      if restored {
        inbox.removals[sessionId] = nil
      } else {
        inbox.removals[sessionId]?.phase = .removed
      }
    case let .undoExpired(sessionId, at):
      guard let removal = inbox.removals[sessionId], removal.at == at, removal.phase == .removed else { return }
      inbox.removals[sessionId] = nil
      // The server removed this card; its head goes too, even if the `inbox-removed` frame was lost. Another head of
      // the session (also of the same turn) is another card and stays.
      if let head = inbox.heads[sessionId], removal.isOf(head) { forgetInboxCard(sessionId) }
    case let .transcriptLoaded(sessionId, version):
      inbox.transcriptVersions[sessionId] = version
    }
  }

  /// A version probe without the `inbox` capability (the server keeps no Inbox now): nothing of it stays.
  mutating func settleInboxCapability() {
    guard capabilities?.inbox == false else { return }
    clearInbox()
  }

  /// Logout, server switch and loss of the capability: the data goes, the open flag (navigation) stays.
  mutating func clearInbox() {
    let open = inbox.open
    inbox = InboxState()
    inbox.open = open
  }

  /// A card text that arrived: the held card's text when it is of the held head's version, and the session's text
  /// unless it already holds the text of the current head and this one is of another version (a read that answered
  /// late, after a newer read). A text newer than its head is kept: the head catches up with it.
  private mutating func noteInboxText(_ card: InboxCard) {
    if inbox.held[card.sessionId]?.head.version == card.version { inbox.held[card.sessionId]?.card = card }
    guard card.version == inbox.heads[card.sessionId]?.version || !holdsCurrentInboxText(card.sessionId) else { return }
    inbox.cards[card.sessionId] = card
  }

  /// The stored text of the session is of its current head's version.
  private func holdsCurrentInboxText(_ sessionId: String) -> Bool {
    guard let head = inbox.heads[sessionId], let card = inbox.cards[sessionId] else { return false }
    return card.version == head.version
  }

  /// A held card takes over a head by ``InboxRules/holdTakesOver(_:from:)``, with that head's text when it is here
  /// already, keeping the order key.
  private mutating func renewInboxHold(_ sessionId: String) {
    guard let hold = inbox.held[sessionId], let head = inbox.heads[sessionId],
      InboxRules.holdTakesOver(head, from: hold)
    else { return }
    inbox.held[sessionId]?.head = head
    inbox.held[sessionId]?.card = inbox.cards[sessionId].flatMap { $0.version == head.version ? $0 : nil }
  }

  private func sessionWorks(_ sessionId: String) -> Bool {
    sessions[sessionId].map(InboxRules.works) ?? false
  }

  private mutating func forgetInboxCard(_ sessionId: String) {
    inbox.heads[sessionId] = nil
    inbox.cards[sessionId] = nil
    inbox.held[sessionId] = nil
    inbox.transcriptVersions[sessionId] = nil
  }
}
