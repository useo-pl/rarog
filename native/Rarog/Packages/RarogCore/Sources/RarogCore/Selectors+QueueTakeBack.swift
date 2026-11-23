import Foundation

// Selectors of the queue take-back. Owner: send.
extension AppState {
  /// The session has a queued bubble (an entry accepted with a held echo).
  public func hasQueuedBubble(_ sessionId: String) -> Bool {
    outbox.contains { $0.sessionId == sessionId && $0.isQueued }
  }

  /// The session keeps the `operationId` of a take-back without a definitive answer (or of one in flight): the
  /// server may hold the taken texts under it, so a gesture replays it although no bubble is queued any more (after
  /// 15 s of idle the bubbles turn Not confirmed).
  public func keepsTakeBack(_ sessionId: String) -> Bool {
    queueTakeBack.operations[sessionId] != nil
  }

  /// The gestures that take the queue back exist (Up on an empty field; the tap and the VoiceOver action of a queued
  /// bubble, and of a Not confirmed one while a take-back is kept): a queued bubble or a kept take-back.
  public func canTakeBackQueue(_ sessionId: String) -> Bool {
    hasQueuedBubble(sessionId) || keepsTakeBack(sessionId)
  }

  /// A take-back request of the session is in flight.
  public func isTakingBackQueue(_ sessionId: String) -> Bool {
    queueTakeBack.inFlight.contains(sessionId)
  }
}
