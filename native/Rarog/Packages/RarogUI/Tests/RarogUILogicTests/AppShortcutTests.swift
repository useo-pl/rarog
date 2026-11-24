import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Skróty przycisków: jedna definicja skrótu (`AppShortcut`), z niej rejestracja
// i podpowiedź „Nazwa (⌘B)”, którą własny dymek pokazuje po najechaniu kursorem. Właściciel: skróty.

@Suite("skróty przycisków: jedna definicja, podpowiedź „Nazwa (skrót)” i własny dymek")
struct AppShortcutTests {
  /// Kod bez komentarzy (jak `SessionListSourceTests.code`).
  private static func code(_ relative: String) throws -> String {
    try SessionListSourceTests.code(relative)
  }

  @Test("glify w kolejności ⌃⌥⇧⌘, potem klawisz: litera wielka, Return „↩”, Escape „Esc”")
  func glyphOrder() {
    #expect(AppShortcut.newSession.glyphs == "⌘N")
    #expect(AppShortcut.newTerminal.glyphs == "⇧⌘N")
    #expect(AppShortcut.toggleList.glyphs == "⌘B")
    #expect(AppShortcut.toggleInspector.glyphs == "⌘I")
    #expect(AppShortcut.popupShell.glyphs == "⌘F")
    #expect(AppShortcut.closeTab.glyphs == "⌘X")
    #expect(AppShortcut.note.glyphs == "⌘J")
    #expect(AppShortcut.dictation.glyphs == "⌥⌘M")
    #expect(AppShortcut.voiceAgent.glyphs == "⌥⌘V")
    #expect(AppShortcut.send.glyphs == "↩")
    #expect(AppShortcut.stop.glyphs == "Esc")
    #expect(AppShortcut.dismissSheet.glyphs == "Esc")
    #expect(AppShortcut.closeSheet.glyphs == "⌘W")
    #expect(AppShortcut.launchSession.glyphs == "⌘↩")
    #expect(AppShortcut.terminalHistory.glyphs == "⌘Y")
    // Make Text Bigger shows the key cap “+” but registers ⌘= and ⇧⌘=; the others show what they register.
    #expect(AppShortcut.textBigger.glyphs == "⌘+")
    #expect(AppShortcut.textBigger.input == "=" && AppShortcut.textBigger.modifiers == .command)
    #expect(AppShortcut.textBigger.alternateCombinations.map(\.glyphs) == ["⇧⌘="])
    #expect(AppShortcut.textSmaller.glyphs == "⌘-")
    #expect(AppShortcut.textActualSize.glyphs == "⌘0")
    #expect(AppShortcut.allCases.filter { !$0.alternateCombinations.isEmpty } == [.textBigger])
    let every: AppShortcut.Modifiers = [.command, .shift, .option, .control]
    #expect(AppShortcut.glyphs(key: .character("k"), modifiers: every) == "⌃⌥⇧⌘K", "kolejność Apple, nie zapisu")
    #expect(AppShortcut.glyphs(key: .escape, modifiers: .command) == "⌘Esc")
  }

