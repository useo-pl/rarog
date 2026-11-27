import Foundation
import Observation

// Whether a recording the user started keeps running while the app is out of the foreground. Owner: voice agent.
//
// The one rule is ``BackgroundRecording/keeps(running:)``: a voice conversation or a message-field dictation whose
// microphone already records keeps running in the background while its voice Live Activity tile stands, or, on a
// device that shows no tiles (an iPad, the app on a Mac), until the screen locks. Without the tile on a phone (Live
// Activities off, a limit, an error, the tile removed) the background ends it, so a recording never runs on unseen.
// A start or a recording still preparing ends in the background whatever the rule says, so nothing opens the
// microphone there. The inputs come from outside: the device class from the app target at launch, the tile from the
// voice activity controller, the lock from the system's protected-data signal, and the scene from the app.

/// The state that decides whether a running recording survives the background, and its one rule.
@MainActor
@Observable
public final class BackgroundRecording {
  /// The device shows no Live Activity tiles (an iPad, the app on a Mac): the screen lock ends a recording there.
  public let noTiles: Bool
  /// The voice Live Activity tile of the running recording stands on this device.
  public private(set) var tileShown = false
  /// The screen locked since the app last came to the foreground.
  public private(set) var locked = false

  public init(noTiles: Bool = false) {
    self.noTiles = noTiles
  }

  /// The voice activity controller: the running recording's tile went up (`true`), or it was refused, ended or
  /// removed (`false`).
  public func tile(shown: Bool) {
    guard shown != tileShown else { return }
    tileShown = shown
  }

  /// The system's signal that protected data becomes unavailable: the screen locked (only with a passcode set).
  public func screenLocked() {
    guard !locked else { return }
    locked = true
  }

  /// The app's scene phase: back in the foreground (`active`) the lock is forgotten. `inactive` and `background`
  /// change nothing, so the lock's own `inactive` step keeps it.
  public func scene(_ phase: ScenePhase) {
    guard phase == .active, locked else { return }
    locked = false
  }

  /// Whether the app in the background keeps a voice conversation or a dictation that `running` (its microphone
  /// already records: a conversation past its readiness gate, a dictation whose microphone opened) instead of ending
  /// it. On a device without tiles the tile never counts, so the lock ends what records there. Both stored inputs are
  /// read on every call, so a caller inside an observation scope learns a change of either.
  public func keeps(running: Bool) -> Bool {
    let shown = tileShown && !noTiles
    let unlocked = !locked
    return (shown || (noTiles && unlocked)) && running
  }
}
