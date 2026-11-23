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

/// Pigułki wyboru w arkuszu zawijane w rzędach — cały wybór widać naraz, bez przewijania.
struct FlowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(subviews, width: proposal.width ?? .infinity)
    let width = rows.map(\.width).max() ?? 0
    let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
    return CGSize(width: proposal.width ?? width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in arrange(subviews, width: bounds.width) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + spacing
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
    var rows: [Row] = []
    var row = Row()
    for (index, subview) in subviews.enumerated() {
      let size = subview.sizeThatFits(.unspecified)
      if !row.indices.isEmpty, row.width + spacing + size.width > width {
        rows.append(row)
        row = Row()
      }
      row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.indices.append(index)
    }
    if !row.indices.isEmpty { rows.append(row) }
    return rows
  }
}
#endif
