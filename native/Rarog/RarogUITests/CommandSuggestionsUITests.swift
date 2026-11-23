import UIKit
import XCTest

/// Podpowiedzi slash-komend nad polem wiadomości przeciw serwerowi demo: po „/c” w polu
/// `demo-rarog` lista z `GET /api/sessions/<id>/commands` (demo: stała lista z rejestru) pokazuje komendy
/// na „c”, bez innych, a stuknięcie w wiersz wstawia `/nazwa ` ze spacją i zamyka listę. Klawisze (Return, Tab,
/// ↑/↓, Esc) sprawdza `RarogUIKitTests/CommandSuggestionsKeysTests`: Esc z XCUITest nie dochodzi do skrótów apki.
/// Zrzut ekranu z otwartą listą zostaje w wyniku testu, a przy `RAROG_SCREENSHOT_DIR` — także
/// plik `komendy-<urządzenie>.png`. Właściciel: pole.
final class CommandSuggestionsUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSlashListsCommandsAndTapInserts() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 15), "pole wiadomości")

    field.tap()
    field.typeText("/c")
    let list = app.scrollViews["commands.suggestions"]
    XCTAssertTrue(list.waitForAppearance(timeout: 10), "lista podpowiedzi po „/c”")
    let compact = app.buttons["commands.suggestion.compact"]
    XCTAssertTrue(compact.waitForAppearance(timeout: 5), "/compact na liście")
    XCTAssertTrue(app.buttons["commands.suggestion.clear"].exists, "/clear na liście")
    XCTAssertFalse(app.buttons["commands.suggestion.batch"].exists, "filtr prefiksem: /batch nie zaczyna się od „c”")
    // Ramkę czytamy, gdy lista stanie: odczyt 0,45 s po „/c” bywa jeszcze pod polem.
    DemoServer.waitUntilStill(list)
    XCTAssertLessThan(list.frame.maxY, field.frame.minY, "lista nad polem")
    shot(app, "komendy-\(UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone")")

    compact.tap()
    let inserted = NSPredicate { _, _ in (field.value as? String) == "/compact " }
    XCTAssertEqual(
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: inserted, object: nil)], timeout: 5), .completed,
      "stuknięcie wstawia nazwę ze spacją: \(field.value ?? "")")
    XCTAssertTrue(list.waitForDisappearance(timeout: 5), "spacja zamyka listę")
    XCTAssertFalse(
      app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).firstMatch.exists,
      "wstawienie nic nie wysyła")
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String) {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else { return }
    let file = URL(filePath: path, directoryHint: .isDirectory).appending(path: "\(name).png")
    try? screenshot.pngRepresentation.write(to: file)
  }
}
