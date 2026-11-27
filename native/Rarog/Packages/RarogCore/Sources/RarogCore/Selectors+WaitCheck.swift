import Foundation

// The Check button of a long wait: whether it stands and what it shows. One answer for the popover of the background
// pill and the inspector, both of which read the store. Owner: send.
extension AppState {
  /// The Check button of the wait `key` in `sessionId`; `nil` = no button. Only where a typed prompt could go now
  /// (`sendBlock(for:) == nil`: a state that takes a message, herdr writable, the session in contact with its source)
  /// and on a fresh list (`sessionStale`): a list from the cache has no command texts, and the message gate would hold
  /// the send anyway. A session that ended has a phantom agent and no wait to check (`sendBlock` refuses it too).
  public func waitCheck(_ key: String, in sessionId: String) -> WaitCheckStatus? {
    guard sessions[sessionId] != nil, sendBlock(for: sessionId) == nil, !sessionStale(sessionId) else { return nil }
    guard let check = waitChecks.checks[key] else { return .ready }
    if let acceptedAt = check.acceptedAt { return .sent(acceptedAt) }
    // Reserved and not in the outbox yet: the entry is being written.
    guard let entry = outbox.first(where: { $0.id == check.entryId }) else { return .sending }
    return entry.isRetryable ? .retry(entry.id) : .sending
  }
}
