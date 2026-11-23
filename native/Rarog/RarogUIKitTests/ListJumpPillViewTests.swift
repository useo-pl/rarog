import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The jump pill over the real stacked list (`ListJumpPillView` and `ListJumpPillTracker` in `SessionListView`,
/// a phone-sized window): it counts at the triggers, stands at its edge and scrolls to its target. The rule itself:
/// `RarogUILogicTests/ListJumpPillTests`. This test host has no app, and an animated scroll does not advance in it
/// (`isScrollAnimating` stays set, the offset stands; measured on iOS 27), so an animated jump reaches its target here
/// through the jump's end check: the stalled animation counts as ended and the correction places the row. With `RAROG_LIST_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR` for
/// `xcodebuild`) the test also writes `list-jump-below.png`.
@MainActor
final class ListJumpPillViewTests: XCTestCase {
  @MainActor
  private struct Rig {
    let store: RarogStore
    let navigation: RarogNavigation
    let tracker: ListJumpPillTracker
    let window: UIWindow
    let list: UICollectionView

    var rows: [ProjectTreeRow] { navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil) }

    /// The agent rows in list order.
    var sessions: [SessionRowModel] {
      rows.compactMap { row in
        if case let .session(model) = row { return model }
        return nil
      }
    }

    /// The live visible part: under the bar and the filter segments, above the footer card.
    var visible: (top: CGFloat, bottom: CGFloat) {
      let insets = list.adjustedContentInset
      return (list.contentOffset.y + insets.top, list.contentOffset.y + list.bounds.height - insets.bottom)
    }

    /// The row is on screen by the rule's half test.
    func onScreen(_ id: String) throws -> Bool {
      let index = try XCTUnwrap(rows.firstIndex { $0.sessionId == id }, "row \(id)")
      let frame = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame)
      let edges = visible
      return ListJumpPill.onScreen(.init(minY: frame.minY, maxY: frame.maxY), top: edges.top, bottom: edges.bottom)
    }

    /// An edge of the visible part in window coordinates.
    func windowY(_ contentY: CGFloat) -> CGFloat {
      list.convert(CGPoint(x: 0, y: contentY), to: window).y
    }

    func close() { window.isHidden = true }
  }

  /// The fixture list (45 agents in 12 projects, all quiet), with states and labels changed before it shows.
  private func rig(_ setup: (RarogStore) throws -> Void = { _ in }) throws -> Rig {
    let store = try ProjectTreeListTests.store()
    try setup(store)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let tracker = ListJumpPillTracker()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(
        store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false, jumpPill: tracker)
    })
    window.makeKeyAndVisible()
    ProjectTreeListTests.spin()
    let rows = navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil)
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
      }, "the tree list")
    return Rig(store: store, navigation: navigation, tracker: tracker, window: window, list: list)
  }

  /// A row off screen turns from running to waiting while the list stands still: the "below" pill appears with the
  /// row's name, its touch target on the footer card. Without the list body asking for a count, nothing in the
  /// collection would change and the pill would not come. A tap brings the row on screen and the pill goes; a row
  /// at the top that then needs the human shows the "above" pill under the filter segments.
  func testRowTurningWaitingOffScreenShowsPillAndTapReachesIt() throws {
    let (last, project) = try Self.lastAgent()
    let s = try rig { store in try Self.change(store, last, project, minute: 3, state: "running") }
    defer { s.close() }
    XCTAssertEqual(s.sessions.last?.id, last, "precondition: the row is the list's last agent")
    XCTAssertFalse(try s.onScreen(last), "precondition: the row is below the visible part")
    XCTAssertEqual(s.tracker.result, .none, "work makes no pill")

    try Self.change(s.store, last, project, minute: 3, state: "waiting-permission")
    ProjectTreeListTests.spin()
    let name = try XCTUnwrap(s.sessions.last?.treeTitle)
    XCTAssertEqual(s.tracker.result.below, ListJumpPill.Side(waiting: 1, name: name, target: last))
    XCTAssertNil(s.tracker.result.above)
    let pill = try XCTUnwrap(s.tracker.belowPillFrame, "the pill is on screen")
    XCTAssertGreaterThanOrEqual(pill.height, ListJumpPillButton.minHeight - 0.5, "touch target")
    XCTAssertEqual(
      pill.maxY, s.windowY(s.visible.bottom), accuracy: 1, "touch target on the footer card, capsule inside it")
    XCTAssertEqual(pill.midX, s.window.bounds.midX, accuracy: 1, "centered in the column")
    let offset = s.list.contentOffset.y

    s.tracker.jump(.below, reduceMotion: false)
    ProjectTreeListTests.spin()
    XCTAssertGreaterThan(s.list.contentOffset.y, offset, "the list scrolled down")
    XCTAssertTrue(try s.onScreen(last), "the target is on screen after the jump")
    XCTAssertNil(s.tracker.result.below, "nothing left below: the pill goes")
    XCTAssertNil(s.navigation.listSelection(s.store.state), "the jump selects nothing")

    let first = try XCTUnwrap(s.sessions.first)
    XCTAssertFalse(try s.onScreen(first.id), "precondition: the first agent is above the visible part")
    try Self.change(s.store, first.id, first.project, minute: 0, state: "error")
    ProjectTreeListTests.spin()
    XCTAssertEqual(s.tracker.result.above?.failed, 1)
    XCTAssertEqual(s.tracker.result.above?.target, first.id)
    let above = try XCTUnwrap(s.tracker.abovePillFrame, "the above pill is on screen")
    XCTAssertEqual(above.minY, s.windowY(s.visible.top), accuracy: 1, "touch target at the top edge, capsule inside it")
  }

  /// A far target among rows of different heights (titles on two lines), far below the laid out part, so its frame
  /// is an estimate when the jump starts: after the scroll (and its one correction) the row is on screen.
  func testFarTargetAmongUnevenRowsIsOnScreenAfterJump() throws {
    let (target, project) = try Self.lastAgent()
    let s = try rig { store in
      for (index, project) in (ProjectTreeListTests.projects + ProjectTreeListTests.below).enumerated() {
        for (minute, suffix) in ["a", "b", "c", "d"].enumerated() where (index + minute).isMultiple(of: 2) {
          try Self.change(
            store, "\(project)-\(suffix)", project, minute: minute, state: "waiting-input",
            label: "a much longer session name for \(project)-\(suffix) that takes a second line in the row")
        }
      }
      try Self.change(store, target, project, minute: 3, state: "waiting-permission")
    }
    defer { s.close() }
    XCTAssertEqual(s.sessions.last?.id, target)
    XCTAssertFalse(try s.onScreen(target))
    XCTAssertEqual(s.tracker.result.below?.target, target)
    let heights = Set(s.rows.indices.prefix(12).compactMap { index -> CGFloat? in
      guard s.rows[index].sessionId != nil else { return nil }
      return s.list.layoutAttributesForItem(at: IndexPath(item: index, section: 0)).map { $0.frame.height.rounded() }
    })
    XCTAssertGreaterThan(heights.count, 1, "precondition: agent rows of different heights (\(heights))")

    s.tracker.jump(.below, reduceMotion: false)
    ProjectTreeListTests.spin()
    XCTAssertTrue(try s.onScreen(target), "the far target is on screen after the jump")
    XCTAssertNil(s.tracker.result.below)
  }

  /// Under Reduce Motion the jump does not animate: the target is on screen as soon as the tap returns, before the
  /// run loop turns once. An animated jump only gets there after its animation.
  func testReduceMotionJumpsWithoutAnimation() throws {
    let (target, project) = try Self.lastAgent()
    let s = try rig { store in try Self.change(store, target, project, minute: 3, state: "error") }
    defer { s.close() }
    XCTAssertEqual(s.tracker.result.below?.target, target)

    s.tracker.jump(.below, reduceMotion: true)
    XCTAssertTrue(try s.onScreen(target), "the target is on screen at once")
    ProjectTreeListTests.spin()
    XCTAssertNil(s.tracker.result.below)
  }

  /// The tree changes while a jump is in flight: the collection already holds the new rows, but the tracker still has
  /// the old ids (a layout before the rows' `onChange`). The correction must not take the target's old index, which now
  /// points at another row far below; it waits for the new ids and then finds the target where it stands now.
  func testCorrectionWaitsForAppliedRowsAfterTreeChange() throws {
    let (target, project) = try Self.lastAgent()
    let s = try rig { store in try Self.change(store, target, project, minute: 3, state: "waiting-permission") }
    defer { s.close() }
    let old = s.rows.map(\.id)
    XCTAssertEqual(s.tracker.result.below?.target, target)

    s.tracker.jump(.below, reduceMotion: false)
    // The target moves to the first project, near the top; its old index stays at the bottom of the list.
    try Self.change(s.store, target, "p1", minute: 3, state: "waiting-permission")
    let new = s.rows.map(\.id)
    XCTAssertNotEqual(new.firstIndex(of: .session(target)), old.firstIndex(of: .session(target)))
    let deadline = Date().addingTimeInterval(0.04)
    while s.tracker.applied != new, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
    XCTAssertEqual(s.tracker.applied, new, "precondition: the collection applied the new rows before the end check")
    s.tracker.didApply(old)
    // The jump's end checks run against the stale ids, then the rows' late report arrives.
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    s.tracker.didApply(new)
    ProjectTreeListTests.spin()
    XCTAssertTrue(try s.onScreen(target), "the target, not the row at its old index, is on screen")
  }

  /// Several states below: one pill counts them, each in its own part ("3 below ↓ · 1 waiting, 1 failed, 1 unread").
  func testSeveralStatesBelowShareOnePill() throws {
    let (_, project) = try Self.lastAgent()
    let s = try rig { store in
      try Self.change(store, "\(project)-b", project, minute: 1, state: "waiting-permission")
      try Self.change(store, "\(project)-c", project, minute: 2, state: "error")
      try Self.change(store, "\(project)-d", project, minute: 3, state: "waiting-input", seen: false)
    }
    defer { s.close() }
    XCTAssertEqual(
      s.tracker.result.below, ListJumpPill.Side(waiting: 1, failed: 1, unread: 1, target: "\(project)-b"))
    try snapshot(s.window, "list-jump-below")
  }

  /// The fixture's last agent row (the fourth agent, minute 3, of the last project) and its project.
  private static func lastAgent() throws -> (id: String, project: String) {
    let store = try ProjectTreeListTests.store()
    let rows = RarogNavigation(prefs: MemoryPreferences()).treeRows(store.state, openCwd: nil, jumpCwd: nil)
    let id = try XCTUnwrap(rows.last?.sessionId, "last agent row")
    XCTAssertTrue(id.hasSuffix("-d"), "the last project's fourth agent")
    return (id, String(id.dropLast(2)))
  }

  /// A session-changed frame for a fixture session in another state, optionally with another label.
  private static func change(
    _ store: RarogStore, _ id: String, _ project: String, minute: Int, state: String, seen: Bool = true,
    label: String? = nil
  ) throws {
    var summary = ProjectTreeListTests.summary(id, project, minute: minute)
      .replacingOccurrences(of: #""state":"waiting-input""#, with: #""state":"\#(state)""#)
    if !seen { summary = summary.replacingOccurrences(of: #""seen":true"#, with: #""seen":false"#) }
    if let label {
      summary = summary.replacingOccurrences(of: #""label":"sesja \#(id)""#, with: #""label":"\#(label)""#)
    }
    try ListFilterBarTests.frame(store, #"{"type":"session-changed","session":\#(summary)}"#)
  }

  private func snapshot(_ window: UIWindow, _ name: String) throws {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_LIST_SNAPSHOT_DIR"], !dir.isEmpty else { return }
    // The layer tree, not `drawHierarchy`: the test target has no app host and the screen capture comes out empty.
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
      window.layer.render(in: context.cgContext)
    }
    try XCTUnwrap(image.pngData(), "\(name): PNG").write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }
}
