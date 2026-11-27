#if os(iOS)
import SwiftUI
import UIKit

// Układy nagłówka sesji. Właściciel: nagłówek.

/// Linia statusu: lewa część (kontekst i git) przy lewej krawędzi, prawa (pigułki) przy prawej;
/// gdy obie nie mieszczą się w jednym rzędzie, prawa schodzi pod lewą, wyrównana do lewej.
/// Żadna część nie jest ucinana — git i tryb panelu mają być widoczne zawsze.
struct StatusLineLayout: Layout {
  var spacing: CGFloat = 12
  var rowSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    let width = proposal.width ?? sizes.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, sizes.count - 1))
    if fitsInRow(sizes, width: width) {
      return CGSize(width: width, height: sizes.map(\.height).max() ?? 0)
    }
    let height = sizes.map(\.height).reduce(0, +) + rowSpacing * CGFloat(max(0, sizes.count - 1))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    if fitsInRow(sizes, width: bounds.width) {
      for (index, subview) in subviews.enumerated() {
        let last = index == subviews.count - 1 && index > 0
        let x = last ? bounds.maxX - sizes[index].width : bounds.minX
        subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(sizes[index]))
      }
      return
    }
    var y = bounds.minY
    for (index, subview) in subviews.enumerated() {
      let width = min(sizes[index].width, bounds.width)
      subview.place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading,
                    proposal: ProposedViewSize(width: width, height: sizes[index].height))
      y += sizes[index].height + rowSpacing
    }
  }

  private func fitsInRow(_ sizes: [CGSize], width: CGFloat) -> Bool {
    sizes.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, sizes.count - 1)) <= width
  }
}

/// Choice chips in a sheet (the model and effort rows of `ModelSheet`): left to right, and a chip that does not fit
/// the width starts the next line (`ChipFlow`), so the whole choice is in view without scrolling. A row that fits
/// stands like `HStack(spacing:)`. One view tree at every text size: a larger text only adds lines.
struct FlowLayout: Layout {
  var spacing: CGFloat = 8
  /// Space between lines. `RecentChip` draws 32 pt inside a 44 pt touch frame, so 0 still leaves a visible gap and
  /// the touch frames of two lines meet without overlapping.
  var lineSpacing: CGFloat = 0

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    placement(width: proposal.width, subviews: subviews).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let frames = placement(width: bounds.width, subviews: subviews).frames
    for (subview, frame) in zip(subviews, frames) {
      subview.place(
        at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
        proposal: ProposedViewSize(frame.size))
    }
  }

  private func placement(width: CGFloat?, subviews: Subviews) -> ChipFlow.Placement {
    ChipFlow.place(
      sizes: subviews.map { $0.sizeThatFits(.unspecified) }, width: width, spacing: spacing, lineSpacing: lineSpacing)
  }
}
#endif
