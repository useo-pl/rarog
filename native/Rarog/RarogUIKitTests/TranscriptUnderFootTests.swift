import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// The transcript runs under the foot: the list reaches the bottom of the
/// session screen and the foot (activity row, field, dock or state card) stands over it. The contract is about
/// `adjustedContentInset.bottom` (what `+Pinning` reads): distance from the top of the foot to the bottom of the view
/// plus 12 pt; the field card's activity band counts while it stands (a turn, `ActivityBand`). The scroll indicator
/// has the same bottom inset. Card choice, focus rescue and revealing a focus target count only the part of the list
/// above the foot.
/// Real `SessionViewController` in a window; helpers from `DecisionDockTests`. Owner: transcript.
@MainActor
final class TranscriptUnderFootTests: XCTestCase {
  typealias D = DecisionDockTests
  static let sizes = [DecisionDockTests.phone, DecisionDockTests.pad]
  /// How far over the bottom of the view the simulated keyboard holds the foot.
  static let lift: CGFloat = 300

  /// Reading positions live in process memory: an unpinned test must not unpin the next one.
  override func setUp() {
    super.setUp()
    TranscriptMemory.positions.remember("s1", nil)
  }

  override func tearDown() {
    TranscriptMemory.positions.remember("s1", nil)
    super.tearDown()
  }

  // MARK: - Inset

