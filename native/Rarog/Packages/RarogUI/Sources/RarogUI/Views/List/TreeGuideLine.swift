#if os(iOS)
import SwiftUI
import UIKit

// The tree guide's line drawn by UIKit, so it can stay in place while the list swipes its row. Owner: list.

/// One row's guide segment (`ProjectTreeGuide` picks the span, `TreeGuideShape` gives the geometry) as a UIKit view
/// in the row content: it changes in the same transaction as the rows on collapse and expand, like the shape it
/// replaces.
struct TreeGuideLine: UIViewRepresentable {
  /// `nil` — no line (a row without a segment that still moves its swipe actions).
  let shape: TreeGuideShape?
  /// How far the row's card starts into the cell: the leading swipe actions stand next to it
  /// (`TreeSwipeActionsShift`).
  var actionsInset: CGFloat = 0
  /// The active project's guide: brighter (`PaletteTokens.treeGuideActive`).
  var active = false

  func makeUIView(context: Context) -> TreeGuideLineView {
    TreeGuideLineView()
  }

  func updateUIView(_ view: TreeGuideLineView, context: Context) {
    view.shape = shape
    view.actionsInset = actionsInset
    view.active = active
  }
}

/// The guide line, and its stand-in while the row is swiped.
///
/// A swipe moves the whole list cell (measured on iOS 27): the list sets the cell's `layer.position`
/// outside any UIView animation, once per touch move and once at release, and the cell's presentation follows the
/// model a few frames later (smoothing during the drag, a spring after release, ~0.6 s). The cell's
/// `configurationState.isSwiped` is already set at the first move, while the presentation is still at rest. The
/// layout attributes of the item follow the swipe, so they do not say where the cell rests. Anything in the cell
/// content travels with the row, the selection plate too, and countering the move frame by frame would trail the
/// presentation by a frame.
///
/// So the line does not move at all. At the first move of a swipe (key-value observation of the cell's `position`, in
/// the same transaction as the list's change) the line in the cell hides and a stand-in with the same frame and colour
/// shows in the collection view, above the cell, where the cell stood before that move. It stays there while the
/// actions are open. When the cell's model is back at that place, a display link watches the cell's presentation
/// until it gets there too, then the line comes back and the stand-in goes. Both swaps happen with the row at rest,
/// so nothing jumps. Without a swipe there is no per-frame work. The same swipe moves the leading actions next to the
/// row's card (`TreeSwipeActionsShift`), once per side and back when the stand-in goes.
final class TreeGuideLineView: UIView {
  /// Geometry of the segment in this view's bounds (the row's whole cell).
  var shape: TreeGuideShape? {
    didSet { if shape != oldValue { setNeedsLayout() } }
  }

  /// How far the row's card starts into the cell (`TreeSwipeActionsShift.inset`).
  var actionsInset: CGFloat {
    get { actionsShift.inset }
    set { actionsShift.inset = newValue }
  }

  /// The active project's guide is brighter; a stand-in already showing (the row swiped) changes with the line.
  var active = false {
    didSet {
      guard active != oldValue else { return }
      line.backgroundColor = Self.color(active: active)
      standIn?.backgroundColor = line.backgroundColor
    }
  }

  static func color(active: Bool) -> UIColor {
    Palette.dynamic(active ? PaletteTokens.treeGuideActive : PaletteTokens.treeGuide)
  }

  /// Whether the list has the cell swiped. Tests replace the read: they move the cell without a touch.
  var readSwiped: @MainActor (UICollectionViewCell) -> Bool = { $0.configurationState.isSwiped }

