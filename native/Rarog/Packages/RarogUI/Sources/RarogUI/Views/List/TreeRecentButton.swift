#if os(iOS)
import SwiftUI

// The Recent Sessions clock in a project header of the tree. Owner: list and projects.

/// Recent Sessions of the project as a button in the project header, before the note glyph. The note button's
/// pattern: a muted glyph, text ink on
/// `TreeNotePlate` under the pointer, a target 44 pt high and `width` wide that ends `reach` past the glyph
/// (`TreeHeaderButtonGeometry`), `borderless` so the cell does not take the tap.
struct TreeRecentButton: View {
  let name: String
  var width: CGFloat = SessionListMetrics.treeButtonWidth
  var reach: CGFloat = 0
  let open: () -> Void
  @State private var hovered = false

  static let symbol = "clock.arrow.circlepath"
  /// Glyph size of both header buttons, the clock and the note (between `caption` and the name's
  /// `subheadline`), also for their placeholders in the header content, so the overlay lands on them.
  static let glyphFont: AppFont = .footnote

  var body: some View {
    Button(action: open) {
      Image(systemName: Self.symbol)
        .appFont(Self.glyphFont)
        .foregroundStyle(Color(uiColor: hovered ? Palette.text : Palette.muted2))
        .fixedSize()
        .background { if hovered { TreeNotePlate() } }
        .padding(.trailing, reach)
        .frame(width: width, height: SessionListMetrics.treeButtonHeight, alignment: .trailing)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .hoverEffectDisabled()
    .onHover { hovered = $0 }
    .pointerTip(UICopy.recentSessionsTitle)
    .accessibilityLabel(UICopy.recentSessionsLabel(name))
    .accessibilityIdentifier("tree.recent.\(name)")
  }
}
#endif
