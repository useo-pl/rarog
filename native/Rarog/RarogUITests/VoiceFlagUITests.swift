import XCTest

/// Build bez Soniox (`RAROG_VOICE_SONIOX = NO`) przeciw serwerowi demo: ekran „Dyktowanie” ma samą
/// opcję systemową, bez słowa „Soniox”, a strona „Dyktowanie” w Ustawieniach nie pokazuje ani opcji, ani stanu Soniox
/// na serwerze. Wybór
/// Soniox z poprzedniego buildu zostaje zapisany, ale trasa pyta.
///
/// Klasa działa tylko na buildzie z tym ustawieniem: `xcodebuild build-for-testing … RAROG_VOICE_SONIOX=NO`,
/// a w środowisku `xcodebuild test-without-building` `TEST_RUNNER_RAROG_VOICE_FLAG_NO=1` (proces testów dostaje
/// `RAROG_VOICE_FLAG_NO=1`). Bez tej zmiennej, czyli w buildzie domyślnym i w pełnej bramce, klasa się pomija.
final class VoiceFlagUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
    guard ProcessInfo.processInfo.environment["RAROG_VOICE_FLAG_NO"] == "1" else {
      throw XCTSkip("build z RAROG_VOICE_SONIOX=NO: TEST_RUNNER_RAROG_VOICE_FLAG_NO=1")
    }
  }

  /// The sheet with the system option only; the choice closes it without recording, the second tap records; the
  /// Settings → Dictation page has no Soniox option and no server state.
  @MainActor
  func testSheetAndSettingsOfferOnlySystemDictation() throws {
    let app = try openComposer(choice: "none")
    let mic = app.buttons["composer.mic"]
    mic.tap()
    let sheet = element(app, "dictation.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "arkusz „Dyktowanie”")
    expectSystemOnly(app, in: sheet)

    element(app, "dictation.choose.system").tap()
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 10), "wybór zamyka arkusz")
    XCTAssertFalse(waitField(app, equals: "Dyktuję z", timeout: 2), "wybór nie nagrywa: \(fieldValue(app))")
    XCTAssertFalse(mic.isSelected, "mikrofon bezczynny")
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z"), "drugie stuknięcie nagrywa: \(fieldValue(app))")
    mic.tap()
    XCTAssertTrue(waitField(app, equals: "Dyktuję z iPada."), "końcówka w polu: \(fieldValue(app))")

    element(app, "list.settings").tap()
    let form = element(app, "settings.form")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "Settings")
    let row = DemoServer.revealSettings(app, "settings.row.dictation", in: form)
    XCTAssertTrue(row.exists, "Dictation row on the Settings list")
    XCTAssertTrue(text(row).contains("Dyktowanie systemowe"), "system dictation chosen: \(text(row))")
    let page = DemoServer.openSettingsPage(app, "dictation")
    expectSystemOnly(app, in: page)
    // Cells off screen are not in the tree, so the page is scrolled to its end before the absence counts.
    let shortcut = DemoServer.revealSettings(app, "settings.shortcut.dictation", in: page)
    XCTAssertTrue(shortcut.exists, "shortcut section at the end of the Dictation page")
    page.swipeUp(velocity: .slow)
    XCTAssertEqual(soniox(in: page).count, 0, "end of the page without the word Soniox: \(soniox(in: page).debugDescription)")
  }

  /// Soniox zapisany przed zmianą buildu: trasa pyta, ekran ma samą opcję systemową i nic nie nagrywa.
  @MainActor
  func testSavedSonioxChoiceAsksForSystem() throws {
    let app = try openComposer(choice: "soniox")
    app.buttons["composer.mic"].tap()
    let sheet = element(app, "dictation.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 10), "arkusz zamiast nagrania przez Soniox")
    expectSystemOnly(app, in: sheet)
    XCTAssertTrue(fieldValue(app).isEmpty, "nic nie nagrywa: \(fieldValue(app))")
  }

  // MARK: - Pomocnicze

  /// Opcja systemowa do wybrania, opcji Soniox nie ma, żaden tekst ekranu nie mówi „Soniox”.
  @MainActor
  private func expectSystemOnly(_ app: XCUIApplication, in screen: XCUIElement) {
    let system = element(app, "dictation.option.system")
    XCTAssertTrue(system.waitForAppearance(timeout: 5), "opcja systemowa")
    XCTAssertFalse(element(app, "dictation.option.soniox").exists, "bez opcji Soniox")
    XCTAssertFalse(element(app, "dictation.choose.soniox").exists, "bez przycisku Soniox")
    XCTAssertEqual(soniox(in: screen).count, 0, "ekran bez słowa „Soniox”: \(soniox(in: screen).debugDescription)")
    // Link stoi pod opcjami; komórek poza ekranem nie ma w drzewie dostępności.
    let privacy = element(app, "dictation.privacy")
    for _ in 0..<5 where !(privacy.exists && privacy.isHittable) { screen.swipeUp(velocity: .slow) }
    XCTAssertTrue(privacy.exists, "link prywatności")
    XCTAssertEqual(soniox(in: screen).count, 0, "dół ekranu bez słowa „Soniox”: \(soniox(in: screen).debugDescription)")
    for _ in 0..<5 where !system.isHittable { screen.swipeDown(velocity: .slow) }
  }

  /// Elementy, których etykieta mówi „Soniox”.
  @MainActor
  private func soniox(in screen: XCUIElement) -> XCUIElementQuery {
    screen.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS[c] 'soniox'"))
  }

  @MainActor
  private func openComposer(choice: String) throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: DemoServer.dictation(choice))
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog").tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "pole wiadomości")
    XCTAssertTrue(app.buttons["composer.mic"].waitForAppearance(timeout: 5), "mikrofon zawsze w polu")
    return app
  }

  @MainActor
  private func fieldValue(_ app: XCUIApplication) -> String {
    (app.textViews["composer.field"].value as? String) ?? ""
  }

  @MainActor
  private func waitField(_ app: XCUIApplication, equals text: String, timeout: TimeInterval = 10) -> Bool {
    let field = app.textViews["composer.field"]
    let predicate = NSPredicate { _, _ in (field.value as? String) == text }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
  }

  /// Etykieta i wartość wiersza razem.
  @MainActor
  private func text(_ element: XCUIElement) -> String {
    [element.label, element.value as? String ?? ""].joined(separator: " ")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }
}
