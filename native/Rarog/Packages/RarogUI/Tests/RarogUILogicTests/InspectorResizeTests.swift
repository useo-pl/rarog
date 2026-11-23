import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The iPad right panel's width: the remembered device preference, the width the column can show, the live drag of
// the divider (saved once, at the end) and the VoiceOver adjustment. The visibility thresholds do not depend on it.

/// An open, standing panel in a column of `columnWidth` pt.
@MainActor
private func standing(_ prefs: MemoryPreferences = MemoryPreferences(), columnWidth: Double = 1056) -> RarogInspector {
  let inspector = RarogInspector(prefs: prefs)
  inspector.noteLayout(columnWidth: columnWidth, eligible: true)
  inspector.setOpen(true)
  return inspector
}

@Suite("right panel: width shown in the column")
struct InspectorDisplayedWidthTests {
  @Test("the transcript keeps at least 560 pt; the panel never goes below 280 pt", arguments: [
    (320.0, 1056.0, 320.0), (560, 1056, 496), (560, 1400, 560), (400, 880, 320), (280, 880, 280),
  ])
  func displayed(preferred: Double, column: Double, expected: Double) {
    #expect(InspectorModel.displayedWidth(preferred: preferred, columnWidth: column) == expected)
  }
}

@MainActor
@Suite("right panel: width preference")
struct InspectorWidthPreferenceTests {
  @Test("no entry → 320; out of range is clamped to 280...560; a non-finite number is no entry", arguments: [
    (nil, 320.0), (100, 280), (900, 560), (400, 400), (Double.nan, 320), (Double.infinity, 320),
  ] as [(Double?, Double)])
  func read(stored: Double?, expected: Double) {
    let prefs = MemoryPreferences()
    if let stored { prefs.set(stored, forKey: NavigationPreferences.inspectorWidth) }
    #expect(RarogInspector(prefs: prefs).preferredWidth == expected)
  }

  @Test("an entry of the wrong type is no entry; a number from UserDefaults (NSNumber) is a width")
  func readsType() {
    let prefs = MemoryPreferences()
    prefs.set("wide", forKey: NavigationPreferences.inspectorWidth)
    #expect(RarogInspector(prefs: prefs).preferredWidth == 320)
    prefs.set(NSNumber(value: 440), forKey: NavigationPreferences.inspectorWidth)
    #expect(RarogInspector(prefs: prefs).preferredWidth == 440)
  }
}

