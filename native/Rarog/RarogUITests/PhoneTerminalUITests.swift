import XCTest

/// Terminal na iPhonie. W stosie (`compact`) podział lista ↔ szczegół pokazuje szczegół,
/// dopóki stoi w nim trasa — także taka, która nie jest wierszem listy (terminal, „Nowy terminal", projekt bez
/// sesji). Demo nie ma terminala, więc trasę stawia adres `rarog://terminal/<id>?session=<id>` (kafel Live
/// Activity, powiadomienie) z sesją spoza listy: ta sama droga co tap, `openPushTarget` → `.terminal(id)`. Ekran
/// terminala stoi wtedy bez połączenia — liczy się, że stoi on, a nie lista, i że „wstecz" wraca do listy.
/// Ekran terminala rozpoznaje „×" terminala w pasku nawigacji (wiersza „Terminal 1" nie ma);
/// zrzuty ekranu sesji i terminala zostają w wyniku testu do porównania nagłówków i paska klawiszy.
final class PhoneTerminalUITests: XCTestCase {
  private static let terminalUrl = "rarog://terminal/0123456789abcdef?session=demo-not-listed"

  override func setUp() {
    continueAfterFailure = false
  }

  /// Z listy: adres terminala wchodzi w ekran terminala, „wstecz" wraca do listy.
  @MainActor
  func testTerminalUrlFromListShowsTerminalOnPhone() throws {
    let app = try launchOnPhone()
    let list = DemoServer.reveal(app, "demo-willow")
    XCTAssertTrue(onTop(list), "start na liście agentów")

    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: Self.terminalUrl)))
    assertTerminalStays(app, list: list, "z listy")

    back(app)
    XCTAssertTrue(waitOnTop(list, timeout: 10), "„wstecz” wraca do listy")
    XCTAssertFalse(onTop(element(app, "terminal.close")), "ekran terminala zszedł")
  }

  /// Z ekranu sesji (wiersz listy zaznaczony): trasa terminala nie cofa stosu do listy.
  @MainActor
  func testTerminalUrlFromSessionShowsTerminalOnPhone() throws {
    let app = try launchOnPhone()
    let list = DemoServer.reveal(app, "demo-willow")
    list.tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "ekran sesji")
    XCTAssertTrue(waitUntil(timeout: 5) { !self.onTop(list) }, "lista pod ekranem sesji")
    assertLeadingTitle(app, "sesja")
    // Ikony prawego rogu stoją w pasku, nie w systemowym „⋯" przepełnienia, które ich nie pokazuje (regułę
    // „najwyżej trzy" na ekranie terminala trzyma `HeaderTrailingIconsTests`, długi tytuł —
    // `testLongTitleKeepsIconsInBarOnPhone`).
    for id in ["header.terminalPopup", "header.close"] {
      XCTAssertTrue(waitOnTop(element(app, id), timeout: 5), "sesja: \(id) w pasku")
    }
    keep(app, "telefon-sesja")

    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: Self.terminalUrl)))
    assertTerminalStays(app, list: list, "z sesji")
    XCTAssertTrue(element(app, "terminal.menu").exists, "„⋯” terminala w pasku nawigacji")
    XCTAssertTrue(element(app, "terminal.key.pad").exists, "pasek klawiszy")
    assertLeadingTitle(app, "terminal")
    keep(app, "telefon-terminal")
    assertPasteKeyPastes(app)

    back(app)
    XCTAssertTrue(waitOnTop(list, timeout: 10), "„wstecz” wraca do listy")
  }

  /// Długi tytuł stoi na suficie i ikony zostają w pasku. Bez sufitu przy długiej nazwie albo
  /// ścieżce projektu tytuł zabiera ikonom miejsce, a system chowa wszystkie trzy w „⋯", które ich nie pokazuje.
  /// Tytuł to nazwa katalogu projektu, a demo ma krótkie, więc sesję w katalogu o długiej nazwie zakłada sterowanie
  /// demo.
  @MainActor
  func testLongTitleKeepsIconsInBarOnPhone() async throws {
    // Przed `create`: pominięty na iPadzie test zostawiłby panel w demo bez sprzątania.
    try requirePhone()
    let control = DemoControl(port: try DemoServer.requirePort())
    try await control.reset()
    let id = try await control.create("idle", cwd: Self.longProject)
    let app = try launchOnPhone()
    DemoServer.reveal(app, id).tap()
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "ekran sesji")
    let icons = ["header.terminalPopup", "header.close"].map { element(app, $0) }
    // Sprzątanie bez sieci: blok `async` z `control.reset()` po porażce zatrzymał przebieg na 4 h.
    // Własna sesja znika dwoma naciśnięciami „×", jak w `HeaderChromeUITests`.
    addTeardownBlock { @MainActor in
      guard icons[1].exists else { return }
      icons[1].tap()
      icons[1].tap()
    }
    for icon in icons {
      XCTAssertTrue(waitOnTop(icon, timeout: 5), "długi tytuł: \(icon.identifier) w pasku, nie w „⋯”")
    }
    // Tytuł ucięty tuż przed ikonami: sufit nie oddaje miejsca za darmo. Odstęp paska to 12 pt, reszta to cięcie
    // tekstu na granicy znaku.
    let title = element(app, "header.title")
    let gap = icons[0].frame.minX - title.frame.maxX
    XCTAssertGreaterThanOrEqual(gap, 12, "tytuł nie wchodzi w odstęp paska: \(title.frame)")
    // The ceiling keeps room for three icons (terminal screen: popup terminal, "⋯", "×"); the session screen shows
    // one (its "×" stands in the current tab), so two targets and their spacing (2 × 46 pt) stay free before it.
    XCTAssertLessThan(gap, 30 + 2 * 46, "tytuł sięga sufitu: \(title.frame), ikona \(icons[0].frame)")
    keep(app, "telefon-dlugi-tytul")
  }

  private static let longProject = "/Users/demo/Projects/przeprojektowanie-naglowka-telefonu-raroga"

  // MARK: - Pomocnicze

  @MainActor
  private func requirePhone() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("stos lista → szczegół jest na iPhonie; iPad trzyma listę obok szczegółu")
    }
  }

  @MainActor
  private func launchOnPhone() throws -> XCUIApplication {
    try requirePhone()
    let port = try DemoServer.requirePort()
    // Pasek klawiszy stoi tylko bez klawiatury sprzętowej, a symulator zgłasza ją zawsze.
    let app = DemoServer.launch(port: port, environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    return app
  }

  /// Ekran terminala na wierzchu, lista pod nim — i tak zostaje (cofnięcie stosu przychodzi chwilę po wejściu).
  /// `list` to wiersz agenta, nie kontener `session.list`: kontener XCUITest zgłaszał jako niehittable także wtedy,
  /// gdy lista stała na wierzchu (iPhone 17 Pro, iOS 27); widok zdjęty ze stosu wypada z drzewa.
  @MainActor
  private func assertTerminalStays(_ app: XCUIApplication, list: XCUIElement, _ from: String) {
    // „×" terminala w pasku nawigacji: identyfikator widoku kontrolera (`terminal.screen`) do drzewa dostępności
    // nie trafia, przycisk paska tak.
    let screen = element(app, "terminal.close")
    XCTAssertTrue(waitOnTop(screen, timeout: 10), "ekran terminala \(from)")
    XCTAssertFalse(onTop(list), "lista agentów nie wraca na wierzch \(from)")
    RunLoop.current.run(until: Date().addingTimeInterval(2))
    XCTAssertTrue(onTop(screen), "ekran terminala stoi dalej \(from)")
    XCTAssertFalse(onTop(list), "lista dalej pod terminalem \(from)")
  }

  /// Systemowy „wstecz" w pasku nawigacji szczegółu (pierwszy przycisk paska, jak w `ListScreenshotUITests`).
  @MainActor
  private func back(_ app: XCUIApplication) {
    let button = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(button.waitForAppearance(timeout: 5), "przycisk „wstecz”")
    button.tap()
  }

  /// Tytuł nagłówka przy lewej krawędzi, tuż za „wstecz" — w sesji i w terminalu tak samo.
  @MainActor
  private func assertLeadingTitle(_ app: XCUIApplication, _ screen: String) {
    let title = element(app, "header.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 5), "tytuł nagłówka: \(screen)")
    let back = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertGreaterThanOrEqual(title.frame.minX, back.frame.maxX, "\(screen): tytuł za „wstecz”")
    XCTAssertLessThan(title.frame.minX - back.frame.maxX, 24, "\(screen): tytuł przy „wstecz”: \(title.frame)")
  }

  /// „Wklej" paska (`UIPasteControl`) ma wielkość klawisza i wkleja tapem. Tapu z marginesu celu, przekazanego
  /// przez `hitTest`, system nie przyjmuje (zmierzone), więc cel to sam klawisz.
  /// Terminal demo nie jest połączony, więc wklejka kończy się zdaniem „nie poszła" — dowód, że tap doszedł.
  @MainActor
  private func assertPasteKeyPastes(_ app: XCUIApplication) {
    UIPasteboard.general.string = "echo rarog"
    let paste = element(app, "terminal.key.paste")
    XCTAssertTrue(paste.waitForAppearance(timeout: 5), "„Wklej” na pasku")
    XCTAssertEqual(paste.frame.height, 36, accuracy: 0.5, "„Wklej” wielkości klawisza: \(paste.frame)")
    paste.tap()
    let status = element(app, "terminal.status.text")
    let offline = "Terminal nie jest połączony — wklejka nie poszła."
    XCTAssertTrue(waitUntil(timeout: 5) { status.exists && status.label == offline }, "tap w „Wklej” wkleja")
  }

  /// Zrzut ekranu w wyniku testu (także przy sukcesie).
  @MainActor
  private func keep(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  @MainActor
  private func onTop(_ element: XCUIElement) -> Bool {
    element.exists && element.isHittable
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Element na wierzchu (istnieje i przyjmuje dotyk). `isHittable` pytany tylko o element, który istnieje: widok
  /// zdjęty ze stosu znika z drzewa dostępności, a pytanie o niego kończy test błędem zapytania.
  @MainActor
  private func waitOnTop(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    waitUntil(timeout: timeout) { self.onTop(element) }
  }

  @MainActor
  private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      guard Date() < deadline else { return false }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    }
    return true
  }
}
