#if os(iOS)
import SwiftUI

// The tab bar's centring on a new current tab, on the clock of the rooms' slide (`ProjectTabBar`). Owner: projects
// and tabs.

/// The centring of one change of the current tab: the scroll stands at its end at once, and the row is drawn shifted
/// back by what the motion has still to cover, so the bar shows the scroll moving.
struct TabBarFollow: Equatable {
  /// The current tab the motion leads to; on any other current tab the motion is over.
  var id: String?
  /// The row's shift per unit of the current tab's index still to cover (`TabBarFollowShift`).
  var distance: CGFloat
  /// The scroll offset at the motion's end and the geometry around it, for the edge fade during the motion.
  var offset: CGFloat
  var viewport: TabBarCentring.Viewport

  static let rest = TabBarFollow(
    id: nil, distance: 0, offset: 0,
    viewport: TabBarCentring.Viewport(contentWidth: 0, containerWidth: 0, leadingInset: 0, trailingInset: 0))

  /// The shift for the current tab `id` at `index` while the drawn index is `shown`: the old place's distance at the
  /// motion's start, 0 at its end and at rest. `nil` while a newer current tab waits for its motion: the bar draws
  /// that one update before it sets the motion, and the row stays where it was drawn.
  func shift(id: String?, index: Double, shown: Double) -> CGFloat? {
    if self.id == nil { return 0 }
    return id == self.id ? distance * CGFloat(index - shown) : nil
  }
}

/// What the bar's centring reads without redrawing the bar: the last scroll offset and tab widths reported by the
/// layout, and the last drawn shift, so a change in the middle of a motion starts where the bar stands.
@MainActor
final class TabBarScrollState {
  var offset: CGFloat = 0
  var viewport: TabBarCentring.Viewport?
  /// The width of each tab's label content (`TabBarCentring.width`), by tab identifier.
  var contentWidths: [String: CGFloat] = [:]
  /// The content's width less the current tab's "×" room, from the last layout.
  var restContentWidth: CGFloat?
  /// The drawn index of the current tab and the drawn shift, from the last frame.
  var shownIndex: Double?
  var shownShift: CGFloat = 0
}

/// The current tab's index as an animatable value: it changes with `currentId`, so it runs in the rooms' animation and
/// on their clock, and the row's shift is drawn from it on every frame of that animation.
struct TabBarFollowShift: ViewModifier, Animatable {
  let follow: TabBarFollow
  let id: String?
  /// The current tab's index; `shown` is its animated value.
  let index: Double
  var shown: Double
  let state: TabBarScrollState

  nonisolated var animatableData: Double {
    get { shown }
    set { shown = newValue }
  }

  func body(content: Content) -> some View {
    let shift = follow.shift(id: id, index: index, shown: shown) ?? state.shownShift
    state.shownIndex = shown
    state.shownShift = shift
    return content.offset(x: shift)
  }
}

/// The edge fade (`TabEdgeMask`) during the motion: from the offset the bar shows, the scroll's end less the row's
/// shift, on the same animated index as the row; at rest the fade from the scroll geometry.
struct TabEdgeMaskFollow: View, Animatable {
  let fade: TabTokens.EdgeFade
  let follow: TabBarFollow
  let id: String?
  let index: Double
  var shown: Double
  let state: TabBarScrollState

  nonisolated var animatableData: Double {
    get { shown }
    set { shown = newValue }
  }

  var body: some View {
    let shift = follow.shift(id: id, index: index, shown: shown) ?? state.shownShift
    TabEdgeMask(fade: shift == 0 ? fade : TabTokens.edgeFade(
      offset: follow.offset - shift, contentWidth: follow.viewport.contentWidth,
      containerWidth: follow.viewport.containerWidth, leadingInset: follow.viewport.leadingInset,
      trailingInset: follow.viewport.trailingInset))
  }
}
#endif
