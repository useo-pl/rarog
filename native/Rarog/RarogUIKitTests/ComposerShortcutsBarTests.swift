@testable import RarogUI
import UIKit
import XCTest

/// The iPadOS keyboard pill under the message field does not show up, also after the prompt is deleted: the field
/// gives the shortcuts bar no groups, and emptying the field from code goes the Backspace way, not by assignment
/// (like `clearFieldQuietly` in the PWA).
@MainActor
final class ComposerShortcutsBarTests: XCTestCase {
  func testShortcutsBarHasNoGroups() {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
    XCTAssertTrue(composer.textView.inputAssistantItem.leadingBarButtonGroups.isEmpty, "bez cofnij/ponów")
    XCTAssertTrue(composer.textView.inputAssistantItem.trailingBarButtonGroups.isEmpty, "bez wklej")
  }

  /// Wysyłka czyści pole z fokusem edycją (zaznacz wszystko, Backspace): edycja ma wpis w historii cofania,
  /// a przypisanie `text` go nie ma. Dla ekranu to dalej zmiana z kodu (`onReplace`), nie pisanie (`onEdit`).
  func testClearingFocusedFieldEditsLikeBackspace() throws {
    let (composer, window) = Self.host()
    defer { window.isHidden = true }
    XCTAssertTrue(composer.textView.becomeFirstResponder(), "pole z fokusem")
    var edits = 0
    var replaces = 0
    composer.onEdit = { edits += 1 }
    composer.onReplace = { replaces += 1 }
    composer.text = "Popraw zapis notatek"
    let undo = try XCTUnwrap(composer.textView.undoManager)
    undo.removeAllActions()

    composer.text = ""

    XCTAssertEqual(composer.text, "")
    XCTAssertEqual(composer.textView.text, "")
    XCTAssertEqual(edits, 0, "czyszczenie z kodu to nie pisanie człowieka")
    XCTAssertEqual(replaces, 2, "każdy zapis z kodu zgłoszony dyktowaniu i szkicom")
    XCTAssertTrue(undo.canUndo, "opróżnienie jak Backspace — z wpisem cofania, nie przypisanie")
    undo.undo()
    XCTAssertEqual(composer.textView.text, "Popraw zapis notatek", "Cmd+Z oddaje wysłany tekst, jak w PWA")
  }

  /// Pole bez fokusu (ekran w tle, przywrócenie szkicu) i zapis niepusty: zwykłe przypisanie, bez wpisu cofania.
  func testAssignmentWithoutFocusOrWithText() throws {
    let (composer, window) = Self.host()
    defer { window.isHidden = true }
    composer.text = "abc"
    composer.text = ""
    XCTAssertEqual(composer.textView.text, "")
    XCTAssertFalse(composer.textView.undoManager?.canUndo ?? false, "bez fokusu: przypisanie")
    XCTAssertTrue(composer.textView.becomeFirstResponder())
    composer.text = "wraca po odmowie"
    XCTAssertEqual(composer.textView.text, "wraca po odmowie")
  }

  /// W trakcie składania znaku (IME, dyktowanie systemowe) czyszczenie idzie przypisaniem — edycja przez silnik
  /// rozbiłaby składany znak. Dla ekranu to dalej zmiana z kodu, nie pisanie.
  func testClearingWhileComposingFallsBackToAssignment() throws {
    let (composer, window) = Self.host()
    defer { window.isHidden = true }
    XCTAssertTrue(composer.textView.becomeFirstResponder())
    var edits = 0
    composer.onEdit = { edits += 1 }
    composer.text = "zażółć "
    composer.textView.setMarkedText("ą", selectedRange: NSRange(location: 1, length: 0))
    XCTAssertNotNil(composer.textView.markedTextRange, "znak w składaniu")
    // Składanie znaku to pisanie człowieka (`onEdit`); liczy się dopiero czyszczenie z kodu.
    edits = 0
    composer.text = ""
    XCTAssertEqual(composer.textView.text, "")
    XCTAssertEqual(edits, 0)
  }

  private static func host() -> (ComposerView, UIWindow) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
    let controller = UIViewController()
    window.rootViewController = controller
    let composer = ComposerView(frame: CGRect(x: 0, y: 100, width: 390, height: 200))
    controller.view.addSubview(composer)
    window.makeKeyAndVisible()
    composer.layoutIfNeeded()
    return (composer, window)
  }
}
