import Foundation
@testable import RarogUI
import Testing

// The mark of a tool's reading on the input audio axis (`RealtimeConversation+Reading.swift`): only the reading
// started last in the run places it. Fakes: `RealtimeHarness` with the reading probe and the helpers of
// `RealtimeConversationTests+Reading.swift`. Owner: voice agent.

private typealias Harness = RealtimeHarness

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

extension RealtimeConversationTests {
  @Test(
    "of two readings the older one played out whole places no mark; the newer one not read or cut leaves none",
    arguments: ["no-audio", "stream-limit", "cut"])
  func olderReadingPlacesNoMark(_ ending: String) async throws {
    // Bug caught: the user's word after the first of two readings opens a send for the second, which they never
    // heard whole.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "read_probe"))
    h.socket.reply(RealtimeSample.call("r1", id: "c2", name: "read_probe"))
    h.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { probe.turns.count == 2 })
    let older = try #require(SpeechSample.streams(h.speechSocket).last)
    try h.input(milliseconds: 1000)
    h.speechSocket.reply(SpeechSample.audio(older, Data(count: 9600)))
    h.speechSocket.reply(SpeechSample.terminated(older))
    let newer = try #require(SpeechSample.streams(h.speechSocket).last)
    #expect(newer != older, "the newer reading's stream starts after the older one's")
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes == [.whole], "the older reading played out whole while the newer one runs")
    #expect(h.diagnostics.contains(.reading(.whole(marks: false))), "it places no mark")
    switch ending {
    case "no-audio":
      h.speechSocket.reply(SpeechSample.terminated(newer))
      h.answered("r1f")
    case "stream-limit":
      h.speechSocket.reply(SpeechSample.audio(newer, Data(count: 4800)))
      h.speechSocket.reply(
        SpeechSample.encoded(["stream_id": newer, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
      h.audio.playedSamples = h.audio.queuedSamples
      try #require(h.audio.handlers).drained()
      h.answered("r1f")
    default:
      h.speechSocket.reply(SpeechSample.audio(newer, Data(count: 96_000)))
      h.speechStarts()
      h.socket.reply(RealtimeSample.speechStopped)
      h.socket.reply(RealtimeSample.committed("in-cut"))
      h.answered("r1c")
    }
    h.utterance("in3", startMs: 50_000)
    #expect(h.comparisons.isEmpty, "no mark stands, so no utterance is compared")
    #expect(try await h.turnCall("r3", call: "c3").utteranceAfterReading == false)
  }

  @Test("audio captured before the playback ended and handed over after it lies before the mark")
  func markCoversAudioCapturedBeforeTheEnd() async throws {
    // Bug caught: speech the user began while the reading still played, whose audio the engine handed over after the
    // playback ended, passes as an utterance after the reading.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    try h.input(milliseconds: 1000)
    h.scheduler.advance(1)
    try h.playReading(stream)
    try h.input(milliseconds: 200, capturedAt: h.scheduler.now - 0.2)
    try h.input(milliseconds: 100)
    h.answered("r1f")
    #expect(h.diagnostics.filter { if case .readingMark = $0 { true } else { false } } == [.readingMark(ms: 1300)])
    h.utterance("in2", startMs: 1150)
    #expect(h.comparisons == [.utteranceCompared(startMs: 1150, markMs: 1300, after: false)])
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading == false)
    h.utterance("in3", startMs: 1301)
    #expect(try await h.turnCall("r3", call: "c3").utteranceAfterReading)
  }

  @Test(
    "while the mark waits for audio captured after the end, an utterance is not after; undated or muted audio waits",
    arguments: ["nothing", "no-time", "muted"])
  func pendingMarkIsNotAfter(_ input: String) async throws {
    // Bug caught: a word compared before the app has every sample captured before the playback ended opens the
    // send, or audio the app cannot date places the mark.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    try h.input(milliseconds: 1000)
    try h.playReading(stream)
    switch input {
    case "no-time":
      try #require(h.audio.handlers).input(Data(count: 4800))
    case "muted":
      h.conversation.setMuted(true)
      try h.input(milliseconds: 100)
      h.conversation.setMuted(false)
    default:
      break
    }
    h.answered("r1f")
    h.utterance("in2", startMs: 50_000)
    #expect(!h.comparisons.contains { if case .utteranceCompared(_, _, true) = $0 { true } else { false } })
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading == false)
    #expect(h.comparisons == [.utteranceCompared(startMs: 50_000, markMs: nil, after: false)], "compared while pending")
    #expect(h.comparisons.first?.traceLine == "voice-agent: utterance start 50000 ms vs mark pending: not-after")
    #expect(!h.diagnostics.contains { if case .readingMark = $0 { true } else { false } })
  }
}
