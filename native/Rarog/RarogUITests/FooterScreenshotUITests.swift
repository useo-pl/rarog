import XCTest

/// Screenshots of the list footer card for visual review: the card with the limits and the machine in both
/// themes, and the list scrolling under it. The demo gives fixed numbers
/// (`server/src/demo/mac.ts`: CPU 35, RAM 80 — warning, disk 95 — red). The test writes `<name>-<theme>.png` and
/// `.json` with element frames (points) straight to `RAROG_SCREENSHOT_DIR`, like `FramesScreenshotUITests`; without the
/// directory it is skipped.
final class FooterScreenshotUITests: XCTestCase {
  private var directory: URL!

  private static let measured = ["list.", "session.list", "usage.sheet"]

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureDark() throws { try capture(theme: "dark") }

  @MainActor
  func testCaptureLight() throws { try capture(theme: "light") }

  /// The list scrolled to its end with rows passing under the card: the bottom scroll edge of the list column is the
  /// soft one, like the transcript's (no full-width hairline and dark band under the card).
  /// On the iPad in landscape (the demo's list is longer than the column there); the screenshot comes from the Mac side
  /// with `RAROG_SCREENSHOT_SYNC=1` (`scripts/ios-shots.sh`), because `XCUIApplication.screenshot()` of a landscape iPad
  /// comes out rotated and cut on the iOS 27 simulator.
  @MainActor
  func testCaptureListUnderCardDark() throws { try listUnderCard(theme: "dark") }

  @MainActor
  func testCaptureListUnderCardLight() throws { try listUnderCard(theme: "light") }

  @MainActor
  private func listUnderCard(theme: String) throws {
    let port = try DemoServer.requirePort()
    let start = XCUIDevice.shared.orientation
    if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
    let app = DemoServer.launch(port: port, environment: ["RAROG_UI_TEST_THEME": theme])
    addTeardownBlock { @MainActor in
      app.terminate()
      XCUIDevice.shared.orientation = start
    }
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    let footer = app.descendants(matching: .any)["list.usage"].firstMatch
    XCTAssertTrue(footer.waitForAppearance(timeout: 10), "footer card")
    let list = app.descendants(matching: .any)["session.list"].firstMatch
    for _ in 0..<3 { list.swipeUp(velocity: .fast) }
    sleep(2)
    try syncShot(app, "stopka-lista-dno-\(theme)")
    list.swipeDown(velocity: .slow)
    sleep(2)
    try syncShot(app, "stopka-lista-srodek-\(theme)")
    // A session beside the list (iPad): the column's edge with the detail open.
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "resync transkryptu"))
      .firstMatch
    guard row.exists, row.isHittable else { return }
    row.tap()
    sleep(2)
    DemoServer.hideKeyboard(app)
    try syncShot(app, "stopka-lista-sesja-\(theme)")
  }

  /// A screenshot taken by the Mac side on request (`<name>.png.request`), else `XCUIApplication.screenshot()`.
  @MainActor
  private func syncShot(_ app: XCUIApplication, _ name: String) throws {
    let file = directory.appending(path: "\(name).png")
    try? FileManager.default.removeItem(at: file)
    if ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_SYNC"] == "1" {
      let request = file.appendingPathExtension("request")
      try Data().write(to: request)
      for _ in 0..<80 where !FileManager.default.fileExists(atPath: file.path) { usleep(250_000) }
      if FileManager.default.fileExists(atPath: file.path) { return }
      try? FileManager.default.removeItem(at: request)
    }
    try app.screenshot().pngRepresentation.write(to: file)
  }

  @MainActor
  private func capture(theme: String) throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(port: port, environment: ["RAROG_UI_TEST_THEME": theme])
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    let footer = app.descendants(matching: .any)["list.usage"].firstMatch
    XCTAssertTrue(footer.waitForAppearance(timeout: 10), "footer card")
    let loaded = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "27 procent", "dysk 95 procent"),
      object: footer)
    XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 20), .completed, "limits and machine: \(footer.label)")
    sleep(1)
    try shot(app, "stopka", theme)
    app.terminate()
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = app.screenshot()
    try screenshot.pngRepresentation.write(to: directory.appending(path: "\(name)-\(theme).png"))
    let predicate = NSPredicate(format: Self.measured.map { "identifier BEGINSWITH '\($0)'" }.joined(separator: " OR "))
    var frames: [[String: Any]] = []
    for item in app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex where item.exists {
      let frame = item.frame
      frames.append([
        "id": item.identifier, "label": item.label,
        "x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height,
      ])
    }
    let report: [String: Any] = [
      "screen": name, "theme": theme, "pointsWidth": app.frame.width, "pointsHeight": app.frame.height,
      "scale": screenshot.image.scale, "frames": frames,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: directory.appending(path: "\(name)-\(theme).json"))
  }
}
