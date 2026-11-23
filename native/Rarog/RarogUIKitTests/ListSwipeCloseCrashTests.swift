import ObjectiveC
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

// Guard of the swipe close (fix: the close pill without `role: .destructive`, `RowActions.closeButton`). Before the
// fix `testSwipeCloseSelectedRowAnswerFirst` failed with the crash below in every run of the class.
// The app crashed after a session was closed by swiping its row in the session list
// (TestFlight build 4502, iPadOS 27.2.1: `NSInternalInconsistencyException` from
// `-[UICollectionView _Bug_Detected_In_Client_Of_UICollectionView_Invalid_Number_Of_Items_In_Section:]`, raised in
// `UpdateCoalescingCollectionView.performBatchUpdates` after `_updateAnimationDidStop:finished:`). These tests close a
// row of the real tree list (`SessionListView` in `TreeAnchorHarness`) with its trailing swipe action, as UIKit runs
// it after a tap on the red pill, while the close answer is held (`CloseHold`), then deliver the list snapshot
// without the row and the answer at chosen times after the tap. A variant that crashes fails with that exception.
// Run this class on its own: after a crash `ProjectTreeListTests` in the same process failed (alone it passes); the
// crashed harness window stays up, since Swift `defer` does not run when an Objective-C exception unwinds.
// Owner: list.

@MainActor
final class ListSwipeCloseCrashTests: XCTestCase {
  /// Runs of each variant (a variant stops at its first crash).
  static let runs = 5

  /// The server's order (`SessionManager.close`: `closeTab`, then the list snapshot, then the answer), both while the
  /// list still animates the row away (the row's cell settles ~430 ms after the tap, measured on iOS 27.0).
  static let snapshotFirst = Timing(snapshotAt: 0.15, answerAt: 0.17)
  /// The answer overtakes the snapshot (another connection than the event stream), both during the animation.
  static let answerFirst = Timing(snapshotAt: 0.17, answerAt: 0.15)
  /// Both after the animation, snapshot first.
  static let snapshotFirstLate = Timing(snapshotAt: 0.8, answerAt: 0.82)
  /// Both after the animation, the answer half a second before the snapshot.
  static let answerFirstLate = Timing(snapshotAt: 1.3, answerAt: 0.8)
  /// The answer and the snapshot in one update of the list, during the animation.
  static let together = Timing(snapshotAt: nil, answerAt: 0.15)
  /// The answer and the snapshot in one update of the list, after the animation.
  static let togetherLate = Timing(snapshotAt: nil, answerAt: 0.8)

  // The session on screen (selected, its transcript beside the list) closed by a swipe.

  func testSwipeCloseSelectedRow() throws {
    try check(Variant(name: "selected, snapshot first"), Self.snapshotFirst)
  }

  func testSwipeCloseSelectedRowAnswerFirst() throws {
    try check(Variant(name: "selected, answer first"), Self.answerFirst, runs: 20)
  }

  func testSwipeCloseSelectedRowAfterAnimation() throws {
    try check(Variant(name: "selected, snapshot first, after the animation"), Self.snapshotFirstLate)
  }

  func testSwipeCloseSelectedRowAnswerFirstAfterAnimation() throws {
    try check(Variant(name: "selected, answer first, after the animation"), Self.answerFirstLate)
  }

  func testSwipeCloseSelectedRowTogether() throws {
    try check(Variant(name: "selected, together"), Self.together)
  }

  func testSwipeCloseSelectedRowTogetherAfterAnimation() throws {
    try check(Variant(name: "selected, together, after the animation"), Self.togetherLate)
  }

  // (a) Another row is selected: the answer does not move the selection.

  func testSwipeCloseUnselectedRow() throws {
    try check(Variant(name: "unselected, snapshot first", selected: "p5-a"), Self.snapshotFirst)
  }

  func testSwipeCloseUnselectedRowAnswerFirst() throws {
    try check(Variant(name: "unselected, answer first", selected: "p5-a"), Self.answerFirst, runs: 20)
  }

  // (b) A sister session changes state while the row animates away (`session-changed` 50 ms after the tap).

