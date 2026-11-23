import UIKit
import XCTest

/// Limity planu i obciążenie Maca w karcie stopki listy przeciw serwerowi demo, który oddaje stałe
/// liczby (`server/src/demo/usage.ts`: 5 h 27 %, tydzień 64 %, Fable 91 %, konto `demo@example.com`;
/// `server/src/demo/mac.ts`: CPU 35 %, RAM 80 %, dysk 95 %). Właściciel: lista.
final class UsageUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// The list footer card always shows the limits and the machine at once. It is not a control:
  /// one static element, a tap opens nothing; the "Usage" sheet comes from the `/usage` app command
  /// (`testUsageCommandOpensLimitsSheet`) and the server update row.
  @MainActor
  func testUsageCardShowsNumbersAndIsNotAControl() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")

    // The card stands under the list from the first frame (skeleton); the numbers come with the reading after login.
    let card = app.descendants(matching: .any)["list.usage"].firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 10), "footer card")
    XCTAssertFalse(app.buttons["list.usage"].exists, "the card is not a button")
    let numbers = NSPredicate(format: "label CONTAINS %@", "okno 5 godzin: 27 procent")
    let loaded = XCTNSPredicateExpectation(predicate: numbers, object: card)
    XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 15), .completed, "demo numbers in the card: \(card.label)")
    // Two fields, 5 h and week: the demo's per-model window (Fable 91 %) is only in the sheet.
    XCTAssertTrue(card.label.contains("tydzień: 64 procent"), card.label)
    XCTAssertFalse(card.label.contains("Fable"), card.label)
    // One element, one sentence: limits and the machine with the threshold level, no expand state.
    let mac = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS %@", "Mac — procesor 35 procent; pamięć 80 procent, wysokie"),
      object: card)
    XCTAssertEqual(XCTWaiter.wait(for: [mac], timeout: 15), .completed, "machine in the card's sentence: \(card.label)")
    XCTAssertTrue(card.label.contains("dysk 95 procent, krytyczne"))
    XCTAssertFalse(card.label.contains("szczegóły"), "no show or hide details: \(card.label)")
    XCTAssertFalse(app.descendants(matching: .any)["list.usage.panel"].exists, "no expanded panel")

    card.tap()
    XCTAssertFalse(
      app.descendants(matching: .any)["usage.sheet"].firstMatch.waitForAppearance(timeout: 2), "a tap opens nothing")
  }

  /// Komenda apki `/usage`: wpisana w pole `demo-rarog` i wysłana otwiera arkusz „Limity” z oknem
  /// 5 h, tygodniem i tygodniem Fable (demo: szczegóły z odczytem sprzed 47 min, `server/src/demo/usage.ts`) i notką
  /// „Stan z …”; w transkrypcie nie ma echa. Zrzut z otwartym arkuszem zostaje w wyniku testu, a przy
  /// `RAROG_SCREENSHOT_DIR` — także plik `limity-<urządzenie>.png`. Klawisze i aliasy: `UsageSheetUIKitTests`.
  @MainActor
  func testUsageCommandOpensLimitsSheet() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 15), "pole wiadomości")
    field.tap()
    field.typeText("/usage")
    app.buttons["composer.send"].tap()

    let sheet = app.descendants(matching: .any)["usage.sheet"].firstMatch
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "arkusz „Limity”")
    let model = app.descendants(matching: .any)["usage.sheet.model"].firstMatch
    XCTAssertTrue(model.waitForAppearance(timeout: 10), "wiersz tygodnia Fable")
    XCTAssertTrue(model.label.hasPrefix("Tydzień — Fable: 91 procent, reset "), model.label)
    XCTAssertTrue(app.descendants(matching: .any)["usage.sheet.5h"].exists, "wiersz okna 5 h")
    XCTAssertTrue(app.descendants(matching: .any)["usage.sheet.7d"].exists, "wiersz tygodnia")
    let stamp = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Stan z ")).firstMatch
    XCTAssertTrue(stamp.waitForAppearance(timeout: 5), "godzina odczytu")
    // The account and the machine section with what each number means (the footer card's details).
    let account = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "demo@example.com"))
    XCTAssertTrue(account.firstMatch.waitForAppearance(timeout: 10), "account in the sheet")
    let machine = app.descendants(matching: .any)["usage.sheet.machine"].firstMatch
    XCTAssertTrue(machine.waitForAppearance(timeout: 10), "machine section in the sheet")
    for prefix in ["Procesor, średnia z minuty: 35 procent", "Pamięć, presja: 80 procent, wysokie",
                   "Dysk, zajęte: 95 procent, krytyczne"] {
      let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
      XCTAssertTrue(row.waitForAppearance(timeout: 5), "machine row: \(prefix)")
    }
    XCTAssertEqual(field.value as? String ?? "", "", "pole puste")
    XCTAssertFalse(
      app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).firstMatch.exists,
      "nic nie poszło do panelu")
    shot(app, "limity-\(UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone")")
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
