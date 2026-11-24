import XCTest

/// Sterowanie sesją przeciw serwerowi demo: Esc przerywa turę i oddaje prompt do pustego pola,
/// formularz „Nowa sesja" zakłada sesję i od razu w nią wchodzi, szkic pola przeżywa
/// nawigację i zabicie apki, zegar w nagłówku otwiera „Ostatnie sesje",
/// a pasek cytatu promptu otwiera listę tur.
///
/// Demo: `demo-rarog-stop` pracuje bez strumienia (tura do przerwania); willow ma dwie sesje i trzy
/// rozmowy CLI do wznowienia. Sesję zakłada test i test ją zamyka (demo ma sufit paneli).
final class SessionControlUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// „Wyślij" staje się Stopem: przy pracującej sesji i pustym polu przycisk pola
  /// (`composer.send`) mówi „Stop", litera przywraca „Wyślij", skasowanie — znów Stop. Tap przerywa turę.
  /// The demo server reports no prompt handed back by Claude Code, so the field stays empty and the button sends,
  /// because the turn has stopped. Esc
  /// z klawiatury idzie tą samą drogą (`interruptTurn`), ale XCUITest nie dowozi Esc do skrótów apki
  /// w symulatorze (pomiar: ani skrót pola, ani ekranu nie dostał zdarzenia) — Esc sprawdza się
  /// ręcznie na iPadzie, regułę rozstrzygania pokrywa `InterruptPresentationTests`.
  @MainActor
  func testSendBecomesStopWhileWorking() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    let button = app.buttons["composer.send"]
    XCTAssertTrue(button.waitForAppearance(timeout: 15), "przycisk pola")
    XCTAssertTrue(wait("label == %@", button, argument: "Stop"), "praca i puste pole: Stop, nie \(button.label)")
    XCTAssertFalse(element(app, "composer.stop").exists, "osobnego Stopu nie ma")
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 5))
    XCTAssertEqual(field.value as? String ?? "", "", "pole puste przed przerwaniem")

    field.tap()
    field.typeText("x")
    XCTAssertTrue(wait("label == %@", button, argument: "Wyślij"), "wpis przywraca „Wyślij”")
    field.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(wait("label == %@", button, argument: "Stop"), "puste pole: znów Stop")

    button.tap()
    // The demo server reports no prompt handed back by Claude Code, so the field stays empty, as in the terminal.
    XCTAssertTrue(
      wait("label == %@", button, argument: "Wyślij", timeout: 20), "tura przerwana: puste pole, przycisk „Wyślij”")
    XCTAssertEqual(field.value as? String ?? "", "", "no handed-back prompt: the field stays empty")
    XCTAssertFalse(element(app, "composer.hint").exists, "po udanym przerwaniu linia pod polem gaśnie")
  }

  /// Szybki podwójny tap „Wyślij" wysyła raz i niczego nie przerywa: przez 700 ms po wysyłce przycisk zostaje
  /// „Wyślij", choć wpis w locie (echo wstrzymane w demo) to już tura do przerwania; drugi tap trafia w pustą
  /// wysyłkę. Po oknie przycisk staje się Stopem. An interrupt leaves no trace this test can see (the demo hands no
  /// prompt back), so the count of interrupts is checked by
  /// `ComposerPrimaryButtonTests.testDoubleSendRightAfterTypingSendsOnceInterruptsNever` (RarogUIKitTests).
  @MainActor
  func testDoubleTapSendSendsOnceInterruptsNever() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "R3 podwójny tap")
    try await control.configure(echo: "hold")
    let app = try launchLoggedIn()
    DemoServer.reveal(app, id).tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(wait("enabled == true", field, timeout: 15), "pole sesji testu")
    let button = app.buttons["composer.send"]
    XCTAssertTrue(wait("label == %@", button, argument: "Wyślij"), "bezczynna sesja: „Wyślij”")
    field.tap()
    field.typeText("R3 podwójny tap")
    button.doubleTap()

    _ = try await control.wait("jedna wysyłka", until: { $0.receivedMessages.count >= 1 })
    _ = try await control.stays("druga wysyłka nie wyszła", for: .seconds(1.5)) { $0.receivedMessages.count == 1 }
    XCTAssertTrue(wait("label == %@", button, argument: "Stop", timeout: 5), "po oknie wpis w locie daje Stop")
    try await control.release("all")
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testNewSessionSheetLaunchesAndDraftSurvivesRelaunch() throws {
    let app = try launchLoggedIn()
    element(app, "list.newSession").tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForAppearance(timeout: 10), "arkusz „Nowa sesja”")

    // A typed directory: Enter navigates (does not launch), the demo project has no subdirectories. While the
    // browser is open, the footer offers an explicit Choose instead of Launch.
    chooseTyped(app, "/Users/demo/Projects/willow/", confirmDirStatus: true)
    // Tryb, model i effort widać od pierwszej klatki, bez rozwijania; zdanie o trybie auto jest
    // ostrzeżeniem od pierwszej klatki, a podsumowanie w stopce mówi to samo krótko.
    let summary = element(app, "newSession.launchSummary")
    XCTAssertTrue(wait("label == %@", summary, argument: "willow · Auto · Opus · xhigh"), summary.label)
    let hint = element(app, "newSession.modeHint")
    XCTAssertTrue(hint.exists && hint.isHittable, "zdanie o trybie auto widoczne bez przewijania")
    // The browser closes after the choice: Start stands under the project, the auto warning under the switch.
    XCTAssertFalse(element(app, "newSession.footerWarning").exists, "no second warning in the footer")
    XCTAssertTrue(element(app, "newSession.model").isHittable && element(app, "newSession.effort").isHittable)
    // Jedno stuknięcie zmienia tryb; zdanie i podsumowanie idą za nim.
    let modes = app.segmentedControls["newSession.mode"]
    XCTAssertTrue(modes.waitForAppearance(timeout: 5), "przełącznik trybu")
    let autoHint = hint.label
    modes.buttons["Plan"].tap()
    XCTAssertTrue(wait("label == %@", summary, argument: "willow · Plan · Opus · xhigh"), summary.label)
    XCTAssertNotEqual(hint.label, autoHint, "zdanie o trybie zmienia się z wyborem")
    modes.buttons["Auto"].tap()
    XCTAssertTrue(wait("label == %@", summary, argument: "willow · Auto · Opus · xhigh"), summary.label)
    // Ultracode: przełącznik pod rzędem startu, przy Opusie, domyślnie wyłączony i bez zdania o koszcie
    // (wiersz jednej linii: „Rozmowy” nad zgięciem); włączony odsłania zdanie, wygasza menu effortu na xhigh,
    // a podsumowanie mówi „ultracode”. Sesja startuje z nim (ponowne wejście niżej).
    let ultracode = app.switches["newSession.ultracode"]
    XCTAssertTrue(ultracode.waitForAppearance(timeout: 5), "przełącznik ultracode")
    XCTAssertEqual(ultracode.value as? String, "0", "domyślnie wyłączony")
    XCTAssertFalse(element(app, "newSession.ultracodeNote").exists, "wyłączony bez zdania o koszcie")
    ultracode.switches.firstMatch.tap()
    XCTAssertTrue(wait("value == '1'", ultracode), "przełącznik włączony")
    XCTAssertTrue(element(app, "newSession.ultracodeNote").waitForAppearance(timeout: 5), "włączony ze zdaniem o koszcie")
    XCTAssertTrue(wait("label == %@", summary, argument: "willow · Auto · Opus · xhigh · ultracode"), summary.label)
    XCTAssertFalse(element(app, "newSession.effort").isEnabled, "menu effortu wygaszone na xhigh")

    // Conversations: Open above Resumable; a closed one resumes with its row, an open one has go-to and Fork.
    // `Form` creates rows only on screen, so the list may be below the fold.
    let closed = element(app, "resume.resume.demo-engine-willow-1")
    for _ in 0..<4 where !closed.waitForAppearance(timeout: 2) {
      element(app, "newSession.sheet").swipeUp(velocity: .slow)
    }
    XCTAssertTrue(closed.exists, "rozmowy do wznowienia")
    let openGroup = element(app, "newSession.resumeOpen")
    let resumableGroup = element(app, "newSession.resumeResumable")
    XCTAssertTrue(openGroup.exists && resumableGroup.exists, "two conversation groups")
    XCTAssertLessThan(openGroup.frame.minY, resumableGroup.frame.minY, "Open above Resumable")
    XCTAssertTrue(element(app, "resume.open.demo-engine-willow-0").exists, "otwarta rozmowa z przejściem")
    XCTAssertTrue(element(app, "resume.fork.demo-engine-willow-0").exists, "otwarta rozmowa z „Rozwidl”")

    // „Uruchom": arkusz znika, apka od razu stoi w nowej sesji projektu.
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    app.buttons["newSession.launch"].tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForDisappearance(timeout: 15), "arkusz zamknięty po starcie")
    let created = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
    XCTAssertTrue(created.waitForAppearance(timeout: 15), "nowa sesja otwarta")
    let createdId = created.identifier
    XCTAssertFalse(["tab.demo-willow", "tab.demo-willow-parser"].contains(createdId), "bieżąca jest nowa sesja: \(createdId)")
    let sessionId = String(createdId.dropFirst("tab.".count))

    // Szkic przeżywa nawigację…
    let field = app.textViews["composer.field"]
    XCTAssertTrue(wait("enabled == true", field, timeout: 15), "pole nowej sesji")
    field.tap()
    let draft = "szkic \(UUID().uuidString.prefix(6))"
    field.typeText(draft)
    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(wait("selected == true", element(app, "tab.demo-willow")), "inna sesja")
    element(app, createdId).tap()
    XCTAssertTrue(wait("value == %@", field, argument: draft), "szkic po powrocie do sesji")

    // …i zabicie apki (bez kasowania danych między uruchomieniami).
    sleep(1)
    app.terminate()
    let again = DemoServer.launch(port: try DemoServer.requirePort(), reset: false)
    XCTAssertTrue(DemoServer.reveal(again, sessionId).waitForAppearance(timeout: 15), "nowa sesja na liście")
    // Ultracode nie trafia do pamięci urządzenia: ponowne wejście w „Nowa sesja” ma go wyłączonego.
    element(again, "list.newSession").tap()
    let ultracodeAgain = again.switches["newSession.ultracode"]
    XCTAssertTrue(ultracodeAgain.waitForAppearance(timeout: 10), "przełącznik ultracode po ponownym wejściu")
    XCTAssertEqual(ultracodeAgain.value as? String, "0", "po ponownym wejściu wyłączony")
    // A known directory: the browser is closed, so the ultracode row with its sentence stands above the footer; a
    // screenshot of this state stays in the test result, and Cancel discards the choice.
    ultracodeAgain.switches.firstMatch.tap()
    XCTAssertTrue(wait("value == '1'", ultracodeAgain), "przełącznik włączony w zwiniętym oknie")
    XCTAssertTrue(element(again, "newSession.ultracodeNote").isHittable, "zdanie o koszcie widoczne")
    let screenshot = XCTAttachment(screenshot: again.screenshot())
    screenshot.name = "nowa-sesja-ultracode"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    element(again, "newSession.cancel").tap()
    XCTAssertTrue(element(again, "newSession.sheet").waitForDisappearance(timeout: 10), "arkusz zamknięty")
    DemoServer.reveal(again, sessionId).tap()
    let restored = again.textViews["composer.field"]
    XCTAssertTrue(wait("value == %@", restored, argument: draft), "szkic po ponownym uruchomieniu")
    clear(again, restored)

    // Sprzątanie: „×" dwa razy zamyka panel założony przez test.
    let close = element(again, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    close.tap()
    XCTAssertTrue(element(again, createdId).waitForDisappearance(timeout: 10), "sesja testu zamknięta")
  }

  /// Stuknięcie w otwartą rozmowę przechodzi do JEJ karty, choć w katalogu stoją dwie (`sessionId` z listy).
  @MainActor
  func testNewSessionOpensLiveConversation() throws {
    let app = try launchLoggedIn()
    element(app, "list.newSession").tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForAppearance(timeout: 10), "arkusz „Nowa sesja”")
    chooseTyped(app, "/Users/demo/Projects/willow/")
    let live = element(app, "resume.open.demo-engine-willow-0")
    // The row must be brought ABOVE the footer — a tap in the middle of an element under the footer hit the footer.
    let warning = element(app, "newSession.footerWarning")
    let footerTop = warning.exists ? warning.frame.minY : element(app, "newSession.launch").frame.minY
    for _ in 0..<6 where !(live.waitForAppearance(timeout: 2) && live.frame.maxY < footerTop - 8) {
      element(app, "newSession.sheet").swipeUp(velocity: .slow)
    }
    XCTAssertTrue(live.exists && live.frame.maxY < footerTop, "otwarta rozmowa na liście, nad stopką")
    live.tap()
    let closed = element(app, "newSession.sheet").waitForDisappearance(timeout: 10)
    // Bez przejścia przy wierszu stoi zdanie — w komunikacie porażki, żeby było wiadomo, czy tap trafił.
    let miss = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kilka sesji' OR label CONTAINS 'nie widzi'"))
      .firstMatch
    XCTAssertTrue(closed, "arkusz zamknięty; zdanie przy wierszu: \(miss.exists ? miss.label : "brak")")
    XCTAssertTrue(wait("selected == true", element(app, "tab.demo-willow")), "karta tej rozmowy")
  }

  /// The directory browser: a tap anywhere on a row opens the directory, Up before the path
  /// goes back, Choose names the directory on screen and the roots level has nothing to choose. The demo projects are
  /// the roots (more than one), so Up from a project leads to the roots level. The rows are compact (~44 pt).
  @MainActor
  func testDirectoryBrowserRowOpensAndUpReturns() throws {
    let app = try launchLoggedIn(environment: ["RAROG_UI_TEST_THEME": "dark"])
    element(app, "list.newSession").tap()
    XCTAssertTrue(element(app, "newSession.sheet").waitForAppearance(timeout: 10), "arkusz „Nowa sesja”")
    let path = app.textFields["newSession.path"]
    if !path.waitForAppearance(timeout: 3) { element(app, "newSession.changeDirectory").tap() }
    XCTAssertTrue(path.waitForAppearance(timeout: 5), "browser field")
    let up = app.buttons["newSession.up"]
    XCTAssertTrue(up.waitForAppearance(timeout: 5), "Up before the path")
    let row = app.buttons["newSession.dir.willow"]
    if !row.waitForAppearance(timeout: 3), up.isEnabled { up.tap() }
    XCTAssertTrue(row.waitForAppearance(timeout: 5), "the roots level lists the demo projects")
    let choose = app.buttons["newSession.choose"]
    XCTAssertFalse(choose.exists, "the roots level: nothing to choose")
    XCTAssertFalse(up.isEnabled, "the roots level: Up disabled")
    XCTAssertLessThanOrEqual(row.frame.height, 50, "compact row, \(row.frame.height) pt")
    XCTAssertGreaterThanOrEqual(row.frame.height, 44, "44 pt touch target, \(row.frame.height) pt")
    XCTAssertEqual(element(app, "newSession.browseHint").label, "Stuknij katalog, żeby go otworzyć.")
    attach(app, "browser-roots")
    // A tap on the name, not on the chevron, opens the directory.
    row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
    XCTAssertTrue(wait("label == %@", choose, argument: "Wybierz willow"), "Choose names the directory on screen")
    XCTAssertTrue(up.isEnabled, "inside a project: Up enabled")
    XCTAssertEqual(up.label, "W górę", "Up from a root leads to the roots level")
    attach(app, "browser-inside")
    up.tap()
    XCTAssertTrue(row.waitForAppearance(timeout: 5), "Up went back to the roots level")
    XCTAssertTrue(choose.waitForDisappearance(timeout: 5), "nothing to choose again")
  }

  @MainActor
  private func attach(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Choosing a typed directory in the browser: Change opens the browser when the window
  /// stands in a known project; Enter in the field goes to the path, the footer holds the hint and "Choose <the
  /// directory on screen>" in place of Launch. "Wybierz willow" asks first only when the browser has not seen willow
  /// as a row yet (the demo roots level knows it is a repository), and then "Wybierz mimo to" chooses.
  @MainActor
  private func chooseTyped(_ app: XCUIApplication, _ value: String, confirmDirStatus: Bool = false) {
    let path = app.textFields["newSession.path"]
    if !path.waitForAppearance(timeout: 3) { element(app, "newSession.changeDirectory").tap() }
    XCTAssertTrue(path.waitForAppearance(timeout: 5), "browser field")
    clear(app, path)
    path.typeText("\(value)\n")
    if confirmDirStatus {
      XCTAssertTrue(
        wait("label == %@", element(app, "newSession.dirStatus"), argument: "Brak podkatalogów — możesz uruchomić sesję tutaj."),
        "project directory without subdirectories")
      XCTAssertFalse(app.buttons["newSession.launch"].exists, "the footer holds the choice, not Launch")
      XCTAssertEqual(element(app, "newSession.browseHint").label, "Stuknij katalog, żeby go otworzyć.")
    }
    let choose = app.buttons["newSession.choose"]
    XCTAssertTrue(wait("label == %@", choose, argument: "Wybierz willow"), choose.label)
    XCTAssertTrue(choose.isHittable, "Choose is pinned in the footer, not under the list")
    choose.tap()
    let anyway = app.buttons["newSession.chooseAnyway"]
    if anyway.waitForAppearance(timeout: 2) { anyway.tap() }
    XCTAssertTrue(element(app, "newSession.project").waitForAppearance(timeout: 5), "browser closed back to the project row")
  }

  /// The Recent Sessions clock stands in the project header of the list, right before the note glyph:
  /// its own button, 44 pt high and at least 36 pt wide, whose target does not overlap the note's.
  @MainActor
  func testRecentSessionsFromTreeClock() throws {
    let app = try launchLoggedIn()
    XCTAssertTrue(DemoServer.revealProject(app, "willow").waitForAppearance(timeout: 10), "nagłówek willow")
    let clock = element(app, "tree.recent.willow")
    XCTAssertTrue(clock.waitForAppearance(timeout: 10), "zegar w nagłówku projektu")
    XCTAssertEqual(clock.elementType, .button, "zegar to przycisk, osobny od nagłówka")
    XCTAssertTrue(clock.isHittable, "zegar klikalny")
    let note = element(app, "tree.note-glyph.willow")
    XCTAssertTrue(note.waitForAppearance(timeout: 10), "glif notatki obok")
    XCTAssertGreaterThanOrEqual(clock.frame.height, 44, "clock target height \(clock.frame)")
    XCTAssertGreaterThanOrEqual(clock.frame.width, 36, "clock target width \(clock.frame)")
    XCTAssertLessThanOrEqual(clock.frame.maxX, note.frame.minX, "zegar przed notatką, cele bez nakładania")
    XCTAssertEqual(clock.frame.midY, note.frame.midY, accuracy: 1, "ta sama linia")
    clock.tap()
    XCTAssertTrue(element(app, "recent.sheet").waitForAppearance(timeout: 10), "„Ostatnie sesje”")
    XCTAssertTrue(element(app, "resume.resume.demo-engine-willow-1").waitForAppearance(timeout: 10), "rozmowy do wznowienia")
    XCTAssertTrue(app.staticTexts["Otwarte sesje stoją na liście agentów — tutaj są tylko te do wznowienia."].exists)
    element(app, "recent.close").tap()
    XCTAssertTrue(element(app, "recent.sheet").waitForDisappearance(timeout: 5))
  }

  @MainActor
  func testPromptBarOpensTurnList() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-data-loader").tap()
    DemoServer.hideKeyboard(app)
    let transcript = app.collectionViews["transcript"]
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    let bar = app.buttons["transcript.promptBar"]
    XCTAssertFalse(bar.exists, "przy dnie paska nie ma")
    // Odjechanie od dna małymi krokami (bez rzutu): pasek stoi między dnem a samą górą, a krótki
    // transkrypt seeda ma to okno węższe niż 0,2 wysokości iPada 13" — jeden duży krok przeskakiwał
    // je aż do góry, gdzie pasek słusznie znika.
    for _ in 0..<8 where !bar.exists {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
      start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 50)),
                  withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    XCTAssertTrue(bar.waitForAppearance(timeout: 5), "pasek cytatu po odjechaniu od dna")
    XCTAssertTrue(bar.label.hasPrefix("Prompt: Zaimportuj dane z CSV"), bar.label)
    bar.tap()
    XCTAssertTrue(element(app, "prompts.sheet").waitForAppearance(timeout: 5), "lista tur")
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'prompts.row.'")).firstMatch
    XCTAssertTrue(row.waitForAppearance(timeout: 5))
    row.tap()
    XCTAssertTrue(element(app, "prompts.sheet").waitForDisappearance(timeout: 5), "skok do tury zamyka listę")

    // Lista od najnowszego: sesja z trzema promptami (pipe-link), pierwszy
    // wiersz od góry to najwyższy numer wiadomości, niżej coraz starsze. Poziomo: w pionie transkrypt seeda
    // mieści się prawie cały (w pełnym przebiegu z kartą „przerwana” zamiast pola nie było położenia, w którym
    // pasek stoi — ani przy dnie, ani przy samej górze), a w poziomie transkrypt jest niższy.
    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
    DemoServer.reveal(app, "demo-pipe-link").tap()
    DemoServer.hideKeyboard(app)
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    for _ in 0..<16 where !bar.exists {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
      start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 50)),
                  withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    XCTAssertTrue(bar.waitForAppearance(timeout: 5), "pasek cytatu w pipe-link")
    bar.tap()
    XCTAssertTrue(element(app, "prompts.sheet").waitForAppearance(timeout: 5), "lista tur pipe-link")
    let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'prompts.row.'"))
    XCTAssertTrue(rows.firstMatch.waitForAppearance(timeout: 5))
    let ordered = rows.allElementsBoundByIndex.sorted { $0.frame.minY < $1.frame.minY }
    let seqs = ordered.compactMap { Int($0.identifier.dropFirst("prompts.row.".count)) }
    XCTAssertEqual(seqs.count, 3, "trzy prompty z tekstem: \(seqs)")
    XCTAssertEqual(seqs, seqs.sorted(by: >), "od najnowszego u góry: \(seqs)")
    XCTAssertTrue(ordered.first?.label.hasPrefix("Prompt 3 z 3, najnowszy") == true, ordered.first?.label ?? "")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func launchLoggedIn(environment: [String: String] = [:]) throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: environment)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    // Pierwszy klawisz sprzętowy przy wysuniętej klawiaturze ekranowej symulator zużywa na
    // przełączenie się na klawiaturę sprzętową — jałowa strzałka przed skrótami.
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Czyści pole: zaznacz wszystko i usuń (pole z fokusem).
  @MainActor
  private func clear(_ app: XCUIApplication, _ field: XCUIElement) {
    field.tap()
    app.typeKey("a", modifierFlags: .command)
    field.typeText(XCUIKeyboardKey.delete.rawValue)
  }

  private func wait(_ predicate: String, _ object: Any, argument: String? = nil, timeout: TimeInterval = 10) -> Bool {
    let format = argument.map { NSPredicate(format: predicate, $0) } ?? NSPredicate(format: predicate)
    let expectation = XCTNSPredicateExpectation(predicate: format, object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
