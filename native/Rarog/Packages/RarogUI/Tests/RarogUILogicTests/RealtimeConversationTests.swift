import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Rozmowa głosowa z OpenAI Realtime: klucz krótki, `session.update`, synchronizacja tur,
// odtwarzanie, przerwanie mową, narzędzia, karta promptu, limity i koniec rozmowy — na atrapie HTTP, gniazda
// i silnika audio. Soniox speaks every answer, so the answer audio comes from the Soniox socket fake
// (`RealtimeHarness.say`). Prawdziwego OpenAI ani Soniox test nie woła. Właściciel: agent głosowy.

// MARK: - Atrapy

/// The ephemeral key provider (in the app: the server route): the result at once, or held until `release()`, which
/// lets every held call go; the result is read when a call returns.
@MainActor
final class RealtimeFakeKeys: RealtimeEphemeralKeyProvider {
  var result: Result<RealtimeEphemeralKey, RealtimeKeyError>
  var hold: Bool
  private(set) var calls = 0
  private var waiting: [CheckedContinuation<Void, Never>] = []

  init(
    _ result: Result<RealtimeEphemeralKey, RealtimeKeyError> = .success(
      RealtimeEphemeralKey(value: "ek_test_secret", model: "gpt-realtime-2.1")),
    hold: Bool = false
  ) {
    self.result = result
    self.hold = hold
  }

  var pending: Bool { !waiting.isEmpty }

  func release() {
    let held = waiting
    waiting = []
    for continuation in held { continuation.resume() }
  }

  func ephemeralKey() async throws(RealtimeKeyError) -> RealtimeEphemeralKey {
    calls += 1
    if hold { await withCheckedContinuation { waiting.append($0) } }
    return try result.get()
  }
}

@MainActor
final class RealtimeFakeSocket: VoiceSocket {
  let request: RealtimeSocketRequest
  let events: VoiceSocketEvents
  var texts: [String] = []
  var closed = false

  init(request: RealtimeSocketRequest, events: VoiceSocketEvents) {
    self.request = request
    self.events = events
  }

  func send(text: String) { texts.append(text) }
  func send(data: Data) {}
  func close() { closed = true }

  func open() { events.opened() }
  func reply(_ json: String) { events.message(json) }
  func drop() { events.closed() }

  /// Typy wysłanych zdarzeń, bez dopisywania dźwięku mikrofonu.
  var types: [String] {
    sent.map { $0["type"] as? String ?? "" }.filter { $0 != "input_audio_buffer.append" }
  }

  var sent: [[String: Any]] {
    texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
  }

  func sent(_ type: String) -> [[String: Any]] { sent.filter { $0["type"] as? String == type } }
}

@MainActor
final class RealtimeFakeAudio: RealtimeAudio {
  var handlers: RealtimeAudioHandlers?
  var startError: VoiceMicError?
  /// Cause the engine reports through `startFailed` before it throws `startError`.
  var startFailure: String?
  var queued: [Data] = []
  var playedSamples = 0
  var clears = 0
  var stops = 0
  var playbackVolume: Float = 1

  /// Pierwszy start czeka (zgoda na mikrofon) do `releaseStart()`.
  var holdFirstStart = false
  private(set) var starts = 0
  private var waitingStart: CheckedContinuation<Void, Never>?

  var startPending: Bool { waitingStart != nil }

  func releaseStart() {
    let continuation = waitingStart
    waitingStart = nil
    continuation?.resume()
  }

  func start(_ handlers: RealtimeAudioHandlers) async throws(VoiceMicError) {
    starts += 1
    if holdFirstStart && starts == 1 { await withCheckedContinuation { waitingStart = $0 } }
    if let startError {
      if let startFailure { handlers.startFailed(startFailure) }
      throw startError
    }
    self.handlers = handlers
  }

  func play(_ pcm: Data) { queued.append(pcm) }

  var queuedSamples: Int { queued.reduce(0) { $0 + $1.count / 2 } }

  func clearPlayback() -> Int {
    clears += 1
    queued = []
    return playedSamples
  }

  func stop() { stops += 1 }
}

// MARK: - Próbki

