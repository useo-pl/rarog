import UIKit
import XCTest

/// The session switcher window against the demo server: only a tap on the current tab opens it (the app has no
/// keyboard shortcut for it). The window lists the tabs of the current project in the order of the tab bar and stays
/// open. The tests read the order from the bar, not from fixed ids, so the demo's project content does not pin them.
/// The hardware keyboard is faked (`RAROG_UI_TEST_HW_KEYBOARD`), so the window takes it the same way on every
/// simulator. The simulator delivers neither Esc nor Return to a screen without a text field
/// (`native/Rarog/docs/tests.md`, "Tests"): those keys are checked by `SessionSwitcherUIKitTests`.
final class SwitcherUITests: XCTestCase {
  /// Sessions the demo always has; demo-rarog shares its project with another session.
  private let visits = ["demo-willow", "demo-data-loader", "demo-rarog"]
  private let keyboard = ["RAROG_UI_TEST_HW_KEYBOARD": "1"]

  override func setUp() {
    continueAfterFailure = false
  }

  /// A tap on the current tab shows the project's tabs in the bar's order with the current one selected; the window
  /// stays; the arrows move the selection, S, Shift+S, Cmd+S and Shift+Cmd+S do not; Cmd+digit of another tab with
  /// the window open picks that row (the window wins over the tab shortcut); a tap on a row opens its tab.
  @MainActor
  func testRowsAreTheProjectTabs() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: keyboard)
    let home = visits[2]
    open(app, home)
    let bar = barTabs(app)
    XCTAssertGreaterThanOrEqual(bar.count, 2, "the project of \(home) has another tab: \(bar)")
    let current = try XCTUnwrap(bar.firstIndex(of: home))
    let other = current == 0 ? 1 : 0

    element(app, "tab.\(home)").tap()
    let window = element(app, "switcher.window")
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "a tap on the current tab opens the window")
    XCTAssertEqual(rows(app), bar, "the rows are the tabs of the bar, in its order")
    XCTAssertTrue(rowSelected(app, home), "the selection starts on the current tab")
    snapshot(app, "okno")
    settle(1.5)
    XCTAssertTrue(window.exists, "the window stays")
    // The window's keys reach it through its key commands (a real key press, not the UIKit test's chain walk).
    let below = bar[(current + 1) % bar.count]
    app.typeKey(XCUIKeyboardKey.downArrow, modifierFlags: [])
    XCTAssertTrue(rowSelected(app, below), "down arrow moves the selection")
    app.typeKey(XCUIKeyboardKey.upArrow, modifierFlags: [])
    XCTAssertTrue(rowSelected(app, home), "up arrow moves it back")
    // S is no key of the window, with or without Shift and Cmd; the arrow after them proves delivery.
    for modifiers: XCUIElement.KeyModifierFlags in [[], .shift, .command, [.command, .shift]] {
      app.typeKey("s", modifierFlags: modifiers)
    }
    settle(0.5)
    XCTAssertTrue(window.exists, "the window stays after S")
    XCTAssertTrue(rowSelected(app, home), "S, Shift+S, Cmd+S and Shift+Cmd+S do not move the selection")
    app.typeKey(XCUIKeyboardKey.downArrow, modifierFlags: [])
    XCTAssertTrue(rowSelected(app, below), "the window still holds the keyboard")
    XCTAssertTrue(selected(app, home), "the screen under the window stays")
    app.typeKey(String(other + 1), modifierFlags: .command)
    XCTAssertTrue(window.waitForDisappearance(timeout: 5), "Cmd+digit picks the row and closes the window")
    XCTAssertTrue(selected(app, bar[other]), "the jump to the row with that digit")

    settle(1)
    element(app, "tab.\(bar[other])").tap()
    XCTAssertTrue(window.waitForAppearance(timeout: 5))
    XCTAssertEqual(rows(app), barTabs(app), "the same tabs from the other tab")
    element(app, "switcher.row.\(home)").tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5))
    XCTAssertTrue(selected(app, home), "a tap on a row opens its tab")
  }

  /// A tap on the current tab opens the window without a keyboard; a tap outside closes it without a jump, a tap on
  /// a row jumps.
  @MainActor
  func testTapOnCurrentTabOpensWindow() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    let home = visits[2]
    open(app, home)
    let target = try XCTUnwrap(barTabs(app).first { $0 != home }, "another tab in the project of \(home)")
    let window = element(app, "switcher.window")
    element(app, "tab.\(home)").tap()
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "a tap on the current tab opens the window")
    snapshot(app, "z-dotyku")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5), "a tap outside closes the window")
    XCTAssertTrue(selected(app, home), "no jump")
    settle(1)
    element(app, "tab.\(home)").tap()
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "second opening")
    element(app, "switcher.row.\(target)").tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5))
    XCTAssertTrue(selected(app, target), "a tap on a row jumps at once")
  }

  /// Cmd+S and Shift+Cmd+S on the session screen do nothing: no window, and nothing reaches the message field. The
  /// letter typed after them proves the keys reach the app.
  @MainActor
  func testCommandSDoesNothing() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: keyboard)
    open(app, visits[2])
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "message field")
    field.tap()
    field.typeText("ab")
    XCTAssertEqual(field.value as? String, "ab")
    app.typeKey("s", modifierFlags: .command)
    app.typeKey("s", modifierFlags: [.command, .shift])
    settle(1.5)
    XCTAssertFalse(element(app, "switcher.window").exists, "no window from Cmd+S")
    XCTAssertEqual(field.value as? String, "ab", "Cmd+S types nothing into the field")
    app.typeKey("c", modifierFlags: [])
    XCTAssertTrue(wait(5) { field.value as? String == "abc" }, "the keys reach the field")
  }

  /// While a sheet is open the gate keeps the window shut; after the sheet closes a tap on the current tab opens it.
  @MainActor
  func testSilentUnderSheet() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: keyboard)
    let home = visits[2]
    open(app, home)
    let newSession = element(app, "list.newSession")
    XCTAssertTrue(newSession.waitForAppearance(timeout: 10), "New Session on the list bar")
    newSession.tap()
    let sheet = element(app, "newSession.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "the New Session sheet")
    settle(1)
    XCTAssertFalse(element(app, "switcher.window").exists, "no window under a sheet")
    element(app, "newSession.cancel").tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 10))
    XCTAssertTrue(selected(app, home), "no jump")
    settle(1)
    element(app, "tab.\(home)").tap()
    let window = element(app, "switcher.window")
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "the gate opens after the sheet closes")
    closeOutside(app, window)
    XCTAssertTrue(selected(app, home), "no jump")
  }

  // MARK: - Helpers

  @MainActor
  private func launch(port: Int, reset: Bool, environment: [String: String]) throws -> XCUIApplication {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("an iPad test with the list beside a session") }
    let start = XCUIDevice.shared.orientation
    let back: UIDeviceOrientation = start.isValidInterfaceOrientation ? start : .portrait
    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = back }
    let app = DemoServer.launch(port: port, reset: reset, environment: environment)
    if reset { DemoServer.pair(app) }
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
    DemoServer.hideKeyboard(app)
    XCTAssertTrue(selected(app, id), "session \(id) on screen")
  }

  /// A tap in the background above the window closes it without a jump.
  @MainActor
  private func closeOutside(_ app: XCUIApplication, _ window: XCUIElement) {
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5), "a tap outside closes the window")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// The session is on screen: its tab in the project bar is selected.
  @MainActor
  private func selected(_ app: XCUIApplication, _ id: String, timeout: TimeInterval = 8) -> Bool {
    wait(timeout) {
      let tab = self.element(app, "tab.\(id)")
      return tab.exists && tab.isSelected
    }
  }

  /// Tab ids on the project's tab bar (`tab.<id>`: a session id, `term.<id>` of a terminal), from the left.
  @MainActor
  private func barTabs(_ app: XCUIApplication) -> [String] {
    let prefix = "tab."
    let found = element(app, "tabs.bar").descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).allElementsBoundByIndex
    var seen: Set<String> = []
    return found.map { (id: String($0.identifier.dropFirst(prefix.count)), left: $0.frame.minX) }
      .sorted { $0.left < $1.left }
      .compactMap { seen.insert($0.id).inserted ? $0.id : nil }
  }

  /// Tab ids in the switcher window (`switcher.row.<id>`), from the top.
  @MainActor
  private func rows(_ app: XCUIApplication) -> [String] {
    let prefix = "switcher.row."
    let found = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).allElementsBoundByIndex
    var seen: Set<String> = []
    return found.map { (id: String($0.identifier.dropFirst(prefix.count)), top: $0.frame.minY) }
      .sorted { $0.top < $1.top }
      .compactMap { seen.insert($0.id).inserted ? $0.id : nil }
  }

  @MainActor
  private func rowSelected(_ app: XCUIApplication, _ id: String) -> Bool {
    wait(5) { self.element(app, "switcher.row.\(id)").isSelected }
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

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "przelacznik-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
