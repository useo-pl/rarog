import XCTest

/// Zrzuty listy do oceny wzrokowej (poprawki wyglądu listy): nagłówek w jednym wierszu
/// i po przewinięciu, sesja otwarta obok (iPad), a do tego dwa nagrania
/// wideo: zmiana rangi wiersza na oczach i powrót z sesji (iPhone). Ten sam protokół co
/// `ScreenshotUITests`: test zostawia `<nazwa>.request` w `RAROG_SCREENSHOT_DIR`, skrypt na
/// zewnątrz robi `xcrun simctl io <udid> screenshot` (albo zaczyna nagranie przy `rec-start-<nazwa>`
/// i kończy je przy `rec-stop`) i odpowiada plikiem `<nazwa>.done`. Bez katalogu test jest pomijany.
final class ListScreenshotUITests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureListScreens() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 lista")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let usage = app.descendants(matching: .any)["list.usage"].firstMatch
    let numbers = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "27 procent"), object: usage)
    XCTAssertEqual(XCTWaiter.wait(for: [numbers], timeout: 15), .completed, "liczby limitów")
    sleep(2)
    try request("lista", app)

    let list = app.descendants(matching: .any)["session.list"].firstMatch
    list.swipeUp(velocity: .slow)
    sleep(2)
    try request("lista-przewinieta", app)
    list.swipeDown(velocity: .fast)
    list.swipeDown(velocity: .fast)
    sleep(1)

    // Zmiana rangi na oczach: bezczynna → pracuje → bezczynna, bez plamy na wierszu.
    XCTAssertTrue(DemoServer.reveal(app, id).exists, "wiersz sesji testu")
    try request("rec-start-ranga", app)
    try await control.emit("delta", sessionId: id, text: "M1 lista pracuje")
    sleep(2)
    try request("ranga-pracuje", app)
    try await control.emit("message", sessionId: id, text: "M1 lista gotowe")
    sleep(3)
    try request("rec-stop", app)

    // Wejście w sesję i powrót (iPhone) albo sesja obok (iPad).
    try request("rec-start-powrot", app)
    DemoServer.reveal(app, id).tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "ekran sesji")
    DemoServer.hideKeyboard(app)
    sleep(2)
    if list.exists, list.isHittable {
      try request("rec-stop", app)
      try request("sesja-obok", app)
      // Kolumna listy aktywna (stuknięcie w puste tło pod wierszami): na urządzeniu systemowe zaznaczenie
      // robi się wtedy niebieskie.
      let frame = list.frame
      app.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: frame.midX, dy: frame.minY + frame.height * 0.6)).tap()
      sleep(1)
      try request("sesja-obok-lista-aktywna", app)
    } else {
      app.navigationBars.buttons.element(boundBy: 0).tap()
      try request("po-powrocie-od-razu", app)
      sleep(3)
      try request("rec-stop", app)
      try request("po-powrocie", app)
    }
    app.terminate()
    try await control.reset()
  }

  /// Zostawia prośbę i czeka na odpowiedź skryptu (zrzut, początek albo koniec nagrania).
  @MainActor
  private func request(_ name: String, _ app: XCUIApplication) throws {
    try app.debugDescription.write(to: directory.appending(path: "\(name).tree.txt"), atomically: true, encoding: .utf8)
    let done = directory.appending(path: "\(name).done")
    try? FileManager.default.removeItem(at: done)
    try Data().write(to: directory.appending(path: "\(name).request"))
    let deadline = Date().addingTimeInterval(30)
    while !FileManager.default.fileExists(atPath: done.path) {
      guard Date() < deadline else {
        XCTFail("skrypt zrzutów nie odpowiedział na \(name)")
        return
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
}