private func message(_ seq: Int, _ role: String, _ text: String, at: String = "2026-11-10T10:00:00.000Z")
  -> TranscriptMessage
{
  let escaped = text.replacing("\"", with: "\\\"")
  return Sample.decode(
    TranscriptMessage.self,
    #"{"seq":\#(seq),"role":"\#(role)","blocks":[{"type":"text","text":"\#(escaped)"}],"at":"\#(at)"}"#)
}

private let speechStarted = #"{"type":"input_audio_buffer.speech_started","item_id":"in1","audio_start_ms":100}"#
private let speechStopped = #"{"type":"input_audio_buffer.speech_stopped","item_id":"in1","audio_end_ms":900}"#

private func committed(_ item: String = "in1") -> String {
  #"{"type":"input_audio_buffer.committed","item_id":"\#(item)"}"#
}

private func created(_ id: String) -> String { #"{"type":"response.created","response":{"id":"\#(id)"}}"# }

private func done(_ id: String, status: String = "completed") -> String {
  #"{"type":"response.done","response":{"id":"\#(id)","status":"\#(status)","output":[]}}"#
}

/// Text of an answer item (the session answers with text; Soniox speaks it).
private func textDelta(_ response: String, item: String, _ text: String = "Answer.") -> String {
  SpeechSample.encoded(["type": "response.output_text.delta", "response_id": response, "item_id": item, "delta": text])
}

private func call(_ response: String, id: String, name: String, arguments: String = "{}") -> String {
  let args = arguments.replacing("\"", with: "\\\"")
  return
    #"{"type":"response.function_call_arguments.done","response_id":"\#(response)","item_id":"fc_\#(id)","call_id":"\#(id)","name":"\#(name)","arguments":"\#(args)"}"#
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// The samples above for the other Realtime test files (`RealtimePlaybackTests.swift`); here they stay private,
/// because other test files declare the same short names.
enum RealtimeSample {
  static let speechStarted = RarogUILogicTests.speechStarted
  static let speechStopped = RarogUILogicTests.speechStopped
  static func committed(_ item: String = "in1") -> String { RarogUILogicTests.committed(item) }
  static func created(_ id: String) -> String { RarogUILogicTests.created(id) }
  static func done(_ id: String, status: String = "completed") -> String { RarogUILogicTests.done(id, status: status) }
  static func textDelta(_ response: String, item: String, _ text: String = "Answer.") -> String {
    RarogUILogicTests.textDelta(response, item: item, text)
  }
  static func call(_ response: String, id: String, name: String, arguments: String = "{}") -> String {
    RarogUILogicTests.call(response, id: id, name: name, arguments: arguments)
  }
}

/// Frames of the Soniox socket fake (`MockSocket`): the streams the client started, and Soniox's answers.
enum SpeechSample {
  static func encoded(_ object: [String: Any]) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }

  /// Stream ids of the start frames sent on `socket`, in order.
  @MainActor
  static func streams(_ socket: MockSocket) -> [String] {
    socket.texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
      .filter { $0["model"] != nil }.compactMap { $0["stream_id"] as? String }
  }

  /// Soniox PCM for `stream`.
  static func audio(_ stream: String, _ pcm: Data) -> String {
    encoded(["stream_id": stream, "audio": pcm.base64EncodedString()])
  }

  static func terminated(_ stream: String) -> String { encoded(["stream_id": stream, "terminated": true]) }
}

/// The Soniox speech key provider of the conversation (in the app: the server route): the results in turn, the last
/// one again after them; with `hold`, each call waits for `release()` and takes its result then.
@MainActor
final class SpeechFakeKeys: SonioxSpeechKeyProvider {
  static let epoch = Date(timeIntervalSince1970: 1_800_000_000)

  var results: [Result<SonioxSpeechConfig, SonioxSpeechKeyError>]
  var hold = false
  private(set) var calls = 0
  private var waiting: [CheckedContinuation<Void, Never>] = []

  var pending: Bool { !waiting.isEmpty }

  func release() {
    let held = waiting
    waiting = []
    for continuation in held { continuation.resume() }
  }

  init(_ results: [Result<SonioxSpeechConfig, SonioxSpeechKeyError>] = [.success(SpeechFakeKeys.config())]) {
    self.results = results
  }

  /// A speech key that expires `seconds` after the start of the manual clock.
  static func config(_ key: String = "snx_temp_conversation_a", expiresIn seconds: TimeInterval = 600)
    -> SonioxSpeechConfig
  {
    SonioxSpeechConfig(
      apiKey: key, expiresAt: epoch.addingTimeInterval(seconds),
      webSocketURL: URL(string: "wss://tts-rt.eu.soniox.com/tts-websocket")!, model: "tts-rt-v2", voice: "Maya",
      sampleRate: 24000, language: "pl")
  }

  func speechKey() async throws(SonioxSpeechKeyError) -> SonioxSpeechConfig {
    calls += 1
    if hold { await withCheckedContinuation { waiting.append($0) } }
    let result = results.count > 1 ? results.removeFirst() : results[0]
    return try result.get()
  }
}

private typealias Harness = RealtimeHarness

/// Rozmowa z atrapami; `ready()` doprowadza ją do słuchania.
@MainActor
final class RealtimeHarness {
  let keys: RealtimeFakeKeys
  let audio = RealtimeFakeAudio()
  let scheduler = ManualScheduler()
  var sockets: [RealtimeFakeSocket] = []
  var messages: [TranscriptMessage]
  var phases: [RealtimeConversation.Phase] = []
  /// Prompts `show_prompt` wrote into the field and their versions, in order.
  var placed: [String] = []
  var placedVersions: [Int] = []
  var placement = RealtimePromptPlacement.alone
  var speech: [Bool] = []
  var levels: [RealtimeLevels] = []
  var diagnostics: [RealtimeConversation.Diagnostic] = []
  var asked: [String] = []
  /// Versions of the prompt each `send_prompt` asked the screen to send, in order.
  var sentVersions: [Int] = []
  var askReply: () async -> String = { #"{"answer":"It was fixed in turn 2."}"# }
  var sendReply: () async -> String = { "sent" }
  /// Soniox speech: its key provider and its sockets.
  let speechKeys: SpeechFakeKeys
  var speechSockets: [MockSocket] = []
  /// The Soniox stream of each answer item that `say` started.
  private(set) var streamOf: [String: String] = [:]
  private(set) var conversation: RealtimeConversation!

  init(
    keys: RealtimeFakeKeys = RealtimeFakeKeys(), messages: [TranscriptMessage] = [],
    speech: SpeechFakeKeys = SpeechFakeKeys()
  ) {
    self.keys = keys
    speechKeys = speech
    self.messages = messages.isEmpty ? [message(1, "user", "Fix the login bug"), message(2, "assistant", "Fixed.")] : messages
    conversation = makeConversation()
  }

  private func makeConversation() -> RealtimeConversation {
    RealtimeConversation(
    dependencies: .init(
      keys: keys,
      socket: { [unowned self] request, events in
        let socket = RealtimeFakeSocket(request: request, events: events)
        self.sockets.append(socket)
        return socket
      },
      audio: audio, scheduler: scheduler,
      speech: RealtimeConversation.Speech(
        keys: speechKeys,
        socket: { [unowned self] url, protocols, events in
          let socket = MockSocket(url: url, protocols: protocols, events: events)
          self.speechSockets.append(socket)
          return socket
        },
        clock: { [scheduler] in SpeechFakeKeys.epoch.addingTimeInterval(scheduler.now) })),
    content: .session(
      messages: { [unowned self] in self.messages },
      askSession: { [unowned self] question in
        self.asked.append(question)
        return await self.askReply()
      },
      showPrompt: { [unowned self] text, version in
        if case .refused = self.placement { return RealtimePromptShown(placement: self.placement) }
        self.placed.append(text)
        self.placedVersions.append(version)
        return RealtimePromptShown(placement: self.placement)
      },
      sendPrompt: { [unowned self] version in
        self.sentVersions.append(version)
        return await self.sendReply()
      }),
    handlers: .init(
      phase: { [unowned self] in self.phases.append($0) },
      speech: { [unowned self] in self.speech.append($0) },
      levels: { [unowned self] in self.levels.append($0) },
      diagnostic: { [unowned self] in self.diagnostics.append($0) }))
  }

  var socket: RealtimeFakeSocket { sockets[sockets.count - 1] }
  var speechSocket: MockSocket { speechSockets[speechSockets.count - 1] }

  /// Both keys and the audio engine at the start → socket → `session.update` → `session.updated` → listening.
  /// The Soniox socket opens too.
  func ready() async {
    let before = sockets.count
    conversation.start()
    #expect(await eventually { sockets.count == before + 1 })
    #expect(!speechSockets.isEmpty)
    speechSocket.open()
    socket.open()
    socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { conversation.phase == .listening })
  }

  /// Wypowiedź rozmówcy zamknięta przez VAD serwera. Over an answer that plays it is speech, not noise: it outlasts
  /// the window (`RealtimeConversation+Noise.swift`).
  func utterance(_ item: String = "in1") {
    speechStarts()
    socket.reply(speechStopped)
    socket.reply(committed(item))
  }

  /// `speech_started` of speech that goes on: over an answer that plays, the noise window passes, so the cut happens.
  func speechStarts() {
    socket.reply(speechStarted)
    if conversation.bargeInWindow != nil { scheduler.advance(RealtimeBargeIn.window) }
  }

  /// Answer `response` speaks `pcm` in its item `item`: the first call sends the item's text (Soniox starts a stream
  /// for it when no other stream runs), then Soniox returns `pcm` on the item's stream.
  func say(_ response: String, item: String, pcm: Data) {
    if streamOf[item] == nil {
      let before = SpeechSample.streams(speechSocket)
      socket.reply(textDelta(response, item: item))
      if let stream = SpeechSample.streams(speechSocket).first(where: { !before.contains($0) }) {
        streamOf[item] = stream
      }
    }
    guard let stream = streamOf[item] else { return }
    speechSocket.reply(SpeechSample.audio(stream, pcm))
  }
}

// MARK: - Testy

@MainActor
@Suite("rozmowa głosowa Realtime: połączenie, sesja, audio, narzędzia, limity")
struct RealtimeConversationTests {
  @Test("klucz krótki od dostawcy → gniazdo z tym kluczem i modelem w adresie")
  func connectsWithEphemeralKey() async {
    let h = Harness()
    h.conversation.start()
    #expect(h.conversation.phase == .connecting)
    #expect(await eventually { !h.sockets.isEmpty })
    #expect(h.keys.calls == 1)
    let socket = h.socket.request
    #expect(socket.url.absoluteString == "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1")
    #expect((socket.protocols.joined() + socket.headers.values.joined()).contains("ek_test_secret"))
  }

  @Test("klucz bez modelu → adres gniazda bez parametru modelu")
  func connectsWithoutModel() async {
    let h = Harness(keys: RealtimeFakeKeys(.success(RealtimeEphemeralKey(value: "ek_x"))))
    h.conversation.start()
    #expect(await eventually { !h.sockets.isEmpty })
    #expect(h.socket.request.url.absoluteString == "wss://api.openai.com/v1/realtime")
  }

  @Test(
    "key provider error → ended without a connection: wrong key, missing key, OpenAI limit, throttled, unavailable",
    arguments: [
      (RealtimeKeyError.keyRejected, RealtimeConversation.End.keyRejected),
      (.keyMissing, .keyMissing),
      (.limit, .openAILimit),
      (.throttled, .throttled),
      (.unavailable, .unavailable),
    ])
  func keyErrors(error: RealtimeKeyError, end: RealtimeConversation.End) async {
    let h = Harness(keys: RealtimeFakeKeys(.failure(error)))
    h.conversation.start()
    #expect(await eventually { h.conversation.phase == .ended(end) })
    #expect(h.sockets.isEmpty)
  }

  @Test("koniec rozmowy w trakcie pobierania klucza krótkiego → koniec bez połączenia, spóźniony klucz odrzucony")
  func endWhileFetchingKey() async {
    let keys = RealtimeFakeKeys(hold: true)
    let h = Harness(keys: keys)
    h.conversation.start()
    #expect(await eventually { keys.pending })
    h.conversation.end(.closed)
    #expect(h.conversation.phase == .ended(.closed))
    keys.release()
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.sockets.isEmpty)
    #expect(h.conversation.phase == .ended(.closed))
  }

  @Test("session.update: instrukcje z projekcją, trzy narzędzia, server_vad bez samodzielnej odpowiedzi, pcm 24 kHz")
  func sessionUpdate() async throws {
    let h = Harness()
    h.conversation.start()
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    let update = try #require(h.socket.sent("session.update").first)
    let session = try #require(update["session"] as? [String: Any])
    #expect(session["type"] as? String == "realtime")
    #expect(session["model"] == nil)
    let instructions = try #require(session["instructions"] as? String)
    #expect(instructions.contains("<transcript>\n### Turn 1 · 2026-11-10T10:00:00.000Z\nUSER: Fix the login bug"))
    #expect(instructions.contains("AGENT: Fixed."))
    #expect(instructions.contains("Answer in the language the user speaks"))
    let tools = try #require(session["tools"] as? [[String: Any]])
    #expect(tools.compactMap { $0["name"] as? String } == ["ask_session", "show_prompt", "send_prompt"])
    let audio = try #require(session["audio"] as? [String: Any])
    let input = try #require(audio["input"] as? [String: Any])
    let vad = try #require(input["turn_detection"] as? [String: Any])
    #expect(vad["type"] as? String == "server_vad")
    #expect(vad["silence_duration_ms"] as? Int == 500)
    #expect(vad["create_response"] as? Bool == false)
    #expect(vad["interrupt_response"] as? Bool == false)
    #expect((input["format"] as? [String: Any])?["rate"] as? Int == 24000)
    #expect((input["format"] as? [String: Any])?["type"] as? String == "audio/pcm")
    // The conversation listens only after the configuration is confirmed.
    #expect(h.conversation.phase == .connecting)
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.conversation.phase == .listening })
  }

  @Test("conversation start sends a text-only session.update: no output audio and no OpenAI voice")
  func sessionUpdateTextOnly() async throws {
    let h = Harness()
    h.conversation.start()
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    let update = try #require(h.socket.sent("session.update").first)
    let session = try #require(update["session"] as? [String: Any])
    #expect(session["output_modalities"] as? [String] == ["text"])
    let audio = try #require(session["audio"] as? [String: Any])
    #expect(audio["output"] == nil)
    #expect(session["voice"] == nil)
    #expect(!h.socket.texts.joined().contains(#""voice""#))
  }

  @Test("mikrofon: PCM z silnika → input_audio_buffer.append w base64")
  func microphoneAppends() async throws {
    let h = Harness()
    await h.ready()
    let handlers = try #require(h.audio.handlers)
    handlers.input(Data([1, 0, 2, 0]))
    let append = try #require(h.socket.sent("input_audio_buffer.append").last)
    #expect(append["audio"] as? String == Data([1, 0, 2, 0]).base64EncodedString())
  }

  @Test("błąd limitu instrukcji → jedna próba z połową budżetu, druga porażka → koniec")
  func instructionsTooLongRetriesOnce() async throws {
    let long = (1...400).flatMap { index in
      [message(index * 2, "user", "question \(index) " + String(repeating: "q", count: 300)),
       message(index * 2 + 1, "assistant", "answer \(index) " + String(repeating: "a", count: 400))]
    }
    let h = Harness(messages: long)
    h.conversation.start()
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    let tooLong =
      #"{"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"Instructions are too long: 68224 tokens, the maximum is 65536 tokens.","param":"session.instructions"}}"#
    h.socket.reply(tooLong)
    let updates = h.socket.sent("session.update")
    #expect(updates.count == 2)
    let first = try #require((updates[0]["session"] as? [String: Any])?["instructions"] as? String)
    let second = try #require((updates[1]["session"] as? [String: Any])?["instructions"] as? String)
    #expect(second.count < first.count)
    #expect(second.contains("[Omitted: turns 1–"))
    h.socket.reply(tooLong)
    #expect(h.conversation.phase == .ended(.instructionsTooLong))
    #expect(h.socket.sent("session.update").count == 2)
    #expect(h.socket.closed)
  }

  @Test("nowa tura w store → conversation.item.create po committed, przed response.create")
  func newTurnsBeforeResponse() async throws {
    let h = Harness()
    await h.ready()
    h.messages.append(message(3, "user", "Now add tests"))
    h.messages.append(message(4, "assistant", "Tests added, key sk-EXAMPLEexampleEXAMPLEexample1234"))
    h.utterance()
    #expect(h.socket.types.suffix(2) == ["conversation.item.create", "response.create"])
    let item = try #require(h.socket.sent("conversation.item.create").last?["item"] as? [String: Any])
    #expect(item["role"] as? String == "system")
    let text = try #require((item["content"] as? [[String: Any]])?.first?["text"] as? String)
    #expect(text.contains("### Turn 2 · 2026-11-10T10:00:00.000Z\nUSER: Now add tests"))
    #expect(text.contains("AGENT: Tests added, key [secret]"))
    #expect(!text.contains("Fix the login bug"))
    // The first answer is over (an order still waiting for its response.created would hold the next one for the
    // fixes, `RealtimeConversation+SpeechBargeIn.swift`).
    h.socket.reply(created("r1"))
    h.socket.reply(done("r1"))
    // Bez nowych tur: sama odpowiedź, bez elementu.
    h.utterance("in2")
    #expect(h.socket.sent("conversation.item.create").count == 1)
    #expect(h.socket.sent("response.create").count == 2)
  }

  @Test("function_call ask_session → callback → function_call_output + response.create po response.done")
  func askSessionTool() async throws {
    let h = Harness()
    var release: CheckedContinuation<String, Never>?
    h.askReply = { await withCheckedContinuation { release = $0 } }
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"Why did the login fail?"}"#))
    #expect(await eventually { release != nil })
    #expect(h.asked == ["Why did the login fail?"])
    #expect(h.conversation.phase == .checkingSession)
    // Wynik jest, ale odpowiedź jeszcze trwa: nic nie wychodzi przed response.done.
    release?.resume(returning: #"{"answer":"It was fixed in turn 2."}"#)
    try? await Task.sleep(for: .milliseconds(10))
    #expect(h.socket.sent("conversation.item.create").isEmpty)
    let before = h.socket.sent("response.create").count
    h.socket.reply(done("r1"))
    #expect(await eventually { !h.socket.sent("conversation.item.create").isEmpty })
    let item = try #require(h.socket.sent("conversation.item.create").last?["item"] as? [String: Any])
    #expect(item["type"] as? String == "function_call_output")
    #expect(item["call_id"] as? String == "c1")
    #expect(item["output"] as? String == #"{"answer":"It was fixed in turn 2."}"#)
    #expect(h.socket.types.last == "response.create")
    #expect(h.socket.sent("response.create").count == before + 1)
  }

  @Test("odpowiedź narzędzia przechodzi przez maskę sekretów")
  func askSessionMasked() async throws {
    let h = Harness()
    h.askReply = { "token ghp_000000000000000000000000000000000000 leaked" }
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"q"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { !h.socket.sent("conversation.item.create").isEmpty })
    let item = try #require(h.socket.sent("conversation.item.create").last?["item"] as? [String: Any])
    #expect(item["output"] as? String == "token [secret] leaked")
  }

  @Test("wynik narzędzia po przerwaniu mową → odrzucony, bez response.create")
  func toolResultAfterBargeInDropped() async throws {
    let h = Harness()
    var release: CheckedContinuation<String, Never>?
    h.askReply = { await withCheckedContinuation { release = $0 } }
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"q"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { release != nil })
    let responses = h.socket.sent("response.create").count
    h.socket.reply(speechStarted)
    release?.resume(returning: "late answer")
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.socket.sent("conversation.item.create").isEmpty)
    #expect(h.socket.sent("response.create").count == responses)
  }

  @Test("wynik narzędzia ze starej generacji (rozmowa zamknięta i otwarta na nowo) → odrzucony")
  func toolResultFromOldGenerationDropped() async throws {
    let h = Harness()
    var release: CheckedContinuation<String, Never>?
    h.askReply = { await withCheckedContinuation { release = $0 } }
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"q"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { release != nil })
    let old = h.socket
    h.conversation.end(.closed)
    #expect(old.closed)
    #expect(h.audio.stops >= 1)
    await h.ready()
    #expect(h.sockets.count == 2)
    release?.resume(returning: "late answer")
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.socket.sent("conversation.item.create").isEmpty)
    #expect(old.sent("conversation.item.create").isEmpty)
    #expect(h.socket.sent("response.create").isEmpty)
  }

  @Test("delta and show_prompt of a response interrupted by speech → dropped, nothing written into the field")
  func cardFromInterruptedResponseDropped() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(speechStarted)
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(textDelta("r1", item: "m1"))
    #expect(h.conversation.fieldPrompt == nil)
    #expect(h.placed.isEmpty)
    #expect(SpeechSample.streams(h.speechSocket).isEmpty)
    #expect(h.audio.queued.isEmpty)
    h.socket.reply(done("r1", status: "cancelled"))
    #expect(h.socket.sent("conversation.item.create").isEmpty)
  }

  @Test("show_prompt → prompt in the field with a version; send_prompt in the same response → tool error, nothing sent")
  func sendPromptSameResponseRefused() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(call("r1", id: "c2", name: "send_prompt"))
    #expect(h.conversation.fieldPrompt == 1)
    #expect(h.placed == ["Run the tests"])
    h.socket.reply(done("r1"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 2 })
    let outputs = h.socket.sent("conversation.item.create").compactMap { $0["item"] as? [String: Any] }
    #expect(outputs.map { $0["call_id"] as? String } == ["c1", "c2"])
    #expect((outputs[1]["output"] as? String)?.contains("error") == true)
    #expect(h.sentVersions.isEmpty)
    #expect(h.socket.types.last == "response.create")
  }

  @Test("send_prompt without a prompt → error; after the prompt and a new utterance → its version, not the argument")
  func sendPromptAfterConfirmation() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r0"))
    h.socket.reply(call("r0", id: "c0", name: "send_prompt", arguments: #"{"text":"rm -rf"}"#))
    h.socket.reply(done("r0"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 1 })
    #expect(h.sentVersions.isEmpty)
    // Odpowiedź modelu na wynik narzędzia (zamówiona przez apkę po wyniku).
    h.socket.reply(created("r0f"))
    h.socket.reply(done("r0f"))
    h.utterance("in2")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 2 })
    // Model woła wysyłkę w kolejnej odpowiedzi, ale rozmówca jeszcze nic nie powiedział.
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(done("r2"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 3 })
    #expect(h.sentVersions.isEmpty)
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    // „Tak, wyślij”.
    h.utterance("in3")
    h.socket.reply(created("r3"))
    h.socket.reply(call("r3", id: "c3", name: "send_prompt", arguments: #"{"text":"something else"}"#))
    h.socket.reply(done("r3"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 4 })
    #expect(h.sentVersions == [1])
    let last = try #require(h.socket.sent("conversation.item.create").last?["item"] as? [String: Any])
    #expect(last["output"] as? String == "sent")
  }

  @Test("a new prompt takes the place of the old one: the version grows, the utterance count starts again")
  func newCardReplacesOld() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"A"}"#))
    h.socket.reply(done("r1"))
    h.socket.reply(created("r1f"))
    h.socket.reply(done("r1f"))
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "show_prompt", arguments: #"{"text":"B"}"#))
    h.socket.reply(call("r2", id: "c3", name: "send_prompt"))
    h.socket.reply(done("r2"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 3 })
    #expect(h.conversation.fieldPrompt == 2)
    #expect(h.placedVersions == [1, 2])
    #expect(h.sentVersions.isEmpty)
  }

  @Test("the prompt left the field → send_prompt hears so and the screen is not asked; a new prompt is live again")
  func promptLeftFieldRefusesSend() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"A"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 1 })
    h.socket.reply(created("r1f"))
    h.socket.reply(done("r1f"))
    h.conversation.promptLeftField()
    #expect(h.conversation.fieldPrompt == nil)
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(done("r2"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 2 })
    let output = try #require(h.socket.sent("conversation.item.create").last?["item"] as? [String: Any])
    #expect((output["output"] as? String)?.contains("no longer holds your prompt") == true)
    #expect(h.sentVersions.isEmpty)
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    h.utterance("in3")
    h.socket.reply(created("r3"))
    h.socket.reply(call("r3", id: "c3", name: "show_prompt", arguments: #"{"text":"B"}"#))
    h.socket.reply(done("r3"))
    #expect(await eventually { h.socket.sent("conversation.item.create").count == 3 })
    #expect(h.conversation.fieldPrompt == 2)
  }

  @Test("error with the OpenAI limit (TPM) → ended with “OpenAI limit”, no retry")
  func rateLimitError() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    let sentBefore = h.socket.texts.count
    h.socket.reply(
      #"{"type":"error","error":{"type":"tokens","code":"rate_limit_exceeded","message":"Rate limit reached for tokens per min (TPM)"}}"#)
    #expect(h.conversation.phase == .ended(.openAILimit))
    #expect(h.socket.closed)
    #expect(h.audio.stops >= 1)
    #expect(h.socket.texts.count == sentBefore)
    h.socket.reply(committed("in9"))
    #expect(h.socket.texts.count == sentBefore)
  }

  @Test("response.done failed z limitem → koniec „limit OpenAI”")
  func rateLimitInResponse() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(
      #"{"type":"response.done","response":{"id":"r1","status":"failed","status_details":{"type":"failed","error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}}}"#)
    #expect(h.conversation.phase == .ended(.openAILimit))
  }

  @Test("inny błąd w trakcie rozmowy → diagnostyka z kodem, rozmowa trwa; zerwane gniazdo → koniec")
  func otherErrorAndDrop() async {
    let h = Harness()
    await h.ready()
    h.socket.reply(#"{"type":"error","error":{"type":"invalid_request_error","code":"unknown_parameter","message":"x"}}"#)
    #expect(h.conversation.phase == .listening)
    #expect(h.diagnostics.contains(.serverError(code: "unknown_parameter")))
    h.socket.drop()
    #expect(h.conversation.phase == .ended(.dropped))
    #expect(h.audio.stops >= 1)
  }

  @Test("microphone refused at the start → the end with its reason, no socket left open")
  func microphoneDenied() async {
    let h = Harness()
    h.audio.startError = .denied
    h.conversation.start()
    #expect(await eventually { h.conversation.phase == .ended(.microphone(.denied)) })
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.sockets.allSatisfy { $0.closed })
  }

  /// Regression: "microphone-failed" in `client.log` said nothing about the step or the system code (-10875 on a Mac
  /// was found only in the system log).
  @Test("engine start failure: the cause line goes to client.log before the end line")
  func audioStartFailureCause() async {
    let h = Harness()
    h.audio.startError = .failed
    h.audio.startFailure = "engine start -10875"
    h.conversation.start()
    #expect(await eventually { h.conversation.phase == .ended(.microphone(.failed)) })
    let cause = h.diagnostics.firstIndex(of: .audioStartFailed(cause: "engine start -10875"))
    let end = h.diagnostics.firstIndex { if case .ended = $0 { true } else { false } }
    #expect(cause != nil)
    #expect(cause.map { c in end.map { c < $0 } ?? true } == true)
  }

  @Test("przerwanie audio przez system → koniec rozmowy")
  func audioInterrupted() async throws {
    let h = Harness()
    await h.ready()
    try #require(h.audio.handlers).interrupted("engine configuration change")
    #expect(h.conversation.phase == .ended(.audioInterrupted))
    #expect(h.diagnostics.contains(.audioInterrupted(cause: "engine configuration change")))
    #expect(RealtimeConversation.Diagnostic.audioInterrupted(cause: "x").traceLine == "voice-agent: audio ended by x")
    #expect(h.socket.closed)
  }

  @Test("restart silnika po zmianie konfiguracji → rozmowa trwa, wpis do logu")
  func audioRestarted() async throws {
    let h = Harness()
    await h.ready()
    try #require(h.audio.handlers).restarted("engine configuration change", false)
    #expect(h.conversation.phase == .listening)
    #expect(!h.socket.closed)
    #expect(h.diagnostics.contains(.audioRestarted(cause: "engine configuration change")))
    #expect(RealtimeConversation.Diagnostic.audioRestarted(cause: "x").traceLine == "voice-agent: audio restarted after x")
  }

  @Test("the end closes the socket and audio and forgets the prompt; events after the end do nothing")
  func endClosesEverything() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"A"}"#))
    h.conversation.end(.closed)
    #expect(h.socket.closed)
    #expect(h.audio.stops >= 1)
    #expect(h.conversation.fieldPrompt == nil)
    #expect(h.speech.last == false)
    let count = h.socket.texts.count
    h.socket.reply(textDelta("r1", item: "m1"))
    h.socket.reply(done("r1"))
    #expect(h.socket.texts.count == count)
    #expect(h.audio.queued.isEmpty)
  }

  @Test("send_prompt called right before the end of the conversation → the screen is not asked to send")
  func sendPromptNotRunAfterEnd() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.conversation.end(.closed)
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.sentVersions.isEmpty)
  }

  @Test("a tool called right before the user's speech → its callback is not called")
  func toolNotRunAfterBargeIn() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(call("r2", id: "c3", name: "ask_session", arguments: #"{"question":"q"}"#))
    h.socket.reply(speechStarted)
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.sentVersions.isEmpty)
    #expect(h.asked.isEmpty)
  }

  @Test("start audio starej generacji wraca po nowym starcie → nie zatrzymuje silnika nowej rozmowy")
  func staleAudioStartDoesNotStopNewOne() async {
    let h = Harness()
    h.audio.holdFirstStart = true
    h.conversation.start()
    #expect(await eventually { h.sockets.count == 1 })
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.audio.startPending })
    h.conversation.end(.closed)
    await h.ready()
    let stops = h.audio.stops
    h.audio.releaseStart()
    try? await Task.sleep(for: .milliseconds(30))
    #expect(h.audio.stops == stops)
    #expect(h.conversation.phase == .listening)
  }

  @Test("odpowiedź zamówiona przed mową rozmówcy, a utworzona po niej → anulowana, jej audio i narzędzia odrzucone")
  func responseOrderedBeforeBargeInDropped() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(speechStarted)
    h.socket.reply(created("r1"))
    let cancel = try #require(h.socket.sent("response.cancel").last)
    #expect(cancel["response_id"] as? String == "r1")
    h.socket.reply(textDelta("r1", item: "m1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"A"}"#))
    #expect(SpeechSample.streams(h.speechSocket).isEmpty)
    #expect(h.conversation.fieldPrompt == nil)
    h.socket.reply(done("r1", status: "cancelled"))
    #expect(h.socket.sent("conversation.item.create").isEmpty)
    // Odpowiedź na nową wypowiedź jest przyjmowana.
    h.socket.reply(speechStopped)
    h.socket.reply(committed("in2"))
    h.socket.reply(created("r2"))
    h.say("r2", item: "m2", pcm: Data(count: 4800))
    #expect(h.audio.queuedSamples == 2400)
  }

  @Test("conversation_already_has_active_response po response.create → ponowienie po response.done, bez zawieszenia w „myśli”")
  func activeResponseRetried() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    #expect(h.socket.sent("response.create").count == 1)
    h.socket.reply(
      #"{"type":"error","error":{"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"Conversation already has an active response"}}"#)
    h.socket.reply(done("r0", status: "cancelled"))
    #expect(h.socket.sent("response.create").count == 2)
    #expect(h.conversation.phase == .thinking)
    h.socket.reply(created("r1"))
    h.socket.reply(done("r1"))
    #expect(h.conversation.phase == .listening)
    #expect(h.socket.sent("response.create").count == 2)
  }

  @Test("opis klucza krótkiego i żądania gniazda nie zawiera klucza")
  func noKeyInDescriptions() {
    let key = RealtimeEphemeralKey(value: "ek_secret", model: "m")
    #expect(!String(describing: key).contains("ek_secret"))
    #expect(!String(reflecting: key).contains("ek_secret"))
    for auth in [RealtimeEndpoint.SocketAuth.subprotocol, .header] {
      let request = RealtimeEndpoint.socketRequest(model: "m", secret: "ek_secret", auth: auth)
      #expect(!String(describing: request).contains("ek_secret"))
    }
  }
}

