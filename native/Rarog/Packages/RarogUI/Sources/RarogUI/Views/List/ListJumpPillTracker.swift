#if os(iOS)
import Observation
import RarogCore
import UIKit

// The jump pill's bridge to the live UIKit collection in which SwiftUI hosts the tree `List`: it counts the rule
// (`Model/ListJumpPill.swift`) at every trigger and scrolls to the pill's target. The pill itself:
// `ListJumpPillView`. Owner: list.

/// Counts both pills of the session list from the collection's live layout and scrolls to a pill's target.
///
/// Triggers: every layout pass of the collection (a scroll lays it out; a change of the content size, of the bounds
/// or of the safe area marks a helper view in the collection, whose `layoutSubviews` runs after the collection's),
/// a new list body (a row changing state or name with the same ids: running → waiting under a still list), the rows
/// the collection applied (`didApply`) and a new measured pill height. The rule gets the ids the collection really
/// holds; when the collection holds another tree the previous result stays until the next trigger.
///
/// Only `result` is observed, and it is written only when it changes, so scrolling redraws neither the list nor the
/// pill on every frame. The class lives in the list's `@State`.
@MainActor
@Observable
final class ListJumpPillTracker {
  /// Both pills; `none` on the skeleton, on an empty list and with the list column hidden.
  private(set) var result = ListJumpPill.Result.none

  /// The pills' last frames in window coordinates (tests read where the pill stands).
  @ObservationIgnored private(set) var abovePillFrame: CGRect?
  @ObservationIgnored private(set) var belowPillFrame: CGRect?
  @ObservationIgnored private(set) weak var list: UICollectionView?
  @ObservationIgnored private var helper: ListJumpPillHelperView?
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []
  /// The tree rows of the latest list body; empty for the skeleton and the empty list.
  @ObservationIgnored private var rows: [ListJumpPill.Row] = []
  /// The ids the collection holds (`onChange` of the rows, after the collection applied them); tests read it.
  @ObservationIgnored private(set) var applied: [ProjectTreeID] = []
  @ObservationIgnored private var hidden = false
  @ObservationIgnored private var filter = ListFilter.all
  @ObservationIgnored private var heights = ListJumpPill.PillHeights(above: estimatedHeight, below: estimatedHeight)
  /// A jump in flight: after the scroll ends, one correction when the target is not on screen.
  @ObservationIgnored private var pending: String?
  @ObservationIgnored private var pendingToken = 0
  /// The offset at the last check of a jump in flight (`poll`); `nil` until the first check after the tap.
  @ObservationIgnored private var polledOffset: CGFloat?
  /// A recount is already queued for this turn of the run loop.
  @ObservationIgnored private var queued = false
  /// Its own corrective scroll does not enter the count again.
  @ObservationIgnored private var scrolling = false

  /// List body: the tree rows the collection gets (`[]` for the skeleton and the empty list), the hidden column
  /// (Cmd+B) and the segment. A row's state or name can change without any change to the collection, so the body
  /// itself asks for a recount.
  func body(rows: [ListJumpPill.Row], hidden: Bool, filter: ListFilter, anchor: TreeListAnchor) {
    self.rows = rows
    self.hidden = hidden
    if filter != self.filter {
      self.filter = filter
      pending = nil
    }
    anchor.addRecipient(self) { [weak self] list in self?.adopt(list) }
    schedule()
  }

  /// `onChange` of the rows: the collection holds `ids`.
  func didApply(_ ids: [ProjectTreeID]) {
    applied = ids
    schedule()
  }

  /// A pill's measured frame (window coordinates); its height decides which rows on screen it covers.
  func measured(_ direction: ListJumpPill.Direction, frame: CGRect) {
    var next = heights
    switch direction {
    case .above:
      abovePillFrame = frame
      next.above = frame.height
    case .below:
      belowPillFrame = frame
      next.below = frame.height
    }
    guard next != heights, frame.height > 0 else { return }
    heights = next
    schedule()
  }

  /// The tree collection (reported through `TreeListAnchor.adopt`): the helper view and the observations move to it.
  func adopt(_ list: UICollectionView) {
    if self.list === list, helper?.superview === list { return }
    helper?.removeFromSuperview()
    observations = []
    self.list = list
    let view = ListJumpPillHelperView()
    view.owner = self
    list.insertSubview(view, at: 0)
    helper = view
    // A scroll, new content and a new size each lay the helper out after the collection.
    observations = [
      list.observe(\.contentOffset, options: [.new]) { [weak view] _, _ in
        MainActor.assumeIsolated { view?.setNeedsLayout() }
      },
      list.observe(\.contentSize, options: [.new]) { [weak view] _, _ in
        MainActor.assumeIsolated { view?.setNeedsLayout() }
      },
      list.observe(\.bounds, options: [.new]) { [weak view] _, _ in
        MainActor.assumeIsolated { view?.setNeedsLayout() }
      },
    ]
    schedule()
  }

  /// A tap on a pill: the collection centers the pill's target (`scrollToItem`, without animation under Reduce
  /// Motion). The target's height may be an estimate until it is laid out, so when the scroll ends and the target is
  /// not on screen, one correction follows without animation. A finger on the list, another segment or the target
  /// leaving the tree cancels the correction. The selection does not change.
  func jump(_ direction: ListJumpPill.Direction, reduceMotion: Bool) {
    let side = direction == .below ? result.below : result.above
    guard let side, let list, Self.holds(list, rows: rows, applied: applied),
          let index = applied.firstIndex(of: .session(side.target))
    else { return }
    pending = side.target
    pendingToken += 1
    polledOffset = nil
    list.scrollToItem(at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: !reduceMotion)
    if reduceMotion {
      // No animation was asked for: the correction follows at once, also over the collection's own animated
      // adjustment when the jump's layout measured new rows (`setContentOffset(_:animated: false)` stops it).
      list.layoutIfNeeded()
      settle(ended: true)
    } else {
      poll(token: pendingToken, left: Self.pollLimit)
    }
  }

