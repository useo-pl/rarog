import Foundation
@testable import RarogUI
import Testing

// The voice conversation with Soniox speech (`RealtimeConversation+Speech.swift`): a text session, the answer's text
// to Soniox, its PCM to playback, the three ends of an answer item (text, synthesis, playback), the speech key before
// `session.update`, the end on a Soniox failure, the speech lines of `client.log` (the cost counts only text that went
// out), and speech over the answer: Soniox `cancel` and the item fixed to the heard text (`delete` + `create`), the
// stream limit. Fakes: `RealtimeHarness`
// with `SpeechFakeKeys` and the socket fake `MockSocket`. No test reaches OpenAI or Soniox. Owner: voice agent.

private typealias Harness = RealtimeHarness
private let speechStopped = RealtimeSample.speechStopped
private func created(_ id: String) -> String { RealtimeSample.created(id) }
private func done(_ id: String) -> String { RealtimeSample.done(id) }
private func call(_ response: String, id: String, name: String, arguments: String = "{}") -> String {
  RealtimeSample.call(response, id: id, name: name, arguments: arguments)
}

private func encoded(_ object: [String: Any]) -> String {
  String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
}

private func textDelta(_ response: String, item: String, _ text: String) -> String {
  encoded(["type": "response.output_text.delta", "response_id": response, "item_id": item, "delta": text])
}

private func textDone(_ response: String, item: String, _ text: String) -> String {
  encoded(["type": "response.output_text.done", "response_id": response, "item_id": item, "text": text])
}

/// A Soniox audio frame of `samples` s16le samples.
private func speechAudio(_ stream: String, samples: Int) -> String {
  encoded(["stream_id": stream, "audio": Data(count: samples * 2).base64EncodedString()])
}

private func terminated(_ stream: String) -> String { encoded(["stream_id": stream, "terminated": true]) }

/// A Soniox audio frame that speaks `text`, each character 50 ms (1200 samples) long, `offset` characters into the
/// stream.
private func spokenAudio(_ stream: String, _ text: String, offset: Int = 0) -> String {
  let characters = text.map(String.init)
  let starts = characters.indices.map { Double(offset + $0) * 0.05 }
  return encoded([
    "stream_id": stream, "audio": Data(count: characters.count * 1200 * 2).base64EncodedString(),
    "timestamps": [
      "characters": characters, "character_start_times_seconds": starts,
      "character_end_times_seconds": starts.map { $0 + 0.05 },
    ],
  ])
}

/// OpenAI added an assistant message item to the conversation after `previous`.
private func itemAdded(_ item: String, after previous: String) -> String {
  encoded([
    "type": "conversation.item.added", "previous_item_id": previous,
    "item": ["id": item, "type": "message", "role": "assistant", "content": [] as [Any]] as [String: Any],
  ])
}

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
  /// Frames sent to Soniox, decoded.
  fileprivate var speechFrames: [[String: Any]] {
    speechSocket.texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
  }

  /// Stream ids of the start frames, in order.
  fileprivate var speechStreams: [String] {
    speechFrames.filter { $0["model"] != nil }.compactMap { $0["stream_id"] as? String }
  }

  /// The text sent on `stream`, joined.
  func speechText(_ stream: String) -> String {
    speechFrames.filter { $0["stream_id"] as? String == stream }.compactMap { $0["text"] as? String }.joined()
  }

  func speechEnded(_ stream: String) -> Bool {
    speechFrames.contains { $0["stream_id"] as? String == stream && $0["text_end"] as? Bool == true }
  }

  fileprivate var traceLines: [String] { diagnostics.map(\.traceLine) }

  /// Item ids of the `conversation.item.delete` events sent to OpenAI.
  fileprivate var deletedItems: [String] {
    socket.sent("conversation.item.delete").compactMap { $0["item_id"] as? String }
  }

  /// The assistant items the app wrote into the conversation: their text and the item they follow.
  fileprivate var assistantItems: [(text: String, after: String?)] {
    socket.sent("conversation.item.create").compactMap { event in
      guard let item = event["item"] as? [String: Any], item["role"] as? String == "assistant",
        let content = (item["content"] as? [[String: Any]])?.first, content["type"] as? String == "output_text",
        let text = content["text"] as? String
      else { return nil }
      return (text, event["previous_item_id"] as? String)
    }
  }

  /// Stream ids Soniox was told to cancel.
  var cancelledStreams: [String] {
    speechFrames.filter { $0["cancel"] as? Bool == true }.compactMap { $0["stream_id"] as? String }
  }

  /// The user's utterance, then response `id` with one text item `item` saying `text`, over.
  fileprivate func answer(_ id: String, item: String, _ text: String) {
    utterance()
    socket.reply(created(id))
    answerText(id, item: item, text)
  }

  /// Response `id`, already created, has one text item `item` saying `text`, over.
  fileprivate func answerText(_ id: String, item: String, _ text: String) {
    socket.reply(textDelta(id, item: item, text))
    socket.reply(textDone(id, item: item, text))
    socket.reply(done(id))
  }
}