@Suite("rozmowa głosowa Realtime: droga klucza krótkiego i PCM")
struct RealtimeTransportTests {
  @Test("klucz krótki w protokołach WebSocket albo w nagłówku — jedna stała wybiera")
  func socketAuth() {
    let protocols = RealtimeEndpoint.socketRequest(model: "gpt-realtime-2.1", secret: "ek_1", auth: .subprotocol)
    #expect(protocols.protocols == ["realtime", "openai-insecure-api-key.ek_1"])
    #expect(protocols.headers.isEmpty)
    let header = RealtimeEndpoint.socketRequest(model: "gpt-realtime-2.1", secret: "ek_1", auth: .header)
    #expect(header.protocols.isEmpty)
    #expect(header.headers == ["Authorization": "Bearer ek_1"])
    #expect(RealtimeEndpoint.socketAuth == .subprotocol)
  }

  @Test("PCM: Float → s16le → Float, przester przycięty")
  func pcmRoundTrip() {
    let data = RealtimePCM.int16Data([0, 1, -1, 2, 0.5])
    #expect(data.count == 10)
    let back = RealtimePCM.floats(data)
    #expect(back.count == 5)
    #expect(back[1] == 1)
    #expect(back[2] == -1)
    #expect(back[3] == 1)
    #expect(abs(back[4] - 0.5) < 0.001)
    #expect(RealtimeAudioFormat.milliseconds(samples: 36_000) == 1500)
  }