  @Test("kombinacja jednoznaczna wszędzie tam, gdzie dwa skróty działają naraz (menu apki działa wszędzie)")
  func uniqueCombinations() {
    let all = AppShortcut.allCases
    #expect(all.count >= 19, "skróty arkusza i skróty samego menu")
    for (index, first) in all.enumerated() {
      for second in all.dropFirst(index + 1) where first.overlaps(second) {
        #expect(
          first.key != second.key || first.modifiers != second.modifiers,
          "\(first) i \(second): ta sama kombinacja \(first.glyphs) w tym samym miejscu")
      }
    }
    // Esc zatrzymuje turę na ekranie sesji i zamyka arkusz — dwa miejsca, które nie działają naraz.
    #expect(!AppShortcut.stop.overlaps(.dismissSheet))
    #expect(AppShortcut.closeTab.scopes == [.session, .terminal], "⌘X: zakładka sesji i terminal")
    #expect(AppShortcut.newSession.overlaps(.dismissSheet), "menu apki działa także nad arkuszem")
  }

  @Test("podpowiedź „Nazwa (skrót)” z katalogu; glify spoza katalogu; kilka skrótów jednej akcji po przecinku")
  func helpText() {
    #expect(UICopy.shortcutHelp("Nowa sesja", [.newSession]) == "Nowa sesja (⌘N)")
    #expect(UICopy.shortcutHelp("Zamknij", [.dismissSheet, .closeSheet]) == "Zamknij (Esc, ⌘W)")
    #expect(L("shortcuts.help", language: .en, "New session", "⌘N") == "New session (⌘N)")
    #expect(L("shortcuts.help", language: .pl, "Nowa sesja", "⌘N") == "Nowa sesja (⌘N)")
    let line = ShortcutTipLine(UICopy.newTerminal, .newTerminal)
    #expect(line.text == "\(UICopy.newTerminal) (⇧⌘N)")
    let lines = ShortcutTipLine.text([ShortcutTipLine("A", .newSession), ShortcutTipLine("B", .newTerminal)])
    #expect(lines == "A (⌘N)\nB (⇧⌘N)", "menu „+”: wiersz na pozycję")
  }

  @Test("⌘X w polu z zaznaczeniem wycina; skrót ekranu sesji to ⌘X z definicji")
  func commandXCutsSelection() throws {
    #expect(CloseTabKey(composerFocused: true, selectionLength: 3, canClose: true) == .cut)
    #expect(CloseTabKey(composerFocused: true, selectionLength: 0, canClose: true) == .close)
    let tabs = try Self.code("Session/SessionViewController+KeysTabs.swift")
    #expect(AppShortcut.closeTab.input == "x" && AppShortcut.closeTab.modifiers == .command)
    #expect(tabs.contains("input: \"x\", modifierFlags: .command"), "rejestracja zgodna z `AppShortcut.closeTab`")
    #expect(tabs.contains("composer.textView.cut(nil)"), "zaznaczenie wycina")
  }

  @Test("rejestracje skrótów przycisków czytają `AppShortcut`; literały ekranu sesji zgodne z definicją")
  func registrationsFromDefinition() throws {
    let commands = try Self.code("Views/RarogCommands.swift")
    for shortcut in [AppShortcut.newSession, .newTerminal, .toggleList, .toggleInspector, .previousProject,
                     .toggleRead, .popupShell, .popupLazygit, .note, .textBigger,
                     .textSmaller, .textActualSize] {
      #expect(commands.contains(".keyboardShortcut(AppShortcut.\(shortcut).keyboardShortcut)"), "menu: \(shortcut)")
    }
    #expect(try Self.code("Views/TextScale/TextScaleAlternateKeys.swift")
      .contains("AppShortcut.textBigger.alternateCombinations"), "⇧⌘= for Make Text Bigger")
    let voice = try Self.code("Session/SessionViewController+KeysVoice.swift")
    #expect(voice.contains("AppShortcut.dictation"), "dyktowanie z definicji")
    let escape = try Self.code("Views/Presentation/EscapeDismiss.swift")
    #expect(escape.contains(".keyboardShortcut(AppShortcut.dismissSheet.keyboardShortcut)"))
    #expect(escape.contains(".keyboardShortcut(AppShortcut.closeSheet.keyboardShortcut)"))
    let launch = try Self.code("Views/NewSession/NewSessionSheet.swift")
    #expect(launch.contains(".keyboardShortcut(AppShortcut.launchSession.keyboardShortcut)"))
    let history = try Self.code("Terminal/TerminalHistorySheet.swift")
    #expect(history.contains(".keyboardShortcut(AppShortcut.terminalHistory.keyboardShortcut)"))
    // Pole wiadomości i przerwanie rejestrują same (UIKit); definicja mówi to samo.
    #expect(AppShortcut.send.input == "\r" && AppShortcut.send.modifiers.isEmpty)
    #expect(try Self.code("Session/ComposerTextView.swift").contains("action: #selector(hardwareReturn), input: \"\\r\")"))
    #expect(AppShortcut.stop.key == .escape && AppShortcut.stop.modifiers.isEmpty)
    #expect(try Self.code("Session/SessionViewController+KeysInterrupt.swift").contains("UIKeyCommand.inputEscape"))
  }

  /// Przyciski ze skrótem i podpowiedź każdego: (plik, fragment kodu).
  static let tips: [(String, String)] = [
    ("Views/NewSession/NewSessionListButton.swift", ".shortcutTip(UICopy.newSessionTitle, .newSession)"),
    ("Views/Projects/ProjectTabBar.swift", "ShortcutTipLine(UICopy.newSessionTitle, .newSession)"),
    ("Views/Projects/ProjectTabBar.swift", "ShortcutTipLine(UICopy.newTerminal, .newTerminal)"),
    ("Views/Projects/TabCloseButton.swift", ".shortcutTip(model.label, .closeTab)"),
    ("Views/Header/HeaderTitleSlot.swift", ".shortcutTip(label, .toggleList)"),
    ("Views/Inspector/InspectorToggleButton.swift", ".shortcutTip(UICopy.inspectorButton, .toggleInspector)"),
    ("Views/SessionControl/HeaderSessionSlot.swift", ".shortcutTip(UICopy.shortcutPopupShell, .popupShell)"),
    ("Views/SessionControl/HeaderSessionSlot.swift", ".shortcutTip(UICopy.terminalClose, .closeTab)"),
    ("Views/Notes/NoteTabButton.swift", ".shortcutTip(UICopy.noteProject, .note)"),
    ("Views/Presentation/SheetScaffold.swift", ".shortcutTip(close.label, .dismissSheet, .closeSheet)"),
    ("Views/NewSession/NewSessionSheet.swift", ".shortcutTip(UICopy.launch, .launchSession)"),
    ("Session/Voice/VoiceViews.swift", "ShortcutTipLine(UICopy.voiceMic, .dictation)"),
    ("Session/ComposerActionBar.swift", "ShortcutTipLine(UICopy.send, .send)"),
    ("Session/ComposerActionBar.swift", "ShortcutTipLine(UICopy.stop, .stop)"),
    ("Terminal/TerminalKeyBar.swift", "ShortcutTipLine(UICopy.terminalHistory, .terminalHistory)"),
  ]

  @Test("strażnik: każdy przycisk z listy ma podpowiedź ze skrótem z `AppShortcut`, bez drugiego dymka systemowego")
  func everyButtonHasTip() throws {
    for (file, fragment) in Self.tips {
      #expect(try Self.code(file).contains(fragment), "\(file): \(fragment)")
    }
    // Systemowy dymek (`.help`, `toolTip`) obok własnego dawał na Macu dwa dymki naraz.
    for file in Set(Self.tips.map(\.0)) {
      let code = try Self.code(file)
      #expect(!code.contains("toolTip"), "\(file): systemowy dymek UIKit")
      for name in ["UICopy.newSessionTitle", "label", "UICopy.inspectorButtonHelp", "UICopy.shortcutPopupShell",
                   "UICopy.terminalClose", "UICopy.sheetCloseHelp(close.label)"] {
        #expect(!code.contains(".help(\(name))"), "\(file): .help(\(name)) obok własnego dymka")
      }
    }
    // UIKit: ślad dymka mają dwa przyciski ekranu sesji i klawisz historii, każdy przez `ShortcutTipTracker`.
    for file in ["Session/Voice/VoiceViews.swift", "Session/ComposerActionBar.swift", "Terminal/TerminalKeyBar.swift"] {
      #expect(try Self.code(file).contains("ShortcutTipTracker("), "\(file)")
    }
  }

  @Test("guard: the sidebar's icon buttons without a shortcut show the name in the app's own tip, never the system one")
  func nameTips() throws {
    let tips = [
      ("Views/List/TreeRecentButton.swift", ".pointerTip(UICopy.recentSessionsTitle)"),
      ("Views/List/ProjectTreeHeaderRow.swift", ".pointerTip(UICopy.noteProject)"),
      ("Views/List/TreeTerminalButton.swift", ".pointerTip(UICopy.shortcutPopupShell)"),
      ("Views/Settings/SettingsSheet.swift", ".pointerTip(UICopy.settingsTitle)"),
      ("Views/List/ListFilterBar.swift", ".pointerTip(label)"),
      ("Views/Inbox/InboxButton.swift", ".pointerTip(UICopy.inboxTitle)"),
      ("Views/List/SessionRow.swift", ".pointerTip(tip)"),
    ]
    for (file, fragment) in tips {
      let code = try Self.code(file)
      #expect(code.contains(fragment), "\(file): \(fragment)")
      // `help(_:)` does not show on an iPad, and on a Mac it would stand beside the app's own tip.
      #expect(!code.contains(".help("), "\(file): system tip")
    }
  }

  @Test("czytnik: podpowiedź nie trafia do `accessibilityHint` ani do etykiety; dymek jest dla czytnika ukryty")
  func hintWithoutGlyphs() throws {
    let tip = try Self.code("Views/Common/ShortcutTip.swift")
    #expect(!tip.contains("accessibilityHint"), "mechanizm dymka nie ustawia podpowiedzi czytnika")
    #expect(!tip.contains("accessibilityLabel"), "ani etykiety")
    #expect(tip.contains("accessibilityElementsHidden = true"), "dymek ukryty dla czytnika")
    for file in Set(Self.tips.map(\.0)) {
      let code = try Self.code(file)
      #expect(!code.contains("accessibilityHint(UICopy.shortcutHelp"), "\(file)")
      #expect(!code.contains("accessibilityHint = UICopy.shortcutHelp"), "\(file)")
      #expect(!code.contains(".glyphs)"), "\(file): glif w tekście dla czytnika")
    }
    // Podpowiedzi czytnika przycisków z listy mówią słowami, nie glifami.
    for hint in [UICopy.stopHint, UICopy.voiceMicHint, UICopy.voiceMicStopHint, UICopy.noteTabReadHint,
                 UICopy.noteTabWriteHint] {
      #expect(!["⌘", "⌥", "⇧", "⌃", "Cmd+"].contains { hint.contains($0) }, "\(hint)")
    }
  }

  @Test("each changeable shortcut has its own row label on its Settings page, in both languages")
  func settingsRowLabels() {
    for language in [CopyLanguage.pl, .en] {
      let labels = AppShortcutSettings.configurable.map { UICopy.shortcutSettingsAction($0, language: language) }
      #expect(labels.allSatisfy { !$0.isEmpty }, "\(language)")
      #expect(Set(labels).count == labels.count, "\(language): \(labels)")
    }
  }
}

