#if os(iOS)
import RarogCore
import SwiftUI

// The jump pill over the session list: "3 below ↓ · 1 waiting, 1 failed, 1 unread". The count comes from
// `ListJumpPillTracker`, the texts from `Copy/UICopy+ListJump.swift`; the container (`SessionListView`) puts one pill
// at each edge of the list. Owner: list.

/// One side's pill, or nothing when that side has no row that needs the human off screen. The container overlays it
/// on the list: "below" its touch frame on the footer card, "above" at the top edge of the list (under the banners
/// and the filter segments). The pill changes neither the list's insets nor its
/// margins. Its measured frame goes back to the tracker: its height decides which rows on screen it covers.
struct ListJumpPillView: View {
  let tracker: ListJumpPillTracker
  let direction: ListJumpPill.Direction
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let side = direction == .below ? tracker.result.below : tracker.result.above
    ZStack {
      if let side {
        ListJumpPillButton(side: side, direction: direction) {
          tracker.jump(direction, reduceMotion: reduceMotion)
        }
        .onGeometryChange(for: CGRect.self) { proxy in proxy.frame(in: .global) } action: { frame in
          tracker.measured(direction, frame: frame)
        }
        .transition(.opacity)
      }
    }
    // The 44 pt touch frame already leaves air around the lower capsule: no extra gap, or it would double.
    .padding(.horizontal, SessionListMetrics.plateEdge * 2)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: side == nil)
  }
}

/// The capsule: translucent `surface2` over a blur, without a stroke, the shadow of the floating controls
/// (`JumpToBottomBar.lift`), its touch target 44 pt high. The text is the segments of `UICopy.listJumpSegments`: the
/// count and the direction in text ink, each state phrase in its state's color, the session's name last in ink, so a
/// long name is cut at its end. At accessibility text sizes the text may take two lines. VoiceOver hears one button
/// with the whole sentence and what a tap does.
struct ListJumpPillButton: View {
  let side: ListJumpPill.Side
  let direction: ListJumpPill.Direction
  let action: () -> Void
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    Button(action: action) {
      label
        .appFont(.footnote.weight(.semibold))
        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
        .truncationMode(.tail)
        .padding(.horizontal, Self.sidePadding)
        .padding(.vertical, Self.verticalPadding)
        .background {
          // Translucent: the rows under the pill stay readable as shapes, so it reads as floating over the list.
          Capsule().fill(.ultraThinMaterial)
          Capsule().fill(Color(uiColor: Palette.surface2).opacity(Self.fillOpacity))
        }
        .shadow(color: .black.opacity(shadowOpacity), radius: 6, y: 3)
        // The capsule hugs its text; the touch target around it stays 44 pt high.
        .frame(minHeight: Self.minHeight)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(UICopy.listJumpSpoken(side, direction))
    .accessibilityHint(UICopy.listJumpHint())
    .accessibilityIdentifier(direction == .below ? "list.jump.below" : "list.jump.above")
  }

  /// The segments as one text, each in its role's ink.
  private var label: Text {
    UICopy.listJumpSegments(side, direction).reduce(Text(verbatim: "")) { text, segment in
      Text("\(text)\(Text(segment.text).foregroundStyle(Color(uiColor: Self.ink(segment.role))))")
    }
  }

  private var shadowOpacity: Double {
    Double(JumpToBottomBar.shadowOpacity(colorScheme == .light ? .light : .dark))
  }

  static func ink(_ role: ListJumpPill.Segment.Role) -> UIColor {
    switch role {
    case .plain, .name: Palette.text
    case .state(.waiting): Palette.tone(.waiting)
    case .state(.failed): Palette.tone(.failed)
    case .state(.unread): Palette.tone(.unread)
    }
  }

  /// The pill's touch target; the capsule inside is lower.
  static let minHeight: CGFloat = 44
  /// Air over and under the text.
  static let verticalPadding: CGFloat = 10
  /// Air at the capsule's ends: its radius, half of a one-line capsule (a footnote line of about 16 pt plus the air
  /// over and under it). With it the text's corners stand as far from the round end as the text stands from the top
  /// and bottom, so the air looks the same on every side.
  static let sidePadding: CGFloat = verticalPadding + 8
  /// How much of `surface2` lies over the blur: the text keeps its contrast, the list shows through a little.
  static let fillOpacity: CGFloat = 0.6
}
#endif
