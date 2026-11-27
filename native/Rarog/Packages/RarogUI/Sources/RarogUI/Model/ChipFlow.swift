import CoreGraphics

// Chips flowing into lines in the rows of the "Model and Effort" sheet. Owner: header.

/// Where each chip of a row stands (`FlowLayout` in `Views/Header/HeaderLayouts`): left to right with `spacing`
/// between chips; a chip that would cross the row's width starts the next line, `lineSpacing` lower. Chips in a line
/// are centred on its height, like in a plain `HStack`, so a row that fits stands exactly as one. A chip wider than
/// the whole width takes its own line and is narrowed to the width (its text truncates instead of being cut by the
/// edge). Pure numbers, tested on macOS.
enum ChipFlow {
  struct Placement: Equatable {
    /// One frame per chip, in the order of the sizes, relative to the row's top leading corner.
    var frames: [CGRect]
    /// The widest line and the height of all lines.
    var size: CGSize
  }

  /// Float noise of measured text widths: a row that fits exactly does not drop its last chip to a new line.
  private static let tolerance: CGFloat = 0.01

  /// - Parameters:
  ///   - sizes: each chip's own size.
  ///   - width: the row's width; `nil`, infinite or 0 and less (not measured) put every chip in one line.
  static func place(sizes: [CGSize], width: CGFloat?, spacing: CGFloat, lineSpacing: CGFloat) -> Placement {
    let limit = width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? .infinity
    // Lines of (index, width) before the vertical placement: a line's height is its tallest chip.
    var lines: [[(index: Int, width: CGFloat)]] = []
    var x: CGFloat = 0
    for (index, size) in sizes.enumerated() {
      let chip = min(size.width, limit)
      // Every line holds at least one chip, so the first chip of a line never moves on, however wide it is.
      if lines.isEmpty || x + spacing + chip > limit + tolerance {
        lines.append([(index, chip)])
        x = chip
      } else {
        lines[lines.count - 1].append((index, chip))
        x += spacing + chip
      }
    }

    var frames = Array(repeating: CGRect.zero, count: sizes.count)
    var top: CGFloat = 0
    var widest: CGFloat = 0
    for (number, line) in lines.enumerated() {
      let height = line.map { sizes[$0.index].height }.max() ?? 0
      if number > 0 { top += lineSpacing }
      var left: CGFloat = 0
      for (position, chip) in line.enumerated() {
        if position > 0 { left += spacing }
        let chipHeight = sizes[chip.index].height
        frames[chip.index] = CGRect(x: left, y: top + (height - chipHeight) / 2, width: chip.width, height: chipHeight)
        left += chip.width
      }
      widest = max(widest, left)
      top += height
    }
    return Placement(frames: frames, size: CGSize(width: widest, height: top))
  }
}
