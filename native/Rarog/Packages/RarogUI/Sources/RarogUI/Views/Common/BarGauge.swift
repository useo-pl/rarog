#if os(iOS)
import SwiftUI
import UIKit

// Gauges of the list footer card: the horizontal limit bar (`BarGauge`) and the vertical machine bar
// (`ColumnGauge`). Decoration next to a number: the number and the VoiceOver sentence carry the meaning. The caller
// gives the fill color (thresholds: `FooterInk`); the track is the text ink at `trackAlpha`. Both grow with
// Dynamic Type (relative to `caption`, like the card's text).

/// Track of both gauges: the text ink at this opacity (white 10 % in the dark theme).
private let trackAlpha = 0.1

/// Horizontal bar filled from the left; the width comes from the caller.
struct BarGauge: View {
  /// 0–1; values out of range are clamped.
  let fraction: Double
  let fill: UIColor
  @AppScaledMetric(relativeTo: .caption) private var height: CGFloat = ListFooterMetrics.usageBarHeight

  var body: some View {
    // The fill is scaled from the left and clipped by the track's capsule: a small value is the rounded start of the
    // bar, not a capsule squeezed into a line.
    Capsule()
      .fill(Color(uiColor: Palette.text).opacity(trackAlpha))
      .overlay {
        Rectangle()
          .fill(Color(uiColor: fill))
          .scaleEffect(x: min(1, max(0, fraction)), y: 1, anchor: .leading)
      }
      .clipShape(Capsule())
      .frame(height: height)
      .accessibilityHidden(true)
  }
}

/// Vertical bar filled from the bottom: fixed width, at least `machineBarHeight` tall, taller when the column is.
struct ColumnGauge: View {
  let fraction: Double
  let fill: UIColor
  @AppScaledMetric(relativeTo: .caption) private var width: CGFloat = ListFooterMetrics.machineBarWidth
  @AppScaledMetric(relativeTo: .caption) private var height: CGFloat = ListFooterMetrics.machineBarHeight

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ListFooterMetrics.machineBarRadius, style: .continuous)
    shape
      .fill(Color(uiColor: Palette.text).opacity(trackAlpha))
      .overlay {
        Rectangle()
          .fill(Color(uiColor: fill))
          .scaleEffect(x: 1, y: min(1, max(0, fraction)), anchor: .bottom)
      }
      .clipShape(shape)
      // At least `machineBarHeight`; beside a taller left column the bar takes the extra height.
      .frame(width: width)
      .frame(minHeight: height, maxHeight: .infinity)
      .accessibilityHidden(true)
  }
}
#endif
