#if os(iOS)
import SwiftUI

// The pop-up terminal glyph in a project header of the tree. Owner: list and terminal.

/// The project's shell in the pop-up window (the Cmd+F window), as a button in the project header before the Recent
/// Sessions clock. The clock's pattern (`TreeRecentButton`): a muted glyph, text ink on `TreeNotePlate` under the
/// pointer, a target 44 pt high and `width` wide that ends `reach` past the glyph, `borderless` so the cell does not
/// take the tap.
struct TreeTerminalButton: View {
  let name: String
  var width: CGFloat = SessionListMetrics.treeButtonWidth
  var reach: CGFloat = 0
  let open: () -> Void
  @State private var hovered = false

  static let symbol = "terminal"

  var body: some View {
    Button(action: open) {
      Image(systemName: Self.symbol)
        .appFont(TreeRecentButton.glyphFont)
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
    .pointerTip(UICopy.shortcutPopupShell)
    .accessibilityLabel(UICopy.treePopupLabel(name))
    .accessibilityIdentifier("tree.terminal.\(name)")
  }
}
#endif
