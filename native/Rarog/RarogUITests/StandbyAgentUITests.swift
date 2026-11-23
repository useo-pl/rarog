import UIKit
import XCTest

/// Trzy stany subagenta w sekcji „w tle" przeciw sterowanemu scenariuszowi demo `standby`
/// (`server/src/demo/scenarios.ts`): sesja bezczynna z jednym subagentem, który skończył turę i czeka na
/// własne komendy w tle (stoi od 18 min, dwie komendy, druga bez treści), i notką o postoju w transkrypcie.
/// Na iPadzie sekcja jest popoverem pigułki, na iPhonie arkuszem. Test idzie tą samą drogą co
/// `WorkflowPanelUITests`, więc ma działać na obu; sprawdzony na iPadzie, na iPhonie jeszcze nie.
final class StandbyAgentUITests: XCTestCase {
  private let task = "m1-standby"
  /// Opis subagenta w scenariuszu. Nie `name`: tak nazywa się właściwość `XCTestCase`.
  private let agentName = "Przegląd pokrycia testami"

  override func setUp() { continueAfterFailure = false }

  /// Postój: wiersz listy mówi „czeka: subagent · …" i nie udaje pracy, pigułka liczy zadanie, wiersz agenta
  /// ma stan „czeka na własne zadanie" z licznikiem od postoju, a pod nim „czeka na:" i komendy → `agent-wake`
  /// (agent rusza sam): wiersz wraca do pracującego, skończona komenda schodzi, druga stoi bez „czeka na".
  @MainActor
  func testWaitingAgentShowsStateAndOwnCommands() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("standby", label: "M1 postój")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))

    // Lista: linia etapu mówi, że subagent czeka; słowo „pracuje w tle" nie pada.
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(wait("label CONTAINS %@", row, arguments: ["czeka: subagent · \(agentName)"]), "linia etapu: \(row.label)")
    XCTAssertFalse(row.label.contains("pracuje w tle"), "czekający subagent nie robi z sesji pracującej: \(row.label)")
    XCTAssertFalse(row.label.contains("w tle: "), row.label)
    snapshot(app, "lista")

    // Sesja: notka o postoju w transkrypcie i pigułka, która liczy zadanie i mówi jego stan.
    openSession(app, id)
    let notice = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'harness.' AND label CONTAINS %@", "czeka na własne zadanie w tle"))
      .firstMatch
    XCTAssertTrue(notice.waitForAppearance(timeout: 15), "notka o postoju")
    XCTAssertTrue(notice.label.contains("Subagent czeka na własne zadanie w tle — „\(agentName)”."), notice.label)
    let pill = element(app, "header.background")
    XCTAssertTrue(pill.waitForAppearance(timeout: 15), "pigułka „w tle”")
    XCTAssertEqual(pill.label, "1 zadanie w tle: subagent \(agentName) czeka na własne zadanie")
    revealPanelRoom(app)
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("telefon: pigułka „w tle” otwiera panel sesji jako arkusz, dymek jest tylko na iPadzie")
    }
    pill.tap()
    let panel = element(app, "header.background.panel")
    XCTAssertTrue(panel.waitForAppearance(timeout: 10), "sekcja „w tle”")

    // Wiersz agenta: stan słowem i licznik od początku postoju. Scenariusz stawia postój 18 min przed `create`,
    // pierwszą komendę 21 min, a start agenta 25 min. Zegary tykają, a przebieg pod obciążeniem bywa kilka razy
    // wolniejszy, więc test porównuje liczniki ZE SOBĄ, nie z liczbą.
    let agent = element(app, "header.background.task.\(task)")
    XCTAssertTrue(agent.waitForAppearance(timeout: 10), "wiersz subagenta")
    XCTAssertTrue(agent.label.hasPrefix("subagent \(agentName), czeka na własne zadanie od "), agent.label)
    XCTAssertTrue(agent.label.hasSuffix("general-purpose · Opus 5.5"), agent.label)
    let waited = try XCTUnwrap(minutes(agent.label), agent.label)
    XCTAssertGreaterThanOrEqual(waited, 18, agent.label)
    // Własne komendy pod agentem: na nie czeka. Druga nie ma treści — samo słowo „komenda".
    let first = own(app, "cmd-1")
    let second = own(app, "cmd-2")
    XCTAssertTrue(first.waitForAppearance(timeout: 5), "własna komenda agenta")
    // Wiersz mówi same narzędzia komendy (`pnpm test -- --coverage` → `pnpm test`); pełną ma „Kopiuj komendę".
    XCTAssertTrue(first.label.hasPrefix("czeka na: pnpm test, od "), first.label)
    XCTAssertTrue(second.label.hasPrefix("czeka na: komenda, od "), second.label)
    // Komenda ruszyła 3 min przed postojem. Licznik agenta liczony od startu byłby o 4 min DŁUŻSZY od niej.
    let firstRuns = try XCTUnwrap(minutes(first.label), first.label)
    XCTAssertTrue((2...4).contains(firstRuns - waited), "licznik agenta od postoju: \(agent.label) / \(first.label)")
    XCTAssertTrue(panel.frame.contains(first.frame) && panel.frame.contains(second.frame), "komendy widać bez przewijania")
    XCTAssertGreaterThan(first.frame.minY, agent.frame.maxY - 1, "komendy stoją pod wierszem agenta")
    XCTAssertGreaterThan(first.frame.minX, agent.frame.minX, "i są pod nim wcięte")
    settle()
    snapshot(app, "panel-czeka")

    // Agent rusza sam: nowa ramka listy bez `waitingSince` i bez skończonej komendy.
    try await control.emit("agent-wake", sessionId: id)
    XCTAssertTrue(wait("NOT (label CONTAINS %@)", agent, arguments: ["czeka"]), "wiersz wraca do pracującego: \(agent.label)")
    // Start agenta leży 7 min przed postojem: licznik przeskakuje w górę, bo znów liczy od startu.
    let worked = try XCTUnwrap(minutes(agent.label), agent.label)
    XCTAssertGreaterThanOrEqual(worked - waited, 6, "licznik znów od startu, nie od postoju: \(agent.label)")
    XCTAssertTrue(first.waitForDisappearance(timeout: 5), "skończona komenda schodzi")
    XCTAssertTrue(wait("label BEGINSWITH %@", second, arguments: ["komenda subagenta, od "]),
      "komenda agenta, który pracuje, stoi bez „czeka na”: \(second.label)")
    settle()
    snapshot(app, "panel-pracuje")
    // Sprzątanie w treści testu, jak w `InspectorUITests`: asynchroniczny blok sprzątania po porażce zawiesił
    // przebieg, a każdy test na kontroli demo i tak zaczyna od `reset`.
    app.terminate()
    try await control.reset()
  }

  // MARK: - Pomocnicze

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func own(_ app: XCUIApplication, _ suffix: String) -> XCUIElement {
    element(app, "header.background.task.\(task).own.\(task)-\(suffix)")
  }

  /// Minuty z etykiety czytnika („od 18 minut", „25 minut"): liczba przed słowem „minut…". `nil`, gdy etykieta
  /// mówi inną jednostką (scenariusz starszy niż godzina).
  private func minutes(_ label: String) -> Int? {
    let words = label.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\u{00A0}" || $0 == "\u{202F}" })
    guard let unit = words.firstIndex(where: { $0.hasPrefix("minut") }), unit > 0 else { return nil }
    return Int(words[unit - 1])
  }

  private func wait(_ predicate: String, _ object: Any, arguments: [Any] = [], timeout: TimeInterval = 15) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: predicate, argumentArray: arguments), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// Sesja z listy; ta sama droga co w `WorkflowPanelUITests` (`DemoServer.openRow`: zwinięty projekt rozwija
  /// nagłówek, wiersz nieklikalny dla XCUITest — stuknięcie po współrzędnych).
  @MainActor
  private func openSession(_ app: XCUIApplication, _ id: String) {
    DemoServer.openRow(app, id, project: "rarog")
  }

  /// Pole wiadomości bierze fokus samo, a klawiatura ekranowa symulatora zabiera popoverowi pół
  /// wysokości — chowamy ją przed otwarciem sekcji.
  @MainActor
  private func revealPanelRoom(_ app: XCUIApplication) {
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 15))
    settle()
    DemoServer.hideKeyboard(app)
  }

  /// Chwila na koniec animacji (popover rosnący do treści) przed pomiarem ramek i zrzutem.
  private func settle() {
    Thread.sleep(forTimeInterval: 0.8)
  }

  @MainActor
  private func snapshot(_ app: XCUIApplication, _ name: String) {
    let device = UIDevice.current.userInterfaceIdiom == .phone ? "iphone" : "ipad"
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "standby-\(device)-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
