#if os(iOS)
import RarogCore
import SwiftUI

// The "×" of the current session or terminal tab and the divider before it. Owner: projects and tabs.

/// The divider and the "×" after the label of the current tab (a session or a terminal), outside the tab's selection
/// button, so a tap
/// on the label still opens the window of the project's tabs. The divider is the one of the "N new" chip: 1 pt in
/// `border`, half the plate's height, `TabTokens.closeDividerGap` after the label. The "×" has its own target,
/// `TabTokens.closeTarget` wide and as tall as the tab. Two presses: the first arms for 5 s ("×" in `err` on an
/// `err` wash, and the card under the bar says what the next press does), the second closes, with a spinner in the
/// glyph's place on the way. A dimmed "×" has no action. Every state keeps the width. Keyboard focus leaving the
/// button disarms a session's close; a terminal keeps its arming on the screen (its 5 s, the screen change, the scene
/// going inactive). The plate under the current tab (`ProjectTabButton`) spans the label, the divider and the "×".
struct TabCloseButton: View {
  let model: TabCloseModel
  let press: () -> Void
  /// Keyboard focus (Tab, Full Keyboard Access) left the button.
  let blur: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 0) {
      TabCloseDivider()
      Button(action: press) {
        TabCloseGlyphView(model: model)
      }
      // The same answer to a finger as the tab beside it: dims and comes back in one step; the pointer lights the glyph.
      .buttonStyle(TabPressStyle())
      .disabled(!model.acts)
      .accessibilityLabel(model.spoken)
      .accessibilityIdentifier(model.accessibilityId)
      .shortcutTip(model.label, .closeTab)
      .focused($focused)
      .onChange(of: focused) { wasFocused, isFocused in
        if wasFocused, !isFocused { blur() }
      }
    }
  }
}

/// The line between the label and the "×": half the plate's height, centered on it (the plate stands
/// `TabTokens.plateTopInset` under the top of the tab and `plateBottomInset` over its bottom).
struct TabCloseDivider: View {
  var body: some View {
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(width: TabTokens.closeDividerWidth)
      .scaleEffect(x: 1, y: 0.5)
      .padding(.top, TabTokens.plateTopInset)
      .padding(.bottom, TabTokens.plateBottomInset)
      .frame(maxHeight: .infinity)
      .accessibilityHidden(true)
  }
}

/// The glyph in its target: "×" in the muted ink (the full text under the pointer), armed in `err` on the wash,
/// dimmed in the idle ink, or a spinner.
struct TabCloseGlyphView: View {
  let model: TabCloseModel
  /// The pointer over the button (`TabPressStyle` through `RarogHoverReader`).
  @Environment(\.rarogHovered) private var hovered

  var body: some View {
    ZStack {
      if model.glyph == .armed {
        RoundedRectangle(cornerRadius: TabTokens.plateRadius, style: .continuous)
          .fill(Color(uiColor: Palette.tabCloseWash))
          .padding(.top, TabTokens.plateTopInset)
          .padding(.bottom, TabTokens.plateBottomInset)
      }
      Group {
        if model.glyph == .closing {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "xmark")
            .appFont(.caption.weight(.semibold))
            .foregroundStyle(Color(uiColor: ink))
        }
      }
      // In the axis of the tab's label, `tabLabelDrop` below the middle of the target.
      .offset(y: HeaderMetrics.tabLabelDrop)
    }
    .frame(width: TabTokens.closeTarget)
    .frame(minHeight: HeaderMetrics.iconTarget, maxHeight: .infinity)
    .contentShape(Rectangle())
  }

  private var ink: UIColor {
    switch model.glyph {
    case .armed: Palette.err
    case .dimmed: Palette.idleInk
    case .idle, .closing: hovered ? Palette.text : Palette.muted2
    }
  }
}
#endif
