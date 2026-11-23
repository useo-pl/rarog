import XCTest

/// Uzbrojenie „×" w nagłówku przeciw serwerowi demo: apka w tle przed upływem 5 s
/// gasi „Na pewno?", więc naciśnięcie po powrocie uzbraja od nowa, zamiast zamykać panel. Dwa
/// naciśnięcia bez przerwy dalej zamykają (samo tapnięcie nie jest utratą fokusu).
///
/// Sesję zakłada test („+" w projekcie data-loader, którego zakładek nie liczy żaden inny test)
/// i test ją zamyka.
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
    close.tap()
    XCTAssertTrue(waitLabel(close, prefix: "Na pewno?"), "po powrocie naciśnięcie uzbraja od nowa")
    XCTAssertTrue(element(app, createdId).exists, "po powrocie nic nie zamknięte")

    // Dwa naciśnięcia bez przerwy zamykają.
    close.tap()
    XCTAssertTrue(element(app, createdId).waitForDisappearance(timeout: 10), "drugie naciśnięcie zamyka")
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
