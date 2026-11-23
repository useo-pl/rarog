import Foundation
@testable import RarogUI
import Testing

// Soniox text-to-speech client of the voice agent (`SonioxSpeech`, `SonioxSpeechFrames.swift`): text frames, the
// utterance queue, key expiry and renewal, errors as events, keepalive, the heard text from character timestamps and
// silence after `close()`. On the socket fake (`MockSocket`) and the manual clock (`ManualScheduler`) from
// `VoiceTests.swift`; no test reaches Soniox. Owner: voice agent.

private let firstKey = "snx_temp_speech_a"
private let secondKey = "snx_temp_speech_b"
private let ttsURL = URL(string: "wss://tts-rt.eu.soniox.com/tts-websocket")!
private let epoch = Date(timeIntervalSince1970: 1_800_000_000)

private func config(_ key: String = firstKey, expiresIn seconds: TimeInterval = 600, from now: TimeInterval = 0)
  -> SonioxSpeechConfig
{
  SonioxSpeechConfig(
    apiKey: key, expiresAt: epoch.addingTimeInterval(now + seconds), webSocketURL: ttsURL, model: "tts-rt-v2",
    voice: "Maya", sampleRate: 24000, language: "pl")
}

private func json(_ object: [String: Any]) -> String {
  String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
}

/// An audio frame of `samples` s16le samples, with character timestamps when given.
private func audio(_ stream: String, samples: Int = 2400, characters: [(String, Double, Double)] = []) -> String {
  var object: [String: Any] = ["stream_id": stream, "audio": Data(count: samples * 2).base64EncodedString()]
  if !characters.isEmpty {
    object["timestamps"] = [
      "characters": characters.map(\.0), "character_start_times_seconds": characters.map(\.1),
      "character_end_times_seconds": characters.map(\.2),
    ]
  }
  return json(object)
}

private func terminated(_ stream: String) -> String { json(["stream_id": stream, "terminated": true]) }

private func error(_ stream: String?, _ code: Int, _ type: String) -> String {
  var object: [String: Any] = ["error_code": code, "error_type": type, "error_message": "message from the server"]
  if let stream { object["stream_id"] = stream }
  return json(object)
}

@MainActor
private final class SpeechHarness {
  let clock = ManualScheduler()
  var sockets: [MockSocket] = []
  var events: [SonioxSpeech.Event] = []
  /// Characters reported as sent, per utterance.
  var sent: [String: Int] = [:]
  var speech: SonioxSpeech!

  init(_ first: SonioxSpeechConfig = config(), start: Bool = true, open: Bool = true) {
    let clock = clock
    speech = SonioxSpeech(
      config: first,
      connect: { [unowned self] url, protocols, events in
        let socket = MockSocket(url: url, protocols: protocols, events: events)
        self.sockets.append(socket)
        return socket
      },
      scheduler: clock, clock: { epoch.addingTimeInterval(clock.now) },
      onEvent: { [unowned self] in self.events.append($0) },
      sent: { [unowned self] utterance, characters in self.sent[utterance, default: 0] += characters })
    if start { speech.start() }
    if open { socket.open() }
  }

  var socket: MockSocket { sockets.last! }

  /// Frames sent on a socket, decoded.
  func frames(_ socket: MockSocket? = nil) -> [[String: Any]] {
    (socket ?? self.socket).texts.compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
    }
  }

  func starts(_ socket: MockSocket? = nil) -> [[String: Any]] { frames(socket).filter { $0["model"] != nil } }

  func texts(_ socket: MockSocket? = nil) -> [[String: Any]] { frames(socket).filter { $0["text"] != nil } }

  func keepalives(_ socket: MockSocket? = nil) -> Int { frames(socket).filter { $0["keep_alive"] != nil }.count }

  /// The stream id of the n-th start frame on the current socket.
  func stream(_ index: Int = 0) -> String { starts()[index]["stream_id"] as! String }

  var audioEvents: [String] {
    events.compactMap { if case let .audio(utterance, _) = $0 { utterance } else { nil } }
  }

  var finished: [String] {
    events.compactMap { if case let .finished(utterance) = $0 { utterance } else { nil } }
  }

  var keyRequests: Int { events.filter { $0 == .keyNeeded }.count }

  var failures: [SonioxSpeech.Failure] {
    events.compactMap { if case let .failed(failure) = $0 { failure } else { nil } }
  }
}

