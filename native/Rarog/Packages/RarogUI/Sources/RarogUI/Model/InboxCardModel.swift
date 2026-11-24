import Foundation
import RarogContract
import RarogCore

// One Inbox card as the screen draws it, and the rule of the "N new ↑" pill. Pure values, tested on macOS
// (`InboxCardModelTests`); the screen (`Views/Inbox/`) only draws them. Owner: Inbox.

/// One card: the list row's header (dot, project · session, state word and clock), the message, what stands under it
/// and whether it can be removed.
public struct InboxCardModel: Sendable, Equatable, Identifiable {
  /// What stands under the message.
  public enum Footer: Sendable, Equatable {
    /// The decision buttons of the pending card from the session's transcript (`AppState.inboxDecision`).
    case decision
    /// A dialog in the pane without a card (`InboxHead.paneDialog(card:)`): "Open session", and above it the pane
    /// dialog card (dismiss with Esc) of the transcript once the Inbox's transcript read gave it.
    case paneDialog
    /// A decision whose buttons are not known here (no `requestId`, the transcript not loaded yet, a card gone), or a
    /// result of a session without a transcript (in a Rarog terminal): "Open session" says where to decide or answer.
    case openSession
    /// The reply field of a result card (`InboxHead.takesReply(of:)`), sent by `RarogStore.replyFromInbox`.
    case reply
    /// Nothing: a stop (the header's "Open session" leads on).
    case none
  }

  public let id: String
  /// The header: the same row model the list draws, so the dot, the state word and the clock say the same.
  public let row: SessionRowModel
  /// The head's version: a new version is new text.
  public let version: String
  /// The head's turn: a reply goes out only while the card still shows the turn the person answered.
  public let turnId: String
  /// The markdown of the message; `nil` while it loads.
  public let text: String?
  /// The server cut the start of a long message.
  public let truncated: Bool
  public let footer: Footer
  /// "×", the swipe and the VoiceOver action exist. A held card of a working session can show a head the server no
  /// longer has: removing it would only bring it back after a 409, so it cannot be removed until its session stands.
  public let removable: Bool
  public let held: Bool
  /// The voice agent button stands on the card (`InboxHead.takesVoice(of:)`): a result or a decision of a session
  /// with a transcript.
  public let voice: Bool

  /// - Parameters:
  ///   - decision: `AppState.inboxDecision(_:)` gave this card its buttons.
  ///   - freshResult: `AppState.freshResult(_:)` of the session: the dot pulses as on the list.
  public init(
    head: InboxHead, session: SessionSummary, card: InboxCard?, held: Bool, decision: Bool, freshResult: Bool
  ) {
    id = head.sessionId
    row = SessionRowModel(session, ordinal: nil, freshResult: freshResult)
    version = head.version
    turnId = head.turnId
    text = card?.text
    truncated = card?.truncated ?? false
    self.held = held
    let working = session.state == .running || session.state == .starting
    removable = !(held && working)
    voice = head.takesVoice(of: session)
    switch head.kind {
    case .decision:
      if decision {
        footer = .decision
      } else if head.paneDialog(card: card) {
        footer = .paneDialog
      } else {
        footer = .openSession
      }
    case .result:
      footer = head.takesReply(of: session) ? .reply : .openSession
    case .failed:
      footer = .none
    }
  }

  /// "project · session", the name the toast and VoiceOver use.
  public var name: String { row.treeTitle.isEmpty ? row.project : "\(row.project) · \(row.treeTitle)" }
}

extension AppState {
  /// The cards of the Inbox screen, in the order of ``inboxItems``.
  public var inboxCardModels: [InboxCardModel] {
    inboxItems.map { item in
      InboxCardModel(
        head: item.head, session: item.session, card: item.card, held: item.held,
        decision: inboxDecision(item.id) != nil, freshResult: freshResult(item.session))
    }
  }
}

/// The cards that came above while the screen was not at its top: the screen never moves under a finger, so a pill
/// counts them by state ("2 new ↑ · 1 waiting, 1 unread") and a tap scrolls up. A card is new when its head's version
/// is one this screen has not shown yet (a new session, or a new result or decision that put it on top); a held card
/// changes its text in place and is not new. Reaching the top clears the pill.
public struct InboxNewCards: Sendable, Equatable {
  /// New cards in the screen's order, not seen at the top yet.
  public private(set) var ids: [String] = []
  /// Session → the version the screen knew. `nil` before the first list: what stands at the start is not new.
  private var known: [String: String]?

  public init() {}

  /// The screen got a new list of cards. `atTop`: its top is on screen, so new cards slide in where they are seen.
  public mutating func update(_ cards: [InboxCardModel], atTop: Bool) {
    let present = Set(cards.map(\.id))
    if let known {
      let fresh = cards.filter { !$0.held && known[$0.id] != $0.version }.map(\.id)
      ids = atTop ? [] : (ids.filter(present.contains) + fresh.filter { !ids.contains($0) })
    }
    known = Dictionary(cards.map { ($0.id, $0.version) }, uniquingKeysWith: { first, _ in first })
  }

  /// The top came on screen: everything new has been seen.
  public mutating func reachedTop() {
    ids = []
  }

  /// The pill's counts, or `nil` when no new card needs it. The target is the topmost new card.
  public func side(_ cards: [InboxCardModel]) -> ListJumpPill.Side? {
    guard !ids.isEmpty else { return nil }
    var side = ListJumpPill.Side(target: "")
    var target: String?
    for card in cards where ids.contains(card.id) {
      guard let attention = ListJumpPill.Attention(card.row.status.tone) else { continue }
      side.add(attention)
      target = target ?? card.id
    }
    guard let target, side.count > 0 else { return nil }
    side.target = target
    return side
  }
}

extension InboxCardModel {
  /// The card ⌫ (or forward delete) removes with a hardware keyboard: the card that has the keyboard focus, when it
  /// can be removed, nobody is typing (a field keeps its own ⌫) and no sheet stands over the screen. `nil` = the key
  /// is not the Inbox's.
  public static func keyRemovalTarget(
    focused: String?, cards: [InboxCardModel], typing: Bool, sheetAbove: Bool
  ) -> InboxCardModel? {
    guard !typing, !sheetAbove, let focused, let card = cards.first(where: { $0.id == focused }), card.removable
    else { return nil }
    return card
  }
}
