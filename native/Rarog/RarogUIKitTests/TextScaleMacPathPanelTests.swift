@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The app's text size on the flat path (the iPad app on a Mac, where every text style has one size) in the
/// inspector, the terminal history and the note editor, on live views stepped through a `TextScale`. The bugs caught
/// here: a font set once from the system's text style, which stays put on a Mac when the app's text size changes; a
/// note editor that loses its selection or types in the old size after a step; and, on the standard path (iPad,
/// iPhone), a font that is no longer what the system gives. The simulator scales text styles itself, so the flat
/// path is forced with `TextStyleScaling.withFlat(true)` around each whole case, layout waits included.
@MainActor
final class TextScaleMacPathPanelTests: XCTestCase {
  private var suite = ""
  private var defaults = UserDefaults.standard

  override func setUp() async throws {
    try await super.setUp()
    suite = "rarog-test-mac-path-panel-\(UUID().uuidString)"
    defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
  }

  override func tearDown() async throws {
    Fonts.scale = .shared
    defaults.removePersistentDomain(forName: suite)
    try await super.tearDown()
  }

  // MARK: - Inspector

  func testInspectorTextTakesTheTableSizeAfterAStep() {
    TextStyleScaling.withFlat(true) {
      let scale = TextScale(defaults: defaults, system: .large)
      let screen = AppFontTests.screen(Self.stateLabel.textScaleHost(scale), flat: true)
      defer { screen.window.isHidden = true }
      XCTAssertEqual(screen.host.view.intrinsicContentSize.height, Self.stateLabelHeight(.large), accuracy: 0.5)

      scale.grow()
      AppFontTests.settle(screen.window)
      XCTAssertEqual(
        screen.host.view.intrinsicContentSize.height, Self.stateLabelHeight(.extraLarge), accuracy: 0.5,
        "a step reaches the open panel")
    }
  }

  /// The simulator gives a text style the same size the table does at every standard step, so only an accessibility
  /// size tells the table from the system there: the table stops at Extra Extra Extra Large.
  func testInspectorTextStopsAtTheTablesLargestStepAtAnAccessibilitySize() {
    TextStyleScaling.withFlat(true) {
      let scale = TextScale(defaults: defaults, system: .accessibilityLarge)
      let screen = AppFontTests.screen(Self.stateLabel.textScaleHost(scale), flat: true)
      defer { screen.window.isHidden = true }
      XCTAssertEqual(
        screen.host.view.intrinsicContentSize.height, Self.stateLabelHeight(.extraExtraExtraLarge), accuracy: 0.5)
      XCTAssertGreaterThan(
        Self.stateLabelHeight(.accessibilityLarge), Self.stateLabelHeight(.extraExtraExtraLarge) + 1,
        "the check can fail")
    }
  }

  func testInspectorTextKeepsTheSystemSizeOnTheStandardPath() {
    TextStyleScaling.withFlat(false) {
      let scale = TextScale(defaults: defaults, system: .large)
      let screen = AppFontTests.screen(Self.stateLabel.textScaleHost(scale), flat: false)
      defer { screen.window.isHidden = true }
      scale.grow()
      AppFontTests.settle(screen.window)
      XCTAssertEqual(
        screen.host.view.intrinsicContentSize.height, Self.stateLabelHeight(.large), accuracy: 0.5,
        "the window's category, not the model's")
    }
  }

  private static var stateLabel: PullRequestStateLabel { PullRequestStateLabel(state: .open, word: "Open") }

  /// The label as the system draws it at `category`, the size the table gives at a standard step.
  private static func stateLabelHeight(_ category: TextSizeCategory) -> CGFloat {
    AppFontTests.size(stateLabel, flat: false, category: category).height
  }

  // MARK: - Terminal history

  func testHistoryTextTakesTheTableSizeAfterAStep() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = TextScale(defaults: defaults, system: .large)
      let (window, text) = try historyText(scale)
      defer { window.isHidden = true }
      XCTAssertEqual(text.font?.pointSize ?? 0, Self.historySize(.large), accuracy: 0.01)

