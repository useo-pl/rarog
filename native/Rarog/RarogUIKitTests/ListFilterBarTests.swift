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
/// (`TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR` for `xcodebuild`) the tests also write `list-filter-needs-you.png`,
/// `list-filter-banner.png` and `voice-sessions-row-discussed.png`.
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

  /// The glass row floats over the list: rows scrolling beneath show through the filter capsule, so its pixels change
  /// when the list moves under it; an opaque row would cover them and stay the same.
  func testGlassRowShowsListBeneath() throws {
    let store = try ProjectTreeListTests.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 },
      "the list's collection")
    // A band across the capsule's middle, between its top and the inset's bottom.
    let top = list.adjustedContentInset.top
    let band = CGRect(
      x: 24, y: top - ListFilterBar.trackInset - ListFilterBar.plateHeight / 2 - 4, width: 300, height: 8)
    let still = try Self.pixels(window, band)
    list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y + 160), animated: false)
    ProjectTreeListTests.spin()
    XCTAssertNotEqual(try Self.pixels(window, band), still, "rows scrolling beneath show through the glass")
    try snapshot(window, "list-glass-scrolled")
    window.overrideUserInterfaceStyle = .light
    ProjectTreeListTests.spin()
    try snapshot(window, "list-glass-scrolled-light")
  }

  /// The window's pixels in `rect` (points, scale 1), drawn from its layer tree.
  private static func pixels(_ window: UIWindow, _ rect: CGRect) throws -> Data {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { window.layer.render(in: $0.cgContext) }
    let crop = try XCTUnwrap(image.cgImage?.cropping(to: rect.integral), "crop")
    return try XCTUnwrap(UIImage(cgImage: crop).pngData(), "PNG")
  }

  /// The active segment's zero reads in secondary text, not muted: muted ink on the glass plate over a busy list
  /// falls under 4.5:1. Inactive zeros and the disabled skeleton stay muted.
  func testActiveZeroCountIsSecondaryText() {
    XCTAssertEqual(ListFilterBar.countInk(.needsYou, count: 0, ready: true, active: true), Palette.text2)
    XCTAssertEqual(ListFilterBar.countInk(.needsYou, count: 0, ready: true, active: false), Palette.muted2)
    XCTAssertEqual(ListFilterBar.countInk(.all, count: 0, ready: false, active: true), Palette.muted2)
    XCTAssertEqual(ListFilterBar.countInk(.needsYou, count: 2, ready: true, active: true), Palette.wait)
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

  /// A banner over the segments stands whole: the top inset rises under the navigation bar as one strip, so the opaque
  /// segment row never covers the bottom of the card over it. Measured in the rendered window along a column where
  /// the card has its fill and the column only its background: the card's visible
  /// height equals the height the card takes on its own.
  func testBannerOverSegmentsStandsWhole() throws {
    let store = try ProjectTreeListTests.store()
    try Self.frame(store, #"{"type":"hello","protocolVersion":999,"serverStartId":"test"}"#)
    let banner = try XCTUnwrap(
      store.state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory()).first,
      "a list banner")
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let width: CGFloat = 402
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 874))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    try snapshot(window, "list-filter-banner")

    // The card on its own, at the strip's width (12 pt each side).
    let card = UIHostingController(rootView: BannerCard(banner: banner))
    card.overrideUserInterfaceStyle = .dark
    let full = card.sizeThatFits(in: CGSize(width: width - 24, height: 1000)).height

    let list = try XCTUnwrap(ProjectTreeListTests.views(UICollectionView.self, in: window).first)
    let insetBottom = Int(list.adjustedContentInset.top.rounded(.down))
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      return format
    }()).image { context in window.layer.render(in: context.cgContext) }
    // 26 pt from the right edge: past the card's round corner, right of the last segment's glyph.
    let pixels = try Self.column(image, x: Int(width) - 26)
    // The column's background from its left edge under the inset, away from the glass's shadow and the rows.
    let background = try Self.column(image, x: 3)[insetBottom + 60]
    // The longest run of rows that differ from the background above the glass row (its top gap, the glass and the
    // inset under it, at the inset's bottom): the card.
    let glassRow = ListFilterBar.glassEdge + ListFilterBar.plateHeight + 3 * ListFilterBar.trackInset
    var longest = 0, run = 0
    for y in 0..<(insetBottom - Int(glassRow.rounded(.up))) {
      run = pixels[y] == background ? 0 : run + 1
      longest = max(longest, run)
    }
    XCTAssertEqual(CGFloat(longest), full, accuracy: 1.5, "the card's visible height, its own height \(full)")
  }

  /// A received result the voice agent picked up stands in the real list between a fresh result and a result a person
  /// read: its own state word, the still dot and dimming of a received result. Light theme, for the snapshot
  /// `voice-sessions-row-discussed.png`.
  func testDiscussedByVoiceRowBesideFreshAndSeen() throws {
    let store = try ProjectTreeListTests.store()
    let base = ProjectTreeListTests.summary
    let rows = [
      base("voice-a", "voice", 0).replacingOccurrences(of: #""seen":true"#, with: #""seen":false"#),
      base("voice-b", "voice", 1)
        .replacingOccurrences(of: #""seen":true"#, with: #""seen":true,"seenBy":"voice-agent""#),
      base("voice-c", "voice", 2),
    ]
    try Self.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(rows.joined(separator: ","))]}"#)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    let sessions = navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil).compactMap { row -> SessionRowModel? in
      if case let .session(model) = row { return model }
      return nil
    }
    XCTAssertEqual(sessions.map(\.id), ["voice-a", "voice-b", "voice-c"])
    XCTAssertEqual(
      sessions.map(\.status.text), [UICopy.stateLabel(.waitingInput), UICopy.discussedByVoice, UICopy.idleSeen])
    XCTAssertEqual(sessions.map(\.freshResult), [true, false, false], "only the fresh result pulses")
    XCTAssertEqual(sessions.map(\.quiet), [false, true, true], "the voice row is dimmed like a read one")
    try snapshot(window, "voice-sessions-row-discussed")
  }

  /// One column of the image as RGBA words, top to bottom.
  private static func column(_ image: UIImage, x: Int) throws -> [UInt32] {
    let cg = try XCTUnwrap(image.cgImage)
    let width = cg.width, height = cg.height
    var data = [UInt32](repeating: 0, count: width * height)
    let context = try XCTUnwrap(CGContext(
      data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (0..<height).map { data[$0 * width + x] }
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
