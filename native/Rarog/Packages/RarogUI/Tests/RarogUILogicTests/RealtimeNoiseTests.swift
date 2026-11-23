import Foundation
@testable import RarogUI
import Testing

// Noise over the answer (`RealtimeConversation+Noise.swift`): speech over an answer that plays lowers the volume and
// waits; VAD's end of speech within the window is noise (the answer goes on, the utterance orders nothing and leaves
// the conversation) unless the VAD's times say 0.4 s of speech, and speech that outlasts the window is today's
// barge-in plus an explicit `response.cancel`. Tool calls in the window wait for the verdict: noise runs them, the cut,
// the end and the mute drop them; after noise their results wait for the noise item's delete. With nothing playing,
// speech cuts at once as before. The end of the conversation and the mute close the window. Fakes and samples:
// `RealtimeConversationTests.swift`. Owner: voice agent.

private typealias Harness = RealtimeHarness
private let speechStarted = RealtimeSample.speechStarted
private let speechStopped = RealtimeSample.speechStopped
private func committed(_ item: String) -> String { RealtimeSample.committed(item) }
private func created(_ id: String) -> String { RealtimeSample.created(id) }
private func done(_ id: String, status: String = "completed") -> String { RealtimeSample.done(id, status: status) }
private func call(_ response: String, id: String, name: String, arguments: String = "{}") -> String {
  RealtimeSample.call(response, id: id, name: name, arguments: arguments)
}

/// VAD events with their times on the input audio axis; `nil` leaves the field out.
private func started(ms: Int?) -> String {
  var event: [String: Any] = ["type": "input_audio_buffer.speech_started", "item_id": "in2"]
  if let ms { event["audio_start_ms"] = ms }
  return SpeechSample.encoded(event)
}