@MainActor
@Suite("voice agent: Soniox speech client")
struct SonioxSpeechTests {
  @Test("the key rides in the protocol list; the start frame carries model, voice, language, format and timestamps")
  func connectsAndStarts() throws {
    let h = SpeechHarness()
    #expect(h.socket.url == ttsURL)
    #expect(h.socket.protocols == ["soniox-api-key", firstKey])
    h.speech.append("Hello", to: "m1")
    let start = try #require(h.starts().first)
    #expect(start["model"] as? String == "tts-rt-v2")
    #expect(start["voice"] as? String == "Maya")
    #expect(start["language"] as? String == "pl")
    #expect(start["audio_format"] as? String == "pcm_s16le")
    #expect(start["sample_rate"] as? Int == 24000)
    #expect(start["return_timestamps"] as? Bool == true)
    #expect(start["api_key"] == nil)
    #expect(!h.socket.texts.joined().contains(firstKey))
  }

  @Test("the start frame always carries the reading speed of the config: 1 by default, 1.2 when chosen")
  func startFrameSpeed() throws {
    let normal = SonioxSpeechFrame.start(stream: "s1", config: config())
    #expect(normal.contains(#""speed":1,"#) || normal.contains(#""speed":1}"#), "\(normal)")
    var faster = config()
    faster.speed = 1.2
    let frame = SonioxSpeechFrame.start(stream: "s1", config: faster)
    #expect(frame.contains(#""speed":1.2"#), "\(frame)")
    let h = SpeechHarness(faster)
    h.speech.append("Hello", to: "m1")
    #expect(try #require(h.starts().first)["speed"] as? Double == 1.2)
    #expect(faster.description.contains("speed: 1.2"))
    var dumped = ""
    dump(faster, to: &dumped)
    #expect(dumped.contains("speed: 1.2"))
  }

  @Test("text goes in delta order, each frame at most 5000 characters, buffered text waits for the open socket")
  func textInDeltaOrder() {
    let h = SpeechHarness(open: false)
    h.speech.append("Zaraz ", to: "m1")
    h.speech.append("sprawdzę.", to: "m1")
    #expect(h.socket.texts.isEmpty)
    h.socket.open()
    let long = String(repeating: "ab ", count: 4000)
    h.speech.append(" Kolejne", to: "m1")
    h.speech.append(long, to: "m1")
    let texts = h.texts().map { $0["text"] as! String }
    #expect(texts.first == "Zaraz sprawdzę.")
    #expect(texts[1] == " Kolejne")
    #expect(texts.joined() == "Zaraz sprawdzę. Kolejne" + long)
    #expect(texts.allSatisfy { $0.count <= 5000 })
    #expect(texts.count == 5)
    #expect(h.texts().allSatisfy { $0["stream_id"] as? String == h.stream() && $0["text_end"] as? Bool == false })
  }

  @Test("text_end goes after the last text")
  func textEndAfterText() {
    let h = SpeechHarness()
    h.speech.append("Jedno", to: "m1")
    h.speech.append(" zdanie.", to: "m1")
    h.speech.end("m1")
    h.speech.append(" late", to: "m1")
    let texts = h.texts()
    #expect(texts.map { $0["text"] as? String } == ["Jedno", " zdanie.", ""])
    #expect(texts.map { $0["text_end"] as? Bool } == [false, false, true])
  }

