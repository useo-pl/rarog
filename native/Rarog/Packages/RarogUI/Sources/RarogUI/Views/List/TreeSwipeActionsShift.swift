#if os(iOS)
import UIKit

// The leading swipe actions of a tree row next to the row's card. Owner: list.

/// Moves the list's swipe actions of one swiped row so the leading actions stand next to the row's card.
///
/// The list lays the actions out from the cell's edge (measured on iOS 27): the actions view is a reusable
/// view beside the cell, at the cell's resting frame, and the pill keeps 10 pt from both ends of the strip the cell
/// uncovers. An agent row's card starts `ProjectTreeRows.agentPlateInset` (33 pt) into its cell, behind the tree
/// guide, so unshifted the leading pill would stand at the column edge, over the guide, 43 pt from the card, while the
/// trailing pill stands 10 pt from the card. The actions view
/// moves by the card's inset toward the cell while the leading actions show, and goes back when the swipe is over.
///
/// It takes the actions view by its place, not by its class: a reusable view beside the cell with the cell's size,
/// centred where the cell rests. Without such a view nothing moves and the actions stay where the list puts them.
/// Taps follow the moved view (measured: the pill's end over the cell's empty leading strip fires the action).
@MainActor
struct TreeSwipeActionsShift {
  /// How far the row's card starts into the cell, from its leading edge.
  var inset: CGFloat = 0
  private weak var actions: UIView?

  /// Sets the shift for the side the cell moved to (`rest`: the cell's `position.x` at rest). At the resting place
  /// the shift stays as it was, so it does not jump while the cell settles.
  mutating func update(cell: UICollectionViewCell, rest: CGFloat) {
    guard let list = cell.superview else { return }
    let moved = cell.layer.position.x - rest
    guard abs(moved) >= 0.01 else { return }
    if actions?.superview !== list {
      actions = Self.actionsView(beside: cell, rest: rest, in: list)
    }
    guard let actions else { return }
    let rightToLeft = cell.effectiveUserInterfaceLayoutDirection == .rightToLeft
    let leading = rightToLeft ? moved < 0 : moved > 0
    let shift = CGAffineTransform(translationX: leading ? (rightToLeft ? -inset : inset) : 0, y: 0)
    if actions.transform != shift { actions.transform = shift }
  }

  /// Puts the actions view back where the list placed it; the list reuses it for the next swipe.
  mutating func reset() {
    actions?.transform = .identity
    actions = nil
  }

  /// The list's swipe actions view of `cell`: a reusable view (not a cell) beside it with the cell's size, centred
  /// where the cell rests. `center` and `bounds` ignore a shift left over from an earlier swipe.
  static func actionsView(beside cell: UICollectionViewCell, rest: CGFloat, in list: UIView) -> UIView? {
    list.subviews.first { view in
      view !== cell && view is UICollectionReusableView && !(view is UICollectionViewCell)
        && view.bounds.size == cell.bounds.size
        && abs(view.center.x - rest) < 0.5 && abs(view.center.y - cell.layer.position.y) < 0.5
    }
  }
}
#endif
