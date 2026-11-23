@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The app's text size on the scene (`TextScaleSceneBinding`): a step of ⌘+ or ⌘- reaches a hosted SwiftUI view and a
/// `UILabel` that adjusts to the content size category, the stored step applies when the binding starts (the scene
/// connecting), and a system accessibility size lifts the override until the system leaves it. The test host has no
/// scene, so the binding carries the override on a window, which gives views the same traits as the scene does.
///
/// On the flat path (the iPad app on a Mac, where every text style has one size and the override moves no font) the
/// Text Size page's Use System Size row and the question card take the table size of the model's step while the window
/// stays at Large; the references are the same views on the standard path at the window's category, which the table
/// equals here.
@MainActor
final class TextScaleSceneTests: XCTestCase {
  /// A domain of its own, removed after the test.
  private var suite = ""
  private var defaults = UserDefaults.standard

  override func setUp() async throws {
    try await super.setUp()
    suite = "rarog-test-text-scale-\(UUID().uuidString)"
    defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
  }

  override func tearDown() async throws {
    Fonts.scale = .shared
    defaults.removePersistentDomain(forName: suite)
    try await super.tearDown()
  }

  /// What the views on screen see.
  final class Seen {
    var size: DynamicTypeSize?
  }

  struct Probe: View {
    let seen: Seen
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
      let _ = seen.size = size
      Text(verbatim: "Aa").font(.body)
    }
  }

  private struct Screen {
    let window: UIWindow
    let label: UILabel
    let seen: Seen
  }

  private func screen() -> Screen {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
    let seen = Seen()
    let host = UIHostingController(rootView: Probe(seen: seen))
    window.rootViewController = host
    let label = UILabel()
    label.font = UIFont.preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.text = "Aa"
    host.view.addSubview(label)
    window.isHidden = false
    settle(window)
    return Screen(window: window, label: label, seen: seen)
  }

  private func settle(_ window: UIWindow) {
    for _ in 0..<3 {
      window.setNeedsLayout()
      window.layoutIfNeeded()
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
  }

  private static func bodySize(_ category: TextSizeCategory) -> CGFloat {
    let traits = UITraitCollection(preferredContentSizeCategory: category.contentSizeCategory)
    return UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
  }

  private func assertShows(_ category: TextSizeCategory, _ screen: Screen, _ note: String, line: UInt = #line) {
    settle(screen.window)
    XCTAssertEqual(screen.label.font.pointSize, Self.bodySize(category), "label, \(note)", line: line)
    XCTAssertEqual(screen.seen.size, DynamicTypeSize(category.contentSizeCategory), "SwiftUI, \(note)", line: line)
  }

  func testStoredStepAppliesWhenTheSceneStarts() {
    let real = UIScreen.main.traitCollection.preferredContentSizeCategory
    XCTAssertNotEqual(real, .extraExtraExtraLarge, "the stored step must differ from the system's size")
    defaults.set(TextSizeCategory.extraExtraExtraLarge.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: defaults)
    let screen = screen()
    let binding = TextScaleSceneBinding(scale: scale, target: .window(screen.window)) { .small }
    assertShows(.extraExtraExtraLarge, screen, "stored step at start")
    XCTAssertEqual(scale.system, .small, "the binding reads the system's size at start")
    _ = binding
  }

  func testStepReachesHostedSwiftUIAndLabel() {
    let scale = TextScale(defaults: defaults)
    let screen = screen()
    let binding = TextScaleSceneBinding(scale: scale, target: .window(screen.window)) { .small }
    scale.shrink()
    XCTAssertEqual(scale.override, .extraSmall)
    assertShows(.extraSmall, screen, "after ⌘-")
    for _ in 0..<6 { scale.grow() }
    XCTAssertEqual(scale.override, .extraExtraExtraLarge)
    assertShows(.extraExtraExtraLarge, screen, "after six ⌘+")
    scale.reset()
    XCTAssertFalse(screen.window.traitOverrides.contains(UITraitPreferredContentSizeCategory.self), "⌘0 lifts it")
    _ = binding
  }

  func testSystemAccessibilitySizeLiftsTheOverrideUntilItLeaves() {
    let center = NotificationCenter()
    var system = UIContentSizeCategory.large
    defaults.set(TextSizeCategory.extraSmall.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: defaults)
    let screen = screen()
    let binding = TextScaleSceneBinding(
      scale: scale, target: .window(screen.window), systemCategory: { system }, center: center)
    assertShows(.extraSmall, screen, "stored step")
    system = .accessibilityMedium
    center.post(name: UIContentSizeCategory.didChangeNotification, object: nil)
    XCTAssertEqual(scale.effective, .accessibilityMedium)
    XCTAssertFalse(screen.window.traitOverrides.contains(UITraitPreferredContentSizeCategory.self), "no override")
    XCTAssertFalse(scale.canGrow || scale.canShrink, "⌘+ and ⌘- disabled")
    system = .large
    center.post(name: UIContentSizeCategory.didChangeNotification, object: nil)
    assertShows(.extraSmall, screen, "the stored step back")
    _ = binding
  }

  // MARK: - Flat path

  func testFlatPathSettingsRowTakesTheTableSizeAtExtraExtraExtraLarge() throws {
    // A step is stored in the reference too, so the row is the same and only the text size differs.
    defaults.set(TextSizeCategory.extraExtraExtraLarge.rawValue, forKey: TextScale.key)
    let reference = try TextStyleScaling.withFlat(false) {
      try [TextSizeCategory.large, .extraExtraExtraLarge].map { window in
        try settingsRowHeight(TextScale(defaults: defaults, system: .large), window: window) {}
      }
    }
    XCTAssertGreaterThan(reference[1], reference[0] + 2, "the check can fail")
    defaults.set(TextSizeCategory.extraExtraLarge.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: defaults, system: .large)
    let height = try TextStyleScaling.withFlat(true) {
      try settingsRowHeight(scale, window: .large) { scale.grow() }
    }
    XCTAssertEqual(scale.effective, .extraExtraExtraLarge)
    XCTAssertEqual(height, reference[1], accuracy: 1, "the open row after ⌘+ on a window at Large")
  }

  func testFlatPathQuestionCardTakesTheTableSizeAtExtraExtraExtraLarge() throws {
    let reference = try TextStyleScaling.withFlat(false) {
      try [TextSizeCategory.large, .extraExtraExtraLarge].map { window in
        let fixture = try Self.questionFixture(window: window)
        defer { fixture.window.isHidden = true }
        return try TextScaleMacPathTests.cardHeight(fixture)
      }
    }
    XCTAssertGreaterThan(reference[1], reference[0] + 2, "the check can fail")
    defaults.set(TextSizeCategory.extraExtraLarge.rawValue, forKey: TextScale.key)
    let scale = TextScale(defaults: defaults, system: .large)
    Fonts.scale = scale
    try TextStyleScaling.withFlat(true) {
      let fixture = try Self.questionFixture(window: .large)
      defer { fixture.window.isHidden = true }
      scale.grow()
      TextScaleMacPathTests.settle(fixture.window)
      XCTAssertEqual(scale.effective, .extraExtraExtraLarge)
      XCTAssertEqual(
        try TextScaleMacPathTests.cardHeight(fixture), reference[1], accuracy: 1,
        "the open card after ⌘+ on a window at Large")
    }
  }

  /// The height of the Text Size page's Use System Size row (a step is stored, so it shows) under the host of `scale`,
  /// on a window of `category`, after `step`. Not a step row: each of those draws its name in its own fixed size. The
  /// window is narrow so the row's text wraps: a form row's minimum height grows with the category alone and would
  /// hide a body font that stays at Large; it is tall so the last row exists.
  private func settingsRowHeight(
    _ scale: TextScale, window category: TextSizeCategory, step: () -> Void
  ) throws -> CGFloat {
    let host = UIHostingController(rootView: TextSizeSettingsPage(scale: scale).textScaleHost(scale))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 260, height: 2400))
    window.traitOverrides.preferredContentSizeCategory = category.contentSizeCategory
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    TextScaleMacPathTests.settle(window)
    step()
    TextScaleMacPathTests.settle(window)
    let cells = DecisionDockTests.views(of: UICollectionViewCell.self, in: host.view).filter { !$0.isHidden }
    // Headers and footers are cells of the list too: from the top, the last one is the footer under Use System Size.
    let ordered = cells.sorted { $0.frame.minY < $1.frame.minY }
    XCTAssertGreaterThanOrEqual(ordered.count, 2, "the page's rows")
    let row = try XCTUnwrap(ordered.dropLast().last, "Use System Size, above its footer")
    return row.frame.height
  }

  /// A session screen on an iPad with a short question card in the dock, on a window of `category`.
  private static func questionFixture(window category: TextSizeCategory) throws -> DecisionDockTests.Fixture {
    let store = try DecisionDockTests.makeStore(messages: 1, state: "waiting-input")
    let fixture = DecisionDockTests.host(store, size: DecisionDockTests.pad)
    fixture.window.traitOverrides.preferredContentSizeCategory = category.contentSizeCategory
    TextScaleMacPathTests.settle(fixture.window)
    try DecisionDockTests.question(fixture, DecisionDockTests.short)
    DecisionDockTests.waitRender(fixture) { !$0.decisionSlot.isHidden }
    TextScaleMacPathTests.settle(fixture.window)
    return fixture
  }
}
