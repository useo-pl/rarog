import XCTest

/// Okna, dymki i formularze apki: okno terminala Cmd+F i Cmd+G, historia, diff, jeden arkusz naraz,
/// klawiatura przy arkuszach, dymki — oraz pomiary, z których wyszły reguły.
/// Demo nie ma terminala, więc apka dostaje szew
/// `RAROG_UI_TEST_FAKE_TERMINAL=1` (build Debug): okno otwiera się ze zmyślonym ekranem, bez połączenia.
/// Sonda `RAROG_UI_TEST_PROBE=1` (`UITestProbe` w apce) mówi, kto trzyma klawiaturę, wykonuje Esc łańcuchem
/// respondentów (symulator klawisza Esc nie podaje) i mierzy promień rogu prezentacji.
///
/// Zrzuty (`testCapture…`) i pomiary (`testMeasure…`) chodzą tylko z `RAROG_SCREENSHOT_DIR`; pomiary dodatkowo
/// z `RAROG_E0_MEASURE=1`. Zrzut XCUITest iPada w poziomie wychodzi obrócony i ucięty (symulator iOS 27), więc przy
/// `RAROG_SCREENSHOT_SYNC=1` test zostawia prośbę `<plik>.request` i czeka na zrzut `xcrun simctl io … screenshot`
/// ze strony Maca (`scripts/ios-shots.sh`).
final class WindowsUITests: XCTestCase {
  private var startOrientation: UIDeviceOrientation?
  private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

  override func setUp() {
    continueAfterFailure = true
    startOrientation = XCUIDevice.shared.orientation
    if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
  }

  override func tearDown() {
    if let startOrientation, startOrientation != XCUIDevice.shared.orientation {
      XCUIDevice.shared.orientation = startOrientation
    }
    super.tearDown()
  }

  // MARK: - Bramka

