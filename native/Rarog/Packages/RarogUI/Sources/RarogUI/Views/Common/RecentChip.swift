#if os(iOS)
import SwiftUI

// Chip of a choice in a row. Used by: the recent project row of the "New Session" sheet (scrolls sideways) and the
// model and effort rows of the "Model and Effort" sheet (flow into lines).

/// Recent project pill like `.dir-recent .pill` in the PWA: `surface` background, muted ink and a thin outline;
/// the chosen project has an outline and ink text (`aria-pressed` in the PWA).
struct RecentChip: View {
  /// Pill touch target (32 pt drawn, 44 pt for a finger) — More… stands at the same height.
  static let hitHeight: CGFloat = 44

  let label: String
  let pressed: Bool

  var body: some View {
    Text(label)
      .appFont(.footnote.monospaced())
      .lineLimit(1)
      .padding(.horizontal, 12)
      .padding(.vertical, 4)
      .frame(minHeight: 32)
      .background(Capsule().fill(Color(uiColor: Palette.surface)))
      .overlay(Capsule().strokeBorder(Color(uiColor: pressed ? Palette.text : Palette.border)))
      .foregroundStyle(Color(uiColor: pressed ? Palette.text : Palette.muted))
      .frame(minHeight: Self.hitHeight)
      .contentShape(Capsule())
  }
}
#endif
