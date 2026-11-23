#if os(iOS)
import RarogCore
import SwiftUI

/// The app's global shortcuts: the scene's command menu (the iPadOS menu bar; Cmd+Shift+N, Cmd+F and
/// Cmd+G of the terminal). From iPadOS 26 the system shows no list under a held Cmd; the
/// app's own shortcut sheet (`ShortcutSheet/`) does, from its own rows. The app attaches the menu with one
/// `.commands` line in `RarogApp`. Owner: shortcuts.
///
/// Polecenia menu działają z fokusem w transkrypcie, w polu wiadomości i na liście, a kombinacje
/// z Cmd niczego nie wpisują do pola. Stan menu (numery zakładek, cel Cmd+L) przychodzi
/// z korzenia widoków jako wartość sceny — numer wskazuje to, co widać na pasku w chwili rysowania.
///
/// Cmd+S and Shift+Cmd+S open the session switcher: a window of the recently visited sessions that
/// stays until Return, a tap or Esc. `SessionSwitcherHost` routes them, not `RarogShortcut` — the window has its own
/// state machine.
///
/// Kombinacje (poza cyframi zakładek) przychodzą z `AppShortcut` — z tej samej definicji podpowiedź przycisku „Nazwa
/// (⌘B)”, więc podpowiedź i skrót nie rozjadą się.
///
/// Cmd+X NIE jest tu poleceniem: menu ma już systemowe „Wytnij". Zamknięcie zakładki to skrót
/// ekranu sesji (`SessionViewController+KeysTabs`), który przy zaznaczeniu w polu wiadomości
/// wycina zamiast zamykać.
public struct RarogCommands: Commands {
  let store: RarogStore
  @FocusedValue(\.rarogShortcuts) private var shortcuts

  public init(store: RarogStore) {
    self.store = store
  }

