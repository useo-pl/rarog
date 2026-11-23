import Foundation
import Observation
import Synchronization

/// The shortcuts a person changes on the Dictation and Voice Agent pages of Settings. The choice belongs
/// to the device (`UserDefaults`), not to the server; nothing saved means the default (``AppShortcut/defaultCombination``).
///
/// `AppShortcut.key` and `modifiers` read ``shared``, so every registration (the session screen's `UIKeyCommand`s, the
/// note form's SwiftUI shortcut), every tip “Name (⌥⌘M)” and the shortcut sheet follow a change without their own code.
/// UIKit asks for `keyCommands` each time; SwiftUI views draw again because a read registers with Observation and a
/// save notifies it.
///
/// A combination is refused (``Refusal``) and not saved when it has no ⌘, ⌥ or ⌃ (Shift alone does not count), its key
/// is not a letter or a digit, the system owns it (``systemCombinations``), or another app shortcut that works at the
/// same time already uses it (`AppShortcut.overlaps`, the tab digits ⌘1–9 of the menu included).
/// Owner: shortcuts.
public final class AppShortcutSettings: Observable, Sendable {
  public static let shared = AppShortcutSettings(defaults: .standard)

  /// The shortcuts Settings lets a person change.
  public static let configurable: [AppShortcut] = [.dictation, .voiceAgent]

  /// Why a combination is not saved.
  public enum Refusal: Equatable, Sendable {
    /// The shortcut is not changeable.
    case notConfigurable
    /// No ⌘, ⌥ or ⌃.
    case needsModifier
    /// The key is not a letter or a digit.
    case needsLetterOrDigit
    /// The system owns the combination.
    case system
    /// Another app shortcut that works at the same time uses the combination.
    case taken
  }

  /// Combinations the system keeps, in one list: on iPadOS 26 ⌘M minimizes the window and wins over an app shortcut
  /// even with `wantsPriorityOverSystemBehavior` (measured in the simulator); ⌘H, ⌘Q, ⌘Tab, ⌘Space and ⌘, belong to
  /// the system; ⌘A, ⌘C, ⌘V, ⌘Z and ⇧⌘Z edit text in the message field, and a session shortcut would take them over.
  public static let systemCombinations: Set<AppShortcut.Combination> = [
    command("m"), command("h"), command("q"), command("\t"), command(" "), command(","),
    command("a"), command("c"), command("v"), command("z"),
    AppShortcut.Combination(key: .character("z"), modifiers: [.shift, .command]),
  ]

  /// ⌘1–9 pick a tab in the app's menu (`RarogCommands`), which works everywhere; they are not `AppShortcut` cases.
  static let tabDigits: Set<AppShortcut.Combination> = Set((1...9).compactMap { digit in
    String(digit).first.map { command($0) }
  })

  private static func command(_ key: Character) -> AppShortcut.Combination {
    AppShortcut.Combination(key: .character(key), modifiers: .command)
  }

  /// The `UserDefaults` key of a changeable shortcut.
  public static func key(_ shortcut: AppShortcut) -> String { "rarog.shortcut.\(shortcut.rawValue)" }

  /// All keys this store writes (a reset before UI tests removes them).
  public static var keys: [String] { configurable.map(key) }

  /// `nonisolated(unsafe)`: the SDK does not mark `UserDefaults` as `Sendable`, and Apple documents it as thread-safe;
  /// the field is constant, and the store calls only `object`, `set` and `removeObject`.
  nonisolated(unsafe) private let defaults: UserDefaults
  private let registrar = ObservationRegistrar()
  private let changes = Mutex(0)

  public init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  /// Counts saves; the key path Observation tracks.
  public var revision: Int {
    registrar.access(self, keyPath: \.revision)
    return changes.withLock { $0 }
  }

  /// The combination in force for `shortcut`. A stored value that cannot be read or that a rule refuses today (a
  /// newer app shortcut took it) reads as the default.
  public func combination(for shortcut: AppShortcut) -> AppShortcut.Combination {
    guard Self.configurable.contains(shortcut) else { return shortcut.defaultCombination }
    _ = revision
    guard let raw = defaults.object(forKey: Self.key(shortcut)) as? String,
      let stored = Self.decode(raw),
      fixedRefusal(stored, for: shortcut) == nil
    else { return shortcut.defaultCombination }
    return stored
  }

  /// Why `combination` cannot become `shortcut`; `nil` = it can.
  public func check(_ combination: AppShortcut.Combination, for shortcut: AppShortcut) -> Refusal? {
    guard Self.configurable.contains(shortcut) else { return .notConfigurable }
    if let refusal = fixedRefusal(combination, for: shortcut) { return refusal }
    let clash = Self.configurable.contains { other in
      other != shortcut && other.overlaps(shortcut) && self.combination(for: other) == combination
    }
    return clash ? .taken : nil
  }

  /// Saves `combination` for `shortcut` after ``check(_:for:)``; a refused one leaves the stored value as it was.
  @discardableResult
  public func save(_ combination: AppShortcut.Combination, for shortcut: AppShortcut) -> Refusal? {
    if let refusal = check(combination, for: shortcut) { return refusal }
    mutate {
      if combination == shortcut.defaultCombination {
        defaults.removeObject(forKey: Self.key(shortcut))
      } else {
        defaults.set(Self.encode(combination), forKey: Self.key(shortcut))
      }
    }
    return nil
  }

  /// Gives `shortcut` its default back; refused while the other changeable shortcut holds that combination.
  @discardableResult
  public func restoreDefault(_ shortcut: AppShortcut) -> Refusal? {
    save(shortcut.defaultCombination, for: shortcut)
  }

  private func mutate(_ change: () -> Void) {
    registrar.withMutation(of: self, keyPath: \.revision) {
      change()
      changes.withLock { $0 += 1 }
    }
  }

  /// The rules that do not depend on the other changeable shortcut. A stored value is read through these only, so
  /// reading one changeable shortcut never reads the other.
  private func fixedRefusal(_ combination: AppShortcut.Combination, for shortcut: AppShortcut) -> Refusal? {
    if combination.modifiers.isDisjoint(with: [.command, .option, .control]) { return .needsModifier }
    if Self.systemCombinations.contains(combination) { return .system }
    guard case let .character(letter) = combination.key, letter.isASCII, letter.isLetter || letter.isNumber else {
      return .needsLetterOrDigit
    }
    if Self.tabDigits.contains(combination) { return .taken }
    let clash = AppShortcut.allCases.contains { other in
      other != shortcut && !Self.configurable.contains(other) && other.overlaps(shortcut)
        && other.defaultCombination == combination
    }
    return clash ? .taken : nil
  }

  // MARK: Stored form

  /// “control+option+d”: modifier names in glyph order, then the key.
  private static let names: [(AppShortcut.Modifiers, String)] = [
    (.control, "control"), (.option, "option"), (.shift, "shift"), (.command, "command"),
  ]

  static func encode(_ combination: AppShortcut.Combination) -> String? {
    guard case let .character(letter) = combination.key else { return nil }
    let parts = names.filter { combination.modifiers.contains($0.0) }.map(\.1)
    return (parts + [String(letter)]).joined(separator: "+")
  }

  static func decode(_ raw: String) -> AppShortcut.Combination? {
    var parts = raw.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let last = parts.popLast(), last.count == 1, let letter = last.first else { return nil }
    var modifiers: AppShortcut.Modifiers = []
    for part in parts {
      guard let modifier = names.first(where: { $0.1 == part })?.0 else { return nil }
      modifiers.insert(modifier)
    }
    return AppShortcut.Combination(key: .character(letter), modifiers: modifiers)
  }
}
