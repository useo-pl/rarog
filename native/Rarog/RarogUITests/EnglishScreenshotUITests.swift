import XCTest

/// Zrzuty kluczowych ekranów po angielsku do oceny ucięć i nakładek (`docs/localization.md`, „Tests”):
/// parowanie, lista, „Settings” z wierszem „Language”, nagłówek sesji z pigułką „w tle” (scenariusz demo `workflow`),
/// karta zgody z seeda, karta „tylko odrzuć” (scenariusz `cannot-allow`), karta pytania (scenariusz `question`),
/// a na iPhonie kafel Live Activity na wyspie, zwinięty i rozwinięty.
///
/// `RAROG_SCREENSHOT_PSEUDO` dokłada pseudojęzyk Foundation: `double` (`-NSDoubleLocalizedStrings YES`, każdy tekst
/// z katalogu dwa razy dłuższy) albo `nonlocalized` (`-NSShowNonLocalizedStrings YES`, tekst bez tłumaczenia
/// wielkimi literami i wpis `com.apple.CFBundle:strings` w logu apki). Test pisze
/// `en[-<pseudo>]-<ekran>-<iphone|ipad>.png` do `RAROG_SCREENSHOT_DIR`; bez katalogu jest pomijany: zrzuty robi się
/// ręcznie, poza bramką. Asercji etykiet nie ma (pseudojęzyk je zmienia), te stoją w `EnglishSmokeUITests`.
///
/// Kafel rysuje rozszerzenie widżetu, a argumenty startu dostaje tylko apka: pseudojęzyk kafla nie obejmuje
/// (zmierzone: wyspa przy `double` bez podwojeń).
final class EnglishScreenshotUITests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    continueAfterFailure = true
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureKeyScreens() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    // Sterowanie demo trzyma jedną sesję odbioru naraz (`create` zdejmuje poprzednią): `cannot-allow` przychodzi
    // dopiero po zrzucie nagłówka sesji `workflow`.
    let workflow = try await control.create("workflow", label: "M1 workflow")
    let pseudo = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_PSEUDO"] ?? ""
    let app = DemoServer.makeApp(language: .en)
    switch pseudo {
    case "": break
    case "double": app.launchArguments += ["-NSDoubleLocalizedStrings", "YES"]
    case "nonlocalized": app.launchArguments += ["-NSShowNonLocalizedStrings", "YES"]
    default:
      XCTFail("RAROG_SCREENSHOT_PSEUDO: double, nonlocalized albo puste, jest „\(pseudo)”")
      return
    }
    let prefix = pseudo.isEmpty ? "en" : "en-\(pseudo)"
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    // Kanał push udany po stronie apki: po świeżej liście z pracującymi sesjami apka startuje kafel (LiveActivityUITests).
    app.launchEnvironment["RAROG_UI_TEST_PUSH"] = "1"
    app.launch()

    XCTAssertTrue(element(app, "pair.start").waitForAppearance(timeout: 15), "ekran parowania")
    settle()
    save(prefix, "parowanie")
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    settle(2)
    save(prefix, "lista")

    if UIDevice.current.userInterfaceIdiom == .phone {
      XCUIDevice.shared.press(.home)
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let island = springboard.descendants(matching: .any)
        .matching(NSPredicate(format: "label BEGINSWITH %@", "Rarog: ")).firstMatch
      if island.waitForAppearance(timeout: 20) {
        settle()
        save(prefix, "kafel-wyspa")
        island.press(forDuration: 1.2)
        settle(2)
        save(prefix, "kafel-wyspa-rozwinieta")
      } else {
        XCTFail("kafel na wyspie po wyjściu z apki")
      }
      app.activate()
      XCTAssertTrue(DemoServer.listShown(app), "lista po powrocie do apki")
    }

    element(app, "list.settings").tap()
    let language = element(app, "settings.language")
    if language.waitForAppearance(timeout: 10) {
      for _ in 0..<4 where !language.isHittable { element(app, "settings.form").swipeUp(velocity: .slow) }
      settle()
      save(prefix, "ustawienia")
    } else {
      XCTFail("wiersz „Language”")
    }
    element(app, "settings.close").tap()
    _ = language.waitForDisappearance(timeout: 5)

    DemoServer.openRow(app, workflow, project: "rarog")
    XCTAssertTrue(element(app, "header.background").waitForAppearance(timeout: 15), "pigułka „w tle”")
    DemoServer.hideKeyboard(app)
    settle()
    save(prefix, "naglowek-w-tle")
    backToList(app)

    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(element(app, "card.permission.demo-perm-willow").waitForAppearance(timeout: 15), "karta zgody")
    DemoServer.hideKeyboard(app)
    settle()
    save(prefix, "karta-zgody")
    backToList(app)

    // Karta bez opcji (`input: null`): tylko „Deny” i zdanie, czemu. Stanu „…waiting for the screen to update” po
    // decyzji demo nie pokaże: driver demo rozstrzyga zgodę od razu i karta znika w tej samej chwili.
    let denyOnly = try await control.create("cannot-allow", label: "M1 zgoda")
    DemoServer.openRow(app, denyOnly, project: "rarog")
    XCTAssertTrue(prefixed(app, "card.permission.").waitForAppearance(timeout: 15), "karta „tylko odrzuć”")
    DemoServer.hideKeyboard(app)
    settle()
    save(prefix, "karta-tylko-odrzuc")
    backToList(app)

    // Karta pytania (scenariusz `question`): opcja autora i opcja tylko dla terminala.
    let question = try await control.create("question", label: "M1 pytanie")
    DemoServer.openRow(app, question, project: "rarog")
    XCTAssertTrue(prefixed(app, "card.question.").waitForAppearance(timeout: 15), "karta pytania")
    DemoServer.hideKeyboard(app)
    settle()
    save(prefix, "karta-pytania")
    try await control.reset()
    app.terminate()
  }

  @MainActor
  private func prefixed(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
  }

  /// Na iPhonie sesja zasłania listę: wstecz w pasku. Na iPadzie lista stoi obok.
  @MainActor
  private func backToList(_ app: XCUIApplication) {
    guard UIDevice.current.userInterfaceIdiom == .phone else { return }
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(DemoServer.listShown(app), "powrót do listy")
  }

  /// Zrzut ekranu do katalogu i do wyniku testu.
  @MainActor
  private func save(_ prefix: String, _ screen: String) {
    let shot = XCUIScreen.main.screenshot()
    let device = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    let name = "\(prefix)-\(screen)-\(device)"
    do {
      try shot.pngRepresentation.write(to: directory.appending(path: "\(name).png"))
    } catch {
      XCTFail("zrzut \(name): \(error)")
    }
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Chwila na koniec animacji (arkusz, wyspa, przewinięcie).
  private func settle(_ seconds: TimeInterval = 1) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
