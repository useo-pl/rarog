import XCTest

/// Zrzuty rundy 3 poprawek wyglądu z ramkami elementów, do porównania przed i po:
/// lista (odstęp agentów, drzewo projektów), nagłówek sesji (ikony w prawym górnym rogu, pasek zakładek nad
/// linią gita), pole przy pracującej turze, karta pytania z zaznaczeniem pod wskaźnikiem i lista promptów.
/// Test pisze `<nazwa>-<motyw>.png` i `<nazwa>-<motyw>.json` (ramki w punktach i skala zrzutu) wprost do
/// `RAROG_SCREENSHOT_DIR`. Bez katalogu jest pomijany: zrzuty robi się ręcznie, poza bramką.
final class FramesScreenshotUITests: XCTestCase {
  private var directory: URL!

  /// Elementy, których ramki trafiają do pliku pomiaru (początek identyfikatora).
  private static let measured = [
    "session.", "project.", "header.", "tab.", "tabs.", "composer.", "question.",
    "card.question.", "prompts.", "transcript.promptBar", "list.usage",
  ]

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureDark() async throws { try await capture(theme: "dark") }

  @MainActor
  func testCaptureLight() async throws { try await capture(theme: "light") }

  @MainActor
  private func capture(theme: String) async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let question = try await control.create("question", label: "R3 pytanie")
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    sleep(2)
    try shot(app, "lista", theme)
    // Na iPhonie tylko lista; reszta ekranów to układ iPada (lista obok sesji, wskaźnik).
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      app.terminate()
      try await control.reset()
      return
    }

    // Nagłówek sesji z gitem: ikony, pasek zakładek i linia statusu.
    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(wait("selected == true", element(app, "tab.demo-willow")), "sesja willow otwarta")
    XCTAssertTrue(element(app, "header.git").waitForAppearance(timeout: 10), "linia gita")
    DemoServer.hideKeyboard(app)
    sleep(1)
    try shot(app, "naglowek", theme)

    // Pole przy pracującej turze (seed pracuje bez strumienia).
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "pole sesji")
    DemoServer.hideKeyboard(app)
    sleep(2)
    try shot(app, "praca", theme)

    // Karta pytania: zaznaczona odpowiedź, raz bez wskaźnika, raz ze wskaźnikiem nad nią (iPad).
    DemoServer.reveal(app, question).tap()
    let card = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'card.question.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta pytania")
    DemoServer.hideKeyboard(app)
    let option = element(app, "question.option.0.0")
    XCTAssertTrue(option.waitForAppearance(timeout: 5))
    option.tap()
    XCTAssertTrue(wait("selected == true", option), "odpowiedź zaznaczona")
    // Wskaźnik z dala od karty: zrzut samego zaznaczenia.
    let away = element(app, "header.status")
    (away.exists ? away : app.navigationBars.firstMatch).hover()
    sleep(1)
    try shot(app, "pytanie", theme)
    option.hover()
    sleep(1)
    try shot(app, "pytanie-wskaznik", theme)

    // Lista promptów: odjechanie od dna małymi krokami, potem pasek cytatu.
    DemoServer.reveal(app, "demo-data-loader").tap()
    DemoServer.hideKeyboard(app)
    let transcript = app.collectionViews["transcript"]
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    let bar = app.buttons["transcript.promptBar"]
    for _ in 0..<8 where !bar.exists {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
      start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 50)),
                  withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    if bar.waitForAppearance(timeout: 5) {
      bar.tap()
      XCTAssertTrue(element(app, "prompts.sheet").waitForAppearance(timeout: 5), "lista tur")
      sleep(1)
      try shot(app, "prompty", theme)
    }
    app.terminate()
    try await control.reset()
  }

  /// Zrzut i ramki mierzonych elementów (punkty) obok siebie w katalogu zrzutów.
  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "R3-\(name)-\(theme)"
    attachment.lifetime = .keepAlways
    add(attachment)
    try screenshot.pngRepresentation.write(to: directory.appending(path: "\(name)-\(theme).png"))
    let predicate = NSPredicate(format: Self.measured.map { "identifier BEGINSWITH '\($0)'" }.joined(separator: " OR "))
    var frames: [[String: Any]] = []
    for item in app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex where item.exists {
      let frame = item.frame
      frames.append([
        "id": item.identifier, "label": item.label,
        "x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height,
      ])
    }
    let report: [String: Any] = [
      "screen": name, "theme": theme, "pointsWidth": app.frame.width,
      "scale": screenshot.image.scale, "frames": frames,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: directory.appending(path: "\(name)-\(theme).json"))
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ format: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
