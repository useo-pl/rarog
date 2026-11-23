import Foundation

// Zdania tylko dla czytnika ekranu, których nie niesie żaden obszar.
// Właściciel: dostępność.
extension UICopy {
  /// Ogłoszenie karty decyzji, która stanęła w trakcie wizyty: nagłówek karty (rodzaj, narzędzie).
  public static func newDecisionSpoken(_ header: String) -> String {
    L("accessibility.newDecisionSpoken", header)
  }
}
