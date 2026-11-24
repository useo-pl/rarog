import Foundation
import RarogCore

// The session switcher window, opened by a tap on the current tab: the tabs of the current project. Owner: shortcuts.
extension UICopy {
  /// Nazwa okna dla czytnika (kontener modalny).
  public static var switcherLabel: String { L("switcher.label") }
  /// Podpowiedź czytnika przy bieżącej zakładce: jej aktywacja otwiera okno.
  public static var switcherTabHint: String { L("switcher.tabHint") }
  /// Pigułka przy zakładce, która stoi na ekranie.
  public static var switcherHere: String { L("switcher.here") }
  public static var switcherEmpty: String { L("switcher.empty") }
  public static var switcherOnlyCurrent: String { L("switcher.onlyCurrent") }

  /// Footer hints of the window that holds the keyboard: the key and what it does.
  public static var switcherHints: [(key: String, action: String)] {
    [("↑↓", L("switcher.hints.select")), ("↩", L("switcher.hints.go")), ("esc", L("switcher.hints.close"))]
  }

  /// The window heading after the project's name: "Zakładki projektu · 6" (small caps come from the `Eyebrow` style).
  /// The whole heading is `SwitcherHeading.text`.
  public static func switcherHeading(_ count: Int) -> String {
    L("switcher.heading", count)
  }

  /// The separator between the project's name and the rest of the heading: the list's dot.
  static var switcherHeadingDot: String { L("app.list.dot") }
}
