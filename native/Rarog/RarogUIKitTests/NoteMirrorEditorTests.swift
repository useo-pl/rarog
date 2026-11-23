@testable import RarogUI
import UIKit
import XCTest

/// „Lustro" markdownu w polu notatki na prawdziwym `NoteTextView`: atrybuty stoją tam, gdzie role
/// `NoteMirror`, a tekst i kursor zostają nietknięte (żaden znak nie znika, nic się nie przesuwa). Właściciel:
/// notatki (apka natywna).
@MainActor
final class NoteMirrorEditorTests: XCTestCase {
  private let text = "## Nagłówek\n- `kod` i **gruby** https://herdr.dev"

  private func editor() -> NoteTextView {
    let view = NoteTextView(frame: CGRect(x: 0, y: 0, width: 360, height: 400), textContainer: nil)
    view.text = text
    view.applyMirror()
    return view
  }

  private func location(of fragment: String, in view: NoteTextView) -> Int {
    (view.text as NSString).range(of: fragment).location
  }

  private func attribute(_ key: NSAttributedString.Key, at index: Int, in view: NoteTextView) -> Any? {
    view.textStorage.attribute(key, at: index, effectiveRange: nil)
  }

  func testMirrorKeepsTextAndSelection() {
    let view = editor()
    view.selectedRange = NSRange(location: 7, length: 3)
    view.applyMirror()
    XCTAssertEqual(view.text, text, "żaden znak nie znika")
    XCTAssertEqual(view.selectedRange, NSRange(location: 7, length: 3), "zaznaczenie zostaje")
  }

  func testRolesGetTheirAttributes() throws {
    let view = editor()
    let body = UIFont.preferredFont(forTextStyle: .body, compatibleWith: view.traitCollection)
    let heading = try XCTUnwrap(attribute(.font, at: 4, in: view) as? UIFont)
    XCTAssertEqual(heading.pointSize, body.pointSize, "nagłówek tego samego rozmiaru")
    XCTAssertTrue(heading.fontDescriptor.symbolicTraits.contains(.traitBold), "linia nagłówka półgruba")
    XCTAssertEqual(attribute(.foregroundColor, at: 0, in: view) as? UIColor, Palette.muted2, "`#` wyciszony")

    let code = try XCTUnwrap(attribute(.font, at: location(of: "kod", in: view), in: view) as? UIFont)
    XCTAssertTrue(code.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "kod stałej szerokości")
    XCTAssertEqual(attribute(.foregroundColor, at: location(of: "kod", in: view), in: view) as? UIColor, Palette.inlineCodeInk)
    XCTAssertNotNil(attribute(.backgroundColor, at: location(of: "kod", in: view), in: view), "tło kodu")
    XCTAssertEqual(attribute(.foregroundColor, at: location(of: "`kod", in: view), in: view) as? UIColor, Palette.muted2)

    let bold = try XCTUnwrap(attribute(.font, at: location(of: "gruby", in: view), in: view) as? UIFont)
    XCTAssertTrue(bold.fontDescriptor.symbolicTraits.contains(.traitBold))
    XCTAssertEqual(attribute(.foregroundColor, at: location(of: "**gruby", in: view), in: view) as? UIColor, Palette.muted2)
    XCTAssertEqual(attribute(.foregroundColor, at: location(of: "herdr.dev", in: view), in: view) as? UIColor, Palette.linkInk)

    let list = try XCTUnwrap(attribute(.paragraphStyle, at: location(of: "i **", in: view), in: view) as? NSParagraphStyle)
    let markerWidth = ("- " as NSString).size(withAttributes: [.font: body]).width
    XCTAssertEqual(list.headIndent, ceil(markerWidth), accuracy: 0.5, "wiszące wcięcie = szerokość „- ”")
    XCTAssertEqual(list.firstLineHeadIndent, 0)
  }

  func testTypingDoesNotInheritNeighbourStyleAndReadOnlyInkKeepsMirror() throws {
    let view = editor()
    let body = UIFont.preferredFont(forTextStyle: .body, compatibleWith: view.traitCollection)
    XCTAssertEqual(view.typingAttributes[.font] as? UIFont, body, "nowy znak bez kroju kodu ani nagłówka")
    view.ink = Palette.text2
    XCTAssertEqual(attribute(.foregroundColor, at: location(of: " i ", in: view), in: view) as? UIColor, Palette.text2)
    XCTAssertEqual(attribute(.foregroundColor, at: 0, in: view) as? UIColor, Palette.muted2, "znaczniki zostają")
  }

  func testAdoptRestylesModelText() {
    let view = editor()
    view.adopt("**nowe**")
    XCTAssertEqual(view.text, "**nowe**")
    XCTAssertEqual(attribute(.foregroundColor, at: 0, in: view) as? UIColor, Palette.muted2, "tekst z modelu też w lustrze")
  }
}