  /// The line in the row content; hidden while the stand-in shows.
  let line = UIView()
  /// The stand-in in the collection view while the row is swiped.
  private(set) var standIn: UIView?
  /// The cell's `position.x` before the swipe's first move (its place in the list); `nil` without a swipe.
  private var rest: CGFloat?
  /// The cell's width that `rest` belongs to. The list resizes a row from its leading edge (rotation, a resized
  /// window), so a new width moves the cell's place in the list by half the change, swiped or not.
  private var restWidth: CGFloat?
  private weak var followed: UICollectionViewCell?
  private var observation: NSKeyValueObservation?
  private var resizeObservation: NSKeyValueObservation?
  private var settle: CADisplayLink?
  private var actionsShift = TreeSwipeActionsShift()
  /// Whether a display link watches the cell's presentation settle (tests).
  var isWatchingSettle: Bool { settle != nil }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    backgroundColor = .clear
    line.isUserInteractionEnabled = false
    line.backgroundColor = Self.color(active: false)
    addSubview(line)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    line.frame = lineFrame
    follow()
    placeStandIn()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopFollowing()
    } else {
      follow()
    }
  }

  /// The line's frame in this view: the path of `TreeGuideShape` (one screen pixel wide, on the pixel grid).
  var lineFrame: CGRect {
    guard let shape else { return .zero }
    let path = shape.path(in: bounds)
    return path.isEmpty ? .zero : path.boundingRect
  }

  /// The list cell this row stands in (`nil` outside a list).
  private var cell: UICollectionViewCell? {
    var view = superview
    while let current = view {
      if let cell = current as? UICollectionViewCell { return cell }
      view = current.superview
    }
    return nil
  }

  /// Observes the cell's position; a reused cell or a row moved to another cell switches the observation.
  private func follow() {
    let cell = self.cell
    guard cell !== followed else { return }
    stopFollowing()
    guard let cell else { return }
    followed = cell
    observation = cell.layer.observe(\.position, options: [.old]) { [weak self] _, change in
      let old = change.oldValue
      MainActor.assumeIsolated { self?.cellMoved(from: old) }
    }
    resizeObservation = cell.layer.observe(\.bounds) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.cellResized() }
    }
  }

  private func stopFollowing() {
    observation?.invalidate()
    observation = nil
    resizeObservation?.invalidate()
    resizeObservation = nil
    followed = nil
    endSettle()
    dropStandIn()
  }

  private func cellMoved(from old: CGPoint?) {
    guard let cell = followed else { return }
    let x = cell.layer.position.x
    guard let rest else {
      // A move along the list (layout, collapse and expand) is not a swipe.
      if let old, old.x != x, readSwiped(cell) { showStandIn(over: cell, rest: old.x) }
      return
    }
    if abs(x - rest) < 0.01 {
      watchSettle()
    } else {
      endSettle()
      actionsShift.update(cell: cell, rest: rest)
    }
    placeStandIn()
  }

  private func showStandIn(over cell: UICollectionViewCell, rest: CGFloat) {
    guard let list = cell.superview else { return }
    let view = UIView()
    view.isUserInteractionEnabled = false
    view.isAccessibilityElement = false
    view.backgroundColor = line.backgroundColor
    list.addSubview(view)
    standIn = view
    self.rest = rest
    restWidth = cell.bounds.width
    line.isHidden = true
    actionsShift.update(cell: cell, rest: rest)
    placeStandIn()
  }

  /// The stand-in at the line's place with the cell at rest; above the cell, so the line lies over the selection
  /// plate as in the row.
  private func placeStandIn() {
    guard let standIn, let rest, let cell = followed else { return }
    let inCell = convert(line.frame, to: cell)
    UIView.performWithoutAnimation {
      standIn.frame = inCell.offsetBy(dx: cell.frame.minX + rest - cell.layer.position.x, dy: cell.frame.minY)
      standIn.layer.zPosition = cell.layer.zPosition + 1
    }
  }

  private func dropStandIn() {
    standIn?.removeFromSuperview()
    standIn = nil
    rest = nil
    restWidth = nil
    actionsShift.reset()
    line.isHidden = false
  }

  /// Moves the place the cell rests at with a new width, so the stand-in stays in the column and the swipe's end is
  /// still found where the list puts the cell back.
  private func cellResized() {
    guard let rest, let restWidth, let cell = followed else { return }
    let width = cell.bounds.width
    guard abs(width - restWidth) >= 0.01 else { return }
    self.rest = rest + (width - restWidth) / 2
    self.restWidth = width
    placeStandIn()
  }

  /// Watches the cell's presentation after the swipe is over, until it reaches the model.
  private func watchSettle() {
    guard settle == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(settleTick))
    link.add(to: .main, forMode: .common)
    settle = link
  }

  private func endSettle() {
    settle?.invalidate()
    settle = nil
  }

  @objc private func settleTick() {
    guard let cell = followed, let rest, abs(cell.layer.position.x - rest) < 0.01 else {
      endSettle()
      return
    }
    let shown = cell.layer.presentation()?.position.x ?? rest
    guard abs(shown - rest) < 0.01 else { return }
    endSettle()
    dropStandIn()
  }
}
#endif
