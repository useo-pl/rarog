#if os(iOS)
import RarogCore
import UIKit

// Coming back from a session to the stacked list: the scroll that brings the last opened row into view, on the live
// UIKit collection in which SwiftUI hosts the tree `List`. The rule: `Model/ListReturnScroll.swift`. Owner: list.

/// On the return from a session or terminal screen the stacked list centers the row of the last opened session when
/// no point of it is on screen (`ListReturnScroll.offset`), once per return.
///
/// When: the first layout of the collection back in the window after the route was cleared. In the stack the
/// navigation controller takes the list out of the window under a pushed screen; on a pop (back button, the route
/// cleared by code) it puts the list back and lays it out when the transition starts, before the first frame of the
/// pop is drawn, and the route is already `nil` by then. The offset set in that layout pass is where the list stands
/// as it slides in, so there is no jump after the pop. A helper view in the collection gets that pass: its
/// `layoutSubviews` runs after the collection's (parent before children).
///
/// The return is taken from the navigation at that first evaluation whatever the verdict (row visible, hidden in a
/// collapsed project, the collection not holding the tree rows yet), so no later layout (a list refresh, a rotation,
/// the human's own scroll) scrolls for it again. The body drops the return where no layout would take it: beside the
/// detail the list never leaves the window (a window narrowed to the stack later must not scroll for an old one), and
/// without tree rows (the skeleton, the empty list) no row reports the collection, so the helper only mounts with the
/// first rows, long after the pop; with no rows there is nothing to scroll to anyway. A return to a loaded list with
/// sessions keeps its tree rows, so the body leaves it for the layout.
///
/// `TreeListAnchor` stays idle on the stacked list after a return: it works only with a selected session, and the
/// cleared route selects none.
///
/// A class in the list's `@State`, without observation: layout and scrolling redraw nothing.
@MainActor
final class TreeReturnScroll {
  private weak var list: UICollectionView?
  private var helper: TreeReturnScrollView?
  private weak var navigation: RarogNavigation?
  /// Tree rows the collection gets with the latest list body (empty for the skeleton and the empty list).
  private var rows: [ProjectTreeID] = []
  private var besideDetail = true
  /// The last opened session, read live (`RarogNavigation.lastVisitedSession`): the row that carries the plate.
  private var target: @MainActor () -> String? = { nil }
  /// A scroll in progress: its own `layoutIfNeeded` does not enter the evaluation again.
  private var scrolling = false

  /// List body: the rows, the column kind and the target. The anchor's adoption of the tree collection brings the
  /// collection here too.
  func body(
    ids: [ProjectTreeID], besideDetail: Bool, navigation: RarogNavigation, anchor: TreeListAnchor,
    target: @escaping @MainActor () -> String?
  ) {
    rows = ids
    self.besideDetail = besideDetail
    self.navigation = navigation
    self.target = target
    if besideDetail || ids.isEmpty { _ = navigation.takeListReturn() }
    anchor.addRecipient(self) { [weak self] list in self?.adopt(list) }
  }

  /// The tree collection (reported through `TreeListAnchor.adopt`): the helper view moves into it.
  func adopt(_ list: UICollectionView) {
    if self.list === list, helper?.superview === list { return }
    helper?.removeFromSuperview()
    self.list = list
    let view = TreeReturnScrollView()
    view.owner = self
    list.insertSubview(view, at: 0)
    helper = view
  }

  /// After the collection's layout, in the window: takes the pending return and scrolls when the rule says so.
  fileprivate func afterLayout() {
    guard !scrolling, let list, list.window != nil, let navigation,
          let from = navigation.takeListReturn()
    else { return }
    guard list.numberOfSections > 0, list.numberOfItems(inSection: 0) == rows.count else { return }
    let frame: (Int) -> ListReturnScroll.Span? = { index in
      list.layoutAttributesForItem(at: IndexPath(item: index, section: 0)).map {
        ListReturnScroll.Span(minY: $0.frame.minY, maxY: $0.frame.maxY)
      }
    }
    let session = target()
    guard let wanted = ListReturnScroll.offset(
      returnedFrom: from, besideDetail: besideDetail, target: session, rows: rows, frame: frame,
      viewport: Self.viewport(list)),
      let index = session.flatMap({ rows.firstIndex(of: .session($0)) })
    else { return }
    scroll(list, to: wanted, item: index, frame: frame)
  }

  /// Rows far from the screen have estimated heights until they are laid out, so after the jump the collection
  /// measures the rows that came on screen and the target moves: the centering repeats with the fresh frame (at most
  /// `maxPasses` times), all in this layout pass. `setContentOffset(_:animated: false)` also stops a scroll animation
  /// the collection may have started itself.
  private func scroll(
    _ list: UICollectionView, to first: CGFloat, item: Int, frame: (Int) -> ListReturnScroll.Span?
  ) {
    scrolling = true
    defer { scrolling = false }
    var wanted = first
    for _ in 0..<Self.maxPasses {
      guard abs(list.contentOffset.y - wanted) > TreeListAnchor.precision || list.isScrollAnimating else { break }
      list.setContentOffset(CGPoint(x: list.contentOffset.x, y: wanted), animated: false)
      list.layoutIfNeeded()
      guard let span = frame(item) else { break }
      wanted = ListReturnScroll.centered(span, in: Self.viewport(list))
    }
  }

  private static func viewport(_ list: UICollectionView) -> ListReturnScroll.Viewport {
    let insets = list.adjustedContentInset
    return .init(
      offset: list.contentOffset.y, boundsHeight: list.bounds.height, contentHeight: list.contentSize.height,
      insetTop: insets.top, insetBottom: insets.bottom)
  }

  /// How many times the centering repeats in one layout pass (rows measured after the jump).
  static let maxPasses = 4
}

/// Helper view in the tree collection: invisible, without touches and accessibility. Entering the window asks for a
/// layout pass, and its `layoutSubviews` runs after the collection's.
final class TreeReturnScrollView: UIView {
  weak var owner: TreeReturnScroll?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isHidden = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { setNeedsLayout() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    owner?.afterLayout()
  }
}
#endif
