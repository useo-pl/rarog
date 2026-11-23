import Foundation
import RarogContract

// Gałęzie reduktora kart. Wołane z głównego `switch` w `Reducer.swift`: zdarzenia obszaru
// (`.cards`) i sprzątanie ostrzeżenia o zaufaniu po każdej ramce.
extension AppState {
  mutating func applyCards(_ event: CardsEvent) {
    switch event {
    case let .trustPromptArmed(sessionId):
      // Kolejność „lista przed 202" jest normalna: dialog zaufania staje kilka sekund PO starcie,
      // więc ostrzeżenie stawiamy niezależnie od tego, czy karta sesji już doszła.
      cards.trustPromptSessionId = sessionId
      settleTrustPrompt()
    }
  }

  /// Zdejmuje ostrzeżenie o zaufaniu, gdy pytanie nie może już stać. Progiem jest STAN
  /// sesji, nie jej pojawienie się na liście: pierwsza karta przychodzi jako `starting`, zanim
  /// dialog stanie w panelu, a ostrzeżenie ma przeżyć ten moment. Sesji jeszcze nie ma = czekamy.
  mutating func settleTrustPrompt() {
    guard let id = cards.trustPromptSessionId, let session = sessions[id] else { return }
    switch session.state {
    case .starting, .waitingPermission: return
    default: cards.trustPromptSessionId = nil
    }
  }

  /// Czas wejścia w czekanie na decyzję (okres łaski, ``DecisionGraceTiming``) po ramce, która zmienia podsumowanie
  /// sesji. Przejście ramką `state` albo `session-changed` liczy się od chwili odbioru (zegar urządzenia, bez różnicy
  /// zegarów); sesja zastana w pełnym stanie — od swojego `stateSince`, o ile nie leży w przyszłości. To samo czekanie
  /// (ten sam `stateSince`) zachowuje swój czas; sesja poza czekaniem go traci.
  mutating func noteDecisionWaits(_ frame: ServerEvent, now: Date) {
    switch frame {
    case let .state(event): noteDecisionWait(event.sessionId, live: true, now: now)
    case let .sessionChanged(changed): noteDecisionWait(changed.session.id, live: true, now: now)
    case .sessionsSnapshot:
      cards.decisionWaits = cards.decisionWaits.filter { sessions[$0.key] != nil }
      for id in sessions.keys { noteDecisionWait(id, live: false, now: now) }
    default: return
    }
  }

  private mutating func noteDecisionWait(_ id: String, live: Bool, now: Date) {
    guard let session = sessions[id], session.isWaitingForDecision else {
      cards.decisionWaits[id] = nil
      return
    }
    if cards.decisionWaits[id]?.stateSince == session.stateSince { return }
    let at: Date?
    if live {
      at = now
    } else {
      at = ISOTime.parse(session.stateSince).flatMap { $0 <= now ? $0 : nil }
    }
    cards.decisionWaits[id] = DecisionWaitStart(stateSince: session.stateSince, at: at)
  }
}