  func testSwipeCloseSelectedRowWithSisterStateChange() throws {
    try check(Variant(name: "selected, sister state change, snapshot first", sisterChangeAt: 0.05), Self.snapshotFirst)
  }

  func testSwipeCloseSelectedRowWithSisterStateChangeTogether() throws {
    try check(Variant(name: "selected, sister state change, together", sisterChangeAt: 0.05), Self.together)
  }

  func testSwipeCloseUnselectedRowWithSisterStateChange() throws {
    try check(
      Variant(name: "unselected, sister state change, answer first", selected: "p5-c", sisterChangeAt: 0.05),
      Self.answerFirst, runs: 20)
  }

  // (c) The tree anchor off (`TreeListAnchor.enabled = false`): nothing of ours reads or moves the live collection.

  func testSwipeCloseSelectedRowWithoutAnchor() throws {
    try check(Variant(name: "selected, anchor off, snapshot first", anchorEnabled: false), Self.snapshotFirst)
  }

  func testSwipeCloseSelectedRowWithoutAnchorAnswerFirst() throws {
    try check(Variant(name: "selected, anchor off, answer first", anchorEnabled: false), Self.answerFirst, runs: 20)
  }

  func testSwipeCloseSelectedRowWithoutAnchorTogether() throws {
    try check(Variant(name: "selected, anchor off, together", anchorEnabled: false), Self.together)
  }

  // MARK: - Run

  struct Variant {
    var name: String
    var selected = "p5-b"
    var closed = "p5-b"
    var anchorEnabled = true
    /// A sister of the closed row (`p5-a`) goes to `running` this long after the tap.
    var sisterChangeAt: TimeInterval?
  }

  struct Timing {
    /// The list snapshot without the closed row, in seconds after the tap; `nil` — in the same main-thread turn as
    /// the answer, at the moment the answer moves the screen (`RarogNavigation.detail`), so SwiftUI takes both
    /// changes in one update of the list (selected row only: the answer moves no other screen).
    var snapshotAt: TimeInterval?
    /// The close answer (the held request released), in seconds after the tap.
    var answerAt: TimeInterval
  }

  private func check(_ variant: Variant, _ timing: Timing, runs: Int = ListSwipeCloseCrashTests.runs) throws {
    for run in 1...runs {
      try swipeClose(variant, timing, run: run)
    }
    print("SWIPECLOSE|\(variant.name): \(runs) runs, no crash")
  }

  private func swipeClose(_ variant: Variant, _ timing: Timing, run: Int) throws {
    let snapshotText = timing.snapshotAt.map { "\($0) s" } ?? "with the answer"
    print("SWIPECLOSE|\(variant.name) run \(run): snapshot \(snapshotText), answer \(timing.answerAt) s")
    let hold = CloseHold()
    let h = try TreeAnchorHarness(
      selected: variant.selected, enabled: variant.anchorEnabled, transport: UIKitTransport.holdingCloses(hold))
    defer { h.close() }
    // As in the app: nobody listens to the anchor's events (a listener makes it read the collection's item count).
    h.anchor.trace = nil
    let item = try XCTUnwrap(h.index(.session(variant.closed)))
    h.place(item: item, at: 0.5)
    let swipe = try SwipeDriver(list: h.list)
    swipe.revealTrailing(item)
    Self.spin(0.5)
    XCTAssertEqual(swipe.revealedItem, item, "trailing actions of the closed row revealed")

    let snapshot = { try h.snapshot(h.fixture.removing([variant.closed])) }
    var events: [(at: TimeInterval, run: () throws -> Void)] = []
    if let at = timing.snapshotAt {
      events.append((at, snapshot))
      events.append((timing.answerAt, { Self.answer(hold) }))
    } else {
      events.append((timing.answerAt, {
        // `onChange` runs synchronously in the setter, before SwiftUI's next update of the list.
        let action = MainActorAction(snapshot)
        withObservationTracking { _ = h.navigation.detail } onChange: {
          MainActor.assumeIsolated { action.run() }
        }
        Self.answer(hold)
      }))
    }
    if let at = variant.sisterChangeAt {
      events.append((at, {
        h.fixture = h.fixture.changing("p5-a", state: "running", since: "2026-10-06T10:05:00.000Z")
        try TreeAnchorFixture.frame(h.store, try XCTUnwrap(h.fixture.changedJSON("p5-a")))
      }))
    }
    events.sort { $0.at < $1.at }
    try swipe.tapPrimary()
    let tapped = CACurrentMediaTime()
    for event in events {
      Self.spin(until: tapped + event.at)
      try event.run()
    }
    Self.spin(until: tapped + (events.last?.at ?? 0) + 1.2)
    XCTAssertEqual(Self.await { await hold.requested }, [variant.closed], "one close request")
    XCTAssertNil(h.store.state.sessions[variant.closed], "the closed session left the list")
    XCTAssertEqual(h.list.numberOfItems(inSection: 0), h.ids().count, "the collection has the tree's rows")
  }

