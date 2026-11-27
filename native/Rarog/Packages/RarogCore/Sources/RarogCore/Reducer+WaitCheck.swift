import Foundation

// Reducer branches of the Check guard (`WaitCheck.swift`). `applyWaitCheck` takes the action's own events from the
// main `switch` in `Reducer.swift`; `settleWaitChecks` runs after every event and follows the outbox entry of each
// check by its id, because the entry changes while the action is not running (the 202, the echo, a Discard, a
// take-back). Emptying together with the outbox: `Reducer+Pairing` (`dataWiped`). Owner: send.
extension AppState {
  mutating func applyWaitCheck(_ event: WaitCheckEvent) {
    switch event {
    case let .reserved(key, entryId):
      waitChecks.checks[key] = WaitCheckState.Check(entryId: entryId)
    case let .released(key, entryId):
      guard waitChecks.checks[key]?.entryId == entryId else { return }
      waitChecks.checks[key] = nil
    }
  }

  /// The outbox told something about the entry of a check. Accepted: a 202 (also queued in the CLI), a replay of an
  /// accepted message, or its echo, whichever comes first; the first moment stays. Freed (only a check not accepted
  /// yet): a final refusal, which no Retry repairs, and a Discard by hand. A take-back of the CLI queue frees it even
  /// after a 202: the message went back to the prompt field and never reached the agent.
  mutating func settleWaitChecks(after event: CoreEvent, now: Date) {
    guard !waitChecks.checks.isEmpty else { return }
    switch event {
    case let .outboxAccepted(id, at), let .outboxQueued(id, at):
      acceptWaitCheck(id, at: at)
    case let .outboxReplayed(id):
      acceptWaitCheck(id, at: now)
    case let .outboxRefused(id, code, _) where OutboxEntry.RefusalCode.final.contains(code ?? ""):
      freeWaitCheck { $0.entryId == id && $0.acceptedAt == nil }
    case let .outboxDiscarded(id):
      freeWaitCheck { $0.entryId == id && $0.acceptedAt == nil }
    case let .queueTakeBack(.taken(_, clientMessageIds)):
      let taken = Set(clientMessageIds)
      freeWaitCheck { taken.contains($0.entryId.uuidString.lowercased()) }
    default:
      break
    }
    // The echo has no event of its own (it comes in a message or transcript frame); `echoed` names its entry.
    for (key, check) in waitChecks.checks where check.acceptedAt == nil && echoed[check.entryId] != nil {
      waitChecks.checks[key]?.acceptedAt = now
    }
  }

  private mutating func acceptWaitCheck(_ entryId: UUID, at: Date) {
    for (key, check) in waitChecks.checks where check.entryId == entryId && check.acceptedAt == nil {
      waitChecks.checks[key]?.acceptedAt = at
    }
  }

  private mutating func freeWaitCheck(where matches: (WaitCheckState.Check) -> Bool) {
    waitChecks.checks = waitChecks.checks.filter { !matches($0.value) }
  }
}