  @Test("cancel cuts the stream without text_end; late audio, characters and terminated of it are dropped")
  func cancelCutsAudio() throws {
    let h = SpeechHarness()
    h.speech.append("Długa odpowiedź", to: "m1")
    let stream = h.stream()
    h.socket.reply(audio(stream, characters: [("D", 0, 0.05)]))
    #expect(h.audioEvents == ["m1"])
    h.speech.cancel("m1")
    h.speech.append(" dalej", to: "m1")
    h.speech.end("m1")
    let cancel = try #require(h.frames().last)
    #expect(cancel["cancel"] as? Bool == true)
    #expect(cancel["stream_id"] as? String == stream)
    #expect(h.texts().allSatisfy { $0["text_end"] as? Bool == false })
    #expect(h.texts().count == 1)
    let before = h.events.count
    h.socket.reply(audio(stream, characters: [("ł", 0.05, 0.1)]))
    h.socket.reply(terminated(stream))
    #expect(h.events.count == before)
    #expect(h.finished.isEmpty)
  }

  @Test("after cancel the next utterance starts on terminated of the cancelled stream; a cancelled waiting one never")
  func cancelAdvancesQueue() {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.append("Druga", to: "m2")
    h.speech.append("Trzecia", to: "m3")
    h.speech.cancel("m2")
    h.speech.cancel("m1")
    #expect(h.starts().count == 1)
    h.socket.reply(audio(h.stream()))
    #expect(h.audioEvents.isEmpty)
    h.socket.reply(terminated(h.stream()))
    #expect(h.starts().count == 2)
    #expect(h.texts().map { $0["text"] as? String } == ["Pierwsza", "Trzecia"])
    #expect(h.finished.isEmpty)
  }

  @Test("a cancelled stream without terminated holds the slot for 3 s at most, then the next utterance starts")
  func cancelWithoutTerminatedTimesOut() {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.append("Druga", to: "m2")
    h.speech.cancel("m1")
    h.clock.advance(2.9)
    #expect(h.starts().count == 1)
    h.clock.advance(0.1)
    #expect(h.starts().count == 2)
    #expect(h.failures.isEmpty)
    h.socket.reply(terminated(h.stream()))
    #expect(h.finished.isEmpty)
  }

  @Test("the second utterance starts only after terminated of the first, even when its text came earlier")
  func queueWaitsForTerminated() {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.append("Druga ", to: "m2")
    h.speech.append("cała.", to: "m2")
    h.speech.end("m2")
    h.speech.end("m1")
    #expect(h.starts().count == 1)
    let first = h.stream()
    h.socket.reply(audio(first))
    h.socket.reply(json(["stream_id": first, "audio": "", "audio_end": true]))
    #expect(h.starts().count == 1)
    h.socket.reply(terminated(first))
    #expect(h.finished == ["m1"])
    #expect(h.starts().count == 2)
    let second = h.stream(1)
    #expect(second != first)
    let secondTexts = h.texts().filter { $0["stream_id"] as? String == second }
    #expect(secondTexts.map { $0["text"] as? String } == ["Druga cała.", ""])
    #expect(secondTexts.last?["text_end"] as? Bool == true)
    h.socket.reply(audio(second))
    #expect(h.audioEvents == ["m1", "m2"])
  }

  @Test("an utterance ended without text finishes in its turn without a stream")
  func emptyUtteranceFinishesWithoutStream() {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.end("m2")
    #expect(h.finished.isEmpty)
    h.socket.reply(terminated(h.stream()))
    #expect(h.finished == ["m1", "m2"])
    #expect(h.starts().count == 1)
  }