private func stopped(ms: Int?) -> String {
  var event: [String: Any] = ["type": "input_audio_buffer.speech_stopped", "item_id": "in2"]
  if let ms { event["audio_end_ms"] = ms }
  return SpeechSample.encoded(event)
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// Time for the tasks of tool calls to start and finish.
private func settle() async { try? await Task.sleep(for: .milliseconds(30)) }

@MainActor
extension RealtimeHarness {
  /// The first utterance's answer `r1` plays 2 s of Soniox audio in item `m1`; `r1` is still open at OpenAI.
  fileprivate func answerPlaying() async {
    await ready()
    utterance()
    socket.reply(created("r1"))
    say("r1", item: "m1", pcm: Data(count: 96_000))
    #expect(conversation.phase == .speaking)
  }

  /// The prompt of `show_prompt` (r1) stands in the field, the user confirmed it (`in2`), and the answer `r2` plays
  /// ("sending it"); `r2` is still open at OpenAI.
  fileprivate func confirmedAnswerPlaying() async {
    await ready()
    utterance()
    socket.reply(created("r1"))
    socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    socket.reply(done("r1"))
    socket.reply(created("r1f"))
    socket.reply(done("r1f"))
    utterance("in2")
    socket.reply(created("r2"))
    say("r2", item: "m2", pcm: Data(count: 96_000))
    #expect(placedVersions == [1])
    #expect(conversation.phase == .speaking)
  }

  fileprivate func ids(_ type: String, _ field: String) -> [String] {
    socket.sent(type).compactMap { $0[field] as? String }
  }

  /// The function outputs sent for `callId`.
  fileprivate func outputs(_ callId: String) -> [String] {
    socket.sent("conversation.item.create").compactMap { $0["item"] as? [String: Any] }
      .filter { $0["call_id"] as? String == callId }.compactMap { $0["output"] as? String }
  }

  /// Position of the last sent event that matches, among the events without microphone audio.
  fileprivate func position(_ matches: ([String: Any]) -> Bool) -> Int? {
    socket.sent.filter { $0["type"] as? String != "input_audio_buffer.append" }.lastIndex(where: matches)
  }

  /// Over the answer `r1`: a held `show_prompt`, `r1`'s `response.done`, then the sound ends as noise.
  fileprivate func noiseAfterHeldPrompt() {
    socket.reply(speechStarted)
    socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    socket.reply(done("r1"))
    scheduler.advance(0.2)
    socket.reply(speechStopped)
  }
}

/// What ends the wait for the noise's `committed` when it does not come.
enum NoiseWaitEnd: Sendable, CaseIterable {
  case nextSpeech, mute, end
}

@MainActor
@Suite("voice conversation: noise over the answer")
struct RealtimeNoiseTests {
  @Test("answer playing, a sound shorter than the window → no cut, no answer, its item deleted, the volume back")
  func noiseIgnored() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    #expect(h.audio.playbackVolume == RealtimeBargeIn.duckedVolume)
    #expect(RealtimeBargeIn.duckedVolume < 1)
    #expect(h.audio.clears == 0)
    h.scheduler.advance(0.2)
    h.socket.reply(speechStopped)
    #expect(h.audio.playbackVolume == 1)
    h.socket.reply(committed("in2"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["in2"])
    #expect(h.socket.sent("response.create").count == orders)
    #expect(h.socket.sent("response.cancel").isEmpty)
    #expect(!h.diagnostics.contains(.speechCancel))
    #expect(h.diagnostics.contains(.noiseIgnored))
    #expect(RealtimeConversation.Diagnostic.noiseIgnored.traceLine == "voice-agent: noise ignored")
    // The window is gone: time passing cuts nothing, and the answer keeps playing.
    h.scheduler.advance(2)
    #expect(h.audio.clears == 0)
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    #expect(h.audio.queuedSamples == 50_400)
    #expect(h.conversation.phase == .speaking)
  }

  @Test("answer playing, speech outlasts the window → today's barge-in plus response.cancel; its answer as today")
  func speechCuts() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    // The user heard 1.5 s of 2 s, the ducked part included.
    h.audio.playedSamples = 36_000
    h.socket.reply(speechStarted)
    h.scheduler.advance(RealtimeBargeIn.minimumSpeech)
    #expect(h.audio.clears == 0)
    h.scheduler.advance(RealtimeBargeIn.window - RealtimeBargeIn.minimumSpeech)
    #expect(h.audio.clears == 1)
    #expect(h.audio.queued.isEmpty)
    #expect(h.audio.playbackVolume == 1)
    #expect(h.diagnostics.contains(.speechCancel))
    #expect(h.ids("response.cancel", "response_id") == ["r1"])
    #expect(h.conversation.bargeInWindow == nil)
    h.socket.reply(speechStopped)
    h.socket.reply(committed("in2"))
    #expect(!h.diagnostics.contains(.noiseIgnored))
    // The fixes of r1 go out at its `response.done`, then the utterance's response.create.
    #expect(h.socket.sent("response.create").count == orders)
    h.socket.reply(done("r1", status: "cancelled"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["m1"])
    #expect(h.socket.sent("response.create").count == orders + 1)
  }

  @Test("nothing playing: speech, its end after 200 ms and the commit → an answer as today, no window")
  func listeningAnswers() async throws {
    let h = Harness()
    await h.ready()
    h.socket.reply(speechStarted)
    #expect(h.conversation.bargeInWindow == nil)
    #expect(h.audio.playbackVolume == 1)
    h.scheduler.advance(0.2)
    h.socket.reply(speechStopped)
    h.socket.reply(committed("in1"))
    #expect(h.socket.sent("response.create").count == 1)
    #expect(h.socket.sent("conversation.item.delete").isEmpty)
    #expect(!h.diagnostics.contains(.noiseIgnored))
  }

  @Test("speech while the answer is generated but nothing plays → cut at once, the open response cancelled by the app")
  func thinkingCutsAtOnce() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(speechStarted)
    #expect(h.conversation.bargeInWindow == nil)
    #expect(h.ids("response.cancel", "response_id") == ["r1"])
  }

  @Test("the end of the conversation in the window → no cut, nothing ordered, the volume back, the timer gone")
  func endInWindow() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    h.conversation.end(.closed)
    #expect(h.audio.playbackVolume == 1)
    #expect(h.conversation.bargeInWindow == nil)
    h.scheduler.advance(RealtimeBargeIn.window + 1)
    #expect(h.audio.clears == 0)
    #expect(!h.diagnostics.contains(.speechCancel))
    #expect(h.socket.sent("response.cancel").isEmpty)
    #expect(h.socket.sent("response.create").count == orders)
  }

  @Test("mute in the window → no cut, the late commit orders nothing and goes, the answer plays on at full volume")
  func muteInWindow() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    h.conversation.setMuted(true)
    #expect(h.audio.playbackVolume == 1)
    #expect(h.conversation.bargeInWindow == nil)
    h.scheduler.advance(RealtimeBargeIn.window + 1)
    #expect(h.audio.clears == 0)
    #expect(!h.diagnostics.contains(.speechCancel))
    h.socket.reply(speechStopped)
    h.socket.reply(committed("in2"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["in2"])
    #expect(h.socket.sent("response.create").count == orders)
    #expect(h.socket.sent("response.cancel").isEmpty)
    #expect(h.conversation.phase == .speaking)
  }

  // MARK: - Tool calls in the window

  @Test("send_prompt in the window, then the speech outlasts it → nothing sent, the call dropped as interrupted")
  func heldSendCut() async throws {
    let h = Harness()
    await h.confirmedAnswerPlaying()
    let orders = h.socket.sent("response.create").count
    // "No, wait" over "sending it", and the model's send_prompt 100 ms later.
    h.socket.reply(speechStarted)
    h.scheduler.advance(0.1)
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    await settle()
    #expect(h.sentVersions.isEmpty)
    h.scheduler.advance(RealtimeBargeIn.window)
    #expect(h.ids("response.cancel", "response_id") == ["r2"])
    await settle()
    #expect(h.sentVersions.isEmpty)
    h.socket.reply(done("r2", status: "cancelled"))
    #expect(h.outputs("c2").isEmpty)
    #expect(h.socket.sent("response.create").count == orders)
  }

  @Test("send_prompt in the window, then the sound ends as noise → the send goes once, after the verdict")
  func heldSendNoise() async throws {
    let h = Harness()
    await h.confirmedAnswerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    await settle()
    #expect(h.sentVersions.isEmpty)
    h.scheduler.advance(0.2)
    h.socket.reply(speechStopped)
    #expect(h.diagnostics.contains(.noiseIgnored))
    #expect(await eventually { h.sentVersions == [1] })
    await settle()
    #expect(h.sentVersions == [1])
    // The noise orders nothing; the answer's own response.done sends the tool result and orders the next answer.
    h.socket.reply(committed("in3"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["in3"])
    h.socket.reply(done("r2"))
    #expect(await eventually { h.outputs("c2") == ["sent"] })
    #expect(h.socket.sent("response.create").count == orders + 1)
  }

  @Test("send_prompt whose work had not started when the speech began waits too: noise runs it, the cut drops it",
    arguments: [true, false])
  func heldWorkStart(noise: Bool) async throws {
    let h = Harness()
    await h.confirmedAnswerPlaying()
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(speechStarted)
    await settle()
    #expect(h.sentVersions.isEmpty)
    if noise {
      h.scheduler.advance(0.2)
      h.socket.reply(speechStopped)
      #expect(await eventually { h.sentVersions == [1] })
    } else {
      h.scheduler.advance(RealtimeBargeIn.window)
      await settle()
      #expect(h.sentVersions.isEmpty)
    }
  }

  @Test(
    "mute or the end in the window with a held send_prompt → nothing sent, nothing ordered", arguments: [true, false])
  func heldSendDroppedByMuteOrEnd(mute: Bool) async throws {
    let h = Harness()
    await h.confirmedAnswerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    await settle()
    if mute { h.conversation.setMuted(true) } else { h.conversation.end(.closed) }
    h.scheduler.advance(RealtimeBargeIn.window + 1)
    await settle()
    #expect(h.sentVersions.isEmpty)
    h.socket.reply(done("r2"))
    #expect(h.outputs("c2").isEmpty)
    #expect(h.socket.sent("response.create").count == orders)
    // The dropped call keeps the conversation from waiting on it.
    #expect(h.conversation.sending.isEmpty)
  }

  // MARK: - Speech length by the VAD's times

  @Test("VAD times say 0.9 s of speech (1000 → 2700 ms), its end 100 ms after the start → the cut now, the utterance answered")
  func longSpeechByTimesCuts() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(started(ms: 1000))
    h.scheduler.advance(0.1)
    h.socket.reply(stopped(ms: 2700))
    #expect(h.audio.clears == 1)
    #expect(h.audio.playbackVolume == 1)
    #expect(h.ids("response.cancel", "response_id") == ["r1"])
    #expect(!h.diagnostics.contains(.noiseIgnored))
    h.socket.reply(committed("in2"))
    #expect(h.socket.sent("conversation.item.delete").isEmpty)
    // The fixes of r1 go out at its `response.done`, then the utterance's response.create.
    h.socket.reply(done("r1", status: "cancelled"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["m1"])
    #expect(h.socket.sent("response.create").count == orders + 1)
    // The window is closed: its time passing cuts nothing more.
    h.scheduler.advance(RealtimeBargeIn.window)
    #expect(h.audio.clears == 1)
  }

  @Test("VAD times say 0.2 s of speech (1000 → 2000 ms) → noise as before")
  func shortSpeechByTimesNoise() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.socket.reply(started(ms: 1000))
    h.scheduler.advance(0.1)
    h.socket.reply(stopped(ms: 2000))
    #expect(h.audio.clears == 0)
    #expect(h.audio.playbackVolume == 1)
    #expect(h.diagnostics.contains(.noiseIgnored))
    h.socket.reply(committed("in2"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["in2"])
    #expect(h.socket.sent("response.create").count == orders)
  }

  @Test("a VAD event without its time → the window's timer decides: an end within it is noise",
    arguments: [(nil, 2700), (1000, nil), (nil, nil)] as [(Int?, Int?)])
  func missingTimesTimerDecides(start: Int?, end: Int?) async throws {
    let h = Harness()
    await h.answerPlaying()
    h.socket.reply(started(ms: start))
    h.scheduler.advance(0.1)
    h.socket.reply(stopped(ms: end))
    #expect(h.audio.clears == 0)
    #expect(h.diagnostics.contains(.noiseIgnored))
    h.socket.reply(committed("in2"))
    #expect(h.ids("conversation.item.delete", "item_id") == ["in2"])
  }

  @Test("send_prompt before the speech, then the mute or the end before its work starts → nothing sent, the call gone",
    arguments: [true, false])
  func unstartedWorkDropped(mute: Bool) async throws {
    let h = Harness()
    await h.confirmedAnswerPlaying()
    let orders = h.socket.sent("response.create").count
    // All before the task of the call starts.
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(speechStarted)
    if mute { h.conversation.setMuted(true) } else { h.conversation.end(.closed) }
    await settle()
    #expect(h.sentVersions.isEmpty)
    if mute {
      #expect(h.conversation.sending.isEmpty)
      #expect(h.conversation.callsByResponse["r2"] == nil)
    }
    h.socket.reply(done("r2"))
    #expect(h.outputs("c2").isEmpty)
    #expect(h.socket.sent("response.create").count == orders)
  }

  @Test("noise after a held show_prompt and its response.done → the noise item's delete goes before the result and the order")
  func noiseItemDeletedFirst() async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.noiseAfterHeldPrompt()
    #expect(h.placed == ["Run the tests"])
    #expect(h.outputs("c1").isEmpty)
    #expect(h.socket.sent("response.create").count == orders)
    h.socket.reply(committed("in2"))
    let delete = try #require(
      h.position { $0["type"] as? String == "conversation.item.delete" && $0["item_id"] as? String == "in2" })
    let output = try #require(h.position { ($0["item"] as? [String: Any])?["call_id"] as? String == "c1" })
    let order = try #require(h.position { $0["type"] as? String == "response.create" })
    #expect(delete < output)
    #expect(output < order)
    #expect(h.outputs("c1").count == 1)
    #expect(h.socket.sent("response.create").count == orders + 1)
  }

  @Test("the noise's committed does not come: the next speech or the mute lets the results go, the end drops them",
    arguments: NoiseWaitEnd.allCases)
  func noiseWaitBounded(end: NoiseWaitEnd) async throws {
    let h = Harness()
    await h.answerPlaying()
    let orders = h.socket.sent("response.create").count
    h.noiseAfterHeldPrompt()
    #expect(h.outputs("c1").isEmpty)
    switch end {
    case .nextSpeech: h.socket.reply(speechStarted)
    case .mute: h.conversation.setMuted(true)
    case .end: h.conversation.end(.closed)
    }
    if end == .end {
      #expect(h.outputs("c1").isEmpty)
      #expect(h.socket.sent("response.create").count == orders)
    } else {
      #expect(h.outputs("c1").count == 1)
      #expect(h.socket.sent("response.create").count == orders + 1)
    }
  }

  @Test("the VAD's times: read from both events, nil when the event has none; the rule takes off padding and silence")
  func speechTimes() throws {
    #expect(RealtimeServerEvent.parse(started(ms: 1000)) == .speechStarted(itemId: "in2", audioStartMs: 1000))
    #expect(RealtimeServerEvent.parse(started(ms: nil)) == .speechStarted(itemId: "in2", audioStartMs: nil))
    #expect(RealtimeServerEvent.parse(stopped(ms: 2700)) == .speechStopped(audioEndMs: 2700))
    #expect(RealtimeServerEvent.parse(stopped(ms: nil)) == .speechStopped(audioEndMs: nil))
    let padding = RealtimeInstructions.prefixPaddingMs + RealtimeInstructions.silenceMs
    let length = try #require(RealtimeBargeIn.speechLength(startMs: 1000, endMs: 1000 + padding + 400))
    #expect(abs(length - 0.4) < 0.000_1)
    #expect(RealtimeBargeIn.speechLength(startMs: nil, endMs: 2700) == nil)
    #expect(RealtimeBargeIn.speechLength(startMs: 1000, endMs: nil) == nil)
  }
}
