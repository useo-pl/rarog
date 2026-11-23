import XCTest

/// Dymek o innej sesji NAD PROMPTEM przeciw demo: sesja odbioru (scenariusz `idle`)
/// pracuje i kończy, gdy człowiek ogląda `demo-rarog-stop` — dymek „Skończył" stoi nad polem wiadomości, 8 pt nad
/// kartą pola (transkrypt biegnie pod stopką) i na osi kolumny, a stuknięcie otwiera sesję i gasi dymek. Właściciel: łączność.
/// Sesja z czynnym polem i bez strumienia: przy zgodzie `demo-willow` pola nie ma, a `done` ma kartę
/// stanu.
final class ToastUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testDoneToastStandsAbovePromptAndOpensSession() async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let id = try await control.create("idle", label: "R5 dymek")
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.reveal(app, "demo-rarog-stop").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "pole wiadomości demo-rarog-stop")
    DemoServer.hideKeyboard(app)

    // Realna praca i koniec tury w INNEJ sesji: running → waiting-input daje sygnał „skończył”.
    try await control.emit("delta", sessionId: id, text: "R5 dymek pracuje")
    sleep(1)
    try await control.emit("message", sessionId: id, text: "R5 dymek gotowe")
    let toast = element(app, "toast.session")
    XCTAssertTrue(toast.waitForAppearance(timeout: 10), "dymek o innej sesji")
    XCTAssertTrue(toast.label.hasPrefix("Skończył"), toast.label)
    sleep(1)
    let transcript = element(app, "transcript")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "dymek-nad-promptem"
    shot.lifetime = .keepAlways
    add(shot)
    XCTAssertLessThan(toast.frame.maxY, field.frame.minY, "dymek nad polem: \(toast.frame), pole \(field.frame)")
    // The transcript runs under the foot, so the toast stands 8 pt above the top of the composer card.
    let card = element(app, "composer.card")
    XCTAssertEqual(toast.frame.maxY, card.frame.minY - 8, accuracy: 2,
                   "8 pt nad kartą pola: \(toast.frame), karta \(card.frame)")
    // Dymek na osi kolumny treści.
    // Pomiar w iPad Pro 11": odchyłka 0,0 pt w pionie i poziomie, z listą i bez. Pole tekstu w karcie ma
    // niesymetryczną wstawkę (5 i 10 pt), więc wobec pola tolerancja jest szersza.
    XCTAssertEqual(toast.frame.midX, transcript.frame.midX, accuracy: 1,
                   "dymek na osi kolumny: \(toast.frame), transkrypt \(transcript.frame)")
    XCTAssertEqual(toast.frame.midX, field.frame.midX, accuracy: 3, "dymek nad polem: \(toast.frame), pole \(field.frame)")

    toast.tap()
    XCTAssertTrue(wait("exists == true AND selected == true", element(app, "tab.\(id)")), "stuknięcie otwiera sesję")
    XCTAssertTrue(toast.waitForDisappearance(timeout: 2), "dymek zgasł")
    app.terminate()
    try await control.reset()
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ format: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
