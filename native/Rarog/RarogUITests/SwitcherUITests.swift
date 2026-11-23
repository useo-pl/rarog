import UIKit
import XCTest

/// The session switcher under Cmd+S against the demo server: the window lists the recently visited
/// sessions, newest first, stays after Cmd+S and survives a cold start of the app (the history lives in
/// the device preferences). The hardware keyboard is faked (`RAROG_UI_TEST_HW_KEYBOARD`), so the window takes it the
/// same way on every simulator. The simulator delivers neither Esc nor Return to a screen without a text field
/// (`native/Rarog/docs/tests.md`, "Tests"): those keys are checked by `SessionSwitcherUIKitTests`.
final class SwitcherUITests: XCTestCase {
  /// Three sessions the demo always has, visited in this order.
  private let visits = ["demo-willow", "demo-data-loader", "demo-rarog"]
  private let keyboard = ["RAROG_UI_TEST_HW_KEYBOARD": "1"]

  override func setUp() {
    continueAfterFailure = false
  }

  /// Visit A, B, C; Cmd+S shows C, B, A with C (the current session) selected; the window stays; the keys move the
  /// selection; a tap on A opens it.
  /// After a cold start of the app (preferences kept) Cmd+S shows the same order, and Cmd+1 with the window open jumps
  /// to row 1 (the window wins over the tab shortcut Cmd+1).
  @MainActor
  func testRecentOrderStaysAndSurvivesColdStart() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: keyboard)
    for id in visits { open(app, id) }
    let (a, b, c) = (visits[0], visits[1], visits[2])

    app.typeKey("s", modifierFlags: .command)
    let window = element(app, "switcher.window")
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "Cmd+S opens the window")
    XCTAssertEqual(Array(rows(app).prefix(3)), [c, b, a], "newest first, the current session on top")
    XCTAssertTrue(rowSelected(app, c), "the selection starts on the current session")
    snapshot(app, "okno")
    settle(1.5)
    XCTAssertTrue(window.exists, "the window stays after Cmd+S")
    // The window's keys reach it through its key commands (a real key press, not the UIKit test's chain walk).
    app.typeKey(XCUIKeyboardKey.downArrow, modifierFlags: [])
    XCTAssertTrue(rowSelected(app, b), "down arrow moves the selection")
    app.typeKey(XCUIKeyboardKey.upArrow, modifierFlags: [])
    XCTAssertTrue(rowSelected(app, c), "up arrow moves it back")
    app.typeKey("s", modifierFlags: [])
    XCTAssertTrue(rowSelected(app, b), "plain S moves like the down arrow")
    XCTAssertTrue(selected(app, c), "the screen under the window stays")
    element(app, "switcher.row.\(a)").tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5))
    XCTAssertTrue(selected(app, a), "a tap on a row opens it")

    settle(1)
    app.typeKey("s", modifierFlags: .command)
    XCTAssertTrue(window.waitForAppearance(timeout: 5))
    let before = rows(app)
    XCTAssertEqual(Array(before.prefix(3)), [a, c, b], "the visit to A moved it on top")
    closeOutside(app, window)
    app.terminate()

    let again = try launch(port: port, reset: false, environment: keyboard)
    again.typeKey("s", modifierFlags: .command)
    let restarted = element(again, "switcher.window")
    XCTAssertTrue(restarted.waitForAppearance(timeout: 5), "Cmd+S after a cold start")
    XCTAssertEqual(rows(again), before, "the same order after a cold start")
    again.typeKey("1", modifierFlags: .command)
    XCTAssertTrue(restarted.waitForDisappearance(timeout: 5), "Cmd+1 picks row 1 and closes the window")
    XCTAssertTrue(selected(again, before[1]), "the jump to row 1, not the tab under Cmd+1")
  }

  /// A tap on the current tab opens the window without a keyboard; a tap outside closes it without a jump, a tap on
  /// a row jumps.
  @MainActor
  func testTapOnCurrentTabOpensWindow() throws {
    let port = try DemoServer.requirePort()
    let app = try launch(port: port, reset: true, environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    let (first, home) = (visits[0], visits[2])
    open(app, first)
    open(app, home)
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
    element(app, "switcher.row.\(first)").tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5))
    XCTAssertTrue(selected(app, first), "a tap on a row jumps at once")
  }

  /// While a sheet is open Cmd+S is silent: no window, no jump. After the sheet closes the shortcut works again.
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
    app.typeKey("s", modifierFlags: .command)
    settle(1.5)
    XCTAssertFalse(element(app, "switcher.window").exists, "no window under a sheet")
    element(app, "newSession.cancel").tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 10))
    XCTAssertTrue(selected(app, home), "no jump")
    settle(1)
    app.typeKey("s", modifierFlags: .command)
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

  /// Session ids in the switcher window, from the top.
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
