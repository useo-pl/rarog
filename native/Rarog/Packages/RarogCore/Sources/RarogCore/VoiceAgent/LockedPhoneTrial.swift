import Foundation
import Observation

// The locked-phone trial switch of this device. Owner: voice agent.
//
// Off by default. While it is off the app keeps its rules for the background: a voice conversation and a dictation
// end when the app leaves the foreground, and the server connection closes after its grace. While it is on, a
// conversation or a message-field dictation the user started, whose microphone already records, keeps running when
// the phone locks, until it ends by any other rule (``LockedPhoneTrial/keeps(running:)``, the one rule). The switch
// belongs to the device: logout, Forget Server and a new server do not clear it. The one key is
// ``LockedPhoneTrial/key``; the Voice Agent settings page shows it.

/// The locked-phone trial switch, stored under one key (`UserDefaults` of the app or memory in tests).
@MainActor
@Observable
public final class LockedPhoneTrial {
  /// The only key of the switch. A constant, so code off the main actor reads it too (the UI test reset).
  public nonisolated static let key = "rarog.voiceAgent.lockedPhoneTrial"

  /// `nil` = memory (tests and the UI test mode).
  @ObservationIgnored private let defaults: UserDefaults?
  /// The trial is on on this device.
  public private(set) var on: Bool

  private init(defaults: UserDefaults?) {
    self.defaults = defaults
    on = defaults?.bool(forKey: Self.key) ?? false
  }

  /// The app: the switch in `UserDefaults`.
  public static func live(defaults: UserDefaults) -> LockedPhoneTrial {
    LockedPhoneTrial(defaults: defaults)
  }

  /// Tests and the UI test mode: the switch in memory, off.
  public static func memory() -> LockedPhoneTrial {
    LockedPhoneTrial(defaults: nil)
  }

  public func set(_ on: Bool) {
    self.on = on
    guard let defaults else { return }
    if on { defaults.set(true, forKey: Self.key) } else { defaults.removeObject(forKey: Self.key) }
  }

  /// Whether the app in the background keeps a voice conversation or a dictation instead of ending it: only with the
  /// trial on, and only one that `runs` (its microphone already records: a conversation past its readiness gate, a
  /// dictation whose microphone opened). A start or a recording still preparing ends as with the trial off, so
  /// nothing opens the microphone while the app is in the background.
  public func keeps(running: Bool) -> Bool {
    on && running
  }
}
