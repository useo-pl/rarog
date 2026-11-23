import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The session screen's text on the flat path of the text size (the iPad app on a Mac, where every text style has
/// one size and no trait change comes with a step): the views take their size from the table at the model's
/// category (`Fonts.scale`, a model on scratch `UserDefaults` here). The bugs caught: a font that stays at the
/// system's one size after ⌘+ on an open view or after the view is put back on screen, a SwiftUI island that does
/// not carry the model's category, a render cached for one step that serves another, and a field that loses its
/// selection or typing attributes when its font changes under the cursor. With the flat path off, the same views
/// keep the sizes of the window's category and ignore the model. Owner: text size.
@MainActor
final class TextScaleMacPathTests: XCTestCase {
  private var suite = ""
  private var defaults = UserDefaults.standard

  override func setUp() async throws {
    try await super.setUp()
    suite = "rarog-test-mac-path-\(UUID().uuidString)"
    defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
  }

  override func tearDown() async throws {
    Fonts.scale = .shared
    defaults.removePersistentDomain(forName: suite)
    try await super.tearDown()
  }

  static let markdown = "# Heading\n\nSome `code` here."

  // MARK: - Flat path

  func testCardInTheDockTakesTheTableSizeOnAnOpenViewAndAfterAttachingAgain() throws {
    // References first, on the standard path: the card at the window's category is the card at the table size.
    let reference = try TextStyleScaling.withFlat(false) {
      try [TextSizeCategory.large, .extraLarge, .extraExtraLarge].map { try Self.cardHeight(window: $0) }
    }
    XCTAssertGreaterThan(reference[1], reference[0] + 2, "the check can fail")
    XCTAssertGreaterThan(reference[2], reference[1] + 2, "the check can fail")
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let fixture = try Self.dockFixture()
      defer { fixture.window.isHidden = true }
      XCTAssertEqual(try Self.cardHeight(fixture), reference[0], accuracy: 1, "at Large")

      scale.grow()
      Self.settle(fixture.window)
      XCTAssertEqual(try Self.cardHeight(fixture), reference[1], accuracy: 1, "a step on the open card")

      let root = fixture.window.rootViewController
      fixture.window.rootViewController = UIViewController()
      Self.settle(fixture.window)
      scale.grow()
      Self.settle(fixture.window)
      fixture.window.rootViewController = root
      Self.settle(fixture.window)
      XCTAssertEqual(try Self.cardHeight(fixture), reference[2], accuracy: 1, "attached again")
    }
  }

  func testMarkdownHeadingAndInlineCodeTakeTheTableSize() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let traits = UITraitCollection(preferredContentSizeCategory: .large)
      let cache = MarkdownCache()
      let before = cache.text(Self.markdown, style: Self.style(traits))
      scale.grow()
      let style = Self.style(traits)
      let after = cache.text(Self.markdown, style: style)
      XCTAssertFalse(before === after, "a render cached for Large does not serve Extra Large")
      let sizes = try Self.markdownSizes(after)
      let heading = TextStyleScaling.scale(
        TextStyleTable.size(.callout, .large) * MarkdownLayout.headingScale(1), relativeTo: .callout,
        category: .extraLarge, flat: true)
      XCTAssertEqual(sizes.heading, heading, accuracy: 0.01, "heading")
      let body = TextStyleTable.size(.callout, .extraLarge)
      XCTAssertEqual(sizes.code, (body * 0.9).rounded(), accuracy: 0.01, "inline code")
      XCTAssertEqual(sizes.body, body, accuracy: 0.01, "body")
    }
  }

  func testPromptBarQuoteTakesTheTableSizeOnAnOpenViewAndAfterAttachingAgain() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let window = Self.window(.large)
      defer { window.isHidden = true }
      let bar = PromptBarView(frame: .zero)
      bar.quote = "A short prompt"
      window.addSubview(bar)
      Self.settle(window)
      let quote = try XCTUnwrap(DecisionDockTests.views(of: UILabel.self, in: bar).first)
      XCTAssertEqual(quote.font.pointSize, Self.quote(.large), accuracy: 0.01)

      scale.grow()
      Self.settle(window)
      XCTAssertEqual(quote.font.pointSize, Self.quote(.extraLarge), accuracy: 0.01, "a step on the open bar")

      bar.removeFromSuperview()
      scale.grow()
      Self.settle(window)
      window.addSubview(bar)
      Self.settle(window)
      XCTAssertEqual(quote.font.pointSize, Self.quote(.extraExtraLarge), accuracy: 0.01, "attached again")
    }
  }

  func testComposerFieldTakesTheTableSizeAndKeepsSelectionTypingAndComposition() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let window = Self.window(.large)
      defer { window.isHidden = true }
      let composer = Self.composer(in: window)
      let field = composer.textView
      field.text = "hello world"
      field.selectedRange = NSRange(location: 2, length: 3)
      field.typingAttributes[.kern] = 1.5
      XCTAssertEqual(field.font?.pointSize ?? 0, TextStyleTable.size(.callout, .large), accuracy: 0.01)

      scale.grow()
      Self.settle(window)
      let size = TextStyleTable.size(.callout, .extraLarge)
      XCTAssertEqual(field.font?.pointSize ?? 0, size, accuracy: 0.01, "a step on the open field")
      XCTAssertEqual(field.selectedRange, NSRange(location: 2, length: 3), "the selection stays")
      XCTAssertEqual(field.typingAttributes[.kern] as? Double, 1.5, "the typing attributes stay")
      XCTAssertEqual((field.typingAttributes[.font] as? UIFont)?.pointSize ?? 0, size, accuracy: 0.01)

      // A content size trait change (the scene's override may reach the views on a Mac) does not put another size
      // on the field: the flat path takes its size from the model only.
      window.traitOverrides.preferredContentSizeCategory = .extraSmall
      Self.settle(window)
      XCTAssertEqual(field.font?.pointSize ?? 0, size, accuracy: 0.01, "a trait change keeps the model's size")
      window.traitOverrides.preferredContentSizeCategory = .large
      Self.settle(window)

      // A step while IME text is being composed waits for the end of composing.
      field.selectedRange = NSRange(location: 11, length: 0)
      field.setMarkedText("ka", selectedRange: NSRange(location: 2, length: 0))
      scale.grow()
      Self.settle(window)
      XCTAssertNotNil(field.markedTextRange, "the composition stays")
      XCTAssertEqual(field.text, "hello worldka")
      field.unmarkText()
      composer.textViewDidChangeSelection(field)
      Self.settle(window)
      XCTAssertEqual(
        field.font?.pointSize ?? 0, TextStyleTable.size(.callout, .extraExtraLarge), accuracy: 0.01,
        "the font after composing")

      composer.removeFromSuperview()
      scale.shrink()
      Self.settle(window)
      Self.place(composer, in: window)
      Self.settle(window)
      XCTAssertEqual(
        field.font?.pointSize ?? 0, TextStyleTable.size(.callout, .extraLarge), accuracy: 0.01, "attached again")
    }
  }

  func testCommandSuggestionRowsTakeTheTableSizeAfterAStep() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let window = Self.window(.large)
      defer { window.isHidden = true }
      let list = CommandSuggestionsView(frame: CGRect(x: 0, y: 0, width: 400, height: 200))
      window.addSubview(list)
      list.show([CommandChoice(name: "review", kind: .prompt, source: .builtin)], selected: 0, showsSelection: false)
      Self.settle(window)
      XCTAssertEqual(try Self.suggestionSize(list), TextStyleTable.size(.subheadline, .large), accuracy: 0.01)

      scale.grow()
      Self.settle(window)
      XCTAssertEqual(
        try Self.suggestionSize(list), TextStyleTable.size(.subheadline, .extraLarge), accuracy: 0.01,
        "a step reaches the open list")
    }
  }

  func testVisibleShortcutTipFitsItsTextAfterAStep() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let window = Self.window(.large)
      defer { window.isHidden = true }
      let anchor = UIView(frame: CGRect(x: 100, y: 100, width: 44, height: 44))
      window.addSubview(anchor)
      let owner = ObjectIdentifier(anchor)
      ShortcutTipBubble.show("New session (⌘N)", below: anchor, owner: owner)
      defer { ShortcutTipBubble.hide(owner: owner) }
      let label = try XCTUnwrap(ShortcutTipBubble.visible?.label)

      scale.grow()
      Self.settle(window)
      XCTAssertEqual(label.font.pointSize, TextStyleTable.size(.footnote, .extraLarge), accuracy: 0.01)
      let text = label.intrinsicContentSize
      XCTAssertGreaterThanOrEqual(label.frame.width, text.width - 0.5, "the open tip is as wide as its text")
      XCTAssertGreaterThanOrEqual(label.frame.height, text.height - 0.5, "the open tip is as tall as its text")
    }
  }

  func testTranscriptProseInALiveCellTakesTheTableSizeAfterAStep() throws {
    try TextStyleScaling.withFlat(true) {
      let scale = makeScale()
      let fixture = try DecisionDockTests.make(size: DecisionDockTests.pad, messages: 1)
      defer { fixture.window.isHidden = true }
      DecisionDockTests.waitRender(fixture) { Self.proseSize($0) != nil }
      let style = MarkdownRenderer.transcriptStyle
      XCTAssertEqual(
        try XCTUnwrap(Self.proseSize(fixture.controller)), TextStyleTable.size(style, .large), accuracy: 0.01)

      scale.grow()
      Self.settle(fixture.window)
      XCTAssertEqual(
        try XCTUnwrap(Self.proseSize(fixture.controller)), TextStyleTable.size(style, .extraLarge), accuracy: 0.01,
        "a step reaches the cells on screen")
    }
  }

  // MARK: - Standard path

  func testWithTheFlatPathOffFollowHoldsNothing() {
    // A registration holds its action until the next step; on the standard path no step may ever come, so a view
    // that registers there would keep its action (and what it captures) alive for good.
    final class Captured: @unchecked Sendable {}
    let owner = NSObject()
    weak var captured: Captured?
    TextStyleScaling.withFlat(false) {
      let value = Captured()
      captured = value
      Fonts.follow(owner, scale: makeScale()) { _ = value }
    }
    XCTAssertNil(captured, "the standard path keeps no action")
    TextStyleScaling.withFlat(true) {
      let value = Captured()
      captured = value
      Fonts.follow(owner, scale: makeScale()) { _ = value }
    }
    XCTAssertNotNil(captured, "the check can fail: the flat path holds the action")
    _ = owner
  }

  func testWithTheFlatPathOffTheViewsKeepTheWindowSizes() throws {
    try TextStyleScaling.withFlat(false) {
      let scale = makeScale()
      let small = UITraitCollection(preferredContentSizeCategory: .small)
      let window = Self.window(.small)
      defer { window.isHidden = true }
      let bar = PromptBarView(frame: .zero)
      bar.quote = "A short prompt"
      window.addSubview(bar)
      let composer = Self.composer(in: window)
      Self.settle(window)
      let quote = try XCTUnwrap(DecisionDockTests.views(of: UILabel.self, in: bar).first)
      let fixture = try Self.dockFixture(window: .small)
      defer { fixture.window.isHidden = true }
      let card = try Self.cardHeight(fixture)

      scale.grow()
      scale.grow()
      Self.settle(window)
      Self.settle(fixture.window)
      let base = UIFont.systemFont(ofSize: TextStyleTable.size(.footnote, .large) + 1)
      let expectedQuote = TextStyleScaling.font(base, relativeTo: .footnote, category: .large, traits: small, flat: false)
      XCTAssertEqual(quote.font.pointSize, expectedQuote.pointSize, accuracy: 0.01, "quote")
      let field = TextStyleScaling.font(ComposerView.textStyle, category: .large, traits: small, flat: false)
      XCTAssertEqual(composer.textView.font?.pointSize ?? 0, field.pointSize, accuracy: 0.01, "field")
      XCTAssertNotEqual(field.pointSize, TextStyleTable.size(.callout, .large), "the check can fail")
      XCTAssertEqual(try Self.cardHeight(fixture), card, accuracy: 0.5, "card")

      let sizes = try Self.markdownSizes(MarkdownRenderer.render(Self.markdown, style: Self.style(small)))
      let heading = UIFont.systemFont(
        ofSize: TextStyleTable.size(.callout, .large) * MarkdownLayout.headingScale(1), weight: .semibold)
      let expectedHeading = TextStyleScaling.font(
        heading, relativeTo: .callout, category: .large, traits: small, flat: false)
      XCTAssertEqual(sizes.heading, expectedHeading.pointSize, accuracy: 0.01, "heading")
      let body = TextStyleScaling.font(
        MarkdownRenderer.transcriptStyle, category: .large, traits: small, flat: false
      ).pointSize
      XCTAssertEqual(sizes.code, (body * 0.9).rounded(), accuracy: 0.01, "inline code")
    }
  }

  // MARK: - Helpers

  /// A text size on scratch `UserDefaults`, the one UIKit views follow for the rest of the test.
  private func makeScale() -> TextScale {
    let scale = TextScale(defaults: defaults, system: .large)
    Fonts.scale = scale
    return scale
  }

  static func window(_ category: TextSizeCategory) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
    window.traitOverrides.preferredContentSizeCategory = category.contentSizeCategory
    window.isHidden = false
    return window
  }

  static func composer(in window: UIWindow) -> ComposerView {
    let composer = ComposerView()
    place(composer, in: window)
    return composer
  }

  static func place(_ composer: ComposerView, in window: UIWindow) {
    composer.translatesAutoresizingMaskIntoConstraints = false
    window.addSubview(composer)
    NSLayoutConstraint.activate([
      composer.leadingAnchor.constraint(equalTo: window.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: window.trailingAnchor),
      composer.bottomAnchor.constraint(equalTo: window.bottomAnchor),
    ])
  }

  /// The quote's size on the flat path: 14 pt at Large, by the table ratio of `footnote`.
  static func quote(_ category: TextSizeCategory) -> CGFloat {
    TextStyleScaling.scale(
      TextStyleTable.size(.footnote, .large) + 1, relativeTo: .footnote, category: category, flat: true)
  }

  static func style(_ traits: UITraitCollection) -> MarkdownRenderer.Style {
    MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: traits)
  }

  /// The heading's size (first character), the inline code's and the body text's around it.
  static func markdownSizes(_ text: NSAttributedString) throws -> (heading: CGFloat, code: CGFloat, body: CGFloat) {
    let heading = try XCTUnwrap(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
    var code: UIFont?
    text.enumerateAttribute(.rarogInlineCode, in: NSRange(location: 0, length: text.length)) { value, range, stop in
      guard (value as? Bool) == true else { return }
      code = text.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
      stop.pointee = true
    }
    let plain = (text.string as NSString).range(of: "Some")
    let body = try XCTUnwrap(text.attribute(.font, at: plain.location, effectiveRange: nil) as? UIFont)
    return (heading.pointSize, try XCTUnwrap(code, "inline code").pointSize, body.pointSize)
  }

  /// A session screen on an iPad with a permission card in the dock.
  static func dockFixture(window category: TextSizeCategory = .large) throws -> DecisionDockTests.Fixture {
    let store = try DecisionDockTests.makeStore(messages: 1, state: "waiting-input")
    let fixture = DecisionDockTests.host(store, size: DecisionDockTests.pad)
    fixture.window.traitOverrides.preferredContentSizeCategory = category.contentSizeCategory
    settle(fixture.window)
    try DecisionDockTests.permission(fixture, "p1")
    DecisionDockTests.waitRender(fixture) { !$0.decisionSlot.isHidden }
    settle(fixture.window)
    return fixture
  }

  /// The card's height in a fresh dock on a window of `category`.
  static func cardHeight(window category: TextSizeCategory) throws -> CGFloat {
    let fixture = try dockFixture(window: category)
    defer { fixture.window.isHidden = true }
    return try cardHeight(fixture)
  }

  static func cardHeight(_ fixture: DecisionDockTests.Fixture) throws -> CGFloat {
    fixture.window.layoutIfNeeded()
    return try XCTUnwrap(DecisionDockTests.dockCardFrame(fixture.controller)).height
  }

  /// The size of the command name in the list's first row.
  static func suggestionSize(_ list: CommandSuggestionsView) throws -> CGFloat {
    let label = try XCTUnwrap(
      DecisionDockTests.views(of: UILabel.self, in: list).first { ($0.attributedText?.length ?? 0) > 0 })
    let text = try XCTUnwrap(label.attributedText)
    return try XCTUnwrap(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont).pointSize
  }

  /// The size of the first prose character in the transcript's first message text, as the cell shows it now.
  static func proseSize(_ controller: SessionViewController) -> CGFloat? {
    let prose = DecisionDockTests.views(of: MessageTextView.self, in: controller.view).first {
      $0.attributedText.string.hasPrefix("Odpowiedź")
    }
    guard let text = prose?.attributedText, text.length > 0 else { return nil }
    return (text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.pointSize
  }

  /// Lets the model's follow-up task run and the views lay out.
  static func settle(_ window: UIWindow) {
    for _ in 0..<4 {
      window.setNeedsLayout()
      window.layoutIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
  }
}
