import Foundation
import Observation
import RarogContract
@testable import RarogUI
import Testing

// The app's text size chosen with ⌘+, ⌘- and ⌘0 (`TextScale`): seven standard steps, a choice stored per device,
// the system's size when nothing is stored, and no override while the system uses an accessibility size.
// Owner: text size.

@MainActor
@Suite("text size: ⌘+, ⌘- and ⌘0 over the system's size, stored per device")
struct TextScaleTests {
  typealias Scratch = AppShortcutSettingsTests.Scratch

  private func scale(_ scratch: Scratch, system: TextSizeCategory) -> TextScale {
    TextScale(defaults: scratch.defaults, system: system)
  }

  @Test("system Large, nothing stored, ⌘+ → Extra Large: the first step starts from the system's size")
  func growFromSystem() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    #expect(scale.chosen == nil && scale.override == nil && scale.effective == .large)
    scale.grow()
    #expect(scale.chosen == .extraLarge)
    #expect(scale.override == .extraLarge)
    #expect(scale.effective == .extraLarge)
  }

  @Test("system Small, nothing stored, ⌘- → Extra Small")
  func shrinkFromSystem() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .small)
    scale.shrink()
    #expect(scale.chosen == .extraSmall)
    #expect(scale.effective == .extraSmall)
  }

  @Test("Extra Small + ⌘- and Extra Extra Extra Large + ⌘+ change nothing; the command is disabled at its end")
  func ends() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    for _ in 0..<10 { scale.shrink() }
    #expect(scale.chosen == .extraSmall)
    #expect(!scale.canShrink && scale.canGrow)
    scale.shrink()
    #expect(scale.chosen == .extraSmall)
    for _ in 0..<10 { scale.grow() }
    #expect(scale.chosen == .extraExtraExtraLarge)
    #expect(!scale.canGrow && scale.canShrink)
    scale.grow()
    #expect(scale.chosen == .extraExtraExtraLarge)
  }

  @Test("the steps go one by one through the seven standard sizes and never into an accessibility size")
  func sevenSteps() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .extraSmall)
    var seen: [TextSizeCategory] = [scale.effective]
    while scale.canGrow {
      scale.grow()
      seen.append(scale.effective)
    }
    #expect(seen == TextSizeCategory.steps)
    #expect(seen.count == 7)
    #expect(!seen.contains { $0.isAccessibility })
  }

  @Test("⌘0 from any stored size → nothing stored, the system's size; ⌘0 with nothing stored is disabled")
  func reset() {
    for step in TextSizeCategory.steps {
      let scratch = Scratch()
      scratch.defaults.set(step.rawValue, forKey: TextScale.key)
      let stored = scale(scratch, system: .medium)
      #expect(stored.canReset)
      stored.reset()
      #expect(stored.chosen == nil && stored.override == nil && stored.effective == .medium, "\(step)")
      #expect(scratch.defaults.object(forKey: TextScale.key) == nil)
      #expect(!stored.canReset)
    }
  }

  @Test("stored Extra Large, system Accessibility Medium → the system's size, ⌘+ and ⌘- disabled; back to Large → Extra Large")
  func accessibilitySuspends() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    scale.grow()
    #expect(scale.override == .extraLarge)
    scale.systemChanged(.accessibilityMedium)
    #expect(scale.override == nil)
    #expect(scale.effective == .accessibilityMedium)
    #expect(!scale.canGrow && !scale.canShrink)
    scale.grow()
    scale.shrink()
    #expect(scale.chosen == .extraLarge, "the stored choice waits")
    scale.systemChanged(.large)
    #expect(scale.override == .extraLarge)
    #expect(scale.effective == .extraLarge)
    #expect(scale.canGrow && scale.canShrink)
  }

  @Test("an unknown or accessibility stored value reads as nothing stored")
  func unknownValue() {
    for value: Any in ["", "huge", "accessibilityMedium", "UICTContentSizeCategoryL", 3] {
      let scratch = Scratch()
      scratch.defaults.set(value, forKey: TextScale.key)
      let scale = scale(scratch, system: .large)
      #expect(scale.chosen == nil, "\(value)")
      #expect(scale.effective == .large, "\(value)")
    }
  }

  @Test("a new store over the same domain reads the stored choice")
  func survivesRestart() {
    let scratch = Scratch()
    scale(scratch, system: .large).grow()
    let fresh = scale(scratch, system: .large)
    #expect(fresh.chosen == .extraLarge)
    #expect(fresh.override == .extraLarge)
  }

  @Test("a change of the override calls the scene back once with the new override; a change of the system that leaves it does not")
  func callsBack() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    var calls: [TextSizeCategory?] = []
    scale.onOverrideChange = { calls.append($0) }
    scale.grow()
    scale.systemChanged(.small)
    scale.systemChanged(.accessibilityLarge)
    scale.systemChanged(.large)
    scale.reset()
    #expect(calls == [.extraLarge, nil, .extraLarge, nil])
  }

  @Test("a step is observable, so the menu and the Settings row draw again")
  func observable() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    let changed = AppShortcutSettingsTests.Flag()
    withObservationTracking {
      _ = scale.canGrow
    } onChange: {
      changed.set()
    }
    scale.grow()
    #expect(changed.value)
  }

  @Test("choose Small with the system at Large → Small stored, the scene called back once; an accessibility size is ignored")
  func chooseStoresAndReports() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    var calls: [TextSizeCategory?] = []
    scale.onOverrideChange = { calls.append($0) }
    scale.choose(.small)
    #expect(scale.chosen == .small && scale.override == .small && scale.effective == .small)
    #expect(scratch.defaults.string(forKey: TextScale.key) == TextSizeCategory.small.rawValue)
    #expect(calls == [.small])
    scale.choose(.small)
    scale.choose(.accessibilityLarge)
    #expect(scale.chosen == .small)
    #expect(calls == [.small], "the same step again and an accessibility size change nothing")
  }

  @Test("choose the system's own step → it is stored, not read as following the system")
  func chooseTheSystemsStep() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .large)
    scale.choose(.large)
    #expect(scale.chosen == .large)
    #expect(scale.canReset)
    #expect(scratch.defaults.string(forKey: TextScale.key) == TextSizeCategory.large.rawValue)
    scale.systemChanged(.small)
    #expect(scale.effective == .large, "the stored step stays when the system moves")
  }

  @Test("choose while the system uses an accessibility size changes nothing, stored or not")
  func chooseWhileSuspended() {
    let stored = Scratch()
    stored.defaults.set(TextSizeCategory.extraLarge.rawValue, forKey: TextScale.key)
    let withStep = scale(stored, system: .accessibilityMedium)
    var calls: [TextSizeCategory?] = []
    withStep.onOverrideChange = { calls.append($0) }
    withStep.choose(.small)
    #expect(withStep.chosen == .extraLarge)
    #expect(stored.defaults.string(forKey: TextScale.key) == TextSizeCategory.extraLarge.rawValue)
    #expect(calls.isEmpty)
    let empty = Scratch()
    let withoutStep = scale(empty, system: .accessibilityMedium)
    withoutStep.choose(.small)
    #expect(withoutStep.chosen == nil)
    #expect(empty.defaults.object(forKey: TextScale.key) == nil)
  }

  @Test("Use System Size while the system uses an accessibility size forgets the stored step")
  func resetWhileSuspended() {
    let scratch = Scratch()
    scratch.defaults.set(TextSizeCategory.extraLarge.rawValue, forKey: TextScale.key)
    let scale = scale(scratch, system: .accessibilityMedium)
    #expect(scale.canReset)
    scale.reset()
    #expect(scale.chosen == nil)
    #expect(scratch.defaults.object(forKey: TextScale.key) == nil)
    scale.systemChanged(.large)
    #expect(scale.effective == .large, "leaving the accessibility size follows the system")
  }

  @Test("choose Medium, then Use System Size → nothing stored, the system's size, the scene called back with nil")
  func resetAfterChoose() {
    let scratch = Scratch()
    let scale = scale(scratch, system: .extraLarge)
    var calls: [TextSizeCategory?] = []
    scale.onOverrideChange = { calls.append($0) }
    scale.choose(.medium)
    scale.reset()
    #expect(scale.chosen == nil && scale.effective == .extraLarge)
    #expect(scratch.defaults.object(forKey: TextScale.key) == nil)
    #expect(calls == [.medium, nil])
  }

  @Test("stored Extra Large at launch applies at once; the menu follows the model to both ends and back to the system")
  func menuFollowsTheModel() {
    let scratch = Scratch()
    scratch.defaults.set(TextSizeCategory.extraLarge.rawValue, forKey: TextScale.key)
    let scale = scale(scratch, system: .large)
    #expect(scale.override == .extraLarge && scale.effective == .extraLarge)
    var menu = TextSizeMenu(scale)
    #expect(menu.canGrow && menu.canShrink && menu.canReset)
    while scale.canGrow { scale.grow() }
    menu = TextSizeMenu(scale)
    #expect(!menu.canGrow && menu.canShrink && menu.canReset, "Extra Extra Extra Large")
    while scale.canShrink { scale.shrink() }
    menu = TextSizeMenu(scale)
    #expect(menu.canGrow && !menu.canShrink && menu.canReset, "Extra Small")
    scale.reset()
    menu = TextSizeMenu(scale)
    #expect(menu.canGrow && menu.canShrink && !menu.canReset, "the system's size")
    #expect(scale.effective == .large)
    let none = TextSizeMenu()
    #expect(!none.canGrow && !none.canShrink && !none.canReset, "no state from the scene yet: every command disabled")
  }
}

