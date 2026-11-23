#if os(iOS)
import UIKit

// A queued bubble (and a Not confirmed one while a take-back without an answer is kept) takes the queue back into the
// message field: a tap anywhere on the bubble except its controls ("Show all", a code block's copy icon), and a
// VoiceOver action on the text. While the take-back waits for the answer the bubble dims further. Owner: send.
extension MessageContentView: UIGestureRecognizerDelegate {
  func buildTakeBack() {
    takeBackTap.addTarget(self, action: #selector(takeBackTapped(_:)))
    takeBackTap.delegate = self
    takeBackTap.isEnabled = false
    addGestureRecognizer(takeBackTap)
  }

  /// The row's opacity: a queue entry is dimmed, and dimmed further while its queue is being taken back, so the
  /// gesture shows at once although the server answers only after a second or more. The shimmer lies in the bubble,
  /// so it fades with it; its own band and timing do not change.
  static func alpha(dimmed: Bool, takingBack: Bool) -> CGFloat {
    takingBack ? 0.3 : dimmed ? 0.55 : 1
  }

  func applyTakeBack(_ on: Bool) {
    takeBackTap.isEnabled = on
    guard on else {
      textView.accessibilityCustomActions = nil
      return
    }
    let action = UIAccessibilityCustomAction(name: UICopy.queuedTakeBackAction) { [weak self] _ in
      guard let takeBack = self?.current.takeBack else { return false }
      takeBack()
      return true
    }
    textView.accessibilityCustomActions = [action]
  }

  /// Whether a tap at `point` (in this view) takes the queue back: on the bubble, not on one of its controls.
  func takesBackTap(at point: CGPoint) -> Bool {
    guard current.takeBack != nil, !plateView.isHidden, plateView.frame.contains(point) else { return false }
    let controls: [UIView] = [foldButton] + codeButtons
    return !controls.contains { !$0.isHidden && $0.frame.contains(point) }
  }

  /// The tap's decision and action by point, without a touch event (the tap recognizer and tests).
  func takeBackTap(at point: CGPoint) {
    guard takesBackTap(at: point) else { return }
    current.takeBack?()
  }

  @objc private func takeBackTapped(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    takeBackTap(at: recognizer.location(in: self))
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard gestureRecognizer === takeBackTap else { return true }
    return takesBackTap(at: touch.location(in: self))
  }

  /// The selectable text keeps its own taps (clearing a selection): the take-back tap recognizes alongside them.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    gestureRecognizer === takeBackTap
  }
}
#endif
