import UIKit
import XCTest

/// Odbiór na prawdziwym procesie apki i prawdziwym serwerze demo: dysk po zabiciu, świeżość
/// oraz duży renderer. Kontroler demo zatrzymuje rzeczywiste ramki/HTTP, nie atrapy magazynu.
final class AcceptanceUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  /// Zimny start z pamięci podręcznej listy bez akcji, potem 401 wylogowuje. 401 bez `device-revoked` zostawia klucz
  /// (serwer mógł zgubić rejestr urządzeń): ekran „Serwer nie rozpoznał tego urządzenia”, a gdy serwer znów
  /// przyjmuje klucz, następny start wraca do listy. Skasowanie PLIKU listy przy 401 sprawdza
  /// `ListCacheTests.clearAndNoRestamp` (RarogCore).
  @MainActor
  func testColdStartCacheHasNoActionsAnd401LogsOut() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 cache")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    open(app, id)
    XCTAssertTrue(app.textViews["composer.field"].isEnabled)
    app.terminate()

    try await control.configure(snapshot: "hold")
    relaunch(app, port: port)
    let cached = DemoServer.row(app, id)
    XCTAssertTrue(cached.waitForAppearance(timeout: 15), "lista odtworzona z dysku bez świeżego snapshotu")
    XCTAssertTrue(wait("label CONTAINS %@", cached, arguments: ["stan sprzed ponownego połączenia"]))
    cached.tap()
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 10))
    XCTAssertFalse(composer.isEnabled, "cached lista nie pozwala wysyłać")
    let close = element(app, "header.close")
    XCTAssertTrue(!close.exists || !close.isEnabled, "cached lista nie zamyka sesji")
    // Wyciszone kontrolki zostają klikalne i mówią powód zamiast działać (UI-4).
    let add = element(app, "tabs.add")
    XCTAssertTrue(add.isEnabled, "„+” mówi powód zamiast znikać")
    DemoServer.addFromPlus(app)
    XCTAssertFalse(element(app, "newSession.sheet").waitForAppearance(timeout: 2), "cached lista nie zakłada sesji")
    let reason = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Łączę z serwerem"))
    // Najpierw arkusz (zdanie stoi w nim), potem tryb (zdanie w dymku) — dymek nie podszywa się pod arkusz.
    element(app, "composer.model").tap()
    let sheet = element(app, "model.sheet")
    XCTAssertTrue(sheet.waitForAppearance(timeout: 5), "arkusz modelu się otwiera")
    XCTAssertTrue(reason.firstMatch.waitForAppearance(timeout: 5), "arkusz modelu mówi powód zamiast zmiany")
    if element(app, "model.dismiss").exists { element(app, "model.dismiss").tap() } else { sheet.swipeDown() }
    XCTAssertTrue(sheet.waitForDisappearance(timeout: 5), "arkusz modelu zamknięty")
    element(app, "composer.mode").tap()
    XCTAssertTrue(reason.firstMatch.waitForAppearance(timeout: 5), "tryb mówi powód")
    let cachedStats = try await control.stays("cached kontrolki niczego nie wysłały") {
      $0.driverSends == 0 && $0.receivedMessages.isEmpty && $0.receivedDecisions.isEmpty
    }
    XCTAssertEqual(cachedStats.driverSends, 0)

    try await control.release("snapshot")
    XCTAssertTrue(wait("enabled == true", composer), "świeża lista i transkrypt odblokowały pole")
    try await control.configure(unauthorized: true)
    app.terminate()
    relaunch(app, port: port)
    XCTAssertTrue(element(app, "pair.unknown.title").waitForAppearance(timeout: 15), "401 wylogowuje")
    XCTAssertFalse(DemoServer.row(app, id).exists)
    app.terminate()
    // Serwer znów przyjmuje klucz: samo 401 klucza nie skasowało, więc start wraca do listy.
    try await control.configure(unauthorized: false)
    relaunch(app, port: port)
    DemoServer.expectList(app)
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testOutboxSurvivesProcessKillBefore202() async throws {
    try await processKill(response: "hold", expectedResponses: 1)
  }

  @MainActor
  func testOutboxSurvivesProcessKillAfter202BeforeEcho() async throws {
    try await processKill(response: "pass", expectedResponses: 0)
  }

  @MainActor
  private func processKill(response: String, expectedResponses: Int) async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "M1 kolejka")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    open(app, id)
    try await control.configure(response: response, echo: "hold")
    let text = "M1 kolejka \(UUID().uuidString)"
    let composer = app.textViews["composer.field"]
    pasteSmallImage(into: composer, app)
    composer.tap()
    composer.typeText(text)
    app.buttons["composer.send"].tap()
    let before = try await control.wait("serwer przyjął jeden wpis, echo jest zatrzymane") {
      $0.acceptedMessages.count == 1 && $0.held.responses == expectedResponses && $0.held.echoes > 0
    }
    let messageId = try XCTUnwrap(before.acceptedMessages.first?.clientMessageId)
    XCTAssertEqual(before.driverSends, 1)
    XCTAssertEqual(before.receivedMessages.count, 1, "jedno tapnięcie Wyślij = jeden POST")
    if response == "pass" {
      // Załącznik od chwili składania body ma pierścień postępu, a kafel mówi czytnikowi „w drodze”.
      // Dopiero obsłużone 202 usuwa progress z reduktora i kafel traci opis stanu (wiersza „w kolejce”
      // nie ma). Samo acceptedMessages/held.responses=0 mówi jedynie o odpowiedzi serwera.
      let tile = element(app, "pending.tile.\(messageId.uppercased()).0")
      XCTAssertTrue(
        wait("exists == true AND (value == nil OR value == %@)", tile, arguments: [""]), "klient obsłużył 202 przed zabiciem")
      XCTAssertFalse(element(app, "pending.status").exists, "zabicie przed timeoutem oczekiwania na echo")
    }
    app.terminate()

    relaunch(app, port: port)
    open(app, id, needsEditable: false)
    if response == "pass" {
      // After a 202 a message with a photo waits 120 s for its echo (`CoreTiming.attachmentUnconfirmedAfter`):
      // the restored entry keeps waiting past the 15 s text deadline. Manual retry of a restored
      // unconfirmed entry is checked by the kill before 202.
      let tile = element(app, "pending.tile.\(messageId.uppercased()).0")
      XCTAssertTrue(tile.waitForAppearance(timeout: 15), "wpis odtworzony z trwałej kolejki")
      XCTAssertFalse(
        element(app, "pending.status").waitForAppearance(timeout: 15), "zdjęcie po 202 czeka na echo dłużej niż tekst")
      let waiting = try await control.stats()
      XCTAssertEqual(waiting.receivedMessages.count, 1, "zimny start nie wysłał drugiego POST")
      try await control.release("all")
      XCTAssertTrue(tile.waitForDisappearance(timeout: 15), "prawdziwe echo odzyskuje wpis")
      try await expectSingleSend(control, messageId: messageId)
      app.terminate()
      try await control.reset()
      return
    }
    XCTAssertTrue(element(app, "pending.status").waitForAppearance(timeout: 15), "wpis odtworzony z trwałej kolejki")
    let retry = element(app, "pending.retry")
    XCTAssertTrue(retry.exists, "niepotwierdzony wpis ma ręczne Ponów")
    // Bez świeżego transkryptu „Ponów” jest wyciszone, ale klikalne: mówi powód i nic nie wysyła (UI-4);
    // liczby żądań niżej łapią każdy drugi POST.
    XCTAssertTrue(retry.isEnabled, "„Ponów” mówi powód zamiast znikać")
    retry.tap()
    let after = try await control.stats()
    // Ponowny POST tego samego id serwer oddaje jako `replayed` BEZ drivera: `driverSends` go nie
    // widzi, więc brak drugiej wysyłki sprawdzają liczby żądań i przyjęć.
    XCTAssertEqual(after.driverSends, 1, "zimny start nie wysyła wpisu sam")
    XCTAssertEqual(after.receivedMessages.count, 1, "zimny start nie wysłał drugiego POST")
    XCTAssertEqual(after.acceptedMessages.count, 1, "zimny start nie dostał drugiego przyjęcia")
    XCTAssertEqual(after.acceptedMessages.first?.clientMessageId, messageId)
    try await control.release("all")
    XCTAssertTrue(element(app, "pending.status").waitForDisappearance(timeout: 15), "prawdziwe echo odzyskuje wpis")
    try await expectSingleSend(control, messageId: messageId)
    app.terminate()
    try await control.reset()
  }

  /// After recovery the server saw exactly one POST, one acceptance and one driver send of this message.
  @MainActor
  private func expectSingleSend(_ control: DemoControl, messageId: String) async throws {
    let recoveredStats = try await control.stays("po odzyskaniu nie ma drugiego POST") {
      $0.receivedMessages.count == 1 && $0.acceptedMessages.count == 1
    }
    XCTAssertEqual(recoveredStats.driverSends, 1, "odtworzenie nie zleciło drugiej wysyłki")
    XCTAssertEqual(recoveredStats.receivedMessages.count, 1, "odtworzenie nie wysłało drugiego POST")
    XCTAssertEqual(recoveredStats.acceptedMessages.count, 1, "odtworzenie nie dostało drugiego przyjęcia")
    XCTAssertEqual(recoveredStats.acceptedMessages.first?.clientMessageId, messageId)
  }

  @MainActor
  func testDigitsStayInCustomAnswerAndTerminalOnlyCannotSend() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("question", label: "M1 cyfry")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    open(app, id, needsEditable: false)
    let terminalOnly = element(app, "question.option.0.1")
    XCTAssertTrue(terminalOnly.waitForAppearance(timeout: 10))
    XCTAssertFalse(terminalOnly.isEnabled, "opcja należąca do terminala pozostaje wygaszona")
    element(app, "question.own.0").tap()
    let custom = element(app, "question.custom.0")
    XCTAssertTrue(custom.waitForAppearance(timeout: 10))
    custom.tap()
    app.typeKey("1", modifierFlags: [])
    app.typeKey("2", modifierFlags: [])
    XCTAssertTrue(wait("value CONTAINS %@", custom, arguments: ["12"]), "cyfry w UITextInput są tekstem")
    let typingStats = try await control.stats()
    XCTAssertEqual(typingStats.receivedAnswers.count, 0, "pisanie nie wysłało POST odpowiedzi")
    XCTAssertEqual(typingStats.driverAnswers.count, 0, "pisanie nie wysłało odpowiedzi")
    try await control.emit("clear-question", sessionId: id)
    XCTAssertTrue(element(app, "card.question.m1-question").waitForDisappearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    app.typeKey("1", modifierFlags: [])
    // Odpowiedź na zniknięte pytanie dostałaby 410 bez drivera: patrzymy na same żądania.
    let dismissedStats = try await control.stays("zniknięta karta nie wysłała POST") { $0.receivedAnswers.isEmpty }
    XCTAssertEqual(dismissedStats.receivedAnswers.count, 0, "zniknięta karta nie wysłała POST")
    XCTAssertEqual(dismissedStats.driverAnswers.count, 0)
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testCannotAllowCardHasNoApprovalButton() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("cannot-allow", label: "M1 terminal")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    open(app, id, needsEditable: false)
    let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.permission.'")).firstMatch
    XCTAssertTrue(card.waitForAppearance(timeout: 10))
    XCTAssertFalse(app.buttons["card.allow"].exists)
    let stats = try await control.stats()
    XCTAssertEqual(stats.receivedDecisions.count, 0)
    XCTAssertEqual(stats.driverDecisions, 0)
    app.terminate()
    try await control.reset()
  }

  @MainActor
  func testFiveHundredTableMessagesKeepPlaceWhileStreaming() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("stress500", label: "M1 500 tabel")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    open(app, id)
    let stats = try await control.stats()
    XCTAssertEqual(stats.transcriptMessages, 500)
    let transcript = element(app, "transcript")
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10))
    DemoServer.hideKeyboard(app)
    // Początek strumienia ma dość treści, żeby nadal był widoczny po odpięciu o 60–100 pt.
    // Drugą deltę potwierdzi zmiana tekstu tej rzeczywistej komórki, bez skoku na dno.
    let initialStream = (1...8).map { "M1 strumień \($0)" }.joined(separator: "\n\n")
    try await control.emit("delta", sessionId: id, text: initialStream)
    let streaming = element(app, "message.open")
    XCTAssertTrue(wait("label CONTAINS %@", streaming, arguments: ["M1 strumień 8"]), "pierwsza delta dotarła do renderera")
    let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
    let distance = max(60, min(100, transcript.frame.height * 0.2))
    // Wolno i z przytrzymaniem: zwykłe puszczenie palca dodaje rozpęd, który (przy klawiaturze
    // ekranowej) wywozi płynącą wiadomość poza ekran — zmierzone ~300 pt zamiast 100.
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)),
                withVelocity: .slow, thenHoldForDuration: 0.3)
    let jump = element(app, "transcript.jump")
    XCTAssertTrue(jump.waitForAppearance(timeout: 10), "ręczne przewinięcie odpina transkrypt")
    XCTAssertTrue(streaming.exists, "płynąca wiadomość pozostaje widoczna przy odpiętym transkrypcie")
    let visibleMessages = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'message.m'"))
    let anchor = try XCTUnwrap(visibleMessages.allElementsBoundByIndex.first { $0.isHittable })
    let anchorID = anchor.identifier
    let before = anchor.frame
    let append = "M1 dopisek \(UUID().uuidString)"
    try await control.emit("delta", sessionId: id, text: "\n\n\(append)")
    XCTAssertTrue(wait("label CONTAINS %@", streaming, arguments: [append]), "druga delta dotarła przez SSE do renderera")
    XCTAssertTrue(jump.exists, "streaming nie przypiął czytanego transkryptu")
    let after = element(app, anchorID)
    XCTAssertTrue(after.exists, "czytana wiadomość pozostała w widoku")
    XCTAssertEqual(after.frame.minY, before.minY, accuracy: 8, "dopisek nie przesunął miejsca czytania")
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "M1-500-tabel-streaming"
    attachment.lifetime = .keepAlways
    add(attachment)
    jump.tap()
    XCTAssertTrue(element(app, "message.open").waitForAppearance(timeout: 10), "płynąca wiadomość jest wyrenderowana")
    try await control.emit("message", sessionId: id)
    XCTAssertTrue(element(app, "message.open").waitForDisappearance(timeout: 10), "message domknęła streaming")
    app.terminate()
    try await control.reset()
  }

  // MARK: - Prawdziwy proces i UI

  @MainActor
  private func pasteSmallImage(into field: XCUIElement, _ app: XCUIApplication) {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64))
    UIPasteboard.general.image = renderer.image { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
    }
    field.tap()
    app.typeKey("v", modifierFlags: .command)
    let tile = element(app, "composer.attachment.0")
    if !tile.waitForAppearance(timeout: 5) {
      field.press(forDuration: 1.2)
      for label in ["Paste", "Wklej"] where app.menuItems[label].waitForAppearance(timeout: 2) {
        app.menuItems[label].tap()
        break
      }
    }
    XCTAssertTrue(tile.waitForAppearance(timeout: 10), "załącznik daje rzeczywisty klientowy postęp wysyłki")
  }

  @MainActor
  private func relaunch(_ app: XCUIApplication, port: Int) {
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment.removeValue(forKey: "RAROG_UI_TEST_RESET")
    app.launch()
  }

  @MainActor
  private func open(_ app: XCUIApplication, _ sessionId: String, needsEditable: Bool = true) {
    XCTAssertTrue(element(app, "session.list").waitForAppearance(timeout: 15))
    let row = DemoServer.reveal(app, sessionId)
    XCTAssertTrue(row.exists, "sesja na przewiniętej liście")
    row.tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 15))
    if needsEditable { XCTAssertTrue(wait("enabled == true", field)) }
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any)[identifier].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, arguments: [Any] = [], timeout: TimeInterval = 15) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: predicate, argumentArray: arguments), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
