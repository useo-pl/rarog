import UIKit
import XCTest

/// Selecting the transcript with the pointer against the demo server: a click held on the last reply and dragged up to
/// the top edge of the transcript, held there, scrolls the list by itself and selects across messages; Cmd+C copies
/// what is highlighted, which the clipboard's change count and a paste into the message field of another session
/// show. A click and drag in XCUITest reaches the app as an `.indirectPointer` touch with the primary button, like a
/// trackpad click on the iPad. In landscape the session `demo-data-loader` is taller than the transcript.
/// Owner: transcript.
final class TranscriptPointerSelectionUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// A message text by the start of its content (cells off screen are not in the accessibility tree).
  @MainActor
  private func message(_ app: XCUIApplication, containing text: String) -> XCUIElement {
    app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'message.m' AND label CONTAINS %@", text))
      .firstMatch
  }

  @MainActor
  func testDragToTopEdgeScrollsAndCopiesAcrossMessages() throws {
    let port = try DemoServer.requirePort()
    let orientation = XCUIDevice.shared.orientation
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = orientation }
    let app = DemoServer.launch(port: port)
    DemoServer.pair(app)
    XCTAssertTrue(DemoServer.listShown(app), "session list")
    DemoServer.reveal(app, "demo-data-loader").tap()
    DemoServer.hideKeyboard(app)

    let transcript = app.collectionViews["transcript"]
    XCTAssertTrue(transcript.waitForAppearance(timeout: 10), "transcript")
    let last = message(app, containing: "Import zakończony")
    XCTAssertTrue(last.waitForAppearance(timeout: 10), "the last reply")
    DemoServer.waitUntilStill(last)
    let first = message(app, containing: "Zaimportuj dane z CSV")
    XCTAssertFalse(first.exists && first.isHittable, "the first prompt starts off screen")

    // From the last reply's text (low in its frame, inside the visible list) up past the top edge of the transcript,
    // over the header, where autoscroll runs fast; held there with the pointer still.
    let visible = transcript.frame.intersection(last.frame)
    let start = app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: visible.minX + 40, dy: visible.maxY - 30))
    let edge = app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: visible.minX + 40, dy: max(20, transcript.frame.minY - 120)))
    start.click(forDuration: 0.3, thenDragTo: edge, withVelocity: .default, thenHoldForDuration: 4)
    XCTAssertTrue(first.waitForAppearance(timeout: 3), "the list scrolled up to the first prompt by itself")

    // One Cmd+C copies the highlight, which the clipboard's change count shows (the runner can read it without the
    // text). On the iOS 27.2 simulator a Cmd+C sent as the first key after the launch often never reaches the app:
    // `UIApplication.sendEvent` sees no key event for it, while a second Cmd+C arrives with the screen as the first
    // responder of the key window and runs `copy:`; an arrow as the first key arrives, and a Cmd+C after it too. So
    // Cmd+C goes again only when the first did not reach the clipboard, and the first one's outcome stays in the
    // report.
    let copies = UIPasteboard.general.changeCount
    let copied = NSPredicate { _, _ in UIPasteboard.general.changeCount != copies }
    app.typeKey("c", modifierFlags: .command)
    let firstCopied =
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: copied, object: nil)], timeout: 3) == .completed
    let outcome = firstCopied ? "The first Cmd+C copied" : "The first Cmd+C did not arrive: pressed again"
    XCTContext.runActivity(named: outcome) { _ in }
    if !firstCopied { app.typeKey("c", modifierFlags: .command) }
    XCTAssertEqual(
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: copied, object: nil)], timeout: 5), .completed,
      "Cmd+C copied the highlight")
    // The finished session has no message field: the clipboard goes into the field of a session that takes messages.
    DemoServer.reveal(app, "demo-rarog").tap()
    let composer = app.textViews["composer.field"]
    XCTAssertTrue(composer.waitForAppearance(timeout: 10), "message field")
    composer.tap()
    // The simulator eats the first hardware key while the on-screen keyboard slides in: an idle arrow, then Cmd+V;
    // when that does not arrive either, Paste from the edit menu.
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    app.typeKey("v", modifierFlags: .command)
    let pasted = NSPredicate(format: "value CONTAINS %@ AND value CONTAINS %@", "Policzę wiersze", "Import zakończony")
    if XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: pasted, object: composer)], timeout: 3) != .completed {
      composer.press(forDuration: 1.2)
      for label in ["Wklej", "Paste"] where app.menuItems[label].waitForAppearance(timeout: 2) {
        app.menuItems[label].tap()
        break
      }
    }
    XCTAssertEqual(
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: pasted, object: composer)], timeout: 5), .completed,
      "the paste holds text of several messages: \(composer.value as? String ?? "")")
    let value = composer.value as? String ?? ""
    XCTAssertTrue(value.contains("\n\n"), "messages joined with an empty line: \(value)")
  }
}
