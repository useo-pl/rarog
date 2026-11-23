import Foundation
import RarogContract

// Gałęzie reduktora sterowania sesją. Wołane z głównego `switch` w `Reducer.swift`.
extension AppState {
  mutating func applySession(_ event: SessionControlEvent, now: Date) -> [CoreEffect] {
    switch event {
    case let .modelsLoaded(models):
      sessionControls.models = models
    case let .modeToggleStarted(sessionId, target, until):
      sessionControls.modeToggles[sessionId] = ModeToggle(target: target, until: until)
      // Wpisy po terminie nie mają już czytelnika — sprzątamy przy okazji nowego.
      sessionControls.modeToggles = sessionControls.modeToggles.filter { $0.value.until > now }
    case let .modeToggleSettled(sessionId, until), let .modeToggleExpired(sessionId, until):
      // Tylko wpis TEJ próby — nowszy tap ma własny termin i własną odpowiedź.
      if sessionControls.modeToggles[sessionId]?.until == until { sessionControls.modeToggles[sessionId] = nil }
    case let .modelChangeStarted(sessionId, target, until):
      sessionControls.modelChanges = sessionControls.modelChanges.filter { $0.value.until > now }
      sessionControls.modelChanges[sessionId] = ModelChange(target: target, until: until)
    case let .modelChangeSettled(sessionId, until), let .modelChangeExpired(sessionId, until):
      // Only this attempt's entry: a newer Apply has its own deadline and its own reply.
      if sessionControls.modelChanges[sessionId]?.until == until { sessionControls.modelChanges[sessionId] = nil }
    case let .restartStarted(sessionId, until):
      sessionControls.restarting.insert(sessionId)
      sessionControls.pendingRestarts = sessionControls.pendingRestarts.filter { $0.value.until > now }
      sessionControls.pendingRestarts[sessionId] = PendingRestart(
        until: until, codeAtStart: sessions[sessionId]?.stateDetailRef?.code, paneAtStart: sessions[sessionId]?.paneId)
    case let .restartFinished(sessionId):
      sessionControls.restarting.remove(sessionId)
    case let .restartRefused(sessionId, uncertain):
      if !uncertain || sessionControls.pendingRestarts[sessionId]?.progressed != true {
        sessionControls.pendingRestarts[sessionId] = nil
      }
    case let .restartExpired(sessionId, until):
      if sessionControls.pendingRestarts[sessionId]?.until == until { sessionControls.pendingRestarts[sessionId] = nil }
    case let .restartGraceEnded(sessionId, settledAt):
      if sessionControls.pendingRestarts[sessionId]?.settledAt == settledAt {
        sessionControls.pendingRestarts[sessionId] = nil
      }
    }
    return []
  }

  /// Ends each model change in flight whose session shows the whole target. A session missing from the list keeps its
  /// entry until the deadline.
  mutating func settleModelChanges() {
    for (id, change) in sessionControls.modelChanges {
      guard let session = sessions[id], change.confirmed(by: session) else { continue }
      sessionControls.modelChanges[id] = nil
    }
  }

  /// Moves each restart in progress along after a list frame and ends it when the card shows the end:
  /// - a `restart.*` sentence other than exiting or launching: the server canceled or failed the restart (the same
  ///   sentence as at the tap counts only once this restart showed progress — it may be left from an earlier one);
  /// - the card live again after the relaunch (seen as `resumable`/`starting` or as a new pane) without `cliUpdate`:
  ///   the new process runs the installed release;
  /// - live again with `cliUpdate` still on it: the grace effect ends it, unless the next frame clears `cliUpdate`.
  /// A card missing from the list is left to the limit: the server rebuilds the card while the new process starts.
  mutating func settleRestarts(now: Date) -> [CoreEffect] {
    var effects: [CoreEffect] = []
    for (id, pending) in sessionControls.pendingRestarts {
      guard let session = sessions[id] else { continue }
      var next = pending
      if let code = session.stateDetailRef?.code, code.hasPrefix("restart.") {
        if code.hasPrefix("restart.exiting") || code.hasPrefix("restart.launching") {
          next.progressed = true
        } else if pending.progressed || code != pending.codeAtStart {
          sessionControls.pendingRestarts[id] = nil
          continue
        }
      }
      switch session.state {
      case .resumable, .starting:
        next.progressed = true
        next.relaunching = true
        next.settledAt = nil
      default:
        if let pane = session.paneId, let before = pending.paneAtStart, pane != before {
          next.progressed = true
          next.relaunching = true
        }
        guard next.relaunching else { break }
        if session.cliUpdate == nil {
          sessionControls.pendingRestarts[id] = nil
          continue
        }
        if next.settledAt == nil {
          next.settledAt = now
          effects.append(.scheduleRestartGrace(sessionId: id, settledAt: now))
        }
      }
      if next != pending { sessionControls.pendingRestarts[id] = next }
    }
    return effects
  }
}
