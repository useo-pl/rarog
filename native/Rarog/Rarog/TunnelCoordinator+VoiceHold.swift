import Foundation
import RarogTransport

// The server connection held for a voice conversation or a dictation that the background rule keeps running
// (`LockedPhoneMonitor` in RarogUI asks for it). Owner: connectivity.
//
// The hold is one background work with `needsServer` and a reserved identifier, outside the system's background
// tasks, so no system expiry ends it: only the release does. While it lives, the machine keeps the generation as it
// keeps one for any background work (`TunnelMachine` state `backgroundWork`), and in the background a request may
// open a new generation within the attempt budget. What the release does is the machine's grace rule
// (`TunnelCoordinatorTests`, the voice hold cases):
// - in the foreground the hold changes nothing: the same generation stays ready, before and after the release;
// - released in the background before the grace of that stay ends (8 s from entering the background), the
//   generation goes back to that grace and closes at its deadline;
// - released after the grace deadline, or after the system expired the tunnel's grace task during the hold (the
//   stay has no grace left then), the generation closes at once;
// - after every release the coordinator and the machine have no work left, and the tunnel's grace task ends once.

extension TunnelCoordinator {
  /// The hold's work identifier. `UIKitBackgroundWork` builds every other work identifier from the system's task
  /// identifier, an `Int`, so those are at most `Int.max`, below this value.
  nonisolated static let voiceHoldWork = TunnelMachine.WorkID(UInt64.max)
  /// The hold's deadline only bounds the budget of an attempt to open a generation in the background (the attempt
  /// budget is the shorter one); the release ends the hold, not this time.
  nonisolated static let voiceHoldAllowance: Duration = .seconds(24 * 3600)

  /// Hold the server connection for a running voice conversation or dictation (`true`), or let it go (`false`).
  /// Calling it again with the same value changes nothing.
  func holdForVoice(_ on: Bool) {
    if on {
      guard !liveWorks.contains(Self.voiceHoldWork) else { return }
      workStarted(Self.voiceHoldWork, expiresAt: timing.now() + Self.voiceHoldAllowance)
    } else {
      workFinished(Self.voiceHoldWork)
    }
  }
}
