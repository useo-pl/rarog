import XCTest

/// Screenshots of the glass field card for visual review and the contrast measurement: the idle card
/// without the activity band, the agent at work with transcript text, a code block and the prompt bubble passing under
/// the card, the keyboard up (when the simulator shows one), in both themes; on the iPad the list footer card and the field card side by side. Render of
/// layers in UIKit tests shows no glass; only `XCUIApplication.screenshot()` does (`GlassScreenshotUITests`). The test
/// writes `<name>-<theme>.png` and `.json` with element frames (points) to `RAROG_SCREENSHOT_DIR`; without the
/// directory it is skipped.
final class ComposerScreenshotUITests: XCTestCase {
  private var directory: URL!

  private static let measured = ["composer.", "transcript.activity", "foot.", "list.usage", "transcript"]

  override func setUpWithError() throws {
    continueAfterFailure = true
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("brak RAROG_SCREENSHOT_DIR — zrzuty robi się ręcznie, poza bramką")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureDark() async throws { try await capture(theme: "dark") }

  @MainActor
  func testCaptureLight() async throws { try await capture(theme: "light") }

  @MainActor
  private func capture(theme: String) async throws {
    let port = try DemoServer.requirePort()
    let control = DemoControl(port: port)
    try await control.reset()
    let app = DemoServer.makeApp()
    addTeardownBlock { @MainActor in
      app.terminate()
      try? await control.reset()
    }
    let id = try await control.create("idle", label: "Szkło pola")
    app.launchEnvironment["RAROG_UI_TEST_BASE_URL"] = "http://127.0.0.1:\(port)"
    app.launchEnvironment["RAROG_UI_TEST_RESET"] = "1"
    app.launchEnvironment["RAROG_UI_TEST_THEME"] = theme
    app.launch()
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "lista sesji")
    DemoServer.hideKeyboard(app)
    DemoServer.openRow(app, id, project: "rarog")
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 10), "pole wiadomości")
    DemoServer.hideKeyboard(app)

    // Content that passes under the card: prose, a code block (the brightest block background) and more prose.
    let code = (1...14).map { "  const line\($0) = await store.read(\"note-\($0)\");" }.joined(separator: "\n")
    for index in 1...3 {
      try await control.emit("message", sessionId: id, text: """
        Odpowiedź \(index): przegląd modułu transkryptu, dość długi akapit, żeby zawinął się na kilka linii \
        i dał komórce wysokość; pod nim blok kodu.

        ```ts
        export async function load(): Promise<void> {
        \(code)
        }
        ```

        Koniec odpowiedzi \(index): tekst pod blokiem kodu.
        """)
    }
    // Idle: the card without the activity band, only as tall as the field.
    settle(1.5)
    try shot(app, "pole-bezczynne", theme)
    try await control.emit("delta", sessionId: id, text: "Czytam moduł transkryptu i sprawdzam pokrycie…")
    let activity = app.descendants(matching: .any)["transcript.activity"].firstMatch
    XCTAssertTrue(activity.waitForAppearance(timeout: 10), "wiersz aktywności")
    settle(1.5)
    try shot(app, "pole-pracuje-dno", theme)

    // The transcript dragged down in steps: text, the code block and its bar pass under the card.
    let transcript = app.collectionViews["transcript"]
    for step in 1...4 {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
      start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 70)))
      settle(1)
      try shot(app, "pole-pracuje-\(step)", theme)
    }

    // The keyboard (an on-screen one only when the simulator has no hardware keyboard connected).
    field.tap()
    settle(1.5)
    try shot(app, "pole-klawiatura", theme)
  }

  private func settle(_ seconds: TimeInterval = 1) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    let screenshot = app.screenshot()
    try screenshot.pngRepresentation.write(to: directory.appending(path: "\(name)-\(theme).png"))
    let predicate = NSPredicate(format: Self.measured.map { "identifier BEGINSWITH '\($0)'" }.joined(separator: " OR "))
    var frames: [[String: Any]] = []
    for item in app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex where item.exists {
      let frame = item.frame
      frames.append(["id": item.identifier, "x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height])
    }
    let report: [String: Any] = [
      "screen": name, "theme": theme, "pointsWidth": app.frame.width, "pointsHeight": app.frame.height,
      "scale": screenshot.image.scale, "frames": frames,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: directory.appending(path: "\(name)-\(theme).json"))
  }
}
