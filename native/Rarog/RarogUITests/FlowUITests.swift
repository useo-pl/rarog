import XCTest

/// Główny przepływ przeciw serwerowi demo: parowanie → lista →
/// transkrypt → wysyłka → echo; karta zgody → decyzja.
final class FlowUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testPairListTranscriptSendEcho() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app, waitForList: false)

    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()

    // Transkrypt przypięty do dna: widać ostatnie wiadomości (pierwsza z seeda bywa już nad krawędzią).
    let message = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'message.'")).firstMatch
    XCTAssertTrue(message.waitForAppearance(timeout: 15), "transkrypt sesji")

    // Wysyłka i echo: wiadomość o DOKŁADNIE wysłanym tekście wraca od serwera (identyfikator
    // `message.m…` = wiadomość z transkryptu serwera, nie wpis kolejki `pending.…`).
    let text = "test echa \(UUID().uuidString.prefix(6))"
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 5))
    composer.tap()
    composer.typeText(text)
    app.buttons["composer.send"].tap()
    XCTAssertEqual(composer.value as? String ?? "", "", "pole wyczyszczone po wysyłce")
    DemoServer.hideKeyboard(app)
    let echo = app.textViews.matching(NSPredicate(
      format: "identifier BEGINSWITH 'message.m' AND (label == %@ OR label == %@)", "Ty: \(text)", text)).firstMatch
    // Płynąca odpowiedź agenta pod echem potrafi je wypchnąć nad krawędź — wtedy przewijamy w górę
    // (komórek poza ekranem nie ma w drzewie dostępności).
    var found = echo.waitForAppearance(timeout: 15)
    for _ in 0..<6 where !found {
      app.collectionViews["transcript"].swipeDown(velocity: .slow)
      found = echo.waitForAppearance(timeout: 1)
    }
    XCTAssertTrue(found, "echo o dokładnym tekście w transkrypcie")
    // Echo zgasiło wpis kolejki: ani wpisu, ani „Nie potwierdzono", ani odmowy pod polem.
    let pending = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'pending.'")).firstMatch
    XCTAssertTrue(pending.waitForDisappearance(timeout: 5), "wpis kolejki zgasł po echu")
    XCTAssertFalse(app.descendants(matching: .any)["pending.status"].exists, "bez „Nie potwierdzono\"")
  }

  /// Zgoda nie wychodzi żadnym klawiszem: Tab, Spacja i Enter niczego nie zatwierdzają,
  /// a przycisk „Zatwierdź" nie przyjmuje fokusu. Esc z fokusem na karcie odrzuca — sprawdzane, gdy
  /// fokus dojdzie do karty (w symulatorze system fokusu na klawisze z XCUITest się nie włącza).
  /// Full Keyboard Access (Spacja jako akcja dostępności) pokrywa `ApprovalGateTests` i próba ręczna.
  /// Kartę daje własna sesja odbioru (scenariusz `permission` kontroli demo), nie zgoda seeda `demo-willow`: odrzucenie
  /// na końcu testu zdejmowało ją ze wspólnego demo bramki, a `HeaderChromeUITests` mierzy potem bursztyn zakładki
  /// `demo-willow`, która czeka.
  @MainActor
  func testApprovalNeverByKeyboard() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("permission", label: "M1 zgoda z klawiatury")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.openRow(app, id, project: "rarog")
    let card = app.descendants(matching: .any)["card.permission.m1-permission"].firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody")
    let allow = app.descendants(matching: .any)["card.allow"].firstMatch
    XCTAssertTrue(allow.exists)

    // Tab, Spacja i Enter z klawiatury sprzętowej, kilka razy: żaden nie zatwierdza, a „Zatwierdź"
    // nigdy nie dostaje fokusu. Fokus klawiatury może stanąć wyłącznie na komórce karty.
    // Karta stoi w transkrypcie (tryb domyślny) albo w doku w miejscu pola (tryb `.dock`).
    let dock = app.descendants(matching: .any)["dock"].firstMatch
    let cell = app.cells.containing(.any, identifier: "card.permission.m1-permission").firstMatch
    var cardCell: XCUIElement { dock.exists ? dock : cell }
    var cardFocused = false
    for _ in 0..<8 {
      app.typeKey(XCUIKeyboardKey.tab, modifierFlags: [])
      XCTAssertFalse(allow.hasFocus, "„Zatwierdź” nie przyjmuje fokusu klawiatury")
      cardFocused = cardFocused || cardCell.hasFocus
      app.typeKey(XCUIKeyboardKey.space, modifierFlags: [])
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
    }
    sleep(1)
    XCTAssertTrue(card.exists, "karta stoi — żaden klawisz jej nie zatwierdził")
    XCTAssertFalse(app.staticTexts["card.status"].exists, "żadna decyzja nie wyszła")
    let afterKeys = try await control.stats()
    XCTAssertEqual(afterKeys.receivedDecisions.count, 0, "żadna decyzja nie doszła do serwera")

    if cardCell.hasFocus {
      // Esc z fokusem na karcie = „Odrzuć".
      app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
    } else {
      // Symulator nie włącza systemu fokusu na zdarzenia klawiszy z XCUITest (żaden element nie
      // dostaje fokusu po Tab) — Esc na karcie sprawdza się ręcznie na iPadzie; tu kartę zdejmuje dotyk.
      print("klawiatura: fokus karty po Tab = \(cardFocused) — Esc do próby ręcznej na iPadzie")
      app.buttons["card.deny"].tap()
    }
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po odrzuceniu")
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testPermissionCardDecision() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)

    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-fleet-ops").tap()

    let card = app.descendants(matching: .any)["card.permission.demo-perm-fleet-ops"].firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody")
    XCTAssertFalse(app.textViews["composer.field"].exists, "pole schowane, gdy karta czeka na decyzję")
    XCTAssertTrue(app.buttons["card.allow"].exists)

    // Demo odmawia zatwierdzenia tej karty (422): karta ZOSTAJE ze zdaniem.
    app.buttons["card.allow"].tap()
    let error = app.staticTexts["card.error"]
    XCTAssertTrue(error.waitForAppearance(timeout: 10), "zdanie odmowy pod kartą")
    XCTAssertTrue(card.exists, "karta zostaje po 422")

    // Odrzucenie przechodzi: karta znika, gdy serwer zgłosi rozstrzygnięcie.
    app.buttons["card.deny"].tap()
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po odrzuceniu")
  }
}
