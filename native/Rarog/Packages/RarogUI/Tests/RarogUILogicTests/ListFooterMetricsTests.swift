import Foundation
@testable import RarogUI
import Testing

// Geometry of the list footer card. Owner: list.

@Suite("list footer card: geometry")
struct ListFooterMetricsTests {
  @Test("card bottom: 14 pt on iPad (20 pt home indicator) and without an indicator, 18 pt on a 34 pt iPhone")
  func bottomGap() {
    #expect(ListFooterMetrics.bottomGap(safeBottom: 20) == 14)
    #expect(ListFooterMetrics.bottomGap(safeBottom: 0) == 14)
    #expect(ListFooterMetrics.bottomGap(safeBottom: 34) == 18, "clear of a tall home indicator, like the composer")
    #expect(ListFooterMetrics.bottomGap(safeBottom: 24) == 14)
  }

  @Test("the content dropped inside the bar still stands clear of the screen edge")
  func contentDrop() {
    // The bottom padding left between the content and the screen edge stays positive at the smallest gap.
    #expect(ListFooterMetrics.bottomGap(safeBottom: 0) - ListFooterMetrics.contentDrop > 0)
  }

  @Test("update row: the usual 9 pt top padding, target reaching ≥ 44 pt below the caption line, not above it")
  func updateRowTarget() {
    let captionLine: CGFloat = 16
    #expect(ListFooterMetrics.cardPaddingTop + captionLine + ListFooterMetrics.updateRowTargetReach >= 44)
    #expect(ListFooterMetrics.updateRowTargetReach <= ListFooterMetrics.lineGap + captionLine,
            "the target ends inside the account line, not past it")
  }
}
