import UIKit
import XCTest

/// Wysyłka zdjęcia przez wklejenie przeciw serwerowi demo: Cmd+V obrazka ze
/// schowka → miniatura nad polem → „Wyślij" → echo o dokładnym tekście i wpis kolejki zgasł.
/// Właściciel: wysyłka.
final class AttachmentUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// Obraz testowy w schowku systemu (proces testów i apka dzielą schowek symulatora).
  @MainActor
  private func putImageOnPasteboard() {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 200))
    let image = renderer.image { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 320, height: 200))
      UIColor.systemOrange.setFill()
      context.fill(CGRect(x: 40, y: 40, width: 120, height: 80))
    }
    UIPasteboard.general.image = image
  }

  /// Wklejenie: Cmd+V z klawiatury sprzętowej, a gdy symulator jej nie poda — menu edycji.
  @MainActor
  private func paste(into field: XCUIElement, _ app: XCUIApplication) {
    field.tap()
    app.typeKey("v", modifierFlags: .command)
    let strip = app.descendants(matching: .any)["composer.attachment.0"].firstMatch
    if strip.waitForAppearance(timeout: 5) { return }
    field.press(forDuration: 1.2)
    for label in ["Paste", "Wklej"] where app.menuItems[label].waitForAppearance(timeout: 2) {
      app.menuItems[label].tap()
      return
    }
  }

  @MainActor
  func testPasteImageSendEcho() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 15), "pole wiadomości")
    XCTAssertTrue(app.buttons["composer.attach"].exists, "spinacz w pasku akcji")

    // Wklejony obraz staje miniaturą nad polem; „×" go zdejmuje.
    putImageOnPasteboard()
    paste(into: composer, app)
    let tile = app.descendants(matching: .any)["composer.attachment.0"].firstMatch
    XCTAssertTrue(tile.waitForAppearance(timeout: 10), "miniatura nad polem po wklejeniu")
    XCTAssertTrue(tile.label.hasPrefix("Zdjęcie 1"), "opis kafelka: \(tile.label)")
    app.buttons["composer.attachment.remove.0"].tap()
    XCTAssertTrue(tile.waitForDisappearance(timeout: 5), "„×” zdejmuje załącznik")

    // Wklejenie, tekst i „Wyślij": echo o dokładnym tekście od serwera, wpis kolejki gaśnie.
    putImageOnPasteboard()
    paste(into: composer, app)
    XCTAssertTrue(tile.waitForAppearance(timeout: 10), "miniatura po drugim wklejeniu")
    // Zrzut paska nad polem do oceny wzrokowej (zostaje w wyniku testu).
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "pasek-zalacznikow"
    shot.lifetime = .keepAlways
    add(shot)
    let text = "zdjęcie \(UUID().uuidString.prefix(6))"
    composer.tap()
    composer.typeText(text)
    app.buttons["composer.send"].tap()
    XCTAssertTrue(tile.waitForDisappearance(timeout: 5), "pasek wyczyszczony po wysyłce")
    DemoServer.hideKeyboard(app)
    let echo = app.textViews.matching(NSPredicate(
      format: "identifier BEGINSWITH 'message.m' AND (label == %@ OR label == %@)", "Ty: \(text)", text)).firstMatch
    var found = echo.waitForAppearance(timeout: 15)
    for _ in 0..<6 where !found {
      app.collectionViews["transcript"].swipeDown(velocity: .slow)
      found = echo.waitForAppearance(timeout: 1)
    }
    XCTAssertTrue(found, "echo wiadomości ze zdjęciem w transkrypcie")
    let pending = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).firstMatch
    XCTAssertTrue(pending.waitForDisappearance(timeout: 10), "wpis kolejki zgasł po echu")
    XCTAssertFalse(app.descendants(matching: .any)["pending.status"].exists, "bez „Nie potwierdzono” i odmowy")
  }
}
