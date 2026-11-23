import XCTest

/// Karta stanu zamiast pola wiadomości i klawiatura kart
/// przeciw serwerowi demo.
///
/// Demo: `demo-map-view` stoi na limicie planu (żywy panel), `demo-pipe-link` czeka na
/// wznowienie (serwer demo odmawia: seed nie ma zapamiętanej rozmowy silnika — 409 ze zdaniem),
/// `demo-willow-parser` jest zamknięta z podsumowaniem. Akcji nieodwracalnych (zamknięcie panelu,
/// nowa sesja) test nie potwierdza: sesje demo są wspólne dla całego przebiegu.
final class CardsUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testLimitCardReplacesComposer() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-map-view").tap()
    let card = element(app, "card.state")
    XCTAssertTrue(card.waitForAppearance(timeout: 10), "karta stanu")
    let text = element(app, "state.text")
    // Zdanie serwera z kodem: godzina z `stateDetailRef.args[0]`, nie z tekstu stanu,
    // który Reducer podaje już przetłumaczony. Seed `demo-map-view` stawia reset na start serwera demo + 2 h, więc
    // godzina leży w najbliższych dwóch godzinach (serwer demo starszy niż 2 h ma limit za sobą — test to zgłosi).
    let clock = try XCTUnwrap(
      text.label.firstMatch(of: #/^Limit planu — spróbuj po ([0-9]{1,2}):([0-9]{2})\. /#), "limit z godziną: \(text.label)")
    let parts = Calendar.current.dateComponents([.hour, .minute], from: Date())
    let ahead = ((Int(clock.output.1) ?? 0) * 60 + (Int(clock.output.2) ?? 0)
      - (parts.hour ?? 0) * 60 - (parts.minute ?? 0) + 24 * 60) % (24 * 60)
    XCTAssertTrue((0...125).contains(ahead), "godzina resetu za \(ahead) min, nie w ciągu 2 h: \(text.label)")
    XCTAssertTrue(text.label.hasSuffix("Sesja żyje w terminalu — nie ma czego wznawiać."), text.label)
    XCTAssertFalse(app.textViews["composer.field"].exists, "pole znika, gdy stoi karta stanu")
    XCTAssertFalse(element(app, "state.resume").exists, "„Wznów” tylko dla sesji bez panelu")

    // Bez przycisku, który pokazuje coś w herdr: skutek byłby na Macu, nie na ekranie.
    XCTAssertFalse(element(app, "state.showInHerdr").exists, "karta stanu bez „Pokaż w herdr”")

    // „Zamknij panel w herdr" pyta drugi raz — test nie potwierdza.
    let close = element(app, "state.close")
    XCTAssertEqual(close.label, "Zamknij panel w herdr")
    close.tap()
    XCTAssertTrue(wait(NSPredicate(format: "label == 'Na pewno zamknąć panel?'"), close), "uzbrojenie: \(close.label)")
    snapshot(app, "karta-stanu-limit")
  }

  @MainActor
  func testResumableCardShowsServerRefusal() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-pipe-link").tap()
    XCTAssertTrue(element(app, "card.state").waitForAppearance(timeout: 10), "karta stanu")
    XCTAssertEqual(element(app, "state.text").label, "przerwana — backend zrestartowany")
    XCTAssertFalse(app.textViews["composer.field"].exists, "pole znika przy „Wznów”")
    XCTAssertTrue(element(app, "state.close").exists, "„×” obok „Wznów”")
    let resume = element(app, "state.resume")
    XCTAssertTrue(resume.exists)
    resume.tap()
    let result = element(app, "state.result")
    XCTAssertTrue(result.waitForAppearance(timeout: 10), "zdanie serwera po odmowie")
    XCTAssertEqual(result.label, "Sesja jest w stanie, który nie pozwala na tę akcję.")
    XCTAssertTrue(resume.isEnabled, "po odmowie „Wznów” znów działa")
    snapshot(app, "karta-stanu-wznow")
  }

  @MainActor
  func testDoneCardOffersNewSession() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-willow-parser").tap()
    XCTAssertTrue(element(app, "card.state").waitForAppearance(timeout: 10), "karta stanu")
    XCTAssertTrue(element(app, "state.newSession").exists, "„Nowa sesja” — żadnego ślepego zaułka")
    XCTAssertEqual(element(app, "state.close").label, "Usuń z listy", "„Usuń z listy” obok „Nowa sesja”")
    XCTAssertFalse(app.textViews["composer.field"].exists, "pole znika przy karcie „gotowe”")
    XCTAssertFalse(element(app, "composer.model").exists, "pigułki modelu nie ma bez pola")
    snapshot(app, "karta-stanu-gotowe")
  }

  /// Tab z ekranu sesji przy stojącej decyzji idzie na kartę, nie do listy,
  /// a Esc z fokusem na karcie ją odrzuca. Karta powstaje we WŁASNEJ sesji testu (wyzwalacz demo
  /// „czerwone"), bo karty seedów należą do `FlowUITests`. Symulator potrafi nie włączyć
  /// systemu fokusu na klawisze z XCUITest — wtedy test mówi to wprost i kartę zdejmuje dotyk.
  @MainActor
  func testTabGoesToCardFirst() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-map-view").tap()
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before + 1)"), tabs, timeout: 15), "nowa zakładka")
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 15), "pole nowej sesji")
    composer.tap()
    composer.typeText("czerwone")
    app.buttons["composer.send"].tap()
    let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody z wyzwalacza demo")
    DemoServer.hideKeyboard(app)
    snapshot(app, "karta-zgody-wlasna-sesja")

    // Pierwszy klawisz sprzętowy symulator zużywa na przełączenie klawiatur (README, Cmd+1…9).
    app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [])
    app.typeKey(XCUIKeyboardKey.tab, modifierFlags: [])
    // Karta zgody stoi w transkrypcie (tryb domyślny) albo w doku (tryb `.dock`); fokus klawiatury
    // staje na komórce karty albo na doku.
    let dock = element(app, "dock")
    let cell = app.cells.containing(card.elementType, identifier: card.identifier).firstMatch
    let target = dock.exists ? dock : cell
    XCTAssertFalse(DemoServer.row(app, "demo-map-view").hasFocus, "Tab nie idzie do listy, gdy stoi decyzja")
    XCTAssertFalse(element(app, "card.allow").hasFocus, "„Zatwierdź” nie przyjmuje fokusu")
    if target.hasFocus {
      snapshot(app, "karta-zgody-fokus")
      app.typeKey(XCUIKeyboardKey.space, modifierFlags: [])
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
      XCTAssertTrue(card.exists, "Spacja i Enter niczego nie zatwierdzają")
      app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
      record("Esc z fokusem na karcie: sprawdzono (karta odrzucona klawiszem)")
    } else {
      record("Esc z fokusem na karcie: nie sprawdzono — fokus po Tab niedostępny w symulatorze, kartę zdejmuje dotyk")
      app.buttons["card.deny"].tap()
    }
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po odrzuceniu")

    // Sprzątanie: własna sesja testu znika dwoma naciśnięciami „×".
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()
  }

  /// Karta w transkrypcie, pole schowane: piszę z klawiaturą ekranową w górze, przychodzi
  /// karta zgody — pole znika razem z klawiaturą, karta stoi na dnie transkryptu z trafialnym „Zatwierdź”, doku nie ma,
  /// a po decyzji pole wraca. Tekst szkicu po decyzji sprawdza UIKit (`DecisionInTranscriptTests`): karta demo
  /// przychodzi 0,4 s po wysłaniu, więc pisanie po wysyłce ściga się z nią.
  @MainActor
  func testCardInTranscriptHidesComposerAndKeyboard() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-map-view").tap()
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    DemoServer.addFromPlus(app)
    XCTAssertTrue(wait(NSPredicate(format: "count == \(before + 1)"), tabs, timeout: 15), "nowa zakładka")
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 15), "pole nowej sesji")
    composer.tap()
    let screenKeyboard = app.keyboards.firstMatch
    let keyboardUp = screenKeyboard.waitForAppearance(timeout: 5) && screenKeyboard.frame.minY < app.frame.maxY - 1
    composer.typeText("czerwone")
    app.buttons["composer.send"].tap()
    let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta zgody z wyzwalacza demo")
    XCTAssertTrue(composer.waitForDisappearance(timeout: 5), "pole znika, gdy karta czeka na decyzję")
    let onScreen = app.keyboards.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY < app.frame.maxY - 1 }
    XCTAssertTrue(onScreen.isEmpty, "klawiatura ekranowa schowana razem z polem")
    record(keyboardUp ? "klawiatura ekranowa była w górze przed kartą" : "klawiatura sprzętowa symulatora: bez ekranowej")
    let allow = element(app, "card.allow")
    XCTAssertTrue(allow.waitForAppearance(timeout: 5))
    DemoServer.waitUntilStill(card)
    XCTAssertTrue(allow.isHittable, "„Zatwierdź” trafialny w transkrypcie")
    XCTAssertFalse(element(app, "dock").exists, "bez doku")
    let transcript = element(app, "transcript").frame
    XCTAssertLessThanOrEqual(card.frame.maxY, transcript.maxY + 1, "karta w transkrypcie: \(card.frame), \(transcript)")
    snapshot(app, "transkrypt-karta-zgody")
    app.buttons["card.deny"].tap()
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta zniknęła po odrzuceniu")
    XCTAssertTrue(composer.waitForAppearance(timeout: 10), "pole wraca po decyzji")
    // Symulator zgłasza klawiaturę sprzętową, więc pole dostaje responder z powrotem (`claimKeyboardForCards`),
    // a symulator wysuwa przy tym ekranową. Bez klawiatury sprzętowej responder nie wraca: pilnuje tego UIKit
    // (`DecisionInTranscriptTests`), tu tylko zapis.
    sleep(1)
    let after = app.keyboards.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY < app.frame.maxY - 1 }
    record(after.isEmpty ? "po decyzji: bez klawiatury ekranowej" : "po decyzji: klawiatura (klawiatura sprzętowa symulatora)")

    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()
  }

  // MARK: - Pomocnicze

  private func record(_ text: String) {
    let attachment = XCTAttachment(string: text)
    attachment.name = text
    attachment.lifetime = .keepAlways
    add(attachment)
    print(text)
  }

  @MainActor
  private func launchLoggedIn() throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func wait(_ predicate: NSPredicate, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout)
      == .completed
  }
}
