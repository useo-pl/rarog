import Foundation
@testable import RarogUI
import Testing

// A tool's reading in the voice conversation (`RealtimeConversation+Reading.swift`): the exact text as a Soniox stream
// of its own in the order of what plays, the call's result only after the reading ended (played out whole, or not
// read), speech over it as a cut, noise as no cut, and no `playedWhole` for it. Fakes: `RealtimeHarness` with a probe
// tool and the Soniox socket fake; the probe and the harness helpers below serve
// `RealtimeConversationTests+ReadingMark.swift` and `RealtimeConversationTests+ReadingEnd.swift` too. Owner: voice
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

/// A host tool whose work hands the conversation `text` to read, and records the call's moment and how the reading
/// ended.
@MainActor
final class ReadingProbe {
  let text = "Project rarog, session api: Run the login tests and fix what fails."
  private(set) var turns: [RealtimeToolTurn] = []
  private(set) var outcomes: [RealtimeReadingOutcome] = []

  var tool: RealtimeToolSpec {
    RealtimeToolSpec(
      name: "read_probe", schema: ["type": "function", "name": "read_probe"], tally: nil,
      action: { [unowned self] _ in
        .workAndRead(checking: false) { turn in
          self.turns.append(turn)
          return .read(self.text) { outcome in
            self.outcomes.append(outcome)
            return outcome == .whole ? "read whole" : "not read"
          }
        }
      })
  }
}

@MainActor
extension RealtimeHarness {
  /// Response `response` calls `read_probe` as `call` and is over; returns the Soniox stream its reading started.
  func readingCall(_ response: String, call: String) async throws -> String {
    let before = SpeechSample.streams(speechSocket)
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.call(response, id: call, name: "read_probe"))
    socket.reply(RealtimeSample.done(response))
    #expect(await eventually { SpeechSample.streams(speechSocket).count > before.count })
    return try #require(SpeechSample.streams(speechSocket).first { !before.contains($0) })
  }

  /// Soniox says `samples` of the reading on `stream` and ends it, and the playback queue drains with all of it played.
  func playReading(_ stream: String, samples: Int = 4800) throws {
    speechSocket.reply(SpeechSample.audio(stream, Data(count: samples * 2)))
    speechSocket.reply(SpeechSample.terminated(stream))
    audio.playedSamples = audio.queuedSamples
    try #require(audio.handlers).drained()
  }

  /// `milliseconds` of microphone audio from the engine (24 kHz s16le), captured at `capturedAt` on the harness's
  /// host clock (its scheduler's time; default: now).
  func input(milliseconds: Int, capturedAt: TimeInterval? = nil) throws {
    try #require(audio.handlers).input(Data(count: milliseconds * 24 * 2), capturedAt ?? scheduler.now)
  }

  /// The user's utterance `item`, whose `speech_started` names `startItem` (default: `item`) and carries `startMs`
  /// (`nil`: no time). Nothing plays then, so it is no noise.
  func utterance(_ item: String, startMs: Int?, startItem: String? = nil) {
    var started: [String: Any] = ["type": "input_audio_buffer.speech_started", "item_id": startItem ?? item]
    if let startMs { started["audio_start_ms"] = startMs }
    socket.reply(SpeechSample.encoded(started))
    socket.reply(SpeechSample.encoded(["type": "input_audio_buffer.speech_stopped", "item_id": item]))
    socket.reply(RealtimeSample.committed(item))
  }

  /// The answer that the last tool result ordered is created and over.
  func answered(_ response: String) {
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.done(response))
  }

  /// Response `response` calls `turn_probe` as `call` and is over, and the answer to its result too; returns the
  /// moment the probe got.
  func turnCall(_ response: String, call: String) async throws -> RealtimeToolTurn {
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.call(response, id: call, name: "turn_probe"))
    socket.reply(RealtimeSample.done(response))
    #expect(await eventually { !outputs(call).isEmpty })
    answered(response + "f")
    return try #require(turns.last)
  }

  /// The reading of `read_probe` (response `response`) plays out whole with `milliseconds` of microphone input more
  /// on the axis, the last 10 ms captured at its end, so they place its mark there; the answer to its result is over.
  func wholeReading(_ response: String, call: String, after milliseconds: Int) async throws {
    let stream = try await readingCall(response, call: call)
    try input(milliseconds: milliseconds - 10)
    try playReading(stream)
    try input(milliseconds: 10)
    answered(response + "f")
  }

  var comparisons: [RealtimeConversation.Diagnostic] {
    diagnostics.filter { if case .utteranceCompared = $0 { true } else { false } }
  }
}

