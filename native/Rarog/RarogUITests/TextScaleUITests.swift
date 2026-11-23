import UIKit
import XCTest

/// The app's text size against the demo server: ⌘= (and ⇧⌘=) and ⌘- move the size one step and type nothing into the
/// message field, ⌘0 gives the system's size back but with the session switcher open picks its row 0 instead, and the
/// main screens pass the accessibility audit with the app's size set far from the system's in both directions. The
/// size shows as the value of the Text Size row on the Settings list, which follows each step; the Text Size page
/// stores a tapped step with a check and goes back to the system's size with Use System Size. The system's size is
/// pinned to Large for the keys (`-UIPreferredContentSizeCategoryName`), so one step up is Larger.
final class TextScaleUITests: AccessibilityAudit {
  private let keyboard = ["RAROG_UI_TEST_HW_KEYBOARD": "1"]
  private let session = "demo-willow"
  private let larger = "Większe"
  private let veryLarge = "Bardzo duże"
  private let system = "Jak w systemie"

  @MainActor
  func testKeysStepOnceAndTypeNothing() throws {
    let app = try launch()
    // A Claude session with the message field.
    open(app, "demo-rarog")
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "message field")
    field.tap()
    field.typeText("ab")
    XCTAssertEqual(field.value as? String, "ab")

    app.typeKey("=", modifierFlags: .command)
    settle(1)
    XCTAssertEqual(field.value as? String, "ab", "⌘= types nothing into the field")
    XCTAssertEqual(textSize(app), larger, "⌘= moves one step from the system's Large")
    closeSettings(app)
    field.tap()
    app.typeKey("=", modifierFlags: [.shift, .command])
    settle(1)
    XCTAssertEqual(field.value as? String, "ab", "⇧⌘= types nothing into the field")
    XCTAssertEqual(textSize(app), veryLarge, "⇧⌘= one more step")

