@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Coming back from a session to the stacked list (`TreeReturnScroll`): the real `SessionListView` in a
/// `NavigationSplitView` collapsed to a stack (compact width, the compact column bound to the route as in the app).
/// The rule itself: `RarogUILogicTests/ListReturnScrollTests`.
@MainActor
final class TreeListReturnScrollTests: XCTestCase {
  private struct Host: View {
    let store: RarogStore
    let navigation: RarogNavigation

    var body: some View {
      NavigationSplitView(preferredCompactColumn: Binding(
        get: { navigation.compactShowsDetail ? .detail : .sidebar },
        set: { column in
          guard column == .sidebar, navigation.compactShowsDetail else { return }
          navigation.compactReturnedToList()
        })
      ) {
        SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
      } detail: {
        Text("detail")
      }
    }
  }

  @MainActor
  private struct Stack {
    let store: RarogStore
    let navigation: RarogNavigation
    let window: UIWindow
    let list: UICollectionView
    let stack: UINavigationController
    let rows: [ProjectTreeRow]

    var insets: UIEdgeInsets { list.adjustedContentInset }

    /// The row's frame in content coordinates against the visible part (under the bar, above the footer card).
    func visibility(_ id: String) throws -> (whole: Bool, any: Bool) {
      let index = try XCTUnwrap(rows.firstIndex { $0.sessionId == id }, "row \(id)")
      let frame = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame)
      let top = list.contentOffset.y + insets.top
      let bottom = list.contentOffset.y + list.bounds.height - insets.bottom
      return (frame.minY >= top - 0.5 && frame.maxY <= bottom + 0.5, frame.maxY > top && frame.minY < bottom)
    }

    /// Opens the session the way the app does (route, then the visit in the history the root view notes).
    func open(_ id: String) {
      navigation.detail = .session(id)
      navigation.noteSessionVisit(store.state)
      ProjectTreeListTests.spin()
    }

    /// Back to the list: the system pop (back button) or the route cleared by code (Live Activity, a closed session).
    func goBack(system: Bool) {
      if system {
        stack.popViewController(animated: true)
      } else {
        navigation.detail = nil
      }
    }

