import Foundation
@testable import RarogUI
import Testing

// The shortcut sheet's key caps and its trace lines (`ShortcutSheetTrace.swift`). Owner: shortcuts.

@Suite("shortcut sheet: key caps and trace lines")
struct ShortcutSheetTraceTests {
  @Test(
    "each modifier glyph is its own cap, the rest one cap",
    arguments: [
      ("⇧⌘N", ["⇧", "⌘", "N"]), ("⌘1–8", ["⌘", "1–8"]), ("⌥⌘V", ["⌥", "⌘", "V"]), ("⌘↩", ["⌘", "↩"]),
      ("Esc", ["Esc"]), ("↩", ["↩"]),
    ])
  func keycaps(glyphs: String, caps: [String]) {
    #expect(ShortcutSheetKeycaps.split(glyphs) == caps)
  }

  @Test("every combination of the sheet splits into caps that join back to it")
  func everyCombination() {
    let everything = ShortcutSheetCapabilities(notes: true, terminal: true, voiceAgent: true, wideIPad: true)
    let content = ShortcutSheetContent(place: .session, capabilities: everything, language: .en)
    let combos = ([content.here].compactMap { $0 } + content.columns.flatMap { $0 }).flatMap(\.rows).flatMap(\.combos)
    #expect(!combos.isEmpty)
    for combo in combos {
      let caps = ShortcutSheetKeycaps.split(combo)
      #expect(caps.joined() == combo && !caps.isEmpty, "\(combo)")
      #expect(caps.dropLast().allSatisfy { ShortcutSheetKeycaps.modifiers.contains(Character($0)) }, "\(combo)")
    }
  }

  @Test("a blocked sheet names every condition that stops it")
  func blocked() {
    let conditions = CommandHold.Conditions(keyWindow: false, loggedIn: true, switcherOpen: true, onMac: false)
    let line = ShortcutSheetTrace.line(.dropped(.blocked), place: .terminal, conditions: conditions)
    #expect(line.hasSuffix("blocked: window not key, switcher open"), "\(line)")
    #expect(ShortcutSheetTrace.line(.started(due: 3), place: nil, conditions: .init()).contains(ShortcutSheetTrace.source))
  }
}
