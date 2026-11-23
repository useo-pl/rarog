import Foundation
import Observation
import RarogContract

// The app's text size chosen with ⌘+, ⌘- and ⌘0 or on the Text Size page, without UIKit. The scene puts the
// effective step on `UIWindowScene.traitOverrides.preferredContentSizeCategory`
// (`Views/TextScale/TextScaleScene.swift`), so every Dynamic Type path grows the way it does with the system slider.
// Where every text style has one size (the iPad app on a Mac) the views read ``TextScale/effective`` themselves
// through the text scaling contract (`Theme/TextStyle/`). Owner: text size.

/// A text size category, named like `UIContentSizeCategory`: the seven standard steps and the five accessibility
/// sizes, smallest first.
public enum TextSizeCategory: String, CaseIterable, Sendable, Comparable {
  case extraSmall, small, medium, large, extraLarge, extraExtraLarge, extraExtraExtraLarge
  case accessibilityMedium, accessibilityLarge, accessibilityExtraLarge, accessibilityExtraExtraLarge
  case accessibilityExtraExtraExtraLarge

  /// The steps ⌘+ and ⌘- walk through; the shortcut never sets an accessibility size.
  public static let steps: [TextSizeCategory] = [
    .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
  ]

  public var isAccessibility: Bool { !Self.steps.contains(self) }

  private var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

  public static func < (lhs: TextSizeCategory, rhs: TextSizeCategory) -> Bool { lhs.index < rhs.index }
}

/// The text size of this device: the system's category (read from the screen, not from the scene that carries the
/// override), the stored choice and the effective category. Nothing stored follows the system. While the system uses an
/// accessibility size there is no override and ⌘+ and ⌘- are disabled; the stored choice comes back when the system
/// leaves it.
@MainActor
@Observable
public final class TextScale {
  /// The `UserDefaults` key of the stored step (the raw value of a standard ``TextSizeCategory``).
  public nonisolated static let key = "rarog.textSize"

  public static let shared = TextScale(defaults: .standard)

  /// The system's text size category.
  public private(set) var system: TextSizeCategory
  /// The step chosen on this device; `nil` = follow the system.
  public private(set) var chosen: TextSizeCategory?

  /// Called with the new ``override`` whenever it changes; the scene binding sets it.
  @ObservationIgnored public var onOverrideChange: ((TextSizeCategory?) -> Void)?
  @ObservationIgnored private let defaults: UserDefaults

  public init(defaults: UserDefaults, system: TextSizeCategory = .large) {
    self.defaults = defaults
    self.system = system
    chosen = (defaults.object(forKey: Self.key) as? String)
      .flatMap(TextSizeCategory.init(rawValue:))
      .flatMap { $0.isAccessibility ? nil : $0 }
  }

  /// The system uses an accessibility size: the app follows the system.
  public var suspended: Bool { system.isAccessibility }

  /// The category the scene must carry; `nil` = no override.
  public var override: TextSizeCategory? { suspended ? nil : chosen }

  /// The category the app's text uses.
  public var effective: TextSizeCategory { override ?? system }

  public var canGrow: Bool { !suspended && effective < .extraExtraExtraLarge }
  public var canShrink: Bool { !suspended && effective > .extraSmall }
  /// ⌘0 and Use System Size: something is stored.
  public var canReset: Bool { chosen != nil }

  /// ⌘+: one step up from the effective category (the system's one when nothing is stored).
  public func grow() { step(1) }

  /// ⌘-: one step down.
  public func shrink() { step(-1) }

  /// The Text Size page: store this step, even when it is the system's own one; only ⌘0 and Use System Size
  /// follow the system again. Disabled while the system uses an accessibility size; an accessibility size is never
  /// stored.
  public func choose(_ step: TextSizeCategory) {
    guard !suspended, TextSizeCategory.steps.contains(step) else { return }
    change { chosen = step }
  }

  /// ⌘0: forget the stored step and follow the system.
  public func reset() {
    guard canReset else { return }
    change { chosen = nil }
  }

  /// The system's category changed (`UIContentSizeCategory.didChangeNotification`).
  public func systemChanged(_ category: TextSizeCategory) {
    guard category != system else { return }
    change { system = category }
  }

  private func step(_ delta: Int) {
    guard delta > 0 ? canGrow : canShrink,
      let index = TextSizeCategory.steps.firstIndex(of: effective)
    else { return }
    let next = TextSizeCategory.steps[index + delta]
    change { chosen = next }
  }

  /// Applies a change, stores the choice and tells the scene when the override moved.
  private func change(_ mutate: () -> Void) {
    let before = override
    let stored = chosen
    mutate()
    if chosen != stored {
      if let chosen {
        defaults.set(chosen.rawValue, forKey: Self.key)
      } else {
        defaults.removeObject(forKey: Self.key)
      }
    }
    if override != before { onOverrideChange?(override) }
  }
}

/// The state of the text size commands in the menu bar at the moment it was drawn.
public struct TextSizeMenu: Sendable, Equatable {
  public var canGrow = false
  public var canShrink = false
  public var canReset = false

  public init() {}

  @MainActor
  public init(_ scale: TextScale) {
    canGrow = scale.canGrow
    canShrink = scale.canShrink
    canReset = scale.canReset
  }
}

/// The Settings row and the Text Size page: the current state (Use System Size or the step's name), the seven steps
/// with the checked one, and the Use System Size button, shown only while a step is stored. The button is the way
/// back to the system's size without a keyboard. While the system uses an accessibility size the app follows it:
/// no step is checked and the list is disabled, but a stored step can still be forgotten.
@MainActor
public struct TextScaleSettingsRow {
  public let value: String
  /// The checked step on the page; `nil` while following the system or while an accessibility size suspends the
  /// stored step.
  public let checked: TextSizeCategory?
  /// The steps can be chosen: the system does not use an accessibility size.
  public let stepsEnabled: Bool
  /// Use System Size is on the page: a step is stored.
  public let showsUseSystem: Bool
  /// The seven standard steps, smallest first, each with its name.
  public let steps: [TextScaleStepOption]
  private let scale: TextScale

  public init(scale: TextScale, language: CopyLanguage = .current) {
    self.scale = scale
    value = scale.chosen.map { UICopy.textSizeStep($0, language: language) } ?? UICopy.textSizeSystem(language: language)
    let checked = scale.override
    self.checked = checked
    stepsEnabled = !scale.suspended
    showsUseSystem = scale.canReset
    steps = TextSizeCategory.steps.map {
      TextScaleStepOption(step: $0, name: UICopy.textSizeStep($0, language: language), checked: $0 == checked)
    }
  }

  /// A tap on a step of the page.
  public func choose(_ step: TextSizeCategory) { scale.choose(step) }

  /// Use System Size.
  public func followSystem() { scale.reset() }
}

/// One step on the Text Size page.
public struct TextScaleStepOption: Identifiable, Equatable, Sendable {
  public let step: TextSizeCategory
  public let name: String
  public let checked: Bool
  public var id: String { step.rawValue }
}
