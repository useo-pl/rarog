import Foundation
import Observation
@testable import RarogCore
import Testing

// The rule that decides whether a running conversation or dictation survives the background: the tile on a phone,
// the screen lock on a device without tiles, and the inputs that change it.

@MainActor
@Suite("background recording rule")
struct BackgroundRecordingTests {
  // Catches a phone that keeps a recording without its tile (the microphone would run on unseen, on the user's
  // bill), ends one whose tile stands, keeps a start that has no open microphone yet, or lets the lock count there.
  @Test(
    "on a phone only a running recording with its tile shown is kept, locked or not",
    arguments: [
      (false, false, false), (true, false, false), (false, true, false), (true, true, true),
    ])
  func phone(tile: Bool, running: Bool, keeps: Bool) {
    let rule = BackgroundRecording()
    rule.tile(shown: tile)
    #expect(rule.keeps(running: running) == keeps)
    rule.screenLocked()
    #expect(rule.keeps(running: running) == keeps, "the lock changes nothing on a phone")
  }

  // Catches a device without tiles that ends a recording at an app switch, keeps one after the lock, keeps a start,
  // or lets a tile the system reported keep a recording past the lock.
  @Test("on a device without tiles a running recording is kept until the screen locks, whatever the tile says")
  func noTiles() {
    let rule = BackgroundRecording(noTiles: true)
    #expect(rule.keeps(running: true))
    #expect(!rule.keeps(running: false), "a start is never kept")
    rule.tile(shown: true)
    rule.screenLocked()
    #expect(!rule.keeps(running: true), "the lock ends it, also with a tile reported")
  }

  // Catches a lock forgotten at the `inactive` step of the lock itself (the recording would survive the lock), or
  // one remembered after the return (the next app switch would end the recording).
  @Test("the lock is forgotten only when the app is back in the foreground")
  func lockForgotten() {
    let rule = BackgroundRecording(noTiles: true)
    rule.screenLocked()
    rule.scene(.inactive)
    rule.scene(.background)
    #expect(!rule.keeps(running: true))
    rule.scene(.active)
    #expect(rule.keeps(running: true), "a later app switch keeps the recording again")
  }

  // Catches a rule whose call misses one of its inputs: a host that watches the rule while the app is in the
  // background would never learn the tile removed or the lock.
  @Test("a change of the tile or of the lock reaches whoever read the rule")
  func observed() {
    let phone = BackgroundRecording()
    phone.tile(shown: true)
    #expect(changes(phone) { phone.tile(shown: false) })
    let tablet = BackgroundRecording(noTiles: true)
    #expect(changes(tablet) { tablet.screenLocked() })
  }

  // Catches settings that give an iPad the phone's rule (a recording would end at every app switch there) or a new
  // device a tile it never showed.
  @Test("the app's settings carry the device class; a new rule has no tile and no lock")
  func settings() {
    let scratch = ScratchDefaults()
    #expect(VoiceAgentSettings.live(defaults: scratch.defaults, noTiles: true).background.noTiles)
    let phone = VoiceAgentSettings.live(defaults: scratch.defaults).background
    #expect(!phone.noTiles && !phone.tileShown && !phone.locked)
    #expect(!VoiceAgentSettings.memory().background.noTiles)
  }

  /// Whether `change` reaches an observation scope that called the rule once.
  private func changes(_ rule: BackgroundRecording, _ change: () -> Void) -> Bool {
    let fired = Fired()
    withObservationTracking {
      _ = rule.keeps(running: true)
    } onChange: {
      fired.value = true
    }
    change()
    return fired.value
  }
}

private final class Fired: @unchecked Sendable {
  var value = false
}
