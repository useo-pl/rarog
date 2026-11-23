import XCTest

/// Karta pytania z odpowiedzią z apki przeciw serwerowi demo. Właściciel: karty
/// pytań.
///
/// Demo: wiadomość ze słowem „pytanie" wywołuje w mock-driverze formularz z dwoma pytaniami
/// („Zapis" jednokrotnego wyboru, „Testy" wielokrotnego). Karta jest odpowiadana jak karta
/// z ekranu (bez pola własnej odpowiedzi), więc serwer odmawia dwóch wartości w jednym pytaniu
/// (409 ze zdaniem) — to jest ścieżka „odmowa wraca do wyboru z powodem". Test zakłada własną
/// pustą sesję w projekcie willow i zamyka ją na końcu: sesje demo z seedów zostają nietknięte.
final class QuestionUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testQuestionFormAnswer() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-willow")), "projekt willow otwarty")
    let created = try newSession(app)

    // Pytanie z pola wiadomości (mock-driver odpowiada formularzem po ~0,4 s).
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 10))
    composer.tap()
    composer.typeText("pytanie o zapis rejestru")
    app.buttons["composer.send"].tap()
    // Klawiatury nie chowamy ręką: pole gaśnie (i oddaje fokus), gdy sesja zaczyna czekać na odpowiedź.
    let card = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'card.question.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 15), "karta pytania w transkrypcie")

    // Jedna karta z sekcjami „pytanie N/M · nagłówek", opcje autora jako wiersze z opisem.
    XCTAssertTrue(app.staticTexts["pytanie 1/2 · Zapis"].exists, "sekcja pierwszego pytania")
    XCTAssertTrue(app.staticTexts["pytanie 2/2 · Testy"].exists, "sekcja drugiego pytania")
    let json = option(app, 0, 0)
    let sqlite = option(app, 0, 1)
    let unit = option(app, 1, 0)
    let integration = option(app, 1, 1)
    XCTAssertEqual(sqlite.label, "SQLite")
    XCTAssertEqual(sqlite.value as? String, "Transakcje, ale nowa zależność natywna.")
    XCTAssertFalse(app.descendants(matching: .any)["question.own.0"].exists, "bez pola własnej odpowiedzi")

    // „Odpowiedz" bez kompletu: zdanie nazywa pytanie, nic nie wychodzi.
    let submit = app.buttons["question.submit"]
    XCTAssertTrue(submit.exists)
    submit.tap()
    let error = app.staticTexts["question.error"]
    XCTAssertTrue(error.waitForAppearance(timeout: 5))
    XCTAssertEqual(error.label, "Brakuje odpowiedzi na pytanie: Jak zapisujemy rejestr sesji?")

    // Cyfra z klawiatury sprzętowej wybiera n-tą opcję pytania bez odpowiedzi: pole wiadomości zgasło
    // przy pytaniu, a klawiaturę bez adresata przejął ekran sesji.
    app.typeKey("2", modifierFlags: [])
    XCTAssertTrue(waitSelected(sqlite), "cyfra 2 wybrała drugą opcję pierwszego pytania")
    json.tap()
    XCTAssertTrue(waitSelected(json) && wait("selected == false", sqlite), "nowy wybór zastępuje poprzedni")
    sqlite.tap()
    unit.tap()
    integration.tap()
    XCTAssertTrue(waitSelected(unit) && waitSelected(integration), "wielokrotny wybór przełącza")
    XCTAssertTrue(error.waitForDisappearance(timeout: 5), "wybór gasi zdanie o brakującej odpowiedzi")

    // Dwie wartości na karcie odpowiadanej cyfrą: serwer odmawia (409), karta wraca do wyboru z powodem.
    // Enter z klawiatury sprawdza się ręcznie: XCUITest nie dostarcza Return do ekranu bez pola
    // tekstowego (zmierzone: ekran nie dostaje nawet `pressesBegan`, cyfry dostaje).
    submit.tap()
    XCTAssertTrue(error.waitForAppearance(timeout: 10), "odmowa serwera pod kartą")
    XCTAssertEqual(error.label, "Wielokrotny wybór zrób w terminalu — Rarog wyśle jedną odpowiedź.")
    XCTAssertTrue(card.exists && submit.exists, "karta zostaje do poprawki")

    // Jedna wartość: „Wysłano…" → „Odpowiedź przyjęta: …", potem karta ustępuje.
    integration.tap()
    XCTAssertTrue(wait("selected == false", integration))
    submit.tap()
    let status = app.staticTexts["question.status"]
    XCTAssertTrue(status.waitForAppearance(timeout: 10), "wiersz stanu zamiast stopki")
    XCTAssertTrue(
      wait("label == %@", status, args: ["Odpowiedź przyjęta: „SQLite, Jednostkowe”"], timeout: 10),
      "potwierdzenie z nazwą odpowiedzi: \(status.label)")
    XCTAssertFalse(submit.exists, "po odpowiedzi stopki nie ma")
    XCTAssertTrue(card.waitForDisappearance(timeout: 15), "karta ustępuje po rozstrzygnięciu i oknie potwierdzenia")

    // Sprzątanie: własna sesja zamknięta dwoma naciśnięciami „×".
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    XCTAssertTrue(wait("label BEGINSWITH 'Na pewno?'", close, timeout: 5), "pierwsze naciśnięcie uzbraja")
    close.tap()
    XCTAssertTrue(element(app, created).waitForDisappearance(timeout: 10), "sesja testu zamknięta")
  }

  /// Jedno pytanie: jedna linia etykiety „pytanie · nagłówek CLI” zamiast etykiety i osobnej linii nagłówka.
  /// Czytnik słyszy „Pytanie od agenta” i nagłówek CLI jednym nagłówkiem. Przy największym piśmie dostępności etykieta
  /// zawija się nad treścią pytania, a zegar schodzi pod nią i nie nachodzi na tekst (zrzut w załączniku: odbiór
  /// na oko; zegar nie ma własnego elementu dostępności, bo nagłówek jest jednym elementem).
  /// Demo: scenariusz `question` (`/api/demo/control`), nagłówek sesji odbioru.
  @MainActor
  func testSingleQuestionHasOneLabelLine() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    for largest in [false, true] {
      try await control.reset()
      let id = try await control.create("question", label: largest ? "P6 duże pismo" : "P6 etykieta")
      let app = DemoServer.makeApp()
      app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
      app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
      if largest {
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
      }
      app.launch()
      DemoServer.pair(app)
      XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
      DemoServer.reveal(app, id).tap()
      let header = element(app, "question.header")
      XCTAssertTrue(header.waitForAppearance(timeout: 15), "etykieta karty pytania")
      DemoServer.hideKeyboard(app)
      XCTAssertEqual(header.label, "Pytanie od agenta, Odbiór M1", "jeden nagłówek dla czytnika")
      XCTAssertFalse(app.staticTexts["Odbiór M1"].exists, "bez osobnej linii nagłówka pod etykietą")
      let question = element(app, "question.text.0")
      XCTAssertTrue(question.waitForAppearance(timeout: 5), "treść pytania")
      XCTAssertLessThanOrEqual(header.frame.maxY, question.frame.minY + 1, "etykieta nad treścią, bez nachodzenia")
      let card = app.descendants(matching: .any)
        .matching(NSPredicate(format: "identifier BEGINSWITH 'card.question.'")).firstMatch
      XCTAssertLessThanOrEqual(header.frame.maxX, card.frame.maxX + 1, "etykieta z zegarem mieści się w karcie")
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "pytanie-jedna-etykieta\(largest ? "-ax5" : "")"
      attachment.lifetime = .keepAlways
      add(attachment)
      app.terminate()
    }
    try await control.reset()
  }

  /// Zaznaczona odpowiedź to prostokąt na całą szerokość wiersza, także w rogach, ze wskaźnikiem nad nią
  /// i bez. `.hoverEffect(.highlight)` stylu wiersza przycinałby cały wiersz, z tłem zaznaczenia, do
  /// kształtu efektu — domyślnie zaokrąglonego prostokąta.
  /// Demo: scenariusz `question` (`/api/demo/control`), karta z dwiema opcjami i polem własnej odpowiedzi.
  @MainActor
  func testPickedOptionHasSquareCorners() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("question", label: "R3 zaznaczenie")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, id).tap()
    let option = element(app, "question.option.0.0")
    XCTAssertTrue(option.waitForAppearance(timeout: 15), "karta pytania")
    DemoServer.hideKeyboard(app)
    option.tap()
    XCTAssertTrue(waitSelected(option), "odpowiedź zaznaczona")
    // Wiersz bez zaznaczenia (opcja tylko w terminalu) niesie kolor karty.
    let plain = element(app, "question.option.0.1")
    for pointer in [false, true] {
      // Wskaźnik nad zaznaczeniem (iPad z gładzikiem) albo z dala od karty.
      (pointer ? option : app.navigationBars.firstMatch).hover()
      sleep(1)
      let screenshot = app.screenshot()
      let attachment = XCTAttachment(screenshot: screenshot)
      attachment.name = "pytanie-zaznaczenie-\(pointer ? "wskaznik" : "bez-wskaznika")"
      attachment.lifetime = .keepAlways
      add(attachment)
      let pixels = try XCTUnwrap(HeaderPixels(screenshot, pointsWidth: app.frame.width))
      let frame = option.frame
      let edge = pixels.color(at: CGPoint(x: frame.minX + 2, y: frame.midY))
      let card = pixels.color(at: CGPoint(x: plain.frame.minX + 2, y: plain.frame.midY))
      XCTAssertGreaterThan(HeaderPixels.distance(edge, card), 6, "zaznaczenie odróżnia się od karty")
      let corners = [
        CGPoint(x: frame.minX + 2, y: frame.minY + 2), CGPoint(x: frame.maxX - 2, y: frame.minY + 2),
        CGPoint(x: frame.minX + 2, y: frame.maxY - 2), CGPoint(x: frame.maxX - 2, y: frame.maxY - 2),
      ]
      for corner in corners {
        let color = pixels.color(at: corner)
        XCTAssertLessThanOrEqual(
          HeaderPixels.distance(color, edge), 4,
          String(format: "róg %@ (%@): #%06X, krawędź #%06X, karta #%06X",
                 "\(corner)", pointer ? "wskaźnik" : "bez wskaźnika", color, edge, card))
      }
    }
    app.terminate()
    try await control.reset()
  }

  /// Wskaźnik nad opcją podświetla WIERSZ opcji, a nagłówek karty stoi bez zmian.
  /// Wiersz rysuje własne tło pod wskaźnikiem (`.onHover`),
  /// bez systemowego efektu. Ten sam scenariusz demo `question`; żadna opcja nie jest zaznaczona.
  ///
  /// `hover()` z XCUITest nie daje w symulatorze iOS 27 stanu wskaźnika: zmierzone — ani własne tło,
  /// ani systemowy `.hoverEffect(.highlight)` nie zmieniają piksela wiersza ani nagłówka. Wtedy test kończy
  /// się JAWNYM pominięciem (nie zielonym), a rozstrzyga odbiór na iPadzie z gładzikiem; gdy symulator zacznie
  /// rysować wskaźnik, asercje wracają same.
  @MainActor
  func testPointerHighlightsOptionRowNotHeader() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("question", label: "R5 wskaźnik")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, id).tap()
    let option = element(app, "question.option.0.0")
    XCTAssertTrue(option.waitForAppearance(timeout: 15), "karta pytania")
    DemoServer.hideKeyboard(app)
    let card = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'card.question.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 5), "karta z identyfikatorem")

    app.navigationBars.firstMatch.hover()
    sleep(1)
    let away = try XCTUnwrap(HeaderPixels(app.screenshot(), pointsWidth: app.frame.width))
    option.hover()
    sleep(1)
    let shot = app.screenshot()
    let over = try XCTUnwrap(HeaderPixels(shot, pointsWidth: app.frame.width))
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = "pytanie-wskaznik-nad-opcja"
    attachment.lifetime = .keepAlways
    add(attachment)

    // Tło wiersza 2 pt od jego lewej krawędzi (przed kolumną klucza) i nagłówek karty: pas 6 pt pod górną
    // krawędzią karty, na środku i przy lewej krawędzi (nad etykietą „pytanie”, pod obrysem). Ramka elementu
    // karty obejmuje jej odstęp 8 pt nad i pod kartą.
    let row = option.frame
    let rowPoint = CGPoint(x: row.minX + 2, y: row.midY)
    let rowChange = HeaderPixels.distance(away.color(at: rowPoint), over.color(at: rowPoint))
    if rowChange == 0 {
      app.terminate()
      try await control.reset()
      throw XCTSkip("hover() nie daje stanu wskaźnika w symulatorze (wiersz bez zmiany piksela) — odbiór na iPadzie")
    }
    XCTAssertGreaterThan(
      rowChange, 4,
      String(format: "wiersz pod wskaźnikiem: #%06X → #%06X", away.color(at: rowPoint), over.color(at: rowPoint)))
    let frame = card.frame
    for point in [CGPoint(x: frame.midX, y: frame.minY + 14), CGPoint(x: frame.minX + 6, y: frame.minY + 14)] {
      XCTAssertLessThanOrEqual(
        HeaderPixels.distance(away.color(at: point), over.color(at: point)), 2,
        String(format: "nagłówek bez zmian w %@: #%06X → #%06X", "\(point)", away.color(at: point), over.color(at: point)))
    }
    app.terminate()
    try await control.reset()
  }

  // MARK: - Pomocnicze

  /// „+" na pasku zakładek zakłada pustą sesję i ją otwiera. Demo dławi zakładanie (5 s między
  /// sesjami) — przy odmowie test czeka i próbuje jeszcze raz.
  @MainActor
  private func newSession(_ app: XCUIApplication) throws -> String {
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    let before = tabs.count
    for attempt in 0..<3 {
      DemoServer.addFromPlus(app)
      if wait("count == \(before + 1)", tabs, timeout: 8) { break }
      XCTAssertLessThan(attempt, 2, "nowa zakładka na pasku")
      sleep(5)
    }
    let created = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
    XCTAssertTrue(created.waitForAppearance(timeout: 10))
    let id = created.identifier
    XCTAssertFalse(["tab.demo-willow", "tab.demo-willow-parser"].contains(id), "bieżąca jest nowa sesja")
    return id
  }

  @MainActor
  private func option(_ app: XCUIApplication, _ section: Int, _ index: Int) -> XCUIElement {
    element(app, "question.option.\(section).\(index)")
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ format: String, _ object: Any, args: [Any] = [], timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: format, argumentArray: args)
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitSelected(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
    wait("exists == true AND selected == true", element, timeout: timeout)
  }
}
