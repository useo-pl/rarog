import CoreGraphics
@testable import RarogUI
import Testing

// Widths of the list filter segments. Owner: list.

@Suite("list filter segments: widths")
struct ListFilterSegmentWidthsTests {
  @Test("segments that fit share the column equally")
  func equalShares() {
    #expect(ListFilterSegmentWidths.widths(ideal: [50, 60, 55, 52], available: 280) == [70, 70, 70, 70])
  }

  @Test("a segment wider than an equal share keeps its width, the others split the rest")
  func wideSegmentKeepsItsWidth() {
    #expect(ListFilterSegmentWidths.widths(ideal: [40, 130, 40, 40], available: 280) == [50, 130, 50, 50])
  }

  @Test("segments that do not fit keep their own widths, so the row scrolls instead of truncating")
  func overflowKeepsIdeal() {
    let ideal: [CGFloat] = [90, 100, 95, 92]
    #expect(ListFilterSegmentWidths.widths(ideal: ideal, available: 300) == ideal)
    #expect(ListFilterSegmentWidths.widths(ideal: ideal, available: 0) == ideal, "column not measured yet")
  }
}
