import Foundation
@testable import RarogUI
import Testing

// Playback and barge-in of the voice agent conversation (`RealtimeConversation+Playback.swift`): time to first
// audio, speech over the answer and an engine restart cut playback to what the user heard, with no
// `conversation.item.truncate` (a text item has no audio to cut; the fixes: `RealtimeConversationTests+Speech.swift`).
// The answer audio is Soniox PCM (`RealtimeHarness.say`). Fakes and samples: `RealtimeConversationTests.swift`.
// Owner: voice agent.

private typealias Harness = RealtimeHarness
private let speechStarted = RealtimeSample.speechStarted
private let speechStopped = RealtimeSample.speechStopped
private func committed() -> String { RealtimeSample.committed() }
private func created(_ id: String) -> String { RealtimeSample.created(id) }
private func done(_ id: String) -> String { RealtimeSample.done(id) }

@MainActor
@Suite("voice conversation: playback and barge-in")
struct RealtimePlaybackTests {
  @Test("czas do początku odtwarzania: od końca mowy do startu dźwięku, zdarzenie bez treści")
  func firstAudioDiagnostic() async throws {
    let h = Harness()
    await h.ready()
    h.socket.reply(speechStarted)
    h.socket.reply(speechStopped)
    h.scheduler.advance(0.6)
    h.socket.reply(committed())
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    h.scheduler.advance(0.7)
    try #require(h.audio.handlers).playbackStarted(0.1)
    #expect(h.diagnostics.contains(.firstAudio(milliseconds: 1400)))
    #expect(RealtimeConversation.Diagnostic.firstAudio(milliseconds: 1400).traceLine == "voice-agent: first audio 1400 ms")
  }

  @Test("speech while it speaks → playback cleared, no truncate, late Soniox audio of the answer dropped")
  func bargeIn() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 96_000))
    #expect(h.conversation.phase == .speaking)
    // The user heard 1.5 s of 2 s.
    h.audio.playedSamples = 36_000
    h.speechStarts()
    #expect(h.audio.clears == 1)
    #expect(h.audio.queued.isEmpty)
    #expect(h.socket.sent("conversation.item.truncate").isEmpty)
    h.say("r1", item: "m1", pcm: Data(count: 9600))
    #expect(h.audio.queued.isEmpty)
    #expect(h.conversation.phase == .listening)
  }

  @Test("engine restart while it speaks → no truncate, late audio dropped, the next answer starts at the restart")
  func restartLosesPlayback() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 96_000))
    // The user heard 0.5 s of 2 s, then the engine started again and the queue was lost.
    h.audio.playedSamples = 12_000
    try #require(h.audio.handlers).restarted("engine configuration change", true)
    #expect(h.audio.clears == 1)
    #expect(h.socket.sent("conversation.item.truncate").isEmpty)
    h.say("r1", item: "m1", pcm: Data(count: 9600))
    #expect(h.audio.queued.isEmpty)
    // r1 lasts at the server until `response.done`; then the conversation listens.
    h.socket.reply(done("r1"))
    #expect(h.conversation.phase == .listening)
    // The cancelled stream frees Soniox's slot; the next answer lies on the axis from the restart on.
    let first = try #require(h.streamOf["m1"])
    h.speechSocket.reply(SpeechSample.terminated(first))
    h.utterance()
    h.socket.reply(created("r2"))
    h.say("r2", item: "m2", pcm: Data(count: 48_000))
    #expect(h.conversation.items["m2"]?.start == 12_000)
    #expect(h.audio.queuedSamples == 24_000)
  }
}
