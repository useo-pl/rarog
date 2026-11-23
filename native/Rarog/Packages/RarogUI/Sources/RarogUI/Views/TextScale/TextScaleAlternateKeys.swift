#if os(iOS)
import SwiftUI

// ⇧⌘= for Make Text Bigger, next to the ⌘= of the menu bar (`RarogCommands`): UIKit matches a press with Shift only
// against a command registered with Shift, and a second menu item would show the command twice in the menu bar,
// while a hidden menu item registers no key. The key sits on an invisible button at the root of the app's views and,
// because SwiftUI does not reach the root's buttons under a sheet, again in the app's one sheet (`SheetHost`). The
// button has a size and an opacity above zero: SwiftUI registers no shortcut for a view without a frame.
// Owner: text size.

struct TextScaleAlternateKeys: ViewModifier {
  var scale = TextScale.shared

  func body(content: Content) -> some View {
    content.background(alignment: .topLeading) {
      ForEach(AppShortcut.textBigger.alternateCombinations, id: \.self) { combination in
        Button { scale.grow() } label: { Color.clear.frame(width: 1, height: 1) }
          .keyboardShortcut(combination.keyboardShortcut)
          .disabled(!scale.canGrow)
          .buttonStyle(.plain)
          .opacity(0.011)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
    }
  }
}
#endif
