@testable import RarogUI
import UIKit
import XCTest

/// The rename field of a list row at the UIKit level: keystrokes and pastes past the limit or with a line break, Return
/// and Esc, and the pointer double click that must never hold back a finger tap. The rules themselves are tested in
/// the package (`SessionRenameTests`). Owner: list.
@MainActor
final class SessionRenameFieldTests: XCTestCase {
  private func field(_ text: String) -> RenameTextFieldView {
    let field = RenameTextFieldView()
    field.text = text
    return field
  }

  /// Types or pastes `string` over `range` the way UIKit asks the delegate; applies it when the delegate agrees.
  private func type(_ string: String, at range: NSRange, into field: RenameTextFieldView) {
    if field.textField(field, shouldChangeCharactersIn: range, replacementString: string) {
      field.text = ((field.text ?? "") as NSString).replacingCharacters(in: range, with: string)
    }
  }

  func testTheFieldRefusesThe29thCharacter() {
    let full = String(repeating: "a", count: SessionRename.maxLength)
    let field = field(full)
    var changes: [String] = []
    field.onChange = { changes.append($0) }
    type("b", at: NSRange(location: full.utf16.count, length: 0), into: field)
    XCTAssertEqual(field.text, full)
    XCTAssertEqual(changes, [], "a refused key changes nothing")
  }

  func testAPasteKeepsWhatFitsAndALineBreakBecomesASpace() {
    let field = field("")
    var changes: [String] = []
    field.onChange = { changes.append($0) }
    type("a\nb", at: NSRange(location: 0, length: 0), into: field)
    XCTAssertEqual(field.text, "a b")
    type(String(repeating: "c", count: 40), at: NSRange(location: 3, length: 0), into: field)
    XCTAssertEqual(field.text?.utf16.count, SessionRename.maxLength)
    XCTAssertEqual(changes.last, field.text, "the counter hears the trimmed text")
  }

  func testAFullFieldRefusesACharacterTypedAtTheStart() {
    let full = String(repeating: "a", count: SessionRename.maxLength)
    let field = field(full)
    var changes: [String] = []
    field.onChange = { changes.append($0) }
    type("b", at: NSRange(location: 0, length: 0), into: field)
    XCTAssertEqual(field.text, full)
    XCTAssertEqual(changes, [])
  }

  func testAPasteIntoTheMiddleKeepsTheRestOfTheName() {
    let field = field("abcdefghijklmnopqrstuvwxyz")
    var changes: [String] = []
    field.onChange = { changes.append($0) }
    type("XYZ", at: NSRange(location: 13, length: 0), into: field)
    XCTAssertEqual(field.text, "abcdefghijklmXYnopqrstuvwxyz")
    XCTAssertEqual(changes, ["abcdefghijklmXYnopqrstuvwxyz"])
    let caret = field.selectedTextRange.map { field.offset(from: field.beginningOfDocument, to: $0.start) }
    XCTAssertEqual(caret, 15, "the caret stands after the inserted part")
  }

  /// A paste over a selection of a full field that keeps the text as it was still moves the caret after the kept
  /// part: a selection left in place would let the next key replace it, although the field is full.
  func testAPasteThatChangesNothingCollapsesTheSelection() {
    let full = "ab" + String(repeating: "c", count: SessionRename.maxLength - 2)
    let field = field(full)
    var changes: [String] = []
    field.onChange = { changes.append($0) }
    field.selectedTextRange = field.textRange(
      from: field.beginningOfDocument, to: field.position(from: field.beginningOfDocument, offset: 2)!)
    type("abX", at: NSRange(location: 0, length: 2), into: field)
    XCTAssertEqual(field.text, full)
    XCTAssertEqual(changes, [], "the text did not change")
    let selection = field.selectedTextRange.map {
      NSRange(
        location: field.offset(from: field.beginningOfDocument, to: $0.start),
        length: field.offset(from: $0.start, to: $0.end))
    }
    XCTAssertEqual(selection, NSRange(location: 2, length: 0), "the caret stands after the kept part")
    type("d", at: selection ?? NSRange(location: 0, length: 2), into: field)
    XCTAssertEqual(field.text, full, "the next key is refused")
  }