  public var body: some Commands {
    let menu = shortcuts?.menu ?? ShortcutMenu()
    // „Nowa sesja" zamiast systemowego „Nowe okno" (apka ma jedno okno).
    CommandGroup(replacing: .newItem) {
      Button(UICopy.shortcutNewSession) { shortcuts?.perform(.newSession) }
        .keyboardShortcut(AppShortcut.newSession.keyboardShortcut)
        .disabled(!menu.canNewSession)
      // Kolejny terminal projektu: te same bramki co „Nowy terminal" pod „+".
      Button(UICopy.newTerminal) { shortcuts?.perform(.newTerminal) }
        .keyboardShortcut(AppShortcut.newTerminal.keyboardShortcut)
        .disabled(!menu.canTerminal)
    }
    // Pogrubienie (Cmd+B) nie ma sensu w polu bez formatowania, a zderzałoby się ze zwijaniem listy.
    CommandGroup(replacing: .textFormatting) {}
    CommandGroup(after: .sidebar) {
      Button(menu.listHidden ? UICopy.shortcutShowList : UICopy.shortcutHideList) {
        shortcuts?.perform(.toggleList)
      }
      .keyboardShortcut(AppShortcut.toggleList.keyboardShortcut)
      .disabled(!menu.canToggleList)
      // Prawy panel sesji na iPadzie. Kursywy nie ma (formatowanie zdjęte wyżej).
      Button(menu.inspectorVisible ? UICopy.shortcutHideInspector : UICopy.shortcutShowInspector) {
        shortcuts?.perform(.toggleInspector)
      }
      .keyboardShortcut(AppShortcut.toggleInspector.keyboardShortcut)
      .disabled(!menu.canToggleInspector)
      textSizeCommands
    }
    CommandMenu(UICopy.shortcutsMenu) {
      // With the session switcher window open, Cmd+digit picks its row instead of the tab.
      ForEach(menu.tabs, id: \.number) { tab in
        Button(UICopy.shortcutTab(tab.number, label: tab.label)) {
          guard shortcuts?.switcherDigit(tab.number) != true else { return }
          shortcuts?.perform(.tab(tab.target))
        }
        .keyboardShortcut(KeyEquivalent(Character(String(tab.number))), modifiers: .command)
      }
      if let last = menu.lastTab {
        Button(UICopy.shortcutLastTab) {
          guard shortcuts?.switcherDigit(9) != true else { return }
          shortcuts?.perform(.tab(last))
        }
        .keyboardShortcut("9", modifiers: .command)
      }
      Divider()
      Button(UICopy.shortcutPreviousProject(menu.previousProject)) { shortcuts?.perform(.previousProject) }
        .keyboardShortcut(AppShortcut.previousProject.keyboardShortcut)
        .disabled(menu.previousProject == nil)
      // Session switcher. Tytuły stałe, pozycje zawsze aktywne: tytuł albo stan
      // zmieniany w locie odpala polecenie drugi raz. Gdy nie ma dokąd iść, polecenie milczy.
      Button(UICopy.switcherNext) { shortcuts?.switchSession(false) }
        .keyboardShortcut(AppShortcut.nextSession.keyboardShortcut)
      Button(UICopy.switcherPrevious) { shortcuts?.switchSession(true) }
        .keyboardShortcut(AppShortcut.previousSession.keyboardShortcut)
      // Przeczytane ↔ nieprzeczytane zaznaczonej sesji. Stały tytuł i zawsze aktywne, z tego samego powodu co
      // przełącznik wyżej; bez stojącego wyniku polecenie milczy.
      Button(UICopy.shortcutReadToggle) { shortcuts?.perform(.toggleRead) }
        .keyboardShortcut(AppShortcut.toggleRead.keyboardShortcut)
      Divider()
      // Okna terminala nad ekranem: ten sam skrót zamyka, drugi przełącza. Litery F i G
      // zostają apce także z fokusem w terminalu (`TerminalKeyMap.appLetters`).
      Button(UICopy.shortcutPopupShell) { shortcuts?.perform(.popup(.popup)) }
        .keyboardShortcut(AppShortcut.popupShell.keyboardShortcut)
        .disabled(!menu.canPopup)
      Button(UICopy.shortcutPopupLazygit) { shortcuts?.perform(.popup(.lazygit)) }
        .keyboardShortcut(AppShortcut.popupLazygit.keyboardShortcut)
        .disabled(!menu.canPopup)
      Divider()
      // Notatka projektu: ten sam skrót otwiera formularz i zamyka go z zapisem.
      Button(UICopy.noteShortcut) { shortcuts?.perform(.note) }
        .keyboardShortcut(AppShortcut.note.keyboardShortcut)
        .disabled(!menu.canNote)
    }
  }

  /// The app's text size (`TextScale`). Make Text Bigger shows “⌘+” in tips and the shortcut sheet and is registered
  /// here as ⌘=; its ⇧⌘= sits on an invisible button at the root of the views (`TextScaleAlternateKeys`). The commands
  /// work over sheets and next to the open session switcher, which stays open; only ⌘0 goes to the switcher first,
  /// where it picks row 0, in whichever order UIKit delivers the press. A command at the end of its range is disabled,
  /// and so is every command while the scene has given no state yet, like the other commands of the menu.
  @ViewBuilder private var textSizeCommands: some View {
    // The state comes as a value of the scene (drawn by the root view), so the menu draws again after each step.
    let size = shortcuts?.textSize ?? TextSizeMenu()
    Divider()
    Button(UICopy.textSizeBigger) { shortcuts?.textScale.grow() }
      .keyboardShortcut(AppShortcut.textBigger.keyboardShortcut)
      .disabled(!size.canGrow)
    Button(UICopy.textSizeSmaller) { shortcuts?.textScale.shrink() }
      .keyboardShortcut(AppShortcut.textSmaller.keyboardShortcut)
      .disabled(!size.canShrink)
    Button(UICopy.textSizeActualSize) {
      guard shortcuts?.switcherDigit(0) != true else { return }
      shortcuts?.textScale.reset()
    }
    .keyboardShortcut(AppShortcut.textActualSize.keyboardShortcut)
    .disabled(!size.canReset)
  }
}
#endif
