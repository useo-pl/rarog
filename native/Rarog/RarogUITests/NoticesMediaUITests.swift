import XCTest

/// Notki harnessu i zdjęcia w wiadomościach przeciw serwerowi demo: sesja
/// `demo-pipe-link` ma trzy notki (skończona, zatrzymana, nieudana), zdjęcia z `/uploads`
/// (mock nadzorcy trzyma je w RAM; jedno „po sprzątaniu" daje 404), PDF i wykres w treści agenta.
/// Właściciel: notki i miniatury.
final class NoticesMediaUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testNoticesAndPhotos() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-pipe-link").tap()
    DemoServer.hideKeyboard(app)
    let transcript = app.collectionViews["transcript"]
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10), "transkrypt")

    // Notki: jedno zdanie systemowe, „Uwaga" słyszy czytnik tylko przy niepowodzeniu.
    let failed = notice(app, containing: "NIE powiodła się")
    XCTAssertTrue(reveal(failed, in: transcript), "notka nieudanej komendy")
    XCTAssertEqual(failed.label, "Uwaga: Komenda w tle NIE powiodła się (kod 1) — „pnpm run e2e:presence”. Pełny wynik w terminalu.")
    let halted = notice(app, containing: "Subagent zatrzymany")
    XCTAssertTrue(reveal(halted, in: transcript), "notka zatrzymanego subagenta")
    XCTAssertEqual(halted.label, "Subagent zatrzymany — „przegląd logu obecności”. Pełny wynik w terminalu.")

    // Obrazek z treści agenta: miniatura z data URL-a, bez sieci.
    let chart = app.buttons.matching(Self.thumbnail(label: "Wykres zdarzeń obecności")).firstMatch
    XCTAssertTrue(reveal(chart, in: transcript), "miniatura wykresu")
    snapshot(app, "notki-i-wykres")

    // Zdjęcia z serwera: `GET …/uploads` z cookie; zdjęcie po sprzątaniu = kafel „Zdjęcie".
    let gone = app.descendants(matching: .any).matching(Self.thumbnail(label: "Zdjęcie")).firstMatch
    XCTAssertTrue(reveal(gone, in: transcript, timeout: 10), "kafel zdjęcia, którego serwer już nie ma")
    let photos = app.buttons.matching(Self.thumbnail(label: "Zdjęcie 1"))
    XCTAssertTrue(reveal(photos.firstMatch, in: transcript), "miniatura zdjęcia z serwera")
    let done = NSPredicate(format: "count == 2")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: photos)], timeout: 10), .completed,
                   "oba zdjęcia z serwera wczytane (z wagą i z historii bez wagi)")

    // Plik: chip z nazwą i wagą. Zdjęcie z historii (bez nazwy, bez wagi) nie zostawia pustej linii.
    let chip = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'chip.' AND label == %@", "notatki-obecnosc.pdf, 178\u{00A0}kB"))
      .firstMatch
    XCTAssertTrue(reveal(chip, in: transcript), "chip PDF z wagą")
    XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Załączniki")).count, 0)
    // Surowego wpisu harnessu nie ma w żadnej wiadomości (znaczniki zaczynają się od „<").
    XCTAssertEqual(app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "<")).count, 0)
    snapshot(app, "zdjecia-i-chip")

    // A tap on a thumbnail opens QuickLook alone, with its own close button; a tap on the image does not close it.
    // XCUITest's Esc reaches no Esc handler in the simulator, so Esc is checked on an iPad.
    XCTAssertTrue(reveal(chart, in: transcript), "miniatura wykresu przed podglądem")
    chart.tap()
    let preview = app.otherElements["QLPreviewControllerView"]
    XCTAssertTrue(preview.waitForAppearance(timeout: 10), "podgląd QuickLook")
    let close = app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"]
    // A tap on the image shows or hides QuickLook's bars and never closes the preview.
    if !close.waitForAppearance(timeout: 3) { preview.tap() }
    XCTAssertTrue(close.waitForAppearance(timeout: 5), "QuickLook's close button in the preview bar")
    preview.tap()
    XCTAssertTrue(preview.exists, "tap w obraz nie zamyka podglądu")
    snapshot(app, "podglad")
    if !close.isHittable { preview.tap() }
    XCTAssertTrue(close.waitForAppearance(timeout: 5) && close.isHittable, "the close button can be tapped")
    close.tap()
    XCTAssertTrue(preview.waitForDisappearance(timeout: 5), "podgląd zamknięty")
    XCTAssertTrue(chart.waitForAppearance(timeout: 5), "z powrotem w transkrypcie")
  }

  /// Kafel miniatury o danej nazwie dla czytnika.
  private static func thumbnail(label: String) -> NSPredicate {
    NSPredicate(format: "identifier BEGINSWITH 'thumbnail.' AND label == %@", label)
  }

  @MainActor
  private func notice(_ app: XCUIApplication, containing text: String) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'harness.' AND label CONTAINS %@", text))
      .firstMatch
  }

  /// Czeka na element, a gdy go nie ma na ekranie, przewija transkrypt w górę, potem w dół
  /// (komórki poza ekranem nie istnieją w drzewie dostępności; transkrypt otwiera się na dnie).
  @MainActor
  private func reveal(_ element: XCUIElement, in transcript: XCUIElement, timeout: TimeInterval = 5) -> Bool {
    if element.waitForAppearance(timeout: timeout), element.isHittable { return true }
    for up in [true, false] {
      for _ in 0..<8 {
        if up { transcript.swipeDown(velocity: .slow) } else { transcript.swipeUp(velocity: .slow) }
        if element.exists, element.isHittable { return true }
      }
    }
    return element.exists
  }

  /// Zrzut ekranu w wyniku testu (`xcresulttool export attachments`) — do oceny wzrokowej.
  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