extension RealtimeConversationTests {
  @Test("Soniox: the speech key comes before session.update; a text session without output audio")
  func speechTextSession() async throws {
    let speech = SpeechFakeKeys()
    let h = Harness(speech: speech)
    h.conversation.start()
    #expect(await eventually { !h.sockets.isEmpty })
    #expect(speech.calls == 1 && h.keys.calls == 1)
    #expect(h.speechSockets.count == 1)
    #expect(h.speechSocket.protocols == ["soniox-api-key", "snx_temp_conversation_a"])
    h.socket.open()
    let update = try #require(h.socket.sent("session.update").first)
    let session = try #require(update["session"] as? [String: Any])
    #expect(session["output_modalities"] as? [String] == ["text"])
    let audio = try #require(session["audio"] as? [String: Any])
    #expect(audio["output"] == nil)
    let input = try #require(audio["input"] as? [String: Any])
    #expect((input["format"] as? [String: Any])?["rate"] as? Int == 24000)
    #expect(!h.socket.texts.joined().contains("marin"))
  }

  @Test("a text answer goes to Soniox and plays its PCM; speaking ends after playback, not at response.done")
  func speechAnswerPlays() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.scheduler.advance(0.2)
    h.socket.reply(created("r1"))
    h.socket.reply(textDelta("r1", item: "m1", "Fixed "))
    h.socket.reply(textDelta("r1", item: "m1", "in turn 2."))
    h.socket.reply(textDone("r1", item: "m1", "Fixed in turn 2."))
    h.socket.reply(done("r1"))
    #expect(h.conversation.phase == .thinking)
    let stream = try #require(h.speechStreams.first)
    #expect(h.speechText(stream) == "Fixed in turn 2.")
    #expect(h.speechEnded(stream))
    #expect(h.audio.queued.isEmpty)
    h.scheduler.advance(0.3)
    h.speechSocket.reply(speechAudio(stream, samples: 4800))
    #expect(h.audio.queuedSamples == 4800)
    #expect(h.conversation.phase == .speaking)
    h.speechSocket.reply(terminated(stream))
    #expect(h.conversation.phase == .speaking)
    h.audio.playedSamples = 4800
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
    #expect(h.traceLines.contains("voice-agent: tts start"))
    #expect(h.traceLines.contains("voice-agent: tts first pcm 500 ms"))
    #expect(h.traceLines.contains("voice-agent: tts end"))
    #expect(!h.traceLines.contains { $0.contains("Fixed") })
  }

  @Test("drained before the synthesis ends keeps the item on the sample axis and the speaking phase")
  func speechDrainedBeforeSynthesisEnd() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.answer("r1", item: "m1", "A longer answer.")
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(speechAudio(stream, samples: 2400))
    h.audio.playedSamples = 2400
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .speaking)
    #expect(h.conversation.items["m1"]?.count == 2400)
    h.speechSocket.reply(speechAudio(stream, samples: 2400))
    #expect(h.conversation.items["m1"]?.count == 4800)
    #expect(h.conversation.items["m1"]?.start == 0)
    h.speechSocket.reply(terminated(stream))
    #expect(h.conversation.phase == .speaking)
    h.audio.playedSamples = 4800
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
    #expect(h.conversation.items.isEmpty)
  }

  @Test("the preamble and the answer after show_prompt play one after the other though the answer's text came first")
  func speechPreambleThenAnswer() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(textDelta("r1", item: "m1", "I am writing it."))
    h.socket.reply(textDone("r1", item: "m1", "I am writing it."))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    // The tool result went out with the next response.create at once; the answer's text arrives before any audio.
    #expect(h.socket.sent("response.create").count == 2)
    h.socket.reply(created("r2"))
    h.socket.reply(textDelta("r2", item: "m2", "Shall I send it?"))
    h.socket.reply(textDone("r2", item: "m2", "Shall I send it?"))
    h.socket.reply(done("r2"))
    #expect(h.speechStreams.count == 1)
    let first = h.speechStreams[0]
    #expect(h.speechText(first) == "I am writing it.")
    h.speechSocket.reply(speechAudio(first, samples: 1000))
    h.speechSocket.reply(speechAudio(first, samples: 1000))
    #expect(h.speechStreams.count == 1)
    h.speechSocket.reply(terminated(first))
    #expect(h.speechStreams.count == 2)
    let second = h.speechStreams[1]
    #expect(h.speechText(second) == "Shall I send it?")
    h.speechSocket.reply(speechAudio(second, samples: 3000))
    #expect(h.audio.queued.map { $0.count / 2 } == [1000, 1000, 3000])
    #expect(h.conversation.items["m1"]?.start == 0 && h.conversation.items["m2"]?.start == 2000)
    h.speechSocket.reply(terminated(second))
    h.audio.playedSamples = 5000
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
  }

  @Test(
    "no speech key at the start → no OpenAI socket, no session.update, the engine stopped, its reason",
    arguments: [
      (SonioxSpeechKeyError.off, RealtimeConversation.End.speechOff),
      (.throttled, .throttled),
      (.unavailable, .speechUnavailable),
    ])
  func speechKeyFailsAtStart(error: SonioxSpeechKeyError, end: RealtimeConversation.End) async {
    let h = Harness(speech: SpeechFakeKeys([.failure(error)]))
    h.conversation.start()
    #expect(await eventually { h.conversation.phase == .ended(end) })
    #expect(h.sockets.isEmpty && h.speechSockets.isEmpty)
    #expect(h.audio.stops >= 1)
    #expect(h.traceLines.last?.hasPrefix("voice-agent: ended \(end.traceName) after") == true)
  }

  @Test("Soniox fails during the conversation → it ends with the reason, both sockets and audio closed, no retry")
  func speechFailureEnds() async throws {
    let speech = SpeechFakeKeys()
    let h = Harness(speech: speech)
    await h.ready()
    h.answer("r1", item: "m1", "Hello.")
    h.speechSocket.drop()
    #expect(h.conversation.phase == .ended(.speechFailed))
    #expect(h.socket.closed)
    #expect(h.audio.stops == 1)
    #expect(h.speechSockets.count == 1 && speech.calls == 1)
    #expect(h.traceLines.contains("voice-agent: tts error socket-closed"))
    #expect(h.traceLines.last?.hasPrefix("voice-agent: ended speech-failed after") == true)
  }

  @Test("an error frame for a stream ends the conversation too, without a new stream")
  func speechStreamErrorEnds() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.answer("r1", item: "m1", "Hello.")
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(encoded(["stream_id": stream, "error_code": 500, "error_type": "internal_error"]))
    #expect(h.conversation.phase == .ended(.speechFailed))
    #expect(h.traceLines.contains("voice-agent: tts error 500 internal_error"))
    #expect(h.speechStreams.count == 1)
  }

  @Test("a key near its expiry: a new speech key and socket; no key then → the end with its reason")
  func speechRenewal() async throws {
    let speech = SpeechFakeKeys([
      .success(SpeechFakeKeys.config(expiresIn: 60)),
      .success(SpeechFakeKeys.config("snx_temp_conversation_b", expiresIn: 600)),
      .failure(.unavailable),
    ])
    let h = Harness(speech: speech)
    await h.ready()
    h.scheduler.advance(40)
    h.answer("r1", item: "m1", "Hello.")
    #expect(await eventually { h.speechSockets.count == 2 })
    #expect(speech.calls == 2)
    #expect(h.speechSocket.protocols.last == "snx_temp_conversation_b")
    h.speechSocket.open()
    let stream = try #require(h.speechStreams.first)
    #expect(h.speechText(stream) == "Hello.")
    h.speechSocket.reply(terminated(stream))
    try #require(h.audio.handlers).drained()
    h.scheduler.advance(580)
    h.answer("r2", item: "m2", "Again.")
    #expect(await eventually { h.conversation.phase == .ended(.speechUnavailable) })
    #expect(speech.calls == 3)
  }

  @Test("a response with a tool call only opens no Soniox stream")
  func speechToolOnlyResponse() async {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    #expect(h.placed == ["Run the tests"])
    #expect(h.speechStreams.isEmpty)
    #expect(h.speechFrames.allSatisfy { $0["text"] == nil })
  }

  @Test("cost: a response line with the characters and the GENERATED audio, the total in the end line")
  func speechCostLine() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.answer("r1", item: "m1", "Hello there")
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(speechAudio(stream, samples: 24_000))
    h.speechSocket.reply(speechAudio(stream, samples: 24_000))
    h.speechSocket.reply(terminated(stream))
    // Only half was played when the queue ran dry: the price counts what Soniox generated.
    h.audio.playedSamples = 24_000
    try #require(h.audio.handlers).drained()
    // 11 characters × 0.3 token × $4/1M + 2 s × 30,000 tokens/h × $21.50/1M = $0.0004.
    #expect(h.traceLines.contains("voice-agent: response 1 tts chars 11 audio 2000 ms $0.0004"))
    h.conversation.end()
    #expect(h.traceLines.last?.hasSuffix(", tts chars 11 audio 2000 ms $0.0004") == true)
  }

  @Test("the end during a stream marks the generated audio as a floor (~) and logs no response line for it")
  func speechCutStream() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.answer("r1", item: "m1", "Hello")
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(speechAudio(stream, samples: 12_000))
    h.conversation.end()
    #expect(!h.traceLines.contains { $0.contains("response 1 tts") })
    #expect(h.traceLines.last?.hasSuffix(", tts chars 5 audio ~500 ms $0.0001") == true)
    #expect(h.speechSocket.closed)
  }

  // MARK: - Cost: only the text that went out

  @Test("the end while the second utterance waits in the queue: the cost counts the first one only")
  func speechCostWithoutQueuedText() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(textDelta("r1", item: "m1", "Hello"))
    h.socket.reply(textDone("r1", item: "m1", "Hello"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    h.socket.reply(created("r2"))
    h.socket.reply(textDelta("r2", item: "m2", "Second answer."))
    h.socket.reply(textDone("r2", item: "m2", "Second answer."))
    h.socket.reply(done("r2"))
    #expect(h.speechStreams.count == 1)
    h.conversation.end()
    #expect(h.traceLines.last?.contains(", tts chars 5 audio ~0 ms") == true)
  }

  @Test("speech with the preamble playing and the answer in the queue: the cancelled, unsent text is not in the cost")
  func speechCostWithoutCancelledText() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    try h.preambleAndAnswer()
    h.audio.playedSamples = 4800
    h.speechStarts()
    h.conversation.end()
    // "I am writing it." went out; "Shall I send it?" waited and never did.
    #expect(h.traceLines.last?.contains(", tts chars 16 audio ~200 ms") == true)
  }

  // MARK: - Speech over the answer

  @Test("speech midway: Soniox cancel, the item fixed to the heard text before the next response.create, no truncate")
  func speechInterruptedMidway() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "Fixed in turn two. "))
    let stream = try #require(h.speechStreams.first)
    h.socket.reply(textDelta("r1", item: "m1", "Then tested."))
    h.speechSocket.reply(spokenAudio(stream, "Fixed in"))
    // 6000 samples played: the first five characters ended in them.
    h.audio.playedSamples = 6000
    h.speechStarts()
    #expect(h.cancelledStreams == [stream])
    #expect(h.traceLines.contains("voice-agent: tts cancel"))
    // The response is still open: the fix waits for its response.done, and so does the next response.create.
    #expect(h.deletedItems.isEmpty)
    h.socket.reply(speechStopped)
    h.socket.reply(RealtimeSample.committed("in2"))
    #expect(h.socket.sent("response.create").count == 1)
    #expect(h.conversation.phase == .thinking)
    h.socket.reply(RealtimeSample.done("r1", status: "cancelled"))
    #expect(Array(h.socket.types.suffix(3)) == ["conversation.item.delete", "conversation.item.create", "response.create"])
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.map(\.text) == ["Fixed"])
    #expect(h.assistantItems.first?.after == "in1")
    #expect(h.socket.sent("conversation.item.truncate").isEmpty)
    #expect(h.socket.sent("response.create").count == 2)
    #expect(!h.traceLines.contains { $0.contains("Fixed") })
  }

  @Test(
    "speech after the text ended, before the speech did: the same fix at once, before the next response.create",
    arguments: [false, true])
  func speechInterruptedAfterText(synthesized: Bool) async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "Fixed in turn two."))
    h.socket.reply(textDone("r1", item: "m1", "Fixed in turn two."))
    h.socket.reply(done("r1"))
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(spokenAudio(stream, "Fixed in turn two."))
    if synthesized { h.speechSocket.reply(terminated(stream)) }
    h.audio.playedSamples = 9600
    h.utterance("in2")
    // A finished stream needs no cancel; a running one gets it.
    #expect(h.cancelledStreams == (synthesized ? [] : [stream]))
    #expect(Array(h.socket.types.suffix(3)) == ["conversation.item.delete", "conversation.item.create", "response.create"])
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.map(\.text) == ["Fixed in"])
    #expect(h.socket.sent("conversation.item.truncate").isEmpty)
  }

  @Test("speech before the first sound: the item is only deleted, no empty item comes in its place")
  func speechInterruptedBeforeSound() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "Hello"))
    let stream = try #require(h.speechStreams.first)
    h.speechStarts()
    #expect(h.cancelledStreams == [stream])
    h.socket.reply(RealtimeSample.done("r1", status: "cancelled"))
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.isEmpty)
    h.socket.reply(speechStopped)
    h.socket.reply(RealtimeSample.committed("in2"))
    #expect(h.socket.types.last == "response.create")
  }

  @Test("a response created after the speech is cancelled and its items deleted from the conversation")
  func speechStaleResponseDeleted() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    // The user speaks again before the ordered response exists.
    h.speechStarts()
    h.socket.reply(created("r1"))
    #expect(h.socket.sent("response.cancel").compactMap { $0["response_id"] as? String } == ["r1"])
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "Too late."))
    h.socket.reply(RealtimeSample.done("r1", status: "cancelled"))
    #expect(h.speechStreams.isEmpty)
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.isEmpty)
  }

  @Test("late deltas of an interrupted response open no stream; its unheard items leave the conversation")
  func speechLateDeltasOpenNoStream() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "First."))
    let stream = try #require(h.speechStreams.first)
    h.speechStarts()
    h.socket.reply(textDelta("r1", item: "m1", " More."))
    h.socket.reply(textDone("r1", item: "m1", "First. More."))
    h.socket.reply(itemAdded("m2", after: "m1"))
    h.socket.reply(textDelta("r1", item: "m2", "Another item."))
    // The cancelled stream frees the slot: still nothing new starts.
    h.speechSocket.reply(terminated(stream))
    #expect(h.speechStreams == [stream])
    #expect(h.speechText(stream) == "First.")
    h.socket.reply(RealtimeSample.done("r1", status: "cancelled"))
    #expect(Set(h.deletedItems) == ["m1", "m2"])
    #expect(h.assistantItems.isEmpty)
  }

  @Test("speech with the preamble playing and the answer in the queue: every unheard utterance cancelled")
  func speechInterruptedWithPreamble() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    let first = try h.preambleAndAnswer()
    h.audio.playedSamples = 4800
    h.speechStarts()
    #expect(h.cancelledStreams == [first])
    h.speechSocket.reply(terminated(first))
    h.scheduler.advance(5)
    // The answer in the queue never starts.
    #expect(h.speechStreams == [first])
    // Both responses are over: the fixes go out at once.
    #expect(Set(h.deletedItems) == ["m1", "m2"])
    #expect(h.assistantItems.map(\.text) == ["I am"])
    #expect(h.assistantItems.first?.after == "in1")
    #expect(h.traceLines.filter { $0 == "voice-agent: tts cancel" }.count == 2)
  }

  @Test("Soniox's stream limit (403 temp_api_key_session_expired): the synthesis ends with the heard text, the talk goes on")
  func speechStreamLimit() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "A very long answer."))
    h.socket.reply(textDone("r1", item: "m1", "A very long answer."))
    h.socket.reply(done("r1"))
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(spokenAudio(stream, "A very"))
    h.speechSocket.reply(
      encoded(["stream_id": stream, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
    #expect(h.traceLines.contains("voice-agent: tts error 403 temp_api_key_session_expired"))
    #expect(h.conversation.phase == .speaking)
    #expect(h.deletedItems.isEmpty)
    h.audio.playedSamples = 7200
    try #require(h.audio.handlers).drained()
    #expect(h.conversation.phase == .listening)
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.map(\.text) == ["A very"])
    #expect(h.traceLines.contains { $0.hasPrefix("voice-agent: response 1 tts chars 19 audio ~300 ms") })
    // The conversation goes on: the next answer speaks on the same socket.
    h.speechSocket.reply(terminated(stream))
    h.answer("r2", item: "m2", "Next.")
    #expect(h.speechStreams.count == 2)
    #expect(h.speechSockets.count == 1)
  }

  @Test(
    "the stream limit before the item's text ended: its later deltas open no second stream; the fix keeps the heard text",
    arguments: [false, true])
  func speechStreamLimitLateDeltas(drainedFirst: Bool) async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "A very long "))
    let stream = try #require(h.speechStreams.first)
    h.speechSocket.reply(spokenAudio(stream, "A very"))
    h.speechSocket.reply(
      encoded(["stream_id": stream, "error_code": 403, "error_type": "temp_api_key_session_expired"]))
    h.speechSocket.reply(terminated(stream))
    if drainedFirst {
      // The queue drained: the cut item is over and waits for its response.done to be fixed.
      h.audio.playedSamples = 7200
      try #require(h.audio.handlers).drained()
    }
    h.socket.reply(textDelta("r1", item: "m1", "answer, "))
    h.socket.reply(textDelta("r1", item: "m1", "said in full."))
    h.socket.reply(textDone("r1", item: "m1", "A very long answer, said in full."))
    h.scheduler.advance(5)
    #expect(h.speechStreams == [stream])
    #expect(h.speechText(stream) == "A very long ")
    h.socket.reply(done("r1"))
    if !drainedFirst {
      h.audio.playedSamples = 7200
      try #require(h.audio.handlers).drained()
    }
    #expect(h.speechStreams == [stream])
    #expect(h.deletedItems == ["m1"])
    #expect(h.assistantItems.map(\.text) == ["A very"])
    #expect(h.conversation.phase == .listening)
  }

  // MARK: - Orders placed before the speech

  @Test("a second utterance committed before the earlier order's response.created: its response.create waits for the delete")
  func speechHeldForOrderBeforeSpeech() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    // The user speaks again before the ordered response exists, and that utterance is committed too.
    h.utterance("in2")
    #expect(h.socket.sent("response.create").count == 1)
    #expect(h.conversation.phase == .thinking)
    h.socket.reply(created("r1"))
    #expect(h.socket.sent("response.cancel").compactMap { $0["response_id"] as? String } == ["r1"])
    h.socket.reply(itemAdded("m1", after: "in1"))
    h.socket.reply(textDelta("r1", item: "m1", "Too late."))
    #expect(h.socket.sent("response.create").count == 1)
    h.socket.reply(RealtimeSample.done("r1", status: "cancelled"))
    #expect(Array(h.socket.types.suffix(2)) == ["conversation.item.delete", "response.create"])
    #expect(h.deletedItems == ["m1"])
    #expect(h.socket.sent("response.create").count == 2)
    h.socket.reply(created("r2"))
    #expect(h.socket.sent("response.cancel").count == 1)
    h.answerText("r2", item: "m2", "Now.")
    #expect(h.speechStreams.count == 1)
    #expect(h.speechText(try #require(h.speechStreams.first)) == "Now.")
  }

  @Test("the same, but the earlier order gets conversation_already_has_active_response: no hang, one response.create")
  func speechHeldOrderAfterActiveResponse() async throws {
    let h = Harness(speech: SpeechFakeKeys())
    await h.ready()
    h.utterance()
    h.utterance("in2")
    #expect(h.socket.sent("response.create").count == 1)
    h.socket.reply(
      #"{"type":"error","error":{"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"Conversation already has an active response"}}"#)
    #expect(h.socket.sent("response.create").count == 1)
    #expect(h.conversation.phase == .thinking)
    h.socket.reply(RealtimeSample.done("r0", status: "cancelled"))
    #expect(h.socket.sent("response.create").count == 2)
    #expect(h.conversation.phase == .thinking)
    h.socket.reply(created("r1"))
    #expect(h.socket.sent("response.cancel").isEmpty)
    h.answerText("r1", item: "m1", "Now.")
    #expect(h.socket.sent("response.create").count == 2)
    #expect(h.speechText(try #require(h.speechStreams.first)) == "Now.")
  }
}

@MainActor
extension RealtimeHarness {
  /// Response r1 says the preamble "I am writing it." (item m1, after the user's in1) and calls `show_prompt`; the
  /// answer r2 "Shall I send it?" (item m2) waits in the Soniox queue while the preamble's stream speaks "I am"
  /// (4800 samples). Returns the preamble's stream.
  @discardableResult
  fileprivate func preambleAndAnswer() throws -> String {
    utterance()
    socket.reply(created("r1"))
    socket.reply(itemAdded("m1", after: "in1"))
    socket.reply(textDelta("r1", item: "m1", "I am writing it."))
    socket.reply(textDone("r1", item: "m1", "I am writing it."))
    socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    socket.reply(done("r1"))
    socket.reply(created("r2"))
    socket.reply(itemAdded("m2", after: "fc_c1_output"))
    socket.reply(textDelta("r2", item: "m2", "Shall I send it?"))
    socket.reply(textDone("r2", item: "m2", "Shall I send it?"))
    socket.reply(done("r2"))
    let first = try #require(speechStreams.first)
    speechSocket.reply(spokenAudio(first, "I am"))
    #expect(speechStreams.count == 1)
    return first
  }
}
