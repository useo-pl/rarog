import XCTest

/// Powiadomienia APNs przeciw demo.
///
/// - Adres `rarog://session/<id>` idzie TĄ SAMĄ drogą co tap w baner (`openPushTarget` w rdzeniu): apka
///   na wierzchu wchodzi w sesję, a przed zalogowaniem cel czeka na logowanie i świeżą listę.
/// - Prawdziwy push robi HOST (`scripts/ios-push.sh`, przekaźnik w `ios-check.sh`): runner w symulatorze
///   nie uruchomi `xcrun simctl push`, więc kładzie ładunek w katalogu sygnałów i czeka na `.sent`.
///   Demo nie ma kanału APNs — `RAROG_UI_TEST_PUSH=1` udaje go po stronie apki (baner „Włącz").
final class PushUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testOpenSessionUrlWhileRunning() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "rarog://session/demo-rarog")))
    // Od chwili, gdy system oddał adres (samo `system.open` to rozmowa runnera ze Springboardem).
    let opened = Date()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-rarog"), timeout: 5), "apka na sesji z adresu")
    // ≤ 2 s; pomiar obejmuje też odpytywanie drzewa dostępności przez XCUITest.
    XCTAssertLessThan(Date().timeIntervalSince(opened), 2, "sesja z adresu w ≤ 2 s")
  }

  /// Liczba na kaflu Live Activity (`rarog://jump/<rodzaj>`): pierwsza sesja tego rodzaju w kolejności listy; tło
  /// kafla (`rarog://list`): lista bez zaznaczonej sesji. Adresy idą przez system jak tap w kafel.
  @MainActor
  func testLiveActivityJumpAndListUrls() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    let selected = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'tab.' AND selected == true")).firstMatch
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "rarog://jump/working")))
    XCTAssertTrue(selected.waitForAppearance(timeout: 5), "liczba „pracuje” otwiera pracującą sesję")
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "rarog://list")))
    XCTAssertTrue(selected.waitForNonExistence(timeout: 5), "tło kafla: bez zaznaczonej sesji")
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 5), "lista agentów")
  }

  @MainActor
  func testOpenSessionUrlBeforeLoginWaitsForLogin() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    let start = element(app, "pair.start")
    XCTAssertTrue(start.waitForAppearance(timeout: 15), "ekran parowania (RAROG_UI_TEST_RESET=1)")
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "rarog://session/demo-map-view")))
    XCTAssertTrue(start.waitForAppearance(timeout: 5), "cel nie omija parowania")
    DemoServer.pair(app, waitForList: false)
    XCTAssertTrue(waitSelected(element(app, "tab.demo-map-view"), timeout: 15), "po zalogowaniu apka wchodzi w cel")
    // Lista dopiero po powrocie: na iPhonie zalogowanie weszło w szczegół, „wstecz” wraca do listy.
    if UIDevice.current.userInterfaceIdiom == .phone { app.navigationBars.buttons.element(boundBy: 0).tap() }
    DemoServer.expectList(app)
  }

  /// „Włącz" → zgoda systemowa → push próbny z hosta daje dymek „Powiadomienia działają"; potem apka
  /// w tle, push o sesji z hosta, tap w baner Springboardu → apka na tej sesji.
  @MainActor
  func testHostPushTestNoticeAndBannerTap() throws {
    let port = try DemoServer.requirePort()
    guard let signals = ProcessInfo.processInfo.environment["RAROG_PUSH_SIGNAL_DIR"] else {
      throw XCTSkip("brak RAROG_PUSH_SIGNAL_DIR — push z hosta robi przekaźnik scripts/ios-check.sh")
    }
    let monitor = addUIInterruptionMonitor(withDescription: "zgoda na powiadomienia") { alert in
      Self.tapAllow(in: alert)
    }
    defer { removeUIInterruptionMonitor(monitor) }
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_PUSH"] = "1"
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")

    // Baner „Włącz" stoi tylko, gdy system jeszcze nie pytał (pierwsze uruchomienie apki na symulatorze); po
    // zgodzie z poprzedniego przebiegu go nie ma, a push próbny i tak musi dać dymek. Świeżo wymazany
    // symulator przez ~2 min po starcie nie odpowiada na odczyt ustawień powiadomień (zmierzone na
    // iOS 27) — baneru wtedy nie ma, a `simctl push` kończy się „Source is not authorized" (README, Testy).
    let enable = element(app, "push.enable")
    if enable.waitForAppearance(timeout: 10) {
      enable.tap()
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let alert = springboard.alerts.firstMatch
      if alert.waitForAppearance(timeout: 5) {
        XCTAssertTrue(Self.tapAllow(in: alert), "przycisk zgody w alercie systemu")
      } else {
        app.tap()
      }
      XCTAssertTrue(enable.waitForDisappearance(timeout: 10), "po zgodzie baner „Włącz” znika")
    }

    try push(signals, #"{"aps":{"alert":{"title":"Rarog","body":"Push próbny"}},"rarog":{"v":1,"kind":"test"}}"#)
    let notice = element(app, "toast.notice")
    XCTAssertTrue(wait("exists == true AND label == 'Powiadomienia działają'", notice, timeout: 10),
                  "dymek po ODEBRANYM pushu próbnym")

    XCUIDevice.shared.press(.home)
    // Push wysłany, zanim apka zejdzie z wierzchu, trafia do `willPresent` (bez banera) — czekamy na tło.
    XCTAssertTrue(wait("state != \(XCUIApplication.State.runningForeground.rawValue)", app, timeout: 10), "apka w tle")
    try push(signals, #"""
      {"aps":{"alert":{"title":"⏳ Czeka na zgodę · rarog","body":"Bash — testy A1"},"thread-id":"demo-rarog"},
       "rarog":{"v":1,"sessionId":"demo-rarog","kind":"permission"}}
      """#)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let banner = springboard.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS 'testy A1'")).firstMatch
    XCTAssertTrue(banner.waitForAppearance(timeout: 30), "baner powiadomienia na Springboardzie")
    banner.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tap w baner otwiera apkę")
    // Bez progu czasu: tap w baner Springboardu i czekanie na jego bezczynność to w XCUITest sekundy
    // narzędzia, nie apki. Czas „≤ 2 s" mierzy wariant z adresem i odbiór na urządzeniu.
    XCTAssertTrue(waitSelected(element(app, "tab.demo-rarog"), timeout: 10), "apka na sesji z powiadomienia")
  }

  // MARK: - Pomocnicze

  /// Ładunek APNs dla przekaźnika hosta; czeka, aż host potwierdzi wysyłkę.
  @MainActor
  private func push(_ directory: String, _ payload: String) throws {
    let name = "a1-\(UUID().uuidString.prefix(8))"
    let base = URL(fileURLWithPath: directory, isDirectory: true)
    let draft = base.appending(path: "\(name).tmp")
    try Data(payload.utf8).write(to: draft)
    // Zmiana nazwy jest atomowa: przekaźnik nie przeczyta połowy pliku.
    try FileManager.default.moveItem(at: draft, to: base.appending(path: "\(name).request"))
    let sent = base.appending(path: "\(name).sent")
    let deadline = Date().addingTimeInterval(15)
    while !FileManager.default.fileExists(atPath: sent.path), Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    let result = try String(contentsOf: sent, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    XCTAssertEqual(result, "ok", "simctl push na hoście (zgoda na powiadomienia?)")
  }

  @MainActor
  @discardableResult
  private static func tapAllow(in alert: XCUIElement) -> Bool {
    for label in ["Allow", "Zezwól", "Pozwól"] where alert.buttons[label].exists {
      alert.buttons[label].tap()
      return true
    }
    return false
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitSelected(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    wait("exists == true AND selected == true", element, timeout: timeout)
  }
}
