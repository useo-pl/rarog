import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The length limit of a voice conversation: one timer of `VoiceAgentSession` on the conversation's clock ends it
// `VoiceAgentSession.sessionLimit` seconds after the tap, whatever happens in between, with one end line in
// `client.log`. The end at each host: `VoiceAgentSessionsConversationTests`, `VoiceAgentInboxTests`,
// `VoiceAgentRowTests`. Fakes: `FakeVoiceAgentBackend`, `VoiceAgentFakeDevice`. Owner: voice agent.

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// A conversation at session `id-a` on `device`, as the session screen builds it.
@MainActor
private func conversation(_ backend: FakeVoiceAgentBackend, on device: VoiceAgentFakeDevice) -> VoiceAgentSession {
  backend.state = appState([session("id-a", label: "Alpha")], sessionsMode: false)
  let host = VoiceAgentSessionHost(sessionId: "id-a", backend: backend)
  host.watchInput = { [unowned backend] in
    VoiceAgentWatch.Input(
      state: backend.state, sessionId: "id-a", login: backend.loginEpoch, enabled: true, sonioxAllowed: true,
      selected: "id-a", background: false)
  }
  return VoiceAgentSession(host: host, backend: backend, dependencies: { device.dependencies($0) })
}

@MainActor
private func endLines(_ backend: FakeVoiceAgentBackend) -> [String] {
  backend.traces.filter { $0.hasPrefix("voice-agent: ended") }
}

extension VoiceAgentSessionTests {
  // Catches a conversation that runs on with an open microphone and a paid connection for as long as nobody ends it.
  @Test("the limit after the tap ends a conversation that changes nothing: session-limit, one end line, its sentence")
  func sessionLimitEnds() async {
    let backend = FakeVoiceAgentBackend()
    let device = VoiceAgentFakeDevice()
    let session = conversation(backend, on: device)
    session.start()
    await device.ready(session)
    device.scheduler.advance(VoiceAgentSession.sessionLimit - 1)
    #expect(session.phase == .listening)
    device.scheduler.advance(1)
    #expect(session.phase == .ended(.sessionLimit) && session.indicator == .ended(.sessionLimit))
    #expect(device.socket.closed && device.audio.stops > 0)
    let ends = endLines(backend)
    #expect(ends.count == 1)
    #expect(ends.first?.hasPrefix("voice-agent: ended session-limit after 1200.0 s") == true, "\(ends)")
    // The sentence names the limit the timer counts.
    #expect(UICopy.voiceAgentEnd(.sessionLimit).contains("\(Int(VoiceAgentSession.sessionLimit / 60))"))
  }

  // Catches the timer of an ended conversation that ends the next one, started on the same session at once.
  @Test("ended by hand at 1199 s and started again at once: the old timer leaves the new one, which gets its own")
  func sessionLimitRestart() async {
    let backend = FakeVoiceAgentBackend()
    let device = VoiceAgentFakeDevice()
    let session = conversation(backend, on: device)
    session.start()
    await device.ready(session)
    device.scheduler.advance(VoiceAgentSession.sessionLimit - 1)
    session.end()
    session.start()
    await device.ready(session, socketsBefore: 1)
    device.scheduler.advance(1)
    #expect(session.phase == .listening, "the first conversation's limit passed")
    device.scheduler.advance(VoiceAgentSession.sessionLimit - 2)
    #expect(session.phase == .listening)
    device.scheduler.advance(1)
    #expect(session.phase == .ended(.sessionLimit))
    #expect(endLines(backend).map { $0.split(separator: " ").prefix(3).joined(separator: " ") }
      == ["voice-agent: ended closed", "voice-agent: ended session-limit"])
  }

  // Catches a limit that a repeated start renews (or drops) while the conversation runs.
  @Test("a start while the conversation runs does not move its end")
  func sessionLimitSecondStart() async {
    let backend = FakeVoiceAgentBackend()
    let device = VoiceAgentFakeDevice()
    let session = conversation(backend, on: device)
    session.start()
    await device.ready(session)
    device.scheduler.advance(600)
    session.start()
    #expect(session.phase == .listening && device.sockets.count == 1, "the running conversation goes on")
    device.scheduler.advance(VoiceAgentSession.sessionLimit - 600)
    #expect(session.phase == .ended(.sessionLimit))
  }

  // Catches a limit that counts from the last activity instead of the tap: a muted microphone or a long answer would
  // keep the conversation going.
  @Test("a mute and an answer that plays do not move the end: it comes 1200 s after the tap, mid-answer")
  func sessionLimitThroughMuteAndAnswer() async throws {
    let backend = FakeVoiceAgentBackend()
    let device = VoiceAgentFakeDevice()
    let session = conversation(backend, on: device)
    session.start()
    await device.ready(session)
    device.scheduler.advance(300)
    session.toggleMute()
    #expect(session.muted)
    device.scheduler.advance(300)
    session.toggleMute()
    device.utterance("in1")
    device.socket.reply(RealtimeSample.created("r1"))
    device.say("r1", item: "m1", pcm: Data(count: 48_000))
    #expect(await eventually { session.phase == .speaking })
    device.scheduler.advance(VoiceAgentSession.sessionLimit - 601)
    #expect(session.isActive)
    device.scheduler.advance(1)
    #expect(session.phase == .ended(.sessionLimit))
  }
}
