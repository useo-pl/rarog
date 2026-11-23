import Foundation
@testable import RarogUI
import Testing

// The Soniox reading speed of the device setting reaches the speech key of the conversation: the screen passes
// `store.voiceAgent.speechSpeed` to `VoiceAgentSession` at the start, the session gives it to `VoiceAgentKeys`, and
// `speechKey()` puts it in the config whose start frame carries `speed` (`SonioxSpeechTests`). Owner: voice agent.

extension VoiceAgentSessionTests {
  @Test("the reading speed set on the session reaches the Soniox config speechKey() returns; 1.0 without one")
  func speechSpeedReachesKey() async throws {
    let backend = FakeVoiceAgentBackend()
    var caught: [VoiceAgentKeys] = []
    let dependencies: (VoiceAgentKeys) -> RealtimeConversation.Dependencies = { keys in
      caught.append(keys)
      return RealtimeConversation.Dependencies(
        keys: keys, socket: { request, events in RealtimeFakeSocket(request: request, events: events) },
        audio: RealtimeFakeAudio(), scheduler: ManualScheduler(),
        speech: RealtimeConversation.Speech(
          keys: keys, socket: { url, protocols, events in MockSocket(url: url, protocols: protocols, events: events) }))
    }
    let faster = VoiceAgentSession(
      host: VoiceAgentSessionHost(sessionId: "s1", backend: backend), speechSpeed: 1.2, backend: backend,
      dependencies: dependencies)
    let normal = VoiceAgentSession(
      host: VoiceAgentSessionHost(sessionId: "s1", backend: backend), backend: backend, dependencies: dependencies)
    #expect(caught.count == 2)
    let fasterConfig = try await caught[0].speechKey()
    #expect(fasterConfig.speed == 1.2 && fasterConfig.voice == "Maya")
    #expect(try await caught[1].speechKey().speed == 1.0)
    withExtendedLifetime((faster, normal)) {}
  }
}
