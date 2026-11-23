import XCTest

/// Projekty, pasek zakładek i skróty przeciw serwerowi demo: zapamiętana zakładka projektu,
/// Cmd+1…9, Cmd+L tam i z powrotem, „+" zakłada sesję w katalogu, „×" i Cmd+X dzielą uzbrojenie,
/// Cmd+B zwija listę, a lista zostaje tam, gdzie ją zostawiono.
///
/// Demo: projekt willow ma dwie sesje — `demo-willow-parser` (starsza, done) i `demo-willow`
/// (młodsza, ostatnio aktywna); data-loader ma jedną (`demo-data-loader`, done).
final class ProjectsUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testProjectTabsAndShortcuts() throws {
    let app = try launchLoggedIn()
    let willow = element(app, "tab.demo-willow")
    let parser = element(app, "tab.demo-willow-parser")
    // Drugi projekt to data-loader: sesja bez tury (pracujący `demo-rarog` strumieniuje i XCUITest
    // czekałby minutę na spoczynek apki przed każdym krokiem).
    let other = element(app, "tab.demo-data-loader")

    // Zakładka zapamiętana na urządzeniu: stoję w starszej sesji willow, wychodzę do innego projektu,
    // a Cmd+L wraca do niej, nie do ostatnio aktywnej. Tap w nagłówek projektu tego nie robi:
    // nagłówek zwija i rozwija.
    DemoServer.reveal(app, "demo-willow-parser").tap()
    XCTAssertTrue(waitSelected(parser), "sesja z listy")
    XCTAssertTrue(willow.exists, "siostra na pasku")
    XCTAssertLessThan(parser.frame.minX, willow.frame.minX, "zakładki od najstarszej")
    DemoServer.reveal(app, "demo-data-loader").tap()
    XCTAssertTrue(waitSelected(other), "sesja innego projektu")
    app.typeKey("l", modifierFlags: .command)
    XCTAssertTrue(waitSelected(parser), "Cmd+L wraca do zakładki, w której to urządzenie stało")

    // Cmd+9 = ostatnia zakładka, Cmd+1 = pierwsza pozycja; na koniec stoję w młodszej sesji.
    // (Ostatnia to `demo-willow`, chyba że wcześniejszy test zostawił w projekcie nowszą sesję.)
    app.typeKey("9", modifierFlags: .command)
    XCTAssertTrue(wait("selected == false", parser), "Cmd+9 zeszło z pierwszej zakładki")
    app.typeKey("1", modifierFlags: .command)
    XCTAssertTrue(waitSelected(parser), "Cmd+1")
    app.typeKey("2", modifierFlags: .command)
    XCTAssertTrue(waitSelected(willow), "Cmd+2")

    // Z innego projektu Cmd+L wraca do willow, drugie naciśnięcie z powrotem.
    DemoServer.reveal(app, "demo-data-loader").tap()
    XCTAssertTrue(waitSelected(other), "sesja innego projektu")
    app.typeKey("l", modifierFlags: .command)
    XCTAssertTrue(waitSelected(willow), "Cmd+L do poprzedniego projektu, do zakładki, w której stałem")
    app.typeKey("l", modifierFlags: .command)
    XCTAssertTrue(waitSelected(other), "drugie Cmd+L z powrotem")
  }

  @MainActor
  func testNewSessionAndCloseTwoStep() throws {
    let app = try launchLoggedIn()
    DemoServer.reveal(app, "demo-willow").tap()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-willow")), "projekt willow otwarty")
    let tabs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
    XCTAssertEqual(tabs.count, 2)

    // „+" → „Nowa sesja" zakłada pustą sesję w tym katalogu i otwiera ją.
    DemoServer.addFromPlus(app)
    XCTAssertTrue(waitCount(tabs, 3), "nowa zakładka na pasku")
    let created = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
    XCTAssertTrue(created.waitForAppearance(timeout: 10))
    let createdId = created.identifier
    XCTAssertFalse(["tab.demo-willow", "tab.demo-willow-parser"].contains(createdId), "bieżąca jest nowa sesja")

    // „×" uzbraja („Na pewno?"), a Cmd+X — ten sam stan — potwierdza.
    // Cmd+X to skrót ekranu sesji: fokus stoi w polu wiadomości, które przy klawiaturze sprzętowej
    // dostaje go samo po wejściu w sesję (jak na iPadzie z klawiaturą).
    XCTAssertTrue(app.textViews["composer.field"].waitForAppearance(timeout: 5))
    let close = element(app, "header.close")
    XCTAssertTrue(close.waitForAppearance(timeout: 5))
    close.tap()
    XCTAssertTrue(waitLabel(close, prefix: "Na pewno?"), "pierwsze naciśnięcie uzbraja")
    XCTAssertTrue(element(app, createdId).exists, "nic jeszcze nie zamknięte")
    app.typeKey("x", modifierFlags: .command)
    XCTAssertTrue(element(app, createdId).waitForDisappearance(timeout: 10), "drugie naciśnięcie zamyka")
    XCTAssertTrue(waitSelected(element(app, "tab.demo-willow")), "powrót do ostatnio aktywnej siostry")
  }

  @MainActor
  func testListToggleKeepsPlace() throws {
    let app = try launchLoggedIn()
    // Ostatni wiersz listy (przewinięty na ekran, jeśli trzeba) → sesja.
    let row = DemoServer.reveal(app, "demo-willow-parser")
    row.tap()
    XCTAssertTrue(waitSelected(element(app, "tab.demo-willow-parser")), "sesja otwarta")
    let list = element(app, "session.list")

    app.typeKey("b", modifierFlags: .command)
    XCTAssertTrue(waitHittable(list, false), "Cmd+B zwija listę")
    app.typeKey("b", modifierFlags: .command)
    XCTAssertTrue(waitHittable(list, true), "Cmd+B rozwija listę")
    XCTAssertTrue(
      waitHittable(DemoServer.row(app, "demo-willow-parser"), true), "lista w miejscu, w którym ją zostawiono")
  }

  // MARK: - Pomocnicze

  @MainActor
  private func launchLoggedIn() throws -> XCUIApplication {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    XCTAssertTrue(DemoServer.revealProject(app, "willow").exists, "nagłówek projektu willow w drzewie")
    DemoServer.hideKeyboard(app)
    // Pierwszy klawisz sprzętowy przy wysuniętej klawiaturze ekranowej symulator zużywa na
    // przełączenie się na klawiaturę sprzętową — jałowa strzałka przed skrótami, póki fokusu nie ma.
    app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [])
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitSelected(_ element: XCUIElement) -> Bool {
    wait("exists == true AND selected == true", element)
  }

  private func waitHittable(_ element: XCUIElement, _ hittable: Bool) -> Bool {
    wait(hittable ? "exists == true AND hittable == true" : "exists == false OR hittable == false", element)
  }

  private func waitCount(_ query: XCUIElementQuery, _ count: Int) -> Bool {
    wait("count == \(count)", query, timeout: 15)
  }

  private func waitLabel(_ element: XCUIElement, prefix: String) -> Bool {
    wait("label BEGINSWITH '\(prefix)'", element, timeout: 5)
  }
}
