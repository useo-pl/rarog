import Foundation
import RarogCore

// The session switcher under Cmd+S: recently visited sessions. Owner: shortcuts.
extension UICopy {
  // Tytuły poleceń menu są STAŁE (strażnik `SessionSwitcherSourceTests`): tytuł zmieniany w locie odpala
  // polecenie drugi raz (Cmd+L, `RarogNavigation.previousProjectRepeatWindow`).
  public static var switcherNext: String { L("switcher.next") }
  public static var switcherPrevious: String { L("switcher.previous") }

  /// Nazwa okna dla czytnika (kontener modalny).
  public static var switcherLabel: String { L("switcher.label") }
  /// Podpowiedź czytnika przy bieżącej zakładce: jej aktywacja otwiera okno.
  public static var switcherTabHint: String { L("switcher.tabHint") }
  /// Pigułka przy sesji, która stoi na ekranie.
  public static var switcherHere: String { L("switcher.here") }
  public static var switcherEmpty: String { L("switcher.empty") }
  public static var switcherOnlyCurrent: String { L("switcher.onlyCurrent") }

  /// Footer hints of the window that holds the keyboard: the key and what it does. "0–9": the row's digit jumps to it.
  public static var switcherHints: [(key: String, action: String)] {
    [
      ("↑↓", L("switcher.hints.select")), ("↩", L("switcher.hints.go")), ("0–9", L("switcher.hints.jump")),
      ("esc", L("switcher.hints.close")),
    ]
  }

  /// The window heading: "Ostatnie · 6" (small caps come from the `Eyebrow` style).
  public static func switcherHeading(_ count: Int) -> String {
    L("switcher.heading", count)
  }
}
