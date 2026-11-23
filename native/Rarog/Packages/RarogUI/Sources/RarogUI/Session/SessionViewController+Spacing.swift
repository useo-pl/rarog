#if os(iOS)
import UIKit

// The transcript's density on the session screen: the side margin of the content, of the quote bar above it and of
// the foot's cards below it. Every cell keeps `TranscriptSpacing.cellSide` on its own; a wider margin of the density
// is an inset of the list section around the cells, measured from the side safe areas and asked on every layout pass
// and safe-area change, so it follows the column width without reconfiguring cells. The foot's cards keep their own
// `ListFooterMetrics.cardSide`; where the density widens the margin, the rest is a margin of the foot stack.
// The vertical gaps reach the cells through their configuration and the hosted rows' environment (`+Cells`, `+Send`).
// Owner: transcript.
extension SessionViewController {
  /// The spacing tokens of the density chosen in Settings.
  var transcriptSpacing: TranscriptSpacing { transcriptDensity.spacing }

  /// The side margin of transcript content in the list's current width.
  func transcriptSide() -> CGFloat {
    let width = collectionView?.bounds.width ?? 0
    return transcriptSpacing.side(column: Self.column(width, safeArea: collectionView?.safeAreaInsets ?? .zero))
  }

  /// The list section of the session screen: the part of the side margin beyond the cells' own goes around them.
  func insetTranscriptSides(_ section: NSCollectionLayoutSection, environment: any NSCollectionLayoutEnvironment) {
    // The container's full width, like `transcriptSide()`: `effectiveContentSize` already lacks the safe areas, and
    // taking them off twice would pick a narrower margin than the quote bar's.
    let column = Self.column(
      environment.container.contentSize.width, safeArea: collectionView?.safeAreaInsets ?? .zero)
    let extra = transcriptSpacing.side(column: column) - TranscriptSpacing.cellSide
    guard extra > 0 else { return }
    // From the safe area's edge, like the quote bar: a list cell under a side safe area insets its content by the
    // overlap, which would swallow an inset narrower than the safe area. Standard keeps the list's own reference.
    section.contentInsetsReference = .safeArea
    section.contentInsets.leading += extra
    section.contentInsets.trailing += extra
  }

  /// `viewDidLayoutSubviews` and a density change: the quote bar stands in line with the transcript content and ends
  /// where the prompt bubble does.
  func placePromptBarSides() {
    turnChrome.promptBar?.spacing = transcriptSpacing
    let side = transcriptSide()
    if let leading = turnChrome.promptBarLeading, leading.constant != side { leading.constant = side }
    if let trailing = turnChrome.promptBarTrailing, trailing.constant != -side { trailing.constant = -side }
  }

  /// `viewDidLayoutSubviews` and a density change: where the density widens the transcript's margin, the foot's cards
  /// (field, activity card, dock, state card) stand at the same margin, so their edges line up with the content.
  /// Standard keeps the cards at their own side, narrower than the content's.
  func placeFootSides() {
    guard let foot = footStack else { return }
    let side = transcriptSide()
    let extra = side > TranscriptSpacing.cellSide ? side - ListFooterMetrics.cardSide : 0
    let margins = foot.directionalLayoutMargins
    guard margins.leading != extra || margins.trailing != extra else { return }
    foot.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: extra, bottom: 0, trailing: extra)
  }

  /// New safe areas: a section inset counts from them, but without a width change the list does not ask for its
  /// section again on its own. Standard has no inset, so its layout stays untouched.
  func followTranscriptSafeArea() {
    guard let list = collectionView, transcriptSide() > TranscriptSpacing.cellSide else { return }
    list.collectionViewLayout.invalidateLayout()
  }

  /// A density change: the list asks for its section again, and the quote bar and the foot follow the new margin.
  func applyTranscriptSides() {
    collectionView.collectionViewLayout.invalidateLayout()
    placePromptBarSides()
    placeFootSides()
  }

  /// The column a side margin is chosen for: the list's width without its side safe areas.
  private static func column(_ width: CGFloat, safeArea: UIEdgeInsets) -> Double {
    Double(max(0, width - safeArea.left - safeArea.right))
  }
}
#endif