  @Test("a key closer than 30 s to expiry before a stream asks for a new key and a new socket, the old one closed")
  func keyNearExpiryRenews() throws {
    let h = SpeechHarness(config(expiresIn: 100))
    h.clock.advance(69)
    h.speech.append("Jeszcze stary klucz", to: "m1")
    h.speech.end("m1")
    #expect(h.starts().count == 1)
    #expect(h.keyRequests == 0)
    h.socket.reply(terminated(h.stream()))
    h.clock.advance(2)
    h.speech.append("Nowy klucz", to: "m2")
    let old = h.sockets[0]
    #expect(h.keyRequests == 1)
    #expect(old.closed)
    #expect(h.starts(old).count == 1)
    #expect(h.sockets.count == 1)
    h.speech.append(" i dalej", to: "m2")
    h.speech.renew(config(secondKey, from: h.clock.now))
    #expect(h.sockets.count == 2)
    #expect(h.socket.protocols == ["soniox-api-key", secondKey])
    #expect(h.socket.texts.isEmpty)
    h.socket.open()
    #expect(h.starts().count == 1)
    #expect(h.texts().map { $0["text"] as? String } == ["Nowy klucz i dalej"])
    old.reply(audio("u1"))
    old.drop()
    #expect(h.failures.isEmpty)
  }

  @Test("a new key already within the margin is a failure, not a loop of key requests")
  func staleRenewedKeyFails() {
    let h = SpeechHarness(config(expiresIn: 20))
    h.speech.append("Tekst", to: "m1")
    #expect(h.keyRequests == 1)
    h.speech.renew(config(secondKey, expiresIn: 10))
    h.socket.open()
    #expect(h.failures == [.invalidKey])
    #expect(h.keyRequests == 1)
    #expect(h.socket.closed)
  }

  @Test("a renewed key that ages while no one speaks asks for another key, not a failure")
  func renewedKeyAgingIdleRenewsAgain() {
    let h = SpeechHarness(config(expiresIn: 20))
    h.speech.append("Tekst", to: "m1")
    h.speech.end("m1")
    #expect(h.keyRequests == 1)
    h.speech.renew(config(secondKey, expiresIn: 100, from: h.clock.now))
    h.socket.open()
    h.socket.reply(terminated(h.stream()))
    h.clock.advance(80)
    h.speech.append("Później", to: "m2")
    #expect(h.keyRequests == 2)
    #expect(h.failures.isEmpty)
  }

  @Test("an error frame that also carries terminated frees the slot at once")
  func errorWithTerminatedFreesSlot() {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.append("Druga", to: "m2")
    h.socket.reply(
      json(["stream_id": h.stream(), "error_code": 408, "error_type": "request_timeout", "terminated": true]))
    #expect(h.finished == ["m1"])
    #expect(h.starts().count == 2)
  }

  @Test("a 401 at the stream start asks for one new key; the stream starts again with its text; a second 401 fails")
  func unauthorizedRenewsOnce() {
    let h = SpeechHarness()
    h.speech.append("Odpowiedź", to: "m1")
    h.speech.end("m1")
    h.socket.reply(error(h.stream(), 401, "unauthenticated"))
    #expect(h.keyRequests == 1)
    #expect(h.sockets[0].closed)
    #expect(h.failures.isEmpty)
    h.speech.renew(config(secondKey))
    h.socket.open()
    #expect(h.texts().map { $0["text"] as? String } == ["Odpowiedź", ""])
    h.socket.reply(error(h.stream(), 401, "unauthenticated"))
    #expect(h.failures == [.unauthenticated])
    #expect(h.keyRequests == 1)
    #expect(h.socket.closed)
  }

  @Test("sent counts only text that went out in a frame, once: not the queued, cancelled text, not the resend after 401")
  func sentCountsFramedTextOnce() {
    let h = SpeechHarness(open: false)
    h.speech.append("Hello", to: "m1")
    #expect(h.sent.isEmpty)
    h.socket.open()
    #expect(h.sent == ["m1": 5])
    h.speech.append(" there", to: "m1")
    h.speech.append("Waiting", to: "m2")
    #expect(h.sent == ["m1": 11])
    h.socket.reply(error(h.stream(), 401, "unauthenticated"))
    h.speech.renew(config(secondKey))
    h.socket.open()
    // The resend on the new socket is the same text.
    #expect(h.texts().map { $0["text"] as? String } == ["Hello there"])
    #expect(h.sent == ["m1": 11])
    h.speech.cancel("m2")
    h.speech.cancel("m1")
    h.clock.advance(5)
    #expect(h.sent == ["m1": 11])
  }