  /// Regression: on a Mac voice processing gave a 48 kHz input and the mixer went to the speaker at 44.1 kHz, so every
  /// voice agent start failed with -10875 ("microphone-failed").
  @Test("mixer → speaker: the input sample rate with the speaker channels when the rates differ, else the default")
  func speakerFormat() throws {
    let mac = try #require(RealtimeAudioFormat.speakerFormat(inputRate: 48_000, mixerRate: 44_100, speakerChannels: 2))
    #expect(mac.sampleRate == 48_000)
    #expect(mac.channelCount == 2)
    #expect(RealtimeAudioFormat.speakerFormat(inputRate: 48_000, mixerRate: 48_000, speakerChannels: 2) == nil)
    #expect(RealtimeAudioFormat.speakerFormat(inputRate: 0, mixerRate: 44_100, speakerChannels: 2) == nil)
    #expect(RealtimeAudioFormat.speakerFormat(inputRate: 48_000, mixerRate: 44_100, speakerChannels: 0)?.channelCount == 1)
  }

  @Test("klasyfikacja błędów: limit, instrukcje za długie, wyścig odpowiedzi, reszta")
  func errorKinds() {
    #expect(RealtimeServerError(type: "tokens", code: "rate_limit_exceeded").kind == .rateLimit)
    #expect(RealtimeServerError(message: "Rate limit reached for tokens per min (TPM)").kind == .rateLimit)
    #expect(
      RealtimeServerError(message: "Instructions exceed the maximum of 65536 tokens", param: "session.instructions").kind
        == .instructionsTooLong)
    #expect(RealtimeServerError(code: "conversation_already_has_active_response").kind == .activeResponse)
    #expect(RealtimeServerError(code: "unknown_parameter", message: "Unknown parameter").kind == .other)
  }
}