  /// A field that leaves the list without Return or Esc (the row goes away in a list update) gives the list its taps
  /// back.
  func testAFieldThatLeavesTheListDetachesItsTapRecognizer() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
    let list = UIScrollView(frame: window.bounds)
    window.addSubview(list)
    let field = field("Nowa")
    field.frame = CGRect(x: 10, y: 10, width: 200, height: 30)
    list.addSubview(field)
    field.delegate?.textFieldDidBeginEditing?(field)
    let taps = { (list.gestureRecognizers ?? []).filter { $0 is UITapGestureRecognizer } }
    XCTAssertEqual(taps().count, 1, "a tap recognizer on the list while the field is open")
    field.removeFromSuperview()
    XCTAssertEqual(taps().count, 0, "the list gets its taps back")
  }

  /// A tap beside the field (the list's empty background, another row) ends it as a cancel. The tap belongs to the
  /// list as well: the recognizer neither cancels nor delays touches, so the tapped row still opens.
  func testATapBesideTheFieldCancels() {
    let list = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
    let field = field("Nowa")
    field.frame = CGRect(x: 10, y: 10, width: 200, height: 30)
    list.addSubview(field)
    var cancels = 0
    field.onCancel = { cancels += 1 }
    field.delegate?.textFieldDidBeginEditing?(field)
    let taps = (list.gestureRecognizers ?? []).compactMap { $0 as? UITapGestureRecognizer }
    XCTAssertEqual(taps.count, 1, "a tap recognizer on the list while the field is open")
    guard let tap = taps.first else { return }
    XCTAssertFalse(tap.cancelsTouchesInView)
    XCTAssertFalse(tap.delaysTouchesBegan)
    XCTAssertFalse(tap.delaysTouchesEnded)
    field.tapped(at: CGPoint(x: 20, y: 15))
    XCTAssertEqual(cancels, 0, "a tap on the field itself stays the field's")
    field.tapped(at: field.convert(CGPoint(x: 100, y: 400), from: list))
    XCTAssertEqual(cancels, 1, "a tap beside the field cancels")
    XCTAssertFalse(list.gestureRecognizers?.contains(tap) ?? false, "the list gets its taps back")
    var saved: [String] = []
    field.onSave = { saved.append($0) }
    XCTAssertFalse(field.textFieldShouldReturn(field))
    XCTAssertEqual(saved, [], "a later Return sends nothing")
  }

  /// The list may hand the next edit of a row the text field view of the previous one: a new edit number starts the
  /// view over, so it shows the new starting name, Return saves again and a tap beside it cancels again. The same
  /// number (any later update of the list) leaves what the person typed alone.
  func testANewEditStartsAReusedFieldOver() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
    let list = UIScrollView(frame: window.bounds)
    window.addSubview(list)
    let field = RenameTextFieldView()
    field.frame = CGRect(x: 10, y: 10, width: 200, height: 30)
    list.addSubview(field)
    var saved: [String] = []
    var cancels = 0
    field.onSave = { saved.append($0) }
    field.onCancel = { cancels += 1 }
    let taps = { (list.gestureRecognizers ?? []).filter { $0 is UITapGestureRecognizer } }

    field.start(1, text: "Stara")
    field.delegate?.textFieldDidBeginEditing?(field)
    XCTAssertFalse(field.textFieldShouldReturn(field))
    XCTAssertEqual(saved, ["Stara"], "the first Return saves")

    field.start(2, text: "Pierwsza")
    XCTAssertEqual(field.text, "Pierwsza", "the second edit starts with its own name")
    field.delegate?.textFieldDidBeginEditing?(field)
    XCTAssertEqual(taps().count, 1, "a tap recognizer on the list again")
    XCTAssertFalse(field.textFieldShouldReturn(field))
    XCTAssertEqual(saved, ["Stara", "Pierwsza"], "the second Return saves")

    field.start(3, text: "Druga")
    field.delegate?.textFieldDidBeginEditing?(field)
    field.text = "Druga x"
    field.start(3, text: "Druga")
    XCTAssertEqual(field.text, "Druga x", "the same edit keeps the typing")
    field.tapped(at: field.convert(CGPoint(x: 100, y: 400), from: list))
    XCTAssertEqual(cancels, 1, "a tap beside the third field cancels")
    XCTAssertEqual(saved.count, 2, "nothing more was saved")
  }

  func testReturnSavesOnceAndTheFollowingLossOfFocusDoesNotCancel() {
    let field = field("Nowa")
    var saved: [String] = []
    var cancels = 0
    field.onSave = { saved.append($0) }
    field.onCancel = { cancels += 1 }
    XCTAssertFalse(field.textFieldShouldReturn(field))
    field.textFieldDidEndEditing(field)
    XCTAssertEqual(saved, ["Nowa"])
    XCTAssertEqual(cancels, 0)
  }

  func testLosingFocusCancels() {
    let field = field("Nowa")
    var saved: [String] = []
    var cancels = 0
    field.onSave = { saved.append($0) }
    field.onCancel = { cancels += 1 }
    field.textFieldDidEndEditing(field)
    XCTAssertEqual(cancels, 1)
    XCTAssertFalse(field.textFieldShouldReturn(field))
    XCTAssertEqual(saved, [], "nothing after the field ended")
  }

  func testEscapeIsAKeyCommandOfTheField() {
    let field = field("Nowa")
    let escape = field.keyCommands?.first { $0.input == UIKeyCommand.inputEscape && $0.modifierFlags.isEmpty }
    XCTAssertNotNil(escape)
    XCTAssertEqual(escape?.wantsPriorityOverSystemBehavior, true, "Esc reaches the field before the system")
  }

  /// A finger tap must open the session at once: the double click recognizer takes pointer clicks only, does not
  /// delay touches and does not cancel them.
  func testTheDoubleClickTakesPointerClicksOnly() {
    let recognizer = UITapGestureRecognizer()
    RenameDoubleClickView.configure(recognizer)
    XCTAssertEqual(recognizer.numberOfTapsRequired, 2)
    XCTAssertEqual(recognizer.allowedTouchTypes, [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)])
    XCTAssertFalse(recognizer.cancelsTouchesInView)
    XCTAssertFalse(recognizer.delaysTouchesBegan)
    XCTAssertFalse(recognizer.delaysTouchesEnded)
  }
}
