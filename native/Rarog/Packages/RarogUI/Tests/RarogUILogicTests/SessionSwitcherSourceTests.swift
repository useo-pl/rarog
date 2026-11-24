import Foundation
@testable import RarogUI
import Testing

// Source guard of the session switcher: the hardware key state has ONE place in the code, the menu's Cmd+digits ask
// the window first, and the tests do not fake a held Cmd. Which tap opens the window is `ProjectTabModel.tap`
// (`SessionSwitcherRowsTests`). Owner: shortcuts.

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

  @Test("the window from a tap; key hints only with the keyboard; the VoiceOver back gesture closes it")
  func windowWiring() throws {
    let files = try Self.code(package: "RarogUI")
    let overlay = try #require(files.first { $0.path == "RarogUI/Switcher/SessionSwitcherOverlay.swift" }).code
    #expect(overlay.contains("let shown = switcher.windowShown"), "the window from a tap")
    #expect(overlay.contains("if switcher.holdsKeyboard { footer }"), "no key hints in a window without the keyboard")
    #expect(overlay.contains("SwitcherKeyAnchor(switcher: switcher)"), "the key receiver of the window in the overlay")
    #expect(overlay.contains(".accessibilityAction(.escape) { switcher.cancel(.outside) }"),
            "gest „wstecz” czytnika zamyka okno — puste okno nie ma innego wyjścia dla czytnika")
  }

  /// The SwiftUI menu commands have no seam a test can press: a Cmd+digit that does not ask the open window first
  /// would switch the tab under the window instead of picking its row.
  @Test("digits: Cmd+1–9 of the menu ask the window first")
  func digitRoutes() throws {
    let files = try Self.code(package: "RarogUI")
    let commands = try #require(files.first { $0.path == "RarogUI/Views/RarogCommands.swift" }).code
    #expect(commands.contains("guard shortcuts?.switcherDigit(tab.number) != true else { return }"),
            "Cmd+1–8: the open window wins over the tab")
    #expect(commands.contains("guard shortcuts?.switcherDigit(9) != true else { return }"),
            "Cmd+9: the open window wins over the last tab")
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
}