extension RealtimeConversationTests {
  @Test("a tool's text is a Soniox stream of its own; the result goes after the stream ended and the queue drained")
  func readingWhole() async throws {
    // Bug caught: the model hears the call's result while the text still plays, or Soniox reads another text.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    #expect(h.speechText(stream) == probe.text)
    #expect(h.speechEnded(stream))
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    #expect(h.conversation.phase == .speaking)
    h.speechSocket.reply(SpeechSample.terminated(stream))
    #expect(h.outputs("c1").isEmpty, "the reading still plays")
    #expect(probe.outcomes.isEmpty)
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes == [.whole])
    #expect(h.outputs("c1") == ["read whole"])
    #expect(h.socket.types.last == "response.create")
  }

  @Test("a reading asked while an answer item still speaks starts after that item's stream and plays after its audio")
  func readingQueuedBehindAnswer() async throws {
    // Bug caught: the reading jumps ahead of the answer the user is hearing, or its audio never reaches the playback.
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
    #expect(SpeechSample.streams(h.speechSocket) == [answer], "the reading waits for the answer's stream")
    h.speechSocket.reply(SpeechSample.terminated(answer))
    let streams = SpeechSample.streams(h.speechSocket)
    #expect(streams.count == 2)
    let reading = try #require(streams.last)
    #expect(h.speechText(reading) == probe.text)
    h.speechSocket.reply(SpeechSample.audio(reading, Data(count: 4800)))
    #expect(h.audio.queued.map(\.count) == [9600, 4800])
  }

  @Test(
    "Soniox ends the reading without audio, at its stream limit or with a stream error → not read; the result goes",
    arguments: ["no-audio", "stream-limit", "stream-error"])
  func readingNotRead(_ ending: String) async throws {
    // Bug caught: a reading the user did not hear whole counts as read, or its stream error ends the conversation.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    switch ending {
    case "no-audio":
      h.speechSocket.reply(SpeechSample.terminated(stream))
    default:
      h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 4800)))
      let limit = ending == "stream-limit"
      let type = limit ? "temp_api_key_session_expired" : "invalid_request"
      h.speechSocket.reply(
        SpeechSample.encoded(["stream_id": stream, "error_code": limit ? 403 : 400, "error_type": type]))
      #expect(h.outputs("c1").isEmpty, "what Soniox said still plays")
      h.audio.playedSamples = h.audio.queuedSamples
      try #require(h.audio.handlers).drained()
    }
    #expect(probe.outcomes == [.notRead])
    #expect(h.outputs("c1") == ["not read"])
    #expect(h.conversation.phase == .thinking, "the conversation goes on and waits for the answer to the result")
  }

  @Test("speech over the reading past the noise window stops it: Soniox cancel, no result, a cut; the next answer goes")
  func speechOverReadingCuts() async throws {
    // Bug caught: the user's "no" over the reading lets its result reach the model, or a leftover reading state holds
    // the next answer.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.audio.playedSamples = 12_000
    let orders = h.socket.sent("response.create").count
    h.socket.reply(RealtimeSample.speechStarted)
    #expect(h.conversation.bargeInWindow != nil, "the noise window first")
    h.scheduler.advance(RealtimeBargeIn.window)
    #expect(h.cancelledStreams == [stream])
    #expect(h.answers == [.cut, .cut])
    h.speechSocket.reply(SpeechSample.terminated(stream))
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes.isEmpty)
    #expect(h.outputs("c1").isEmpty)
    h.socket.reply(RealtimeSample.speechStopped)
    h.socket.reply(RealtimeSample.committed("in2"))
    #expect(h.socket.sent("response.create").count == orders + 1, "the next utterance orders its answer")
  }

  @Test("noise over the reading within the window: the reading goes on, ends whole, and its result goes")
  func noiseOverReading() async throws {
    // Bug caught: a cough over the reading stops it, or its result goes before the reading ended.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.socket.reply(RealtimeSample.speechStarted)
    h.scheduler.advance(0.2)
    h.socket.reply(RealtimeSample.speechStopped)
    h.socket.reply(RealtimeSample.committed("in-noise"))
    #expect(h.diagnostics.contains(.noiseIgnored))
    #expect(h.cancelledStreams.isEmpty)
    #expect(h.outputs("c1").isEmpty, "the reading goes on")
    h.speechSocket.reply(SpeechSample.terminated(stream))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes == [.whole])
    #expect(h.outputs("c1") == ["read whole"])
  }

  @Test("a reading that played out whole never tells playedWhole; the spoken answer after it still does")
  func readingIsNoAnswer() async throws {
    // Bug caught: a host that picks up a session's result or counts an announcement as heard on playedWhole takes a
    // tool's reading for the model's answer.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    try h.playReading(stream)
    #expect(h.audio.queued.count == 1, "the reading played")
    #expect(h.outputs("c1") == ["read whole"])
    #expect(h.answers == [.cut])
    h.socket.reply(RealtimeSample.created("r2"))
    h.say("r2", item: "m2", pcm: Data(count: 4800))
    h.socket.reply(RealtimeSample.done("r2"))
    try h.playOut("m2")
    #expect(h.answers == [.cut, .playedWhole])
  }

  @Test("a lost playback during the reading (the engine restarted) → not read, and the result goes")
  func lostPlaybackReadingNotRead() async throws {
    // Bug caught: a reading whose audio the engine dropped counts as heard, or its call never gets a result and the
    // conversation stays in Answering.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
    h.audio.playedSamples = 12_000
    try #require(h.audio.handlers).restarted("engine configuration change", true)
    #expect(h.cancelledStreams == [stream])
    #expect(probe.outcomes == [.notRead])
    #expect(h.outputs("c1") == ["not read"])
  }

  @Test("the end of the conversation during a reading delivers nothing; the next conversation reads again")
  func endDuringReading() async throws {
    // Bug caught: a result or a late Soniox frame of an ended conversation reaches the model or the host.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    let first = h.socket
    let firstSpeech = h.speechSocket
    h.conversation.end()
    firstSpeech.reply(SpeechSample.terminated(stream))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes.isEmpty)
    #expect(first.sent("conversation.item.create").isEmpty)
    await h.ready()
    h.utterance()
    let next = try await h.readingCall("r2", call: "c2")
    try h.playReading(next)
    #expect(probe.outcomes == [.whole])
    #expect(h.outputs("c2") == ["read whole"])
  }

  // MARK: - The mark on the input audio axis

  @Test("an utterance that began after the whole reading's mark → a tool called after it learns so; the log has both")
  func utteranceAfterReading() async throws {
    // Bug caught: a send that waits for the user's word after the reading never opens, or opens before any reading.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    try await h.wholeReading("r1", call: "c1", after: 1000)
    #expect(h.diagnostics.contains(.reading(.whole(marks: true))))
    #expect(h.diagnostics.contains(.readingMark(ms: 1000)))
    #expect(probe.turns.map(\.utteranceAfterReading) == [false])
    h.utterance("in2", startMs: 1001)
    #expect(h.comparisons == [.utteranceCompared(startMs: 1001, markMs: 1000, after: true)])
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading)
  }

  @Test(
    "an utterance at the mark, before it (its event after the playback), without a time or of another item: not after",
    arguments: ["at-the-mark", "before-the-mark", "no-time", "another-item"])
  func utteranceNotAfterReading(_ start: String) async throws {
    // Bug caught: speech the user began while the reading still played, or one the app cannot date, opens the send.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    try await h.wholeReading("r1", call: "c1", after: 1000)
    switch start {
    case "at-the-mark": h.utterance("in2", startMs: 1000)
    case "before-the-mark": h.utterance("in2", startMs: 400)
    case "no-time": h.utterance("in2", startMs: nil)
    default: h.utterance("in2", startMs: 1500, startItem: "in-other")
    }
    let logged = start == "at-the-mark" ? 1000 : start == "before-the-mark" ? 400 : nil
    #expect(h.comparisons == [.utteranceCompared(startMs: logged, markMs: 1000, after: false)])
    #expect(try await h.turnCall("r2", call: "c2").utteranceAfterReading == false)
  }

  @Test("muted microphone input does not move the input position the mark is taken from")
  func mutedInputKeepsPosition() async throws {
    // Bug caught: the position counts audio that never went to OpenAI, so the mark runs ahead of OpenAI's axis.
    let probe = ReadingProbe()
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readingCall("r1", call: "c1")
    try h.input(milliseconds: 600)
    h.conversation.setMuted(true)
    try h.input(milliseconds: 1000)
    h.conversation.setMuted(false)
    try h.input(milliseconds: 390)
    try h.playReading(stream)
    try h.input(milliseconds: 10)
    #expect(h.diagnostics.contains(.readingMark(ms: 1000)))
  }

  @Test("a second reading replaces the mark: an utterance after the first but before the second's end is not after")
  func secondReadingReplacesMark() async throws {
    // Bug caught: the user's word about the first reading opens a send after a second one they did not answer.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    try await h.wholeReading("r1", call: "c1", after: 1000)
    h.utterance("in2", startMs: 1200)
    try await h.wholeReading("r2", call: "c2", after: 1000)
    #expect(probe.turns.map(\.utteranceAfterReading) == [false, true], "the second call came after a word")
    #expect(h.diagnostics.contains(.readingMark(ms: 2000)))
    h.utterance("in3", startMs: 1500)
    #expect(try await h.turnCall("r3", call: "c3").utteranceAfterReading == false)
    h.utterance("in4", startMs: 2100)
    #expect(try await h.turnCall("r4", call: "c4").utteranceAfterReading)
    #expect(
      h.comparisons == [
        .utteranceCompared(startMs: 1200, markMs: 1000, after: true),
        .utteranceCompared(startMs: 1500, markMs: 2000, after: false),
        .utteranceCompared(startMs: 2100, markMs: 2000, after: true),
      ])
  }

  @Test(
    "a reading after a whole one that is not read or is cut leaves no mark: no utterance after it is after",
    arguments: ["no-audio", "stream-limit", "cut"])
  func failedReadingDropsMark(_ ending: String) async throws {
    // Bug caught: a word about the first reading opens a send for a prompt whose reading the user never heard whole.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    try await h.wholeReading("r1", call: "c1", after: 1000)
    h.utterance("in2", startMs: 1200)
    let stream = try await h.readingCall("r2", call: "c2")
    switch ending {
    case "no-audio":
      h.speechSocket.reply(SpeechSample.terminated(stream))
      h.answered("r2f")
      #expect(h.diagnostics.contains(.reading(.notRead(.noAudio))))
    case "stream-limit":
      h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 4800)))
      h.speechSocket.reply(
        SpeechSample.encoded(["stream_id": stream, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
      h.audio.playedSamples = h.audio.queuedSamples
      try #require(h.audio.handlers).drained()
      h.answered("r2f")
      #expect(h.diagnostics.contains(.reading(.notRead(.streamLimit))))
    default:
      h.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
      h.speechStarts()
      h.socket.reply(RealtimeSample.speechStopped)
      h.socket.reply(RealtimeSample.committed("in-cut"))
      h.answered("r2c")
      #expect(h.diagnostics.contains(.reading(.notRead(.cut))))
    }
    h.utterance("in3", startMs: 50_000)
    #expect(try await h.turnCall("r3", call: "c3").utteranceAfterReading == false)
    #expect(h.comparisons == [.utteranceCompared(startMs: 1200, markMs: 1000, after: true)])
  }

  @Test("the end of the conversation drops the mark: the next conversation counts from zero and has no mark")
  func endDropsMark() async throws {
    // Bug caught: a word in a new conversation, whose input axis starts again, passes as an answer to an old reading.
    let probe = ReadingProbe()
    let h = Harness(turnProbe: true, tools: [probe.tool])
    await h.ready()
    h.utterance()
    try await h.wholeReading("r1", call: "c1", after: 1000)
    h.conversation.end()
    let before = h.comparisons.count
    await h.ready()
    h.utterance("in1", startMs: 5000)
    #expect(try await h.turnCall("r1", call: "c3").utteranceAfterReading == false)
    #expect(h.comparisons.count == before)
    try await h.wholeReading("r2", call: "c4", after: 300)
    #expect(h.diagnostics.last { if case .readingMark = $0 { true } else { false } } == .readingMark(ms: 300))
  }
}
