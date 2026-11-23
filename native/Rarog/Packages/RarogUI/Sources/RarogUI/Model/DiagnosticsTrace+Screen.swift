import Foundation
import RarogCore

// Cmd+L traces for `client.log`. There is no trace of every screen change: it would eat the trace budget.
// Only the ends of paths.
extension DiagnosticsTrace {
  /// „skrót Cmd+L: do …/rarog" albo „skrót Cmd+L: brak celu".
  public static func previousProject(target: String?) -> String {
    "skrót Cmd+L: " + (target.map { "do \(shortSessionId($0))" } ?? "brak celu")
  }

  /// Drugie wywołanie Cmd+L tego samego wciśnięcia, pominięte (`RarogNavigation.previousProjectRepeatWindow`).
  public static let previousProjectRepeat = "skrót Cmd+L: powtórzenie tego samego wciśnięcia — pominięte"
}