  @Test("audio after a renewal resets the 401 budget")
  func audioResetsUnauthorizedBudget() {
    let h = SpeechHarness()
    h.speech.append("A", to: "m1")
    h.socket.reply(error(nil, 401, "unauthenticated"))
    h.speech.renew(config(secondKey))
    h.socket.open()
    h.socket.reply(audio(h.stream()))
    h.socket.reply(terminated(h.stream()))
    h.speech.append("B", to: "m2")
    h.socket.reply(error(h.stream(1), 401, "unauthenticated"))
    #expect(h.keyRequests == 2)
    #expect(h.failures.isEmpty)
  }

  @Test(
    "request_timeout and 403 temp_api_key_session_expired end that utterance with an error event; the queue moves on",
    arguments: [(408, "request_timeout"), (403, "temp_api_key_session_expired")])
  func streamErrorIsEvent(code: Int, type: String) {
    let h = SpeechHarness()
    h.speech.append("Pierwsza", to: "m1")
    h.speech.append("Druga", to: "m2")
    h.speech.end("m2")
    h.socket.reply(audio(h.stream()))
    h.socket.reply(error(h.stream(), code, type))
    #expect(h.failures == [.stream(utterance: "m1", code: code, type: type)])
    #expect(h.finished == ["m1"])
    #expect(h.starts().count == 1)
    h.socket.reply(terminated(h.stream()))
    #expect(h.finished == ["m1"])
    #expect(h.starts().count == 2)
    h.socket.reply(terminated(h.stream(1)))
    #expect(h.finished == ["m1", "m2"])
    #expect(!h.socket.closed)
  }

  @Test("a dropped socket is one failure event, then nothing; no new socket")
  func droppedSocketFails() {
    let h = SpeechHarness()
    h.speech.append("Tekst", to: "m1")
    h.socket.drop()
    #expect(h.failures == [.connection(code: nil, type: nil)])
    h.speech.append(" dalej", to: "m1")
    h.speech.append("Nowa", to: "m2")
    h.clock.advance(60)
    #expect(h.sockets.count == 1)
    #expect(h.events.count == 1)
    #expect(h.failures.first?.logCode == "socket-closed")
  }

  @Test("an error frame for the whole connection ends speech with its code")
  func connectionErrorFails() {
    let h = SpeechHarness()
    h.socket.reply(error(nil, 429, "max_concurrent_connections_reached"))
    #expect(h.failures == [.connection(code: 429, type: "max_concurrent_connections_reached")])
    #expect(h.socket.closed)
    #expect(h.failures.first?.logCode == "429 max_concurrent_connections_reached")
  }

  @Test("a key without the snx_temp_ prefix is never sent")
  func invalidKeyNotSent() {
    let h = SpeechHarness(config("plain-key"), open: false)
    #expect(h.sockets.isEmpty)
    #expect(h.failures == [.invalidKey])
  }

  @Test("keepalive every 20 s while no stream runs, none during a stream")
  func keepaliveBetweenStreams() {
    let h = SpeechHarness()
    h.clock.advance(19)
    #expect(h.keepalives() == 0)
    h.clock.advance(1)
    #expect(h.keepalives() == 1)
    h.clock.advance(20)
    #expect(h.keepalives() == 2)
    #expect(h.frames().last?["keep_alive"] as? Bool == true)
    h.speech.append("Mówię", to: "m1")
    h.clock.advance(60)
    #expect(h.keepalives() == 2)
    h.socket.reply(terminated(h.stream()))
    h.clock.advance(20)
    #expect(h.keepalives() == 3)
  }

