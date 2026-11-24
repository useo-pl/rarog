import Foundation
@testable import RarogUI
import Testing

// How a tool's reading ends in the voice conversation (`RealtimeConversation+Reading.swift`): its end waits for the
// verdict of an open noise window, and the waits for its stream's first audio and for its end are bounded. Fakes:
// `RealtimeHarness` with the reading probe and the helpers of `RealtimeConversationTests+Reading.swift`. Owner: voice
// agent.

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
    "a reading's end within the noise window waits: noise or the mute end it whole, once; speech cuts it",
    arguments: ["noise", "mute", "speech"])
  func readingEndWaitsForWindow(_ verdict: String) async throws {
    // Bug caught: a "no" the user began over the end of a reading lets the reading count as heard and its result
    // reach the model before the app knows it was speech.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.speechSocket.reply(SpeechSample.terminated(stream))
    h.socket.reply(RealtimeSample.speechStarted)
    #expect(h.conversation.bargeInWindow != nil)
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes.isEmpty, "the reading's end waits for the verdict")
    #expect(h.outputs("c1").isEmpty)
    switch verdict {
    case "noise":
      h.scheduler.advance(0.2)
      h.socket.reply(RealtimeSample.speechStopped)
      #expect(probe.outcomes == [.whole])
      h.socket.reply(RealtimeSample.committed("in-noise"))
      #expect(h.outputs("c1") == ["read whole"])
    case "mute":
      h.conversation.setMuted(true)
      #expect(probe.outcomes == [.whole])
      #expect(h.outputs("c1") == ["read whole"])
    default:
      h.scheduler.advance(RealtimeBargeIn.window)
      #expect(probe.outcomes.isEmpty, "the cut drops the call")
      #expect(h.outputs("c1").isEmpty)
      #expect(h.diagnostics.contains(.reading(.notRead(.cut))))
    }
    h.scheduler.advance(RealtimeBargeIn.window)
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes.count == (verdict == "speech" ? 0 : 1), "the reading ends once")
    let ends = h.diagnostics.filter { if case .reading = $0 { true } else { false } }
    #expect(ends.count == 1)
  }

  @Test("the playback lost while the noise window is open: the not-read waits for the verdict, and speech drops it")
  func lostPlaybackWaitsForWindow() async throws {
    // Bug caught: the result of a reading cut by the user's speech reaches the model because the engine restarted
    // within the window.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.audio.playedSamples = 12_000
    h.socket.reply(RealtimeSample.speechStarted)
    try #require(h.audio.handlers).restarted("engine configuration change", true)
    #expect(h.cancelledStreams == [stream])
    #expect(probe.outcomes.isEmpty, "the not-read waits for the verdict")
    h.scheduler.advance(RealtimeBargeIn.window)
    #expect(probe.outcomes.isEmpty)
    #expect(h.outputs("c1").isEmpty)
    #expect(h.diagnostics.contains(.reading(.notRead(.cut))))
  }

  @Test("Soniox never ends a reading's stream: the wait after its audio played is bounded, then cancel and not read")
  func stalledReadingEndsNotRead() async throws {
    // Bug caught: a stream Soniox never ends keeps the call's result, and with it the model's answer, waiting forever.
    let wait = SonioxSpeech.Timing.production.drainLimit
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    h.scheduler.advance(wait - 1)
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 4800)))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    h.scheduler.advance(wait - 0.1)
    #expect(probe.outcomes.isEmpty, "new audio restarted the wait")
    h.scheduler.advance(0.1)
    #expect(h.cancelledStreams == [stream])
    #expect(probe.outcomes == [.notRead])
    #expect(h.outputs("c1") == ["not read"])
    #expect(h.diagnostics.contains(.reading(.notRead(.stalled))))
    h.answered("r1f")
    h.utterance("in2", startMs: 50_000)
    #expect(h.comparisons.isEmpty, "no mark")
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading == false)
  }

  @Test("a cut or the end while a reading waits for its stream's end: the bound passes with no result", arguments: [
    "cut", "end",
  ])
  func stalledReadingGuards(_ ending: String) async throws {
    // Bug caught: the bound's timer delivers a not-read result after the user cut the reading or ended the
    // conversation.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    if ending == "cut" { h.speechStarts() } else { h.conversation.end() }
    h.scheduler.advance(SonioxSpeech.Timing.production.drainLimit * 2)
    #expect(probe.outcomes.isEmpty)
    #expect(h.outputs("c1").isEmpty)
    let ends = h.diagnostics.filter { if case .reading = $0 { true } else { false } }
    #expect(ends == (ending == "cut" ? [.reading(.notRead(.cut))] : []))
  }

  @Test("no audio of a reading's started stream: the wait for its first audio is bounded, then cancel and not read")
  func silentReadingEndsNotRead() async throws {
    // Bug caught: a stream Soniox never starts speaking keeps the call's result, and the tool that waits for it,
    // until the user speaks.
    let limit = SonioxSpeech.Timing.production.firstAudioLimit
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.scheduler.advance(limit - 0.1)
    #expect(h.cancelledStreams.isEmpty)
    #expect(probe.outcomes.isEmpty)
    h.scheduler.advance(0.1)
    #expect(h.cancelledStreams == [stream])
    #expect(probe.outcomes == [.notRead])
    #expect(h.outputs("c1") == ["not read"])
    #expect(h.diagnostics.contains(.reading(.notRead(.noFirstAudio))))
    h.speechSocket.reply(SpeechSample.terminated(stream))
    #expect(probe.outcomes.count == 1, "a late end of the cancelled stream ends nothing")
    h.answered("r1f")
    h.utterance("in2", startMs: 50_000)
    #expect(h.comparisons.isEmpty, "no mark")
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading == false)
  }

  @Test("a reading's first audio right before the bound disarms it: no stop, and the reading plays out whole")
  func firstAudioBeforeLimitKeepsReading() async throws {
    // Bug caught: a slow but working stream is cancelled while it speaks, and the user hears half a prompt.
    let limit = SonioxSpeech.Timing.production.firstAudioLimit
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.scheduler.advance(limit - 0.1)
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.scheduler.advance(limit)
    #expect(h.cancelledStreams.isEmpty)
    #expect(probe.outcomes.isEmpty)
    h.speechSocket.reply(SpeechSample.terminated(stream))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes == [.whole])
    #expect(h.outputs("c1") == ["read whole"])
  }

  @Test("a reading queued behind an answer's stream: the wait for its first audio starts with its own stream")
  func queuedReadingWaitsFromItsStream() async throws {
    // Bug caught: a reading that waits behind a long answer is cancelled before Soniox ever started it.
    let limit = SonioxSpeech.Timing.production.firstAudioLimit
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 9600))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "read_probe"))
    h.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { probe.turns.count == 1 })
    let answer = try #require(h.streamOf["m1"])
    h.scheduler.advance(limit * 2)
    #expect(h.cancelledStreams.isEmpty, "the reading waits for the answer's stream")
    #expect(probe.outcomes.isEmpty)
    h.speechSocket.reply(SpeechSample.terminated(answer))
    let reading = try #require(SpeechSample.streams(h.speechSocket).last)
    #expect(reading != answer)
    h.scheduler.advance(limit - 0.1)
    #expect(h.cancelledStreams.isEmpty)
    h.scheduler.advance(0.1)
    #expect(h.cancelledStreams == [reading])
    #expect(probe.outcomes == [.notRead])
  }

  @Test("a cut or the end while a reading waits for its first audio: the bound passes with no result", arguments: [
    "cut", "end",
  ])
  func silentReadingGuards(_ ending: String) async throws {
    // Bug caught: the bound's timer delivers a not-read result, or cancels a stream again, after the user cut the
    // reading or ended the conversation.
    let limit = SonioxSpeech.Timing.production.firstAudioLimit
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.scheduler.advance(limit / 2)
    if ending == "cut" { h.speechStarts() } else { h.conversation.end() }
    h.scheduler.advance(limit * 2)
    #expect(probe.outcomes.isEmpty)
    #expect(h.outputs("c1").isEmpty)
    #expect(h.cancelledStreams == (ending == "cut" ? [stream] : []), "only the cut's own cancel")
    let ends = h.diagnostics.filter { if case .reading = $0 { true } else { false } }
    #expect(ends == (ending == "cut" ? [.reading(.notRead(.cut))] : []))
  }

  @Test("the end of the conversation during a reading's synthesis makes the Soniox audio of the end line a floor")
  func endDuringReadingSynthesisIsFloor() async throws {
    // Bug caught: the end line reports the audio of a reading whose stream never ended as exact.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    h.conversation.end()
    let summary = try #require(h.diagnostics.compactMap { if case let .ended(line) = $0 { line } else { nil } }.last)
    #expect(summary.spoken.samples == 4800)
    #expect(summary.spoken.cut, "its synthesis did not end")
  }
}
