import Foundation
import RarogContract

// Gałęzie reduktora przerwań i odbioru wyniku. Wołane z głównego `switch` w `Reducer.swift`.
extension AppState {
  mutating func applyTurnControl(_ event: TurnControlEvent) -> [CoreEffect] {
    switch event {
    case let .interruptStarted(sessionId, at):
      turnControl.interrupts[sessionId] = at
    case let .interruptSettled(sessionId, startedAt):
      // Tylko wpis TEJ próby — nowszy gest ma własne żądanie i własne rozstrzygnięcie.
      if turnControl.interrupts[sessionId] == startedAt { turnControl.interrupts[sessionId] = nil }
    case let .interruptReplied(session):
      applyInterruptReply(session)
    case let .seenNoted(sessionId, stateSince):
      turnControl.seen[sessionId] = stateSince
    case let .seenForgotten(sessionId):
      turnControl.seen[sessionId] = nil
    case let .unreadMarked(sessionId):
      turnControl.manualUnread.insert(sessionId)
      // A new gesture waits for its own frame, unless the card already carries the server mark.
      if sessions[sessionId]?.markedUnseen == true {
        turnControl.manualUnreadConfirmed.insert(sessionId)
      } else {
        turnControl.manualUnreadConfirmed.remove(sessionId)
      }
    case let .unreadReleased(sessionId):
      turnControl.manualUnread.remove(sessionId)
      turnControl.manualUnreadConfirmed.remove(sessionId)
    }
    return []
  }

  /// Karta z odpowiedzi na przerwanie: naprawia widok, gdy strumień umarł po cichu.
  /// Dwa strażniki: karta zdjęta w międzyczasie nie wraca (spóźniona odpowiedź wskrzeszałaby ją
  /// na liście), a karta starsza od znanej nie cofa nowszej tury (miarą jest `stateSince`).
  /// Stan i aktywność to para, którą serwer emituje przy przerwaniu: bez zgaszenia aktywności
  /// wiersz pod transkryptem dalej mówiłby „uruchamiam…" nad stojącą sesją.
  private mutating func applyInterruptReply(_ session: SessionSummary) {
    guard let known = sessions[session.id], let at = ISOTime.parse(session.stateSince),
      let knownAt = ISOTime.parse(known.stateSince), at >= knownAt
    else { return }
    var fresh = session
    fresh.activity = nil
    sessions[session.id] = fresh
    noteListMemory(session.id)
    guard transcripts[session.id] != nil else { return }
    transcripts[session.id]?.activity = nil
    transcripts[session.id]?.activityAt = nil
    if session.state != .running, session.state != .starting { transcripts[session.id]?.joinedMidTurn = false }
  }

  /// Zalogowanie i wylogowanie (`resetView`): przerwania i zgłoszenia „obejrzane" sprzed nich nie
  /// należą do nowego zalogowania, a wyższy numer odcina wyniki żądań w drodze.
  mutating func resetTurnControl() {
    var next = TurnControlState()
    next.login = turnControl.login + 1
    turnControl = next
  }
}
