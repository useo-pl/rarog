import Foundation
@testable import RarogUI
import Testing

// Read-along of a tool's reading (`RealtimeConversation+ReadAlong.swift`): the alignment of the characters Soniox said
// to the original text, and the progress the conversation reports to the host while the reading plays and at its
// end (whole, cut, not read). Fakes: `RealtimeHarness` and the Soniox socket fake from
// `RealtimeConversationTests.swift`. Owner: voice agent.

private typealias Harness = RealtimeHarness

/// Each spoken character lasts this long on the reading's audio: 1200 samples at 24 kHz.
private let step = 0.05
private let samplesPerCharacter = 1200

/// The characters Soniox said for `text`, one after another, each ``step`` long, starting `offset` characters into
/// the stream.
private func spoken(_ text: String, offset: Int = 0) -> [SonioxSpokenCharacter] {
  text.enumerated().map { index, character in
    let start = Double(offset + index) * step
    return SonioxSpokenCharacter(text: String(character), start: start, end: start + step)
  }
}

/// Seconds of the reading's audio that cover the first `characters` spoken characters.
private func upTo(_ characters: Int) -> TimeInterval { Double(characters) * step }

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// A Soniox audio frame of `stream` that speaks `text`, each character 1200 samples, `offset` characters into it;
/// `timed: false` sends the same audio with no timestamps.
private func spokenFrame(_ stream: String, _ text: String, offset: Int = 0, timed: Bool = true) -> String {
  var object: [String: Any] = [
    "stream_id": stream, "audio": Data(count: text.count * samplesPerCharacter * 2).base64EncodedString(),
  ]
  if timed {
    let characters = spoken(text, offset: offset)
    object["timestamps"] = [
      "characters": characters.map(\.text), "character_start_times_seconds": characters.map(\.start),
      "character_end_times_seconds": characters.map(\.end),
    ]
  }
  return SpeechSample.encoded(object)
}

/// A host tool whose work hands the conversation `text` to read with a progress closure, and records the progress
/// and how the reading ended.
@MainActor
private final class ReadAlongProbe {
  let text: String
  private(set) var progress: [ReadingProgress] = []
  private(set) var outcomes: [RealtimeReadingOutcome] = []

  init(_ text: String) { self.text = text }

  var tool: RealtimeToolSpec {
    RealtimeToolSpec(
      name: "read_along_probe", schema: ["type": "function", "name": "read_along_probe"], tally: nil,
      action: { [unowned self] _ in
        .workAndRead(checking: false) { _ in
          .read(
            self.text,
            then: { outcome in
              self.outcomes.append(outcome)
              return outcome == .whole ? "read whole" : "not read"
            },
            progress: { self.progress.append($0) })
        }
      })
  }
}

@MainActor
private extension RealtimeHarness {
  /// Response `response` calls `read_along_probe` as `call` and is over; returns the Soniox stream its reading started.
  func readAlongCall(_ response: String, call: String) async throws -> String {
    let before = SpeechSample.streams(speechSocket)
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.call(response, id: call, name: "read_along_probe"))
    socket.reply(RealtimeSample.done(response))
    #expect(await eventually { SpeechSample.streams(speechSocket).count > before.count })
    return try #require(SpeechSample.streams(speechSocket).first { !before.contains($0) })
  }

  /// The playback reached `samples` on its axis and the read-along tick ran.
  func played(_ samples: Int) {
    audio.playedSamples = samples
    scheduler.advance(RealtimeLevelMeter.interval)
  }
}

@MainActor
@Suite("voice conversation: read-along of a tool's reading")
struct ReadAlongTests {
  // MARK: - Alignment

  @Test(
    "the heard prefix of the original text, from the characters Soniox said",
    arguments: [
      // Bug caught: a trailing full stop Soniox said is not counted, so the whole text never lights up.
      ("Run tests.", "Run tests.", 10, 10),
      // Bug caught: the second space of a folded run of whitespace stays unread.
      ("A  b", "A b", 3, 4),
      // Bug caught: the dropped emoji stops the alignment, or the words after it are lost.
      ("Fix 🐛 now", "Fix now", 7, 9),
      // Bug caught: Polish letters do not match, or a prefix counts UTF-16 units instead of characters.
      ("Zażółć", "Zażółć", 2, 2),
      // Bug caught: the prefix runs ahead over the emoji and the space before the next word is said.
      ("Fix 🐛 now", "Fix now", 3, 3),
      // Bug caught: a trailing emoji Soniox dropped counts as heard before the end of the reading closes it.
      ("Done 🎉", "Done", 4, 4),
    ])
  func alignment(_ original: String, _ said: String, _ heard: Int, _ prefix: Int) {
    #expect(alignedPrefix(original: original, heard: spoken(said), playedUpTo: upTo(heard)) == prefix)
  }

