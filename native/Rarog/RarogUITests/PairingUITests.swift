import XCTest

/// Parowanie i klucz urządzenia przeciw demo.
///
/// - Kod „jak z Maca” wydaje demo (`POST /api/demo/pairing` — trasa istnieje tylko w trybie demo): odpina urządzenia
///   demo, więc każdy test paruje od zera.
/// - Link wklejony w „Mam link” i adres `rarog://pair#…` otwarty przez system kończą się kartą „Sparować z …?”.
/// - Bez klucza stoi sam ekran parowania (apka nie ma logowania tokenem). Po parowaniu apka wstaje po zabiciu bez
///   parowania (klucz w Keychainie), „Ustawienia” mówią „klucz urządzenia”
///   i wydają kod dla nowego urządzenia; odpięcie daje trwały ekran „To urządzenie odpięto”.
/// - Ekran parowania ma pod kontrolkami trzy linki produktu (polityka prywatności, instrukcja serwera, wsparcie), w pl
///   i en.
/// - Ekran parowania bez nazwy apki nad tytułem; akapit podaje `rarog pair` (pismo kodu, tekst bez zmian dla
///   VoiceOver) i ścieżkę „Ustawienia → Parowanie → Sparuj nowe urządzenie”; Settings have a "Parowanie" row whose
///   page carries that button.
/// - A `device-paired` push from the host (relay in `scripts/ios-check.sh` and `scripts/ios-test.sh`): a banner on
///   top, and a tap while the app is killed opens Settings on the Pairing page.
final class PairingUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testPairWithLinkThenRelaunchStaysPaired() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    XCTAssertTrue(element(app, "pair.start").waitForAppearance(timeout: 15), "ekran parowania, bez tokenu")
    XCTAssertFalse(app.secureTextFields.firstMatch.exists, "apka nie ma pola tokenu")
    // Nad tytułem nie stoi nazwa apki; akapit z komendą i ścieżką do sekcji „Parowanie”.
    XCTAssertEqual(
      app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Rarog")).count, 0, "bez etykiety „RAROG” nad tytułem")
    let lead = element(app, "pair.start.lead").label
    XCTAssertTrue(lead.contains("uruchom rarog pair"), "komenda w akapicie: \(lead)")
    XCTAssertTrue(lead.contains("Ustawienia → Parowanie → Sparuj nowe urządzenie"), "ścieżka w akapicie: \(lead)")
    pair(app, link: try DemoServer.pairingLink(port: port))
    DemoServer.expectList(app)

    // Settings → Server: the device key.
    let server = DemoServer.openSettingsPage(app, "server")
    let auth = DemoServer.revealSettings(app, "settings.auth", in: server)
    XCTAssertTrue(auth.exists, "access row on the Server page")
    XCTAssertTrue(auth.label.contains("klucz urządzenia"), "access: \(auth.label)")
    DemoServer.settingsBack(app, from: "Serwer")
    // Settings → Pairing → Pair New Device: the path the pairing screen gives; the code links to the server's address.
    let row = DemoServer.revealSettings(app, "settings.row.pairing", in: element(app, "settings.form"))
    XCTAssertEqual(row.label, "Parowanie", "Pairing row on the Settings list")
    let pairingPage = DemoServer.openSettingsPage(app, "pairing")
    XCTAssertTrue(app.navigationBars["Parowanie"].exists, "title of the Pairing page")
    let issue = DemoServer.revealSettings(app, "settings.issue", in: pairingPage)
    XCTAssertTrue(issue.exists && issue.isHittable, "„Sparuj nowe urządzenie”")
    XCTAssertEqual(issue.label, "Sparuj nowe urządzenie")
    issue.tap()
    let link = element(app, "settings.code.link")
    XCTAssertTrue(link.waitForAppearance(timeout: 10), "code for a new device")
    XCTAssertTrue(link.label.hasPrefix("https://rarog.ai/pair#v=1&u=http%3A%2F%2F127.0.0.1%3A\(port)&c="), link.label)
    DemoServer.settingsBack(app, from: "Parowanie")
    element(app, "settings.close").tap()

    // Zabicie apki nie wylogowuje: klucz w Keychainie, bez ekranu parowania.
    app.terminate()
    let again = DemoServer.launch(port: port, reset: false)
    DemoServer.expectList(again)
    XCTAssertFalse(element(again, "pair.start").exists, "bez parowania po restarcie")
  }

  @MainActor
  func testSystemLinkShowsConfirmationAndCancelChangesNothing() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    let start = element(app, "pair.start")
    XCTAssertTrue(start.waitForAppearance(timeout: 15))
    XCUIDevice.shared.system.open(try XCTUnwrap(DemoServer.systemLink(try DemoServer.pairingLink(port: port))))
    let title = element(app, "pair.confirm.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "link z systemu daje kartę potwierdzenia")
    XCTAssertEqual(title.label, "Sparować z 127.0.0.1?")
    element(app, "pair.cancel").tap()
    XCTAssertTrue(title.waitForDisappearance(timeout: 5), "„Anuluj” zdejmuje kartę")
    XCTAssertTrue(start.exists, "bez potwierdzenia nic się nie zmienia")
    // Zły link: karta mówi, co jest nie tak, i nic nie wychodzi.
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "rarog://pair#v=9")))
    XCTAssertTrue(title.waitForAppearance(timeout: 10))
    XCTAssertEqual(title.label, "To nie jest link parowania")
  }

  @MainActor
  func testRevokedDeviceShowsPersistentScreen() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    XCTAssertTrue(element(app, "pair.start").waitForAppearance(timeout: 15))
    pair(app, link: try DemoServer.pairingLink(port: port))
    DemoServer.expectList(app)
    // Następny kod z demo odpina wszystkie urządzenia demo: strumień listy zamknięty, ponowne połączenie = 401
    // `device-revoked`.
    _ = try DemoServer.pairingLink(port: port)
    let revoked = element(app, "pair.revoked.title")
    XCTAssertTrue(revoked.waitForAppearance(timeout: 30), "ekran odpięcia")
    XCTAssertTrue(element(app, "pair.revoked.lead").label.contains("odpiął to urządzenie"))
    // Trwały: po zabiciu apki ten sam ekran, nie zwykły ekran parowania.
    app.terminate()
    let again = DemoServer.launch(port: port, reset: false)
    XCTAssertTrue(element(again, "pair.revoked.title").waitForAppearance(timeout: 15), "ekran odpięcia po restarcie")
    // Ponowne parowanie zdejmuje ekran.
    pair(again, link: try DemoServer.pairingLink(port: port))
    DemoServer.expectList(again)
  }

  /// Ekran parowania bez sparowania: pod kontrolkami trzy linki produktu, z nazwami w języku apki.
  @MainActor
  func testUnpairedScreenShowsProductLinks() throws {
    let port = try DemoServer.requirePort()
    let expected: [(DemoServer.AppLanguage, [String])] = [
      (.pl, ["Polityka prywatności", "Instalacja serwera", "Wsparcie"]),
      (.en, ["Privacy Policy", "Set Up a Server", "Support"]),
    ]
    for (language, labels) in expected {
      let app = DemoServer.launch(port: port, language: language)
      XCTAssertTrue(element(app, "pair.start").waitForAppearance(timeout: 15), "ekran parowania (\(language))")
      for (id, label) in zip(["privacy", "setup", "support"], labels) {
        let link = element(app, "pairing.link.\(id)")
        XCTAssertTrue(link.waitForAppearance(timeout: 5), "link \(id) (\(language))")
        XCTAssertEqual(link.label, label, "\(id) (\(language))")
      }
      app.terminate()
    }
  }

  /// The `device-paired` security push from the host: a banner on top; a tap while the app is killed opens the
  /// Pairing page of Settings.
  @MainActor
  func testDevicePairedPushBannerAndColdTap() throws {
    let port = try DemoServer.requirePort()
    guard let signals = ProcessInfo.processInfo.environment["RAROG_PUSH_SIGNAL_DIR"] else {
      throw XCTSkip("brak RAROG_PUSH_SIGNAL_DIR — push z hosta robi przekaźnik scripts/ios-check.sh")
    }
    let monitor = addUIInterruptionMonitor(withDescription: "zgoda na powiadomienia") { alert in
      Self.tapAllow(in: alert)
    }
    defer { removeUIInterruptionMonitor(monitor) }
    let app = DemoServer.launch(port: port, environment: ["RAROG_UI_TEST_PUSH": "1"])
    XCTAssertTrue(element(app, "pair.start").waitForAppearance(timeout: 15))
    pair(app, link: try DemoServer.pairingLink(port: port))
    DemoServer.expectList(app)
    let enable = element(app, "push.enable")
    if enable.waitForAppearance(timeout: 10) {
      enable.tap()
      let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
      if alert.waitForAppearance(timeout: 5) { Self.tapAllow(in: alert) } else { app.tap() }
      _ = enable.waitForDisappearance(timeout: 10)
    }
    let payload = #"""
      {"aps":{"alert":{"title":"🔐 Sparowano nowe urządzenie","body":"iPad·Rarog — test powiadomienia"},"sound":"default"},
       "rarog":{"v":1,"kind":"device-paired"}}
      """#
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let banner = springboard.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS 'test powiadomienia'")).firstMatch

    // Na wierzchu: system pokazuje baner (inne rodzaje wycisza obecność).
    try push(signals, payload)
    XCTAssertTrue(banner.waitForAppearance(timeout: 30), "baner device-paired na wierzchu")

    // Killed app: a tap on the banner starts it from scratch and opens Settings on the Pairing page (no session).
    app.terminate()
    try push(signals, payload)
    XCTAssertTrue(banner.waitForAppearance(timeout: 30), "baner przy zabitej apce")
    banner.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "tap uruchamia apkę")
    XCTAssertTrue(element(app, "settings.page.pairing").waitForAppearance(timeout: 20), "the Pairing page from the tap")
  }

  // MARK: - Pomocnicze

  /// „Mam link” → link → karta „Sparować z 127.0.0.1?” → „Sparuj”.
  @MainActor
  private func pair(_ app: XCUIApplication, link: String) {
    let haveLink = element(app, "pair.haveLink")
    XCTAssertTrue(haveLink.waitForAppearance(timeout: 10), "„Mam link”")
    haveLink.tap()
    let field = app.textFields["pair.link"]
    XCTAssertTrue(field.waitForAppearance(timeout: 5), "pole linku")
    field.tap()
    field.typeText(link + XCUIKeyboardKey.return.rawValue)
    let title = element(app, "pair.confirm.title")
    XCTAssertTrue(title.waitForAppearance(timeout: 10), "karta potwierdzenia")
    XCTAssertEqual(title.label, "Sparować z 127.0.0.1?")
    let confirm = element(app, "pair.confirm")
    DemoServer.waitUntilStill(confirm)
    confirm.tap()
  }

  /// Ładunek APNs dla przekaźnika hosta (`scripts/ios-push.sh`); czeka, aż host potwierdzi wysyłkę.
  @MainActor
  private func push(_ directory: String, _ payload: String) throws {
    let name = "e3-\(UUID().uuidString.prefix(8))"
    let base = URL(fileURLWithPath: directory, isDirectory: true)
    let draft = base.appending(path: "\(name).tmp")
    try Data(payload.utf8).write(to: draft)
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
}
