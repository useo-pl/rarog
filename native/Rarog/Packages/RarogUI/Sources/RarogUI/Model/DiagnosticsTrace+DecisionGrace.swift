import Foundation
import RarogCore

// Linia śladu pierwszej karty po czekaniu bez karty (okres łaski). Właściciel: karty; kanał i budżet
// śladów: łączność (`RarogStore.trace`).
extension DiagnosticsTrace {
  /// „decyzja …-w1-p1: pierwsza karta zgoda hook po 614 ms od czekania”. Bez treści komendy.
  public static func decisionCard(_ arrival: DecisionCardTrace.Arrival) -> String {
    let kind = switch arrival.kind {
    case .permissionHook: "zgoda hook"
    case .permissionJsonl: "zgoda jsonl"
    case .permissionScreen: "zgoda ekran"
    case .question: "pytanie"
    case .fallbackDialog: "dialog zapasowy"
    }
    let when = arrival.milliseconds.map { " po \($0) ms od czekania" } ?? ", czas wejścia w czekanie nieznany"
    return "decyzja \(shortSessionId(arrival.sessionId)): pierwsza karta \(kind)\(when)"
  }
}
