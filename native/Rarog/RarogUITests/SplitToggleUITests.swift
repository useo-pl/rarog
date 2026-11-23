import XCTest

/// Systemowego przycisku zwijania listy nie ma, także po aktualizacji apki. Apkę po aktualizacji właściciel otwiera z
/// ikony na ekranie początkowym, więc start idzie bez `RAROG_UI_TEST_RESET`, ze stanem z poprzedniego uruchomienia.
/// Zwijanie listy mieszka w nagłówku sesji (`header.listToggle`, `SplitChromeUITests`); systemowego uchwytu nie ma w
/// żadnym układzie: po ponownym starcie, po zwinięciu listy i po zmianie szerokości okna z `compact` na `regular`
/// (iPhone Pro Max obrócony w poziom). Trzeci test pilnuje pętli układu, którą daje
/// `.toolbar(removing: .sidebarToggle)` na kolumnie: przy wysuniętej klawiaturze apka stoi (komentarz
/// w `SessionListView`).
final class SplitToggleUITests: XCTestCase {
  /// Etykiety systemowego uchwytu listy (`NavigationSplitView`) w obu językach symulatora.
  private static let systemToggleLabels = ["Ukryj pasek boczny", "Pokaż pasek boczny", "Hide Sidebar", "Show Sidebar"]

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  /// iPad: drugie uruchomienie bez resetu stanu (jak z ikony po aktualizacji), lista rozwinięta i zwinięta.
  @MainActor
  func testRelaunchWithoutResetHasNoSystemToggle() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("lista obok szczegółu jest na iPadzie") }
    let port = try DemoServer.requirePort()
    let first = DemoServer.launch(port: port)
    DemoServer.pair(first)
    XCTAssertTrue(DemoServer.listShown(first), "lista sesji")
    first.terminate()

    let app = DemoServer.launch(port: port, reset: false)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji po starcie bez resetu (parowanie przeżyło)")
    assertNoSystemToggle(app, "start bez resetu, sama lista")
    DemoServer.hideKeyboard(app)
    DemoServer.reveal(app, "demo-willow").tap()
    let toggle = element(app, "header.listToggle")
    XCTAssertTrue(toggle.waitForAppearance(timeout: 10), "przycisk zwijania w nagłówku sesji")
    assertNoSystemToggle(app, "start bez resetu, sesja otwarta")
    restoreListOnTeardown(app)
    toggle.tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), false), "lista zwinięta")
    assertNoSystemToggle(app, "start bez resetu, lista zwinięta")
    toggle.tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), true), "lista rozwinięta")
    app.terminate()
  }

  /// iPhone Pro Max: pion to `compact` (stos), poziom to `regular` (lista obok szczegółu). Start bez resetu w pionie,
  /// sesja otwarta, obrót w poziom — podział rozkłada się na dwie kolumny i systemowego uchwytu nie ma.
  @MainActor
  func testCompactToRegularHasNoSystemToggle() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("zmiana compact → regular obrotem jest na iPhonie Pro Max; iPad ma regular w obu orientacjach")
    }
    let port = try DemoServer.requirePort()
    let start = XCUIDevice.shared.orientation
    XCUIDevice.shared.orientation = .portrait
    addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = start }
    let first = DemoServer.launch(port: port)
    DemoServer.pair(first)
    XCTAssertTrue(DemoServer.listShown(first), "lista sesji")
    first.terminate()

    let app = DemoServer.launch(port: port, reset: false)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji po starcie bez resetu")
    assertNoSystemToggle(app, "compact, lista")
    DemoServer.openRow(app, "demo-willow", project: "willow")
    XCTAssertTrue(element(app, "header.title").waitForAppearance(timeout: 10), "sesja otwarta")
    assertNoSystemToggle(app, "compact, sesja")
    XCUIDevice.shared.orientation = .landscapeLeft
    let toggle = element(app, "header.listToggle")
    guard toggle.waitForAppearance(timeout: 10) else {
      throw XCTSkip("ten model w poziomie zostaje compact — podział się nie rozkłada")
    }
    XCTAssertTrue(waitHittable(element(app, "session.list"), true), "regular: lista obok szczegółu")
    assertNoSystemToggle(app, "regular po obrocie")
    restoreListOnTeardown(app)
    toggle.tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), false), "lista zwinięta")
    assertNoSystemToggle(app, "regular, lista zwinięta")
    toggle.tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), true), "lista rozwinięta")
    app.terminate()
  }

  /// iPad, sesja otwarta, klawiatura ekranowa w górze: apka odpowiada na tap w 5 s. Strażnik pętli układu: jedna
  /// zmiana paska podziału przy wysunięciu klawiatury potrafiła trzymać wątek główny na 100 %.
  @MainActor
  func testKeyboardUpAppResponds() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("lista obok szczegółu jest na iPadzie") }
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "pole sesji")
    field.tap()
    field.typeText("a")
    guard app.keyboards.firstMatch.waitForAppearance(timeout: 3) else {
      throw XCTSkip("symulator z klawiaturą sprzętową: klawiatura ekranowa się nie wysuwa")
    }
    restoreListOnTeardown(app)
    let toggle = element(app, "header.listToggle")
    // Czas liczony od chwili, w której XCUITest oddał tap: sam `tap()` czeka na bezczynność apki i na symulatorze
    // trwa kilka sekund także bez pętli (zmierzone: 6,4 s od wywołania do zwiniętej listy). Apka
    // w pętli układu nie zwinęłaby listy wcale.
    let tapping = Date()
    toggle.tap()
    let tapped = Date()
    let collapsed = waitHittable(element(app, "session.list"), false, timeout: 5)
    let elapsed = Date().timeIntervalSince(tapped)
    print("klawiatura w górze: tap \(tapped.timeIntervalSince(tapping)) s, zwinięcie listy po \(elapsed) s")
    XCTAssertTrue(collapsed, "apka odpowiada na tap przy wysuniętej klawiaturze")
    XCTAssertLessThan(elapsed, 5, "odpowiedź w 5 s")
    assertNoSystemToggle(app, "klawiatura w górze")
    toggle.tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), true), "lista rozwinięta")
    field.typeText(XCUIKeyboardKey.delete.rawValue)
    app.terminate()
  }

  // MARK: - Pomocnicze

  @MainActor
  private func assertNoSystemToggle(_ app: XCUIApplication, _ when: String) {
    for label in Self.systemToggleLabels {
      XCTAssertFalse(app.buttons[label].exists, "\(when): systemowy uchwyt „\(label)”")
    }
  }

  /// Zwinięcie listy jest preferencją apki (przeżywa restart): test, który ją zwija, rozwija ją z powrotem także po
  /// porażce (wzór `SplitChromeUITests`).
  @MainActor
  private func restoreListOnTeardown(_ app: XCUIApplication) {
    addTeardownBlock { @MainActor in
      let toggle = app.descendants(matching: .any)["header.listToggle"].firstMatch
      guard app.state == .runningForeground, toggle.exists, toggle.label == "Pokaż listę sesji" else { return }
      toggle.tap()
    }
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func waitHittable(_ element: XCUIElement, _ hittable: Bool, timeout: TimeInterval = 10) -> Bool {
    let format = hittable ? "exists == true AND hittable == true" : "exists == false OR hittable == false"
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
