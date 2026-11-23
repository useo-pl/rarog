import Foundation
@testable import RarogUI
import Testing

// The start of a voice conversation (`RealtimeConversation+Start.swift`): the speech key, the OpenAI key and the audio
// engine start at the tap, side by side; a key refusal picks its reason whatever the order of arrival; the
// conversation listens only when the engine runs and `session.updated` came, in either order; one ready line with the
// stage times. Fakes: `RealtimeHarness` with held key providers and a held engine start. Owner: voice agent.

private typealias Harness = RealtimeHarness

private let sessionUpdated = #"{"type":"session.updated","session":{}}"#

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// Lets the tasks a release resumed run to their next wait.
@MainActor
private func settle() async {
  for _ in 0..<50 { await Task.yield() }
}

@MainActor
private func traceLines(_ h: Harness) -> [String] { h.diagnostics.map(\.traceLine) }

@MainActor
private func readyLines(_ h: Harness) -> [String] {
  traceLines(h).filter { $0.hasPrefix("voice-agent: ready after ") }
}

/// PCM s16le with every sample at `value`.
private func pcm(_ value: Int16, samples: Int = 4) -> Data {
  var data = Data(capacity: samples * 2)
  for _ in 0..<samples { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  return data
}

/// Both key providers and the engine start held at the tap.
@MainActor
private func heldHarness(
  openAI: Result<RealtimeEphemeralKey, RealtimeKeyError> = .success(
    RealtimeEphemeralKey(value: "ek_test_secret", model: "gpt-realtime-2.1")),
  speech: Result<SonioxSpeechConfig, SonioxSpeechKeyError> = .success(SpeechFakeKeys.config()),
  holdAudio: Bool = true
) -> Harness {
  let speechKeys = SpeechFakeKeys([speech])
  speechKeys.hold = true
  let h = Harness(keys: RealtimeFakeKeys(openAI, hold: true), speech: speechKeys)
  h.audio.holdFirstStart = holdAudio
  return h
}

@MainActor
@Suite("voice conversation start: keys and audio at once, one readiness gate, the ready line")
struct RealtimeConversationStartTests {
  @Test("the tap starts both key fetches and the audio engine before any of them returns")
  func startsEverythingAtOnce() async {
    let h = heldHarness()
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending && h.audio.startPending })
    #expect(h.speechKeys.calls == 1 && h.keys.calls == 1 && h.audio.starts == 1)
    #expect(h.conversation.phase == .connecting)
    #expect(h.sockets.isEmpty && h.speechSockets.isEmpty)
  }

  @Test(
    "speech key refused, OpenAI key fine → the speech reason, no socket, the engine stopped",
    arguments: [true, false])
  func speechKeyRefused(openAIFirst: Bool) async {
    let h = heldHarness(speech: .failure(.off), holdAudio: false)
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending })
    if openAIFirst {
      h.keys.release()
      await settle()
      #expect(h.conversation.phase == .connecting)
      #expect(h.sockets.isEmpty)
      h.speechKeys.release()
    } else {
      h.speechKeys.release()
      #expect(await eventually { h.conversation.phase == .ended(.speechOff) })
      h.keys.release()
    }
    #expect(await eventually { h.conversation.phase == .ended(.speechOff) })
    await settle()
    #expect(h.conversation.phase == .ended(.speechOff))
    #expect(h.sockets.isEmpty && h.speechSockets.isEmpty)
    #expect(h.audio.starts == 1 && h.audio.stops >= 1)
    #expect(readyLines(h).isEmpty)
  }

  @Test(
    "OpenAI key refused, speech key fine → the OpenAI reason, no socket, the engine stopped",
    arguments: [true, false])
  func openAIKeyRefused(openAIFirst: Bool) async {
    let h = heldHarness(openAI: .failure(.keyMissing), holdAudio: false)
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending })
    if openAIFirst {
      h.keys.release()
      await settle()
      h.speechKeys.release()
    } else {
      h.speechKeys.release()
      await settle()
      #expect(h.conversation.phase == .connecting)
      h.keys.release()
    }
    #expect(await eventually { h.conversation.phase == .ended(.keyMissing) })
    #expect(h.sockets.isEmpty && h.speechSockets.isEmpty)
    #expect(h.audio.starts == 1 && h.audio.stops >= 1)
    #expect(readyLines(h).isEmpty)
  }

  @Test("both keys refused → the speech reason, whichever refusal comes first", arguments: [true, false])
  func bothKeysRefused(openAIFirst: Bool) async {
    let h = heldHarness(openAI: .failure(.keyRejected), speech: .failure(.unavailable), holdAudio: false)
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending })
    if openAIFirst {
      h.keys.release()
      await settle()
      #expect(h.conversation.phase == .connecting)
      h.speechKeys.release()
    } else {
      h.speechKeys.release()
      await settle()
      h.keys.release()
    }
    #expect(await eventually { h.conversation.phase == .ended(.speechUnavailable) })
    await settle()
    #expect(h.conversation.phase == .ended(.speechUnavailable))
    #expect(h.sockets.isEmpty)
    #expect(h.audio.stops >= 1)
  }

  @Test("audio before session.updated: connecting, nothing appended or counted; after it listening and audio flows")
  func audioBeforeSessionUpdated() async throws {
    let h = Harness()
    h.conversation.start()
    #expect(await eventually { h.audio.handlers != nil })
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    let audio = try #require(h.audio.handlers)
    audio.input(pcm(0x4000))
    #expect(h.conversation.phase == .connecting)
    #expect(h.socket.sent("input_audio_buffer.append").isEmpty)
    h.socket.reply(sessionUpdated)
    #expect(h.conversation.phase == .listening)
    audio.input(pcm(0x2000))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
    h.conversation.end(.closed)
    // The loud input before the gate did not count: the peak is the later, quieter one.
    #expect(traceLines(h).last?.contains("mic peak 0.25") == true)
  }

  @Test("session.updated before the audio engine runs: connecting until the engine starts, then listening")
  func sessionUpdatedBeforeAudio() async throws {
    let h = Harness()
    h.audio.holdFirstStart = true
    h.conversation.start()
    #expect(await eventually { h.audio.startPending })
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    h.socket.reply(sessionUpdated)
    await settle()
    #expect(h.conversation.phase == .connecting)
    h.audio.releaseStart()
    #expect(await eventually { h.conversation.phase == .listening })
    try #require(h.audio.handlers).input(pcm(0x2000))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
  }

  @Test("the end while the engine starts stops the engine that starts late")
  func endDuringAudioStart() async {
    let h = Harness()
    h.audio.holdFirstStart = true
    h.conversation.start()
    #expect(await eventually { h.audio.startPending })
    h.conversation.end(.closed)
    let stops = h.audio.stops
    h.audio.releaseStart()
    #expect(await eventually { h.audio.stops == stops + 1 })
    #expect(h.conversation.phase == .ended(.closed))
  }

  @Test("end and a new start before the old key requests return: the old results do nothing")
  func oldKeysIgnoredAfterRestart() async {
    let h = heldHarness(holdAudio: false)
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending })
    h.conversation.end(.closed)
    h.keys.hold = false
    h.speechKeys.hold = false
    await h.ready()
    // The old requests return refusals now: neither ends the new conversation nor opens a socket.
    h.keys.result = .failure(.keyMissing)
    h.speechKeys.results = [.failure(.off)]
    h.keys.release()
    h.speechKeys.release()
    await settle()
    #expect(h.conversation.phase == .listening)
    #expect(h.sockets.count == 1 && h.speechSockets.count == 1)
  }

  @Test("one ready line with the stage times from the tap, and none again later")
  func readyLine() async throws {
    let h = heldHarness()
    h.conversation.start()
    #expect(await eventually { h.speechKeys.pending && h.keys.pending && h.audio.startPending })
    h.scheduler.advance(0.2)
    h.speechKeys.release()
    await settle()
    h.scheduler.advance(0.1)
    h.keys.release()
    #expect(await eventually { !h.sockets.isEmpty })
    h.scheduler.advance(0.4)
    h.audio.releaseStart()
    #expect(await eventually { h.audio.handlers != nil })
    await settle()
    #expect(readyLines(h).isEmpty)
    h.scheduler.advance(0.25)
    h.speechSocket.open()
    h.socket.open()
    h.socket.reply(sessionUpdated)
    #expect(h.conversation.phase == .listening)
    #expect(readyLines(h) == ["voice-agent: ready after 950 ms (keys 300 ms, session 650 ms, audio 700 ms)"])
    h.socket.reply(sessionUpdated)
    try #require(h.audio.handlers).restarted("engine configuration change", false)
    h.conversation.setMuted(true)
    h.conversation.setMuted(false)
    #expect(readyLines(h).count == 1)
  }
}
