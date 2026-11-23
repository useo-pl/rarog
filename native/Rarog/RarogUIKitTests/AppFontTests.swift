@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The SwiftUI half of the text scaling contract: `AppFont`, `.appFont(_:)`, the host modifier (`.textScaleHost()`)
/// and `@AppScaledMetric`. The bugs caught here: on the standard path (`flat == false`) a font that is not exactly
/// today's expression (the iPad would change); on the flat path (a Mac, where every text style has one size) a font
/// that does not take its size from the table, loses its weight, digits or leading, text without a font that stays
/// at one size, and a metric that does not follow a step on an open view or breaks a local ceiling.
@MainActor
final class AppFontTests: XCTestCase {
  private var suite = ""
  private var defaults = UserDefaults.standard

  override func setUp() async throws {
    try await super.setUp()
    suite = "rarog-test-app-font-\(UUID().uuidString)"
    defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
  }

  override func tearDown() async throws {
    defaults.removePersistentDomain(forName: suite)
    try await super.tearDown()
  }

  // MARK: - Standard path

  /// Every font expression the views use today, and the `AppFont` that replaces it.
  static let todays: [(String, AppFont, Font)] = [
    ("largeTitle", .largeTitle, .largeTitle), ("title", .title, .title), ("title2", .title2, .title2),
    ("title3", .title3, .title3), ("headline", .headline, .headline), ("subheadline", .subheadline, .subheadline),
    ("body", .body, .body), ("callout", .callout, .callout), ("footnote", .footnote, .footnote),
    ("caption", .caption, .caption), ("caption2", .caption2, .caption2),
    ("caption mono", .caption.monospaced(), .caption.monospaced()),
    ("footnote mono", .footnote.monospaced(), .footnote.monospaced()),
    ("callout mono", .callout.monospaced(), .callout.monospaced()),
    ("body mono", .body.monospaced(), .body.monospaced()),
    ("subheadline mono", .subheadline.monospaced(), .subheadline.monospaced()),
    ("headline mono", .headline.monospaced(), .headline.monospaced()),
    ("title3 mono", .title3.monospaced(), .title3.monospaced()),
    ("caption2 mono", .caption2.monospaced(), .caption2.monospaced()),
    ("caption semibold", .caption.weight(.semibold), .caption.weight(.semibold)),
    ("caption medium", .caption.weight(.medium), .caption.weight(.medium)),
    ("caption bold", .caption.weight(.bold), .caption.weight(.bold)),
    ("caption2 bold", .caption2.weight(.bold), .caption2.weight(.bold)),
    ("caption2 semibold", .caption2.weight(.semibold), .caption2.weight(.semibold)),
    ("caption2 regular", .caption2.weight(.regular), .caption2.weight(.regular)),
    ("subheadline semibold", .subheadline.weight(.semibold), .subheadline.weight(.semibold)),
    ("subheadline medium", .subheadline.weight(.medium), .subheadline.weight(.medium)),
    ("subheadline regular", .subheadline.weight(.regular), .subheadline.weight(.regular)),
    ("footnote semibold", .footnote.weight(.semibold), .footnote.weight(.semibold)),
    ("footnote regular", .footnote.weight(.regular), .footnote.weight(.regular)),
    ("callout semibold", .callout.weight(.semibold), .callout.weight(.semibold)),
    ("body semibold", .body.weight(.semibold), .body.weight(.semibold)),
    ("title2 semibold", .title2.weight(.semibold), .title2.weight(.semibold)),
    ("caption mono medium", .caption.monospaced().weight(.medium), .caption.monospaced().weight(.medium)),
    ("caption mono semibold", .caption.monospaced().weight(.semibold), .caption.monospaced().weight(.semibold)),
    ("caption mono regular", .caption.monospaced().weight(.regular), .caption.monospaced().weight(.regular)),
    ("caption2 mono medium", .caption2.monospaced().weight(.medium), .caption2.monospaced().weight(.medium)),
    ("caption2 mono semibold", .caption2.monospaced().weight(.semibold), .caption2.monospaced().weight(.semibold)),
    ("footnote mono semibold", .footnote.monospaced().weight(.semibold), .footnote.monospaced().weight(.semibold)),
    ("footnote mono regular", .footnote.monospaced().weight(.regular), .footnote.monospaced().weight(.regular)),
    ("subheadline mono semibold", .subheadline.monospaced().weight(.semibold), .subheadline.monospaced().weight(.semibold)),
    ("caption digits", .caption.monospacedDigit(), .caption.monospacedDigit()),
    ("footnote digits", .footnote.monospacedDigit(), .footnote.monospacedDigit()),
    ("callout digits", .callout.monospacedDigit(), .callout.monospacedDigit()),
  ]