extension AppShortcutTests {
  /// Stan dymka bez UIKit: spoczynek kursora, chowanie przy wyjściu i naciśnięciu, dotyk bez dymka.
  @Suite("stan dymka: spoczynek, chowanie, dotyk")
  struct Tip {
    let rest = ShortcutTipState.rest

    @Test("dymek po chwili spoczynku kursora, nie wcześniej")
    func showsAfterRest() {
      var state = ShortcutTipState()
      state.pointerMoved(at: 10)
      #expect(state.due == 10 + rest)
      let tick1 = state.tick(at: 10 + rest - 0.01)
      #expect(!tick1, "przed czasem spoczynku")
      let tick2 = state.tick(at: 10 + rest)
      #expect(tick2, "po czasie spoczynku")
      #expect(state.shown)
      #expect(rest >= 0.3 && rest <= 1.0, "chwila, nie natychmiast i nie długo")
    }

    @Test("ruch przed pokazaniem liczy spoczynek od nowa; po pokazaniu ruch nad przyciskiem dymka nie chowa")
    func movementRestartsRest() {
      var state = ShortcutTipState()
      state.pointerMoved(at: 0)
      state.pointerMoved(at: rest * 0.8)
      let tick3 = state.tick(at: rest + 0.01)
      #expect(!tick3, "kursor w ruchu")
      let tick4 = state.tick(at: rest * 1.8 + 0.01)
      #expect(tick4)
      state.pointerMoved(at: 5)
      let tick5 = state.tick(at: 5)
      #expect(state.shown && tick5, "dymek stoi")
    }