@MainActor
@Suite("text size: the Settings row")
struct TextScaleSettingsRowTests {
  typealias Scratch = AppShortcutSettingsTests.Scratch

  @Test("stored Extra Large: the row names the step, Use System Size shows and gives nothing stored")
  func followSystem() {
    let scratch = Scratch()
    scratch.defaults.set(TextSizeCategory.extraLarge.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: scratch.defaults, system: .large)
    let row = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(row.value == L("textSize.step.extraLarge", language: .en))
    #expect(row.showsUseSystem)
    row.followSystem()
    #expect(scale.chosen == nil)
    let after = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(after.value == L("textSize.system", language: .en))
    #expect(!after.showsUseSystem)
  }

  @Test("nothing stored: the row says the system's size and the button is hidden")
  func nothingStored() {
    let scratch = Scratch()
    let scale = TextScale(defaults: scratch.defaults, system: .small)
    for language in [CopyLanguage.en, .pl] {
      let row = TextScaleSettingsRow(scale: scale, language: language)
      #expect(row.value == L("textSize.system", language: language))
      #expect(!row.showsUseSystem)
    }
  }

  @Test("every step has its own name in both languages; the button does not repeat the row's value")
  func stepNames() {
    for language in [CopyLanguage.en, .pl] {
      let names = TextSizeCategory.steps.map { UICopy.textSizeStep($0, language: language) }
      #expect(Set(names).count == 7, "\(language): \(names)")
      #expect(!names.contains(L("textSize.system", language: language)))
      #expect(L("textSize.useSystem", language: language) != L("textSize.system", language: language), "\(language)")
    }
  }

