import Foundation
import Observation

// How wide the agent's prose runs in the transcript on this device: readable (a line ends at the density's measure,
// `TranscriptSpacing.readableEm`, from the content's edge; the default) or the whole column. A device preference in
// `UserDefaults`, set on the Text Size page; the session screen renders its cells again when it changes
// (`TranscriptWidth.follow`). The prompt bubble keeps its own cap in both modes. Owner: transcript.

/// The transcript width mode; the raw value is what `UserDefaults` stores.
public enum TranscriptWidthMode: String, CaseIterable, Sendable {
  case readable, full
}

@MainActor
@Observable
public final class TranscriptWidth {
  /// The `UserDefaults` key of the stored mode; no entry means readable.
  public nonisolated static let key = "rarog.transcriptWidth"

  public static let shared = TranscriptWidth(defaults: .standard)

  public private(set) var mode: TranscriptWidthMode
  @ObservationIgnored private let defaults: UserDefaults

  /// An unknown stored value reads as readable.
  public init(defaults: UserDefaults) {
    self.defaults = defaults
    mode = defaults.string(forKey: Self.key).flatMap(TranscriptWidthMode.init(rawValue:)) ?? .readable
  }

  /// The agent's prose runs across the whole column.
  public var full: Bool { mode == .full }

  /// Stores the mode; readable, the default, removes the entry.
  public func choose(_ mode: TranscriptWidthMode) {
    guard mode != self.mode else { return }
    self.mode = mode
    if mode == .readable {
      defaults.removeObject(forKey: Self.key)
    } else {
      defaults.set(mode.rawValue, forKey: Self.key)
    }
  }

  /// Calls `action` after every change of the mode, for as long as `owner` lives; not at registration. Observation
  /// reports a change before the new value is set, so `action` runs on the next turn of the main actor.
  public static func follow(
    _ owner: AnyObject, width: TranscriptWidth = .shared, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    track(WeakOwner(owner), width: width, action)
  }

  private static func track(
    _ box: WeakOwner, width: TranscriptWidth, _ action: @escaping @MainActor @Sendable () -> Void
  ) {
    withObservationTracking {
      _ = width.mode
    } onChange: {
      Task { @MainActor in
        guard box.alive else { return }
        track(box, width: width, action)
        action()
      }
    }
  }
}