    // Over the Settings sheet the keys work too; the row follows each step.
    app.typeKey("-", modifierFlags: .command)
    XCTAssertTrue(waitTextSize(app, larger), "⌘- one step back: \(textSize(app) ?? "-")")
    app.typeKey("=", modifierFlags: [.shift, .command])
    XCTAssertTrue(waitTextSize(app, veryLarge), "⇧⌘= over the sheet: \(textSize(app) ?? "-")")
    app.typeKey("-", modifierFlags: .command)
    XCTAssertTrue(waitTextSize(app, larger), "⌘- over the sheet: \(textSize(app) ?? "-")")
    closeSettings(app)
    field.tap()
    app.typeKey("0", modifierFlags: .command)
    settle(1)
    XCTAssertEqual(field.value as? String, "ab", "⌘0 types nothing into the field")
    XCTAssertEqual(textSize(app), system, "⌘0 gives the system's size back")
  }

  @MainActor
  func testCommandZeroPicksSwitcherRowAndKeepsTheSize() throws {
    let app = try launch()
    open(app, "demo-data-loader")
    open(app, session)
    app.typeKey("=", modifierFlags: .command)
    XCTAssertEqual(textSize(app), larger, "one step before the switcher")
    closeSettings(app)

    app.typeKey("s", modifierFlags: .command)
    let window = element(app, "switcher.window")
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "⌘S opens the switcher")
    app.typeKey("0", modifierFlags: .command)
    XCTAssertTrue(window.waitForDisappearance(timeout: 5), "⌘0 picks row 0 and closes the window")
    XCTAssertTrue(selected(app, session), "row 0 is the session on screen")
    XCTAssertEqual(textSize(app), larger, "⌘0 in the switcher does not reset the size")
    closeSettings(app)
  }

  /// The Text Size page: a tapped step is stored (checked, the list row shows its name), and Use System Size, shown
  /// only while a step is stored, gives the system's size back.
  @MainActor
  func testPageStepAndUseSystem() throws {
    let app = try launch()
    XCTAssertEqual(textSize(app), system, "no step stored at start")
    var page = DemoServer.openSettingsPage(app, "textSize")
    XCTAssertFalse(element(app, "textSize.useSystem").exists, "no Use System Size while following the system")
    let step = element(app, "textSize.step.extraExtraLarge")
    XCTAssertTrue(step.waitForAppearance(timeout: 5), "the Very Large step")
    XCTAssertFalse(step.isSelected, "no check while following the system")
    step.tap()
    XCTAssertTrue(wait(5) { step.isSelected }, "the tapped step is checked")
    XCTAssertFalse(element(app, "textSize.step.large").isSelected, "one check only")
    XCTAssertTrue(
      DemoServer.revealSettings(app, "textSize.useSystem", in: page).exists, "Use System Size once a step is stored")
    DemoServer.settingsBack(app, from: "Rozmiar pisma")
    XCTAssertEqual(textSize(app), veryLarge, "the list row shows the stored step")

    page = DemoServer.openSettingsPage(app, "textSize")
    let useSystem = DemoServer.revealSettings(app, "textSize.useSystem", in: page)
    XCTAssertTrue(useSystem.exists && useSystem.isHittable, "Use System Size")
    useSystem.tap()
    XCTAssertTrue(useSystem.waitForDisappearance(timeout: 5), "Use System Size gone after the reset")
    XCTAssertFalse(step.isSelected, "no check after the reset")
    DemoServer.settingsBack(app, from: "Rozmiar pisma")
    XCTAssertEqual(textSize(app), system, "the list row follows the system again")
    closeSettings(app)
  }

  /// The transcript width on the Text Size page: readable checked at start, a tap on Full Width moves the one check.
  @MainActor
  func testPageTranscriptWidth() throws {
    let app = try launch()
    let page = DemoServer.openSettingsPage(app, "textSize")
    let full = DemoServer.revealSettings(app, "textSize.width.full", in: page)
    let readable = element(app, "textSize.width.readable")
    XCTAssertTrue(full.exists && readable.exists, "both width options")
    XCTAssertTrue(readable.isSelected, "readable by default")
    XCTAssertFalse(full.isSelected)
    full.tap()
    XCTAssertTrue(wait(5) { full.isSelected }, "the tapped option is checked")
    XCTAssertFalse(readable.isSelected, "one check only")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "text-size-transcript-width"
    shot.lifetime = .keepAlways
    add(shot)
    readable.tap()
    XCTAssertTrue(wait(5) { readable.isSelected }, "back to readable")
    DemoServer.settingsBack(app, from: "Rozmiar pisma")
    closeSettings(app)
  }

  /// The system's size small, the app's the largest step: every screen grows past the system.
  @MainActor
  func testAuditSmallSystemLargestAppSize() throws {
    try walkMainScreens(
      largestText: false, systemSize: "UICTContentSizeCategoryS", appTextSize: "extraExtraExtraLarge",
      label: "-sys-s-app-xxxl")
  }

  /// The system's size the largest standard one, the app's the smallest step: every screen shrinks below the system.
  @MainActor
  func testAuditLargestSystemSmallestAppSize() throws {
    try walkMainScreens(
      largestText: false, systemSize: "UICTContentSizeCategoryXXXL", appTextSize: "extraSmall",
      label: "-sys-xxxl-app-xs")
  }

  // MARK: - Helpers

  @MainActor
  private func launch() throws -> XCUIApplication {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("an iPad test with the list beside a session") }
    let start = XCUIDevice.shared.orientation
    let back: UIDeviceOrientation = start.isValidInterfaceOrientation ? start : .portrait
    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = back }
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment.merge(keyboard) { $1 }
    app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    // The first shortcut of a new app process does not reach the app on a simulator that already got a key from
    // XCUITest; any delivered key fixes it (`native/Rarog/docs/tests.md`, "Tests"). An idle right arrow on the list.
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
    return app
  }

  @MainActor
  private func open(_ app: XCUIApplication, _ id: String) {
    DemoServer.hideKeyboard(app)
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(row.waitForAppearance(timeout: 10), "row \(id)")
    row.tap()
    settle(0.8)
    XCTAssertTrue(selected(app, id), "session \(id) on screen")
  }

  /// The value of the Text Size row on the Settings list; opens Settings when they are closed. Callers on a page go
  /// Back first.
  @MainActor
  private func textSize(_ app: XCUIApplication) -> String? {
    let form = element(app, "settings.form")
    if !form.exists {
      element(app, "list.settings").tap()
      guard form.waitForAppearance(timeout: 10) else { return nil }
    }
    return DemoServer.revealSettings(app, "settings.row.textSize", in: form).value as? String
  }

  @MainActor
  private func waitTextSize(_ app: XCUIApplication, _ expected: String) -> Bool {
    wait(5) { self.textSize(app) == expected }
  }

  @MainActor
  private func closeSettings(_ app: XCUIApplication) {
    let form = element(app, "settings.form")
    guard form.exists else { return }
    element(app, "settings.close").tap()
    XCTAssertTrue(form.waitForDisappearance(timeout: 10), "Settings closed")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// The session is on screen: its tab in the project bar is selected.
  @MainActor
  private func selected(_ app: XCUIApplication, _ id: String) -> Bool {
    wait(8) {
      let tab = self.element(app, "tab.\(id)")
      return tab.exists && tab.isSelected
    }
  }

  @MainActor
  private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return condition()
  }

  private func settle(_ seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
