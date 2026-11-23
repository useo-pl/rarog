import XCTest

/// Expanding and collapsing a project with a real tap leaves its header in place. The selected session stands above
/// the project, fully visible and not in the middle: the case in which an anchor that centres the row moves the list.
/// A tap on the header's content goes through the list selection (`SessionListView.treeSelection`), which a UIKit
/// test cannot fire; the arrow and a selected session under the project are covered by `ProjectTreeExpandAnchorTests`
/// (UIKit).
///
/// The anchor needs a list longer than its visible part: iPad in landscape and accessibility text size M
/// (`UICTContentSizeCategoryAccessibilityM`; at the regular size the demo list overflows the visible part by ~90 pt).
/// The test creates no session. Without the anchor (iPad Pro 11-inch simulator, iOS 27.0) the header moves −78.5 pt
/// on a tap on the content and on the arrow alike, and the selected session lands in the middle; with the anchor on
/// for one project only, this test fails at its first step: 400.0 → 466.0 pt.
final class ProjectTreeExpandUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testHeaderStaysWhenProjectTogglesByTap() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("lista obok szczegółu (iPad)") }
    let port = try DemoServer.requirePort()
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = DemoServer.makeApp()
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)

    // Lista nie na samej górze: jedno przeciągnięcie o jedną trzecią widocznej części, które musi ją przesunąć.
    let list = element(app, "session.list")
    var visible = visibleArea(app, list)
    // Po identyfikatorze: element z `allElementsBoundByIndex` po przewinięciu wskazywałby inny nagłówek.
    let probe = element(app, try XCTUnwrap(lowestHeader(app, visible), "nagłówek projektu w widocznej części"))
    let probeBefore = probe.frame.minY
    drag(app, list, visible, by: -visible.height / 3)
    DemoServer.waitUntilStill(probe)
    XCTAssertLessThan(probe.frame.minY - probeBefore, -visible.height / 4,
                      "lista dłuższa od widocznej części: przeciągnięcie przesunęło nagłówek \(probe.identifier)")
    visible = visibleArea(app, list)
    let project = try XCTUnwrap(middleProject(app, visible), "projekt z agentami w środku widocznej części")
    let header = element(app, "project.\(project)")
    let chevron = element(app, "tree.toggle.\(project)")
    center(app, list, header)

    // Zaznaczona sesja nad projektem, cała widoczna i co najmniej 40 pt od środka widocznej części.
    visible = visibleArea(app, list)
    let selected = try XCTUnwrap(rowAbove(app, visible, header: header), "wiersz sesji cały nad nagłówkiem \(project)")
    let row = DemoServer.row(app, selected)
    row.tap()
    XCTAssertTrue(wait("exists == true AND selected == true", element(app, "tab.\(selected)")), "sesja \(selected)")
    DemoServer.hideKeyboard(app)
    DemoServer.waitUntilStill(header)
    if abs(row.frame.midY - visible.midY) < 40 {
      drag(app, list, visible, by: -70)
      DemoServer.waitUntilStill(header)
    }
    XCTAssertTrue(visible.contains(row.frame), "zaznaczona cała widoczna: \(row.frame) w \(visible)")
    XCTAssertGreaterThanOrEqual(abs(row.frame.midY - visible.midY), 40, "zaznaczona nie na środku: \(row.frame)")

    // Treść nagłówka rozwija, strzałka zwija, strzałka rozwija, treść nagłówka zwija — za każdym razem nagłówek stoi.
    var steps: [String] = []
    for (target, expanded, label) in [
      (header, true, "stuknięcie w treść, rozwinięcie"), (chevron, false, "strzałka, zwinięcie"),
      (chevron, true, "strzałka, rozwinięcie"), (header, false, "stuknięcie w treść, zwinięcie"),
    ] {
      let before = header.frame.minY
      target.tap()
      XCTAssertTrue(
        wait(expanded ? "value == 'rozwinięty'" : "value BEGINSWITH 'zwinięty'", header),
        "\(label): \(header.value ?? "—")")
      DemoServer.waitUntilStill(header)
      let after = header.exists ? header.frame.minY : .nan
      steps.append("\(label) \(fmt(before)) → \(fmt(after))")
      XCTAssertEqual(after, before, accuracy: 1, "\(label): nagłówek \(project) \(fmt(before)) → \(fmt(after))")
    }
    print("drzewo UI: P \(project), zaznaczona \(selected) | \(steps.joined(separator: " | "))")
  }

  /// Najniższy nagłówek projektu cały w widocznej części (sonda przesunięcia listy: po przeciągnięciu w górę o jedną
  /// trzecią zostaje na ekranie).
  @MainActor
  private func lowestHeader(_ app: XCUIApplication, _ visible: CGRect) -> String? {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'project.'"))
      .allElementsBoundByIndex
      .filter { $0.exists && visible.contains($0.frame) }
      .max { $0.frame.minY < $1.frame.minY }?
      .identifier
  }

  /// Projekt z agentami najbliżej środka widocznej części, którego zwinięcie chowa wiersze („zwinięty, widać N z M”,
  /// N < M): sesje pilne i pracujące stoją także w zwiniętym projekcie, więc rozwinięcie takiego projektu nic by nie
  /// wstawiło. Zostaje zwinięty.
  @MainActor
  private func middleProject(_ app: XCUIApplication, _ visible: CGRect) -> String? {
    let headers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'project.'"))
      .allElementsBoundByIndex
      .filter { $0.exists && visible.contains($0.frame) }
      .compactMap { header -> (String, CGRect)? in
        let name = String(header.identifier.dropFirst("project.".count))
        guard element(app, "tree.toggle.\(name)").exists else { return nil }
        return (name, header.frame)
      }
    let byDistance = headers.sorted { abs($0.1.midY - visible.midY) < abs($1.1.midY - visible.midY) }
    for (name, _) in byDistance {
      collapse(app, name)
      let value = element(app, "project.\(name)").value as? String ?? ""
      let numbers = value.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
      if numbers.count == 2, numbers[0] < numbers[1] { return name }
      element(app, "tree.toggle.\(name)").tap()
      XCTAssertTrue(wait("value == 'rozwinięty'", element(app, "project.\(name)")), "rozwinięcie \(name)")
    }
    return nil
  }

  /// Wiersz sesji cały w widocznej części, najbliżej nad nagłówkiem.
  @MainActor
  private func rowAbove(_ app: XCUIApplication, _ visible: CGRect, header: XCUIElement) -> String? {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'session.' AND identifier != 'session.list'"))
      .allElementsBoundByIndex
      .filter { $0.exists && visible.contains($0.frame) && $0.frame.maxY <= header.frame.minY }
      .max { $0.frame.minY < $1.frame.minY }
      .map { String($0.identifier.dropFirst("session.".count)) }
  }

  /// Zwija projekt strzałką, gdy jest rozwinięty, i czeka na spoczynek nagłówka.
  @MainActor
  private func collapse(_ app: XCUIApplication, _ project: String) {
    let header = element(app, "project.\(project)")
    if (header.value as? String) == "rozwinięty" {
      element(app, "tree.toggle.\(project)").tap()
      XCTAssertTrue(wait("value BEGINSWITH 'zwinięty'", header), "zwinięcie \(project)")
    }
    DemoServer.waitUntilStill(header)
  }

  /// Nagłówek w środku widocznej części (do 30 pt), przeciągnięciem bez rozpędu.
  @MainActor
  private func center(_ app: XCUIApplication, _ list: XCUIElement, _ header: XCUIElement) {
    for _ in 0..<3 {
      let visible = visibleArea(app, list)
      let delta = visible.midY - header.frame.midY
      if abs(delta) < 30 { break }
      drag(app, list, visible, by: delta)
      DemoServer.waitUntilStill(header)
    }
  }

  /// Przeciągnięcie palcem wewnątrz widocznej części z przytrzymaniem na końcu (bez rozpędu); dodatnie = treść w dół.
  @MainActor
  private func drag(_ app: XCUIApplication, _ list: XCUIElement, _ visible: CGRect, by delta: CGFloat) {
    let limit = max(40, visible.height / 2 - 24)
    let step = max(-limit, min(limit, delta))
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let start = origin.withOffset(CGVector(dx: list.frame.midX, dy: visible.midY - step / 2))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
                withVelocity: .slow, thenHoldForDuration: 0.3)
  }

  /// Część listy pod paskiem nawigacji i nad stopką limitów (jak `DemoServer.visibleListArea`).
  @MainActor
  private func visibleArea(_ app: XCUIApplication, _ list: XCUIElement) -> CGRect {
    let frame = list.frame
    var top = frame.minY
    var bottom = frame.maxY
    for bar in app.navigationBars.allElementsBoundByIndex
    where bar.frame.minX < frame.maxX && bar.frame.maxX > frame.minX && bar.frame.maxY < frame.midY {
      top = max(top, bar.frame.maxY)
    }
    let usage = element(app, "list.usage")
    if usage.exists, usage.frame.minX < frame.maxX, usage.frame.minY > frame.midY {
      bottom = min(bottom, usage.frame.minY)
    }
    return CGRect(x: frame.minX, y: top, width: frame.width, height: max(0, bottom - top))
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func wait(_ predicate: String, _ object: Any, timeout: TimeInterval = 10) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: object)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func fmt(_ value: CGFloat) -> String {
    value.isFinite ? String(format: "%.1f", Double(value)) : "-"
  }
}
