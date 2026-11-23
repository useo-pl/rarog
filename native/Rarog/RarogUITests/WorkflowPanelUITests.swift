import UIKit
import XCTest

/// Przebieg workflow w panelu „w tle" i faza w linii karty —
/// przeciw sterowanemu scenariuszowi demo `workflow` (`server/src/demo/scenarios.ts`): sesja
/// bezczynna z jednym zadaniem w tle, plan Implementacja → Review → Poprawki, 56 skończonych i jeden
/// żywy agent w Review. Kolejne rozkłady przychodzą zwykłymi ramkami listy po `emit` kontroli demo.
/// Dymek „w tle” jest tylko na iPadzie: na iPhonie pigułka otwiera panel sesji jako arkusz,
/// a te same sekcje w panelu sprawdza `InspectorUITests`.
final class WorkflowPanelUITests: XCTestCase {
  private let task = "m1-workflow"

  override func setUp() { continueAfterFailure = false }

  /// Otwarcie i fazy → bieżąca rozwinięta: żywy agent na wierzchu, widoczny bez przewijania mimo 44
  /// skończonych, a skończeni pod zwiniętym „✓ 44 skończyło" → ręcznie otwarta inna faza i rozwinięta lista
  /// skończonych przeżywają nowy rozkład → dopisany żywy agent niczego nad sobą nie przesuwa → zakończenie
  /// agentów nie przesuwa wiersza fazy → rozkład rosnący NAD czytanym wierszem go nie przesuwa → zmiana
  /// bieżącej fazy rozwija nową i nie zwija poprzednich → koniec przebiegu zamyka panel razem z pigułką.
  @MainActor
  func testPanelFollowsRunWithoutJumps() async throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("telefon: pigułka „w tle” otwiera panel sesji jako arkusz, dymek jest tylko na iPadzie")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 workflow")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)

    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    openSession(app, id)