  func testResolveOnTheStandardPathIsTodaysExpression() {
    for (name, font, today) in Self.todays {
      for category in TextSizeCategory.allCases {
        XCTAssertEqual(font.resolve(category, flat: false), today, "\(name) at \(category)")
        XCTAssertEqual(font.resolve(typeSize: category.dynamicTypeSize, flat: false), today, "\(name) at \(category)")
      }
    }
    // The comparison sees the modifiers: another order or an explicit regular weight is another font.
    XCTAssertNotEqual(AppFont.caption.resolve(TextSizeCategory.large, flat: false), Font.footnote)
    XCTAssertNotEqual(AppFont.subheadline.resolve(TextSizeCategory.large, flat: false), Font.subheadline.weight(.regular))
  }

  // MARK: - Flat path

  func testResolveOnTheFlatPathTakesTheTableSizeAtEveryStep() {
    for (name, font, _) in Self.todays {
      for category in TextSizeCategory.steps {
        let ui = font.uiFont(category, flat: true)
        XCTAssertEqual(ui.pointSize, TextStyleTable.size(font.uiStyle, category), "\(name) at \(category)")
        XCTAssertEqual(font.resolve(category, flat: true), Font(ui as CTFont), "\(name) at \(category)")
      }
    }
  }

  func testTheFlatPathKeepsWeightAndTabularDigits() {
    let font = AppFont.caption.monospacedDigit().weight(.semibold).uiFont(.extraExtraLarge, flat: true)
    XCTAssertEqual(TextStyleTableTests.weight(of: font), UIFont.Weight.semibold.rawValue, accuracy: 0.01)
    XCTAssertEqual(
      TextStyleTableTests.width("1111", font), TextStyleTableTests.width("8888", font), accuracy: 0.01, "tabular digits")
    let mono = AppFont.footnote.monospaced().weight(.medium).uiFont(.small, flat: true)
    XCTAssertTrue(TextStyleTableTests.isMonospaced(mono), mono.fontName)
    XCTAssertEqual(TextStyleTableTests.weight(of: mono), UIFont.Weight.medium.rawValue, accuracy: 0.01)

    // Rendered: the digits stay tabular in a view.
    let one = Self.size(Text(verbatim: "1111").appFont(.body.monospacedDigit()), flat: true, category: .extraLarge)
    let eight = Self.size(Text(verbatim: "8888").appFont(.body.monospacedDigit()), flat: true, category: .extraLarge)
    XCTAssertEqual(one.width, eight.width, accuracy: 0.5)
  }

  /// Two lines of each style at Large stand as high as the system's style does; `.system(size:)` stands lower.
  func testTwoLinesAtLargeKeepTheStyleLeading() {
    for (name, font, today) in Self.todays.prefix(11) {
      let flat = Self.size(Text(verbatim: "Aa\nAa").appFont(font), flat: true, category: .large).height
      let system = Self.size(Text(verbatim: "Aa\nAa").font(today), flat: false, category: .large).height
      XCTAssertEqual(flat, system, accuracy: 0.01, name)
    }
    let bare = Self.size(Text(verbatim: "Aa\nAa").font(.system(size: 17)), flat: false, category: .large).height
    let body = Self.size(Text(verbatim: "Aa\nAa").appFont(.body), flat: true, category: .large).height
    XCTAssertNotEqual(bare, body, "the check can fail")
  }

  func testAppFontInAViewReadsTheViewCategory() {
    for category in TextSizeCategory.steps {
      let modifier = Self.size(Text(verbatim: "Aa").appFont(.callout), flat: true, category: category)
      let explicit = Self.size(
        Text(verbatim: "Aa").font(AppFont.callout.resolve(category, flat: true)), flat: true, category: .large)
      XCTAssertEqual(modifier.height, explicit.height, accuracy: 0.01, "\(category)")
    }
  }

  func testTextAndAttributedStringVariantsResolveFromTheGivenSize() {
    let text = Text(verbatim: "Aa").appFont(.caption.monospaced(), .xxLarge, flat: true)
    let expected = Text(verbatim: "Aa").font(AppFont.caption.monospaced().resolve(.extraExtraLarge, flat: true))
    XCTAssertEqual(
      Self.size(text, flat: false, category: .large).height, Self.size(expected, flat: false, category: .large).height,
      accuracy: 0.01)
    var piece = AttributedString("Aa")
    piece.setAppFont(.caption, .xLarge, flat: true)
    XCTAssertEqual(piece.swiftUI.font, AppFont.caption.resolve(.extraLarge, flat: true))
    piece.setAppFont(.caption, .xLarge, flat: false)
    XCTAssertEqual(piece.swiftUI.font, Font.caption)
  }

  // MARK: - Host

  /// What a view under the host sees.
  final class Seen {
    var font: Font?
    var size: DynamicTypeSize?
    var metric: CGFloat = 0
    var system: CGFloat = 0
  }

  struct Probe: View {
    let seen: Seen
    @Environment(\.font) private var font
    @Environment(\.dynamicTypeSize) private var size
    @AppScaledMetric(relativeTo: .footnote) private var metric: CGFloat = 10
    @ScaledMetric(relativeTo: .footnote) private var system: CGFloat = 10

