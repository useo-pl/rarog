import XCTest

/// Screenshots of the voice agent in the session screen, for a visual check: the status row "Hearing you" while the
/// user speaks and "Prompt in the field" with the prompt written into the message field. The demo server offers no
/// voice agent, so the app plays a scripted conversation (`RAROG_UI_TEST_VOICE_AGENT`, Debug build,
/// `ScriptedVoiceAgent`): the user speaks for five seconds, then the answer calls `show_prompt`. The test writes
/// `voice-agent-hearing-<theme>.png` and `voice-agent-prompt-<theme>.png` into `RAROG_SCREENSHOT_DIR`; without it the
/// test is skipped (screenshots are taken by hand, outside the gate). Owner: voice agent.
final class VoiceAgentScreenshotUITests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["RAROG_SCREENSHOT_DIR"] else {
      throw XCTSkip("no RAROG_SCREENSHOT_DIR: screenshots are taken by hand, outside the gate")
    }
    directory = URL(filePath: path, directoryHint: .isDirectory)
  }

  @MainActor
  func testCaptureDark() throws { try capture(theme: "dark") }

  @MainActor
  private func capture(theme: String) throws {
    let port = try DemoServer.requirePort()
    let app = DemoServer.launch(
      port: port, environment: ["RAROG_UI_TEST_VOICE_AGENT": "1", "RAROG_UI_TEST_THEME": theme])
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    DemoServer.reveal(app, "demo-rarog").tap()
    let field = app.textViews["composer.field"]
    XCTAssertTrue(field.waitForAppearance(timeout: 15), "message field")
    let button = app.buttons["composer.voiceAgent"]
    XCTAssertTrue(button.waitForAppearance(timeout: 10), "voice agent button")
    button.tap()

    let status = app.staticTexts["composer.voice.status"]
    XCTAssertTrue(wait(status, label: "label == %@", "Słyszę Cię"), "hearing: \(status.label)")
    sleep(1)
    try shot(app, "voice-agent-hearing", theme)

    XCTAssertTrue(wait(status, label: "label BEGINSWITH %@", "Prompt w polu"), "prompt: \(status.label)")
    XCTAssertEqual(field.value as? String, "Run the login tests and fix what fails.", "the prompt in the field")
    try shot(app, "voice-agent-prompt", theme)
    button.tap()
    app.terminate()
  }

  @MainActor
  private func wait(_ element: XCUIElement, label format: String, _ text: String) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, text), object: element)
    return XCTWaiter.wait(for: [expectation], timeout: 20) == .completed
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String, _ theme: String) throws {
    try app.screenshot().pngRepresentation.write(to: directory.appending(path: "\(name)-\(theme).png"))
  }
}