      scale.grow()
      AppFontTests.settle(window)
      let font = try XCTUnwrap(text.font)
      XCTAssertEqual(font.pointSize, Self.historySize(.extraLarge), accuracy: 0.01, "a step reaches the open text")
      XCTAssertGreaterThan(font.pointSize, Self.historySize(.large))
      XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), font.fontName)
    }
  }

  func testHistoryTextKeepsTheSystemSizeOnTheStandardPath() throws {
    try TextStyleScaling.withFlat(false) {
      let scale = TextScale(defaults: defaults, system: .large)
      let (window, text) = try historyText(scale)
      defer { window.isHidden = true }
      scale.grow()
      AppFontTests.settle(window)
      let expected = UIFontMetrics(forTextStyle: .body).scaledValue(
        for: Self.historyBase, compatibleWith: text.traitCollection)
      XCTAssertEqual(text.font?.pointSize ?? 0, expected, accuracy: 0.01)
      XCTAssertTrue(text.adjustsFontForContentSizeCategory, "the system scales it")
    }
  }

  private static var historyBase: CGFloat {
    TerminalFontSize.points(pad: UIDevice.current.userInterfaceIdiom == .pad)
  }

  private static func historySize(_ category: TextSizeCategory) -> CGFloat {
    TextStyleScaling.scale(historyBase, relativeTo: .body, category: category, flat: true)
  }

  /// The history text as the history window builds it, following `scale`.
  private func historyText(_ scale: TextScale) throws -> (UIWindow, HistoryTextView) {
    let screen = AppFontTests.screen(
      TerminalHistoryText(text: "$ ls\nnotes.txt").frame(width: 300, height: 200), flat: TextStyleScaling.isFlat)
    let text = try XCTUnwrap(Self.find(HistoryTextView.self, in: screen.host.view))
    text.textScale = scale
    AppFontTests.settle(screen.window)
    return (screen.window, text)
  }

  // MARK: - Note editor

  func testNoteEditorTakesTheTableSizeAfterAStepAndKeepsSelectionAndTypingAttributes() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = TextScale(defaults: defaults, system: .large)
      let (window, editor) = noteEditor(scale)
      defer { window.isHidden = true }
      let plain = (editor.text as NSString).range(of: "plain").location
      XCTAssertEqual(try Self.font(at: plain, in: editor).pointSize, TextStyleTable.size(.body, .large))
      editor.selectedRange = NSRange(location: plain, length: 3)

      scale.grow()
      AppFontTests.settle(window)
      let size = TextStyleTable.size(.body, .extraLarge)
      XCTAssertEqual(try Self.font(at: plain, in: editor).pointSize, size, "the text")
      XCTAssertEqual(editor.font?.pointSize, size, "the field")
      XCTAssertEqual(editor.selectedRange, NSRange(location: plain, length: 3), "the selection stays")
      let typing = try XCTUnwrap(editor.typingAttributes[.font] as? UIFont)
      XCTAssertEqual(typing.pointSize, size, "the next character comes in the new size")
      XCTAssertEqual(editor.typingAttributes[.foregroundColor] as? UIColor, editor.ink, "in the field's ink")
      let heading = try Self.font(at: 3, in: editor)
      XCTAssertEqual(heading.pointSize, size, "the heading follows the body")
    }
  }

  func testNoteEditorKeepsTheSystemSizeOnTheStandardPath() throws {
    try TextStyleScaling.withFlat(false) {
      let scale = TextScale(defaults: defaults, system: .large)
      let (window, editor) = noteEditor(scale)
      defer { window.isHidden = true }
      scale.grow()
      AppFontTests.settle(window)
      let body = UIFont.preferredFont(forTextStyle: .body, compatibleWith: editor.traitCollection)
      let plain = (editor.text as NSString).range(of: "plain").location
      XCTAssertEqual(try Self.font(at: plain, in: editor), body)
      XCTAssertEqual(editor.font?.pointSize, body.pointSize)
      XCTAssertTrue(editor.adjustsFontForContentSizeCategory, "the system scales it")
    }
  }

  private func noteEditor(_ scale: TextScale) -> (UIWindow, NoteTextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 600))
    window.traitOverrides.preferredContentSizeCategory = .large
    let root = UIViewController()
    window.rootViewController = root
    window.isHidden = false
    let editor = NoteTextView(frame: CGRect(x: 0, y: 0, width: 360, height: 400), textContainer: nil)
    editor.textScale = scale
    root.view.addSubview(editor)
    editor.text = "## Title\nplain text and `code`"
    editor.applyMirror()
    AppFontTests.settle(window)
    return (window, editor)
  }

  private static func font(at index: Int, in editor: NoteTextView) throws -> UIFont {
    try XCTUnwrap(editor.textStorage.attribute(.font, at: index, effectiveRange: nil) as? UIFont)
  }

  // MARK: - Note reader

  func testNoteReaderTakesTheTableSizeAfterAStepAndKeepsTheSelection() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = TextScale(defaults: defaults, system: .large)
      Fonts.scale = scale
      // No text size host above the reader: under one, the host's step reaches the text view as a trait change, and
      // the case here is the model's step alone.
      let screen = AppFontTests.screen(NoteReader(text: "plain text of the note").frame(width: 360), flat: true)
      defer { screen.window.isHidden = true }
      let reader = try XCTUnwrap(Self.find(UITextView.self, in: screen.host.view))
      XCTAssertEqual(try Self.readerSize(reader), TextStyleTable.size(.body, .large), accuracy: 0.01)
      reader.selectedRange = NSRange(location: 6, length: 4)

      scale.grow()
      AppFontTests.settle(screen.window)
      XCTAssertEqual(
        try Self.readerSize(reader), TextStyleTable.size(.body, .extraLarge), accuracy: 0.01,
        "a step reaches the open reader")
      XCTAssertEqual(reader.selectedRange, NSRange(location: 6, length: 4), "the selection stays")
    }
  }

  private static func readerSize(_ reader: UITextView) throws -> CGFloat {
    try XCTUnwrap(reader.attributedText.attribute(.font, at: 0, effectiveRange: nil) as? UIFont).pointSize
  }

  // MARK: - Helpers

  private static func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
    if let match = view as? View { return match }
    for subview in view.subviews {
      if let match = find(type, in: subview) { return match }
    }
    return nil
  }
}
