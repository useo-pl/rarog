import XCTest

/// Zbiorcza Live Activity przeciw demo.
///
/// Demo nie ma kanału APNs — `RAROG_UI_TEST_PUSH=1` udaje go po stronie apki, więc apka po zalogowaniu
/// i świeżej liście z pracującymi sesjami sama startuje aktywność (rdzeń, `RarogStore+LiveActivity`). Kafel
/// zostaje wtedy przy stanie STARTOWYM i licznikach, które apka zapisuje sama: przebiegi, limity i Maca dosyła
/// wyłącznie serwer pushem, a demo pushy nie wysyła.
/// Kafel rysuje rozszerzenie `RarogWidgets`; na iPhonie z wyspą widać go na ekranie głównym, a tap w zwiniętą wyspę
/// otwiera apkę na liście agentów (`widgetURL`). Na iPadzie kafel stoi tylko na ekranie blokady, do
/// którego XCUITest nie sięga — tam test sprawdza sam start (bez wyjątku w apce) i kończy się pominięciem.
final class LiveActivityUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testActivityOnIslandAndTapOpensList() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_PUSH"] = "1"
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("iPad: kafel Live Activity stoi tylko na ekranie blokady — odbiór ręczny (README, Testy)")
    }
    // Start idzie po pełnym stanie listy; chwila na żądanie do systemu, zanim apka zejdzie w tło.
    sleep(2)
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    // Wyspa niesie zdanie kafla dla czytnika („Rarog: N sesji czeka na decyzję…", `LiveActivityPresentation`).
    let island = springboard.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Rarog: ")).firstMatch
    XCTAssertTrue(island.waitForAppearance(timeout: 20), "kafel na wyspie po wyjściu z apki")
    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    shot.name = "wyspa-zwinieta"
    shot.lifetime = .keepAlways
    add(shot)
    island.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tap w wyspę otwiera apkę")
    XCTAssertTrue(app.descendants(matching: .any)["session.list"].firstMatch.waitForAppearance(timeout: 10), "lista agentów")
    let selectedTab = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'tab.' AND selected == true")).firstMatch
    XCTAssertFalse(selectedTab.waitForAppearance(timeout: 3), "tło kafla nie otwiera sesji")
  }
}
