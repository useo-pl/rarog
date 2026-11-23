import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// The message field card is glass: the activity row is its first line, in a band
/// open for a turn, the message line (`composer.hint`) its last line, radius 26 pt, sides 10 pt, the transcript runs
/// under it and the foot carries the system soft scroll edge. With the field hidden (decision, state card, grace) an
/// activity row with content stands alone as a narrow card of the same material; the "1 of N" dock header stands on a
/// surface too. Real `SessionViewController` in a window; helpers from `DecisionDockTests`. Owner: send.
@MainActor
final class ComposerCardTests: XCTestCase {
  typealias D = DecisionDockTests
  typealias U = TranscriptUnderFootTests
  static let sizes = [DecisionDockTests.phone, DecisionDockTests.pad]

  override func setUp() {
    super.setUp()
    TranscriptMemory.positions.remember("s1", nil)
  }

  override func tearDown() {
    TranscriptMemory.positions.remember("s1", nil)
    super.tearDown()
  }

  // MARK: - Activity row in the card

  /// The activity row is the first line of the field card, in a band open from the start of a turn to its end
  /// (`ActivityBand`): idle, the card is only as tall as the field; working, it grows upwards
  /// (its bottom stays) and the line stands above the text; a line that goes out mid-turn (a streaming answer) leaves
  /// the band; the turn's end closes it.
  func testActivityBandOpensForTurnAndClosesAfterIt() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 20)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      try D.session(fixture, state: "waiting-input")
      D.waitRender(fixture) { !$0.composer.activityBandOpen }
      U.layout(fixture)
      let card = try Self.card(controller)
      XCTAssertTrue(controller.activityRow.isDescendant(of: card), "\(size): the activity row is in the field card")
      let idle = Self.frame(card, in: controller)
      XCTAssertEqual(controller.composer.activitySlot.bounds.height, 0, "\(size): idle, no band")
      XCTAssertLessThanOrEqual(
        Self.frame(controller.composer.textView, in: controller).minY - idle.minY, 4.5, "\(size): the text starts at the top")

      try D.session(fixture, state: "running")
      D.waitRender(fixture) { $0.activityRow.isAccessibilityElement && $0.composer.activityBandOpen }
      U.layout(fixture)
      let working = Self.frame(card, in: controller)
      let row = Self.frame(controller.activityRow, in: controller)
      let text = Self.frame(controller.composer.textView, in: controller)
      XCTAssertEqual(working.maxY, idle.maxY, accuracy: 0.5, "\(size): the card's bottom stays")
      XCTAssertLessThan(working.minY, idle.minY - 10, "\(size): the card grows upwards by the band")
      XCTAssertGreaterThanOrEqual(row.minY, working.minY - 0.5, "\(size): the line starts inside the card")
      XCTAssertLessThanOrEqual(row.maxY, text.minY + 0.5, "\(size): the line stands above the text")

      // A streaming answer has its own cursor: the row goes blank, the band stays (no pulse mid-turn).
      try D.frame(fixture.store, #"{"type":"delta","sessionId":"s1","text":"Płynie odpowiedź"}"#, source: .session("s1"))
      D.waitRender(fixture) { !$0.activityRow.isAccessibilityElement }
      U.layout(fixture)
      XCTAssertTrue(controller.composer.activityBandOpen, "\(size): the band stays through the turn")
      XCTAssertEqual(Self.frame(card, in: controller), working, "\(size): the card holds its frame mid-turn")

      try D.session(fixture, state: "waiting-input")
      D.waitRender(fixture) { !$0.composer.activityBandOpen }
      U.layout(fixture)
      XCTAssertEqual(Self.frame(card, in: controller), idle, "\(size): the turn's end closes the band")
    }
  }

  /// The message line (send errors, interrupt refusals) is the card's last line, under the control row, and may wrap.
  /// The card grows upwards: its bottom stays at rest.
  func testMessageLineIsLastLineOfCard() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 20)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    U.layout(fixture)
    let card = try Self.card(controller)
    let rest = Self.frame(card, in: controller)
    controller.composer.setHint(
      "Nie udało się wysłać wiadomości. Serwer odpowiedział błędem, spróbuj jeszcze raz za chwilę albo sprawdź sieć.",
      isError: true)
    U.layout(fixture)
    let hint = try XCTUnwrap(D.find(controller.composer, id: "composer.hint") as? UILabel, "message line")
    XCTAssertTrue(hint.isDescendant(of: card), "the message line is in the card")
    let line = Self.frame(hint, in: controller)
    let send = Self.frame(controller.composer.sendButtonView, in: controller)
    let grown = Self.frame(card, in: controller)
    XCTAssertGreaterThanOrEqual(line.minY, send.maxY - 0.5, "under the control row")
    XCTAssertLessThanOrEqual(line.maxY, grown.maxY - 4, "inside the card, above its bottom edge")
    XCTAssertGreaterThan(line.height, hint.font.lineHeight * 1.5, "a long sentence wraps")
    XCTAssertEqual(grown.maxY, rest.maxY, accuracy: 0.5, "the card's bottom stays at rest")
    XCTAssertGreaterThan(grown.height, rest.height, "the card grows by the line")
    U.assertContract(controller, "message line")
    controller.composer.setHint(nil)
    U.layout(fixture)
    XCTAssertEqual(Self.frame(card, in: controller), rest, "without the line the card is back")
  }

  // MARK: - Material and shape

  /// The card is system Liquid Glass with the measured layer, radius 26 pt, 10 pt from the column's edges; the
  /// transcript shows around it (no opaque backdrop) and the foot carries the soft scroll edge of the list.
  func testCardIsGlassWithRadiusSidesAndScrollEdge() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 20)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      U.layout(fixture)
      let card = try Self.card(controller)
      let glass = D.views(of: UIVisualEffectView.self, in: card).first { $0.effect is UIGlassEffect }
      XCTAssertNotNil(glass, "\(size): the card has a glass effect view")
      XCTAssertEqual(card.layer.cornerRadius, 26, accuracy: 0.01, "\(size): radius 26 pt")
      // The glass draws its own shape (a capsule by default): its corner configuration has to give the card's radius.
      XCTAssertEqual(glass?.effectiveRadius(corner: .topLeft) ?? 0, 26, accuracy: 0.01, "\(size): the glass is 26 pt too")
      let frame = Self.frame(card, in: controller)
      let safe = controller.view.safeAreaLayoutGuide.layoutFrame
      XCTAssertEqual(frame.minX - safe.minX, 10, accuracy: 0.5, "\(size): 10 pt from the left edge")
      XCTAssertEqual(safe.maxX - frame.maxX, 10, accuracy: 0.5, "\(size): 10 pt from the right edge")
      XCTAssertNil(D.find(controller.view, id: "session.footBackdrop"), "\(size): no opaque band under the foot")
      XCTAssertEqual(controller.composer.backgroundColor ?? .clear, .clear, "\(size): the field view is clear")
      let foot = try XCTUnwrap(controller.composer.superview, "foot stack")
      let edge = foot.interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }.first
      XCTAssertNotNil(edge, "\(size): the foot has the scroll edge interaction")
      XCTAssertEqual(edge?.edge, .bottom, "\(size): bottom edge")
      XCTAssertTrue(edge?.scrollView === controller.collectionView, "\(size): of the transcript")
    }
  }

  /// A disabled field keeps its dashed edge over the card's material, also with the solid card of Reduce Transparency.
  func testDisabledFieldDashedEdgeIsOverTheSurface() throws {
    let fixture = try DecisionInTranscriptTests.make(size: Self.sizes[0], messages: 20)
    defer { fixture.window.isHidden = true }
    let composer = fixture.controller.composer
    composer.isEditable = false
    U.layout(fixture)
    let card = try Self.card(fixture.controller)
    let surface = try XCTUnwrap(
      D.views(of: UIVisualEffectView.self, in: card).first { $0.effect is UIGlassEffect }?.superview, "card surface")
    let host = try XCTUnwrap(surface.superview?.layer.sublayers, "the field container's layers")
    let dashed = try XCTUnwrap(
      host.first { ($0 as? CAShapeLayer)?.lineDashPattern != nil }, "the dashed edge in the field container")
    let dashedIndex = try XCTUnwrap(host.firstIndex { $0 === dashed })
    let surfaceIndex = try XCTUnwrap(host.firstIndex { $0 === surface.layer })
    XCTAssertGreaterThan(dashedIndex, surfaceIndex, "the dashed edge is drawn over the surface")
  }

  /// One line on the iPad: with the keyboard down the field card ends `ListFooterMetrics.bottomGap` from the
  /// bottom edge, the distance the list footer card keeps, so both glass cards end on the same line.
  func testCardBottomKeepsTheFooterGap() throws {
    for safeBottom: CGFloat in [20, 0, 34] {
      let fixture = try SessionLayoutTests.makeSession(safeBottom: safeBottom)
      defer { fixture.window.isHidden = true }
      guard fixture.window.safeAreaInsets.bottom <= safeBottom else { continue }
      let card = try Self.card(fixture.controller)
      let frame = card.convert(card.bounds, to: nil)
      XCTAssertEqual(
        fixture.window.bounds.maxY - frame.maxY, ListFooterMetrics.bottomGap(safeBottom: safeBottom), accuracy: 0.5,
        "safe area \(safeBottom): the footer card's gap")
    }
  }

  // MARK: - Hidden field

  /// Stop, then a decision card before the interrupt's REST reply: the field hides, but "interrupting" stays on screen
  /// in a narrow card of the same glass at the top of the foot, and the transcript inset keeps the contract.
  func testInterruptingStaysVisibleWhenDecisionHidesField() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 20)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.session(fixture, state: "running")
    D.waitRender(fixture) { $0.activityRow.isAccessibilityElement }
    fixture.store.dispatch(.turnControl(.interruptStarted(sessionId: "s1", at: Date())))
    D.waitRender(fixture) { $0.activityRow.accessibilityLabel?.contains(UICopy.activityInterrupting) == true }
    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    U.layout(fixture)

    let row = controller.activityRow
    XCTAssertTrue(row.accessibilityLabel?.contains(UICopy.activityInterrupting) == true, "still interrupting")
    XCTAssertTrue(Self.isOnScreen(row), "the row is visible with the field hidden")
    XCTAssertFalse(row.isDescendant(of: controller.composer), "not in the hidden field")
    let card = try XCTUnwrap(D.find(controller.view, id: "foot.activity"), "the narrow activity card")
    XCTAssertTrue(row.isDescendant(of: card), "the row stands in the narrow card")
    let glass = D.views(of: UIVisualEffectView.self, in: card).first { $0.effect is UIGlassEffect }
    XCTAssertTrue(glass.map(Self.isOnScreen) ?? false, "the narrow card is glass")
    let frame = Self.frame(row, in: controller)
    XCTAssertLessThanOrEqual(frame.maxY, controller.view.bounds.maxY - 8, "above the bottom edge")
    U.assertContract(controller, "interrupting, hidden field")
  }

  /// The narrow card is glass only while the row has something to say; an empty row leaves no card on screen.
  func testNarrowCardShowsOnlyWithContent() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 20)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    U.layout(fixture)
    XCTAssertFalse(controller.activityRow.isAccessibilityElement, "waiting for a decision: nothing to say")
    let card = try XCTUnwrap(D.find(controller.view, id: "foot.activity"), "the narrow activity card")
    let glass = D.views(of: UIVisualEffectView.self, in: card).first { $0.effect is UIGlassEffect }
    XCTAssertFalse(glass.map(Self.isOnScreen) ?? false, "no empty glass card")
  }

  /// The "1 of N" dock header stands on a surface of its own, not straight over the scrolling transcript.
  func testDockPositionStandsOnSurface() throws {
    let fixture = D.host(try D.makeStore(messages: 20, state: "waiting-permission", permissions: ["p1", "p2"]), size: D.phone)
    defer { fixture.window.isHidden = true }
    D.waitRender(fixture) { !$0.decisionSlot.isHidden }
    U.layout(fixture)
    let position = try XCTUnwrap(D.label(in: fixture.controller.decisionSlot, id: "dock.position"), "\"1 of N\"")
    XCTAssertFalse(position.isHidden, "two cards: the header shows")
    let surface = try XCTUnwrap(D.find(fixture.controller.decisionSlot, id: "dock.position.surface"), "header surface")
    XCTAssertTrue(position.isDescendant(of: surface), "the header stands on its surface")
    let glass = D.views(of: UIVisualEffectView.self, in: surface).first { $0.effect is UIGlassEffect }
    XCTAssertNotNil(glass, "the surface is the cards' glass")
  }

  // MARK: - Screenshot

  /// Screenshots for review (layer render: no glass blur, the card's layer and edge only): iPhone, the agent at work
  /// with the activity row in the field card, then Stop and a decision before the REST reply, "interrupting" in the
  /// narrow card, both themes.
  func testScreenshotInterruptingWithDecision() throws {
    for style in [UIUserInterfaceStyle.dark, .light] {
      let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 20)
      defer { fixture.window.isHidden = true }
      fixture.window.overrideUserInterfaceStyle = style
      try D.session(fixture, state: "running")
      D.waitRender(fixture) { $0.activityRow.isAccessibilityElement }
      U.layout(fixture)
      let theme = style == .dark ? "dark" : "light"
      Self.snapshot(fixture.controller, name: "etap2b-pole-pracuje-iphone-\(theme)")
      fixture.store.dispatch(.turnControl(.interruptStarted(sessionId: "s1", at: Date())))
      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
      U.layout(fixture)
      Self.snapshot(fixture.controller, name: "etap2b-decyzja-przerywa-iphone-\(theme)")
    }
  }

  // MARK: - Helpers

  /// Layer render of the session view on its `background`, written to `RAROG_CARD_SNAPSHOT_DIR` (when set) and attached. The
  /// shared `DecisionDockTests.snapshot` falls back to `drawHierarchy`, which gives a blank frame in this process
  /// when the window's corner pixel is transparent.
  static func snapshot(_ controller: SessionViewController, name: String) {
    controller.view.window?.layoutIfNeeded()
    D.spin(0.2)
    let view = controller.view!
    let format = UIGraphicsImageRendererFormat(for: view.traitCollection)
    format.opaque = true
    let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
      Palette.background.resolvedColor(with: view.traitCollection).setFill()
      context.fill(view.bounds)
      view.layer.render(in: context.cgContext)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    XCTContext.runActivity(named: name) { $0.add(attachment) }
    guard let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty,
      let data = image.pngData()
    else { return }
    try? data.write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }

  /// The field card: the text view's container.
  static func card(_ controller: SessionViewController) throws -> UIView {
    try XCTUnwrap(controller.composer.textView.superview, "field card")
  }

  static func frame(_ view: UIView, in controller: SessionViewController) -> CGRect {
    view.convert(view.bounds, to: controller.view)
  }

  /// In a window, no hidden ancestor, not transparent.
  static func isOnScreen(_ view: UIView) -> Bool {
    guard view.window != nil else { return false }
    var current: UIView? = view
    while let item = current {
      if item.isHidden || item.alpha < 0.01 { return false }
      current = item.superview
    }
    return true
  }
}
