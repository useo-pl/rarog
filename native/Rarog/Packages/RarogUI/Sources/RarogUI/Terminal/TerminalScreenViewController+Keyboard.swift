#if os(iOS)
import UIKit

// The terminal surface while the on-screen keyboard slides (rule: `TerminalKeyboardSlide`). The container
// (`TerminalSurfaceContainer`) places the surface in every layout pass. The keyboard's own pass runs inside its
// animation: when the keyboard comes up, the surface keeps its height and its top moves up by the rows SwiftTerm will
// drop from the top, in the same animation, so the text travels with the key bar and the top rows go under the
// container's top edge; when the keyboard goes down, the surface takes the final height outside the animation. The
// end of the slide (`keyboardDidShowNotification`, `keyboardDidHideNotification`) gives the surface the container's
// height: the grid shrinks only then, and the rows it drops are already out of sight. A quiet window of the size
// settler that ends during the hold waits for that end. Owner: terminal.

extension TerminalScreenViewController {
  /// The end of the keyboard's slide; called once from `viewDidLoad`.
  func observeKeyboardSlide() {
    let center = NotificationCenter.default
    for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidHideNotification] {
      center.addObserver(self, selector: #selector(keyboardSlideEnded(_:)), name: name, object: nil)
    }
  }

  /// Keyboard notifications come on the main thread.
  @objc nonisolated private func keyboardSlideEnded(_ note: Notification) {
    MainActor.assumeIsolated { self.endKeyboardSlide() }
  }

  /// The held surface takes the container's height, without animation: the grid changes now. The `rs` whose quiet
  /// ended during the hold goes after a new quiet, unless the grid change has just started its own.
  func endKeyboardSlide() {
    if keyboardSlide.release() {
      // The slide's move of the held surface may still run: the final frame stands at once (it shows the same rows).
      let layer = surface.view.layer
      for key in layer.animationKeys() ?? [] where key == "position" || key.hasPrefix("bounds") {
        layer.removeAnimation(forKey: key)
      }
      UIView.performWithoutAnimation {
        container.setNeedsLayout()
        container.layoutIfNeeded()
      }
    }
    resumeDeferredSettle()
  }

  /// The hold has ended (at the end of the slide or in a layout pass: the keyboard turned back, a hardware keyboard,
  /// rotation): the `rs` whose quiet fell inside it goes after a new quiet. A grid that did not change starts no quiet
  /// of its own, so without this a forced `rs` (focus) would be lost.
  private func resumeDeferredSettle() {
    guard keyboardSlide.hold == nil, let deferred = keyboardSlide.deferredSettle else { return }
    keyboardSlide.deferredSettle = nil
    settle(deferred)
  }

  /// The surface's frame for this layout pass of the container (`TerminalSurfaceContainer.layoutSubviews`).
  func placeSurface() {
    let surfaceView = surface.view
    let bounds = container.bounds
    let inset = Self.sideInset
    let width = max(0, bounds.width - 2 * inset)
    let pass = TerminalKeyboardSlide.Pass(
      container: bounds.size, surfaceHeight: surfaceView.bounds.height, keyboardUp: onScreenKeyboardUp,
      animated: UIView.inheritedAnimationDuration > 0,
      eligible: !hardwareKeyboard() && heldHeight == nil && surface.gridSize.rows > 0)
    switch keyboardSlide.place(pass, rise: rise(toHeight:)) {
    case .fill:
      surfaceView.frame = CGRect(x: inset, y: 0, width: width, height: bounds.height)
    case .fillAtOnce:
      UIView.performWithoutAnimation {
        surfaceView.frame = CGRect(x: inset, y: 0, width: width, height: bounds.height)
      }
    case let .held(top, height):
      surfaceView.frame = CGRect(x: inset, y: top, width: width, height: height)
    }
    resumeDeferredSettle()
  }

  /// The on-screen keyboard covers the bottom of the screen: the keyboard layout guide stands above the bottom of the
  /// safe area (with the keyboard away it stands on it).
  private var onScreenKeyboardUp: Bool {
    if let keyboardIsUp { return keyboardIsUp() }
    return view.keyboardLayoutGuide.layoutFrame.minY < view.safeAreaLayoutGuide.layoutFrame.maxY - 1
  }

  /// How far the content moves up when the grid shrinks to a view of `height`: the rows that leave the top times the
  /// cell height.
  private func rise(toHeight height: CGFloat) -> CGFloat {
    let rows = surface.gridSize.rows
    guard rows > 0 else { return 0 }
    let cell = surface.gridFrame.height / CGFloat(rows)
    guard cell > 0 else { return 0 }
    let fitting = max(0, Int(height / cell))
    return CGFloat(surface.rowsLeavingTop(shrinkingTo: fitting)) * cell
  }

  /// Edge bands of the held surface stop at the container: its rows above the top and below the key bar are
  /// out of sight. Outside the hold the bands stay as laid out.
  func clippedWhileHeld(_ bands: [TerminalEdgeBands.Band]) -> [TerminalEdgeBands.Band] {
    guard keyboardSlide.hold != nil else { return bands }
    let frame = container.convert(container.bounds, to: edgeFill)
    return bands.compactMap { band in
      let top = max(band.rect.minY, frame.minY)
      let bottom = min(band.rect.maxY, frame.maxY)
      guard bottom > top else { return nil }
      return TerminalEdgeBands.Band(
        rect: CGRect(x: band.rect.minX, y: top, width: band.rect.width, height: bottom - top), color: band.color)
    }
  }
}
#endif