    var body: some View {
      let _ = seen.font = font
      let _ = seen.size = size
      let _ = seen.metric = metric
      let _ = seen.system = system
      Text(verbatim: "Aa\nAa")
    }
  }

  func testTextWithoutAFontUnderTheHostTakesTheTableSizeAndFollowsAStep() throws {
    let scale = scale()
    scale.grow()
    scale.grow()
    let seen = Seen()
    let screen = Self.screen(Probe(seen: seen).textScaleHost(scale), flat: true)
    defer { screen.window.isHidden = true }
    XCTAssertEqual(seen.size, .xxLarge)
    XCTAssertEqual(seen.font, AppFont.body.resolve(.extraExtraLarge, flat: true))
    let expected = Self.size(
      Text(verbatim: "Aa\nAa").font(AppFont.body.resolve(.extraExtraLarge, flat: true)), flat: false, category: .large)
    XCTAssertEqual(screen.host.view.intrinsicContentSize.height, expected.height, accuracy: 0.5, "rendered")

    scale.shrink()
    Self.settle(screen.window)
    XCTAssertEqual(seen.size, .xLarge, "a step reaches an open view")
    XCTAssertEqual(seen.font, AppFont.body.resolve(.extraLarge, flat: true))
  }

  func testTheHostAddsNothingOnTheStandardPath() {
    let scale = scale()
    scale.grow()
    let seen = Seen()
    let screen = Self.screen(Probe(seen: seen).textScaleHost(scale), flat: false, window: .small)
    defer { screen.window.isHidden = true }
    XCTAssertNil(seen.font, "no default font")
    XCTAssertEqual(seen.size, .small, "the view keeps the window's category, not the model's")
    XCTAssertEqual(seen.metric, seen.system, "the metric is ScaledMetric")
  }

  func testTheMetricFollowsAStepOnAnOpenViewAndKeepsALocalCeiling() {
    let scale = scale()
    let open = Seen()
    let capped = Seen()
    let screen = Self.screen(
      VStack {
        Probe(seen: open)
        Probe(seen: capped).dynamicTypeSize(...DynamicTypeSize.large)
      }.textScaleHost(scale), flat: true)
    defer { screen.window.isHidden = true }
    XCTAssertEqual(open.metric, 10)
    scale.grow()
    scale.grow()
    scale.grow()
    Self.settle(screen.window)
    XCTAssertEqual(open.size, .xxxLarge)
    XCTAssertEqual(
      open.metric, TextStyleScaling.scale(10, relativeTo: .footnote, category: .extraExtraExtraLarge, flat: true),
      accuracy: 0.0001)
    XCTAssertGreaterThan(open.metric, 10)
    XCTAssertEqual(capped.size, .large, "the local ceiling holds")
    XCTAssertEqual(capped.metric, 10, "the metric under the ceiling stays at Large")
    XCTAssertEqual(capped.font, AppFont.body.resolve(.extraExtraExtraLarge, flat: true), "the host's default font")
  }

  func testTheDefaultFontUnderACeilingFollowsTheCeilingWhenAppliedAgain() {
    let scale = scale()
    scale.grow()
    scale.grow()
    let seen = Seen()
    let screen = Self.screen(
      Probe(seen: seen).appDefaultFont().dynamicTypeSize(...DynamicTypeSize.large).textScaleHost(scale), flat: true)
    defer { screen.window.isHidden = true }
    XCTAssertEqual(seen.font, AppFont.body.resolve(TextSizeCategory.large, flat: true))
  }

  // MARK: - Helpers

  private func scale() -> TextScale {
    TextScale(defaults: defaults, system: .large)
  }

  struct Screen {
    let window: UIWindow
    let host: UIHostingController<AnyView>
  }

  static func screen(_ view: some View, flat: Bool, window category: TextSizeCategory = .large) -> Screen {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 600))
    window.traitOverrides.preferredContentSizeCategory = category.contentSizeCategory
    let host = UIHostingController(rootView: AnyView(view.fixedSize().environment(\.textStyleFlat, flat)))
    host.sizingOptions = .intrinsicContentSize
    window.rootViewController = host
    window.isHidden = false
    settle(window)
    return Screen(window: window, host: host)
  }

  /// The size a view takes at `category` with the flat path on or off.
  static func size(_ view: some View, flat: Bool, category: TextSizeCategory) -> CGSize {
    let host = UIHostingController(
      rootView: AnyView(view.fixedSize().environment(\.textStyleFlat, flat).dynamicTypeSize(category.dynamicTypeSize)))
    return host.sizeThatFits(in: CGSize(width: 2000, height: 2000))
  }

  static func settle(_ window: UIWindow) {
    for _ in 0..<3 {
      window.setNeedsLayout()
      window.layoutIfNeeded()
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
  }
}
