import CoreGraphics
@testable import RarogUI
import Testing

// Chips flowing into lines in the rows of the "Model and Effort" sheet. Owner: header.

@Suite("chip rows: flow into lines")
struct ChipFlowTests {
  private let spacing: CGFloat = 8
  private let lineSpacing: CGFloat = 4

  /// The frames of a plain horizontal row (`HStack(spacing:)` with centred chips): the reference for a row that fits.
  private func plainRow(_ sizes: [CGSize]) -> [CGRect] {
    let height = sizes.map(\.height).max() ?? 0
    var x: CGFloat = 0
    return sizes.map { size in
      defer { x += size.width + spacing }
      return CGRect(x: x, y: (height - size.height) / 2, width: size.width, height: size.height)
    }
  }

  private func place(_ sizes: [CGSize], width: CGFloat?) -> ChipFlow.Placement {
    ChipFlow.place(sizes: sizes, width: width, spacing: spacing, lineSpacing: lineSpacing)
  }

  @Test("chips that fit stand in one line, where a plain row puts them")
  func fitsInOneLine() {
    let sizes = [CGSize(width: 40, height: 44), CGSize(width: 52.5, height: 40), CGSize(width: 30, height: 44)]
    let placement = place(sizes, width: 300)
    #expect(placement.frames == plainRow(sizes))
    #expect(placement.size == CGSize(width: 40 + 52.5 + 30 + 2 * spacing, height: 44), "the row's own width")
    #expect(place(sizes, width: nil).frames == plainRow(sizes), "no width proposed: one line")
    #expect(place(sizes, width: .infinity).frames == plainRow(sizes))
  }

  @Test("chips filling the width exactly stay in one line")
  func exactFitStaysInOneLine() {
    let sizes = [CGSize(width: 121.1, height: 44), CGSize(width: 120.9, height: 44)]
    #expect(place(sizes, width: 250).frames == plainRow(sizes))
  }

  @Test("chips wider than the width flow into further lines, in order, none past the edge")
  func wrapsIntoLines() {
    let sizes = Array(repeating: CGSize(width: 100, height: 44), count: 5)
    let placement = place(sizes, width: 250)
    let line = 44 + lineSpacing
    #expect(placement.frames == [
      CGRect(x: 0, y: 0, width: 100, height: 44), CGRect(x: 108, y: 0, width: 100, height: 44),
      CGRect(x: 0, y: line, width: 100, height: 44), CGRect(x: 108, y: line, width: 100, height: 44),
      CGRect(x: 0, y: 2 * line, width: 100, height: 44),
    ])
    #expect(placement.frames.allSatisfy { $0.maxX <= 250 }, "no chip cut by the row's edge")
    #expect(placement.frames.map(\.width) == sizes.map(\.width), "chips keep their widths")
    #expect(placement.size == CGSize(width: 208, height: 3 * 44 + 2 * lineSpacing))
  }

  @Test("a chip wider than the whole width takes its own line, narrowed to the width")
  func oversizedChipOwnLine() {
    let sizes = [CGSize(width: 60, height: 44), CGSize(width: 400, height: 44), CGSize(width: 60, height: 44)]
    let placement = place(sizes, width: 250)
    let line = 44 + lineSpacing
    #expect(placement.frames == [
      CGRect(x: 0, y: 0, width: 60, height: 44),
      CGRect(x: 0, y: line, width: 250, height: 44),
      CGRect(x: 0, y: 2 * line, width: 60, height: 44),
    ])
    #expect(placement.size == CGSize(width: 250, height: 3 * 44 + 2 * lineSpacing))
  }

  @Test("no chips: no size")
  func empty() {
    #expect(place([], width: 250) == ChipFlow.Placement(frames: [], size: .zero))
  }
}
