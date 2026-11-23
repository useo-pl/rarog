#if os(iOS)
@testable import RarogTerminal
import RarogUI
import Testing
import UIKit

// A layout inside an animation (a rotation, the shortcut bar of a hardware keyboard, the screen's stack following the
// keyboard layout guide) can resize the surface in an animation block. SwiftTerm draws the layer for the final size
// at once; the surface must neither scale that drawing to the animated bounds (text drawn stretched, shrinking back)
// nor animate what its own layout moves (the caret sliding across the rows). While the on-screen keyboard comes up
// the screen holds the surface's height and moves it up by the rows that leave the top
// (`rowsLeavingTop(shrinkingTo:)`), so that number must match what SwiftTerm does at the shrink. Owner: terminal.

@MainActor
@Suite("terminal: surface inside the keyboard animation (iOS)")
struct SwiftTermSurfaceKeyboardAnimationTests {
  /// A surface full of lines with the cursor on the bottom row, laid out at 390×700, then shrunk to 390×420 inside
  /// `UIView.animate` the way the keyboard layout guide does it.
  private func shrunkInAnimation() async throws
    -> (surface: SwiftTermSurface, window: UIWindow, caretBefore: CGRect?)
  {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 390, height: 700))
    var text = ""
    for line in 1...80 { text += "line \(line) of synthetic output\r\n" }
    text += "> "
    surface.feed(Data(text.utf8))
    // SwiftTerm places the caret on its display tick (~1/60 s after the bytes), not in `feed`.
    try await Task.sleep(for: .milliseconds(100))
    surface.layoutIfNeeded()
    let caretBefore = caret(of: surface)?.frame
    UIView.animate(withDuration: 0.3) {
      surface.frame = CGRect(x: 0, y: 0, width: 390, height: 420)
      surface.layoutIfNeeded()
    }
    return (surface, window, caretBefore)
  }

  /// SwiftTerm's caret is a subview of the terminal view; its type is internal to SwiftTerm.
  private func caret(of surface: SwiftTermSurface) -> UIView? {
    surface.subviews.first { String(describing: type(of: $0)) == "CaretView" }
  }

  @Test("the caret jumps to its new row instead of sliding across the text")
  func caretDoesNotAnimate() async throws {
    let (surface, window, caretBefore) = try await shrunkInAnimation()
    defer { window.isHidden = true }
    let caret = try #require(caret(of: surface), "the caret stands on the surface")
    let before = try #require(caretBefore)
    #expect(caret.frame.minY < before.minY, "the smaller grid moved the caret up: \(before) → \(caret.frame)")
    let keys = caret.layer.animationKeys() ?? []
    #expect(!keys.contains("position"), "caret animations: \(keys)")
  }

  /// The strip under the unscaled drawing shows the layer's own background. SwiftTerm sets it once, from its default
  /// colour, before the app's theme arrives: a measured frame showed a pure black block under a #090909 terminal.
  @Test("the strip the drawing does not cover has the terminal background, also after a theme change")
  func layerBackgroundIsTerminalBackground() {
    let theme = UIColor {
      $0.userInterfaceStyle == .dark ? UIColor(white: 0.2, alpha: 1) : UIColor(white: 0.9, alpha: 1)
    }
    let surface = SwiftTermSurface(
      configuration: TerminalSurfaceConfiguration(fontSize: 13, background: theme, foreground: .white))
    let window = host(surface, size: CGSize(width: 390, height: 700))
    defer { window.isHidden = true }
    for style in [UIUserInterfaceStyle.light, .dark] {
      window.overrideUserInterfaceStyle = style
      window.layoutIfNeeded()
      surface.updateTraitsIfNeeded()
      let expected = theme.resolvedColor(with: surface.traitCollection).cgColor
      let actual = surface.layer.backgroundColor
      #expect(actual == expected, "style \(style.rawValue): \(String(describing: actual))")
    }
  }

  /// Rows SwiftTerm drops from the top when the grid shrinks: rows below the cursor go first, the rest from the top.
  /// The count must name the row that stands at the top after the real shrink.
  @Test(
    "rows leaving the top match SwiftTerm's shrink, with the cursor on the last row and above it", arguments: [0, 3])
  func rowsLeavingTopMatchShrink(cursorUp: Int) async throws {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 390, height: 700))
    defer { window.isHidden = true }
    var text = ""
    for line in 1...80 { text += "line \(line) of synthetic output\r\n" }
    text += "> "
    if cursorUp > 0 { text += "\u{1B}[\(cursorUp)A" }
    surface.feed(Data(text.utf8))
    surface.layoutIfNeeded()
    let rows = surface.gridSize.rows
    let before = surface.visibleText.components(separatedBy: "\n")
    let target = rows - 10
    let left = surface.rowsLeavingTop(shrinkingTo: target)
    #expect(left == 10 - cursorUp, "rows: \(rows), cursor \(cursorUp) rows above the bottom")
    let cell = surface.gridFrame.height / CGFloat(rows)
    surface.frame = CGRect(x: 0, y: 0, width: 390, height: CGFloat(target) * cell + cell / 2)
    surface.layoutIfNeeded()
    #expect(surface.gridSize.rows == target)
    let after = surface.visibleText.components(separatedBy: "\n")
    #expect(after.first == before[left], "top row after the shrink: \(after.first ?? "")")
  }

  /// Held while the keyboard comes up, the surface stands above its container, under the screen's header and the top
  /// of the safe area. The surface is a scroll view: the system's top edge effect blurred the rows going up (a dark
  /// band the height of the rise, recorded on an iPhone) and the safe area would add a content inset.
  @Test("a surface moved above the safe area gets no edge blur and no content inset")
  func noEdgeEffectAboveSafeArea() async throws {
    let surface = makeSurface()
    let window = host(surface, size: CGSize(width: 390, height: 700))
    defer { window.isHidden = true }
    surface.frame = CGRect(x: 0, y: -200, width: 390, height: 700)
    window.layoutIfNeeded()
    #expect(surface.adjustedContentInset == .zero, "inset: \(surface.adjustedContentInset)")
    #expect(surface.topEdgeEffect.isHidden, "top edge effect: \(surface.topEdgeEffect.style)")
    #expect(surface.bottomEdgeEffect.isHidden, "bottom edge effect: \(surface.bottomEdgeEffect.style)")
  }

  @Test("the layer keeps its drawing unscaled while its bounds animate, top-aligned like the caret")
  func contentsDoNotScale() async throws {
    let (surface, window, _) = try await shrunkInAnimation()
    defer { window.isHidden = true }
    // The frame change itself is animated by UIKit (the parent's layout), so the case is real.
    #expect((surface.layer.animationKeys() ?? []).contains("bounds.size"))
    #expect(surface.contentMode == .topLeft, "cell (0, 0) at the top-left corner, where SwiftTerm places the caret")
    let scaling: [CALayerContentsGravity] = [.resize, .resizeAspect, .resizeAspectFill]
    #expect(!scaling.contains(surface.layer.contentsGravity), "gravity: \(surface.layer.contentsGravity.rawValue)")
  }
}
#endif
