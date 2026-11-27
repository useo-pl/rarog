import Foundation
@testable import RarogUI
import Testing

// The shortcut row of the Dictation and Voice Agent pages (`ShortcutRowEditor`): a tap on the shortcut listens, the
// first valid combination is saved at once, a refusal keeps listening, and every other way out ends without a save.
// The keyboard and the menu rebuild are injected, so the row's rules run without a view. Owner: shortcuts.

@MainActor
@Suite("shortcut row in Settings: listen, save at once, refuse, cancel")
struct ShortcutRowEditorTests {
  typealias Combination = AppShortcut.Combination

  /// The row with its effects counted: keyboard taken and released, menus rebuilt.
  @MainActor
  final class Row {
    let scratch = AppShortcutSettingsTests.Scratch()
    let settings: AppShortcutSettings
    let editor: ShortcutRowEditor
    var taken = 0
    var released = 0
    var rebuilt = 0
    var takeSucceeds = true

    init(_ shortcut: AppShortcut = .dictation) {
      settings = AppShortcutSettings(defaults: scratch.defaults)
      editor = ShortcutRowEditor(shortcut: shortcut, settings: settings)
      editor.takeKeyboard = { [unowned self] in
        taken += 1
        return takeSucceeds
      }
      editor.releaseKeyboard = { [unowned self] in released += 1 }
      editor.rebuildMenus = { [unowned self] in rebuilt += 1 }
    }
  }

  static let optionCommandK = Combination(key: .character("k"), modifiers: [.option, .command])
  static let escape = Combination(key: .escape, modifiers: [])

  @Test("listening + ⌥⌘K: saved, the pill shows ⌥⌘K, the keyboard given back, menus rebuilt once")
  func validCombinationSavesAtOnce() {
    let row = Row()
    row.editor.tap(keyboard: true)
    #expect(row.editor.listening)
    #expect(row.taken == 1)

    row.editor.press(Self.optionCommandK)
    #expect(!row.editor.listening)
    #expect(row.editor.refusal == nil)
    #expect(row.editor.combination.glyphs == "⌥⌘K")
    #expect(row.settings.combination(for: .dictation) == Self.optionCommandK)
    #expect(row.released == 1)
    #expect(row.rebuilt == 1)
  }

  @Test("a second change right after the first works the same way")
  func secondSaveRightAfter() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.press(Self.optionCommandK)
    row.editor.tap(keyboard: true)
    #expect(row.editor.listening)
    let controlD = Combination(key: .character("d"), modifiers: [.control])
    row.editor.press(controlD)
    #expect(!row.editor.listening)
    #expect(row.editor.combination.glyphs == "⌃D")
    #expect(row.taken == 2)
    #expect(row.released == 2)
    #expect(row.rebuilt == 2)
  }

  @Test("listening + K without a modifier: refused for the modifier, still listening, nothing saved")
  func bareKeyIsRefused() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.press(Combination(key: .character("k"), modifiers: []))
    #expect(row.editor.listening)
    #expect(row.editor.refusal == .needsModifier)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
    #expect(row.released == 0)
    #expect(row.rebuilt == 0)

    // A valid combination after the refusal saves and clears the sentence.
    row.editor.press(Self.optionCommandK)
    #expect(!row.editor.listening)
    #expect(row.editor.refusal == nil)
    #expect(row.editor.combination == Self.optionCommandK)
  }

  @Test("listening + the other shortcut's combination: refused as taken")
  func otherShortcutIsTaken() {
    let row = Row(.dictation)
    row.editor.tap(keyboard: true)
    row.editor.press(AppShortcut.voiceAgent.defaultCombination)
    #expect(row.editor.listening)
    #expect(row.editor.refusal == .taken)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }

  @Test("listening + Esc: ends without a change; a key after that saves nothing")
  func escapeCancels() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.press(Combination(key: .character("k"), modifiers: []))
    row.editor.press(Self.escape)
    #expect(!row.editor.listening)
    #expect(row.editor.refusal == nil)
    #expect(row.released == 1)

    row.editor.press(Self.optionCommandK)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
    #expect(row.rebuilt == 0)
  }

  @Test("listening + a second tap on the pill: ends without a save")
  func secondTapCancels() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.tap(keyboard: true)
    #expect(!row.editor.listening)
    #expect(row.released == 1)
    #expect(row.taken == 1)
    row.editor.press(Self.optionCommandK)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }

  @Test("listening + the row goes away (or a tap beside, or the keyboard disconnects): ends without a save")
  func stopCancels() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.stop()
    #expect(!row.editor.listening)
    #expect(row.released == 1)
    row.editor.stop()
    #expect(row.released == 1, "a second stop releases nothing")
    row.editor.press(Self.optionCommandK)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }

  @Test("someone else took the keyboard: listening ends, nothing to release, a key after that saves nothing")
  func keyboardLostEnds() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.keyboardLost()
    #expect(!row.editor.listening)
    #expect(row.released == 0)
    row.editor.press(Self.optionCommandK)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }

  @Test("the keyboard refused (no window): the row does not listen")
  func refusedKeyboardDoesNotListen() {
    let row = Row()
    row.takeSucceeds = false
    row.editor.tap(keyboard: true)
    #expect(!row.editor.listening)
    row.editor.press(Self.optionCommandK)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }

  @Test("without a hardware keyboard the pill only shows the shortcut")
  func noKeyboardOnlyShows() {
    let row = Row()
    row.editor.tap(keyboard: false)
    #expect(!row.editor.listening)
    #expect(row.taken == 0)
  }

  @Test("a shortcut that differs from its default offers Restore Default; restoring gives the default back")
  func restoreDefault() {
    let row = Row()
    #expect(!row.editor.differsFromDefault)
    row.editor.tap(keyboard: true)
    row.editor.press(Self.optionCommandK)
    #expect(row.editor.differsFromDefault)

    row.editor.restoreDefault()
    #expect(row.editor.refusal == nil)
    #expect(!row.editor.differsFromDefault)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
    #expect(row.rebuilt == 2)
  }

  @Test("Restore Default while the other shortcut holds the default: refused as taken, nothing changes")
  func restoreDefaultTaken() {
    let row = Row(.dictation)
    row.editor.tap(keyboard: true)
    row.editor.press(Self.optionCommandK)
    #expect(row.settings.save(AppShortcut.dictation.defaultCombination, for: .voiceAgent) == nil)

    row.editor.restoreDefault()
    #expect(row.editor.refusal == .taken)
    #expect(row.editor.combination == Self.optionCommandK)
    #expect(row.rebuilt == 1)
  }

  @Test("Restore Default while listening ends the listening first")
  func restoreDefaultWhileListening() {
    let row = Row()
    row.editor.tap(keyboard: true)
    row.editor.press(Self.optionCommandK)
    row.editor.tap(keyboard: true)
    row.editor.restoreDefault()
    #expect(!row.editor.listening)
    #expect(row.released == 2)
    #expect(row.editor.combination == AppShortcut.dictation.defaultCombination)
  }
}
