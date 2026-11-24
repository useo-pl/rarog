import CoreGraphics

// Where the tab bar's scroll stands with the current tab centred, as a pure function of the bar's geometry, so the
// bar can set that offset itself in the update that changes the current tab (`Views/Projects/ProjectTabBar`). Owner:
// projects and tabs.

/// The scroll offset of the tab bar with a tab in the middle of its visible part.
enum TabBarCentring {
  /// The bar's scroll geometry as `ScrollGeometry` reports it: `contentWidth` without the insets, `containerWidth`
  /// the visible part, which is the scroll view's frame less the insets (measured on iOS 27: an iPad bar 1210 pt wide
  /// under a 320 pt session list reports a container of 890 pt and a leading inset of 320 pt; an iPhone in landscape,
  /// 874 pt with 62 pt of safe area on each side, reports 750 pt), and the insets of the content (on the iPad the bar
  /// reaches under the session list, and its visible part starts after it).
  struct Viewport: Equatable {
    var contentWidth: CGFloat
    var containerWidth: CGFloat
    var leadingInset: CGFloat
    var trailingInset: CGFloat
  }

  /// The `contentOffset.x` that puts the middle of `tab` (its span in the content, from the content's leading edge)
  /// in the middle of the visible part, clamped to the content: from `-leadingInset` at the start to
  /// `contentWidth - containerWidth - leadingInset` at the end, where the content's end meets the visible part's.
  /// Content narrower than the visible part stays at its start.
  static func offset(tab: ClosedRange<CGFloat>, in viewport: Viewport) -> CGFloat {
    let start = -viewport.leadingInset
    let end = viewport.contentWidth - viewport.containerWidth - viewport.leadingInset
    let centred = (tab.lowerBound + tab.upperBound) / 2 - viewport.leadingInset - viewport.containerWidth / 2
    return max(start, min(centred, max(start, end)))
  }

  /// A tab's width in the bar from the width of its label's content (the state mark, the glyph and the text): the
  /// label's insets around the content and at least the tab's target, and on the tab with the "×" (`closes`) the
  /// divider gap in place of the trailing inset, then the divider and the "×" (`ProjectTabLabel`, `TabCloseRoom`). A
  /// session label's content keeps its width when the tab becomes current (the text is monospaced in both weights);
  /// the terminal glyph is drawn in the current tab's weight, so a terminal tab's content can change with it.
  static func width(content: CGFloat, closes: Bool) -> CGFloat {
    let trailing = closes ? TabTokens.closeDividerGap : HeaderMetrics.tabLabelInset
    let label = max(HeaderMetrics.tabTarget, HeaderMetrics.tabLabelInset + content + trailing)
    return label + (closes ? TabTokens.closeDividerWidth + TabTokens.closeTarget : 0)
  }

  /// How much wider the tab is with the "×" than as a sibling. It is not one constant: a label at the target's minimum
  /// does not give up its trailing inset to the divider gap.
  static func room(content: CGFloat) -> CGFloat {
    width(content: content, closes: true) - width(content: content, closes: false)
  }

  /// The span of tab `index` in the bar's row once the tab `current` holds the current place with its "×": the row
  /// starts at `leading`, the tabs stand `spacing` apart, each as wide as `width(content:closes:)` gives for its
  /// label's content (`contentWidths`).
  static func span(
    of index: Int, contentWidths: [CGFloat], current: Int?, spacing: CGFloat, leading: CGFloat
  ) -> ClosedRange<CGFloat> {
    var minX = leading
    for (position, content) in contentWidths.enumerated() {
      let full = width(content: content, closes: position == current)
      if position == index { return minX...(minX + full) }
      minX += full + spacing
    }
    return minX...minX
  }
}
