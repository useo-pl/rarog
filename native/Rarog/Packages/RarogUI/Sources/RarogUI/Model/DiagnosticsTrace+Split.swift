import Foundation

// Ślad pierwszego podziału lista ↔ szczegół do `client.log` (`SplitDisplayModeProbe`, diagnoza
// systemowego przycisku zwijania listy). Same nazwy stanów UIKit i SwiftUI, bez treści.
extension DiagnosticsTrace {
  /// „podział: okno=regular, faza=active, apka=active, uchwyt=never, w pasku=nie".
  public static func split(size: String, phase: String, app: String, button: String, inBar: Bool) -> String {
    "podział: okno=\(size), faza=\(phase), apka=\(app), uchwyt=\(button), w pasku=\(inBar ? "tak" : "nie")"
  }
}