    @Test("wyjście kursora chowa dymek i kasuje odliczanie")
    func exitHides() {
      var state = ShortcutTipState()
      state.pointerMoved(at: 0)
      _ = state.tick(at: rest)
      state.pointerExited()
      #expect(!state.shown && state.due == nil)
      state.pointerMoved(at: 1)
      state.pointerExited()
      let tick6 = state.tick(at: 5)
      #expect(!tick6, "odliczanie przerwane wyjściem")
    }

    @Test("naciśnięcie chowa dymek i nie pokazuje go znowu, dopóki kursor nie wyjdzie")
    func pressHides() {
      var state = ShortcutTipState()
      state.pointerMoved(at: 0)
      _ = state.tick(at: rest)
      state.pressed()
      #expect(!state.shown && state.due == nil)
      state.pointerMoved(at: 1)
      let tick7 = state.tick(at: 5)
      #expect(!tick7, "po kliknięciu nad tym samym przyciskiem bez dymka")
      state.pointerExited()
      state.pointerMoved(at: 6)
      let tick8 = state.tick(at: 6 + rest)
      #expect(tick8, "nowe najechanie — znowu dymek")
    }

    @Test("dotyk nie wywołuje dymka: bez zdarzenia kursora nie ma odliczania")
    func touchNeverShows() {
      var state = ShortcutTipState()
      state.pressed()
      let tick9 = state.tick(at: 100)
      #expect(state.due == nil && !tick9)
      var fresh = ShortcutTipState()
      let freshShown = fresh.tick(at: 100)
      #expect(!freshShown)
    }
  }
}