// MARK: - Usage and events in client.log

extension RealtimeConversationTests {
  private func lines(_ h: Harness) -> [String] { h.diagnostics.map(\.traceLine) }

  private func summary(_ h: Harness) -> RealtimeConversation.EndSummary? {
    h.diagnostics.lazy.compactMap { if case let .ended(summary) = $0 { summary } else { nil } }.last
  }

  @Test("measured response.done usage → a line per response with its cost; the end line sums both")
  func usageLines() async throws {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(MeasuredUsage.done("r2", usage: MeasuredUsage.second))
    h.scheduler.advance(12.5)
    h.conversation.end(.closed)
    let lines = lines(h)
    #expect(lines.contains(
      "voice-agent: response 1 completed: text in 42000 (cached 41920), audio in 412 (cached 320), out text 173, $0.0243"))
    #expect(lines.contains(
      "voice-agent: response 2 completed: text in 42233 (cached 41984), audio in 412 (cached 384), out text 178, $0.0231"))
    #expect(lines.last
      == "voice-agent: ended closed after 12.5 s: 2 responses (0 without usage), speech 2, mic peak 0.00, ask 0, send 0, "
        + "$0.0474, tts chars 0 audio 0 ms $0.0000")
    let total = try #require(summary(h)?.cost)
    #expect(abs(total - MeasuredUsage.exchangeCost) < 1e-12)
  }

  @Test("repeated response.done of one response → one line, counted once")
  func repeatedDone() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    h.socket.reply(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    h.conversation.end(.closed)
    #expect(lines(h).filter { $0.hasPrefix("voice-agent: response ") }.count == 1)
    #expect(summary(h)?.responses == 1)
    #expect(lines(h).last?.hasSuffix("send 0, $0.0243, tts chars 0 audio 0 ms $0.0000") == true)
  }

  @Test("cancelled response with usage is priced; failed without usage → no usage, total partial")
  func cancelledAndFailed() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", status: "cancelled", usage: MeasuredUsage.first))
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(MeasuredUsage.done("r2", status: "failed"))
    h.conversation.end(.closed)
    let lines = lines(h)
    #expect(lines.contains { $0.hasPrefix("voice-agent: response 1 cancelled: text in 42000 ") && $0.hasSuffix(", $0.0243") })
    #expect(lines.contains("voice-agent: response 2 failed: no usage"))
    #expect(lines.last?.contains(": 2 responses (1 without usage),") == true)
    #expect(lines.last?.hasSuffix(", $0.0243 partial, tts chars 0 audio 0 ms $0.0000") == true)
  }

  @Test("usage with totals but no details → no usage line, total partial")
  func usageTotalsWithoutDetails() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", usage: #"{"total_tokens":100,"input_tokens":80,"output_tokens":20}"#))
    h.conversation.end(.closed)
    #expect(lines(h).contains("voice-agent: response 1 completed: no usage"))
    #expect(summary(h)?.withoutUsage == 1)
    #expect(
      lines(h).last?.hasSuffix(
        ": 1 responses (1 without usage), speech 1, mic peak 0.00, ask 0, send 0, $0.0000 partial, tts chars 0 audio 0 ms "
          + "$0.0000") == true)
  }

  @Test("end before response.done (response created or only ordered) → total partial; no response → not partial")
  func endBeforeDone() async {
    let open = Harness()
    await open.ready()
    open.utterance()
    open.socket.reply(created("r1"))
    open.conversation.end(.closed)
    #expect(
      lines(open).last?.hasSuffix(
        ": 0 responses (0 without usage), speech 1, mic peak 0.00, ask 0, send 0, $0.0000 partial, tts chars 0 audio 0 "
          + "ms $0.0000") == true)

    let ordered = Harness()
    await ordered.ready()
    ordered.utterance()
    ordered.conversation.end(.closed)
    #expect(summary(ordered)?.partial == true)

    let quiet = Harness()
    await quiet.ready()
    quiet.conversation.end(.closed)
    #expect(summary(quiet)?.partial == false)
    #expect(lines(quiet).last?.hasSuffix("send 0, $0.0000, tts chars 0 audio 0 ms $0.0000") == true)
  }

  @Test("model outside the price table → tokens without a price, end line without a total")
  func unpricedModel() async {
    let h = Harness(keys: RealtimeFakeKeys(.success(RealtimeEphemeralKey(value: "ek_x", model: "gpt-realtime-9"))))
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    h.conversation.end(.closed)
    let lines = lines(h)
    #expect(lines.contains(
      "voice-agent: response 1 completed: text in 42000 (cached 41920), audio in 412 (cached 320), out text 173"))
    #expect(!lines.dropLast().contains { $0.contains("$") })
    #expect(
      lines.last?.hasSuffix(
        ": 1 responses (0 without usage), speech 1, mic peak 0.00, ask 0, send 0, tts chars 0 audio 0 ms $0.0000") == true,
      "only the Soniox estimate carries a price")
  }

  @Test("session model, audio start, speech events, mic peak, tool calls and the end reason, never the text")
  func conversationEvents() async throws {
    let h = Harness()
    await h.ready()
    h.socket.reply(#"{"type":"session.created","session":{"model":"gpt-realtime-2.1","instructions":"secret words"}}"#)
    let audio = try #require(h.audio.handlers)
    audio.started("in MicrophoneBuiltIn 48000 Hz 1 ch, out Speaker")
    audio.input(Data([0x00, 0x40, 0x00, 0xC0]))
    h.utterance()
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"What failed?"}"#))
    h.socket.reply(call("r1", id: "c2", name: "send_prompt"))
    h.scheduler.advance(3)
    h.socket.drop()
    let lines = lines(h)
    #expect(lines.contains("voice-agent: session gpt-realtime-2.1"))
    #expect(lines.contains("voice-agent: audio started (in MicrophoneBuiltIn 48000 Hz 1 ch, out Speaker)"))
    #expect(lines.contains("voice-agent: speech started") && lines.contains("voice-agent: speech stopped"))
    #expect(
      lines.last == "voice-agent: ended dropped after 3.0 s: 0 responses (0 without usage), speech 1, mic peak 0.50, "
        + "ask 1, send 1, $0.0000 partial, tts chars 0 audio 0 ms $0.0000")
    #expect(!lines.contains { $0.contains("secret") || $0.contains("What failed") })
    #expect(RealtimeConversation.Diagnostic.session(model: nil).traceLine == "voice-agent: session unknown")
  }

  @Test("end without a connection (key error) → one end line with the reason, no price without a model")
  func endLineWithoutConnection() async {
    let h = Harness(keys: RealtimeFakeKeys(.failure(.keyMissing)))
    h.conversation.start()
    #expect(await eventually { h.conversation.phase == .ended(.keyMissing) })
    #expect(
      lines(h).filter { $0.hasPrefix("voice-agent: ended ") }
        == [
          "voice-agent: ended key-missing after 0.0 s: 0 responses (0 without usage), speech 0, mic peak 0.00, ask 0, "
            + "send 0, tts chars 0 audio 0 ms $0.0000"
        ])
  }

  @Test("an end the app caused names it in the end line")
  func endLineDetail() async {
    let h = Harness()
    await h.ready()
    h.conversation.end(.closed, detail: "field-hidden")
    #expect(summary(h)?.traceLine.hasPrefix("voice-agent: ended closed (field-hidden) after ") == true)
  }
}

