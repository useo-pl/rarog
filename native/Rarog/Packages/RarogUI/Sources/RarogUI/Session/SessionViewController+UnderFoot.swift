#if os(iOS)
import UIKit

// The transcript runs under the foot: the list reaches the bottom of the screen and the foot
// (the field card with the activity row as its first line; with the field hidden the activity row's narrow card, then
// the dock or the state card) floats over it as glass. Here: the one "top of the foot" anchor, the bottom inset of the
// list, the soft scroll edge under the foot and the part of the list the foot does not cover. Owner: transcript.
extension SessionViewController {
  /// The one "top of the foot" anchor for the Scroll to Bottom button and the toast above the prompt: the top of the
  /// foot stack, i.e. the top of the field card, whose activity band stands through a whole turn although the row goes
  /// out and comes back many times in it (`ActivityBand`); with the field hidden, the top of the activity
  /// row's own card.
  var footTopAnchor: NSLayoutYAxisAnchor { footStack.topAnchor }

  /// Top of the foot in the screen view (see `footTopAnchor`).
  var footTop: CGFloat { footStack.frame.minY }

  /// `viewDidLayoutSubviews`, before `holdPositionOnLayout`: `adjustedContentInset.bottom` = foot + 12 pt, the scroll
  /// indicator the same. The system part (safe area under `.automatic` adjustment) is subtracted, so it is not counted
  /// twice. An unpinned transcript keeps its offset while it stays in the legal range, otherwise the offset comes down
  /// to the bottom; a pinned one goes back to the bottom in `holdPositionOnLayout`.
  func placeTranscriptInset() {
    guard let list = collectionView, view.bounds.height > 0 else { return }
    let target = CGFloat(FootRest.transcriptInset(footTop: Double(footTop), viewBottom: Double(view.bounds.maxY)))
    let system = list.adjustedContentInset.bottom - list.contentInset.bottom
    let inset = target - system
    guard abs(list.contentInset.bottom - inset) > 0.25 || abs(list.verticalScrollIndicatorInsets.bottom - inset) > 0.25
    else { return }
    let offset = list.contentOffset.y
    list.contentInset.bottom = inset
    list.verticalScrollIndicatorInsets.bottom = inset
    guard !pinned, !list.isUserScrolling else { return }
    // UIKit may move the offset on an inset change; the content anchor stays unless the offset left the legal range.
    setClampedOffset(offset)
  }

  /// The system's soft scroll edge under the floating foot (Apple: controls over content): the transcript fades where
  /// the foot's cards overlay its bottom edge. The foot is the container of those elements.
  func installScrollEdge() {
    let edge = UIScrollEdgeElementContainerInteraction()
    edge.scrollView = collectionView
    edge.edge = .bottom
    footStack.addInteraction(edge)
  }

  // MARK: - Uncovered area

  /// The part of the list's bounds above the top of the foot (and so above the keyboard, which carries the foot).
  func uncoveredTranscriptRect() -> CGRect {
    let bounds = collectionView.bounds
    let top = collectionView.convert(CGPoint(x: 0, y: footTop), from: view).y
    return CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: max(0, min(bounds.maxY, top) - bounds.minY))
  }

  /// Laid-out cells with at least half a point above the foot: what the person can actually see.
  func uncoveredCells() -> [UICollectionViewCell] {
    let visible = uncoveredTranscriptRect()
    return collectionView.visibleCells.filter { cell in
      cell.frame.maxY > visible.minY + 0.5 && cell.frame.minY < visible.maxY - 0.5
    }
  }

  /// The cell lies wholly above the foot.
  func isUncovered(_ cell: UICollectionViewCell) -> Bool {
    let visible = uncoveredTranscriptRect()
    return cell.frame.minY >= visible.minY - 0.5 && cell.frame.maxY <= visible.maxY + 0.5
  }
}
#endif
