import XCTest

/// Drzewo projektów na liście agentów przeciw serwerowi demo: zwijanie projektu bez ruszania trasy, otwarta i ostatnio otwarta sesja widoczne
/// w zwiniętym projekcie, pamięć zwinięcia po ponownym uruchomieniu BEZ resetu, stuknięcie w nagłówek zwija i rozwija,
/// menu kontekstowe nagłówka zakłada sesję w projekcie.
/// Kotwicę przewinięcia mierzą `ProjectTreeListTests` i `ProjectTreeExpandAnchorTests` (UIKit), nagłówek w miejscu przy
/// stuknięciu — `ProjectTreeExpandUITests`, kolejność i widoczność — testy rdzenia.
///
/// Demo: willow ma `demo-willow` (czeka na zgodę) i `demo-willow-parser` (done — cisza); data-loader ma
/// `demo-data-loader` (done).
final class ProjectTreeUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  private var pad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

  /// Strzałka zwija bez ruszania trasy; otwarta i ostatnio otwarta sesja stoją w zwiniętym projekcie do ręcznego
  /// zwinięcia albo rozwinięcia; zwinięcie przeżywa ponowne uruchomienie apki bez resetu.
  @MainActor
  func testCollapseKeepsRouteAndIsRemembered() throws {
    let port = try DemoServer.requirePort()
    var app = try launchLoggedIn()
    let header = element(app, "project.willow")
    XCTAssertTrue(header.waitForAppearance(timeout: 10), "nagłówek willow")
    XCTAssertEqual(header.value as? String, "rozwinięty", "nowy projekt rozwinięty")
    let parser = DemoServer.row(app, "demo-willow-parser")
    XCTAssertTrue(DemoServer.reveal(app, "demo-willow-parser").exists, "cicha sesja w rozwiniętym projekcie")

    if pad {
      parser.tap()
      XCTAssertTrue(waitSelected(element(app, "tab.demo-willow-parser")), "sesja z drzewa")
    }
    toggle(app, "willow")
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "strzałka zwija: \(header.value ?? "—")")
    if pad {
      XCTAssertTrue(element(app, "tab.demo-willow-parser").isSelected, "zwinięcie nie rusza trasy")
      XCTAssertTrue(parser.exists, "otwarta sesja zostaje w zwiniętym projekcie")
      DemoServer.reveal(app, "demo-data-loader").tap()
      XCTAssertTrue(waitSelected(element(app, "tab.demo-data-loader")), "tap w inny wiersz")
      XCTAssertTrue(parser.exists, "ostatnio otwarta zostaje do spokojnej chwili")
      toggle(app, "willow")
      XCTAssertTrue(wait("value == 'rozwinięty'", header), "rozwinięcie")
      toggle(app, "willow")
      XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "ponowne zwinięcie")
    }
    XCTAssertTrue(parser.waitForDisappearance(timeout: 5), "cicha sesja schowana w zwiniętym projekcie")

    // Pamięć urządzenia: ponowne uruchomienie BEZ resetu (cookie i preferencje z poprzedniego przebiegu).
    app.terminate()
    app = DemoServer.launch(port: port, reset: false)
    let again = element(app, "project.willow")
    XCTAssertTrue(again.waitForAppearance(timeout: 20), "drzewo po ponownym uruchomieniu")
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", again), "zwinięcie zapamiętane: \(again.value ?? "—")")
    XCTAssertFalse(DemoServer.row(app, "demo-willow-parser").exists, "cicha sesja dalej schowana")
    toggle(app, "willow")
    XCTAssertTrue(wait("value == 'rozwinięty'", again), "sprzątanie: projekt rozwinięty")
  }

  /// Stuknięcie w treść nagłówka zwija i rozwija projekt jak strzałka i nie wchodzi w projekt;
  /// strzałka też niczego nie otwiera. Return na nagłówku z fokusem robi to samo co tap — o ile
  /// symulator da fokus komórce listy.
  @MainActor
  func testHeaderTapTogglesAndKeepsRoute() throws {
    let app = try launchLoggedIn()
    let willow = element(app, "tab.demo-willow")
    if pad {
      DemoServer.reveal(app, "demo-willow").tap()
      XCTAssertTrue(waitSelected(willow), "sesja innego projektu na ekranie")
    }
    let header = DemoServer.revealProject(app, "data-loader")
    XCTAssertTrue(header.exists, "nagłówek data-loader")
    // Stan demo jest wspólny dla przebiegu: projekt zwinięty przez wcześniejszą klasę najpierw rozwija strzałka.
    if (header.value as? String)?.hasPrefix("zwinięty") == true { toggle(app, "data-loader") }
    XCTAssertTrue(wait("value == 'rozwinięty'", header), "projekt rozwinięty na starcie")
    header.tap()
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "tap w treść nagłówka zwija: \(header.value ?? "—")")
    // Trasa stoi: iPad — dalej sesja willow obok; iPhone — dalej lista, bez wejścia w sesję projektu.
    sleep(1)
    if pad {
      XCTAssertTrue(willow.isSelected, "tap w nagłówek nie wchodzi w projekt")
    } else {
      XCTAssertFalse(element(app, "tab.demo-data-loader").exists, "tap w nagłówek nie wchodzi w projekt")
      XCTAssertTrue(header.exists, "lista zostaje na ekranie")
    }
    header.tap()
    XCTAssertTrue(wait("value == 'rozwinięty'", header), "drugi tap rozwija")

    toggle(app, "data-loader")
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "strzałka zwija")
    if pad { XCTAssertTrue(willow.isSelected, "strzałka nie otwiera projektu") }
    toggle(app, "data-loader")
    XCTAssertTrue(wait("value == 'rozwinięty'", header), "sprzątanie: projekt rozwinięty")
    guard pad else { return }

    // Klawiatura: pierwszy klawisz sprzętowy symulator zużywa na przełączenie klawiatur (README, Cmd+1…9).
    app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [])
    let cell = app.cells.containing(.any, identifier: "project.data-loader").firstMatch
    if cell.exists, cell.hasFocus {
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
      XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "Return na nagłówku zwija")
      XCTAssertTrue(willow.isSelected, "Return na nagłówku nie wchodzi w projekt")
      app.typeKey(XCUIKeyboardKey.return, modifierFlags: [])
      XCTAssertTrue(wait("value == 'rozwinięty'", header), "sprzątanie: Return rozwija")
    } else {
      print("klawiatura: fokus komórki listy niedostępny w symulatorze — Return i Spacja do próby ręcznej na iPadzie")
    }
  }

  /// Glif notatki przy KAŻDYM projekcie: osobny przycisk za nagłówkiem (nagłówek ignoruje
  /// dzieci), w pierwszej linii nagłówka po prawej, przed dymkiem agentów; wartość mówi, czy notatka ma treść.
  @MainActor
  func testNoteGlyphAtEveryProject() throws {
    let app = try launchLoggedIn()
    for (project, value) in [("data-loader", "jest treść"), ("willow", "pusta")] {
      let header = DemoServer.revealProject(app, project)
      XCTAssertTrue(header.waitForAppearance(timeout: 10), "nagłówek \(project)")
      let glyph = element(app, "tree.note-glyph.\(project)")
      XCTAssertTrue(glyph.waitForAppearance(timeout: 10), "glif notatki przy \(project)")
      XCTAssertEqual(glyph.elementType, .button, "\(project): przycisk")
      XCTAssertTrue(wait("value == '\(value)'", glyph), "\(project): \(glyph.value ?? "—")")
      XCTAssertTrue(glyph.isHittable, "\(project): glif klikalny")
      // Cel 44 pt w pierwszej linii nagłówka, po prawej stronie treści.
      XCTAssertGreaterThanOrEqual(glyph.frame.width, 44)
      XCTAssertGreaterThanOrEqual(glyph.frame.height, 44)
      XCTAssertGreaterThan(glyph.frame.midX, header.frame.midX, "\(project): glif po prawej")
      XCTAssertLessThan(glyph.frame.midY, header.frame.midY + 1, "\(project): glif w pierwszej linii")
    }
  }

  /// Menu kontekstowe nagłówka: przytrzymanie → „Nowa sesja” zakłada sesję w TYM projekcie
  /// i wchodzi w nią, a zwinięty projekt zostaje zwinięty; nad resztą menu stoi też „Nowy terminal” (demo nie ma
  /// terminala, więc wygaszony). Odmowa startu z menu listy mówi zdanie — na iPhonie nad listą, która stoi na
  /// wierzchu stosu, na iPadzie w szczególe obok; zawsze jedna karta. Sufit 6 paneli demo: 4 z zasiewu, własna
  /// sesja testu i sesja odbioru z `control.create`.
  @MainActor
  func testHeaderMenuStartsSessionAndExplainsRefusal() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let app = try launchLoggedIn()
    let header = DemoServer.revealProject(app, "map-view")
    XCTAssertTrue(header.exists, "nagłówek map-view")
    if (header.value as? String)?.hasPrefix("zwinięty") != true { toggle(app, "map-view") }
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "projekt zwinięty przed startem")

    // Kolejność menu: „Nowa sesja”, „Nowy terminal”, „Notatka projektu”, „Zwiń wszystkie”.
    header.press(forDuration: 1.0)
    let newSession = DemoServer.menuItem(app, id: "tree.newSession", label: "Nowa sesja")
    XCTAssertTrue(newSession.waitForAppearance(timeout: 5), "menu nagłówka ma „Nową sesję”")
    let newTerminal = DemoServer.menuItem(app, id: "tree.newTerminal", label: "Nowy terminal")
    XCTAssertTrue(newTerminal.exists, "menu nagłówka ma „Nowy terminal”")
    XCTAssertFalse(newTerminal.isEnabled, "bez terminala na serwerze pozycja wygaszona")
    let note = DemoServer.menuItem(app, id: "tree.note", label: "Notatka projektu")
    let collapseAll = app.buttons["Zwiń wszystkie"].firstMatch
    XCTAssertTrue(note.exists && collapseAll.exists, "reszta menu na miejscu")
    let order = [newSession, newTerminal, note, collapseAll].map(\.frame.minY)
    XCTAssertEqual(order, order.sorted(), "kolejność pozycji menu: \(order)")
    newSession.tap()

    // Wejście w nową sesję w tym projekcie: zakładka nowej sesji bieżąca, obok zakładka siostry z map-view.
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "pole nowej sesji")
    let current = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'tab.' AND selected == true")).firstMatch
    XCTAssertTrue(current.waitForAppearance(timeout: 15), "bieżąca zakładka nowej sesji")
    let id = String(current.identifier.dropFirst("tab.".count))
    XCTAssertNotEqual(id, "demo-map-view", "nowa sesja, nie siostra")
    XCTAssertTrue(element(app, "tab.demo-map-view").exists, "nowa sesja w projekcie nagłówka")
    if pad {
      XCTAssertTrue(DemoServer.row(app, id).waitForAppearance(timeout: 10), "nowa sesja widoczna w zwiniętym projekcie")
      XCTAssertTrue((header.value as? String)?.hasPrefix("zwinięty") == true, "apka niczego nie rozwinęła")
    }

    // Szósty panel: start zablokowany. Menu listy nie wygasza „Nowej sesji”, tap mówi powód.
    _ = try await control.create("idle", label: "M1 sufit paneli")
    if !pad { back(app) }
    let again = DemoServer.revealProject(app, "map-view")
    XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", again), "po powrocie projekt dalej zwinięty")
    again.press(forDuration: 1.0)
    let blocked = DemoServer.menuItem(app, id: "tree.newSession", label: "Nowa sesja")
    XCTAssertTrue(blocked.waitForAppearance(timeout: 5), "menu nagłówka przy blokadzie")
    XCTAssertTrue(blocked.isEnabled, "blokada startu nie wygasza pozycji")
    blocked.tap()
    let notices = app.descendants(matching: .any).matching(identifier: "tabs.notice")
    XCTAssertTrue(notices.firstMatch.waitForAppearance(timeout: 10), pad ? "zdanie w szczególe" : "zdanie nad listą")
    print("zdanie odmowy: \(notices.firstMatch.label)")
    XCTAssertEqual(notices.count, 1, "jedna karta zdania")
    if pad {
      XCTAssertTrue(element(app, "tab.\(id)").isSelected, "odmowa nie zmienia ekranu")
      notices.firstMatch.tap()
      XCTAssertTrue(notices.firstMatch.waitForDisappearance(timeout: 5), "tap zamyka zdanie")
    } else {
      XCTAssertTrue(again.exists, "lista zostaje na wierzchu")
      XCTAssertFalse(app.textViews["composer.field"].exists, "bez wejścia w sesję")
      // Zdanie nad listą gaśnie samo po swoim czasie (5 s), jak w szczególe.
      XCTAssertTrue(notices.firstMatch.waitForDisappearance(timeout: 10), "zdanie nad listą gaśnie samo")
    }

    // Sprzątanie: sesja odbioru i własna sesja testu (dwa naciśnięcia „×”) zwalniają sufit paneli.
    try await control.reset()
    if !pad {
      // Wiersz własnej sesji mógł już zejść ze zwiniętego projektu (zwolniony `heldOpen`): najpierw rozwinięcie.
      toggle(app, "map-view")
      XCTAssertTrue(wait("value == 'rozwinięty'", again), "projekt rozwinięty do sprzątania")
      DemoServer.reveal(app, id).tap()
    }
    XCTAssertTrue(waitSelected(element(app, "tab.\(id)")), "własna sesja na ekranie")
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()
    XCTAssertTrue(element(app, "tab.\(id)").waitForDisappearance(timeout: 15), "własna sesja zamknięta")
  }

  /// Zrzuty drzewa do oceny wzrokowej (iPad i iPhone, jasny i ciemny): lista, sesja obok (iPad), zwinięty projekt —
  /// na iPadzie przy zaznaczonej sesji obok, więc jeden kadr pokazuje zaznaczenie, zwinięcie i prowadnicę.
  /// Pliki `drzewo-<kadr>-<motyw>.png` w `RAROG_SCREENSHOT_DIR`; bez katalogu test jest pomijany.
  @MainActor
  func testCaptureTreeScreens() throws {
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    let directory = URL(filePath: path, directoryHint: .isDirectory)
    let port = try DemoServer.requirePort()
    let device = pad ? "ipad" : "iphone"
    for theme in ["dark", "light"] {
      let app = DemoServer.launch(port: port, environment: ["RAROG_UI_TEST_THEME": theme])
      DemoServer.pair(app)
      XCTAssertTrue(element(app, "project.willow").waitForAppearance(timeout: 15), "drzewo")
      DemoServer.hideKeyboard(app)
      sleep(2)
      print("zrzut \(device) \(theme): tytuł \(element(app, "list.title").frame), lista \(element(app, "session.list").frame)")
      try shot(app, directory, "\(device)-lista-\(theme)")
      if pad {
        DemoServer.reveal(app, "demo-rarog").tap()
        XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 10), "sesja obok")
        DemoServer.hideKeyboard(app)
        sleep(2)
        try shot(app, directory, "\(device)-sesja-obok-\(theme)")
      }
      toggle(app, "willow")
      sleep(1)
      try shot(app, directory, "\(device)-zwiniety-\(theme)")
      toggle(app, "willow")
      app.terminate()
    }
  }

  // MARK: - Pomocnicze

  @MainActor
  private func launchLoggedIn() throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    return app
  }

  /// Systemowy „wstecz” w pasku nawigacji szczegółu (iPhone; jak w `PhoneTabsUITests`).
  @MainActor
  private func back(_ app: XCUIApplication) {
    DemoServer.hideKeyboard(app)
    let button = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(button.waitForAppearance(timeout: 5), "przycisk „wstecz”")
    button.tap()
    DemoServer.expectList(app)
  }

  /// Strzałka projektu (wyciągnięta w widoczną część listy).
  @MainActor
  private func toggle(_ app: XCUIApplication, _ project: String) {
    let chevron = DemoServer.revealElement(app, element(app, "tree.toggle.\(project)"))
    XCTAssertTrue(chevron.exists, "strzałka \(project)")
    chevron.tap()
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ directory: URL, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "drzewo-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
    try screenshot.pngRepresentation.write(to: directory.appending(path: "drzewo-\(name).png"))
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitSelected(_ element: XCUIElement) -> Bool {
    wait("exists == true AND selected == true", element)
  }
}