  /// The server's answer: the held close request released as soon as it has arrived.
  private static func answer(_ hold: CloseHold) {
    Task {
      while await hold.requested.isEmpty { try? await Task.sleep(for: .milliseconds(1)) }
      await hold.releaseAll()
    }
  }

  static func spin(_ seconds: TimeInterval) {
    spin(until: CACurrentMediaTime() + seconds)
  }

  /// The main run loop in steps of 4 ms until `deadline` (`CACurrentMediaTime`). A synchronous test keeps the main
  /// queue draining in it; an async test runs in a main-queue block, where a nested run loop would not run SwiftUI's
  /// and the store's main-queue work.
  static func spin(until deadline: CFTimeInterval) {
    repeat { RunLoop.main.run(until: Date().addingTimeInterval(0.004)) } while CACurrentMediaTime() < deadline
  }

  /// Runs `body` in a task and spins the main run loop until it ends.
  static func await<T>(_ body: @escaping @MainActor () async -> T) -> T {
    let box = ResultBox<T>()
    Task { @MainActor in box.value = await body() }
    let deadline = Date().addingTimeInterval(5)
    while box.value == nil, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
    return box.value!
  }
}

@MainActor
final class ResultBox<T> {
  var value: T?
}

/// A main-actor action handed to a `@Sendable` callback (`withObservationTracking`'s `onChange`).
@MainActor
final class MainActorAction {
  let body: () throws -> Void

  init(_ body: @escaping () throws -> Void) { self.body = body }

  func run() { XCTAssertNoThrow(try body()) }
}

/// UIKit's private swipe machinery of the list (iOS 27.0, read from the runtime): the layout's swipe actions module
/// (`UICollectionViewLayout._swipeActionsModule`) reveals the trailing actions of a row, and its current swipe
/// occurrence takes a tap on an action the way the pull view reports a tapped button. A test has no touch.
@MainActor
struct SwipeDriver {
  let module: NSObject

  init(list: UICollectionView) throws {
    module = try XCTUnwrap(
      list.collectionViewLayout.value(forKey: "swipeActionsModule") as? NSObject, "swipe actions module of the layout")
  }

  func revealTrailing(_ item: Int) {
    _ = module.perform(
      NSSelectorFromString("revealTrailingSwipeActionsForIndexPath:"), with: IndexPath(item: item, section: 0))
  }

  var occurrence: NSObject? {
    (module.value(forKey: "swipeActionController") as? NSObject)?.value(forKey: "currentSwipeOccurrence") as? NSObject
  }

  /// The row whose actions are revealed.
  var revealedItem: Int? { (occurrence?.value(forKey: "indexPath") as? IndexPath)?.item }

  /// The tap on the first (primary) action of the revealed side, as the pull view reports a tapped button.
  func tapPrimary() throws {
    let occurrence = try XCTUnwrap(occurrence, "a swipe occurrence")
    let pull = try XCTUnwrap(occurrence.value(forKey: "actionView") as? NSObject, "the pull view")
    let action = try XCTUnwrap(pull.value(forKey: "primarySwipeAction") as? NSObject, "the primary action")
    _ = occurrence.perform(NSSelectorFromString("swipeActionPullView:tappedAction:"), with: pull, with: action)
  }
}
