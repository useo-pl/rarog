import Foundation
@testable import RarogUI
import Testing

// Strażnik źródeł przełącznika sesji. Stan klawiszy sprzętowych ma JEDNO miejsce w kodzie,
// tytuły poleceń menu są stałe, a testy nie udają trzymanego Cmd. Właściciel: skróty.

@Suite("przełącznik sesji: strażnik źródeł")
struct SessionSwitcherSourceTests {
  static let packages = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

  /// Pliki Swift pakietu z kodem bez komentarzy (zdanie o `GCKeyboard` w komentarzu to nie jego użycie).
  static func code(package: String) throws -> [(path: String, code: String)] {
    let sources = packages.appending(path: "\(package)/Sources")
    let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    return try files.map { file in
      let text = try String(contentsOf: file, encoding: .utf8)
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
        .joined(separator: "\n")
      return (String(file.path.dropFirst(sources.path.count + 1)), text)
    }
  }

  @Test("only Model/HardwareKeys.swift reads the GCKeyboard key state (RarogUI and RarogTerminal)")
  func oneKeyboardStateAccess() throws {
    let files = try Self.code(package: "RarogUI") + Self.code(package: "RarogTerminal")
    #expect(files.count > 60, "skan widzi za mało plików źródeł")
    let owner = "RarogUI/Model/HardwareKeys.swift"
    #expect(files.contains { $0.path == owner && $0.code.contains("button(forKeyCode:") }, "właściciel czyta stan")
    for marker in ["button(forKeyCode:", "keyChangedHandler", "pressedChangedHandler"] {
      let offenders = files.filter { $0.path != owner && $0.code.contains(marker) }.map(\.path)
      #expect(offenders.isEmpty, "\(marker): \(offenders)")
    }
  }

  @Test("polecenia menu przełącznika: stałe tytuły z copy, zawsze aktywne (bez `.disabled`), skróty Cmd+S i Shift+Cmd+S")
  func menuCommands() throws {
    let commands = try #require(try Self.code(package: "RarogUI").first { $0.path == "RarogUI/Views/RarogCommands.swift" })
    let lines = commands.code.split(separator: "\n").map(String.init)
    #expect(AppShortcut.nextSession.glyphs == "⌘S" && AppShortcut.previousSession.glyphs == "⇧⌘S")
    for (title, shortcut) in [
      ("UICopy.switcherNext", ".keyboardShortcut(AppShortcut.nextSession.keyboardShortcut)"),
      ("UICopy.switcherPrevious", ".keyboardShortcut(AppShortcut.previousSession.keyboardShortcut)"),
    ] {
      let index = try #require(lines.firstIndex { $0.contains("Button(\(title))") }, "\(title)")
      #expect(lines[index + 1].contains(shortcut), "\(title): skrót w następnej linii")
      #expect(!lines[index + 2].contains(".disabled"), "\(title): pozycja zawsze aktywna")
    }
  }

  @Test("a tap on the current tab opens the window through the host gate; key hints only with the keyboard")
  func tapOnCurrentTab() throws {
    let files = try Self.code(package: "RarogUI")
    let slot = try #require(files.first { $0.path == "RarogUI/Views/Header/HeaderTabsSlot.swift" }).code
    #expect(slot.contains("if tab.current, let switcher {"), "bieżąca zakładka przed nawigacją")
    #expect(slot.contains("SessionSwitcherHost.openByTap(switcher: switcher, store: store, navigation: navigation)"),
            "ta sama bramka co polecenie: zalogowanie i nic zaprezentowanego")
    let overlay = try #require(files.first { $0.path == "RarogUI/Switcher/SessionSwitcherOverlay.swift" }).code
    #expect(overlay.contains("let shown = switcher.windowShown"), "the window from the command and from a tap")
    #expect(overlay.contains("if switcher.holdsKeyboard { footer }"), "no key hints in a window without the keyboard")
    #expect(overlay.contains("SwitcherKeyAnchor(switcher: switcher)"), "the key receiver of the window in the overlay")
    #expect(overlay.contains(".accessibilityAction(.escape) { switcher.cancel(.outside) }"),
            "gest „wstecz” czytnika zamyka okno — puste okno nie ma innego wyjścia dla czytnika")
  }

  @Test("digits: the window's keys 0–9 with and without Cmd, Cmd+1–9 of the menu ask the window first")
  func digitRoutes() throws {
    let files = try Self.code(package: "RarogUI")
    let responder = try #require(files.first { $0.path == "RarogUI/Switcher/SwitcherKeyResponder.swift" }).code
    #expect(SwitcherKey.digits == ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
    #expect(responder.contains("for digit in SwitcherKey.digits"), "every digit is a key of the window")
    #expect(responder.contains("for modifiers in [[], .command, .numericPad, [.numericPad, .command]]"),
            "with and without Cmd (still held after Cmd+S), the top row and the keypad")
    let commands = try #require(files.first { $0.path == "RarogUI/Views/RarogCommands.swift" }).code
    #expect(commands.contains("guard shortcuts?.switcherDigit(tab.number) != true else { return }"),
            "Cmd+1–8: the open window wins over the tab")
    #expect(commands.contains("guard shortcuts?.switcherDigit(9) != true else { return }"),
            "Cmd+9: the open window wins over the last tab")
    let overlay = try #require(files.first { $0.path == "RarogUI/Switcher/SessionSwitcherOverlay.swift" }).code
    #expect(overlay.contains("SwitcherRows.digitKey(at: index, keyboard: switcher.holdsKeyboard)"),
            "digit keys only in a window that holds the keyboard")
  }

  @Test("no faked held Cmd: the UI test flag and the Cmd release button are gone from the app and test sources")
  func noHeldCommandFake() throws {
    let root = Self.packages.deletingLastPathComponent()
    let dirs = ["Packages/RarogUI/Sources", "RarogUITests", "RarogUIKitTests", "Rarog"]
    var offenders: [String] = []
    for dir in dirs {
      let base = root.appending(path: dir)
      let files = try #require(FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil))
        .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
      for file in files {
        let text = try String(contentsOf: file, encoding: .utf8)
        if text.contains("RAROG_UI_TEST_SWITCHER_HOLD") || text.contains("switcher.release") {
          offenders.append(file.lastPathComponent)
        }
      }
    }
    #expect(offenders.isEmpty, "\(offenders)")
  }

  @Test("tytuły poleceń przełącznika są stałe: bez interpolacji i bez funkcji")
  func constantCommandTitles() throws {
    let copy = try #require(try Self.code(package: "RarogUI").first { $0.path == "RarogUI/Copy/UICopy+Switcher.swift" })
    for name in ["switcherNext", "switcherPrevious"] {
      let lines = copy.code.split(separator: "\n").filter { $0.contains(name) }
      #expect(lines.count == 1, "\(name): jedna definicja")
      let line = String(lines.first ?? "")
      // Tekst idzie z katalogu języka: wyliczane `static var` z kluczem bez argumentów jest stałe
      // przez cały proces (język procesu się nie zmienia), więc tytuł polecenia nie zmienia się w locie.
      #expect(line.contains("public static var \(name): String { L(\"switcher."), "\(name): tekst z katalogu, nie funkcja")
      #expect(line.hasSuffix("\") }"), "\(name): klucz bez argumentów — tytuł nie zależy od stanu")
      #expect(!line.contains("\\("), "\(name): bez interpolacji")
    }
  }
}
