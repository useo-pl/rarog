import Foundation
@testable import RarogCore
import Testing

// The locked-phone trial switch: off on a new device, stored under its one key, and the background rule it changes.

@MainActor
@Suite("locked-phone trial switch")
struct LockedPhoneTrialTests {
  // Catches a switch that starts on (the microphone would keep running after the lock without the user's word) or
  // does not survive a new launch.
  @Test("off on a new device; on survives a new launch; off removes the key")
  func stored() {
    let scratch = ScratchDefaults()
    let trial = LockedPhoneTrial.live(defaults: scratch.defaults)
    #expect(!trial.on)
    trial.set(true)
    #expect(LockedPhoneTrial.live(defaults: scratch.defaults).on)
    trial.set(false)
    #expect(scratch.defaults.object(forKey: LockedPhoneTrial.key) == nil)
    #expect(!LockedPhoneTrial.live(defaults: scratch.defaults).on)
  }

  // Catches a rule that keeps a conversation in the background with the switch off, ends a running one with the
  // switch on, or keeps a start that has no open microphone yet (the app would open it in the background by itself).
  @Test(
    "the background keeps only a running conversation or dictation, and only with the switch on",
    arguments: [(false, false, false), (true, false, false), (false, true, false), (true, true, true)])
  func backgroundRule(running: Bool, on: Bool, keeps: Bool) {
    let trial = LockedPhoneTrial.memory()
    trial.set(on)
    #expect(trial.keeps(running: running) == keeps)
  }

  // Catches settings that read the switch from somewhere else than the device's defaults.
  @Test("the voice agent settings of the app carry the switch of the same defaults")
  func settings() {
    let scratch = ScratchDefaults()
    LockedPhoneTrial.live(defaults: scratch.defaults).set(true)
    #expect(VoiceAgentSettings.live(defaults: scratch.defaults).lockedPhoneTrial.on)
    #expect(!VoiceAgentSettings.memory().lockedPhoneTrial.on)
  }
}