  // MARK: - Count

  private func schedule() {
    helper?.setNeedsLayout()
    guard !queued else { return }
    queued = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.queued = false
      self.recount()
    }
  }

  /// After the collection's layout (helper view) and after a body: the rule on the live layout.
  fileprivate func recount() {
    guard !scrolling else { return }
    guard !rows.isEmpty, !hidden else { return publish(.none) }
    guard let list, list.window != nil, list.numberOfSections > 0 else { return }
    if pending != nil, list.isTracking || list.isDragging { pending = nil }
    let next = ListJumpPill.evaluate(
      rows: rows, applied: applied, items: list.numberOfItems(inSection: 0), frame: Self.span(list),
      viewport: Self.viewport(list), pillHeights: heights)
    if let next { publish(next) }
    if pending != nil { settle() }
  }

  private func publish(_ next: ListJumpPill.Result) {
    if next != result { result = next }
  }

  // MARK: - Jump

  /// While the animated scroll runs, the end is checked again shortly: the last frame of the animation may not move
  /// the offset, so no layout reports the end. The first check only notes the offset (a late first frame of the
  /// animation is not its end); an animation whose offset stood still between two checks has ended
  /// as far as the jump is concerned: a scroll animation moves the offset on every frame, and a stalled one
  /// (`isScrollAnimating` stays set without motion when nothing drives the animation, as in a test host without an
  /// app) would otherwise keep the correction from ever running.
  private func poll(token: Int, left: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.pollInterval) { [weak self] in
      guard let self, self.pendingToken == token, self.pending != nil, let list = self.list else { return }
      let offset = list.contentOffset.y
      let stalled = offset == self.polledOffset
      self.polledOffset = offset
      self.settle(ended: stalled)
      if self.pending != nil, left > 1 { self.poll(token: token, left: left - 1) } else { self.pending = nil }
    }
  }

  /// One correction when the scroll has ended and the target is not on screen. `ended` — the caller knows the motion
  /// is over (no animation asked for, or a stalled one); otherwise a running scroll animation or deceleration waits.
  /// Refinement passes in the same correction follow the rows the jump measured, like `TreeReturnScroll`.
  /// The target's index comes from `applied`, so the correction runs only while the collection holds the tree of the
  /// latest body: a layout between a tree change and the rows' `onChange` still has the old ids, and the target's old
  /// index would point at another row. Then the jump waits for `didApply`, which counts again; a target that left the
  /// tree ends it.
  private func settle(ended: Bool = false) {
    guard let target = pending, let list else { return }
    if list.isTracking || list.isDragging {
      pending = nil
      return
    }
    guard rows.contains(where: { $0.id == .session(target) }) else {
      pending = nil
      return
    }
    guard Self.holds(list, rows: rows, applied: applied) else { return }
    if list.isDecelerating || (!ended && list.isScrollAnimating) { return }
    pending = nil
    guard let index = applied.firstIndex(of: .session(target)) else { return }
    let frame = Self.span(list)
    guard let span = frame(index) else { return }
    let first = Self.viewport(list)
    guard !ListJumpPill.onScreen(span, top: first.visibleTop, bottom: first.visibleBottom) else { return }
    scrolling = true
    defer {
      scrolling = false
      schedule()
    }
    var wanted = ListReturnScroll.centered(span, in: first)
    for _ in 0..<TreeReturnScroll.maxPasses {
      guard abs(list.contentOffset.y - wanted) > TreeListAnchor.precision else { break }
      list.setContentOffset(CGPoint(x: list.contentOffset.x, y: wanted), animated: false)
      list.layoutIfNeeded()
      guard let moved = frame(index) else { break }
      wanted = ListReturnScroll.centered(moved, in: Self.viewport(list))
    }
  }

  // MARK: - Helpers

  /// The collection holds the tree of the latest body: the same ids as `rows`, as many items as `applied`.
  private static func holds(_ list: UICollectionView, rows: [ListJumpPill.Row], applied: [ProjectTreeID]) -> Bool {
    list.numberOfSections > 0 && list.numberOfItems(inSection: 0) == applied.count && rows.map(\.id) == applied
  }

  private static func span(_ list: UICollectionView) -> (Int) -> ListJumpPill.Span? {
    { index in
      list.layoutAttributesForItem(at: IndexPath(item: index, section: 0)).map {
        ListJumpPill.Span(minY: $0.frame.minY, maxY: $0.frame.maxY)
      }
    }
  }

  private static func viewport(_ list: UICollectionView) -> ListJumpPill.Viewport {
    let insets = list.adjustedContentInset
    return .init(
      offset: list.contentOffset.y, boundsHeight: list.bounds.height, contentHeight: list.contentSize.height,
      insetTop: insets.top, insetBottom: insets.bottom)
  }

  /// A pill's height before its first measurement: the minimum touch target, which the pill keeps.
  static let estimatedHeight: CGFloat = 44
  /// How often the end of an animated jump is checked, and for how long at most (2 s).
  static let pollInterval: TimeInterval = 0.05
  static let pollLimit = 40
}

/// Helper view in the tree collection: invisible, without touches and accessibility. Its `layoutSubviews` runs after
/// the collection's, in the same layout pass; entering the window and a new safe area ask for one.
final class ListJumpPillHelperView: UIView {
  weak var owner: ListJumpPillTracker?

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

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    owner?.recount()
  }
}
#endif
