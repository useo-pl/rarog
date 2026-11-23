import XCTest

/// Markdown odpowiedzi agenta przeciw serwerowi demo: tabela, cytat i linia
/// z seeda `demo-willow-parser` w tekście dla czytnika; ikona w pasku bloku kodu kopiuje surowy
/// kod (sprawdzone wklejeniem w pole wiadomości innej sesji), a ptaszek trwa chwilę.
/// Właściciel: transkrypt, markdown.
final class MarkdownUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// Komórka wiadomości przewinięta na ekran (komórek poza ekranem nie ma w drzewie dostępności).
  @MainActor
  private func message(_ app: XCUIApplication, containing text: String) -> XCUIElement {
    let element = app.textViews.matching(NSPredicate(
      format: "identifier BEGINSWITH 'message.m' AND label CONTAINS %@", text)).firstMatch
    var found = element.waitForAppearance(timeout: 10)
    for _ in 0..<8 where !found {
      app.collectionViews["transcript"].swipeDown(velocity: .slow)
      found = element.waitForAppearance(timeout: 1)
    }
    return element
  }

  /// Chowa klawiaturę ekranową, jeśli stoi i da się w nią stuknąć (w trakcie wysuwania przycisk
  /// istnieje, ale stuknięcie w niego przewraca test).
  @MainActor
  private func hideKeyboard(_ app: XCUIApplication) {
    for _ in 0..<3 {
      for label in ["Ukryj klawiaturę", "Hide keyboard"] {
        let button = app.keyboards.buttons[label]
        if button.exists, button.isHittable {
          button.tap()
          return
        }
      }
      guard app.keyboards.count > 0 else { return }
      Thread.sleep(forTimeInterval: 0.5)
    }
  }

  @MainActor
  private func keepScreenshot(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  @MainActor
  func testTableQuoteAndRuleRenderAsText() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-willow-parser").tap()
    hideKeyboard(app)

    let answer = message(app, containing: "Formaty w liczbach")
    XCTAssertTrue(answer.exists, "odpowiedź z pełnym markdownem")
    let label = answer.label
    // Tabela czytana komórkami, nie kreskami; znaczniki składni nie wychodzą na wierzch.
    XCTAssertTrue(label.contains("Tabela, 3\u{00A0}wiersze: Format, Przykład, Testy"), "tabela dla czytnika: \(label)")
    XCTAssertTrue(label.contains("ISO 8601, 2026-10-05T09:00:00Z, 4"), "wiersz tabeli: \(label)")
    XCTAssertFalse(label.contains("|"), "bez kresek tabeli: \(label)")
    XCTAssertFalse(label.contains("**") || label.contains("~~") || label.contains("> "), "bez znaczników: \(label)")
    XCTAssertTrue(label.contains("Uwaga: strefa czasowa"), "cytat: \(label)")
    XCTAssertTrue(label.contains("2. Stary helper formatDate zniknął"), "lista numerowana i przekreślenie: \(label)")
    keepScreenshot(app, "markdown-pelny")
  }

  @MainActor
  func testCodeBlockCopyIcon() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-willow").tap()
    hideKeyboard(app)

    XCTAssertTrue(message(app, containing: "export async function saveNote").exists, "wiadomość z blokiem kodu")
    let copy = app.buttons.matching(identifier: "code.copy").firstMatch
    XCTAssertTrue(copy.waitForAppearance(timeout: 5), "ikona kopiowania w pasku bloku")
    XCTAssertEqual(copy.label, "Kopiuj blok kodu")
    copy.tap()
    XCTAssertEqual(copy.label, "Skopiowano blok kodu", "ptaszek po skopiowaniu")
    keepScreenshot(app, "blok-kodu-skopiowany")
    let back = NSPredicate(format: "label == %@", "Kopiuj blok kodu")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: back, object: copy)], timeout: 5), .completed,
                   "ikona wraca po chwili")

    // Schowek niesie surowy kod: wklejenie w pole sesji, która przyjmuje wiadomości.
    DemoServer.reveal(app, "demo-rarog").tap()
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 10), "pole wiadomości")
    composer.tap()
    // Symulator zjada pierwszy klawisz sprzętowy przy wysuniętej klawiaturze ekranowej (README):
    // jałowa strzałka, potem Cmd+V; gdy i to nie dojdzie — „Wklej" z menu edycji.
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    app.typeKey("v", modifierFlags: .command)
    let code = """
      export async function saveNote(note: Note): Promise<void> {
        await store.write(note);
        emitter.emit("note-saved", note.id);
      }
      """
    let pasted = NSPredicate(format: "value == %@", code)
    if XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: pasted, object: composer)], timeout: 3) != .completed {
      composer.press(forDuration: 1.2)
      for label in ["Wklej", "Paste"] where app.menuItems[label].waitForAppearance(timeout: 2) {
        app.menuItems[label].tap()
        break
      }
    }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: pasted, object: composer)], timeout: 5), .completed,
                   "w schowku dokładnie kod bloku: \(composer.value as? String ?? "")")
  }
}
