import XCTest

/// Zdania serwera w apce (`docs/localization.md`, „Server sentences in the app”) przeciw serwerowi demo, po
/// polsku i po angielsku. Serwer wysyła angielski tekst i kod zdania (`*Ref`); apka składa zdanie w swoim języku.
///
/// Demo: `demo-map-view` stoi na limicie planu — `stateDetail` to token `resetAt=<ISO>`, `stateDetailRef` to kod
/// `state.limit-reached` z chwilą w `args[0]` (seed: chwila startu demo + 2 h); karta stanu zaczyna się od zdania
/// limitu z lokalną godziną tej chwili. `demo-pipe-link` czeka na wznowienie, a serwer demo odmawia (409
/// `rest.bad-state`), bo seed nie ma zapamiętanej rozmowy silnika. Odmowa niczego nie zmienia, więc test nie
/// psuje seedów wspólnych dla całego przebiegu.
///
/// Godzinę limitu test wylicza z czasu pracy serwera demo (`/health`, `uptime`): seed powstaje między startem demo
/// a teraz (demo potrafi zasiać sesje od nowa), więc godzina na karcie leży w oknie [start + 2 h, teraz + 2 h].
final class ServerSentenceUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testLimitSentenceInPolish() throws {
    try expectLimitSentence(language: .pl, prefix: "Limit planu — spróbuj po ", locale: "pl_PL")
  }

  @MainActor
  func testLimitSentenceInEnglish() throws {
    try expectLimitSentence(language: .en, prefix: "Plan limit reached. Try again after ", locale: "en_US")
  }

  @MainActor
  func testResumeRefusalInPolish() throws {
    try expectResumeRefusal(language: .pl, "Sesja jest w stanie, który nie pozwala na tę akcję.")
  }

  @MainActor
  func testResumeRefusalInEnglish() throws {
    try expectResumeRefusal(language: .en, "The session is in a state that doesn't allow this action.")
  }

  // MARK: - Przypadki

  /// Karta stanu `demo-map-view` zaczyna się od zdania limitu z godziną `args[0]` w regionie języka apki.
  @MainActor
  private func expectLimitSentence(language: DemoServer.AppLanguage, prefix: String, locale: String) throws {
    let port = try DemoServer.requirePort()
    let window = try resetWindow(port: port)
    let app = launchPaired(port: port, language: language)
    DemoServer.reveal(app, "demo-map-view").tap()
    XCTAssertTrue(element(app, "card.state").waitForAppearance(timeout: 10), "karta stanu")
    let label = element(app, "state.text").label
    XCTAssertTrue(label.hasPrefix(prefix), "zdanie limitu w języku apki: \(label)")
    let rest = label.dropFirst(prefix.count)
    let clock = String(rest.prefix { $0 != "." })
    XCTAssertTrue(rest.dropFirst(clock.count).hasPrefix("."), "zdanie limitu kończy się kropką: \(label)")
    XCTAssertTrue(
      Self.clocks(in: window, locale: Locale(identifier: locale)).contains(clock),
      "godzina „\(clock)” nie leży w oknie chwili limitu \(window)")
    snapshot(app, "zdanie-limitu-\(language.rawValue)")
  }

  /// „Wznów” na `demo-pipe-link` → 409 serwera, na karcie jego zdanie w języku apki.
  @MainActor
  private func expectResumeRefusal(language: DemoServer.AppLanguage, _ sentence: String) throws {
    let port = try DemoServer.requirePort()
    let app = launchPaired(port: port, language: language)
    DemoServer.reveal(app, "demo-pipe-link").tap()
    XCTAssertTrue(element(app, "card.state").waitForAppearance(timeout: 10), "karta stanu")
    let resume = element(app, "state.resume")
    XCTAssertTrue(resume.waitForAppearance(timeout: 5), "„Wznów”")
    resume.tap()
    let result = element(app, "state.result")
    XCTAssertTrue(result.waitForAppearance(timeout: 10), "zdanie serwera po odmowie")
    XCTAssertEqual(result.label, sentence)
    snapshot(app, "odmowa-wznowienia-\(language.rawValue)")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func launchPaired(port: Int, language: DemoServer.AppLanguage) -> XCUIApplication {
    let app = DemoServer.launch(port: port, language: language)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    return app
  }

  /// Okno chwili limitu seedu: od startu demo + 2 h do teraz + 2 h, z minutą zapasu na zaokrąglenie godziny.
  private func resetWindow(port: Int) throws -> ClosedRange<Date> {
    let now = Date()
    let uptime = try Self.uptime(port: port)
    let lead: TimeInterval = 2 * 60 * 60
    return now.addingTimeInterval(lead - uptime - 60)...now.addingTimeInterval(lead + 60)
  }

  /// Godziny w języku `locale` dla każdej minuty okna, w obu cyklach zegara. Cykl wybiera apka z preferencji
  /// urządzenia (`CopyLocale`): świeży symulator dziedziczy z Maca `AppleICUForce24HourTime`, a `-AppleLocale`
  /// zmienia tylko region, więc `en_US` bywa na symulatorze 24-godzinny. Regułę cyklu sprawdzają testy `CopyLocale`.
  private static func clocks(in window: ClosedRange<Date>, locale: Locale) -> Set<String> {
    let formatters = ["Hmm", "hmm"].map { template in
      let formatter = DateFormatter()
      formatter.locale = locale
      formatter.timeZone = .current
      formatter.calendar = Calendar(identifier: .gregorian)
      formatter.setLocalizedDateFormatFromTemplate(template)
      return formatter
    }
    var clocks: Set<String> = []
    var moment = window.lowerBound
    while moment <= window.upperBound {
      for formatter in formatters { clocks.insert(formatter.string(from: moment)) }
      moment.addTimeInterval(60)
    }
    return clocks
  }

  /// Czas pracy serwera demo w sekundach (`GET /health`, bez klucza urządzenia).
  private static func uptime(port: Int) throws -> TimeInterval {
    let request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/health")))
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var body: Data?
    URLSession.shared.dataTask(with: request) { data, _, _ in
      body = data
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    let object = try body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let seconds = try XCTUnwrap(object?["uptime"] as? NSNumber, "demo bez `uptime` w /health")
    return seconds.doubleValue
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
