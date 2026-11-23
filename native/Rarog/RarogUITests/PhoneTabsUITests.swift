import XCTest

/// Pasek zakładek na iPhonie. W stosie (`compact`) wejście z listy wpycha ekran sesji, więc pasek powstaje od nowa —
/// bieżąca zakładka ma stanąć na środku paska, na ile pozwala przewinięcie, i zawsze cała na ekranie.
///
/// Pasek dłuższy od ekranu daje projekt `demo-willow` z sesjami dołożonymi przez „+” (stoją na końcu, za siostrami).
/// Demo ma sufit paneli, a w pełnej bramce wcześniejsze klasy zmieniają jego stan: gdy pasek nie wyjdzie poza ekran,
/// test jawnie się pomija.
final class PhoneTabsUITests: XCTestCase {
  private let project = "demo-willow"
  private let first = "demo-willow-parser"

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testCurrentTabVisibleAfterEnteringFromList() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("stos lista → szczegół jest na iPhonie; iPad trzyma listę obok szczegółu")
    }
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)

    enter(app, project)
    let add = element(app, "tabs.add")
    XCTAssertTrue(add.waitForAppearance(timeout: 10), "pasek zakładek")
    // Dwie sesje więcej, o ile demo ma wolne panele: zakładki dołożone przez „+” stoją na końcu paska.
    for _ in 0..<2 {
      let before = tabs(app).count
      for _ in 0..<4 where add.frame.maxX > app.frame.maxX { DemoServer.dragTabs(app) }
      DemoServer.addFromPlus(app)
      guard wait(15, { self.tabs(app).count == before + 1 }) else { break }
      DemoServer.hideKeyboard(app)
    }
    // Ostatnia zakładka sesji: najdalej w prawo. Demo nie ma żywych terminali, a zaproszenie terminala ma identyfikator
    // spoza `tab.` (`tabs.terminal-invite`), więc każde `tab.` jest tu sesją z wierszem na liście.
    let ids = tabs(app).map { (id: String($0.identifier.dropFirst("tab.".count)), x: $0.frame.minX) }
      .sorted { $0.x < $1.x }.map(\.id)
    let last = try XCTUnwrap(ids.last, "zakładki sesji")
    back(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista po „wstecz”")

    // Pierwsza zakładka trzyma pasek w pozycji startowej: ostatnia musi wtedy wystawać za prawą krawędź, inaczej test
    // niczego nie sprawdza.
    enter(app, first)
    assertCurrentVisible(app, first)
    let hidden = element(app, "tab.\(last)").frame
    print(String(format: "zakładki: %@ w pozycji startowej od %.1f do %.1f pt", last, hidden.minX, hidden.maxX))
    guard hidden.maxX > app.frame.width + 1 else {
      throw XCTSkip("ostatnia zakładka (\(last)) mieści się w pozycji startowej: \(hidden) — za mało zakładek w demo")
    }
    back(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista po „wstecz”")

    // Ostatnia zakładka stoi za prawą krawędzią paska w pozycji startowej; pierwsza — przy lewej.
    for id in [last, first, last] {
      enter(app, id)
      assertCurrentVisible(app, id)
      back(app)
      XCTAssertTrue(DemoServer.listShown(app), "lista po „wstecz”")
    }
  }

  // MARK: - Pomocnicze

  /// Bieżąca zakładka cała na ekranie i zaznaczona; środek w osi ekranu, chyba że pasek doszedł do końca.
  @MainActor
  private func assertCurrentVisible(_ app: XCUIApplication, _ id: String) {
    let tab = element(app, "tab.\(id)")
    XCTAssertTrue(wait(8) { tab.exists && tab.isSelected }, "zakładka \(id) bieżąca")
    // Środkowanie bez animacji, ale pasek bywa układany jeszcze chwilę po wepchnięciu ekranu na stos.
    DemoServer.waitUntilStill(tab)
    let frame = tab.frame
    let width = app.frame.width
    let add = element(app, "tabs.add").frame
    print(String(format: "zakładki: %@ od %.1f do %.1f pt, środek %.1f (ekran %.1f), „+” do %.1f",
                 id, frame.minX, frame.maxX, frame.midX, width / 2, add.maxX))
    XCTAssertGreaterThanOrEqual(frame.minX, 0, "\(id): lewa krawędź na ekranie (\(frame))")
    XCTAssertLessThanOrEqual(frame.maxX, width, "\(id): prawa krawędź na ekranie (\(frame))")
    // Środek, o ile pozwala przewinięcie: pierwsza zakładka stoi przy lewej krawędzi, a gdy „+” stoi przy prawej,
    // pasek jest na końcu i dalej przewinąć się nie da.
    let atStart = frame.minX <= 16
    let atEnd = add.maxX <= width + 1
    if !atStart, !atEnd {
      XCTAssertEqual(frame.midX, width / 2, accuracy: 4, "\(id): na środku paska")
    }
  }

  @MainActor
  private func enter(_ app: XCUIApplication, _ id: String) {
    DemoServer.hideKeyboard(app)
    let row = DemoServer.reveal(app, id)
    XCTAssertTrue(row.waitForAppearance(timeout: 10), "wiersz \(id)")
    row.tap()
  }

  /// Systemowy „wstecz” w pasku nawigacji szczegółu (pierwszy przycisk paska, jak w `PhoneTerminalUITests`).
  @MainActor
  private func back(_ app: XCUIApplication) {
    DemoServer.hideKeyboard(app)
    let button = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(button.waitForAppearance(timeout: 5), "przycisk „wstecz”")
    button.tap()
  }

  @MainActor
  private func tabs(_ app: XCUIApplication) -> [XCUIElement] {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tab.'"))
      .allElementsBoundByIndex
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  @MainActor
  private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return condition()
  }
}
