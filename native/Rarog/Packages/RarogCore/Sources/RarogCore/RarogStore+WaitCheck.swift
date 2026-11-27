import Foundation

// "Check" next to a subagent that waits long on its own background command: the tap sends the main agent the message
// `RarogUI` composed, once per wait. The message is an ordinary typed prompt of the session (`send(text:to:)`, the
// durable outbox, the same server route and the same gates), so a tap has no power a typed prompt does not have. The
// guard lives in the store state (`WaitCheck.swift`), so a closed popover or the inspector next to it see the same
// answer. Owner: send.
extension RarogStore {
  /// The tap on Check of the wait `key` (`BackgroundTaskRules.waitKey`) in `sessionId`, with the message `text`.
  ///
  /// No button (`AppState.waitCheck(_:in:)` is `nil`), a message in flight or one the server already took: nothing goes
  /// out (`.ignored`). A Not confirmed entry or one refused with Retry: that same entry goes again (`retry`, the same
  /// `clientMessageId`, which the server takes at most once). Otherwise a new entry: the wait is reserved under the
  /// entry's id before the first `await`, so a second tap during the disk write or the request finds it taken; an end
  /// that leaves no entry frees it again.
  @discardableResult
  public func checkWait(_ key: String, text: String, in sessionId: String) async -> SendOutcome {
    guard state.auth == .loggedIn, let status = state.waitCheck(key, in: sessionId) else { return .ignored }
    switch status {
    case .sending, .sent:
      return .ignored
    case let .retry(entryId):
      return await retry(entryId)
    case .ready:
      break
    }
    let entryId = UUID()
    dispatch(.waitCheck(.reserved(key: key, entryId: entryId)))
    let outcome = await send(text: text, to: sessionId, entryId: entryId)
    switch outcome {
    case .accepted, .unconfirmed, .refused:
      // The entry exists; the reducer follows it (accepted, freed by a final refusal or a Discard).
      break
    case .empty, .blocked, .notPersisted, .ignored:
      // Only this reservation: another data space may have emptied the guard meanwhile.
      dispatch(.waitCheck(.released(key: key, entryId: entryId)))
    }
    return outcome
  }
}
