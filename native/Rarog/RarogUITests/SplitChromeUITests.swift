import XCTest

/// Wygląd podziału lista ↔ szczegół na iPadzie:
/// - przycisk zwijania listy stoi w lewym górnym rogu nagłówka sesji, a nazwa projektu i ścieżka tuż za nim;
///   działa przy liście rozwiniętej i zwiniętej, systemowego uchwytu nie ma nigdzie;
/// - listę od szczegółu oddziela pionowa kreska (1 piksel) w obu motywach, a po zwinięciu listy jej nie ma;
/// - pole wiadomości nie daje paskowi skrótów klawiatury grup „cofnij, ponów, wklej” (pigułka iPadOS pod polem).
final class SplitChromeUITests: XCTestCase {
  /// Etykiety systemowego uchwytu listy (`NavigationSplitView`) w obu językach symulatora.
  private static let systemToggleLabels = ["Ukryj pasek boczny", "Pokaż pasek boczny", "Hide Sidebar", "Show Sidebar"]

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("lista obok szczegółu jest na iPadzie") }
  }

  @MainActor
  func testListToggleLivesInSessionHeader() throws {
    let app = try launch(theme: nil)
    openSession(app, "demo-willow")
    let list = element(app, "session.list")
    let toggle = element(app, "header.listToggle")
    let title = element(app, "header.title")
    XCTAssertTrue(toggle.waitForAppearance(timeout: 5), "przycisk zwijania w nagłówku sesji")
    XCTAssertTrue(title.exists, "tytuł obok przycisku")
    assertNoSystemToggle(app, "lista rozwinięta")
    restoreListOnTeardown(app)
    XCTAssertEqual(toggle.label, "Ukryj listę sesji")
    XCTAssertTrue(title.label.contains("willow") && title.label.contains("~/Projects/willow"), "nazwa i ścieżka: \(title.label)")
    XCTAssertGreaterThanOrEqual(min(toggle.frame.width, toggle.frame.height), 43.5, "cel dotyku: \(toggle.frame)")
    // Przycisk na lewym brzegu kolumny szczegółu, tytuł tuż za nim, w jednym rzędzie, przed ikonami prawego rogu.
    XCTAssertGreaterThanOrEqual(toggle.frame.minX, list.frame.maxX, "przycisk w szczególe, nie w liście")
    XCTAssertLessThan(toggle.frame.minX - list.frame.maxX, 24, "przycisk przy lewej krawędzi szczegółu: \(toggle.frame)")
    XCTAssertEqual(title.frame.minX - toggle.frame.maxX, 2, accuracy: 1, "tytuł tuż za przyciskiem")
    XCTAssertGreaterThan(title.frame.width, 40, "tytuł widoczny, nie ściśnięty do zera: \(title.frame)")
    XCTAssertEqual(title.frame.midY, toggle.frame.midY, accuracy: 4, "jeden rząd")
    XCTAssertLessThan(title.frame.maxX, element(app, "header.terminalPopup").frame.minX, "tytuł przed ikonami")
    XCTAssertFalse(element(app, "list.newSession").frame.intersects(toggle.frame), "przycisk nie w pasku listy")
    // Bez systemowego uchwytu pasek listy nie centruje „AGENCI (N)”: nagłówek zostaje przy lewej krawędzi.
    let listTitle = element(app, "list.title")
    XCTAssertLessThan(listTitle.frame.minX, list.frame.minX + 24, "„AGENCI” przy lewej krawędzi: \(listTitle.frame)")
    // …but whole: with two buttons in the bar (New Session before Settings) the heading can slide past the
    // column's left edge ("GENCI (8)").
    XCTAssertGreaterThanOrEqual(listTitle.frame.minX, list.frame.minX, "„AGENCI” nie ucięte: \(listTitle.frame)")
    let newSession = element(app, "list.newSession")
    XCTAssertLessThan(listTitle.frame.maxX, newSession.frame.minX, "heading before New Session")
    XCTAssertLessThanOrEqual(newSession.frame.maxX, element(app, "list.settings").frame.minX + 1, "dwa przyciski obok")

    toggle.tap()
    XCTAssertTrue(waitHittable(list, false), "przycisk zwija listę")
    XCTAssertTrue(wait("label == 'Pokaż listę sesji'", toggle), "ta sama pozycja mówi „pokaż”")
    assertNoSystemToggle(app, "lista zwinięta")
    XCTAssertLessThan(toggle.frame.minX, 24, "po zwinięciu przy lewej krawędzi ekranu: \(toggle.frame)")
    XCTAssertEqual(title.frame.minX - toggle.frame.maxX, 2, accuracy: 1, "tytuł dalej tuż za przyciskiem")
    toggle.tap()
    XCTAssertTrue(waitHittable(list, true), "ten sam przycisk rozwija listę")
    XCTAssertTrue(wait("label == 'Ukryj listę sesji'", toggle))
    app.terminate()
  }

  /// „Ustawienia” i „Nowa sesja” w pasku listy jedną grupą: cele co `HeaderMetrics.iconSpacing` (2 pt, jak ikony
  /// prawego rogu nagłówka sesji, nie odstęp systemu). New Session stands before Settings, its glyph level with the
  /// gear and 9 pt towards it (`NewSessionListButton.glyphLift` and `glyphShift`). The gear stands in the column of the
  /// first project header's note glyph. With the terminal seam on, the header's terminal target ends where the
  /// clock's begins.
  @MainActor
  func testListBarIconsTogether() throws {
    let app = try launch(theme: nil, fakeTerminal: true)
    let settings = element(app, "list.settings")
    let newSession = element(app, "list.newSession")
    XCTAssertTrue(settings.waitForAppearance(timeout: 5) && newSession.exists, "dwa przyciski w pasku listy")
    sleep(1)
    let gap = settings.frame.minX - newSession.frame.maxX
    print("pasek listy: ustawienia \(settings.frame), nowa sesja \(newSession.frame), odstęp \(gap)")
    XCTAssertLessThanOrEqual(gap, 3, "cele obok siebie: \(newSession.frame) → \(settings.frame)")
    XCTAssertGreaterThanOrEqual(gap, -0.5, "cele się nie nakładają")
    XCTAssertEqual(settings.frame.midY, newSession.frame.midY, accuracy: 0.5, "cele w jednym rzędzie")
    let shot = capture(app, "pasek-listy-ikony")
    let pixels = try XCTUnwrap(HeaderPixels(shot, pointsWidth: app.frame.width))
    let ink = try [settings, newSession].map { button in
      let frame = button.frame
      return try XCTUnwrap(pixels.ink(in: frame, background: pixels.dominant(in: frame)), "glif \(button.identifier)")
    }
    print("pasek listy: tusz ustawień \(ink[0]) (środek \(ink[0].midY)), nowej sesji \(ink[1]) (środek \(ink[1].midY))")
    XCTAssertEqual(
      ink[0].midY - ink[1].midY, 0, accuracy: 0.5, "New Session glyph level with the gear: \(ink[0]) / \(ink[1])")
    let headerButton = { (prefix: String) in
      app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }
    let note = headerButton("tree.note-glyph."), recent = headerButton("tree.recent.")
    let terminal = headerButton("tree.terminal.")
    XCTAssertTrue(note.exists && recent.exists && terminal.exists, "note, clock and terminal in a project header")
    let below = try [note, recent].map { button in
      // Only the glyph's band: the 44 pt target reaches down to the branch line.
      let frame = button.frame.insetBy(dx: 0, dy: 13)
      return try XCTUnwrap(pixels.ink(in: frame, background: pixels.dominant(in: frame)), "glif \(button.identifier)")
    }
    print("pasek listy: tusz notatki \(below[0]), zegara \(below[1])")
    XCTAssertEqual(ink[0].midX, below[0].midX, accuracy: 1, "gear over the note glyph: \(ink[0]) / \(below[0])")
    XCTAssertEqual(terminal.frame.maxX, recent.frame.minX, accuracy: 0.5, "terminal target ends at the clock's")
    app.terminate()
  }

  @MainActor
  func testColumnDividerDark() throws { try checkColumnDivider(theme: "dark") }

  @MainActor
  func testColumnDividerLight() throws { try checkColumnDivider(theme: "light") }

  /// Pole wiadomości bez grup paska skrótów: na symulatorze pasek stoi nad klawiaturą ekranową, na iPadzie z klawiaturą
  /// sprzętową zwijał się do pigułki pod polem. Przed rundą 4 stały w nim „cofnij”, „Przywróć” i „Wklej”.
  @MainActor
  func testComposerKeyboardBarWithoutShortcuts() throws {
    let app = try launch(theme: nil)
    openSession(app, "demo-rarog-stop")
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "pole sesji")
    field.tap()
    field.typeText("abc")
    guard app.keyboards.firstMatch.waitForAppearance(timeout: 3) else {
      throw XCTSkip("symulator z klawiaturą sprzętową: paska skrótów nad klawiaturą ekranową nie ma")
    }
    for id in ["assistantUndo", "assistantRedo", "assistantPaste:forEvent:"] {
      XCTAssertFalse(app.buttons[id].exists, "\(id) w pasku skrótów")
    }
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3))
    XCTAssertEqual(field.value as? String ?? "", "", "pole opróżnione Backspace'em")
    for id in ["assistantUndo", "assistantRedo", "assistantPaste:forEvent:"] {
      XCTAssertFalse(app.buttons[id].exists, "\(id) po opróżnieniu pola")
    }
    app.terminate()
  }

  // MARK: - Pomocnicze

  /// Kreska przy prawej krawędzi listy, przez całą wysokość: ostatni piksel kolumny listy odstaje od tła po obu
  /// stronach. Po zwinięciu listy przy lewej krawędzi ekranu kreski nie ma.
  @MainActor
  private func checkColumnDivider(theme: String) throws {
    let app = try launch(theme: theme)
    openSession(app, "demo-willow")
    DemoServer.hideKeyboard(app)
    sleep(1)
    let list = element(app, "session.list").frame
    let shot = capture(app, "kreska-\(theme)")
    let pixels = try XCTUnwrap(HeaderPixels(shot, pointsWidth: app.frame.width))
    let height = app.frame.height
    let ys = stride(from: 40, to: height - 40, by: 20).map { CGFloat($0) }
    let line = ys.filter { y in
      let ink = pixels.color(at: CGPoint(x: list.maxX - 0.25, y: y))
      let left = pixels.color(at: CGPoint(x: list.maxX - 4, y: y))
      let right = pixels.color(at: CGPoint(x: list.maxX + 4, y: y))
      return HeaderPixels.distance(ink, left) > 6 && HeaderPixels.distance(ink, right) > 6
    }
    print("kreska (\(theme)): \(line.count)/\(ys.count) próbek przy x = \(list.maxX)")
    XCTAssertGreaterThanOrEqual(Double(line.count), Double(ys.count) * 0.9, "\(theme): kreska przez całą wysokość")

    restoreListOnTeardown(app)
    element(app, "header.listToggle").tap()
    XCTAssertTrue(waitHittable(element(app, "session.list"), false), "lista zwinięta")
    sleep(1)
    let collapsed = try XCTUnwrap(HeaderPixels(capture(app, "kreska-zwinieta-\(theme)"), pointsWidth: app.frame.width))
    let edge = ys.filter { y in
      HeaderPixels.distance(collapsed.color(at: CGPoint(x: 0.25, y: y)), collapsed.color(at: CGPoint(x: 4, y: y))) > 6
    }
    XCTAssertLessThanOrEqual(Double(edge.count), Double(ys.count) * 0.1, "\(theme): po zwinięciu bez kreski przy krawędzi")
    element(app, "header.listToggle").tap()
    app.terminate()
  }

  /// Zwinięcie listy jest preferencją apki (przeżywa restart i `RAROG_UI_TEST_RESET`): test, który ją zwija,
  /// rozwija ją z powrotem także po porażce. Blok końca testu, nie `defer` (przerwanie go pomija).
  @MainActor
  private func restoreListOnTeardown(_ app: XCUIApplication) {
    addTeardownBlock { @MainActor in
      let toggle = app.descendants(matching: .any)["header.listToggle"].firstMatch
      guard app.state == .runningForeground, toggle.exists, toggle.label == "Pokaż listę sesji" else { return }
      toggle.tap()
    }
  }

  @MainActor
  private func launch(theme: String?, fakeTerminal: Bool = false) throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    if fakeTerminal { app.launchEnvironment["RAROG_UI_TEST_FAKE_TERMINAL"] = "1" }
    if let theme { app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme }
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    return app
  }

  @MainActor
  private func openSession(_ app: XCUIApplication, _ id: String) {
    DemoServer.reveal(app, id).tap()
    XCTAssertTrue(wait("selected == true", element(app, "tab.\(id)")), "sesja \(id) otwarta")
  }

  @MainActor
  private func assertNoSystemToggle(_ app: XCUIApplication, _ when: String) {
    for label in Self.systemToggleLabels {
      XCTAssertFalse(app.buttons[label].exists, "\(when): systemowy uchwyt „\(label)”")
    }
  }

  @MainActor
  private func capture(_ app: XCUIApplication, _ name: String) -> XCUIScreenshot {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    return screenshot
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ format: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitHittable(_ element: XCUIElement, _ hittable: Bool) -> Bool {
    wait(hittable ? "exists == true AND hittable == true" : "exists == false OR hittable == false", element)
  }
}
