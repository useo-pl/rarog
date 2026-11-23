import XCTest

/// Zrzuty głównych ekranów do oceny wzrokowej. Test prowadzi apkę do stanu
/// i zostawia w katalogu `RAROG_SCREENSHOT_DIR` plik `<nazwa>.request`; skrypt na zewnątrz robi
/// `xcrun simctl io <udid> screenshot` (albo zatrzymuje serwer demo przy `stop-server`) i odpowiada
/// plikiem `<nazwa>.done`. Bez katalogu test jest pomijany — nie wchodzi do bramki.
final class ScreenshotUITests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureMainScreens() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    XCTAssertTrue(app.descendants(matching: .any)["pair.start"].firstMatch.waitForAppearance(timeout: 15))
    try request("parowanie", app)

    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app))
    sleep(1)
    try request("lista", app)

    DemoServer.reveal(app, "demo-rarog").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10))
    sleep(4)
    try request("transkrypt", app)

    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(app.descendants(matching: .any)["card.permission.demo-perm-willow"].firstMatch.waitForAppearance(timeout: 15))
    sleep(2)
    try request("zgoda", app)

    DemoServer.reveal(app, "demo-fleet-ops").tap()
    XCTAssertTrue(app.descendants(matching: .any)["card.permission.demo-perm-fleet-ops"].firstMatch.waitForAppearance(timeout: 15))
    sleep(2)
    try request("zgoda-ryzykowna", app)

    // „Nie potwierdzono": serwer znika w trakcie wysyłki — wpis zostaje z Ponów/Odrzuć.
    DemoServer.reveal(app, "demo-rarog").tap()
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 10))
    sleep(2)
    try request("stop-server", app)
    composer.tap()
    composer.typeText("Sprawdź jeszcze testy widoków")
    app.buttons["composer.send"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["pending.status"].firstMatch.waitForAppearance(timeout: 20))
    sleep(2)
    try request("nie-potwierdzono", app)
  }

  /// Zostawia prośbę i czeka na odpowiedź skryptu (zrzut ekranu albo zatrzymanie serwera).
  /// Klawiatura ekranowa schodzi przed zrzutem: symulator zgłasza klawiaturę sprzętową, więc pole
  /// dostaje fokus samo, a pół ekranu klawiatury zasłaniałoby oceniany układ.
  @MainActor
  private func request(_ name: String, _ app: XCUIApplication) throws {
    if app.keyboards.count > 0 {
      DemoServer.hideKeyboard(app)
      sleep(1)
    }
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
      Thread.sleep(forTimeInterval: 0.2)
    }
  }
}