@MainActor
@Suite("right panel: dragging the divider")
struct InspectorDragTests {
  @Test("the width follows the drag live, the preference is written once, at the end, clamped")
  func dragSavesAtEnd() {
    let prefs = MemoryPreferences()
    let inspector = standing(prefs)
    inspector.drag(translation: -40)
    #expect(inspector.displayedWidth == 360, "dragging left widens")
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) == nil, "nothing saved mid-gesture")
    inspector.drag(translation: -400)
    #expect(inspector.displayedWidth == 496, "1056 pt column: the transcript keeps 560 pt")
    #expect(inspector.preferredWidth == 320, "the preference waits for the end of the gesture")
    inspector.endDrag()
    #expect(inspector.preferredWidth == 496)
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) as? Double == 496)
    #expect(RarogInspector(prefs: prefs).preferredWidth == 496, "the device remembers it")
  }

  @Test("the drag starts from the width shown, not the preferred one, and stops at 280 and 560")
  func dragLimits() {
    let prefs = MemoryPreferences()
    prefs.set(560.0, forKey: NavigationPreferences.inspectorWidth)
    let inspector = standing(prefs)
    #expect(inspector.displayedWidth == 496)
    inspector.drag(translation: 16)
    #expect(inspector.displayedWidth == 480, "from the 496 pt on screen")
    inspector.drag(translation: 900)
    #expect(inspector.displayedWidth == 280)
    inspector.endDrag()
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) as? Double == 280)

    let wide = standing(MemoryPreferences(), columnWidth: 1400)
    wide.drag(translation: -900)
    #expect(wide.displayedWidth == 560)
    wide.endDrag()
    #expect(wide.preferredWidth == 560)
  }

  @Test("a new gesture starts from the width the previous one left")
  func secondGesture() {
    let inspector = standing(columnWidth: 1400)
    inspector.drag(translation: -80)
    inspector.endDrag()
    inspector.drag(translation: -40)
    #expect(inspector.displayedWidth == 440)
    inspector.endDrag()
    #expect(inspector.preferredWidth == 440)
  }

  @Test("an end without a drag writes nothing")
  func endWithoutDrag() {
    let prefs = MemoryPreferences()
    let inspector = standing(prefs, columnWidth: 900)
    inspector.endDrag()
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) == nil)
    #expect(inspector.preferredWidth == 320)
  }

  @Test("dragging never hides the panel and never changes whether it is open")
  func dragKeepsPanel() {
    let inspector = standing()
    inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(inspector.standing, "inside the hysteresis band")
    for step in 1...20 {
      inspector.drag(translation: Double(-8 * step))
      #expect(inspector.standing && inspector.open)
    }
    inspector.endDrag()
    #expect(inspector.standing && inspector.open)
  }

  @Test("a narrower column narrows the panel without touching the preference; the width returns with the room")
  func narrowColumnKeepsPreference() {
    let prefs = MemoryPreferences()
    prefs.set(480.0, forKey: NavigationPreferences.inspectorWidth)
    let inspector = standing(prefs, columnWidth: 1400)
    #expect(inspector.displayedWidth == 480)
    inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(inspector.displayedWidth == 340)
    #expect(inspector.preferredWidth == 480 && prefs.object(forKey: NavigationPreferences.inspectorWidth) as? Double == 480)
    inspector.noteLayout(columnWidth: 1400, eligible: true)
    #expect(inspector.displayedWidth == 480)
  }

  @Test("a column narrowing mid-drag narrows the live width too; the transcript keeps 560 pt")
  func narrowColumnMidDrag() {
    let inspector = standing(columnWidth: 1400)
    inspector.drag(translation: -240)
    #expect(inspector.displayedWidth == 560)
    inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(inspector.displayedWidth == 340)
    inspector.noteLayout(columnWidth: 1400, eligible: true)
    #expect(inspector.displayedWidth == 560)
  }

  @Test("open and standing follow 920 / 880 pt whatever the width", arguments: [280.0, 320, 400, 560])
  func thresholdsIgnoreWidth(width: Double) {
    let prefs = MemoryPreferences()
    prefs.set(width, forKey: NavigationPreferences.inspectorWidth)
    let inspector = RarogInspector(prefs: prefs)
    inspector.noteLayout(columnWidth: 919, eligible: true)
    #expect(!inspector.canOpen)
    inspector.noteLayout(columnWidth: 920, eligible: true)
    #expect(inspector.canOpen)
    inspector.setOpen(true)
    inspector.noteLayout(columnWidth: 880, eligible: true)
    #expect(inspector.standing)
    inspector.noteLayout(columnWidth: 879, eligible: true)
    #expect(!inspector.standing)
    for column in [879.0, 880, 919, 920] {
      for standing in [false, true] {
        #expect(InspectorModel.fits(columnWidth: column, eligible: true, standing: standing)
          == (column >= (standing ? 880 : 920)))
      }
    }
  }
}

@MainActor
@Suite("right panel: VoiceOver width adjustment")
struct InspectorAdjustTests {
  @Test("40 pt steps within the drag limits, saved at each step")
  func adjust() {
    let prefs = MemoryPreferences()
    let inspector = standing(prefs)
    inspector.adjustWidth(by: InspectorModel.adjustmentStep)
    #expect(inspector.displayedWidth == 360)
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) as? Double == 360)
    for _ in 0..<5 { inspector.adjustWidth(by: InspectorModel.adjustmentStep) }
    #expect(inspector.displayedWidth == 496, "1056 pt column: stops where the transcript keeps 560 pt")
    for _ in 0..<10 { inspector.adjustWidth(by: -InspectorModel.adjustmentStep) }
    #expect(inspector.displayedWidth == 280)
    #expect(prefs.object(forKey: NavigationPreferences.inspectorWidth) as? Double == 280)
  }
}
