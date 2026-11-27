#if os(iOS)
import RarogCore
import SwiftUI

// The filter segments over the session list: All · Needs You · Working · Unread as glyphs with their counts.
// Membership and counts come from the core (`ListFilter`), the chosen segment from the navigation
// (`Navigation+ListFilter.swift`); the container (`SessionListView`) puts the row in its top inset, beside the Inbox
// button, floating over the list. Owner: list.

/// One glass capsule of segments under the navigation bar and the banners, floating over the list, which scrolls
/// beneath it (`FilterGlass`). It stands from the first frame: on the skeleton and on an empty list the segments are
/// disabled and the counts muted, so the list appearing does not change the top inset. The segments share one
/// capsule, so they read as one control that picks one filter; the active segment sits on a capsule plate
/// (`Palette.filterGlassPlate`). The segments share the capsule's width, so the row fits without scrolling; it
/// scrolls sideways only when even the glyphs do not fit, and never truncates.
struct ListFilterBar: View {
  let store: RarogStore
  let navigation: RarogNavigation
  /// The row's width, measured; the segments spread over it when they fit.
  @State private var width: CGFloat = 0
  /// The segments' own width, measured; above the row's width the row scrolls.
  @State private var contentWidth: CGFloat = 0

  var body: some View {
    let state = store.state
    let ready = state.sessionsLoaded && !state.sessions.isEmpty
    // One scroll view at every text size: equal segments across the column when they fit, so it does not scroll;
    // only when even the glyphs do not fit (the largest accessibility sizes in a narrow column) the row scrolls
    // sideways instead of truncating. Not `ViewThatFits`: swapping the view on a text size change made the Dynamic
    // Type audit see the counts as partially unsupported. Unclipped while it fits, so the glass's shadow shows.
    let fits = contentWidth <= width + 0.5
    ScrollView(.horizontal) { segments(state, ready: ready) }
      .scrollIndicators(.hidden)
      .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
      .scrollClipDisabled(fits)
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(UICopy.listFilterGroup)
      .accessibilityIdentifier("list.filter")
  }

  private func segments(_ state: AppState, ready: Bool) -> some View {
    FilterSegmentsLayout(available: width) {
      ForEach(ListFilter.allCases, id: \.self) { filter in
        segment(filter, count: state.listFilterCount(filter), ready: ready)
      }
    }
    .background { FilterGlass(shape: Capsule()) }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
  }

  /// The gap between the glass's edge and a segment's plate. The segment's target includes it.
  static let trackInset: CGFloat = 4
  /// The plate's height; with the inset on both sides the glass and every target are 44 pt tall.
  static let plateHeight: CGFloat = 36
  /// The glass row's distance from the column's sides and from the navigation bar above it.
  static let glassEdge: CGFloat = 12

  /// A segment is its glyph and its count; the word is what VoiceOver says and what the pointer shows in the app's
  /// own tip (`pointerTip`: the system `help` does not show on an iPad). Words did not fit the column without
  /// scrolling. Under the pointer a segment lights like an agent row and a tab: its plate at half opacity
  /// (`HoverTokens.agentRowAlpha`) and the glyph in full text ink.
  private func segment(_ filter: ListFilter, count: Int, ready: Bool) -> some View {
    RarogHoverReader(enabled: ready) { hovered in
      segmentButton(filter, count: count, ready: ready, hovered: hovered)
    }
  }

  private func segmentButton(_ filter: ListFilter, count: Int, ready: Bool, hovered: Bool) -> some View {
    let active = navigation.listFilter == filter
    let label = UICopy.listFilterLabel(filter)
    return Button {
      navigation.selectListFilter(filter, state: store.state)
    } label: {
      HStack(spacing: 5) {
        Image(systemName: Self.glyph(filter))
          .foregroundStyle(Color(uiColor: (active || hovered) && ready ? Palette.text : Palette.text2))
        Text(count, format: .number)
          .appFont(.subheadline.monospacedDigit())
          .foregroundStyle(Color(uiColor: Self.countInk(filter, count: count, ready: ready, active: active)))
      }
      .appFont(.subheadline.weight(active ? .semibold : .regular))
      .lineLimit(1)
      .fixedSize()
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, minHeight: Self.plateHeight)
      .background {
        let plate = Color(uiColor: Palette.filterGlassPlate)
        if active {
          Capsule().fill(plate)
        } else if hovered {
          Capsule().fill(plate.opacity(HoverTokens.agentRowAlpha))
        }
      }
      .padding(Self.trackInset)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!ready)
    .pointerTip(label)
    .accessibilityLabel(label)
    .accessibilityValue(Text(count, format: .number))
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityIdentifier("list.filter.\(filter.rawValue)")
  }

  /// The segment's glyph: a list for All, a speech bubble with a question for the sessions that ask the human, a bolt
  /// for work and a check for a result handed over.
  static func glyph(_ filter: ListFilter) -> String {
    switch filter {
    case .all: "list.bullet"
    case .needsYou: "questionmark.bubble"
    case .working: "bolt"
    case .unread: "checkmark"
    }
  }

  /// How far the top inset (banners and this row) rises under the navigation bar: the bar leaves empty space under
  /// the title; a larger rise put the glass against the bar. The container applies it to the whole inset, never to
  /// this row alone: the row is opaque and would cover the bottom of a banner over it.
  static let rise: CGFloat = 4

  /// The count's ink: Needs You in amber and Unread in the unread blue while they count something; All and Working
  /// in secondary text; zero, the skeleton and an empty list muted. The active segment's zero is secondary text:
  /// `muted2` on the glass plate over a busy list falls under 4.5:1 (the disabled skeleton is exempt).
  static func countInk(_ filter: ListFilter, count: Int, ready: Bool, active: Bool = false) -> UIColor {
    guard ready else { return Palette.muted2 }
    guard count > 0 else { return active ? Palette.text2 : Palette.muted2 }
    switch filter {
    case .needsYou: return Palette.wait
    case .unread: return Palette.tone(.unread)
    case .all, .working: return Palette.text2
    }
  }
}
/// The segments in one row at the widths of `ListFilterSegmentWidths`: spread over `available` when they fit, at their
/// own widths when they do not (the scroll view around them then scrolls).
private struct FilterSegmentsLayout: Layout {
  let available: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let widths = widths(subviews)
    let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
    return CGSize(width: widths.reduce(0, +), height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    for (subview, width) in zip(subviews, widths(subviews)) {
      subview.place(
        at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading,
        proposal: ProposedViewSize(width: width, height: bounds.height))
      x += width
    }
  }

  private func widths(_ subviews: Subviews) -> [CGFloat] {
    ListFilterSegmentWidths.widths(ideal: subviews.map { $0.sizeThatFits(.unspecified).width }, available: available)
  }
}
#endif
