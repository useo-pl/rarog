import Foundation
@testable import RarogUI
import Testing

// The background rule of the end check of a voice conversation (`VoiceAgentWatch`): the background refuses every
// start, and it ends a started conversation unless the host says the background keeps it (the background rule keeps
// it and the conversation is past its readiness gate). The other end reasons: `VoiceAgentSessionTests`.
// Owner: voice agent.

private func input(background: Bool, keeps: Bool) -> VoiceAgentWatch.Input {
  VoiceAgentWatch.Input(
    loggedIn: true, login: 1, enabled: true, selected: "s1", background: background, keepsInBackground: keeps,
    epoch: nil, boundary: nil)
}

@Suite("voice conversation end check: the background and the host's keep")
struct VoiceAgentWatchTests {
  // Catches a start check that lets the host keep a start in the background: the app would open the microphone
  // there without the user's tap in the foreground.
  @Test("the start check refuses the background whatever the host says", arguments: [false, true])
  func startRefusedInBackground(keeps: Bool) {
    var watch = VoiceAgentWatch(sessionId: "s1", start: input(background: true, keeps: keeps))
    #expect(watch.check(input(background: true, keeps: keeps)) == .background)
  }

  // Catches a gate that ends a kept conversation (its tile would do nothing), keeps one the host does not keep (no
  // tile, or a conversation still connecting), or stays latched after the host stops keeping it.
  @Test("after the start the background ends the conversation unless the host keeps it")
  func startedConversation() {
    var watch = VoiceAgentWatch(sessionId: "s1", start: input(background: false, keeps: false))
    #expect(watch.check(input(background: false, keeps: false)) == nil, "the start check passes")
    #expect(watch.check(input(background: true, keeps: true)) == nil, "kept in the background")
    #expect(watch.check(input(background: false, keeps: true)) == nil, "back in the foreground")
    #expect(watch.check(input(background: true, keeps: false)) == .background, "not kept: it ends")
  }
}
