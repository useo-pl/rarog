import CoreGraphics

// Placement of the buttons at the end of a project header's first line. Owner: list and projects.

/// Where the project header's buttons (pop-up terminal, Recent Sessions clock, note glyph; any of them may be absent)
/// stand: one gap between every two glyphs, the smallest from `minGap` up that still gives each button a target of
/// at least `minWidth` without overlapping its neighbour's. The targets touch, so the whole row reacts to a tap.
///
/// Measured from the last glyph's trailing edge (x = 0, the trailing edge of the header content). The last target
/// reaches `trailingReach` past it, into the cell's trailing inset; the first target reaches left into the space
/// before the name, which the header reserves (`width`). Pure numbers, tested on macOS; drawn by
/// `ProjectTreeHeaderRow`.
struct TreeHeaderButtonGeometry: Equatable {
  /// A horizontal span in the coordinates above.
  struct Span: Equatable {
    var minX: CGFloat
    var maxX: CGFloat
    var width: CGFloat { maxX - minX }
    var midX: CGFloat { (minX + maxX) / 2 }
  }

  /// Air between two neighbouring glyphs.
  let gap: CGFloat
  /// Trailing edge of each glyph, in the order of the input widths.
  let glyphTrailing: [CGFloat]
  /// Touch target of each button, in the order of the input widths.
  let targets: [Span]

  /// Room the buttons take in the first line: from the first target's leading edge to the last glyph's trailing
  /// edge. Reserving it keeps every target off the name and the count before it.
  var width: CGFloat { -(targets.first?.minX ?? 0) }

  init(
    glyphWidths widths: [CGFloat],
    minWidth: CGFloat = SessionListMetrics.treeButtonWidth,
    minGap: CGFloat = SessionListMetrics.treeButtonGap,
    trailingReach: CGFloat = SessionListMetrics.treeButtonReach
  ) {
    let count = widths.count
    // The targets right of glyph `i` need `minWidth` each; their glyphs, the gaps between them and the trailing
    // reach give that room, so glyph `i` ends where those targets begin.
    var gap = minGap
    for index in 0..<max(count - 1, 0) {
      let after = CGFloat(count - 1 - index)
      let room = trailingReach + widths[(index + 1)...].reduce(0, +)
      gap = max(gap, minWidth - room / after)
    }
    var trailing = [CGFloat](repeating: 0, count: count)
    for index in stride(from: count - 2, through: 0, by: -1) {
      trailing[index] = trailing[index + 1] - widths[index + 1] - gap
    }
    // From the trailing end: each target ends where the next one begins and takes at least `minWidth`, more when
    // the glyph is wider (the largest text sizes).
    var targets = [Span](repeating: Span(minX: 0, maxX: 0), count: count)
    var right = trailingReach
    for index in stride(from: count - 1, through: 0, by: -1) {
      let left = min(right - minWidth, trailing[index] - widths[index])
      targets[index] = Span(minX: left, maxX: right)
      right = left
    }
    self.gap = gap
    self.glyphTrailing = trailing
    self.targets = targets
  }
}