  @Test("nothing stored: seven steps in order with their names, none checked, the list enabled, Use System Size hidden")
  func pageFollowingTheSystem() {
    let scratch = Scratch()
    let scale = TextScale(defaults: scratch.defaults, system: .large)
    let row = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(row.steps.map(\.step) == TextSizeCategory.steps)
    #expect(row.steps.map(\.name) == TextSizeCategory.steps.map { UICopy.textSizeStep($0, language: .en) })
    #expect(row.checked == nil)
    #expect(!row.steps.contains { $0.checked })
    #expect(row.stepsEnabled)
    #expect(!row.showsUseSystem)
  }

  @Test("a step chosen on the page: that step alone is checked and Use System Size shows; following the system hides it")
  func pageChoosesAStep() {
    let scratch = Scratch()
    let scale = TextScale(defaults: scratch.defaults, system: .large)
    TextScaleSettingsRow(scale: scale, language: .en).choose(.medium)
    let row = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(row.checked == .medium)
    #expect(row.steps.filter(\.checked).map(\.step) == [.medium])
    #expect(row.showsUseSystem)
    row.followSystem()
    let after = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(after.checked == nil && !after.showsUseSystem)
  }

  @Test("stored step and an accessibility size in the system: no check, the list disabled, Use System Size still shows and works")
  func pageWhileSuspended() {
    let scratch = Scratch()
    scratch.defaults.set(TextSizeCategory.extraLarge.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: scratch.defaults, system: .accessibilityLarge)
    let row = TextScaleSettingsRow(scale: scale, language: .en)
    #expect(row.checked == nil)
    #expect(!row.steps.contains { $0.checked })
    #expect(!row.stepsEnabled)
    #expect(row.showsUseSystem)
    row.choose(.small)
    #expect(scale.chosen == .extraLarge, "a disabled list stores nothing")
    row.followSystem()
    #expect(scale.chosen == nil)
    #expect(!TextScaleSettingsRow(scale: scale, language: .en).showsUseSystem)
  }
}
