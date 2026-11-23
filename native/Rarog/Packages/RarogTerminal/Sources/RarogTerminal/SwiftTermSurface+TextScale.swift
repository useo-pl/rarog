#if os(iOS)
import Observation
import RarogUI
@preconcurrency import SwiftTerm
import UIKit

// The surface follows the app's text size (`TextScale`: ⌘+, ⌘-, ⌘0 and the system's size under a stored step) on the
// living emulator, without a new connection. The grid changes the way a rotation changes it. Owner: terminal.

extension SwiftTermSurface {
  /// The font size the app's text size gives now (``TerminalFontSize/points(_:scale:)``).
  var scaledFontSize: CGFloat {
    TerminalFontSize.points(configuration.fontSize, scale: configuration.textScale)
  }

  /// Watches the effective and the system's category. Observation reports a change before the new value is set, so the
  /// font changes on the next turn of the main actor.
  func followTextScale() {
    guard let scale = configuration.textScale, !closed else { return }
    withObservationTracking {
      _ = scale.effective
      _ = scale.system
    } onChange: { [weak self] in
      Task { @MainActor in
        guard let self, !self.closed else { return }
        self.followTextScale()
        self.applyScaledFont()
      }
    }
  }

  /// Puts the four Menlo fonts at ``scaledFontSize`` on the emulator, then lets the next layout pass set the grid.
  ///
  /// SwiftTerm's own font change (`setFonts`) resizes the terminal through `resize(cols:rows:)`, which also soft-resets
  /// it: application cursor keys, the scroll region, the colours set by the program and a hidden cursor would all go.
  /// SwiftTerm skips that resize while the view has no size, so the fonts go in at a zero size, after one SwiftTerm
  /// layout at that size, which never touches the grid (`processSizeChange` ignores 0 × 0). The next layout at the
  /// real size then changes the grid like a rotation: `Buffer.resize` without a reset and one ``onResize`` with the
  /// new grid. A parked surface (outside the window) keeps its fonts and grid: a layout forced while parked (the
  /// Cmd+F/G window lays out its stack when edge colours change) would otherwise resize the emulator under bytes the
  /// server sends for the old grid. ``didMoveToWindow()`` applies the size on return. The skips of
  /// ``layoutSubviews()`` (inactive scene, too small a frame) hold the resize back like any other layout.
  func applyScaledFont() {
    let size = scaledFontSize
    guard !closed, window != nil, font.pointSize != size else { return }
    let fonts = Self.fonts(size: size)
    let full = bounds
    let autoresizes = autoresizesSubviews
    // Subviews keep their frames through the zero size.
    autoresizesSubviews = false
    bounds.size = .zero
    UIView.performWithoutAnimation { super.layoutSubviews() }
    setFonts(normal: fonts.normal, bold: fonts.bold, italic: fonts.italic, boldItalic: fonts.boldItalic)
    bounds = full
    autoresizesSubviews = autoresizes
    setNeedsLayout()
  }
}
#endif
