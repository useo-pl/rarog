import CoreGraphics

// Widths of the list filter segments in their row. Owner: list.

/// How wide each filter segment stands (`ListFilterBar`): when the segments fit the column, they share its width
/// equally, and a segment whose content is wider than an equal share keeps its own width while the others split the
/// rest; when they do not fit, each keeps its own width and the row scrolls sideways. Pure numbers, tested on macOS.
enum ListFilterSegmentWidths {
  /// - Parameters:
  ///   - ideal: each segment's own width (glyph, count and padding).
  ///   - available: the column's width; 0 or less before it is measured.
  static func widths(ideal: [CGFloat], available: CGFloat) -> [CGFloat] {
    guard ideal.reduce(0, +) < available else { return ideal }
    var widths = ideal
    var open = Set(ideal.indices)
    var room = available
    // Water-filling: a segment wider than the equal share of the room left keeps its width and leaves the share to
    // the others; the rest get that share.
    while !open.isEmpty {
      let share = room / CGFloat(open.count)
      let wide = open.filter { ideal[$0] > share }
      if wide.isEmpty {
        for index in open { widths[index] = share }
        break
      }
      for index in wide {
        open.remove(index)
        room -= ideal[index]
      }
    }
    return widths
  }
}