  /// Szew działa: Cmd+F otwiera okno powłoki w demo i ten sam skrót je zamyka, a Cmd+G otwiera i zamyka lazygita.
  /// Pasek jak w każdym oknie: „×” z lewej, „⋯” z prawej; „×” zamyka okno.
  @MainActor
  func testTerminalWindowOpensInDemo() throws {
    let app = try launch()
    for key in ["f", "g"] {
      openWindow(app, key: key)
      let popup = element(app, "terminal.popup")
      XCTAssertTrue(popup.waitForAppearance(timeout: 10), "okno Cmd+\(key)")
      settle(1)
      XCTAssertEqual(Set(windowBarButtons(app).map(\.identifier)), Self.barButtons, "Cmd+\(key): „×” i „⋯”")
      XCTAssertGreaterThan(element(app, "terminal.popup.menu").frame.midX, popup.frame.midX, "„⋯” z prawej")
      XCTAssertLessThan(element(app, "terminal.popup.close").frame.midX, popup.frame.midX, "„×” z lewej")
      closeWindow(app, key: key)
      XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "Cmd+\(key) zamyka okno")
    }
    openWindow(app, key: "f")
    XCTAssertTrue(element(app, "terminal.popup").waitForAppearance(timeout: 10), "okno powłoki znowu")
    settle(1)
    element(app, "terminal.popup.close").tap()
    XCTAssertTrue(element(app, "terminal.popup").waitForDisappearance(timeout: 5), "„×” zamyka okno")
  }

  /// Przyciski paska okna terminala: „×” i „⋯”.
  static let barButtons: Set<String> = ["terminal.popup.close", "terminal.popup.menu"]

  /// Historia z okna terminala: menu „⋯” → „Historia” pokazuje zmyślony tekst jako stronę okna, „wstecz” wraca.
  @MainActor
  func testHistoryOpensFromTerminalWindow() throws {
    let app = try launch()
    openWindow(app, key: "f")
    XCTAssertTrue(element(app, "terminal.popup").waitForAppearance(timeout: 10), "okno powłoki")
    XCTAssertTrue(openHistory(app), "„Historia” w menu „⋯” okna")
    XCTAssertTrue(element(app, "terminal.history.text").waitForAppearance(timeout: 10), "tekst historii")
    XCTAssertFalse(element(app, "terminal.history.close").exists, "strona historii nie ma przycisku zamknięcia okna")
    historyBack(app).tap()
    XCTAssertTrue(element(app, "terminal.history.text").waitForDisappearance(timeout: 5), "powrót z historii")
    XCTAssertTrue(element(app, "terminal.popup").waitForAppearance(timeout: 5), "okno terminala zostaje")
    closeWindow(app, key: "f")
    XCTAssertTrue(element(app, "terminal.popup").waitForDisappearance(timeout: 5), "Cmd+F zamyka okno po historii")
  }

  /// Okna na wspólnym szkielecie: „wstecz” historii stoi tam, gdzie zamknięcie diffa, a okna mają tę samą
  /// szerokość; okno terminala nie ma przycisku zamknięcia; Esc (sondą) zamyka historię
  /// i zostawia okno terminala; Cmd+W zamyka diff, a nie scenę apki; promień rogu arkusza z API systemu zgadza się
  /// z liczbą, z której apka liczy odstęp treści od rogu.
  @MainActor
  func testHistoryAndDiffShareWindowAnatomy() throws {
    guard isPad else { throw XCTSkip("wspólna szerokość okien dotyczy iPada — na telefonie arkusz ma rozmiar systemu") }
    let app = try launch(environment: ["RAROG_UI_TEST_PROBE": "1"])
    openWindow(app, key: "f")
    let terminal = element(app, "terminal.popup")
    XCTAssertTrue(terminal.waitForAppearance(timeout: 10), "okno powłoki")
    settle(1)
    let terminalWindow = terminal.frame
    let terminalScreen = element(app, "terminal.screen").frame
    let terminalMenu = element(app, "terminal.popup.menu").frame
    let terminalClose = element(app, "terminal.popup.close").frame
    XCTAssertEqual(Set(windowBarButtons(app).map(\.identifier)), Self.barButtons, "„×” i „⋯” w pasku")
    XCTAssertGreaterThan(terminalMenu.midX, terminalWindow.midX, "„⋯” stoi z prawej")
    // Terminal zaczyna się pod paskiem: żaden wiersz nie leży pod przyciskami paska.
    XCTAssertGreaterThanOrEqual(terminalScreen.minY, terminalMenu.maxY - 1, "terminal pod „⋯”")
    XCTAssertGreaterThanOrEqual(terminalScreen.minY, terminalClose.maxY - 1, "terminal pod „×”")
    // Tytuł „RODZAJ projekt” w pasku, jak w historii i diffie; czytnik słyszy rodzaj i projekt.
    let title = element(app, "terminal.popup.title")
    XCTAssertTrue(title.exists, "tytuł w pasku")
    XCTAssertTrue(title.label.hasPrefix("terminal: "), "rodzaj i projekt: \(title.label)")
    XCTAssertFalse(title.frame.intersects(terminalMenu), "nie przykrywa przycisku")
    XCTAssertEqual(title.frame.midY, terminalMenu.midY, accuracy: 2, "tytuł na wysokości przycisków paska")
    // Arkusz iPada ma promień 32 pt: dół siatki dotyka łuku rogu — ekran terminala stoi 5 pt nad
    // dolną krawędzią (32 − √(32² − 16²) = 4,3 w górę), a nie 12 pt jak treść historii i diffa.
    XCTAssertEqual(terminalWindow.maxY - terminalScreen.maxY, 5, accuracy: 1, "terminal przy łuku rogu")
    XCTAssertEqual(terminalScreen.minX - terminalWindow.minX, 8, accuracy: 1, "ekran terminala 8 pt od boku okna")
    XCTAssertTrue(openHistory(app), "„Historia” w menu „⋯” okna")
    XCTAssertTrue(element(app, "terminal.history.text").waitForAppearance(timeout: 10), "tekst historii")
    settle(1)
    // Historia jest stroną TEGO SAMEGO okna: jedna prezentacja, ta sama rama, „wstecz" tam, gdzie było zamknięcie.
    let onHistory = probe(app, "inspect")
    XCTAssertTrue(onHistory.contains("presented=[PresentationHostingController:sheet];"), "jeden arkusz")
    XCTAssertTrue(onHistory.hasPrefix("fr=HistoryTextView"), "tekst historii trzyma klawiaturę: \(onHistory.prefix(60))")
    let historyBack = historyBack(app).frame
    XCTAssertEqual(historyBack.midY, terminalMenu.midY, accuracy: 2, "„wstecz” na wysokości przycisków paska okna")
    XCTAssertTrue(probe(app, "escape").contains("sent=true"), "Esc ma odbiorcę na stronie historii")
    XCTAssertTrue(element(app, "terminal.history.text").waitForDisappearance(timeout: 5), "Esc wraca z historii")
    XCTAssertTrue(terminal.waitForAppearance(timeout: 5), "okno terminala zostaje")
    closeWindows(app)
    XCTAssertTrue(terminal.waitForDisappearance(timeout: 5), "Cmd+F zamyka okno terminala")

    try openDiffFromPopover(app)
    let diff = element(app, "diff.sheet")
    XCTAssertTrue(diff.waitForAppearance(timeout: 10), "okno diffa")
    settle(1)
    let diffClose = element(app, "diff.close").frame
    XCTAssertLessThan(diffClose.midX, diff.frame.midX, "zamknięcie diffa stoi z lewej")
    XCTAssertEqual(terminalWindow.width, diff.frame.width, accuracy: 1, "okno terminala ma szerokość diffa")
    // Systemowy „wstecz” jest o kilka punktów szerszy od przycisku zamknięcia (pomiar: 4 pt), stąd zapas.
    XCTAssertEqual(historyBack.midX, diffClose.midX, accuracy: 6, "„wstecz” historii tam, gdzie zamknięcie diffa")
    XCTAssertEqual(historyBack.midY, diffClose.midY, accuracy: 2, "i na tej samej wysokości")
    XCTAssertEqual(terminalMenu.midY, diffClose.midY, accuracy: 1, "przyciski paska okien na tej samej wysokości")
    XCTAssertEqual(terminalClose.midX, diffClose.midX, accuracy: 1, "„×” terminala tam, gdzie „×” diffa")
    XCTAssertEqual(terminalClose.midY, diffClose.midY, accuracy: 1, "i na tej samej wysokości")
    // `Radius.systemSheet` w RarogUI: z tej liczby treść okna liczy odstęp od łuku rogu.
    XCTAssertTrue(probe(app, "corners").contains("api-bottom=32.0;"), "promień arkusza iPada z API systemu")
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(diff.waitForDisappearance(timeout: 5), "Cmd+W zamyka diff")
    XCTAssertEqual(app.state, .runningForeground, "Cmd+W nie zamyka sceny apki")
  }

  /// Jeden arkusz naraz: diff z dymka gita zdejmuje dymek; Cmd+F nad diffem stawia okno terminala w jego
  /// miejsce; szybkie Cmd+G, Cmd+F zostawia jedno okno powłoki; formularz trzyma — Cmd+F nic nie stawia i po
  /// zamknięciu formularza nic nie wyskakuje samo (okno nie czeka „w kolejce” za formularzem).
  @MainActor
  func testOneSheetAtATime() throws {
    let app = try launch()
    let popup = element(app, "terminal.popup")
    let diff = element(app, "diff.sheet")
    let panel = element(app, "header.git.panel")

    try openDiffFromPopover(app)
    XCTAssertTrue(diff.waitForAppearance(timeout: 10), "okno diffa")
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "dymek gita schodzi, gdy staje okno")

    // Pierwszy skrót po starcie apki symulator czasem gubi; ponowienie tylko wtedy, gdy okno nie stanęło.
    for _ in 0..<3 where !popup.exists {
      app.typeKey("f", modifierFlags: .command)
      _ = popup.waitForAppearance(timeout: 5)
    }
    XCTAssertTrue(popup.exists, "Cmd+F nad diffem stawia okno terminala")
    XCTAssertTrue(diff.waitForDisappearance(timeout: 5), "diff schodzi — stoi jedno okno")

    app.typeKey("g", modifierFlags: .command)
    app.typeKey("f", modifierFlags: .command)
    settle(3)
    let windows = app.descendants(matching: .any).matching(identifier: "terminal.popup")
    XCTAssertEqual(windows.count, 1, "po Cmd+G, Cmd+F stoi jedno okno")
    XCTAssertTrue(element(app, "terminal.popup.title").label.hasPrefix("terminal: "), "i jest to okno powłoki")
    closeWindow(app, key: "f")
    XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "okno zamknięte")
    settle(1.5)
    XCTAssertFalse(diff.exists || panel.exists, "pod oknem nic nie zostało")

    guard isPad else { throw XCTSkip("„Nowa sesja” w pasku listy niedostępna (telefon: lista pod szczegółem)") }
    // Jeden element „Nowa sesja” i to klikalny: kotwica podpowiedzi skrótu nie niesie identyfikatora przycisku.
    let newSession = element(app, "list.newSession")
    XCTAssertTrue(newSession.waitForAppearance(timeout: 5) && newSession.isHittable, "„Nowa sesja” w pasku listy")
    XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "list.newSession").count, 1,
                   "jeden element o identyfikatorze „Nowej sesji”")
    newSession.tap()
    let form = element(app, "newSession.sheet")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "formularz „Nowa sesja”")
    app.typeKey("f", modifierFlags: .command)
    settle(2.5)
    XCTAssertTrue(form.exists, "formularz trzyma")
    XCTAssertFalse(popup.exists, "Cmd+F nad formularzem nic nie stawia")
    element(app, "newSession.cancel").tap()
    XCTAssertTrue(form.waitForDisappearance(timeout: 5), "formularz zamknięty")
    settle(3)
    XCTAssertFalse(popup.exists, "okno nie czekało w kolejce za formularzem")
  }

  /// Klawiatura przy arkuszach: pod formularzem i diffem litery nie trafiają
  /// do pola wiadomości, a po zamknięciu każdego arkusza — także okna terminala, które bierze klawiaturę dla
  /// siebie — pisze się w polu od razu, bez stukania w nie. To zachowanie systemu, na którym apka polega: test
  /// pilnuje, żeby zmiany okien go nie zepsuły. The session needs an active field (`demo-willow` waits for
  /// a permission, so it has no field). It runs on `demo-rarog-stop` (same project, branch and three
  /// changed files as `demo-rarog`, but no endless delta stream), the pattern `ToastUITests` uses. This is a
  /// precaution, not a fix of a known cause: in the full iOS gate this test hit the 300 s limit on 60 s waits for
  /// the app to go idle, with no failed assertion, and the streaming seed is only a suspect. Recent Sessions is not
  /// covered: its clock stands in the list, and a tap in the list takes the keyboard from the field.
  @MainActor
  func testComposerKeepsKeyboardAroundSheets() throws {
    guard isPad else { throw XCTSkip("„Nowa sesja” obok sesji i okna nad nią: iPad") }
    let app = try launch(environment: ["RAROG_UI_TEST_PROBE": "1"], session: "demo-rarog-stop")
    let field = app.textViews["composer.field"]
    func holdsKeyboard() -> Bool { probe(app, "inspect").hasPrefix("fr=ComposerTextView") }
    func typed() -> String { ((field.value as? String) ?? "").lowercased() }
    field.tap()
    settle(1)
    XCTAssertTrue(holdsKeyboard(), "pole trzyma klawiaturę przed arkuszem")

    element(app, "list.newSession").tap()
    let form = element(app, "newSession.sheet")
    XCTAssertTrue(form.waitForAppearance(timeout: 10), "formularz")
    settle(1)
    app.typeKey("a", modifierFlags: [])
    // Formularz stoi na wspólnym szkielecie: Cmd+W zamyka formularz, nie scenę apki, choć przed nim klawiaturę
    // trzymało pole wiadomości (formularz bierze ją na czas pokazania).
    XCTAssertLessThan(element(app, "newSession.cancel").frame.midX, form.frame.midX, "zamknięcie formularza z lewej")
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(form.waitForDisappearance(timeout: 5), "Cmd+W zamyka formularz")
    XCTAssertEqual(app.state, .runningForeground, "Cmd+W nie zamyka sceny apki")
    settle(1.5)
    XCTAssertTrue(holdsKeyboard(), "po formularzu klawiatura jest w polu")
    app.typeKey("b", modifierFlags: [])
    settle(0.7)
    XCTAssertEqual(typed(), "b", "litera spod formularza nie trafia do pola, litera po zamknięciu trafia")

    try openDiffFromPopover(app)
    let diff = element(app, "diff.sheet")
    XCTAssertTrue(diff.waitForAppearance(timeout: 10), "okno diffa")
    settle(1)
    app.typeKey("d", modifierFlags: [])
    // Cmd+W przy klawiaturze, którą przed oknem trzymało pole wiadomości: zamyka okno, nie scenę apki.
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(diff.waitForDisappearance(timeout: 5), "Cmd+W zamyka diff")
    XCTAssertEqual(app.state, .runningForeground, "Cmd+W nie zamyka sceny apki")
    settle(1.5)
    XCTAssertTrue(holdsKeyboard(), "po diffie klawiatura jest w polu")

    let popup = element(app, "terminal.popup")
    for _ in 0..<3 where !popup.exists {
      app.typeKey("f", modifierFlags: .command)
      _ = popup.waitForAppearance(timeout: 5)
    }
    XCTAssertTrue(popup.exists, "okno terminala")
    closeWindow(app, key: "f")
    XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "okno terminala zamknięte skrótem")
    settle(1.5)
    XCTAssertTrue(holdsKeyboard(), "po oknie terminala klawiatura wraca do pola")
    app.typeKey("g", modifierFlags: [])
    settle(0.7)
    XCTAssertEqual(typed(), "bg", "do pola trafiły tylko litery wpisane bez arkusza")
  }

  /// Dymki: dymek gita jest tak wysoki jak treść (trzy pliki nie zostawiają pustego pasa pod listą), „Pokaż
  /// diff” stoi w stopce i otwiera okno; przycisku zamknięcia dymek nie ma ani na iPadzie, ani na telefonie, gdzie
  /// jest arkuszem z tytułem i uchwytem — zamyka go przeciągnięcie w dół od uchwytu.
  /// Pliki w dymku przychodzą ramką `git-status` (dymek diffa nie pobiera), której sesja demo z seeda nie
  /// dostaje przy wejściu — stąd sesja odbioru i ramka wysłana przez test. Telefon dymka gita nie ma:
  /// linia otwiera tam panel sesji w arkuszu z tym samym paskiem, uchwytem i gestem zamknięcia.
  @MainActor
  func testPopoverFitsContentAndClosesOnPhone() async throws {
    let control = DemoControl(port: try DemoServer.requirePort())
    try await control.reset()
    let id = try await control.create("idle", label: "M1 dymek")
    let app = try launch(session: id)
    let git = element(app, "header.git")
    try await control.emitGitStatus(sessionId: id) { git.exists }
    DemoServer.hideKeyboard(app)
    git.tap()
    if !isPad {
      try phoneInspectorSheet(app)
      app.terminate()
      try await control.reset()
      return
    }
    let panel = element(app, "header.git.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "dymek gita")
    let files = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'header.git.file.'"))
    XCTAssertTrue(files.firstMatch.waitForAppearance(timeout: 10), "pliki w dymku")
    let footer = element(app, "header.git.diff")
    XCTAssertTrue(footer.waitForAppearance(timeout: 5), "„Pokaż diff” w stopce")
    settle(1)
    // Zrzut tylko na życzenie (`RAROG_SCREENSHOT_DIR`): dymek iPada albo arkusz telefonu.
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil { try shot(app, "dymek-git") }
    XCTAssertFalse(element(app, "popover.close").exists, "dymek bez przycisku zamknięcia")
    XCTAssertLessThan(panel.frame.height, 340, "dymek tak wysoki jak treść: \(panel.frame.height)")
    XCTAssertEqual(footer.frame.maxY, panel.frame.maxY, accuracy: 2, "stopka zamyka dymek")
    footer.tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForAppearance(timeout: 10), "stopka otwiera okno diffa")
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "dymek schodzi")
    element(app, "diff.close").tap()
    XCTAssertTrue(element(app, "diff.sheet").waitForDisappearance(timeout: 5), "diff zamknięty")
    app.terminate()
    try await control.reset()
  }

  /// Telefon po tapnięciu linii gita: panel sesji w arkuszu przewinięty do zmian w katalogu, bez dymka gita; pasek
  /// z tytułem bez „×”, systemowy uchwyt u góry, przeciągnięcie od niego zamyka
  /// arkusz. Tytuł z `UICopy.inspectorSheetTitle`.
  @MainActor
  private func phoneInspectorSheet(_ app: XCUIApplication) throws {
    let panel = element(app, "inspector.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "panel sesji w arkuszu")
    XCTAssertFalse(element(app, "header.git.panel").exists, "telefon nie ma dymka gita")
    let files = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'inspector.git.file.'"))
    XCTAssertTrue(files.firstMatch.waitForAppearance(timeout: 10), "pliki w panelu")
    XCTAssertTrue(element(app, "inspector.git.title").isHittable, "kotwica na zmianach w katalogu")
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil { try shot(app, "arkusz-panelu") }
    // A tap on an existing file: the preview stands over the sheet, and closing it returns to the panel.
    let file = element(app, "inspector.git.file.src/notes.ts")
    XCTAssertTrue(file.waitForAppearance(timeout: 10), "an existing file in the sheet")
    file.tap()
    let close = element(app, "QLOverlayDoneButtonAccessibilityIdentifier")
    XCTAssertTrue(close.waitForAppearance(timeout: 10), "the file preview over the sheet")
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil { settle(1.5); try shot(app, "podglad-arkusz") }
    close.tap()
    XCTAssertTrue(close.waitForDisappearance(timeout: 5), "the file preview closed")
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "closing the preview returns to the panel sheet")
    let bar = app.navigationBars["Panel sesji"]
    XCTAssertTrue(bar.waitForAppearance(timeout: 5), "tytuł panelu w pasku arkusza")
    let barButtons = bar.buttons.allElementsBoundByIndex
    XCTAssertTrue(barButtons.isEmpty, "pasek arkusza bez przycisków: \(barButtons.map(\.label))")
    let grabber = sheetGrabber(app)
    XCTAssertTrue(grabber.waitForAppearance(timeout: 5), "uchwyt arkusza")
    let start = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 500)))
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "przeciągnięcie od uchwytu zamyka arkusz")
  }

  /// iPhone: okno terminala nie ma przycisku zamknięcia, a zamyka je
  /// przeciągnięcie w dół od systemowego uchwytu na środku u góry albo od pustego paska pod nim. Przeciągnięcie
  /// w treści terminala okna nie zamyka. Zamknięte gestem okno zwalnia stan nawigacji: ikona otwiera je od nowa.
  /// Bez sondy: jej przyciski stoją u góry na środku, nad uchwytem.
  @MainActor
  func testGrabberDragClosesWindowOnPhone() throws {
    guard !isPad else { throw XCTSkip("uchwyt okna terminala jest tylko na telefonie (na iPadzie zamyka tap obok)") }
    let app = try launch(environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    let popup = element(app, "terminal.popup")
    func open() {
      let icon = element(app, "header.terminalPopup")
      XCTAssertTrue(icon.waitForAppearance(timeout: 5), "ikona „Terminal w oknie” w pasku sesji")
      icon.tap()
      XCTAssertTrue(popup.waitForAppearance(timeout: 10), "okno powłoki")
      settle(1.5)
    }
    func drag(from point: XCUICoordinate, by distance: CGFloat) {
      point.press(forDuration: 0.05, thenDragTo: point.withOffset(CGVector(dx: 0, dy: distance)))
      settle(1.5)
    }
    open()
    XCTAssertEqual(Set(windowBarButtons(app).map(\.identifier)), Self.barButtons, "„×” obok uchwytu")
    let grabber = sheetGrabber(app)
    XCTAssertTrue(grabber.waitForAppearance(timeout: 5), "uchwyt arkusza")
    XCTAssertEqual(grabber.frame.midX, popup.frame.midX, accuracy: 2, "uchwyt na środku")
    XCTAssertLessThan(grabber.frame.midY, popup.frame.minY + 20, "uchwyt u góry okna: \(grabber.frame)")

    let content = popup.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
    drag(from: content, by: 300)
    XCTAssertTrue(popup.exists, "przeciągnięcie w treści terminala nie zamyka okna")

    drag(from: grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), by: 450)
    XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "przeciągnięcie od uchwytu zamyka okno")
    // `demo-willow` czeka na zgodę, więc pola wiadomości nie ma: ekran sesji poznać po ikonie okna.
    let sessionIcon = element(app, "header.terminalPopup")
    XCTAssertTrue(sessionIcon.waitForAppearance(timeout: 5) && sessionIcon.isHittable, "pod oknem ekran sesji")

    // Pusty pasek pod uchwytem nie oddaje dotyku terminalowi: przeciągnięcie z niego też zamyka okno.
    open()
    let bar = app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: popup.frame.midX - 40, dy: popup.frame.minY + 40))
    drag(from: bar, by: 450)
    XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "przeciągnięcie z pustego paska zamyka okno")
  }

  /// Gest „wstecz” czytnika (VoiceOver) zamyka okno terminala i dymek, choć żadne z nich nie ma przycisku zamknięcia.
  /// Symulator VoiceOver nie ma, więc gest wykonuje sonda (`probe.axescape`): od elementu
  /// w treści albo w pasku w górę, jak UIKit. Pomiar (iPhone 17 Pro, iOS 27.0): z treści terminala gest
  /// bierze kontroler okna, z paska — kontener nawigacji, w dymku — kontener prezentacji systemu (`UITransitionView`).
  /// Po każdym zamknięciu stan nawigacji jest czysty: okno otwiera się od nowa.
  @MainActor
  func testAccessibilityEscapeClosesWindowAndPopover() async throws {
    let control = DemoControl(port: try DemoServer.requirePort())
    try await control.reset()
    let id = try await control.create("idle", label: "M1 dymek")
    let app = try launch(environment: ["RAROG_UI_TEST_PROBE": "1"], session: id)
    let popup = element(app, "terminal.popup")
    // Okno z ikony „Terminal w oknie” w pasku sesji: ta sama droga na iPadzie i na telefonie.
    let icon = element(app, "header.terminalPopup")
    for action in ["axescape", "axescapebar"] {
      XCTAssertTrue(icon.waitForAppearance(timeout: 5), "\(action): ikona „Terminal w oknie”")
      icon.tap()
      XCTAssertTrue(popup.waitForAppearance(timeout: 10), "\(action): okno powłoki")
      settle(1.5)
      let result = probe(app, action)
      XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "\(action): gest zamyka okno terminala (\(result))")
      XCTAssertTrue(probe(app, "inspect").contains("presented=[]"), "\(action): nic nie zostało nad ekranem")
    }
    icon.tap()
    XCTAssertTrue(popup.waitForAppearance(timeout: 10), "okno otwiera się od nowa: stan nawigacji czysty")
    XCTAssertTrue(probe(app, "axescape").hasPrefix("axesc="), "sonda")
    XCTAssertTrue(popup.waitForDisappearance(timeout: 5))

    let git = element(app, "header.git")
    try await control.emitGitStatus(sessionId: id) { git.exists }
    // Telefon: linia gita otwiera panel sesji jako arkusz, ten sam kontener co dymek.
    let panel = element(app, isPad ? "header.git.panel" : "inspector.panel")
    for action in ["axescape", "axescapebar"] where isPad == false || action == "axescape" {
      DemoServer.hideKeyboard(app)
      git.tap()
      XCTAssertTrue(panel.waitForAppearance(timeout: 5), "\(action): dymek gita albo arkusz panelu")
      settle(1.5)
      let result = probe(app, action)
      XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "\(action): gest zamyka dymek (\(result))")
    }
    app.terminate()
    try await control.reset()
  }

  /// iPhone w poziomie bez klawiatury sprzętowej (bez „×” nie byłoby dotykowej drogi
  /// odpięcia). System stawia wtedy okno na cały ekran, bez uchwytu, ale przeciągnięcie w dół od pustego paska dalej
  /// je zamyka (pasek na telefonie dotyku terminalowi nie oddaje), a w treści — nie. Pomiar (iPhone 17 Pro,
  /// iOS 27.0) tak samo dla okna otwartego w pionie i obróconego oraz otwartego od razu w poziomie. Dymek w poziomie
  /// zostaje arkuszem z uchwytem i też schodzi gestem. Gest startuje poniżej górnej krawędzi: przeciągnięcie od samej
  /// krawędzi łapie system (Centrum powiadomień) i psuje kolejne gesty testu.
  @MainActor
  func testLandscapeDragClosesWindowOnPhone() async throws {
    guard !isPad else { throw XCTSkip("poziom bez uchwytu dotyczy telefonu") }
    let control = DemoControl(port: try DemoServer.requirePort())
    try await control.reset()
    let id = try await control.create("idle", label: "M1 dymek")
    let app = try launch(environment: ["RAROG_UI_TEST_NO_HW_KEYBOARD": "1"], session: id)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle(2)
    let popup = element(app, "terminal.popup")
    let icon = element(app, "header.terminalPopup")
    func drag(_ x: CGFloat, _ y: CGFloat) {
      let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
      point.press(forDuration: 0.05, thenDragTo: point.withOffset(CGVector(dx: 0, dy: 300)))
      settle(1.5)
    }
    for round in ["pierwsze otwarcie", "ponowne otwarcie"] {
      XCTAssertTrue(icon.waitForAppearance(timeout: 5), "\(round): ikona „Terminal w oknie”")
      icon.tap()
      XCTAssertTrue(popup.waitForAppearance(timeout: 10), "\(round): okno powłoki")
      settle(1.5)
      XCTAssertTrue(element(app, "terminal.key.esc").exists, "\(round): bez klawiatury sprzętowej, z paskiem klawiszy")
      let frame = popup.frame
      drag(frame.midX, frame.minY + 150)
      XCTAssertTrue(popup.exists, "\(round): przeciągnięcie w treści terminala nie zamyka okna")
      drag(frame.midX - 60, frame.minY + 30)
      XCTAssertTrue(popup.waitForDisappearance(timeout: 5), "\(round): przeciągnięcie z pustego paska zamyka okno")
    }

    // Linia gita na telefonie otwiera panel sesji w kontenerze dymku.
    let git = element(app, "header.git")
    try await control.emitGitStatus(sessionId: id) { git.exists }
    let panel = element(app, "inspector.panel")
    git.tap()
    XCTAssertTrue(panel.waitForAppearance(timeout: 5), "panel sesji w poziomie")
    settle(1.5)
    XCTAssertTrue(sheetGrabber(app).exists, "panel w poziomie zostaje arkuszem z uchwytem")
    drag(panel.frame.midX, panel.frame.minY + 30)
    XCTAssertTrue(panel.waitForDisappearance(timeout: 5), "przeciągnięcie zamyka arkusz panelu w poziomie")
    app.terminate()
    try await control.reset()
  }

  // MARK: - Zrzuty

  @MainActor
  func testCaptureDark() throws { try capture(theme: "dark") }

  @MainActor
  func testCaptureLight() throws { try capture(theme: "light") }

  @MainActor
  private func capture(theme: String) throws {
    _ = try screenshotDirectory()
    let app = try launch(environment: ["RAROG_UI_TEST_THEME": theme])
    openWindow(app, key: "f")
    guard element(app, "terminal.popup").waitForAppearance(timeout: 10) else { return XCTFail("okno powłoki") }
    settle(2)
    try shot(app, "okno-terminal-\(theme)")
    openHistory(app)
    if element(app, "terminal.history.text").waitForAppearance(timeout: 10) {
      settle(1.5)
      try shot(app, "okno-historia-\(theme)")
    } else {
      XCTFail("historia")
    }
    // Okno lazygita: program pełnoekranowy ze szwu — pas wokół siatki w kolorze jej krawędzi. Bez klawiatury
    // sprzętowej terminal nie bierze fokusu, więc klawiatura ekranowa nie zmienia siatki po narysowaniu programu
    // (zmyślony program nie rysuje się od nowa po zmianie rozmiaru) i dolny pasek statusu stoi nad paskiem klawiszy.
    let program = try launch(environment: ["RAROG_UI_TEST_THEME": theme, "RAROG_UI_TEST_NO_HW_KEYBOARD": "1"])
    openWindow(program, key: "g")
    guard element(program, "terminal.popup").waitForAppearance(timeout: 10) else { return XCTFail("okno lazygita") }
    settle(2)
    try shot(program, "okno-program-\(theme)")
  }

  // MARK: - Pomiary okien

  /// Pomiary okien: zderzenia skrótu okna z diffem, formularzem i dymkami; kto trzyma klawiaturę
  /// pod prezentacją; promień rogu z API; Esc łańcuchem respondentów; Cmd+W i przeciągnięcie po terminalu.
  /// Wynik: `pomiary-<urządzenie>.txt` w `RAROG_SCREENSHOT_DIR`. Niczego nie zakłada — tylko zapisuje.
  @MainActor
  func testMeasure() throws {
    let directory = try screenshotDirectory()
    guard ProcessInfo.processInfo.environment["RAROG_E0_MEASURE"] == "1" else {
      throw XCTSkip("pomiary okien tylko z RAROG_E0_MEASURE=1")
    }
    var log: [String] = ["urządzenie: \(UIDevice.current.name), iOS \(UIDevice.current.systemVersion)"]
    func note(_ line: String) {
      log.append(line)
      try? log.joined(separator: "\n").write(
        to: directory.appending(path: "pomiary-\(isPad ? "ipad" : "iphone").txt"), atomically: true, encoding: .utf8)
    }
    let app = try launch(environment: ["RAROG_UI_TEST_PROBE": "1"])
    note("--- start: \(probe(app, "inspect"))")

    // Okno powłoki: fokus, rogi, przeciągnięcie po treści, Esc sondy.
    openWindow(app, key: "f")
    if element(app, "terminal.popup").waitForAppearance(timeout: 10) {
      settle(1.5)
      note("okno powłoki: \(probe(app, "inspect"))")
      note("okno powłoki rogi: \(probe(app, "corners"))")
      let popup = element(app, "terminal.popup")
      let middle = popup.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: 260)))
      settle(1)
      note("okno powłoki po przeciągnięciu palcem po treści: stoi=\(popup.exists)")
      if popup.exists {
        note("okno powłoki Esc sondy: \(probe(app, "escape"))")
        settle(1)
        note("okno powłoki po Esc: stoi=\(element(app, "terminal.popup").exists)")
      }
    } else {
      note("okno powłoki: NIE otwarte")
    }
    closeWindows(app)

    // Okno lazygita: Esc ma pójść do programu (okno zostaje).
    openWindow(app, key: "g")
    if element(app, "terminal.popup").waitForAppearance(timeout: 10) {
      settle(1)
      note("lazygit Esc sondy: \(probe(app, "escape"))")
      settle(1)
      note("lazygit po Esc: stoi=\(element(app, "terminal.popup").exists)")
      // Historia nad oknem: kto trzyma klawiaturę, Esc. Okno mogło zejść po Esc sondy — wtedy od nowa.
      if !element(app, "terminal.popup").exists {
        openWindow(app, key: "g")
        _ = element(app, "terminal.popup").waitForAppearance(timeout: 10)
        settle(1)
      }
      if openHistory(app), element(app, "terminal.history.text").waitForAppearance(timeout: 10) {
        settle(1.5)
        note("historia nad oknem: \(probe(app, "inspect"))")
        note("historia nad oknem Esc sondy: \(probe(app, "escape"))")
        settle(1)
        note(
          "po Esc: historia=\(element(app, "terminal.history.text").exists) okno=\(element(app, "terminal.popup").exists)")
      }
    }
    closeWindows(app, key: "g")

    // Fokus w polu wiadomości, jak przy pracy z klawiaturą: pod prezentacjami sprawdzamy, dokąd idą litery.
    let field = app.textViews["composer.field"]
    if field.exists, field.isHittable {
      field.tap()
      settle(1)
    }
    note("pole wiadomości z fokusem: \(probe(app, "inspect"))")

    // Dymek gita.
    let git = element(app, "header.git")
    let panel = element(app, "header.git.panel")
    let showDiff = element(app, "header.git.diff")
    if git.waitForAppearance(timeout: 10) {
      git.tap()
      if panel.waitForAppearance(timeout: 5) {
        settle(1)
        note("dymek gita: \(probe(app, "inspect"))")
        note("dymek gita rogi: \(probe(app, "corners"))")
        note("dymek gita ramka: \(rect(panel.frame))")
        app.typeKey("x", modifierFlags: [])
        settle(0.5)
        note("dymek gita po literze x: pole=\(fieldValue(app))")
        app.typeKey("f", modifierFlags: .command)
        settle(2.5)
        note(
          "Cmd+F przy dymku gita: okno=\(element(app, "terminal.popup").exists) dymek=\(panel.exists) \(probe(app, "inspect"))")
        closeWindows(app)
        if panel.exists { dismissOutside(app) }
        settle(1.5)
        note("po zamknięciu dymka: okno=\(element(app, "terminal.popup").exists) \(probe(app, "inspect"))")
        closeWindows(app)
      } else {
        note("dymek gita: NIE otwarty")
      }
      // Diff z dymka (arkusz nad dymkiem), ze stopki „Pokaż diff".
      if !panel.exists { git.tap() }
      if panel.waitForAppearance(timeout: 5), showDiff.waitForAppearance(timeout: 10) {
        showDiff.tap()
        let diff = element(app, "diff.sheet")
        if diff.waitForAppearance(timeout: 10) {
          settle(1.5)
          note("diff: \(probe(app, "inspect"))")
          note("diff rogi: \(probe(app, "corners"))")
          note("diff przycisk zamknięcia: \(rect(element(app, "diff.close").frame))")
          app.typeKey("y", modifierFlags: [])
          settle(0.5)
          note("diff po literze y: pole=\(fieldValue(app))")
          app.typeKey("f", modifierFlags: .command)
          settle(2.5)
          note("Cmd+F przy diffie: okno=\(element(app, "terminal.popup").exists) diff=\(diff.exists)")
          if diff.exists {
            note("diff Esc sondy: \(probe(app, "escape"))")
            settle(1.5)
            note(
              "po Esc: diff=\(diff.exists) dymek=\(panel.exists) okno=\(element(app, "terminal.popup").exists) \(probe(app, "inspect"))")
          }
          if diff.exists { element(app, "diff.close").tap() }
          settle(2)
          note(
            "po zamknięciu diffa: okno=\(element(app, "terminal.popup").exists) dymek=\(panel.exists) \(probe(app, "inspect"))")
          closeWindows(app)
          if panel.exists { dismissOutside(app) }
          settle(1.5)
          note("po zamknięciu dymka: okno=\(element(app, "terminal.popup").exists) \(probe(app, "inspect"))")
          closeWindows(app)
        } else {
          note("diff: NIE otwarty")
        }
      }
    } else {
      note("linia gita: brak")
    }

    // Formularz „Nowa sesja”.
    let newSession = element(app, "list.newSession")
    if newSession.waitForAppearance(timeout: 5), newSession.isHittable {
      newSession.tap()
      let sheet = element(app, "newSession.sheet")
      if sheet.waitForAppearance(timeout: 10) {
        settle(1.5)
        note("formularz: \(probe(app, "inspect"))")
        note("formularz rogi: \(probe(app, "corners"))")
        note("formularz przycisk Anuluj: \(rect(element(app, "newSession.cancel").frame))")
        app.typeKey("f", modifierFlags: .command)
        settle(2.5)
        note("Cmd+F przy formularzu: okno=\(element(app, "terminal.popup").exists) formularz=\(sheet.exists)")
        note("formularz Esc sondy: \(probe(app, "escape"))")
        settle(1.5)
        note("po Esc: formularz=\(sheet.exists) okno=\(element(app, "terminal.popup").exists)")
        if sheet.exists { element(app, "newSession.cancel").tap() }
        settle(2.5)
        note("po zamknięciu formularza: okno=\(element(app, "terminal.popup").exists) \(probe(app, "inspect"))")
        closeWindows(app)
      }
    } else {
      note("„Nowa sesja” w pasku listy: niedostępna")
    }

    // Dymek modelu.
    let model = element(app, "composer.model")
    if model.waitForAppearance(timeout: 5), model.isHittable {
      model.tap()
      let sheet = element(app, "model.sheet")
      if sheet.waitForAppearance(timeout: 10) {
        settle(1)
        note("dymek modelu: \(probe(app, "inspect")) ramka=\(rect(sheet.frame))")
        note("dymek modelu Esc sondy: \(probe(app, "escape"))")
        settle(1.5)
        note("po Esc: dymek=\(sheet.exists) \(probe(app, "inspect"))")
        if sheet.exists { dismissOutside(app) }
        settle(1)
      }
    } else {
      note("pigułka modelu: niedostępna")
    }
    // Cmd+W przy otwartym diffie — na samym końcu, bo zamknięcie sceny kończy pomiary.
    if git.exists {
      if !panel.exists { git.tap() }
      if panel.waitForAppearance(timeout: 5), showDiff.waitForAppearance(timeout: 10) {
        showDiff.tap()
        if element(app, "diff.sheet").waitForAppearance(timeout: 10) {
          settle(1)
          app.typeKey("w", modifierFlags: .command)
          settle(2)
          note(
            "Cmd+W przy diffie: diff=\(element(app, "diff.sheet").exists) stan apki=\(app.state.rawValue) (4 = na wierzchu)")
          if app.state != .runningForeground { app.activate() }
          settle(1)
          if element(app, "diff.sheet").exists { element(app, "diff.close").tap() }
          settle(1)
          if panel.exists { dismissOutside(app) }
          settle(1)
        }
      }
    }
    note("--- koniec: \(probe(app, "inspect"))")
  }

  // MARK: - Pomocnicze

  /// Apka zalogowana, z otwartą sesją. Sesji odbioru (zakładanej przez test) bywa nie widać na liście — wtedy
  /// wejście idzie przez nagłówek projektu „rarog" w drzewie i jej zakładkę. `demo-willow` czeka na zgodę, więc
  /// pole wiadomości jest w niej schowane: wejście potwierdza zaznaczona zakładka sesji.
  @MainActor
  private func launch(environment: [String: String] = [:], session: String = "demo-willow") throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    var merged = ["RAROG_UI_TEST_FAKE_TERMINAL": "1"]
    merged.merge(environment) { $1 }
    let app = DemoServer.launch(port: port, environment: merged)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    DemoServer.openRow(app, session, project: "rarog")
    if session == "demo-willow" {
      let tab = element(app, "tab.\(session)")
      let selected = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "exists == true AND selected == true"), object: tab)
      XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 15), .completed, "sesja otwarta")
    } else {
      XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15), "sesja otwarta")
    }
    DemoServer.hideKeyboard(app)
    return app
  }

  /// Cmd+F albo Cmd+G. Strzałka przed skrótem budzi obsługę klawiatury sprzętowej w symulatorze. Pierwszy skrót
  /// po starcie apki bywa zgubiony (iOS 26.2: 2 z 5 prób), więc skrót idzie ponownie, gdy okno nie stanęło — nigdy
  /// przy stojącym oknie, bo ten sam skrót je zamyka.
  @MainActor
  private func openWindow(_ app: XCUIApplication, key: String) {
    for _ in 0..<3 {
      app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
      app.typeKey(key, modifierFlags: .command)
      if element(app, "terminal.popup").waitForAppearance(timeout: 4) { return }
    }
  }

  /// Okno diffa z dymka gita, ze stopki „Pokaż diff". Wierszy plików w dymku sesji demo z seeda nie ma: przychodzą
  /// ramką `git-status`, której demo nie wysyła przy wejściu w sesję; okno i tak pobiera listę samo.
  @MainActor
  private func openDiffFromPopover(_ app: XCUIApplication) throws {
    // „Pokaż diff” stoi w dymku gita, a ten jest tylko na iPadzie: na telefonie linia
    // otwiera panel sesji, w którym diff otwiera stuknięty plik.
    guard isPad else { throw XCTSkip("telefon: dymka gita z „Pokaż diff” nie ma") }
    let git = element(app, "header.git")
    XCTAssertTrue(git.waitForAppearance(timeout: 10), "linia gita")
    git.tap()
    let footer = element(app, "header.git.diff")
    XCTAssertTrue(footer.waitForAppearance(timeout: 10), "„Pokaż diff” w stopce dymka gita")
    footer.tap()
  }

  /// „Historia” z menu „⋯” okna; `false`, gdy okna albo pozycji nie ma (pomiary idą wtedy dalej).
  @MainActor
  @discardableResult
  private func openHistory(_ app: XCUIApplication) -> Bool {
    let menu = element(app, "terminal.popup.menu")
    guard menu.waitForAppearance(timeout: 5) else { return false }
    menu.tap()
    let item = app.buttons["Historia"].firstMatch
    guard item.waitForAppearance(timeout: 5) else { return false }
    item.tap()
    return true
  }

  /// Systemowy „wstecz" strony historii w oknie terminala: pierwszy przycisk paska OKNA, czyli tego, w którym
  /// stoi kopiowanie historii. iOS 26.2 zostawia w drzewie także pasek ekranu pod arkuszem i podaje go pierwszy
  /// (zamiast „wstecz” wychodzi przycisk listy), iOS 27 go nie podaje.
  @MainActor
  private func historyBack(_ app: XCUIApplication) -> XCUIElement {
    app.navigationBars.containing(.any, identifier: "terminal.history.copy").buttons.element(boundBy: 0)
  }

  /// Wraca ze strony historii i zamyka okno terminala, jeśli stoją: skrótem okna (`key`: „f” powłoka, „g” lazygit),
  /// bo przycisku zamknięcia okno nie ma.
  @MainActor
  private func closeWindows(_ app: XCUIApplication, key: String = "f") {
    if element(app, "terminal.history.text").exists {
      historyBack(app).tap()
      _ = element(app, "terminal.history.text").waitForDisappearance(timeout: 5)
      settle(0.5)
    }
    if element(app, "terminal.popup").exists {
      closeWindow(app, key: key)
      _ = element(app, "terminal.popup").waitForDisappearance(timeout: 5)
      settle(1)
    }
  }

  /// Zamknięcie okna terminala tym samym skrótem, który je otworzył. Strzałka przed skrótem budzi obsługę klawiatury
  /// sprzętowej w symulatorze (jak w ``openWindow(_:key:)``); w oknie powłoki idzie do terminala jako jałowy ruch.
  @MainActor
  private func closeWindow(_ app: XCUIApplication, key: String) {
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
    app.typeKey(key, modifierFlags: .command)
  }

  /// Systemowy uchwyt arkusza (etykieta systemu: po polsku albo po angielsku, zależnie od języka symulatora).
  @MainActor
  private func sheetGrabber(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Uchwyt arkusza", "Sheet Grabber"])).firstMatch
  }

  /// Przyciski paska okna terminala (pasek, w którym stoi „⋯” okna); systemowy „×” bywa w drzewie dwa razy (przycisk
  /// i jego wnętrze), więc testy porównują zbiór identyfikatorów.
  @MainActor
  private func windowBarButtons(_ app: XCUIApplication) -> [XCUIElement] {
    app.navigationBars.containing(.any, identifier: "terminal.popup.menu").buttons.allElementsBoundByIndex
  }

  /// Tap obok prezentacji (prawa krawędź pod nagłówkiem): zamyka dymek, a system nie oddaje go widokowi pod spodem.
  @MainActor
  private func dismissOutside(_ app: XCUIApplication) {
    let screen = app.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: screen.width - 24, dy: 150)).tap()
  }

  @MainActor
  private func probe(_ app: XCUIApplication, _ action: String) -> String {
    let button = element(app, "probe.\(action)")
    guard button.waitForAppearance(timeout: 3) else { return "sonda: brak przycisku \(action)" }
    button.tap()
    settle(0.3)
    return (element(app, "probe.state").value as? String) ?? "sonda: brak stanu"
  }

  @MainActor
  private func fieldValue(_ app: XCUIApplication) -> String {
    let field = app.textViews["composer.field"]
    guard field.exists else { return "brak pola" }
    return "„\((field.value as? String) ?? "")”"
  }

  private func rect(_ frame: CGRect) -> String {
    "x=\(Int(frame.minX)) y=\(Int(frame.minY)) w=\(Int(frame.width)) h=\(Int(frame.height))"
  }

  private func screenshotDirectory() throws -> URL {
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty i pomiary robi się ręcznie, poza bramką")
    }
    return URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    let file = try screenshotDirectory().appending(path: "\(name).png")
    // Zrzut z poprzedniego przebiegu udawałby odpowiedź: test szedłby dalej, a strona Maca łapała ekran po czasie.
    try? FileManager.default.removeItem(at: file)
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_SYNC"] == "1" {
      let request = file.appendingPathExtension("request")
      try Data().write(to: request)
      for _ in 0..<80 where !FileManager.default.fileExists(atPath: file.path) { settle(0.25) }
      if FileManager.default.fileExists(atPath: file.path) { return }
      // Bez odpowiedzi: prośba znika, żeby spóźniona strona Maca nie zapisała pod tą nazwą późniejszego ekranu.
      try? FileManager.default.removeItem(at: request)
    }
    try screenshot.pngRepresentation.write(to: file)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func settle(_ seconds: TimeInterval = 1) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