// MARK: - Levels for the voice agent button

/// PCM s16le with every sample at `value`.
private func loudPCM(_ samples: Int, value: Int16 = 8192) -> Data {
  var data = Data(capacity: samples * 2)
  for _ in 0..<samples { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  return data
}

/// Levels of the conversation (`RealtimeConversation+Levels.swift`): output on the playback axis, input peak since
/// the last event, at most one event per interval, zero at barge-in, restart and end.
@MainActor
@Suite("voice conversation: levels for the button bars")
struct RealtimeLevelsTests {
  @Test("3 s of queued output do not move the bars before they play; the playing part does")
  func outputFollowsPlayedSamples() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: loudPCM(72_000, value: 16384))
    h.scheduler.advance(RealtimeLevelMeter.interval * 3)
    #expect(h.levels.allSatisfy { $0.output == 0 })
    h.audio.playedSamples = 1200
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.output == 0.5)
  }

  @Test("microphone: the peak since the last event; silence lowers it by a fifth per event down to rest, then no events")
  func inputPeakSinceLastEvent() async throws {
    let h = Harness()
    await h.ready()
    let handlers = try #require(h.audio.handlers)
    handlers.input(loudPCM(480, value: 4096))
    handlers.input(loudPCM(480, value: 16384))
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last == RealtimeLevels(input: 0.5, output: 0))
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last == RealtimeLevels(input: 0.4, output: 0), "the shown level falls, it does not jump")
    h.scheduler.advance(2)
    #expect(h.levels.last == .zero, "silence brings the level to rest")
    let falling = h.levels.map(\.input)
    #expect(zip(falling, falling.dropFirst()).allSatisfy { $0 > $1 })
    let count = h.levels.count
    h.scheduler.advance(1)
    #expect(h.levels.count == count, "silence at rest costs no events")
  }

  @Test("loud output, then the answer stops: the output level falls to rest as well")
  func outputFallsToRest() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: loudPCM(1200, value: 16384))
    h.audio.playedSamples = 1200
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.output == 0.5)
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.output == 0.4)
    h.scheduler.advance(2)
    #expect(h.levels.last == .zero)
  }

  @Test("one level event per interval however many chunks arrive; every chunk still goes to OpenAI")
  func throttledWithoutLosingAudio() async throws {
    let h = Harness()
    await h.ready()
    let handlers = try #require(h.audio.handlers)
    let appended = h.socket.sent("input_audio_buffer.append").count
    for index in 0..<100 { handlers.input(loudPCM(240, value: Int16(100 + index))) }
    #expect(h.levels.isEmpty)
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.count == 1)
    #expect(h.socket.sent("input_audio_buffer.append").count == appended + 100)
    h.scheduler.advance(1)
    #expect(h.levels.count <= 2 + Int(1 / RealtimeLevelMeter.interval))
  }

  @Test("barge-in, engine restart and the end zero both levels")
  func zeroOnBargeInRestartAndStop() async throws {
    let h = Harness()
    await h.ready()
    let handlers = try #require(h.audio.handlers)
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: loudPCM(24_000, value: 16384))
    h.audio.playedSamples = 1200
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.output == 0.5)
    h.speechStarts()
    #expect(h.levels.last == .zero)

    handlers.input(loudPCM(480))
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.input == 0.25)
    handlers.restarted("engine configuration change", false)
    #expect(h.levels.last == .zero)

    handlers.input(loudPCM(480))
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.input == 0.25)
    h.conversation.end(.closed)
    #expect(h.levels.last == .zero)
    let count = h.levels.count
    h.scheduler.advance(1)
    #expect(h.levels.count == count)
  }

  @Test("the meter alone: the peak of the played range only, played chunks dropped")
  func meter() {
    var meter = RealtimeLevelMeter(played: 0)
    meter.queued(loudPCM(100, value: 1000), at: 0)
    meter.queued(loudPCM(100, value: 32767), at: 100)
    #expect(meter.tick(played: 0) == .zero)
    #expect(meter.tick(played: 50).output == Float(1000) / 32768)
    #expect(meter.tick(played: 150).output == Float(32767) / 32768)
    #expect(meter.tick(played: 150).output == 0)
    meter.queued(loudPCM(100, value: 2000), at: 200)
    meter.reset(played: 200)
    #expect(meter.tick(played: 300) == .zero)
  }
}

