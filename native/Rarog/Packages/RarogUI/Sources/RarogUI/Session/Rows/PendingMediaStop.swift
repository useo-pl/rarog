#if os(iOS)
import SwiftUI
import UIKit

// The stop in the center of the progress ring on a thumbnail of an entry in flight, as the App Store
// download: the square is drawn by `PendingRing`, the touch target is a UIKit button over it. The dimming above the
// thumbnail does not take touches (`PendingOverlay`), the button does, and only where it stands. VoiceOver gets the
// action "Cancel sending" on the thumbnail itself (`PendingMediaRowView`), so the button stays out of its tree.
// Owner: send, an exception in `Rows/` because it is outbox state.

/// The touch target of the stop: a UIKit control, so it takes the touch under views that do not, inside a hosting
/// configuration cell too, and a test can find it and hit-test it in the window.
final class PendingStopButton: UIButton {
  static let identifier = "pending.stop"
  /// The minimum target of a touch control (Apple HIG), whatever the size of the drawn square.
  static let side: CGFloat = 44

  var action: () -> Void = {}

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = false
    accessibilityIdentifier = Self.identifier
    addAction(UIAction { [weak self] _ in self?.action() }, for: .touchUpInside)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) unused") }
}

/// `PendingStopButton` in a SwiftUI view; the caller centers it over the ring.
struct PendingStopTarget: UIViewRepresentable {
  let action: () -> Void

  func makeUIView(context: Context) -> PendingStopButton {
    PendingStopButton(frame: .zero)
  }

  func updateUIView(_ button: PendingStopButton, context: Context) {
    button.action = action
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: PendingStopButton, context: Context) -> CGSize? {
    CGSize(width: PendingStopButton.side, height: PendingStopButton.side)
  }
}

extension View {
  /// The stop target over the center of this view, while the send of the entry is in flight and a stop is wired.
  func pendingStop(_ indicator: PendingIndicator, _ stop: (() -> Void)?) -> some View {
    overlay {
      if indicator.stoppable, let stop { PendingStopTarget(action: stop) }
    }
  }

  /// The VoiceOver action "Cancel sending" on a thumbnail of an entry in flight.
  func pendingStopAction(_ indicator: PendingIndicator, _ stop: (() -> Void)?) -> some View {
    accessibilityActions {
      if indicator.stoppable, let stop { Button(UICopy.cancelSend, action: stop) }
    }
  }
}
#endif
