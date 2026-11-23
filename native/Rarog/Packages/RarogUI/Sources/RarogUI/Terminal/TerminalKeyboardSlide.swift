import CoreGraphics

// The terminal surface while the on-screen keyboard slides. The screen's stack stands on the keyboard layout guide,
// so the keyboard animates the height of the surface's container. A surface that follows the container changes the
// grid in the first frame of the slide: SwiftTerm draws the smaller grid at once, so the text jumps to its final
// place and the key bar closes the strip under it. Instead, while the keyboard comes up the surface keeps its height
// and moves up inside the clipping container by the rows SwiftTerm will drop from the top, so the top rows go under
// the top edge like scrolling; when the keyboard has arrived the surface takes the container's height, and the
// smaller grid draws the same rows in the same places. While the keyboard goes down the surface takes the final
// height at once, outside the animation: the new rows wait under the key bar until it slides away.
// Pure logic: the screen asks it in every layout pass of the container (`TerminalScreenViewController+Keyboard`),
// tests on macOS (`TerminalKeyboardSlideTests`). Owner: terminal.

/// The surface's place in its container while the on-screen keyboard slides.
struct TerminalKeyboardSlide: Equatable, Sendable {
  /// Where the surface stands after one layout pass of the container.
  enum Placement: Equatable, Sendable {
    /// The container's height, set in the pass's animation (if any): what every layout outside a slide does.
    case fill
    /// The container's height, set outside the animation: the keyboard goes down and the grid grows at once.
    case fillAtOnce
    /// The height from before the keyboard came up, with the top `top` points from the container's top (≤ 0).
    case held(top: CGFloat, height: CGFloat)
  }

  /// One layout pass of the container.
  struct Pass: Equatable, Sendable {
    /// The container's size in this pass (the final size when the pass runs in an animation).
    var container: CGSize
    /// The surface's height before this pass.
    var surfaceHeight: CGFloat
    /// The on-screen keyboard covers the bottom of the screen in this pass.
    var keyboardUp: Bool
    /// The pass runs inside an animation (the keyboard's).
    var animated: Bool
    /// The slide may hold the grid: no hardware keyboard, the stack follows the keyboard layout guide (not the
    /// height held while a window closes) and the grid has rows.
    var eligible: Bool

    init(container: CGSize, surfaceHeight: CGFloat, keyboardUp: Bool, animated: Bool, eligible: Bool) {
      self.container = container
      self.surfaceHeight = surfaceHeight
      self.keyboardUp = keyboardUp
      self.animated = animated
      self.eligible = eligible
    }
  }

  /// The held surface: its height, the container width it was held for, the container height its top was computed
  /// for and that top.
  struct Hold: Equatable, Sendable {
    var height: CGFloat
    var width: CGFloat
    var container: CGFloat
    var top: CGFloat
  }

  /// The surface held at its old height; `nil` = the surface fills the container.
  private(set) var hold: Hold?
  /// The keyboard's state in the previous pass; `nil` before the first one.
  private var keyboardWasUp: Bool?
  /// The end of a quiet window that fell inside the hold: the settled `rs` waits for the end of the slide.
  var deferredSettle: Int?

  init() {}

  /// The surface's place in this pass.
  /// - Parameter rise: how far the content moves up when the grid shrinks to a view of the given height (the rows
  ///   SwiftTerm drops from the top times the cell height).
  mutating func place(_ pass: Pass, rise: (CGFloat) -> CGFloat) -> Placement {
    let wasUp = keyboardWasUp ?? pass.keyboardUp
    keyboardWasUp = pass.keyboardUp
    if let held = hold {
      let holds =
        pass.eligible && pass.keyboardUp && pass.container.width == held.width && pass.container.height < held.height
      guard holds else {
        hold = nil
        return .fill
      }
      if pass.container.height != held.container {
        hold?.container = pass.container.height
        hold?.top = Self.top(rise(pass.container.height), height: held.height)
      }
      return .held(top: hold?.top ?? 0, height: held.height)
    }
    guard pass.eligible, pass.animated else { return .fill }
    if pass.keyboardUp, !wasUp, pass.container.height < pass.surfaceHeight {
      let top = Self.top(rise(pass.container.height), height: pass.surfaceHeight)
      hold = Hold(height: pass.surfaceHeight, width: pass.container.width, container: pass.container.height, top: top)
      return .held(top: top, height: pass.surfaceHeight)
    }
    if !pass.keyboardUp, wasUp, pass.container.height > pass.surfaceHeight { return .fillAtOnce }
    return .fill
  }

  /// The keyboard finished its slide: the next pass fills the container. `true` = the surface was held.
  mutating func release() -> Bool {
    defer { hold = nil }
    return hold != nil
  }

  /// The top for a rise: never below the container's top, never the whole surface above it.
  private static func top(_ rise: CGFloat, height: CGFloat) -> CGFloat {
    -min(max(0, rise), height)
  }
}