  @Test("a number said as a word moves the prefix on midway, never back, and covers the text at the end")
  func numberSaidAsWord() {
    // Bug caught: the prefix stalls on the number until the next exact match, or jumps back once the words realign.
    let original = "Run 3 tests"
    let heard = spoken("Run three tests")
    var previous = 0
    for characters in 0...heard.count {
      let prefix = alignedPrefix(original: original, heard: heard, playedUpTo: upTo(characters))
      #expect(prefix >= previous, "never shrinks at \(characters) characters heard")
      #expect(prefix <= original.count)
      previous = prefix
    }
    let midway = alignedPrefix(original: original, heard: heard, playedUpTo: upTo(heard.count / 2))
    #expect((4...11).contains(midway))
    #expect(previous == 11)
  }

  @Test("a character counts once the playback passed its end; one without a time moves nothing")
  func characterTimes() {
    // Bug caught: a character lights up while it is still being said, or a timeless character moves the prefix.
    #expect(alignedPrefix(original: "Run", heard: spoken("Run"), playedUpTo: upTo(2) - 0.01) == 1)
    #expect(alignedPrefix(original: "Run", heard: [], playedUpTo: 10) == 0)
    let timeless = [SonioxSpokenCharacter(text: "R", start: .nan, end: .nan)]
    #expect(alignedPrefix(original: "Run", heard: timeless, playedUpTo: 10) == 0)
  }

  // MARK: - Progress of the reading in the conversation

