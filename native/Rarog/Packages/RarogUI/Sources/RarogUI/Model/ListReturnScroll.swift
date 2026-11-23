import CoreGraphics
import RarogCore

// Coming back from a session or terminal screen to the stacked list: the rule that decides whether the row of the last
// opened session is scrolled into view, and to which offset. Pure numbers, tested on macOS (`ListReturnScrollTests`);
// the scroll on the live collection: `Views/List/TreeReturnScroll.swift`. Owner: list.

/// The stacked list marks the last opened session with the selection plate (`ListRowHighlight`). When that session was
/// entered another way than its row (a notification, the Live Activity, the session switcher, a tab in the header),
/// its row can stand far off screen, and the plate shows nothing. On the way back the list then centers that row,
/// once, before it appears. A row visible even partly stays where it is; a row hidden in a collapsed project (not in
/// the rows) is not scrolled to and no project expands; beside the detail (iPad) nothing scrolls.
public enum ListReturnScroll {
  /// Geometry of the list in the collection's points: `contentOffset.y`, the collection's height, the content height
  /// and `adjustedContentInset` (the bar on top, the floating footer card at the bottom).
  public struct Viewport: Sendable, Equatable {
    public var offset: CGFloat
    public var boundsHeight: CGFloat
    public var contentHeight: CGFloat
    public var insetTop: CGFloat
    public var insetBottom: CGFloat

    public init(offset: CGFloat, boundsHeight: CGFloat, contentHeight: CGFloat, insetTop: CGFloat, insetBottom: CGFloat) {
      self.offset = offset
      self.boundsHeight = boundsHeight
      self.contentHeight = contentHeight
      self.insetTop = insetTop
      self.insetBottom = insetBottom
    }

    /// Top and bottom edge of the visible part in content coordinates: under the bar, above the footer card.
    var visibleTop: CGFloat { offset + insetTop }
    var visibleBottom: CGFloat { offset + boundsHeight - insetBottom }
  }

  /// A row's vertical extent in content coordinates.
  public struct Span: Sendable, Equatable {
    public var minY: CGFloat
    public var maxY: CGFloat

    public init(minY: CGFloat, maxY: CGFloat) {
      self.minY = minY
      self.maxY = maxY
    }
  }

  /// Clearing the route from `old` to `new` brings the human back to the list from a session or terminal screen. A
  /// project screen without a session is not a return: no row of it carries the plate.
  public static func isReturn(from old: RarogNavigation.Detail?, to new: RarogNavigation.Detail?) -> Bool {
    guard new == nil, let old else { return false }
    switch old {
    case .session, .terminal, .openingTerminal: return true
    case .project: return false
    }
  }

  /// The offset that brings the last opened row into view on a return, or `nil` for no scroll.
  /// - Parameters:
  ///   - returnedFrom: the screen the human came back from (`RarogNavigation.takeListReturn()`); `nil` — no return.
  ///   - target: the last opened session (`RarogNavigation.lastVisitedSession`), the row with the plate.
  ///   - rows: the tree rows the collection holds, in order (an index here is the item index).
  ///   - frame: the row's extent from the collection's layout by item index.
  public static func offset(
    returnedFrom: RarogNavigation.Detail?, besideDetail: Bool, target: String?, rows: [ProjectTreeID],
    frame: (Int) -> Span?, viewport: Viewport
  ) -> CGFloat? {
    guard !besideDetail, isReturn(from: returnedFrom, to: nil), let target,
          let index = rows.firstIndex(of: .session(target)), let span = frame(index),
          entirelyOutside(span, in: viewport)
    else { return nil }
    return centered(span, in: viewport)
  }

  /// No point of the row stands in the visible part (within the layout's half-point rounding).
  public static func entirelyOutside(_ span: Span, in viewport: Viewport) -> Bool {
    span.maxY <= viewport.visibleTop + TreeListAnchorMath.edgeTolerance
      || span.minY >= viewport.visibleBottom - TreeListAnchorMath.edgeTolerance
  }

  /// The offset that puts the row's center at the center of the visible part, within the content.
  public static func centered(_ span: Span, in viewport: Viewport) -> CGFloat {
    let visible = viewport.boundsHeight - viewport.insetTop - viewport.insetBottom
    let wanted = (span.minY + span.maxY) / 2 - viewport.insetTop - visible / 2
    return TreeListAnchorMath.clamp(
      wanted, contentHeight: viewport.contentHeight, boundsHeight: viewport.boundsHeight,
      insetTop: viewport.insetTop, insetBottom: viewport.insetBottom)
  }
}

public extension RarogNavigation {
  /// The screen the human came back from to the list (a session or a terminal), handed out once: the list scrolls at
  /// most once per return, never again on a later layout. `nil` while a screen is shown and after a cold start.
  func takeListReturn() -> Detail? {
    guard detail == nil, let from = listReturn else { return nil }
    listReturn = nil
    return from
  }
}
