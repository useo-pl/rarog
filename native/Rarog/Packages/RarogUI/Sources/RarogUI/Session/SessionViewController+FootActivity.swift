#if os(iOS)
import UIKit

// Where the activity row stands: the first line of the field card while the field shows, a narrow
// card of its own at the top of the foot while the field hides (`FootActivityCard`). Called after every foot change
// (`renderStateCard`). The row's band in the field card opens for a turn and closes after it (`placeActivityBand`).
// Owner: transcript.
extension SessionViewController {
  /// The row follows the field: in its card, or alone above the dock, the state card or the empty foot. The row's
  /// clock and sentences follow its actual visibility (`ActivityRowView.visibilityChanged`).
  func placeActivityRow() {
    let inField = !composer.isHidden
    var moved = false
    if inField, activityRow.superview !== composer.activitySlot {
      composer.installActivity(activityRow)
      moved = true
    } else if !inField, !activityRow.isDescendant(of: activityCard) {
      activityCard.install(activityRow)
      moved = true
    }
    if activityCard.isHidden != inField {
      activityCard.isHidden = inField
      moved = true
    }
    let rests = decisionSlot.isHidden && stateCardSlot.isHidden
    if activityCard.restsOnFoot != rests { activityCard.restsOnFoot = rests }
    if moved { activityRow.visibilityChanged() }
    placeActivityBand()
  }

  /// The field card's activity band (`ActivityBand`): open from the start of a turn to its end, closed while idle. The
  /// card grows and shrinks upwards over 0.2 s (none with Reduce Motion or off screen); the transcript's bottom inset
  /// follows the foot in the same layout pass (`placeTranscriptInset`), and a pinned transcript stays at the bottom.
  func placeActivityBand() {
    let open = ActivityBand.isOpen(
      rowHasContent: activityRow.hasContent, session: store.state.sessions[sessionId]?.state)
    guard composer.activityBandOpen != open else { return }
    let animated = view.window != nil && !composer.isHidden && !UIAccessibility.isReduceMotionEnabled
    if animated { view.layoutIfNeeded() }
    composer.activityBandOpen = open
    guard animated else { return }
    UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) {
      self.view.layoutIfNeeded()
    }
  }
}
#endif