    func close() { window.isHidden = true }
  }

  private func stacked() throws -> Stack {
    let store = try ProjectTreeListTests.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
    window.traitOverrides.horizontalSizeClass = .compact
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: Host(store: store, navigation: navigation))
    window.makeKeyAndVisible()
    ProjectTreeListTests.spin()
    let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
      }, "tree list in the window")
    var responder: UIResponder? = list
    var stack: UINavigationController?
    while let current = responder, stack == nil {
      stack = current as? UINavigationController
      responder = current.next
    }
    return Stack(
      store: store, navigation: navigation, window: window, list: list,
      stack: try XCTUnwrap(stack, "the stack of the collapsed split"), rows: rows)
  }

  /// The last opened session entered another way than its row (a notification, the switcher), its row far below the
  /// screen: on the way back the list already stands on that row while the pop slides in, and stays there after it.
  /// If the scroll came only after the pop (a SwiftUI `onChange`, a later layout), the row would be off screen during
  /// the transition; if the return were not taken once, the human's scroll away would be undone by the next layout.
  func testReturnBringsFarRowIntoViewBeforePopEnds() throws {
    for system in [true, false] {
      let s = try stacked()
      defer { s.close() }
      let target = try XCTUnwrap(s.rows.last?.sessionId, "last agent row")
      XCTAssertFalse(try s.visibility(target).any, "precondition: the row is entirely below the visible part")
      s.open(target)
      XCTAssertNil(s.list.window, "the pushed session takes the list out of the window")

      s.goBack(system: system)
      // A short run of the loop: the pop transition (~0.35 s) is still under way.
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
      XCTAssertNotNil(s.stack.transitionCoordinator, "still in the pop transition (system: \(system))")
      XCTAssertNotNil(s.list.window)
      XCTAssertTrue(try s.visibility(target).whole, "the row is on screen while the list slides in (system: \(system))")
      let during = s.list.contentOffset.y

      ProjectTreeListTests.spin()
      XCTAssertNil(s.stack.transitionCoordinator)
      XCTAssertTrue(try s.visibility(target).whole, "the row stays on screen after the pop (system: \(system))")
      XCTAssertEqual(s.list.contentOffset.y, during, accuracy: 0.5, "no jump after the pop (system: \(system))")

      // The human scrolls back to the top; a later layout does not scroll for the same return again.
      s.list.setContentOffset(CGPoint(x: 0, y: -s.insets.top), animated: false)
      let helper = try XCTUnwrap(
        ProjectTreeListTests.views(TreeReturnScrollView.self, in: s.list).first, "return helper in the collection")
      helper.setNeedsLayout()
      s.list.layoutIfNeeded()
      ProjectTreeListTests.spin()
      XCTAssertEqual(s.list.contentOffset.y, -s.insets.top, accuracy: 0.5, "one scroll per return (system: \(system))")
    }
  }

  /// The app launched straight into a session (a notification tap): the list has never been on screen, and the first
  /// return still finds it laid out with the tree rows and scrolls before the pop's first frame. If the collection
  /// only got its rows after the first layout back in the window, the return would be spent without a scroll.
  func testReturnAfterLaunchIntoSessionBringsRowIntoView() throws {
    let store = try ProjectTreeListTests.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
    let target = try XCTUnwrap(rows.last?.sessionId, "last agent row")
    navigation.detail = .session(target)
    navigation.noteSessionVisit(store.state)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
    window.traitOverrides.horizontalSizeClass = .compact
    window.rootViewController = UIHostingController(rootView: Host(store: store, navigation: navigation))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    XCTAssertNotNil(navigation.detail, "the session is on screen")

    navigation.detail = nil
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
      }, "tree list back in the window")
    let index = try XCTUnwrap(rows.firstIndex { $0.sessionId == target })
    let insets = list.adjustedContentInset
    func whole() throws -> Bool {
      let frame = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame)
      return frame.minY >= list.contentOffset.y + insets.top - 0.5
        && frame.maxY <= list.contentOffset.y + list.bounds.height - insets.bottom + 0.5
    }
    var responder: UIResponder? = list
    var stack: UINavigationController?
    while let current = responder, stack == nil {
      stack = current as? UINavigationController
      responder = current.next
    }
    XCTAssertNotNil(stack?.transitionCoordinator, "still in the pop transition")
    XCTAssertTrue(try whole(), "the row is on screen while the list slides in")
    ProjectTreeListTests.spin()
    XCTAssertTrue(try whole(), "the row stays on screen after the pop")
  }

  /// A return while the list has no tree rows yet (the skeleton before the first session list, e.g. after a new
  /// login with the session route kept): there is nothing to scroll, so the return is spent. The skeleton rows report
  /// no collection, so the helper view only mounts with the first tree rows; if the return were still pending then,
  /// the list would jump to the row long after the pop.
  func testReturnOverSkeletonIsNotReplayedWhenRowsArrive() throws {
    let loaded = try ProjectTreeListTests.store()
    let target = try XCTUnwrap(
      loaded.state.projectTreeRows(collapsed: RarogNavigation(prefs: MemoryPreferences()).collapsedProjects,
                                   openCwd: nil, jumpCwd: nil).last?.sessionId,
      "last agent row of the fixture")
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    try TreeAnchorFixture.connect(store)
    XCTAssertFalse(store.state.sessionsLoaded, "precondition: the skeleton")
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session(target)
    navigation.noteSessionVisit(store.state)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
    window.traitOverrides.horizontalSizeClass = .compact
    window.rootViewController = UIHostingController(rootView: Host(store: store, navigation: navigation))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()

    navigation.detail = nil
    ProjectTreeListTests.spin()
    let sessions = (ProjectTreeListTests.projects + ProjectTreeListTests.below).flatMap { project in
      ["a", "b", "c", "d"].enumerated().map { index, suffix in
        ProjectTreeListTests.summary("\(project)-\(suffix)", project, minute: index)
      }
    } + [ProjectTreeListTests.summary("p7-a", "p7", minute: 0)]
    try TreeAnchorFixture.frame(
      store, #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
    ProjectTreeListTests.spin()

    let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
    XCTAssertEqual(navigation.lastVisitedSession(store.state), target, "the plate row is the far one")
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
      }, "tree list with the rows")
    XCTAssertFalse(
      ProjectTreeListTests.views(TreeReturnScrollView.self, in: list).isEmpty, "the helper mounted with the rows")
    XCTAssertEqual(list.contentOffset.y, -list.adjustedContentInset.top, accuracy: 0.5, "the list stays at the top")
  }

  /// A last opened row already on screen keeps the list where it was: the return does not move the content offset.
  func testReturnLeavesVisibleRowInPlace() throws {
    for system in [true, false] {
      let s = try stacked()
      defer { s.close() }
      let target = try XCTUnwrap(s.rows.first { $0.sessionId != nil }?.sessionId, "first agent row")
      XCTAssertTrue(try s.visibility(target).whole, "precondition: the row is on screen")
      let before = s.list.contentOffset.y
      s.open(target)
      s.goBack(system: system)
      ProjectTreeListTests.spin()
      XCTAssertNotNil(s.list.window)
      XCTAssertEqual(s.list.contentOffset.y, before, accuracy: 0.5, "visible row: no scroll (system: \(system))")
    }
  }
}