  @Test("a reading queued behind an answer counts from its own start on the playback axis")
  func startAfterQueuedAnswer() async throws {
    // Bug caught: the answer audio before the reading lights up the prompt before a word of it was said.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800 * 2))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "read_along_probe"))
    h.socket.reply(RealtimeSample.done("r1"))
    let answer = try #require(h.streamOf["m1"])
    #expect(await eventually { SpeechSample.streams(h.speechSocket).count == 1 })
    h.speechSocket.reply(SpeechSample.terminated(answer))
    #expect(await eventually { SpeechSample.streams(h.speechSocket).count == 2 })
    let reading = try #require(SpeechSample.streams(h.speechSocket).last)
    h.speechSocket.reply(spokenFrame(reading, "Run tests."))
    h.played(4800)
    #expect(probe.progress.isEmpty, "only the answer played")
    h.played(4800 + 3 * samplesPerCharacter)
    #expect(probe.progress == [ReadingProgress(spokenPrefix: 3, end: nil)])
    h.speechSocket.reply(SpeechSample.terminated(reading))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.progress.last == ReadingProgress(spokenPrefix: 10, end: .whole))
    #expect(probe.outcomes == [.whole])
  }

  @Test("whole closes the prefix to the whole text, also past a trailing emoji; nothing comes after the end")
  func wholeClosesPrefix() async throws {
    // Bug caught: the end of a reading leaves the trailing emoji unlit, or a late tick reports after the end.
    let probe = ReadAlongProbe("Done 🎉")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readAlongCall("r1", call: "c1")
    h.speechSocket.reply(spokenFrame(stream, "Done"))
    h.played(2 * samplesPerCharacter)
    h.played(4 * samplesPerCharacter)
    h.speechSocket.reply(SpeechSample.terminated(stream))
    try #require(h.audio.handlers).drained()
    #expect(
      probe.progress == [
        ReadingProgress(spokenPrefix: 2, end: nil), ReadingProgress(spokenPrefix: 4, end: nil),
        ReadingProgress(spokenPrefix: 6, end: .whole),
      ])
    h.scheduler.advance(1)
    #expect(probe.progress.count == 3)
  }

  @Test("speech over the reading after \"Run\" ends the progress with the heard prefix and cut")
  func cutKeepsHeardPrefix() async throws {
    // Bug caught: a cut reports the whole queued reading as heard, or tells the host nothing.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readAlongCall("r1", call: "c1")
    h.speechSocket.reply(spokenFrame(stream, "Run tests."))
    h.audio.playedSamples = 3 * samplesPerCharacter
    h.socket.reply(RealtimeSample.speechStarted)
    h.scheduler.advance(RealtimeBargeIn.window)
    #expect(h.cancelledStreams == [stream])
    #expect(probe.progress.last == ReadingProgress(spokenPrefix: 3, end: .cut))
    #expect(probe.progress.filter { $0.end != nil }.count == 1)
    #expect(probe.outcomes.isEmpty)
  }

  @Test("the host's stop after \"Run\" cuts the reading as speech over it does: the heard prefix, no result")
  func hostStopCutsTheReading() async throws {
    // Bug caught: Edit or Send on the card lets the reading play on or reports it heard, or the dropped call leaves
    // the conversation stuck so the next utterance gets no answer.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readAlongCall("r1", call: "c1")
    h.speechSocket.reply(spokenFrame(stream, "Run tests."))
    h.audio.playedSamples = 3 * samplesPerCharacter
    let orders = h.socket.sent("response.create").count
    h.conversation.stopReading()
    #expect(h.cancelledStreams == [stream])
    #expect(h.audio.clears == 1, "the queued audio of the reading goes")
    #expect(probe.progress.last == ReadingProgress(spokenPrefix: 3, end: .cut))
    #expect(probe.progress.filter { $0.end != nil }.count == 1)
    h.speechSocket.reply(SpeechSample.terminated(stream))
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes.isEmpty && h.outputs("c1").isEmpty)
    #expect(h.conversation.phase == .listening)
    h.utterance("in2")
    #expect(h.socket.sent("response.create").count == orders + 1, "the next utterance orders its answer")
  }

  @Test("the host's stop with no reading leaves the playing answer alone")
  func hostStopWithoutReading() async throws {
    // Bug caught: Edit after the reading ended cuts the model's answer that plays now.
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800 * 2))
    let answers = h.answers.count
    let cancels = h.socket.sent("response.cancel").count
    h.conversation.stopReading()
    #expect(h.cancelledStreams.isEmpty && h.audio.clears == 0)
    #expect(h.socket.sent("response.cancel").count == cancels && h.answers.count == answers)
    #expect(h.conversation.phase == .speaking)
  }

  @Test("a reading cut at the stream limit after \"Run\" ends not read with the real prefix")
  func notReadKeepsPrefix() async throws {
    // Bug caught: a reading the user did not hear whole lights up whole.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readAlongCall("r1", call: "c1")
    h.speechSocket.reply(spokenFrame(stream, "Run"))
    h.speechSocket.reply(
      SpeechSample.encoded(["stream_id": stream, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.outcomes == [.notRead])
    #expect(probe.progress.last == ReadingProgress(spokenPrefix: 3, end: .notRead))
  }

  @Test("a playback lost after \"Run\" ends not read with what played before the loss, also once later audio queued")
  func lostPlaybackKeepsPlayedPrefix() async throws {
    // Bug caught: a reading whose end waits for the noise window counts the audio queued after the loss as heard.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "read_along_probe"))
    h.socket.reply(RealtimeSample.call("r1", id: "c2", name: "read_along_probe"))
    h.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { !SpeechSample.streams(h.speechSocket).isEmpty })
    let first = try #require(SpeechSample.streams(h.speechSocket).first)
    h.speechSocket.reply(spokenFrame(first, "Run tests."))
    h.audio.playedSamples = 3 * samplesPerCharacter
    h.socket.reply(RealtimeSample.speechStarted)
    try #require(h.audio.handlers).restarted("engine configuration change", true)
    #expect(probe.outcomes.isEmpty, "the not-read waits for the verdict")
    h.speechSocket.reply(SpeechSample.terminated(first))
    #expect(await eventually { SpeechSample.streams(h.speechSocket).count == 2 })
    let second = try #require(SpeechSample.streams(h.speechSocket).last)
    h.speechSocket.reply(spokenFrame(second, "Run tests."))
    h.scheduler.advance(0.2)
    h.socket.reply(RealtimeSample.speechStopped)
    h.socket.reply(RealtimeSample.committed("in-noise"))
    #expect(probe.outcomes == [.notRead])
    #expect(probe.progress.filter { $0.end != nil } == [ReadingProgress(spokenPrefix: 3, end: .notRead)])
  }

  @Test("audio without timestamps moves nothing while it plays; whole still closes to the whole text")
  func noTimestamps() async throws {
    // Bug caught: a reading without character times never lights up, also after it played out whole.
    let probe = ReadAlongProbe("Run tests.")
    let h = Harness(tools: [probe.tool])
    await h.ready()
    h.utterance()
    let stream = try await h.readAlongCall("r1", call: "c1")
    h.speechSocket.reply(spokenFrame(stream, "Run tests.", timed: false))
    h.played(5 * samplesPerCharacter)
    #expect(probe.progress.isEmpty)
    h.speechSocket.reply(SpeechSample.terminated(stream))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(probe.progress == [ReadingProgress(spokenPrefix: 10, end: .whole)])
  }
}