  @Test("heard text = joined characters ending within the played samples, after normalization")
  func heardTextFromCharacters() throws {
    let h = SpeechHarness()
    h.speech.append("OK 👍  wysyłam", to: "m1")
    let stream = h.stream()
    // Soniox drops the emoji and folds the spaces: the characters are the spoken text.
    let spoken: [(String, Double, Double)] = [
      ("O", 0, 0.1), ("K", 0.1, 0.2), (" ", 0.2, 0.25), ("w", 0.25, 0.3), ("y", 0.3, 0.35), ("s", 0.35, 0.4),
      ("y", 0.4, 0.45), ("ł", 0.45, 0.5), ("a", 0.5, 0.55), ("m", 0.55, 0.6),
    ]
    h.socket.reply(audio(stream, samples: 4800, characters: Array(spoken[0..<4])))
    h.socket.reply(audio(stream, samples: 4800))
    h.socket.reply(audio(stream, samples: 4800, characters: Array(spoken[4...])))
    var text = SonioxSpokenText()
    for case let .characters(utterance, characters) in h.events where utterance == "m1" { text.append(characters) }
    #expect(text.heard(playedSamples: 0, sampleRate: 24000) == "")
    #expect(text.heard(playedSamples: 4800, sampleRate: 24000) == "OK")
    #expect(text.heard(playedSamples: 7200, sampleRate: 24000) == "OK w")
    #expect(text.heard(playedSamples: 14400, sampleRate: 24000) == "OK wysyłam")
    #expect(h.audioEvents.count == 3)
  }

  @Test("audio frames without timestamps add no characters")
  func audioWithoutTimestampsAddsNothing() {
    let h = SpeechHarness()
    h.speech.append("Tak", to: "m1")
    h.socket.reply(audio(h.stream(), samples: 2400, characters: [("T", 0, 0.05)]))
    h.socket.reply(audio(h.stream(), samples: 24000))
    var text = SonioxSpokenText()
    for case let .characters(_, characters) in h.events { text.append(characters) }
    #expect(text.heard(playedSamples: 1_000_000, sampleRate: 24000) == "T")
  }

  @Test("after close() nothing reaches the caller")
  func silentAfterClose() {
    let h = SpeechHarness()
    h.speech.append("Tekst", to: "m1")
    let stream = h.stream()
    h.speech.close()
    #expect(h.socket.closed)
    let sent = h.socket.texts.count
    h.socket.reply(audio(stream, characters: [("T", 0, 0.05)]))
    h.socket.reply(error(stream, 408, "request_timeout"))
    h.socket.reply(terminated(stream))
    h.socket.drop()
    h.speech.append(" dalej", to: "m1")
    h.speech.end("m1")
    h.speech.renew(config(secondKey))
    h.clock.advance(120)
    #expect(h.events.isEmpty)
    #expect(h.socket.texts.count == sent)
    #expect(h.sockets.count == 1)
  }

  @Test("close() while a key is awaited: the late key opens nothing")
  func closeWhileAwaitingKey() {
    let h = SpeechHarness(config(expiresIn: 10))
    h.speech.append("Tekst", to: "m1")
    #expect(h.keyRequests == 1)
    h.speech.close()
    h.speech.renew(config(secondKey))
    #expect(h.sockets.count == 1)
    #expect(h.events == [.keyNeeded])
  }

  @Test("the config description hides the key")
  func configHidesKey() {
    let value = config()
    #expect(!value.description.contains(firstKey))
    #expect(!String(reflecting: value).contains(firstKey))
    var dumped = ""
    dump(value, to: &dumped)
    #expect(!dumped.contains(firstKey))
    #expect(dumped.contains("Maya"))
    #expect(!Mirror(reflecting: value).children.contains { $0.label == "apiKey" })
  }
}
