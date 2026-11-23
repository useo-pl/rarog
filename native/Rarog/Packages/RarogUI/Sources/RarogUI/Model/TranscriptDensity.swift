import Foundation
import Observation

// How much space the transcript puts around its elements on this device: standard (the default) or relaxed, whose
// tokens stand in `TranscriptSpacing`. A device preference in `UserDefaults`, set on the Text Size page; the session
// screen renders its cells and lays out its list again when it changes (`TranscriptDensity.follow`). Owner: transcript.

@MainActor
@Observable
public final class TranscriptDensity {
  /// The `UserDefaults` key of the stored mode; no entry means standard.
  public nonisolated static let key = "rarog.transcriptDensity"

  public static let shared = TranscriptDensity(defaults: .standard)

  public private(set) var mode: TranscriptDensityMode
  @ObservationIgnored private let defaults: UserDefaults

  /// An unknown stored value reads as standard.
  public init(defaults: UserDefaults) {
    self.defaults = defaults
    mode = defaults.string(forKey: Self.key).flatMap(TranscriptDensityMode.init(rawValue:)) ?? .standard
  }

  /// The spacing tokens of the stored mode.
  public var spacing: TranscriptSpacing { mode.spacing }

  /// Stores the mode; standard, the default, removes the entry.
  public func choose(_ mode: TranscriptDensityMode) {
    guard mode != self.mode else { return }
    self.mode = mode
    if mode == .standard {
      defaults.removeObject(forKey: Self.key)
    } else {
      defaults.set(mode.rawValue, forKey: Self.key)
    }
  }

  /// Calls `action` after every change of the mode, for as long as `owner` lives; not at registration. Observation
  /// reports a change before the new value is set, so `action` runs on the next turn of the main actor.
  public static func follow(
    _ owner: AnyObject, density: TranscriptDensity = .shared, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    track(WeakOwner(owner), density: density, action)
  }

  private static func track(
    _ box: WeakOwner, density: TranscriptDensity, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    withObservationTracking {
      _ = density.mode
    } onChange: {
      Task { @MainActor in
        guard box.alive else { return }
        track(box, density: density, action)
        action()
      }
    }
  }
}
