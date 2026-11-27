@testable import RarogUI
import UIKit
import XCTest

/// The key receiver of a listening shortcut row in Settings (`ShortcutCaptureView`), wired to its editor as the row
/// wires it: it takes the keyboard when the row starts listening, gives it back to the previous responder when the
/// row saves or cancels, ends the listening when somebody else takes the keyboard or the row leaves the window, and
/// while it listens its own Esc wins over the sheet's. The row's rules are tested by the package
/// (`ShortcutRowEditorTests`). Key presses go through the modelled UIKit lookup
/// (`SessionSwitcherUIKitTests.keyTarget`): the simulator does not deliver Esc. Owner: shortcuts.
@MainActor
final class ShortcutCaptureViewTests: XCTestCase {
  /// A sheet with Esc and ⌘W of its own, like the Settings sheet's invisible buttons.
  final class SheetController: UIViewController {
    var closed = 0

    override var keyCommands: [UIKeyCommand]? {
      [
        UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(close)),
        UIKeyCommand(input: "w", modifierFlags: .command, action: #selector(close)),
      ]
    }

    @objc func close() { closed += 1 }
  }

  private struct Harness {
    let window: UIWindow
    let sheet: SheetController
    let field: UITextField
    let other: UITextField
    let capture: ShortcutCaptureView
    let editor: ShortcutRowEditor
  }

  private func harness() -> Harness {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
    let sheet = SheetController()
    window.rootViewController = sheet
    window.makeKeyAndVisible()
    let field = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
    let other = UITextField(frame: CGRect(x: 0, y: 60, width: 200, height: 40))
    let capture = ShortcutCaptureView(frame: CGRect(x: 0, y: 120, width: 80, height: 30))
    sheet.view.addSubview(field)
    sheet.view.addSubview(other)
    sheet.view.addSubview(capture)
    capture.currentResponder = { [weak window] in window.flatMap(SessionSwitcherUIKitTests.firstResponder) }
    let domain = "rarog-test-capture-\(UUID().uuidString)"
    // swiftlint:disable:next force_unwrapping
    let defaults = UserDefaults(suiteName: domain)!
    let editor = ShortcutRowEditor(shortcut: .dictation, settings: AppShortcutSettings(defaults: defaults))
    ShortcutCaptureField.wire(capture, to: editor)
    editor.rebuildMenus = {}
    addTeardownBlock { @MainActor in
      window.isHidden = true
      defaults.removePersistentDomain(forName: domain)
    }
    return Harness(window: window, sheet: sheet, field: field, other: other, capture: capture, editor: editor)
  }

  /// The main queue ran the view's deferred hand-back.
  private func settle() async {
    try? await Task.sleep(for: .milliseconds(80))
  }

  private static let optionCommandK = AppShortcut.Combination(key: .character("k"), modifiers: [.option, .command])

  func testTakesKeyboardWhileListeningAndGivesItBackAfterSave() async {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder(), "the page's responder holds the keyboard")
    XCTAssertFalse(h.capture.canBecomeFirstResponder, "a row that does not listen takes no keyboard")

    h.editor.tap(keyboard: true)
    XCTAssertTrue(h.editor.listening)
    XCTAssertTrue(h.capture.isFirstResponder, "the listening row holds the keyboard")
    XCTAssertFalse(h.field.isFirstResponder)

    h.capture.onPress(Self.optionCommandK)
    XCTAssertFalse(h.editor.listening)
    XCTAssertFalse(h.capture.isFirstResponder)
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "after the save the keyboard goes back")
    XCTAssertEqual(h.editor.combination, Self.optionCommandK)
  }

  func testEscapeWhileListeningIsTheRowsNotTheSheets() async {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    XCTAssertTrue(SessionSwitcherUIKitTests.keyTarget(UIKeyCommand.inputEscape, in: h.window)?.responder === h.sheet,
                  "without listening Esc closes the sheet")

    h.editor.tap(keyboard: true)
    let target = SessionSwitcherUIKitTests.keyTarget(UIKeyCommand.inputEscape, in: h.window)
    XCTAssertTrue(target?.responder === h.capture, "while listening Esc belongs to the row")
    if let action = target?.command.action { h.capture.perform(action) }
    XCTAssertFalse(h.editor.listening, "Esc ends the listening")
    XCTAssertEqual(h.sheet.closed, 0, "the sheet stays")
    XCTAssertEqual(h.editor.combination, AppShortcut.dictation.defaultCombination, "nothing saved")
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the keyboard goes back after Esc")
    XCTAssertTrue(SessionSwitcherUIKitTests.keyTarget(UIKeyCommand.inputEscape, in: h.window)?.responder === h.sheet,
                  "after the listening Esc closes the sheet again")
  }

  func testAnotherResponderEndsTheListening() async {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.editor.tap(keyboard: true)
    XCTAssertTrue(h.other.becomeFirstResponder(), "another field takes the keyboard")
    XCTAssertFalse(h.editor.listening, "losing the keyboard ends the listening")
    await settle()
    XCTAssertTrue(h.other.isFirstResponder, "the new responder keeps the keyboard")
    h.capture.onPress(Self.optionCommandK)
    XCTAssertEqual(h.editor.combination, AppShortcut.dictation.defaultCombination, "a key after that saves nothing")
  }

  func testSecondListeningGivesTheKeyboardBackToTheSameResponder() async {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.editor.tap(keyboard: true)
    h.editor.tap(keyboard: true)
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "a second tap gives the keyboard back")

    h.editor.tap(keyboard: true)
    XCTAssertTrue(h.capture.isFirstResponder, "the row listens again")
    h.capture.onPress(ShortcutRowEditor.cancelKey)
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the second release gives the keyboard to the same responder")
  }

  func testLeavingTheWindowEndsTheListening() async {
    let h = harness()
    XCTAssertTrue(h.field.becomeFirstResponder())
    h.editor.tap(keyboard: true)
    h.capture.removeFromSuperview()
    XCTAssertFalse(h.editor.listening, "the row gone ends the listening")
    await settle()
    XCTAssertTrue(h.field.isFirstResponder, "the keyboard goes back to the page")
  }
}