// MARK: - Microphone mute

/// Mute from the composer mic during a conversation: no microphone audio to OpenAI, the buffer cleared once, the
/// engine and playback untouched; every conversation starts unmuted.
extension RealtimeConversationTests {
  @Test("muted → no input_audio_buffer.append, one clear, no input usage, the mic level at zero; unmute → appends resume")
  func muteStopsAppends() async throws {
    let h = Harness()
    await h.ready()
    let handlers = try #require(h.audio.handlers)
    handlers.input(loudPCM(480))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.input == 0.25)
    h.conversation.setMuted(true)
    #expect(h.conversation.muted)
    #expect(h.socket.sent("input_audio_buffer.clear").count == 1)
    #expect(h.levels.last?.input == 0, "the mic level drops to zero at once")
    handlers.input(loudPCM(480, value: 16384))
    handlers.input(loudPCM(480, value: 16384))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.input == 0)
    h.conversation.setMuted(true)
    #expect(h.socket.sent("input_audio_buffer.clear").count == 1, "a second mute sends nothing")
    #expect(h.audio.stops == 0, "the engine keeps running")
    h.conversation.setMuted(false)
    #expect(!h.conversation.muted)
    handlers.input(loudPCM(480))
    #expect(h.socket.sent("input_audio_buffer.append").count == 2)
    #expect(h.socket.sent("input_audio_buffer.clear").count == 1)
    #expect(h.diagnostics.filter { $0 == .muted }.count == 1)
    #expect(h.diagnostics.filter { $0 == .unmuted }.count == 1)
    #expect(RealtimeConversation.Diagnostic.muted.traceLine == "voice-agent: muted")
    #expect(RealtimeConversation.Diagnostic.unmuted.traceLine == "voice-agent: unmuted")
    h.conversation.end(.closed)
    guard case let .ended(summary)? = h.diagnostics.last else {
      Issue.record("no end line")
      return
    }
    #expect(summary.micPeak == 0.25, "muted audio does not count as input")
  }

  @Test("mute during speech: the hearing state resets; the answer in flight goes on")
  func muteDuringSpeech() async {
    let h = Harness()
    await h.ready()
    h.socket.reply(speechStarted)
    #expect(h.speech.last == true)
    h.conversation.setMuted(true)
    #expect(h.speech.last == false)

    let answering = Harness()
    await answering.ready()
    answering.utterance()
    answering.socket.reply(created("r1"))
    answering.conversation.setMuted(true)
    answering.say("r1", item: "m1", pcm: Data(count: 4800))
    #expect(answering.conversation.phase == .speaking)
    #expect(answering.audio.queuedSamples == 2400)
    #expect(answering.socket.sent("response.cancel").isEmpty)
  }

  @Test("late VAD events of the utterance dropped by mute order nothing, even after a quick unmute; the item goes")
  func muteDropsLateUtterance() async {
    let h = Harness()
    await h.ready()
    h.socket.reply(speechStarted)
    h.conversation.setMuted(true)
    h.socket.reply(speechStopped)
    h.socket.reply(committed("in1"))
    #expect(h.socket.sent("response.create").isEmpty)
    #expect(h.socket.sent("conversation.item.delete").count == 1)

    let quick = Harness()
    await quick.ready()
    quick.socket.reply(speechStarted)
    quick.conversation.setMuted(true)
    quick.conversation.setMuted(false)
    quick.socket.reply(committed("in1"))
    #expect(quick.socket.sent("response.create").isEmpty, "a commit that was on its way before the unmute")
    quick.utterance("in2")
    #expect(quick.socket.sent("response.create").count == 1, "the next utterance after the unmute is answered")
  }

  @Test("speech_started while muted neither hears nor cuts the answer that plays")
  func muteIgnoresLateSpeech() async {
    let h = Harness()
    await h.ready()
    h.utterance()
    h.socket.reply(created("r1"))
    h.say("r1", item: "m1", pcm: Data(count: 4800))
    h.conversation.setMuted(true)
    h.socket.reply(speechStarted)
    #expect(h.speech.last != true)
    #expect(h.conversation.phase == .speaking)
    #expect(h.socket.sent("response.cancel").isEmpty)
  }

  @Test("mute while no conversation runs is a no-op; the next conversation starts unmuted")
  func muteNotRunning() async throws {
    let h = Harness()
    h.conversation.setMuted(true)
    #expect(!h.conversation.muted)
    #expect(h.diagnostics.isEmpty)
    await h.ready()
    h.conversation.setMuted(true)
    #expect(h.conversation.muted)
    h.conversation.end(.closed)
    #expect(!h.conversation.muted)
    let count = h.diagnostics.count
    h.conversation.setMuted(true)
    #expect(!h.conversation.muted)
    #expect(h.diagnostics.count == count)
    await h.ready()
    #expect(!h.conversation.muted)
    try #require(h.audio.handlers).input(loudPCM(480))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
  }
}
