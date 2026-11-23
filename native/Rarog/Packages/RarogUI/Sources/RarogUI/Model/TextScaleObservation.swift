import Observation

// UIKit code sets its fonts again when the app's text size changes. On the flat path (the iPad app on a Mac) the
// system sends no trait change, so views follow the model (`TextScale.effective`) instead; on the standard path the
// same call keeps working next to the trait change. Owner: text size.

@MainActor
public enum TextScaleObservation {
  /// Calls `action` after every change of `scale.effective`, for as long as `owner` lives; not at registration.
  /// Observation reports a change before the new value is set, so `action` runs on the next turn of the main actor
  /// and reads the new value.
  ///
  ///     TextScaleObservation.follow(self) { [weak self] in self?.applyFonts() }
  public static func follow(
    _ owner: AnyObject, scale: TextScale = .shared, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    let box = WeakOwner(owner)
    track(box, scale: scale, action)
  }

  private static func track(
    _ box: WeakOwner, scale: TextScale, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    withObservationTracking {
      _ = scale.effective
    } onChange: {
      Task { @MainActor in
        guard box.alive else { return }
        track(box, scale: scale, action)
        action()
      }
    }
  }
}

/// The owner, held weakly across the observation's re-registrations (also `TranscriptWidth.follow`).
final class WeakOwner: @unchecked Sendable {
  weak var value: AnyObject?
  init(_ value: AnyObject) { self.value = value }
  var alive: Bool { value != nil }
}
