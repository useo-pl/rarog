import CoreGraphics

/// Geometry of the list footer: a translucent bar docked to the bottom of the list column with the
/// account line, the two plan-usage fields and the three machine columns. Pure numbers, tested on macOS (`ListFooterMetricsTests`); the
/// view lives in `Views/List/Footer`. Values are at the default text size; text and gauges grow with Dynamic Type
/// (`@AppScaledMetric` in the view).
public enum ListFooterMetrics {
  // MARK: Card

  /// The content's inset from the list column (safe area) on the left and right, on top of `cardPaddingSide`. The
  /// same 10 pt as the composer card, the state card and the decision dock, so swapping them never
  /// moves an edge.
  public static let cardSide: CGFloat = 10
  /// Padding of the content inside the bar. With `cardSide` and `contentDrop` the content stands 16 pt from the column
  /// sides, 12 pt under the top line and `bottomGap` + 1 pt over the screen edge (compact bar).
  public static let cardPaddingTop: CGFloat = 9
  public static let cardPaddingSide: CGFloat = 6
  public static let cardPaddingBottom: CGFloat = 4
  /// Between the card's lines (update row, account line, usage line).
  public static let lineGap: CGFloat = 8
  /// How far the update row's tap target reaches below its text (over the line gap and the account line), so the
  /// target is ≥ 44 pt without spare height above the text: 9 pt padding + ~16 pt caption line + 19 pt.
  public static let updateRowTargetReach: CGFloat = 19
  /// The shortest distance between the content's bottom padding and the bottom edge of the screen.
  public static let cardBottomMin: CGFloat = 14
  /// How far the content sits lower in the bar than its padding alone puts it: this much more air under the top line
  /// and this much less over the screen edge.
  public static let contentDrop: CGFloat = 3

  /// Distance between the content's bottom padding and the bottom edge of the screen (keyboard hidden); the bar's
  /// surface reaches the edge. Never less than
  /// `cardBottomMin`; next to a taller home indicator the rule of the composer foot (`FootRest.gap`) keeps the card
  /// clear of it. iPad (20 pt safe area): 14 pt; iPhone with a 34 pt home indicator: 18 pt; no indicator: 14 pt.
  /// The field card takes the same value (`SessionViewController.placeFoot`), so on iPad both cards end on one line.
  public static func bottomGap(safeBottom: CGFloat) -> CGFloat {
    max(cardBottomMin, CGFloat(FootRest.gap(safeBottom: Double(safeBottom))))
  }

  // MARK: Usage line

  /// Between the columns of the usage line: the two limit fields, the divider and the machine columns.
  public static let fieldGap: CGFloat = 12
  /// Inside a limit field: label row, bar, reset line.
  public static let fieldInnerGap: CGFloat = 4
  /// Horizontal limit bar.
  public static let usageBarHeight: CGFloat = 5
  /// Width of the vertical divider between the limits and the machine columns.
  public static let dividerWidth: CGFloat = 0.5

  // MARK: Machine columns

  /// Width of one machine column (CPU, RAM, DSK) and the gap between columns.
  public static let machineColumnWidth: CGFloat = 26
  public static let machineColumnGap: CGFloat = 4
  /// Inside a machine column: number, bar, label.
  public static let machineInnerGap: CGFloat = 3
  /// Vertical bar of a machine column, growing from the bottom.
  public static let machineBarWidth: CGFloat = 7
  public static let machineBarHeight: CGFloat = 18
  public static let machineBarRadius: CGFloat = 2
}
