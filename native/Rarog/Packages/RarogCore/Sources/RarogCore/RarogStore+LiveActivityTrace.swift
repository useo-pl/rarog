import Foundation
import RarogContract

// Live Activity arrival traces in `client.log`: the moment the app leaves the background (the same moment it sends
// presence) and every content the system hands the app for its activity (`contentUpdates`), each with the device clock
// in the line. The `at` field of a `client.log` entry is the time its batch was sent, and after a return the batch
// waits for the list stream to come back, so `at` alone hides the gap this trace measures. Together with the server's
// `live-activity: done chime → …, updatedEpoch N` line they tell whether a chime landed while the app was already in
// the foreground. The app sees the content, never the sound. Owner: Live Activity.

/// Lines of the Live Activity arrival traces.
enum LiveActivityTrace {
  /// "live-activity: foreground at 2026-11-25T20:10:01.234Z (scene inactive), tile updatedEpoch 1795000000" — the
  /// tile part says what the system already shows, so a chime that arrived before the return is visible even when no
  /// content line follows.
  static func foreground(at: Date, scene: ScenePhase, tileEpoch: Int?) -> String {
    let tile = tileEpoch.map { "tile updatedEpoch \($0)" } ?? "no tile"
    return "live-activity: foreground at \(stamp(at)) (scene \(word(scene))), \(tile)"
  }

  /// "live-activity: content updatedEpoch 1795000000 at 2026-11-25T20:10:01.534Z, scene active, 300 ms after
  /// foreground". The milliseconds stay as they come out (negative after a clock set back).
  static func content(updatedEpoch: Int, at: Date, scene: ScenePhase, foregroundAt: Date?) -> String {
    let since = foregroundAt.map { "\(Int((at.timeIntervalSince($0) * 1000).rounded())) ms after foreground" }
      ?? "no return from the background yet"
    return "live-activity: content updatedEpoch \(updatedEpoch) at \(stamp(at)), scene \(word(scene)), \(since)"
  }

  /// Device time in UTC with milliseconds, in the form of the `server.log` prefix.
  private static func stamp(_ date: Date) -> String { ISOTime.string(date) + "Z" }

  private static func word(_ scene: ScenePhase) -> String {
    switch scene {
    case .active: "active"
    case .inactive: "inactive"
    case .background: "background"
    }
  }
}

extension RarogStore {
  /// The scene left the background: remember the moment and write it with the content the tile shows now. Only with
  /// the Live Activity system attached (the app), so stores of other areas write nothing.
  func traceLiveActivityForeground(scene: ScenePhase) {
    guard let system = liveRuntime.system else { return }
    let now = areaNow
    liveRuntime.foregroundAt = now
    let tileEpoch = liveRuntime.activityId.flatMap { system.displayedContent($0)?.state.updatedEpoch }
    trace(LiveActivityTrace.foreground(at: now, scene: scene, tileEpoch: tileEpoch), budget: .foreground)
  }

  /// A content of this process's activity arrived from the system. A counter write of the app keeps the push's
  /// `updatedEpoch`, so if the system reports such writes too, the first line with a given number is still the push
  /// arriving and a later one an echo.
  func traceLiveActivityContent(_ state: LiveActivityContentState) {
    let line = LiveActivityTrace.content(
      updatedEpoch: state.updatedEpoch, at: areaNow, scene: areaPhase, foregroundAt: liveRuntime.foregroundAt)
    trace(line, budget: .liveActivityContent)
  }
}
