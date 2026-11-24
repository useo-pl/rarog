import Foundation
import RarogCore

// The Inbox route: the Inbox button opens it in the right column (a screen on the stack on the iPhone), and
// "Open session" from a card keeps the Inbox standing behind the session (also once the session's screen takes the
// route of the Rarog terminal it stands in), so the stack's Back returns to it. On the
// iPhone the session is pushed onto the detail stack above the Inbox (`compactInboxPath`), so Back and the edge
// swipe uncover the Inbox, not the list. The core mirrors one value of this file (`inboxStands`): texts load and held
// cards stay only while it is true. Owner: Inbox.

/// The session opened from an Inbox card, pushed above the Inbox on the iPhone's detail stack.
public struct InboxSessionPush: Hashable, Sendable {
  public let sessionId: String
}

/// The screen opened from an Inbox card: the session, which names the push on the iPhone's stack, and the route that
/// screen stands on. A Claude session in a Rarog terminal takes its terminal's route right after it opens
/// (``RarogNavigation/settleHostedRoute(_:)``), the same screen: the route follows and the push keeps its session, so
/// the stack neither pops it nor pushes it again.
public struct InboxOrigin: Hashable, Sendable {
  public let sessionId: String
  public let route: RarogNavigation.Detail

  /// The origin after the right column changed from `old` to `new`: it follows a change of route of the same screen
  /// (`adopting`) and ends with any other change.
  func following(
    from old: RarogNavigation.Detail?, to new: RarogNavigation.Detail?, adopting: Bool
  ) -> InboxOrigin? {
    if new == route { return self }
    guard adopting, old == route, let new else { return nil }
    return InboxOrigin(sessionId: sessionId, route: new)
  }
}

public extension RarogNavigation {
  /// The Inbox stands: on screen, or behind the session opened from one of its cards. Leaving it (another screen on
  /// the iPad, Back to the list on the iPhone) ends every hold in the core (`RarogStore.inboxClosed()`).
  var inboxStands: Bool {
    detail == .inbox || inboxBehindSession
  }

  /// The session on screen (or the terminal it stands in) was opened from an Inbox card; the stack's Back returns
  /// to the Inbox.
  var inboxBehindSession: Bool {
    guard let origin = inboxOrigin else { return false }
    return detail == origin.route
  }

  /// The Inbox button on the list.
  func openInbox() {
    detail = .inbox
  }

  /// "Open session" on an Inbox card: the session's screen with the Inbox behind it.
  func openSessionFromInbox(_ sessionId: String) {
    detail = .session(sessionId)
    inboxOrigin = InboxOrigin(sessionId: sessionId, route: .session(sessionId))
  }

  /// The session whose transcript stream stands (the one writer is `RarogRootView`, through `RarogStore.openSession`):
  /// the session on screen, or on the Inbox the session of the card whose voice conversation runs or connects, which
  /// reads that transcript and takes the echo of its prompt. Off the Inbox a target left behind opens nothing.
  var transcriptSessionId: String? {
    selectedSessionId ?? (detail == .inbox ? inboxVoiceTarget : nil)
  }

  /// The voice conversation of an Inbox card started (`sessionId`) or ended (`nil`).
  func setInboxVoiceTarget(_ sessionId: String?) {
    guard inboxVoiceTarget != sessionId else { return }
    inboxVoiceTarget = sessionId
  }

  /// The iPhone's detail stack above the Inbox at its root: the session opened from a card, or nothing.
  var compactInboxPath: [InboxSessionPush] {
    guard inboxBehindSession, let origin = inboxOrigin else { return [] }
    return [InboxSessionPush(sessionId: origin.sessionId)]
  }

  /// The stack popped the session opened from a card (Back, the edge swipe): the Inbox under it is on screen.
  func compactInboxPopped() {
    if inboxBehindSession { detail = .inbox }
  }
}
