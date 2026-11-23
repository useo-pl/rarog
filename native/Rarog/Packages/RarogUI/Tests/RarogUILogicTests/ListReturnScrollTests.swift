import CoreGraphics
import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Coming back from a session to the stacked list: whether the last opened row is scrolled into view, and where to.
// On the real list: `RarogUIKitTests/TreeListReturnScrollTests`. Owner: list.

@Suite("list return scroll")
@MainActor
struct ListReturnScrollTests {
  private typealias Scroll = ListReturnScroll

  /// Rows "a", "b", "c" under one project; "b" spans `bMinY…bMinY + 50` in content coordinates.
  private static let rows: [ProjectTreeID] = [.project("/p"), .session("a"), .session("b"), .session("c")]

  /// A 700 pt collection with a 50 pt bar on top and an 80 pt footer card at the bottom, 3000 pt of content: at
  /// offset 0 the visible part runs from 50 to 620.
  private static let viewport = Scroll.Viewport(
    offset: 0, boundsHeight: 700, contentHeight: 3000, insetTop: 50, insetBottom: 80)

  private func offset(
    returnedFrom: RarogNavigation.Detail? = .session("b"), besideDetail: Bool = false, target: String? = "b",
    rows: [ProjectTreeID] = Self.rows, bMinY: CGFloat, viewport: Scroll.Viewport = Self.viewport
  ) -> CGFloat? {
    Scroll.offset(
      returnedFrom: returnedFrom, besideDetail: besideDetail, target: target, rows: rows,
      frame: { index in
        rows.indices.contains(index) && rows[index] == .session("b") ? Scroll.Span(minY: bMinY, maxY: bMinY + 50) : nil
      },
      viewport: viewport)
  }

  @Test("return from b, row b entirely below the visible part: b ends up centered")
  func belowScrolls() throws {
    let y = try #require(offset(bMinY: 2000))
    // Center of the visible part (570 pt high) at the row's center: 2025 − 50 − 285.
    #expect(y == 1690)
    let shown = Scroll.Viewport(offset: y, boundsHeight: 700, contentHeight: 3000, insetTop: 50, insetBottom: 80)
    #expect(!Scroll.entirelyOutside(Scroll.Span(minY: 2000, maxY: 2050), in: shown))
  }

  @Test("return from b, row b entirely above (scrolled away up): b ends up centered")
  func aboveScrolls() throws {
    let scrolled = Scroll.Viewport(offset: 1500, boundsHeight: 700, contentHeight: 3000, insetTop: 50, insetBottom: 80)
    #expect(offset(bMinY: 100, viewport: scrolled) == -50, "centering wants −210, clamped to the top of the content")
    #expect(offset(bMinY: 900, viewport: scrolled) == 590, "925 − 50 − 285")
  }

  @Test("the row under the bar or under the footer card counts as not visible")
  func underChromeScrolls() {
    // Under the footer card: starts at 620, the card's top edge.
    #expect(offset(bMinY: 620) != nil)
    // Under the bar: ends at 50, the bar's bottom edge.
    #expect(offset(bMinY: 0) != nil)
  }

  @Test("the target near the end of the content stops at the end, fully visible")
  func clampedAtEnd() throws {
    let y = try #require(offset(bMinY: 2940))
    #expect(y == 2380, "3000 + 80 − 700")
  }

  @Test("return from b, row b partly visible: no scroll")
  func partlyVisibleStays() {
    #expect(offset(bMinY: 600) == nil, "20 pt above the footer card")
    #expect(offset(bMinY: 10) == nil, "10 pt under the bar")
    #expect(offset(bMinY: 300) == nil, "whole")
  }

  @Test("row b hidden in a collapsed project or not in the rows: no scroll")
  func hiddenRowStays() {
    let collapsed: [ProjectTreeID] = [.project("/p"), .session("a")]
    #expect(offset(rows: collapsed, bMinY: 2000) == nil)
    #expect(offset(target: nil, bMinY: 2000) == nil, "no last opened session")
    #expect(offset(target: "gone", bMinY: 2000) == nil)
  }

  @Test("beside the detail: never")
  func besideDetailNever() {
    #expect(offset(besideDetail: true, bMinY: 2000) == nil)
  }

  @Test("not a return: no scroll")
  func notAReturn() {
    #expect(offset(returnedFrom: nil, bMinY: 2000) == nil, "cold start, or the list already on screen")
    #expect(offset(returnedFrom: .project("/p"), bMinY: 2000) == nil, "a project screen without a session")
  }

  @Test("a return is the route cleared from a session or terminal screen")
  func returnRoutes() {
    #expect(Scroll.isReturn(from: .session("b"), to: nil))
    #expect(Scroll.isReturn(from: .terminal("t1"), to: nil))
    #expect(!Scroll.isReturn(from: .project("/p"), to: nil))
    #expect(!Scroll.isReturn(from: .session("b"), to: .session("c")))
    #expect(!Scroll.isReturn(from: nil, to: nil))
  }

  @Test("navigation hands the return out once, and any new screen drops it")
  func navigationTakesReturnOnce() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.takeListReturn() == nil, "cold start")
    navigation.detail = .session("b")
    #expect(navigation.takeListReturn() == nil, "a screen is shown")
    navigation.detail = nil
    #expect(navigation.takeListReturn() == .session("b"))
    #expect(navigation.takeListReturn() == nil, "one scroll per return")
    navigation.detail = .terminal("t1")
    navigation.detail = nil
    navigation.detail = .session("c")
    #expect(navigation.takeListReturn() == nil, "the next screen drops an untaken return")
    navigation.detail = .project("/p")
    navigation.detail = nil
    #expect(navigation.takeListReturn() == nil)
  }
}
