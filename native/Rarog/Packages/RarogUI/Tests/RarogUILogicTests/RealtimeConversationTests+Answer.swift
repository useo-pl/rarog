import Foundation
@testable import RarogUI
import Testing

// What the voice conversation tells its host about the answers (`RealtimeConversation+Answer.swift`): a spoken answer
// without a tool call played out whole, and a cut at every barge-in and at a lost playback. Noise over the answer is
// no cut. Fakes: `RealtimeHarness` with `SpeechFakeKeys` and the Soniox socket fake. Owner: voice agent.

private typealias Harness = RealtimeHarness

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

@MainActor
extension RealtimeHarness {
  /// The stream of `item` ends at Soniox, and the playback queue drains with all of it played.
  func playOut(_ item: String) throws {
    let stream = try #require(streamOf[item])
    speechSocket.reply(SpeechSample.terminated(stream))
    audio.playedSamples = audio.queuedSamples
    try #require(audio.handlers).drained()
  }
}

extension RealtimeConversationTests {
  @Test("a spoken answer without a tool call: playedWhole once, when its playback drained, not at response.done")
  func answerPlayedWhole() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    #expect(h.answers == [.cut], "speech while nothing plays is a barge-in")
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 9600))
    h.socket.reply(RealtimeSample.done("r1"))
    #expect(h.answers == [.cut], "the answer still plays")
    try h.playOut("m1")
    #expect(h.answers == [.cut, .playedWhole])
    try #require(h.audio.handlers).drained()
    #expect(h.answers == [.cut, .playedWhole], "once")
  }

  @Test("a response that calls a tool speaks its preamble to the end: no event; the answer after the result counts")
  func preambleDoesNotCount() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"Why?"}"#))
    h.socket.reply(RealtimeSample.done("r1"))
    try h.playOut("m1")
    #expect(await eventually { h.socket.sent("response.create").count == 2 }, "the tool result went out")
    #expect(h.answers == [.cut])
    h.socket.reply(RealtimeSample.created("r2"))
    h.say("r2", item: "m2", pcm: Data(count: 4800))
    h.socket.reply(RealtimeSample.done("r2"))
    try h.playOut("m2")
    #expect(h.answers == [.cut, .playedWhole])
  }

  @Test("speech over the playing answer cuts it: a cut, and its playback never counts as whole")
  func speechOverAnswerCuts() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 96_000))
    h.socket.reply(RealtimeSample.done("r1"))
    h.audio.playedSamples = 12_000
    h.speechStarts()
    #expect(h.answers == [.cut, .cut])
    let stream = try #require(h.streamOf["m1"])
    h.speechSocket.reply(SpeechSample.terminated(stream))
    try #require(h.audio.handlers).drained()
    #expect(!h.answers.contains(.playedWhole))
  }

  @Test("noise over the playing answer is no cut: the answer goes on and counts when it played out")
  func noiseIsNoCut() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 96_000))
    h.socket.reply(RealtimeSample.done("r1"))
    h.socket.reply(RealtimeSample.speechStarted)
    h.scheduler.advance(0.2)
    h.socket.reply(RealtimeSample.speechStopped)
    #expect(h.diagnostics.contains(.noiseIgnored))
    try h.playOut("m1")
    #expect(h.answers == [.cut, .playedWhole])
  }

  @Test("speech while a tool's work runs drops its result: a cut")
  func speechDuringToolWorkCuts() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    var release: CheckedContinuation<Void, Never>?
    h.askReply = {
      await withCheckedContinuation { release = $0 }
      return #"{"answer":"Late."}"#
    }
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.socket.reply(RealtimeSample.call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"Why?"}"#))
    h.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { release != nil })
    h.speechStarts()
    #expect(h.answers == [.cut, .cut])
    release?.resume()
  }

  @Test("the stream limit cut the item: the answer does not count as whole")
  func streamLimitIsNotWhole() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    h.socket.reply(RealtimeSample.done("r1"))
    let stream = try #require(h.streamOf["m1"])
    h.speechSocket.reply(
      SpeechSample.encoded(["stream_id": stream, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
    #expect(h.answers == [.cut])
  }

  @Test("one item of the answer got no audio: the answer does not count as whole")
  func silentItemIsNotWhole() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    h.socket.reply(RealtimeSample.textDelta("r1", item: "m2"))
    h.socket.reply(RealtimeSample.done("r1"))
    let before = SpeechSample.streams(h.speechSocket)
    h.speechSocket.reply(SpeechSample.terminated(try #require(h.streamOf["m1"])))
    // The second item's stream starts when the first one's is over; it ends without audio.
    let silent = try #require(SpeechSample.streams(h.speechSocket).first { !before.contains($0) })
    h.speechSocket.reply(SpeechSample.terminated(silent))
    h.audio.playedSamples = h.audio.queuedSamples
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
    #expect(h.answers == [.cut])
  }

  @Test("a lost playback (the engine restarted) is a cut, and the answer does not count as whole")
  func lostPlaybackCuts() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(RealtimeSample.created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 96_000))
    h.audio.playedSamples = 12_000
    try #require(h.audio.handlers).restarted("engine configuration change", true)
    #expect(h.answers == [.cut, .cut])
    h.socket.reply(RealtimeSample.done("r1"))
    let stream = try #require(h.streamOf["m1"])
    h.speechSocket.reply(SpeechSample.terminated(stream))
    #expect(!h.answers.contains(.playedWhole))
  }
}
