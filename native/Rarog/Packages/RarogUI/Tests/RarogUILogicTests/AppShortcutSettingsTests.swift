import Foundation
import Observation
@testable import RarogUI
import Testing

// The dictation and voice agent shortcuts chosen in Settings (`AppShortcutSettings`): stored per device in an injected
// `UserDefaults`, checked before saving, and read by `AppShortcut` everywhere the shortcut is registered or shown.
// Owner: shortcuts.

@Suite("changeable shortcuts: dictation and the voice agent, per device")
struct AppShortcutSettingsTests {
  /// The test's own `UserDefaults` domain, removed after the test (it touches neither the app's domain nor other tests).
  final class Scratch {
    let name = "rarog-test-shortcuts-\(UUID().uuidString)"
    let defaults: UserDefaults

    init() {
      // swiftlint:disable:next force_unwrapping
      defaults = UserDefaults(suiteName: name)!
    }

    deinit {
      defaults.removePersistentDomain(forName: name)
    }
  }

  typealias Combination = AppShortcut.Combination

  @Test("nothing saved: dictation ⌥⌘M, voice agent ⌥⌘V")
  func defaultsWithoutSave() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    #expect(settings.combination(for: .dictation).glyphs == "⌥⌘M")
    #expect(settings.combination(for: .voiceAgent).glyphs == "⌥⌘V")
    #expect(AppShortcutSettings.configurable == [.dictation, .voiceAgent])
  }

  @Test("⌃⌥D for dictation is saved, read back and read by a new store over the same domain")
  func saveAndReadBack() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    let refusal = settings.save(Combination(key: .character("d"), modifiers: [.control, .option]), for: .dictation)
    #expect(refusal == nil)
    let saved = settings.combination(for: .dictation)
    #expect(saved.glyphs == "⌃⌥D")
    #expect(saved.input == "d")
    #expect(saved.modifiers == [.control, .option])
    #expect(settings.combination(for: .voiceAgent).glyphs == "⌥⌘V", "the other shortcut keeps its default")
    let fresh = AppShortcutSettings(defaults: scratch.defaults)
    #expect(fresh.combination(for: .dictation).glyphs == "⌃⌥D")
  }

  @Test("a captured key is case-insensitive: ⌃⌥ with “D” is the same combination as with “d”")
  func capturedUppercase() {
    #expect(Combination(key: .character("D"), modifiers: [.control, .option])
      == Combination(key: .character("d"), modifiers: [.control, .option]))
  }

  @Test(
    "refusals: no ⌘, ⌥ or ⌃; not a letter or digit; a system shortcut; a combination another shortcut uses",
    arguments: [
      (Combination(key: .character("n"), modifiers: .command), AppShortcutSettings.Refusal.taken),
      (Combination(key: .character("v"), modifiers: [.option, .command]), .taken),
      (Combination(key: .character("x"), modifiers: .command), .taken),
      (Combination(key: .character("1"), modifiers: .command), .taken),
      // ⌘W closes the note form, where dictation is registered too.
      (Combination(key: .character("w"), modifiers: .command), .taken),
      (Combination(key: .character("d"), modifiers: []), .needsModifier),
      (Combination(key: .character("d"), modifiers: .shift), .needsModifier),
      (Combination(key: .character("m"), modifiers: .command), .system),
      (Combination(key: .character("h"), modifiers: .command), .system),
      (Combination(key: .character("q"), modifiers: .command), .system),
      (Combination(key: .character("\t"), modifiers: .command), .system),
      (Combination(key: .character(" "), modifiers: .command), .system),
      (Combination(key: .character(","), modifiers: .command), .system),
      (Combination(key: .character("-"), modifiers: [.option, .command]), .needsLetterOrDigit),
      // The text size keys of the app menu: ⌘= and ⇧⌘= enlarge, ⌘- reduces, ⌘0 gives the system size back.
      (Combination(key: .character("="), modifiers: .command), .needsLetterOrDigit),
      (Combination(key: .character("="), modifiers: [.shift, .command]), .needsLetterOrDigit),
      (Combination(key: .character("-"), modifiers: .command), .needsLetterOrDigit),
      (Combination(key: .character("0"), modifiers: .command), .taken),
      (Combination(key: .returnKey, modifiers: .command), .needsLetterOrDigit),
    ])
  func refusals(combination: Combination, refusal: AppShortcutSettings.Refusal) {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    #expect(settings.check(combination, for: .dictation) == refusal)
    #expect(settings.save(combination, for: .dictation) == refusal)
    #expect(settings.combination(for: .dictation).glyphs == "⌥⌘M", "a refused combination is not saved")
    #expect(scratch.defaults.dictionaryRepresentation().keys.allSatisfy { !AppShortcutSettings.keys.contains($0) })
  }

  @Test("allowed: a digit with ⌥⌘, a letter with ⇧⌃, the shortcut's own current combination")
  func allowed() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    #expect(settings.check(Combination(key: .character("7"), modifiers: [.option, .command]), for: .dictation) == nil)
    #expect(settings.check(Combination(key: .character("k"), modifiers: [.shift, .control]), for: .voiceAgent) == nil)
    #expect(settings.check(Combination(key: .character("m"), modifiers: [.option, .command]), for: .dictation) == nil)
  }

  @Test("dictation and the voice agent cannot share a combination, whichever moves")
  func mutualConflict() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    #expect(settings.save(Combination(key: .character("d"), modifiers: [.control, .option]), for: .voiceAgent) == nil)
    #expect(settings.check(Combination(key: .character("d"), modifiers: [.control, .option]), for: .dictation) == .taken)
    #expect(settings.check(Combination(key: .character("v"), modifiers: [.option, .command]), for: .dictation) == nil,
            "⌥⌘V is free once the voice agent moved away")
  }

  @Test("Restore Default after ⌃⌥D gives ⌥⌘M back and removes the saved value")
  func restoreDefault() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    _ = settings.save(Combination(key: .character("d"), modifiers: [.control, .option]), for: .dictation)
    #expect(settings.restoreDefault(.dictation) == nil)
    #expect(settings.combination(for: .dictation).glyphs == "⌥⌘M")
    #expect(scratch.defaults.object(forKey: AppShortcutSettings.key(.dictation)) == nil)
  }

  @Test("Restore Default is refused while the other shortcut holds the default combination")
  func restoreDefaultTaken() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    _ = settings.save(Combination(key: .character("d"), modifiers: [.control, .option]), for: .dictation)
    _ = settings.save(Combination(key: .character("m"), modifiers: [.option, .command]), for: .voiceAgent)
    #expect(settings.restoreDefault(.dictation) == .taken)
    #expect(settings.combination(for: .dictation).glyphs == "⌃⌥D")
  }

  @Test("an unreadable or no longer valid stored value reads as the default")
  func unreadableValue() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    for value: Any in ["", "command", "hyper+d", "command+m", "command+n", 42] {
      scratch.defaults.set(value, forKey: AppShortcutSettings.key(.dictation))
      #expect(settings.combination(for: .dictation).glyphs == "⌥⌘M", "\(value)")
    }
  }

  @Test("other shortcuts are not changeable and keep their combination")
  func notConfigurable() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    let free = Combination(key: .character("k"), modifiers: [.control, .option])
    #expect(settings.save(free, for: .newSession) == .notConfigurable)
    #expect(settings.combination(for: .newSession).glyphs == "⌘N")
  }

  @Test("a save is observable, so SwiftUI views that show the shortcut draw again")
  func observable() {
    let scratch = Scratch()
    let settings = AppShortcutSettings(defaults: scratch.defaults)
    let changed = Flag()
    withObservationTracking {
      _ = settings.combination(for: .dictation)
    } onChange: {
      changed.set()
    }
    _ = settings.save(Combination(key: .character("d"), modifiers: [.control, .option]), for: .dictation)
    #expect(changed.value)
  }

  @Test("the app's shortcuts read the shared settings: `AppShortcut.dictation` is the stored combination")
  func appShortcutReadsSettings() {
    #expect(AppShortcut.dictation.combination == AppShortcutSettings.shared.combination(for: .dictation))
    #expect(AppShortcut.voiceAgent.combination == AppShortcutSettings.shared.combination(for: .voiceAgent))
    #expect(AppShortcut.dictation.defaultCombination.glyphs == "⌥⌘M")
    #expect(AppShortcut.voiceAgent.defaultCombination.glyphs == "⌥⌘V")
  }

  /// A thread-safe flag for the observation callback.
  final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    func set() { lock.withLock { raised = true } }
    var value: Bool { lock.withLock { raised } }
  }
}
