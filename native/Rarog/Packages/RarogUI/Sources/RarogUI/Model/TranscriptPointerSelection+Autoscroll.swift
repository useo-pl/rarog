import CoreGraphics
import Foundation

// Speed of the list's own scrolling while a pointer selection is dragged near or past the top or bottom edge of the
// visible list. A pure curve: zero at the inner boundary of the band, growing with the depth in the band and past the
// edge, up to a ceiling, so the list creeps when the pointer just enters the band and races when it is far outside.
// The screen applies it every frame. Owner: transcript.

extension TranscriptPointerSelection {
  /// Height of the band along each visible edge of the list where autoscroll begins, in points.
  public static let autoscrollBand: CGFloat = 44
  /// Fastest autoscroll, in points per second.
  static let autoscrollCeiling: CGFloat = 2400
  /// Depth past the band's inner boundary where the speed reaches the ceiling, in points.
  static let autoscrollFullDepth: CGFloat = 220

  /// Autoscroll speed in points per second for a pointer `depth` points past the band's inner boundary toward the
  /// edge (the edge itself is at ``autoscrollBand``, beyond it the pointer is outside the list). Zero at or inside the
  /// inner boundary; grows quadratically, without a step at the edge, up to the ceiling.
  public static func autoscrollSpeed(depth: CGFloat) -> CGFloat {
    guard depth > 0 else { return 0 }
    let share = min(depth / autoscrollFullDepth, 1)
    return autoscrollCeiling * share * share
  }

  /// Signed autoscroll velocity for a pointer at `pointer`, with `top` and `bottom` the visible edges of the list
  /// (inside its content insets), all in one vertical coordinate space: negative scrolls toward the top of the content,
  /// positive toward the bottom, zero outside both bands. In a list shorter than two bands the nearer edge wins.
  public static func autoscrollVelocity(pointer: CGFloat, top: CGFloat, bottom: CGFloat) -> CGFloat {
    let towardTop = top + autoscrollBand - pointer
    let towardBottom = pointer - (bottom - autoscrollBand)
    if towardTop > 0, towardTop > towardBottom { return -autoscrollSpeed(depth: towardTop) }
    if towardBottom > 0, towardBottom > towardTop { return autoscrollSpeed(depth: towardBottom) }
    return 0
  }
}
