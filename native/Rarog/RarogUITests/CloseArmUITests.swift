import XCTest

/// The "×" in the current tab against the demo server: its own target after the label, the arming card under the
/// bar, the app in the background before the 5 s run out puts out "Sure?" and the card, so a press after coming
/// back arms anew instead of closing the pane. Two presses in a row still close (a tap is not a loss of focus).
///
/// Each test creates its session ("+" in the data-loader project, whose tabs no other test counts) and closes it.
final class CloseArmUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSceneDeactivationDisarmsClose() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    let row = DemoServer.reveal(app, "demo-data-loader")
    XCTAssertTrue(row.exists, "sesja data-loader na liście")
    row.tap()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-data-loader")), "projekt data-loader otwarty")

    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait("count == \(before + 1)", tabs, timeout: 15), "nowa zakładka na pasku")
    let created = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
    XCTAssertTrue(created.waitForAppearance(timeout: 10))
    let createdId = created.identifier
    XCTAssertNotEqual(createdId, "tab.demo-data-loader", "bieżąca jest nowa sesja")

    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    let armedAt = Date()
    close.tap()
    // Pojedyncze odczyty etykiety, nie czekanie: całość musi się zmieścić w 5 s uzbrojenia.
    XCTAssertTrue(close.label.hasPrefix("Na pewno?"), "pierwsze naciśnięcie uzbraja")
    XCTAssertTrue(element(app, "tabs.closeArmed").exists, "the arming card under the bar")

    // Apka w tło i z powrotem przed upływem 5 s: „Na pewno?" zgasło, naciśnięcie uzbraja od nowa.
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    let label = close.label
    // Czas w logu: odczyt później niż 5 s po uzbrojeniu niczego by nie rozstrzygał (pomiar:
    // 4,5–4,9 s).
    let elapsed = Date().timeIntervalSince(armedAt)
    print(String(format: "zamknięcie-uzbrojenie: odczyt po powrocie %.1f s po uzbrojeniu", elapsed))
    XCTAssertFalse(label.hasPrefix("Na pewno?"), "powrót do apki gasi uzbrojenie (\(label))")
    XCTAssertFalse(element(app, "tabs.closeArmed").exists, "the card goes with the arming")
    close.tap()
    XCTAssertTrue(waitLabel(close, prefix: "Na pewno?"), "po powrocie naciśnięcie uzbraja od nowa")
    XCTAssertTrue(element(app, createdId).exists, "po powrocie nic nie zamknięte")

    // Dwa naciśnięcia bez przerwy zamykają.
    close.tap()
    XCTAssertTrue(element(app, createdId).waitForDisappearance(timeout: 10), "drugie naciśnięcie zamyka")
  }

  /// The "×" is a target of its own: about 28 × 44 pt right after the current tab's label. A tap on the label opens
  /// the window of the project's tabs and arms nothing; a tap on the "×" arms and shows the card; a second tap closes
  /// the tab.
  @MainActor
  func testTabCloseTargetArmsAndCloses() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "the session list")
    DemoServer.hideKeyboard(app)
    let row = DemoServer.reveal(app, "demo-data-loader")
    XCTAssertTrue(row.exists, "the data-loader session on the list")
    row.tap()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-data-loader")), "the data-loader project open")

    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait("count == \(before + 1)", tabs, timeout: 15), "a new tab on the bar")
    let created = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
    XCTAssertTrue(created.waitForAppearance(timeout: 10))
    let createdId = created.identifier
    XCTAssertNotEqual(createdId, "tab.demo-data-loader", "the new session is the current tab")
    let current = element(app, createdId)
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    // Cleanup also after a failure: the test's own session goes with two presses of its "×" (the demo's pane ceiling).
    addTeardownBlock { @MainActor in
      guard current.exists, close.exists else { return }
      close.tap()
      close.tap()
    }

    let target = close.frame
    let label = current.frame
    print("close-arm: “×” \(target), label \(label)")
    XCTAssertEqual(target.width, 28, accuracy: 1, "“×” target width")
    XCTAssertGreaterThanOrEqual(target.height, 43.5, "“×” target height")
    XCTAssertGreaterThanOrEqual(target.minX, label.maxX, "the “×” is an element of its own after the label")
    XCTAssertLessThanOrEqual(target.minX - label.maxX, 2, "the “×” right after the divider")

    current.tap()
    let window = element(app, "switcher.window")
    XCTAssertTrue(window.waitForAppearance(timeout: 5), "a tap on the label opens the window of the project's tabs")
    XCTAssertFalse(close.label.hasPrefix("Na pewno?"), "the label's tap arms nothing (\(close.label))")
    XCTAssertFalse(element(app, "tabs.closeArmed").exists, "no arming card")
    element(app, "switcher.row.\(createdId.dropFirst("tab.".count))").tap()
    XCTAssertTrue(window.waitForDisappearance(timeout: 5), "picking the current row closes the window")

    close.tap()
    XCTAssertTrue(waitLabel(close, prefix: "Na pewno?"), "the first press arms")
    XCTAssertTrue(element(app, "tabs.closeArmed").exists, "the arming card under the bar")
    XCTAssertTrue(current.exists, "nothing closed yet")
    close.tap()
    XCTAssertTrue(current.waitForDisappearance(timeout: 10), "the second press closes the tab")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitSelected(_ element: XCUIElement) -> Bool {
    wait("exists == true AND selected == true", element)
  }

  private func waitLabel(_ element: XCUIElement, prefix: String) -> Bool {
    wait("label BEGINSWITH '\(prefix)'", element, timeout: 5)
  }
}
