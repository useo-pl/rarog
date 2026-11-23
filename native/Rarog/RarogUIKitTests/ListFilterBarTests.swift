import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The filter segments over the real stacked list (`ListFilterBar` in `SessionListView`, a phone-sized window): the
/// collection gets exactly the tree rows of the chosen segment, and the bar stands from the skeleton on, so the
/// list's top inset does not change when the sessions arrive. With `RAROG_LIST_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR` for `xcodebuild`) the test also writes `list-filter-needs-you.png`.
@MainActor
final class ListFilterBarTests: XCTestCase {
  func testSegmentFiltersCollectionRows() throws {
    let store = try ProjectTreeListTests.store()
    try Self.change(store, "p1-a", "p1", state: "waiting-permission")
    try Self.change(store, "p2-a", "p2", state: "running")
    try Self.change(store, "p2-b", "p2", minute: 1, state: "running")
    try Self.change(store, "p3-a", "p3", state: "error")
    try Self.change(store, "p4-b", "p4", minute: 1, state: "waiting-input", seen: false)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    let rows = { navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil) }
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 },
      "the list's collection")
    XCTAssertEqual(list.numberOfItems(inSection: 0), rows().count, "All: every tree row")
    let topInset = list.adjustedContentInset.top

    navigation.selectListFilter(.needsYou, state: store.state)
    ProjectTreeListTests.spin()
    XCTAssertEqual(rows().map(\.id), [
      .project("/Users/demo/p1"), .session("p1-a"), .project("/Users/demo/p3"), .session("p3-a"),
    ], "an unread result belongs to Unread only")
    XCTAssertEqual(list.numberOfItems(inSection: 0), rows().count, "Needs You: the collection has the filtered rows")
    XCTAssertEqual(list.adjustedContentInset.top, topInset, accuracy: 0.5, "the segment change keeps the top inset")
    try snapshot(window, "list-filter-needs-you")
    // The segments fit a phone column without a sideways scroll: the bar has no scroll view of its own.
    let sideways = ProjectTreeListTests.views(UIScrollView.self, in: window).filter {
      !($0 is UICollectionView) && $0.contentSize.width > $0.bounds.width + 0.5
    }
    XCTAssertTrue(sideways.isEmpty, "the filter row scrolls sideways: \(sideways.map(\.frame))")

    navigation.selectListFilter(.unread, state: store.state)
    ProjectTreeListTests.spin()
    XCTAssertEqual(rows().map(\.id), [.project("/Users/demo/p4"), .session("p4-b")])
    XCTAssertEqual(list.numberOfItems(inSection: 0), rows().count)
  }

  /// The bar stands while the list is still the skeleton: the sessions arriving do not move the top inset.
  func testBarStandsFromTheSkeleton() throws {
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    // Connected before the list shows, so only the sessions arriving changes the list (no connecting card).
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try Self.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    XCTAssertFalse(store.state.sessionsLoaded, "the skeleton is on screen")
    let skeleton = try XCTUnwrap(ProjectTreeListTests.views(UICollectionView.self, in: window).first)
    let before = skeleton.adjustedContentInset.top
    try Self.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(ProjectTreeListTests.summary("p1-a", "p1", minute: 0))]}"#)
    ProjectTreeListTests.spin()
    XCTAssertTrue(store.state.sessionsLoaded)
    let list = try XCTUnwrap(ProjectTreeListTests.views(UICollectionView.self, in: window).first)
    XCTAssertEqual(list.adjustedContentInset.top, before, accuracy: 0.5, "the list appearing keeps the top inset")
  }

  /// A session-changed frame for a fixture session in another state.
  static func change(
    _ store: RarogStore, _ id: String, _ project: String, minute: Int = 0, state: String, seen: Bool = true
  ) throws {
    var summary = ProjectTreeListTests.summary(id, project, minute: minute)
      .replacingOccurrences(of: #""state":"waiting-input""#, with: #""state":"\#(state)""#)
    if !seen { summary = summary.replacingOccurrences(of: #""seen":true"#, with: #""seen":false"#) }
    try frame(store, #"{"type":"session-changed","session":\#(summary)}"#)
  }

  static func frame(_ store: RarogStore, _ json: String) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: .global, cursor: nil))
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
