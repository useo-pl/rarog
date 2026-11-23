import XCTest

/// Pięć ekranów odbioru w obu motywach i w zwykłym/największym piśmie.
/// Artefakty trafiają do xcresult; sam zrzut nie zastępuje jego oceny wzrokowej.
/// The class only takes screenshots (its taps are covered by gate tests), so without `RAROG_SCREENSHOT_DIR` it is
/// skipped: screenshots are taken by hand, outside the gate. The screenshots stay attachments in the test result.
final class AcceptanceScreenshotUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
    guard ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil else {
      throw XCTSkip("no RAROG_SCREENSHOT_DIR: screenshots are taken by hand, outside the gate")
    }
  }

  @MainActor
  func testLightScreens() async throws { try await capture(theme: "Light", largest: false) }

  @MainActor
  func testDarkScreens() async throws { try await capture(theme: "Dark", largest: false) }

  @MainActor
  func testLightLargestScreens() async throws { try await capture(theme: "Light", largest: true) }

  @MainActor
  func testDarkLargestScreens() async throws { try await capture(theme: "Dark", largest: true) }

  @MainActor
  private func capture(theme: String, largest: Bool) async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("cannot-allow", label: "M1 zrzuty")
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme.lowercased()
    if largest {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    }
    app.launch()
    let suffix = "\(theme.lowercased())-\(largest ? "ax5" : "normal")"
    XCTAssertTrue(app.descendants(matching: .any)["pair.start"].firstMatch.waitForAppearance(timeout: 15))
    snapshot(app, "parowanie-\(suffix)")
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    XCTAssertTrue(DemoServer.reveal(app, id).exists, "własna sesja jest na przewiniętej liście")
    DemoServer.hideKeyboard(app)
    snapshot(app, "lista-\(suffix)")
    DemoServer.reveal(app, id).tap()
    let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15))
    DemoServer.hideKeyboard(app)
    snapshot(app, "sesja-karta-\(suffix)")
    let model = element(app, "composer.model")
    XCTAssertTrue(model.waitForAppearance(timeout: 10))
    model.tap()
    XCTAssertTrue(element(app, "model.sheet").waitForAppearance(timeout: 10))
    snapshot(app, "model-\(suffix)")
    let dismiss = element(app, "model.dismiss")
    if dismiss.exists {
      dismiss.tap()
    } else {
      let sheet = element(app, "model.sheet").frame
      let transcript = element(app, "transcript").frame
      let x = sheet.maxX + 20 < transcript.maxX ? (sheet.maxX + transcript.maxX) / 2 : (transcript.minX + sheet.minX) / 2
      app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: transcript.minY + 30)).tap()
    }
    XCTAssertTrue(element(app, "model.sheet").waitForDisappearance(timeout: 10))
    let newSession = element(app, "list.newSession")
    if !newSession.waitForAppearance(timeout: 2) {
      app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [])
      app.typeKey("b", modifierFlags: .command)
    }
    XCTAssertTrue(newSession.waitForAppearance(timeout: 10))
    newSession.tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForAppearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    snapshot(app, "nowa-sesja-\(suffix)")
    // Drugi kadr: sekcja Start i nagłówek rozmów — dowód wzrostu z pismem dla wyjątku audytu.
    let hint = element(app, "newSession.modeHint")
    let footerTop = element(app, "newSession.launch").frame.minY
    for _ in 0..<8 where !(hint.exists && hint.frame.maxY > 0 && hint.frame.maxY < footerTop - 40) {
      element(app, "newSession.sheet").swipeUp(velocity: .slow)
    }
    snapshot(app, "nowa-sesja-start-\(suffix)")
    element(app, "newSession.cancel").tap()
    app.terminate()
    try await control.reset()
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "M1-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