  /// Pinned transcript without a keyboard: the list reaches the bottom of the view, the inset covers the foot plus
  /// 12 pt, and the last row ends exactly 12 pt above the top of the foot.
  func testPinnedInsetCoversFootWithoutKeyboard() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      Self.layout(fixture)
      Self.assertContract(fixture.controller, "\(size) no keyboard")
      try Self.assertLastRowOnFoot(fixture.controller, "\(size) no keyboard")
    }
  }

  /// The foot lifted the way a keyboard lifts it (a required constraint over the soft `footDown`): the inset follows
  /// the top of the foot, the pinned transcript stays at the bottom, and dropping the foot brings the old inset back.
  func testPinnedInsetFollowsLiftedFoot() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      Self.layout(fixture)
      let rest = fixture.controller.collectionView.adjustedContentInset.bottom
      let restTop = Self.footTop(fixture.controller)
      let lift = Self.liftFoot(fixture.controller)
      Self.layout(fixture)
      Self.assertContract(fixture.controller, "\(size) lifted")
      let rise = restTop - Self.footTop(fixture.controller)
      XCTAssertGreaterThan(rise, Self.lift - 20, "\(size): the foot went up")
      XCTAssertEqual(
        fixture.controller.collectionView.adjustedContentInset.bottom, rest + rise, accuracy: 0.5,
        "\(size): the inset grows with the foot")
      try Self.assertLastRowOnFoot(fixture.controller, "\(size) lifted")
      lift.isActive = false
      Self.layout(fixture)
      Self.assertContract(fixture.controller, "\(size) dropped")
      try Self.assertLastRowOnFoot(fixture.controller, "\(size) dropped")
    }
  }

  /// The on-screen keyboard from the message field and from the "Custom answer" field of a question card in the
  /// transcript: the same contract. A simulator with a hardware keyboard shows no on-screen keyboard — the test says so.
  func testInsetWithOnScreenKeyboard() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 40)
    defer {
      fixture.controller.view.endEditing(true)
      fixture.window.isHidden = true
    }
    fixture.window.makeKeyAndVisible()
    let controller = fixture.controller
    XCTAssertTrue(controller.composer.textView.becomeFirstResponder(), "focus in the message field")
    try Self.awaitKeyboard(fixture)
    Self.assertContract(controller, "message field keyboard")
    try Self.assertLastRowOnFoot(controller, "message field keyboard")
    controller.composer.textView.resignFirstResponder()

    try D.question(fixture, D.form)
    D.waitRender(fixture) { $0.rows["qdock-form"] != nil && $0.composer.isHidden }
    controller.ui.questions.drafts.update("dock-form", sections: 3) { $0.openCustom(in: 0) }
    controller.scheduleRender()
    var field: UITextView?
    for _ in 0..<100 where field == nil {
      D.spin(0.02)
      field = DecisionInTranscriptTests.cell(controller, "qdock-form").flatMap { D.views(of: UITextView.self, in: $0).first }
    }
    let text = try XCTUnwrap(field, "the \"Custom answer\" field in the card")
    XCTAssertTrue(text.becomeFirstResponder(), "focus in the card field")
    try Self.awaitKeyboard(fixture)
    Self.assertContract(controller, "custom answer keyboard")
  }

  /// Dock, state card and the empty foot of a decision in the transcript give the same contract.
  func testDockStateCardAndEmptyFootKeepContract() throws {
    for size in Self.sizes {
      let docked = D.host(try D.makeStore(messages: 40, state: "waiting-input"), size: size)
      defer { docked.window.isHidden = true }
      try D.permission(docked, "p1")
      D.waitRender(docked) { !$0.decisionSlot.isHidden }
      Self.layout(docked)
      Self.assertContract(docked.controller, "\(size) dock")
      XCTAssertLessThanOrEqual(abs(docked.controller.distanceFromBottom()), 0.5, "\(size): dock, pinned at the bottom")

      let card = try DecisionInTranscriptTests.make(size: size, messages: 40)
      defer { card.window.isHidden = true }
      // The app's host installs the state card (`SessionControllerHost`); without it the slot would stay empty.
      card.controller.installStateCard(navigation: RarogNavigation(prefs: MemoryPreferences()))
      try D.frame(card.store, #"""
        {"type":"session-changed","session":{"id":"s1","cwd":"/Users/demo/project","title":"project",
         "state":"waiting-input","engine":"codex","stateSince":"2026-10-06T12:00:00.000Z",
         "createdAt":"2026-10-06T10:00:00.000Z","lastActivityAt":"2026-10-06T10:00:00.000Z"}}
        """#, source: .global)
      D.waitRender(card) { !$0.stateCardSlot.isHidden }
      Self.layout(card)
      XCTAssertGreaterThan(card.controller.stateCardSlot.bounds.height, 20, "\(size): the state card stands in the foot")
      Self.assertContract(card.controller, "\(size) state card")
      try Self.assertLastRowOnFoot(card.controller, "\(size) state card")
    }
  }

  /// A decision hides the field: the foot is only the activity row's reserved band (its own narrow card; no
  /// strip where the field stood), and the last row ends 12 pt above it, near the bottom of the screen.
  func testHiddenComposerLeavesNoStrip() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
      Self.layout(fixture)
      let controller = fixture.controller
      let foot = try XCTUnwrap(controller.composer.superview, "foot stack")
      let footFrame = foot.convert(foot.bounds, to: controller.view)
      let card = try XCTUnwrap(D.find(controller.view, id: "foot.activity"), "\(size): the activity row's card")
      let band = card.convert(card.bounds, to: controller.view)
      XCTAssertEqual(footFrame.height, band.height, accuracy: 0.5, "\(size): only the activity band, no strip after the field")
      XCTAssertTrue(controller.activityRow.isDescendant(of: card), "\(size): the activity row stands in its own card")
      let activity = Self.footTop(controller)
      XCTAssertEqual(band.minY, activity, accuracy: 0.5, "\(size): the activity band is the top of the foot")
      Self.assertContract(controller, "\(size) hidden field")
      try Self.assertLastRowOnFoot(controller, "\(size) hidden field")
      XCTAssertGreaterThan(activity, controller.view.bounds.maxY - 80, "\(size): the foot top is near the bottom edge")
    }
  }

  // MARK: - Moving foot and activity row

  /// A turn opens and closes the field card's activity band: a pinned transcript stays at the bottom, an unpinned one
  /// keeps its rows and offset.
  func testActivityBandOpenAndCloseKeepsRows() throws {
    for pinned in [true, false] {
      let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      let list = controller.collectionView!
      if !pinned {
        list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 400), animated: false)
        controller.pinned = false
      }
      Self.layout(fixture)
      XCTAssertFalse(controller.activityRow.isAccessibilityElement, "pinned \(pinned): no activity yet")
      let row = try XCTUnwrap(Self.lastRowFrame(controller), "pinned \(pinned): last row")
      let offset = list.contentOffset.y

      try D.session(fixture, state: "running")
      D.waitRender(fixture) { $0.activityRow.isAccessibilityElement && $0.composer.activityBandOpen }
      Self.layout(fixture)
      if pinned {
        XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "pinned: at the bottom with the band")
        XCTAssertLessThanOrEqual(
          try XCTUnwrap(Self.lastRowFrame(controller)).maxY, Self.footTop(controller), "pinned: last row above the foot")
      } else {
        XCTAssertEqual(try XCTUnwrap(Self.lastRowFrame(controller)), row, "unpinned: row with activity")
        XCTAssertEqual(list.contentOffset.y, offset, accuracy: 0.5, "unpinned: offset with activity")
      }

      try D.session(fixture, state: "waiting-input")
      D.waitRender(fixture) { !$0.activityRow.isAccessibilityElement && !$0.composer.activityBandOpen }
      Self.layout(fixture)
      XCTAssertEqual(try XCTUnwrap(Self.lastRowFrame(controller)), row, "pinned \(pinned): row after activity")
      XCTAssertEqual(list.contentOffset.y, offset, accuracy: 0.5, "pinned \(pinned): offset after activity")
      if pinned {
        XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "pinned: at the bottom after the band")
      }
    }
  }

  /// Unpinned 50 pt from the bottom with the foot lifted (keyboard): the foot goes down, the inset shrinks below the
  /// offset, so the offset comes down to the legal bottom — no empty strip over the foot. Lifting keeps the top row.
  func testUnpinnedNearBottomStaysInRangeWhenFootDrops() throws {
    for size in Self.sizes {
      let fixture = try DecisionInTranscriptTests.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      let list = controller.collectionView!
      Self.layout(fixture)
      list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 50), animated: false)
      controller.pinned = false
      Self.layout(fixture)
      let (top, topY) = try XCTUnwrap(D.topRow(controller), "\(size): top row")
      let restTop = Self.footTop(controller)

      let lift = Self.liftFoot(controller)
      Self.layout(fixture)
      let rise = restTop - Self.footTop(controller)
      XCTAssertEqual(try XCTUnwrap(D.screenY(controller, top)), topY, accuracy: 0.5, "\(size): lift keeps the top row")
      XCTAssertEqual(controller.distanceFromBottom(), 50 + rise, accuracy: 0.5, "\(size): lifted, still unpinned")

      list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y + rise), animated: false)
      Self.layout(fixture)
      XCTAssertEqual(controller.distanceFromBottom(), 50, accuracy: 0.5, "\(size): 50 pt from the bottom over the keyboard")
      lift.isActive = false
      Self.layout(fixture)
      let inset = list.adjustedContentInset
      let maxY = max(-inset.top, list.contentSize.height + inset.bottom - list.bounds.height)
      XCTAssertLessThanOrEqual(list.contentOffset.y, maxY + 0.5, "\(size): offset in the legal range")
      XCTAssertGreaterThanOrEqual(controller.distanceFromBottom(), -0.5, "\(size): no empty strip over the foot")
      XCTAssertFalse(controller.pinned, "\(size): only a gesture pins")
      Self.assertContract(controller, "\(size) dropped")
    }
  }

  // MARK: - Uncovered area

  /// A card under the foot (unpinned transcript) is neither the "visible card" nor the focus rescue target; the
  /// VoiceOver move to a decision reveals it above the foot first.
  func testCardUnderFootIsNotVisibleCardNorRescueTarget() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 40)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    var posts: [(UIAccessibility.Notification, Any?)] = []
    controller.accessibilityPost = { posts.append(($0, $1)) }
    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    Self.layout(fixture)
    let list = controller.collectionView!
    let path = try XCTUnwrap(controller.dataSource.indexPath(for: "pp1"))
    let card = try XCTUnwrap(list.layoutAttributesForItem(at: path)?.frame, "card frame")
    // Card top 1 pt under the top of the foot.
    let top = Self.footTop(controller)
    list.setContentOffset(CGPoint(x: 0, y: card.minY - (top - list.frame.minY) - 1), animated: false)
    controller.pinned = false
    Self.layout(fixture)
    let cell = try XCTUnwrap(DecisionInTranscriptTests.cell(controller, "pp1"), "card cell laid out")
    XCTAssertTrue(list.visibleCells.contains(cell), "the card cell is on the list, under the foot")
    XCTAssertGreaterThan(cell.convert(cell.bounds, to: controller.view).minY, top, "card below the foot top")

    XCTAssertNil(controller.visibleCardCell(), "a card under the foot is not a visible card")
    let rescue = try XCTUnwrap(controller.focusRescueTarget(), "rescue target")
    XCTAssertFalse(rescue === cell, "the rescue target is not the covered card")
    XCTAssertLessThan(rescue.convert(rescue.bounds, to: controller.view).minY, top, "the rescue target is above the foot")

    controller.voiceOverAwaitsDockCard = true
    controller.moveVoiceOverToDecision(composerHadFocus: true)
    D.spin(0.1)
    let target = try XCTUnwrap(posts.last { $0.0 == .layoutChanged }?.1 as? UICollectionViewCell, "focus on a cell")
    XCTAssertTrue(target === DecisionInTranscriptTests.cell(controller, "pp1"), "focus goes to the card")
    let revealed = target.convert(target.bounds, to: controller.view)
    XCTAssertLessThanOrEqual(revealed.maxY, Self.footTop(controller) + 0.5, "the focus target is revealed above the foot")
  }

  // MARK: - Screenshot

  /// Screenshot for review: iPhone, agent at work, pinned transcript, keyboard down.
  func testScreenshotWorkingPinned() throws {
    let fixture = try DecisionInTranscriptTests.make(size: DecisionDockTests.phone, messages: 20)
    defer { fixture.window.isHidden = true }
    try D.session(fixture, state: "running")
    D.waitRender(fixture) { $0.activityRow.isAccessibilityElement }
    Self.layout(fixture)
    XCTAssertLessThanOrEqual(abs(fixture.controller.distanceFromBottom()), 0.5, "pinned at the bottom")
    D.snapshot(fixture.controller, name: "etap2a-agent-pracuje-iphone")
  }

  // MARK: - Helpers

  static func layout(_ fixture: D.Fixture) {
    for _ in 0..<3 {
      fixture.window.setNeedsLayout()
      fixture.window.layoutIfNeeded()
    }
    D.spin(0.05)
    fixture.window.layoutIfNeeded()
  }

  /// Top of the foot in the screen view: the top of its first shown element — the field card (with its activity band
  /// in a turn), or with the field hidden the activity row's own card.
  static func footTop(_ controller: SessionViewController) -> CGFloat {
    let foot = controller.composer.superview!
    let shown = (foot as? UIStackView)?.arrangedSubviews.filter { !$0.isHidden } ?? []
    let tops = shown.map { $0.convert($0.bounds, to: controller.view).minY }
    return tops.min() ?? foot.convert(foot.bounds, to: controller.view).maxY
  }

  /// Lifts the foot `lift` pt over the bottom of the view, like a keyboard; deactivate to drop it.
  static func liftFoot(_ controller: SessionViewController) -> NSLayoutConstraint {
    let foot = controller.composer.superview!
    let lift = foot.bottomAnchor.constraint(lessThanOrEqualTo: controller.view.bottomAnchor, constant: -Self.lift)
    lift.isActive = true
    return lift
  }

  static func awaitKeyboard(_ fixture: D.Fixture) throws {
    let view = fixture.controller.view!
    for _ in 0..<40 where view.keyboardLayoutGuide.layoutFrame.height < 100 { D.spin(0.05) }
    guard view.keyboardLayoutGuide.layoutFrame.height >= 100 else {
      throw XCTSkip("the simulator showed no on-screen keyboard (hardware keyboard) — case not checked")
    }
    D.spin(0.5)
    layout(fixture)
  }

  static func assertContract(
    _ controller: SessionViewController, _ label: String, file: StaticString = #filePath, line: UInt = #line
  ) {
    let view = controller.view!
    let list = controller.collectionView!
    XCTAssertEqual(list.frame.maxY, view.bounds.maxY, accuracy: 0.5, "\(label): list reaches the bottom", file: file, line: line)
    let expected = view.bounds.maxY - footTop(controller) + SessionViewController.transcriptBottomInset
    XCTAssertEqual(
      list.adjustedContentInset.bottom, expected, accuracy: 0.5, "\(label): inset = foot + 12", file: file, line: line)
    XCTAssertTrue(list.automaticallyAdjustsScrollIndicatorInsets, "\(label): indicator follows safe area", file: file, line: line)
    XCTAssertEqual(
      list.verticalScrollIndicatorInsets.bottom, list.contentInset.bottom, accuracy: 0.5,
      "\(label): the scroll indicator has the same bottom inset", file: file, line: line)
  }

  /// Pinned: the last row ends exactly 12 pt above the top of the foot.
  static func assertLastRowOnFoot(
    _ controller: SessionViewController, _ label: String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(label): pinned at the bottom", file: file, line: line)
    let row = try XCTUnwrap(lastRowFrame(controller), "\(label): last row", file: file, line: line)
    XCTAssertEqual(
      row.maxY, footTop(controller) - SessionViewController.transcriptBottomInset, accuracy: 0.5,
      "\(label): last row 12 pt above the foot", file: file, line: line)
  }

  /// Frame of the last transcript row in the screen view.
  static func lastRowFrame(_ controller: SessionViewController) -> CGRect? {
    guard let id = controller.dataSource.snapshot().itemIdentifiers.last,
      let path = controller.dataSource.indexPath(for: id),
      let frame = controller.collectionView.layoutAttributesForItem(at: path)?.frame
    else { return nil }
    return controller.collectionView.convert(frame, to: controller.view)
  }
}
