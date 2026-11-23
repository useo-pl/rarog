import XCTest

/// Zrzuty rundy 4 poprawek wyglądu z ramkami elementów, do porównania przed i po (iPad):
/// wybrany agent na liście (z fokusem klawiatury i bez), nagłówek sesji (przycisk zwijania listy, tytuł),
/// granica listy i szczegółu, lista zwinięta i pole wiadomości po usunięciu tekstu Backspace'em i po wysyłce
/// (pigułka klawiatury iPadOS). Test pisze `<nazwa>-<motyw>.png` i `<nazwa>-<motyw>.json` (ramki w punktach
/// i skala zrzutu) wprost do `RAROG_SCREENSHOT_DIR`. Bez katalogu jest pomijany: zrzuty robi się ręcznie,
/// poza bramką.
final class PadFramesScreenshotUITests: XCTestCase {
  private var directory: URL!

  /// Elementy, których ramki trafiają do pliku pomiaru (początek identyfikatora).
  private static let measured = ["session.", "list.", "header.", "tab.", "tabs.", "composer.", "split."]

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("runda 4 dotyczy układu iPada") }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureDark() throws { try capture(theme: "dark") }

  @MainActor
  func testCaptureLight() throws { try capture(theme: "light") }

  @MainActor
  private func capture(theme: String) throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    // Klawiatura sprzętowa: pierwszy klawisz przełącza symulator z klawiatury ekranowej.
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])

    // Wybrany agent po tapnięciu (zgłoszenie: niebieska obwódka) i nagłówek sesji z tytułem.
    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(wait("selected == true", element(app, "tab.demo-willow")), "sesja willow otwarta")
    DemoServer.hideKeyboard(app)
    sleep(1)
    try shot(app, "wybor", theme)

    // Lista zwinięta Cmd+B i rozwinięta z powrotem.
    app.typeKey("b", modifierFlags: .command)
    sleep(1)
    try shot(app, "zwinieta", theme)
    app.typeKey("b", modifierFlags: .command)
    sleep(1)

    // Pole: tekst, usunięcie Backspace'em do pustego pola, wysyłka (pigułka klawiatury iPadOS). Sesja pracuje,
    // więc pole przyjmuje tekst (willow czeka na zgodę i ma pole wygaszone).
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "pole sesji")
    field.tap()
    field.typeText("abc")
    sleep(1)
    try shot(app, "pole-tekst", theme)
    // Backspace jak człowiek (symulator bez klawiatury sprzętowej pisze klawiaturą ekranową).
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3))
    sleep(2)
    try shot(app, "pole-usuniete", theme)
    field.typeText("R4 test")
    app.buttons["composer.send"].tap()
    sleep(2)
    try shot(app, "pole-po-wysylce", theme)
    app.terminate()
  }

  /// Zrzut całego ekranu (z oknem klawiatury) i ramki mierzonych elementów (punkty) obok siebie.
  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "R4-\(name)-\(theme)"
    attachment.lifetime = .keepAlways
    add(attachment)
    try screenshot.pngRepresentation.write(to: directory.appending(path: "\(name)-\(theme).png"))
    let predicate = NSPredicate(format: Self.measured.map { "identifier BEGINSWITH '\($0)'" }.joined(separator: " OR "))
    var frames: [[String: Any]] = []
    for item in app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex where item.exists {
      let frame = item.frame
      frames.append([
        "id": item.identifier, "label": item.label, "selected": item.isSelected, "focus": item.hasFocus,
        "x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height,
      ])
    }
    let report: [String: Any] = [
      "screen": name, "theme": theme, "pointsWidth": app.frame.width,
      "scale": screenshot.image.scale, "frames": frames,
      "keyboards": app.keyboards.allElementsBoundByIndex.map { NSCoder.string(for: $0.frame) },
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: directory.appending(path: "\(name)-\(theme).json"))
    try app.debugDescription.write(to: directory.appending(path: "\(name)-\(theme).txt"), atomically: true, encoding: .utf8)
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