    // Otwarcie: pigułka → panel; podsumowanie jednym zdaniem i fazy ze stanem.
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15), "pigułka „w tle”")
    revealPanelRoom(app)
    pill.tap()
    let panel = element(app, "header.background.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "panel „w tle”")
    let summary = element(app, "workflow.\(task).summary")
    XCTAssertTrue(summary.waitForAppearance(timeout: 10))
    XCTAssertTrue(summary.label.hasPrefix("Przebieg workflow: skończone fazy 1 z 3, 56 skończyło, 1 pracuje. "),
      summary.label)
    let impl = phase(app, "Implementacja")
    let review = phase(app, "Review")
    XCTAssertEqual(impl.label, "Implementacja: skończona, skończonych 12 z 12")
    XCTAssertEqual(review.label, "Review: w toku, skończonych 44 z 45")
    // Bieżąca rozwinięta sama, skończona zwinięta.
    XCTAssertEqual(review.value as? String, "rozwinięte")
    XCTAssertEqual(impl.value as? String, "zwinięte")
    // Żywy na wierzchu fazy — widoczny bez przewijania, choć faza ma 44 skończonych.
    let live = agent(app, "review:45")
    XCTAssertTrue(live.waitForAppearance(timeout: 5), "żywy agent bieżącej fazy")
    XCTAssertTrue(live.isHittable && panel.frame.contains(live.frame), "żywy agent widoczny bez przewijania")
    XCTAssertTrue(live.label.hasPrefix("review:45 pracuje, od "), live.label)
    let reviewDone = doneGroup(app, "Review")
    XCTAssertEqual(reviewDone.label, "Review: 44 skończyło")
    XCTAssertEqual(reviewDone.value as? String, "zwinięte", "lista skończonych domyślnie zwinięta")
    XCTAssertFalse(agent(app, "review:01").exists, "skończeni schowani pod swoim wierszem")
    XCTAssertFalse(agent(app, "impl:01").exists, "agenci zwiniętej fazy schowani")
    snapshot(app, "panel-otwarty")

    // Ręka: Implementacja (bez żywych — sam wiersz skończonych) i lista skończonych Review.
    impl.tap()
    let implDone = doneGroup(app, "Implementacja")
    XCTAssertTrue(implDone.waitForAppearance(timeout: 5), "stuknięcie rozwija fazę")
    XCTAssertEqual(implDone.label, "Implementacja: 12 skończyło")
    XCTAssertEqual(impl.value as? String, "rozwinięte")
    XCTAssertFalse(agent(app, "impl:01").exists, "faza bez żywych: sam wiersz skończonych")
    reviewDone.tap()
    XCTAssertTrue(agent(app, "review:01").waitForAppearance(timeout: 5), "stuknięcie rozwija listę skończonych")
    XCTAssertEqual(reviewDone.value as? String, "rozwinięte")
    settle()
    // Nowy rozkład: żywy agent dopisany pod żywymi niczego nad sobą nie przesuwa, rozwinięcia zostają.
    let reviewBefore = review.frame
    let liveBefore = live.frame
    try await control.emit("workflow-agent", sessionId: id)
    XCTAssertTrue(wait("label BEGINSWITH %@", summary,
      arguments: ["Przebieg workflow: skończone fazy 1 z 3, 56 skończyło, 2 pracują. "]),
      "nowy rozkład dotarł do otwartego panelu: \(summary.label)")
    XCTAssertTrue(agent(app, "review:46").waitForAppearance(timeout: 5), "nowy żywy pod żywymi")
    XCTAssertEqual(impl.value as? String, "rozwinięte", "ręcznie otwarta faza nie zwinęła się po odświeżeniu")
    XCTAssertEqual(reviewDone.value as? String, "rozwinięte", "rozwinięta lista skończonych przeżyła odświeżenie")
    XCTAssertTrue(agent(app, "review:01").exists)
    XCTAssertEqual(review.frame.minY, reviewBefore.minY, accuracy: 1, "dopisany agent nie przesunął fazy nad sobą")
    XCTAssertEqual(live.frame.minY, liveBefore.minY, accuracy: 1, "ani żywego nad sobą")
    snapshot(app, "panel-reka-i-nowy-agent")

    // Agenci kończą: schodzą z żywych, licznik rośnie, wiersz fazy stoi.
    let reviewHeader = review.frame
    try await control.emit("workflow-done", sessionId: id)
    XCTAssertTrue(wait("label == %@", reviewDone, arguments: ["Review: 46 skończyło"]), reviewDone.label)
    XCTAssertEqual(review.frame.minY, reviewHeader.minY, accuracy: 1, "zakończenie agenta nie przesunęło fazy")
    XCTAssertEqual(reviewDone.value as? String, "rozwinięte")

    // Rozkład rośnie NAD czytanym wierszem: Implementacja (zwinięta) dostaje żywego agenta, staje się
    // bieżąca i rozwija się nad Review. Czytany wiersz z listy skończonych Review zostaje w miejscu.
    impl.tap()
    XCTAssertTrue(implDone.waitForDisappearance(timeout: 5), "zwinięcie innej fazy")
    scrollToBottom(app, panel)
    let reference = try XCTUnwrap(topVisibleAgent(app, panel, prefix: "review:"), "czytany wiersz Review u góry panelu")
    let referenceY = reference.frame.minY
    try await control.emit("workflow-agent", sessionId: id, text: "Implementacja")
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      XCTAssertEqual(reference.frame.minY, referenceY, accuracy: 2, "rozkład rosnący nad wierszem go nie przesunął")
      try await Task.sleep(for: .milliseconds(150))
    }
    snapshot(app, "panel-kotwica")

    // Zmiana bieżącej fazy: Poprawki rozwijają się same, poprzednie bieżące zostają rozwinięte.
    try await control.emit("workflow-phase", sessionId: id)
    XCTAssertTrue(agent(app, "fix:01").waitForAppearance(timeout: 10), "nowa bieżąca faza rozwinięta")
    XCTAssertEqual(phase(app, "Poprawki").label, "Poprawki: w toku, skończonych 0 z 1")
    scrollToTop(app, panel)
    XCTAssertEqual(phase(app, "Implementacja").value as? String, "rozwinięte", "była bieżąca — zostaje rozwinięta")
    XCTAssertEqual(phase(app, "Implementacja").label, "Implementacja: skończona, skończonych 13 z 13")
    XCTAssertEqual(implDone.label, "Implementacja: 13 skończyło", "agent dopisany nad czytanym wierszem skończył")
    XCTAssertEqual(phase(app, "Review").value as? String, "rozwinięte", "odświeżenie nie zwinęło Review")
    XCTAssertTrue(summary.label.hasPrefix("Przebieg workflow: skończone fazy 2 z 3, 59 skończyło, 1 pracuje. "),
      summary.label)
    snapshot(app, "panel-nowa-faza")

    // Koniec przebiegu: panel znika razem z pigułką.
    try await control.emit("workflow-end", sessionId: id)
    XCTAssertTrue(panel.waitForDisappearance(timeout: 10), "koniec przebiegu zamyka panel")
    XCTAssertTrue(pill.waitForDisappearance(timeout: 10), "i zdejmuje pigułkę")
    app.terminate()
    try await control.reset()
  }

  /// Linia karty: workflow w toku mówi fazę planu PRZED nazwą i idzie za nią przy nowym
  /// rozkładzie; koniec przebiegu zdejmuje linię. Linia workflow w toku
  /// nie ma „w tle: workflow ·”, bo pasek faz pod kartą mówi „workflow”.
  @MainActor
  func testCardLineShowsPhase() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 workflow karta")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["faza 2/3 Review · przegląd M1"]),
      "linia karty mówi fazę planu: \(row.label)")
    snapshot(app, "lista-faza")
    try await control.emit("workflow-phase", sessionId: id)
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["faza 3/3 Poprawki · przegląd M1"]),
      "linia karty idzie za fazą: \(row.label)")
    try await control.emit("workflow-end", sessionId: id)
    XCTAssertTrue(wait("NOT (label CONTAINS %@) AND NOT (label CONTAINS %@)", row, arguments: ["przegląd M1", "w tle"]),
      "koniec przebiegu zdejmuje linię: \(row.label)")
    app.terminate()
    try await control.reset()
  }

  /// Bez kontaktu ze źródłem: panel mówi „ostatni znany stan", a zegar żywego agenta stoi.
  @MainActor
  func testStalePanelSaysLastKnownState() async throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("telefon: pigułka „w tle” otwiera panel sesji jako arkusz, dymek jest tylko na iPadzie")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 workflow stale")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    openSession(app, id)
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15))
    revealPanelRoom(app)
    pill.tap()
    XCTAssertTrue(element(app, "header.background.panel").waitForAppearance(timeout: 10))
    XCTAssertFalse(element(app, "header.background.stale").exists, "świeży panel nie straszy")
    try await control.emit("detach", sessionId: id)
    let stale = element(app, "header.background.stale")
    XCTAssertTrue(stale.waitForAppearance(timeout: 10), "panel mówi, że to ostatni znany stan")
    snapshot(app, "panel-nieswiezy")
    app.terminate()
    try await control.reset()
  }

  // MARK: - Zrzuty (ocena wzrokowa): oba motywy, zwykłe i największe pismo

  @MainActor
  func testScreensDark() async throws { try await screens(theme: "dark", largest: false) }

  @MainActor
  func testScreensLight() async throws { try await screens(theme: "light", largest: false) }

  @MainActor
  func testScreensDarkLargest() async throws { try await screens(theme: "dark", largest: true) }

  @MainActor
  func testScreensLightLargest() async throws { try await screens(theme: "light", largest: true) }

  /// Screenshots for visual review: the checks here repeat the tests above (the largest text size only changes the
  /// look), so without `RAROG_SCREENSHOT_DIR` the four `testScreens*` tests are skipped. The screenshots stay
  /// attachments in the test result.
  @MainActor
  private func screens(theme: String, largest: Bool) async throws {
    guard ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] != nil else {
      throw XCTSkip("no RAROG_SCREENSHOT_DIR: screenshots are taken by hand, outside the gate")
    }
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("telefon: pigułka „w tle” otwiera panel sesji jako arkusz, dymek jest tylko na iPadzie")
    }
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("workflow", label: "M1 workflow")
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    if largest {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    }
    app.launch()
    let suffix = "\(theme)-\(largest ? "ax5" : "normal")"
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    snapshot(app, "lista-\(suffix)")
    openSession(app, id)
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15))
    revealPanelRoom(app)
    pill.tap()
    XCTAssertTrue(element(app, "header.background.panel").waitForAppearance(timeout: 10))
    // Domyślnie: bieżąca Review z żywym na wierzchu i zwiniętymi skończonymi. Potem ręka: Implementacja
    // i jej lista skończonych.
    let impl = phase(app, "Implementacja")
    XCTAssertTrue(impl.waitForAppearance(timeout: 10))
    settle()
    snapshot(app, "panel-\(suffix)")
    impl.tap()
    let implDone = doneGroup(app, "Implementacja")
    XCTAssertTrue(implDone.waitForAppearance(timeout: 5))
    implDone.tap()
    XCTAssertTrue(agent(app, "impl:01").waitForAppearance(timeout: 5))
    settle()
    snapshot(app, "panel-rozwiniete-\(suffix)")
    app.terminate()
    try await control.reset()
  }

  // MARK: - Pomocnicze

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func phase(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    element(app, "workflow.\(task).phase.\(title)")
  }

  @MainActor
  private func doneGroup(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    element(app, "workflow.\(task).done.\(title)")
  }

  @MainActor
  private func agent(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    element(app, "workflow.\(task).agent.m1-wf-\(label)")
  }

  private func wait(_ predicate: String, _ object: Any, arguments: [Any] = [], timeout: TimeInterval = 15) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: predicate, argumentArray: arguments), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// Sesja z listy. Wiersz, którego XCUITest nie uznaje za klikalny (iPhone w największym piśmie), dostaje
  /// stuknięcie po współrzędnych; zwinięty projekt rozwija nagłówek (`DemoServer.openRow`). Nagłówek projektu
  /// nie jest drogą awaryjną: zwija i rozwija, nie wchodzi w projekt.
  @MainActor
  private func openSession(_ app: XCUIApplication, _ id: String) {
    DemoServer.openRow(app, id, project: "rarog")
  }

  /// Pole wiadomości bierze fokus samo, a klawiatura ekranowa symulatora zabiera popoverowi pół
  /// wysokości — chowamy ją przed otwarciem panelu.
  @MainActor
  private func revealPanelRoom(_ app: XCUIApplication) {
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15))
    settle()
    DemoServer.hideKeyboard(app)
  }

  /// Chwila na koniec animacji (chevron, popover rosnący do treści) przed pomiarem ramek.
  private func settle() {
    Thread.sleep(forTimeInterval: 0.8)
  }

  /// Przeciągnięcie palcem w panelu bez rozpędu: start i koniec wewnątrz panelu, przytrzymanie na końcu.
  @MainActor
  private func drag(_ app: XCUIApplication, _ panel: XCUIElement, by delta: CGFloat) {
    let frame = panel.frame
    let span = min(abs(delta), frame.height * 0.6)
    let step = delta < 0 ? -span : span
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let start = origin.withOffset(CGVector(dx: frame.midX, dy: frame.midY - step / 2))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
                withVelocity: .slow, thenHoldForDuration: 0.3)
  }

  @MainActor
  private func scrollToBottom(_ app: XCUIApplication, _ panel: XCUIElement) {
    for _ in 0..<12 {
      let last = phase(app, "Poprawki")
      if last.exists, last.isHittable, last.frame.maxY < panel.frame.maxY - 4 { break }
      drag(app, panel, by: -400)
    }
    drag(app, panel, by: -400)
    settle()
  }

  @MainActor
  private func scrollToTop(_ app: XCUIApplication, _ panel: XCUIElement) {
    for _ in 0..<12 {
      let summary = element(app, "workflow.\(task).summary")
      if summary.exists, summary.isHittable, summary.frame.minY > panel.frame.minY { break }
      drag(app, panel, by: 400)
    }
    settle()
  }

  /// Najwyższy w pełni widoczny wiersz agenta z danym prefiksem etykiety — miejsce czytania.
  @MainActor
  private func topVisibleAgent(_ app: XCUIApplication, _ panel: XCUIElement, prefix: String) -> XCUIElement? {
    let rows = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "workflow.\(task).agent.m1-wf-\(prefix)"))
      .allElementsBoundByIndex
    let top = panel.frame.minY + 8
    let visible = rows.filter { $0.isHittable && $0.frame.minY >= top && $0.frame.maxY <= panel.frame.maxY }
    guard let first = visible.min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
    return element(app, first.identifier)
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let device = UIDevice.current.userInterfaceIdiom == .phone ? "iphone" : "ipad"
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "workflow-\(device)-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
