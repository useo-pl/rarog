import XCTest

/// Nawigacja terminala przeciw serwerowi demo. Demo nie ma terminala (`termEnabled: false`), więc
/// samego ekranu terminala XCUITest nie otworzy — sprawdza, że wejścia istnieją i przy wyłączonym terminalu mówią
/// powód zamiast milczeć: zakładka-zaproszenie wygaszona, menu „+" z „Nową sesją" i wygaszonym „Nowym terminalem",
/// przycisk „Terminal w oknie" w nagłówku, Cmd+Shift+N, Cmd+F i Cmd+G ze zdaniem pod paskiem, bez zmiany ekranu.
/// Trasę, okna i historię z prawdziwym terminalem pokrywają testy logiki (`TerminalNavigationTests`) i UIKit
/// (`TerminalPopupTests`), a urządzenie — odbiór na iPadzie.
final class TerminalNavUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTerminalEntriesExplainWhenServerHasNoTerminal() throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    DemoServer.reveal(app, "demo-willow").tap()
    let willow = element(app, "tab.demo-willow")
    XCTAssertTrue(wait("exists == true AND selected == true", willow), "sesja willow otwarta")
    let off = "Terminal jest wyłączony na serwerze."

    // Zaproszenie stoi na końcu sesji, wygaszone, z powodem w nazwie; tap mówi powód i nie zmienia ekranu.
    let invite = element(app, "tabs.terminal-invite")
    XCTAssertTrue(invite.waitForAppearance(timeout: 10), "zaproszenie do terminala w pasku")
    XCTAssertEqual(invite.label, off)
    XCTAssertGreaterThan(invite.frame.minX, willow.frame.minX, "terminale stoją za sesjami")
    invite.tap()
    let notice = element(app, "tabs.notice")
    XCTAssertTrue(notice.waitForAppearance(timeout: 5), "zdanie pod paskiem")
    XCTAssertEqual(notice.label, off)
    XCTAssertTrue(willow.isSelected, "ekran bez zmian")
    notice.tap()
    XCTAssertTrue(notice.waitForDisappearance(timeout: 5))

    // „+" to menu: „Nowa sesja" i wygaszony „Nowy terminal".
    let add = element(app, "tabs.add")
    for _ in 0..<4 where add.frame.maxX > app.frame.maxX { DemoServer.dragTabs(app) }
    add.tap()
    let newSession = DemoServer.menuItem(app, id: "tabs.add.session", label: "Nowa sesja")
    let newTerminal = DemoServer.menuItem(app, id: "tabs.add.terminal", label: "Nowy terminal")
    XCTAssertTrue(newSession.waitForAppearance(timeout: 5), "menu „+” ma „Nową sesję”")
    XCTAssertTrue(newTerminal.exists, "menu „+” ma „Nowy terminal”")
    XCTAssertFalse(newTerminal.isEnabled, "bez terminala na serwerze pozycja wygaszona")
    // Zamknięcie menu bez wyboru: tap poza nim (w tytuł nagłówka).
    element(app, "header.title").tap()
    XCTAssertTrue(newSession.waitForDisappearance(timeout: 5), "menu zamknięte bez zakładania")

    // Przycisk „Terminal w oknie" w nagłówku robi to samo co Cmd+F: powód pod paskiem, ekran bez zmian, okna nie ma.
    let popupButton = element(app, "header.terminalPopup")
    XCTAssertTrue(popupButton.waitForAppearance(timeout: 5), "przycisk okna terminala w nagłówku")
    XCTAssertEqual(popupButton.label, "Terminal w oknie")
    popupButton.tap()
    XCTAssertTrue(notice.waitForAppearance(timeout: 5), "przycisk nagłówka mówi powód")
    XCTAssertEqual(notice.label, off)
    XCTAssertFalse(element(app, "terminal.popup").exists, "okna nie ma")
    XCTAssertTrue(willow.isSelected, "ekran bez zmian po przycisku nagłówka")
    notice.tap()
    XCTAssertTrue(notice.waitForDisappearance(timeout: 5))

    // Skróty terminala z klawiatury: powód pod paskiem, ekran bez zmian, okna nie ma.
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
    for (key, modifiers) in [("f", XCUIElement.KeyModifierFlags.command), ("g", .command), ("n", [.command, .shift])] {
      app.typeKey(key, modifierFlags: modifiers)
      XCTAssertTrue(notice.waitForAppearance(timeout: 5), "Cmd+\(key) mówi powód")
      XCTAssertEqual(notice.label, off)
      XCTAssertFalse(element(app, "terminal.popup").exists, "okna nie ma")
      XCTAssertTrue(willow.isSelected, "ekran bez zmian po Cmd+\(key)")
      notice.tap()
      XCTAssertTrue(notice.waitForDisappearance(timeout: 5))
    }
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
