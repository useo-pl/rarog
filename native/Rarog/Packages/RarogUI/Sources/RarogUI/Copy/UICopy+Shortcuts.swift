import Foundation
import RarogContract
import RarogCore

// Keyboard shortcuts and the command menu: the names in the iPadOS menu bar. The shortcut sheet under a
// held Cmd reuses some of them (`UICopy+ShortcutSheet.swift`). Owner: shortcuts.
extension UICopy {
  public static var shortcutsMenu: String { L("shortcuts.shortcutsMenu") }
  public static var shortcutNewSession: String { L("shortcuts.newSession") }
  public static var shortcutPreviousProject: String { L("shortcuts.previousProject") }
  public static var shortcutLastTab: String { L("shortcuts.lastTab") }
  public static var shortcutShowList: String { L("shortcuts.showList") }
  public static var shortcutHideList: String { L("shortcuts.hideList") }
  public static var shortcutCloseTab: String { L("shortcuts.closeTab") }
  /// Shift+Cmd+U: stały tytuł, bo kierunek zależy od stanu wyniku w chwili naciśnięcia.
  public static var shortcutReadToggle: String { L("shortcuts.readToggle") }

  /// Podpowiedź przycisku po najechaniu kursorem: „Nowa sesja (⌘N)”, kilka skrótów jednej akcji po przecinku
  /// („Zamknij (Esc, ⌘W)”). Glify z `AppShortcut`, spoza katalogu.
  public static func shortcutHelp(_ name: String, _ shortcuts: [AppShortcut]) -> String {
    L("shortcuts.help", name, list(shortcuts.map(\.glyphs), .comma))
  }

  /// The tab's menu item: the number and the name, so the menu says WHERE the digit leads.
  public static func shortcutTab(_ number: Int, label: String) -> String {
    L("shortcuts.tab", number, label)
  }

  /// „Poprzedni projekt: willow" — cel skrótu z nazwy, jak kreska w sekcji PROJEKTY.
  public static func shortcutPreviousProject(_ name: String?) -> String {
    name.map { L("shortcuts.previousProject.named", $0) } ?? shortcutPreviousProject
  }
}
