import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Dyktowanie: bufory, ramki PCM, strumień Soniox, nagrywarka i sklejenie z polem —
// na ręcznym zegarze, atrapie gniazda, mikrofonu i pobierania klucza z dławikiem serwera.
// Właściciel: dyktowanie.

private func token(maxSession: Int = 900, apiKey: String = "snx_temp_test_a") -> VoiceToken {
  dictationToken(maxSession: maxSession, apiKey: apiKey)
}

@MainActor
private func settle() async {
  await dictationSettle()
}

/// Ręczny zegar: żaden test nie czeka sekundy na keepalive ani minuty na ciszę.
@MainActor
final class ManualScheduler: VoiceScheduler {
  private var queue: [(id: Int, at: TimeInterval, work: @MainActor () -> Void)] = []
  private var nextId = 0
  private(set) var now: TimeInterval = 0

  func schedule(after seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer {
    nextId += 1
    let id = nextId
    queue.append((id, now + seconds, work))
    return VoiceTimer { [weak self] in self?.queue.removeAll { $0.id == id } }
  }

  /// Przesuwa zegar; timer uzbrojony w callbacku w tej samej chwili też odpala.
  func advance(_ seconds: TimeInterval) {
    let target = now + seconds
    while let next = queue.filter({ $0.at <= target }).min(by: { $0.at < $1.at }) {
      queue.removeAll { $0.id == next.id }
      now = max(now, next.at)
      next.work()
    }
    now = target
  }
}

@MainActor
final class MockSocket: VoiceSocket {
  let url: URL
  let protocols: [String]
  let events: VoiceSocketEvents
  var texts: [String] = []
  var audio = 0
  /// Everything sent, text and audio, in order.
  var sent: [Sent] = []
  var closed = false

  enum Sent: Equatable {
    case text(String)
    case data(Data)
  }

  init(url: URL, protocols: [String], events: VoiceSocketEvents) {
    self.url = url
    self.protocols = protocols
    self.events = events
  }

  func send(text: String) {
    texts.append(text)
    sent.append(.text(text))
  }

  func send(data: Data) {
    audio += 1
    sent.append(.data(data))
  }
  func close() { closed = true }

  // Zdarzenia dostarcza TEST — prawdziwe gniazdo też nie woła ich synchronicznie.
  func open() { events.opened() }
  func reply(_ json: String) { events.message(json) }
  func drop() { events.closed() }
}

/// Wspólna sesja audio procesu (`AVAudioSession.sharedInstance()`): jedno nagranie ją włącza,
/// zatrzymanie mikrofonu, który ją trzyma, wyłącza — także cudzą, przejętą w międzyczasie.
@MainActor
final class FakeAudioSession {
  var active = false
}

@MainActor
final class FakeMicrophone: VoiceMicrophone {
  var failure: VoiceMicError?
  var onFrame: (@MainActor (VoiceFrame) -> Void)?
  var onInterrupt: (@MainActor () -> Void)?
  var flushes = 0
  var stops = 0
  /// Wywołania `start` — każde to pytanie o zgodę i otwarcie wejścia.
  private(set) var starts = 0
  /// Wejście otwarte: `start` wrócił bez błędu, `stop` jeszcze nie przyszedł.
  private(set) var isOpen = false
  /// Woła się na początku każdego `start` (dziennik kolejności w testach).
  var onStart: (@MainActor () -> Void)?
  /// Start czeka na `grant()` (pytanie systemowe o zgodę).
  var holdStart = false
  /// Spłukanie czeka na `releaseFlush()` — jak `MicrophoneCapture`, które wraca przez główną kolejkę.
  var holdFlush = false
  /// Sesja audio jak w `MicrophoneCapture`: start ją włącza, `stop` wyłącza raz (idempotentnie).
  var session: FakeAudioSession?
  private var holdsSession = false
  private var waiting: CheckedContinuation<Void, Never>?
  private var flushing: CheckedContinuation<Void, Never>?

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    starts += 1
    onStart?()
    if holdStart { await withCheckedContinuation { waiting = $0 } }
    if let failure { throw failure }
    self.onFrame = onFrame
    self.onInterrupt = onInterrupt
    isOpen = true
    session?.active = true
    holdsSession = true
  }

  func grant() {
    waiting?.resume()
    waiting = nil
  }

  func flush() async {
    flushes += 1
    if holdFlush { await withCheckedContinuation { flushing = $0 } }
  }

  func releaseFlush() {
    flushing?.resume()
    flushing = nil
  }

  func stop() {
    stops += 1
    isOpen = false
    guard holdsSession else { return }
    holdsSession = false
    session?.active = false
  }

  func frame(peak: Float) { onFrame?(VoiceFrame(pcm: Data(count: 320), peak: peak)) }

  /// A frame with given PCM, loud enough to count as speech.
  func frame(_ pcm: Data, peak: Float = 0.5) { onFrame?(VoiceFrame(pcm: pcm, peak: peak)) }
}



private let invalidKeyFrame = #"{"error_code":401,"error_type":"unauthenticated","error_message":"Invalid API key."}"#
private let limitFrame = #"{"error_code":429,"error_type":"limit_exceeded","error_message":"Limit exceeded."}"#

@Suite("dyktowanie: bufory i odpowiedzi Soniox")
struct VoiceBufferTests {
  @Test("składa realną sekwencję tokenów bez własnego sklejania słów; hipoteza jest zastępowana")
  func tokens() {
    var buffers = VoiceBuffers.empty
    buffers = SonioxText.apply(buffers, [.init(text: "Zrób", isFinal: true), .init(text: " listę", isFinal: false)])
    #expect(buffers == VoiceBuffers(committed: "Zrób", provisional: " listę"))
    buffers = SonioxText.apply(buffers, [.init(text: " listę", isFinal: true), .init(text: " zadań", isFinal: false)])
    #expect(buffers == VoiceBuffers(committed: "Zrób listę", provisional: " zadań"))
    buffers = SonioxText.apply(buffers, [.init(text: " zadań.", isFinal: true)])
    #expect(buffers == VoiceBuffers(committed: "Zrób listę zadań.", provisional: ""))
  }

  @Test("wiadomość bez tokenów nie rusza buforów (inaczej pole migotałoby)")
  func emptyMessage() {
    let buffers = VoiceBuffers(committed: "a", provisional: " b")
    #expect(SonioxText.apply(buffers, []) == buffers)
  }

  @Test("<end> domyka akapit i nie trafia do tekstu; <fin> znika w całości")
  func markers() {
    #expect(SonioxText.append("Zdanie. ", "<end>") == "Zdanie.\n")
    #expect(SonioxText.append("Zdanie.\n", " Drugie") == "Zdanie.\nDrugie")
    #expect(SonioxText.append("", "<end>") == "")
    #expect(SonioxText.apply(.empty, [.init(text: "<end>", isFinal: false)]) == .empty)
    let finished = SonioxText.apply(
      VoiceBuffers(committed: "tekst"), [.init(text: "<fin>", isFinal: true), .init(text: "<fin>", isFinal: false)])
    #expect(finished.text == "tekst")
  }

  @Test("zerwanie zamienia hipotezę w tekst, zamiast ją kasować")
  func fold() {
    #expect(SonioxText.fold(VoiceBuffers(committed: "ala ", provisional: "ma kota")) == VoiceBuffers(committed: "ala ma kota"))
  }

  @Test("odpowiedź strumienia: tokeny (także pusta lista), koniec, kod błędu; is_final tylko jako prawdziwy bool")
  func replies() throws {
    let reply = try #require(SonioxReply.parse(#"{"tokens":[{"text":"a","is_final":true},{"text":"b","is_final":1}],"x":2}"#))
    #expect(reply.tokens == [.init(text: "a", isFinal: true), .init(text: "b", isFinal: false)])
    #expect(SonioxReply.parse(#"{"finished":true}"#)?.finished == true)
    #expect(SonioxReply.parse(invalidKeyFrame)?.errorCode == 401)
    #expect(SonioxReply.parse(limitFrame)?.errorCode == 429)
    let empty = try #require(SonioxReply.parse(#"{"tokens":[]}"#))
    #expect(empty.tokens == [] && empty.errorCode == nil, "pusta ramka wyniku to też ramka wyniku")
    #expect(SonioxReply.parse("nie json") == nil)
    let timed = try #require(SonioxReply.parse(#"{"tokens":[{"text":"a","is_final":true,"start_ms":600,"end_ms":760}]}"#))
    #expect(timed.tokens == [.init(text: "a", isFinal: true, startMs: 600, endMs: 760)])
  }

  @Test("ramka konfiguracyjna: format i język z serwera, klucza nie niesie nigdy; bez granicy wypowiedzi i `context`")
  func configFrame() throws {
    for key in ["snx_temp_test_a", "temp:x", "demo-temporary-key"] {
      let frame = SonioxConfigFrame(token(apiKey: key)).json
      let object = try #require(try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
      #expect(object["api_key"] == nil && !frame.contains(key), "klucz \(key) nie jedzie w ramce startowej")
    }
    let frame = SonioxConfigFrame(token()).json
    let object = try #require(try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
    #expect(object["model"] as? String == "stt-rt-v6")
    #expect(object["audio_format"] as? String == "pcm_s16le")
    #expect(object["sample_rate"] as? Int == 16000 && object["num_channels"] as? Int == 1)
    #expect(object["language_hints"] as? [String] == ["pl", "en"])
    #expect(object["language_hints_strict"] as? Bool == false)
    #expect(object["enable_endpoint_detection"] as? Bool == false, "pauza na zastanowienie nie domyka zdania")
    for knob in ["endpoint_sensitivity", "max_endpoint_delay_ms", "endpoint_latency_adjustment_level"] {
      #expect(object[knob] == nil, "pokrętła granicy nie mają sensu bez jej wykrywania: \(knob)")
    }
    #expect(object["context"] == nil)
  }

  @Test("klucz jedzie wyłącznie listą protokołów i tylko z prefiksem `snx_temp_`")
  func keyRoute() {
    #expect(SonioxKey.protocols("snx_temp_test_a") == ["soniox-api-key", "snx_temp_test_a"])
    #expect(SonioxKey.protocols("temp:x") == nil && SonioxKey.protocols("demo-temporary-key") == nil)
    #expect(SonioxKey.protocols("") == nil)
  }
}

@Suite("dyktowanie: ramki PCM 16 kHz")
struct PCMFramerTests {
  @Test("ramka wychodzi po 100 ms materiału; szczyt jedzie razem z nią")
  func frames() {
    var framer = PCMFramer()
    #expect(framer.push([Float](repeating: 0.25, count: 1000)).isEmpty)
    let frames = framer.push([Float](repeating: -0.5, count: 700))
    #expect(frames.count == 1)
    #expect(frames[0].pcm.count == 3200)
    #expect(frames[0].peak == 0.5)
    let rest = framer.flush()
    #expect(rest?.pcm.count == 200 && rest?.peak == 0.5)
    #expect(framer.flush() == nil)
  }

  @Test("przester przycinany, a nie zawijany; skala asymetryczna; NaN to cisza")
  func scale() {
    #expect(PCMFramer.sample(1) == 32767)
    #expect(PCMFramer.sample(-1) == -32768)
    var framer = PCMFramer()
    _ = framer.push([2, -3, .nan])
    let frame = framer.flush()!
    let values = frame.pcm.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map(\.littleEndian)
    #expect(values == [32767, -32768, 0])
    #expect(frame.peak == 1)
  }
}

@MainActor
@Suite("dyktowanie: strumień Soniox")
struct SonioxStreamTests {
  @Test("pierwsza próba: klucz `snx_temp_` w liście protokołów, ramka startowa bez klucza; dźwięk przed otwarciem czeka")
  func firstAttempt() async throws {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    #expect(h.sockets.count == 1 && h.last.protocols == ["soniox-api-key", "snx_temp_test_a"])
    #expect(h.last.url.absoluteString == "wss://stt-rt.eu.soniox.com/transcribe-websocket")
    h.stream.sendAudio(Data(count: 320))
    #expect(h.last.audio == 0, "przed otwarciem nie ma dokąd wysyłać")
    h.last.open()
    let frame = try #require(h.last.texts.first)
    #expect(frame.contains(#""model":"stt-rt-v6""#))
    #expect(h.stream.state == .streaming)
    #expect(h.last.audio == 1, "audio from before the open goes after the config frame")
    h.stream.sendAudio(Data(count: 320))
    #expect(h.last.audio == 2)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("zerwanie po ramce wyniku: NOWY klucz, najwcześniej 3 s po poprzednim pobraniu; tekst zostaje")
  func retryAfterDrop() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"ala ","is_final":true},{"text":"ma kota","is_final":false}]}"#)
    await h.pass(1)
    h.last.drop()
    #expect(h.stream.buffers == VoiceBuffers(committed: "ala ma kota"), "hipoteza staje się tekstem")
    #expect(h.stream.state == .reconnecting && h.mints == 1)
    await h.pass(1.75)
    #expect(h.mints == 1, "drugie pobranie najwcześniej 3 s po pierwszym")
    await h.pass(0.25)
    #expect(h.mint.calls == [0, 3] && h.mint.throttled == 0)
    #expect(h.sockets.count == 2 && h.last.protocols == ["soniox-api-key", "snx_temp_test_b"])
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":" i psa","is_final":true}]}"#)
    #expect(h.stream.buffers.committed == "ala ma kota i psa")
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("ramka błędu po otwarciu (403, sesja klucza wygasła): ponowienie z NOWYM kluczem")
  func errorFrameRetries() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"tekst","is_final":true}]}"#)
    h.last.reply(#"{"error_code":403,"error_type":"temp_api_key_session_expired","error_message":"Session expired."}"#)
    #expect(h.sockets[0].closed && h.stream.state == .reconnecting)
    await h.pass(3)
    #expect(h.mints == 2 && h.mint.throttled == 0)
    #expect(h.sockets.count == 2 && h.last.protocols.last == "snx_temp_test_b")
    h.last.open()
    #expect(h.stream.state == .streaming && h.stream.buffers.committed == "tekst" && h.done.isEmpty)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("klucz wygasł przed otwarciem (gniazdo zamknięte bez `opened`): ponowienie z nowym pobraniem")
  func closedBeforeOpen() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    #expect(h.sockets.count == 1)
    h.last.drop()
    #expect(h.stream.state == .reconnecting && h.sockets[0].texts.isEmpty)
    await h.pass(3)
    #expect(h.mints == 2 && h.mint.throttled == 0)
    #expect(h.sockets.count == 2 && h.last.protocols.last == "snx_temp_test_b")
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("klucz bez `snx_temp_` nie jedzie nigdzie: zero połączeń, po budżecie prób błąd strumienia")
  func keyWithoutPrefix() async {
    for key in ["temp:x", "demo-temporary-key"] {
      let h = StreamHarness()
      h.mint.results = Array(repeating: .token(token(apiKey: key)), count: 8)
      h.stream.start()
      await settle()
      await h.pass(30)
      #expect(h.sockets.isEmpty, "\(key): ani w ramce, ani w liście protokołów")
      #expect(h.mints == 4 && h.mint.throttled == 0, "\(key): 1 + 3 próby w rytmie dławika")
      #expect(h.done == [.failed(.dropped)] && h.stream.state == .failed)
    }
  }

  @Test("otwarcie → ramka błędu bez wyniku: 4 pobrania i 4 połączenia co ≥ 3 s, bez 429, potem koniec")
  func errorLoopEnds() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    var served = 0
    // Każde gniazdo: otwarcie i od razu odmowa (zły klucz), bez ramki wyniku.
    for _ in 0..<(30 * 4) {
      while served < h.sockets.count {
        h.sockets[served].open()
        h.sockets[served].reply(invalidKeyFrame)
        served += 1
      }
      await h.pass(0.25)
    }
    #expect(h.mints == 4 && h.sockets.count == 4)
    #expect(h.mint.gaps.allSatisfy { $0 >= 3 } && h.mint.throttled == 0, "odstępy: \(h.mint.gaps)")
    #expect(h.done == [.failed(.dropped)] && h.stream.state == .failed)
    await h.pass(60)
    #expect(h.mints == 4, "minuta później: bez piątego pobrania")
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("ramka wyniku (także pusta) odnawia budżet: pięć zerwań po wyniku, każde z ponowieniem")
  func resultRenewsBudget() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    for cycle in 0..<5 {
      h.last.open()
      h.last.reply(cycle.isMultiple(of: 2) ? #"{"tokens":[]}"# : #"{"tokens":[{"text":"x","is_final":true}]}"#)
      h.last.drop()
      await h.pass(3)
    }
    #expect(h.mints == 6 && h.sockets.count == 6 && h.done.isEmpty)
    #expect(h.mint.gaps.allSatisfy { $0 >= 3 } && h.mint.throttled == 0)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("ramka błędu 429: jedno pobranie, koniec bez ponowienia, tekst zostaje")
  func rateLimitFrame() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"tekst","is_final":true},{"text":" urwany","is_final":false}]}"#)
    h.last.reply(limitFrame)
    #expect(h.done == [.failed(.rateLimited)] && h.stream.buffers.committed == "tekst urwany")
    await h.pass(10)
    #expect(h.mints == 1 && h.sockets.count == 1 && h.sockets[0].closed)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("stop albo anulowanie w trakcie pobrania: późny klucz nie otwiera gniazda, pobranie anulowane")
  func endWhileMinting() async {
    for abort in [false, true] {
      let h = StreamHarness()
      h.mint.hold = true
      h.stream.start()
      await settle()
      #expect(h.mints == 1 && h.sockets.isEmpty)
      if abort { h.stream.abort() } else { h.stream.finish() }
      #expect(h.done == [.finished] && h.stream.state == .idle)
      h.mint.release()
      await settle()
      #expect(h.sockets.isEmpty && h.mint.cancelled == 1)
      await h.pass(10)
      #expect(h.mints == 1 && h.done == [.finished])
    }
  }

  @Test("„wyłączone” i „stop” z pobrania: koniec bez ponowienia i bez połączenia")
  func mintRefusals() async {
    let disabled = StreamHarness()
    disabled.mint.results = [.disabled("Wyłączone.")]
    disabled.stream.start()
    await settle()
    #expect(disabled.done == [.failed(.disabled("Wyłączone."))])
    await disabled.pass(10)
    #expect(disabled.mints == 1 && disabled.sockets.isEmpty)

    let stopped = StreamHarness()
    stopped.mint.results = [.stop("Za szybko.")]
    stopped.stream.start()
    await settle()
    #expect(stopped.done == [.failed(.mint("Za szybko."))])
    await stopped.pass(10)
    #expect(stopped.mints == 1 && stopped.sockets.isEmpty)
  }

  @Test("pobranie bez odpowiedzi (sieć) próbuje dalej, w rytmie dławika serwera")
  func mintRetry() async {
    let h = StreamHarness()
    h.mint.results = [.retry("Sieć.")]
    h.stream.start()
    await settle()
    #expect(h.stream.state == .reconnecting && h.mints == 1)
    await h.pass(2.75)
    #expect(h.mints == 1)
    await h.pass(0.25)
    #expect(h.mints == 2 && h.sockets.count == 1 && h.mint.throttled == 0)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("po trzech nieudanych próbach oddaje błąd, a nie kręci się w kółko")
  func givesUp() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    for _ in 0..<3 {
      h.last.drop()
      await h.pass(3)
    }
    #expect(h.sockets.count == 4 && h.mint.throttled == 0)
    h.last.drop()
    #expect(h.done == [.failed(.dropped)] && h.stream.state == .failed)
    expectKeyOnlyInProtocols(h.sockets)
  }

  @Test("keepalive tylko wtedy, gdy dźwięk nie płynie")
  func keepalive() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.clock.advance(15)
    #expect(h.last.texts.count == 2 && h.last.texts[1] == #"{"type":"keepalive"}"#)
    h.clock.advance(7.5)
    h.stream.sendAudio(Data(count: 320))
    h.clock.advance(7.5)
    #expect(h.last.texts.count == 2, "ramka dźwięku liczy się jak ruch")
  }

  @Test("stop finalizuje i czeka na `finished`; anulowanie zeruje bufory i zamyka gniazdo")
  func finishAndAbort() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"tekst","is_final":true}]}"#)
    h.stream.finish()
    #expect(Array(h.last.texts.dropFirst()) == [#"{"type":"finalize"}"#, ""])
    #expect(h.done.isEmpty, "czeka na ostatnie słowa")
    h.last.reply(#"{"tokens":[{"text":" koniec","is_final":true}]}"#)
    h.last.reply(#"{"finished":true}"#)
    #expect(h.done == [.finished] && h.stream.buffers.committed == "tekst koniec")

    let second = StreamHarness()
    second.stream.start()
    await settle()
    second.last.open()
    second.last.reply(#"{"tokens":[{"text":"do kosza","is_final":true}]}"#)
    second.stream.abort()
    #expect(second.stream.buffers == .empty && second.last.closed)
  }

  @Test("stop przed otwarciem gniazda kończy od razu, bez ramki finalize przed konfiguracją")
  func finishBeforeOpen() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.stream.finish()
    #expect(h.done == [.finished] && h.last.texts.isEmpty && h.last.closed)
  }

  @Test("cisza po finalizacji kończy się po limicie czasu, z tekstem")
  func finalizeTimeout() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.stream.finish()
    h.clock.advance(2.5)
    #expect(h.done == [.finished] && h.last.closed)
  }

  @Test("edit in silence: the hypothesis already in the field does not come back when Soniox confirms it")
  func editKeepsShownHypothesis() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"Zrób listę","is_final":true,"start_ms":0,"end_ms":800},"#
      + #"{"text":" zadań.","is_final":false,"start_ms":800,"end_ms":1200}]}"#)
    h.stream.resetBuffers()
    h.last.reply(#"{"tokens":[{"text":" zadań.","is_final":true,"start_ms":800,"end_ms":1200}]}"#)
    #expect(h.stream.buffers == .empty, "the confirmed sentence is already in the field")
    h.last.reply(#"{"tokens":[{"text":" zadań.","is_final":false,"start_ms":800,"end_ms":1200},"#
      + #"{"text":" I","is_final":false,"start_ms":2000,"end_ms":2100}]}"#)
    #expect(h.stream.buffers == VoiceBuffers(provisional: " I"), "only words spoken after the edit")
    h.last.reply(#"{"tokens":[{"text":" I testy.","is_final":true,"start_ms":2000,"end_ms":2600}]}"#)
    #expect(h.stream.buffers == VoiceBuffers(committed: " I testy."))
  }

  @Test("a message with only words from before the edit clears the hypothesis instead of keeping a stale one")
  func editThenOnlyOldWords() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"ala","is_final":false,"start_ms":0,"end_ms":400}]}"#)
    h.stream.resetBuffers()
    h.last.reply(#"{"tokens":[{"text":" ma","is_final":false,"start_ms":900,"end_ms":1100}]}"#)
    #expect(h.stream.buffers == VoiceBuffers(provisional: " ma"))
    h.last.reply(#"{"tokens":[{"text":"ala","is_final":false,"start_ms":0,"end_ms":400}]}"#)
    #expect(h.stream.buffers == .empty)
  }

  @Test("a word that crosses the edit keeps the part spoken after it; a word Soniox rewrote stays as the field has it")
  func editInsideWord() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"Start","is_final":true,"start_ms":0,"end_ms":300},"#
      + #"{"text":" do","is_final":false,"start_ms":300,"end_ms":400}]}"#)
    h.stream.resetBuffers()
    h.last.reply(#"{"tokens":[{"text":" doing","is_final":true,"start_ms":300,"end_ms":800}]}"#)
    #expect(h.stream.buffers == VoiceBuffers(committed: "ing"))
    h.last.reply(#"{"tokens":[{"text":" more","is_final":false,"start_ms":350,"end_ms":900}]}"#)
    #expect(h.stream.buffers == VoiceBuffers(committed: "ing"), "a rewrite of shown words cannot be merged, so it is skipped")
  }

  @Test("a new connection counts time from zero again, so the cut from the edit does not swallow its words")
  func editCutEndsWithConnection() async {
    let h = StreamHarness()
    h.stream.start()
    await settle()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"ala ma kota","is_final":false,"start_ms":0,"end_ms":5000}]}"#)
    h.stream.resetBuffers()
    h.last.drop()
    await h.pass(3)
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":" i psa","is_final":true,"start_ms":0,"end_ms":600}]}"#)
    #expect(h.stream.buffers.committed == " i psa")
  }
}

@MainActor
@Suite("dyktowanie: nagrywarka")
struct VoiceRecorderTests {
  @Test("minuta ciszy kończy nagranie i mówi dlaczego; tekst zostaje, mikrofon zwolniony")
  func silence() async {
    let h = RecorderHarness()
    await h.recording()
    #expect(h.view.phase == .recording)
    h.sockets[0].reply(#"{"tokens":[{"text":"powiedziane","is_final":true}]}"#)
    h.mic.frame(peak: 0.5)
    h.mic.frame(peak: 0.001)
    h.clock.advance(61)
    await settle()
    #expect(h.view.phase == .finalizing)
    #expect(h.mic.flushes == 1, "ostatnia ramka przed finalizacją")
    h.sockets[0].reply(#"{"finished":true}"#)
    #expect(h.view.phase == .idle && h.view.notice == .silence)
    #expect(h.view.buffers.committed == "powiedziane")
    #expect(h.mic.stops >= 1)
  }

  @Test("przerwanie z zewnątrz to przypadek normalny: tekst zostaje, zdanie wprost")
  func interrupted() async {
    let h = RecorderHarness()
    await h.recording()
    h.sockets[0].reply(#"{"tokens":[{"text":"zdanie","is_final":true},{"text":" urwane","is_final":false}]}"#)
    h.mic.onInterrupt?()
    await settle()
    h.clock.advance(2.5)
    #expect(h.view.phase == .idle && h.view.notice == .interrupted && h.view.notice?.isError == false)
    #expect(h.view.buffers.committed == "zdanie urwane")
  }

  @Test("anulowanie porzuca tekst w całości, bez komunikatu")
  func cancel() async {
    let h = RecorderHarness()
    await h.recording()
    h.sockets[0].reply(#"{"tokens":[{"text":"do kosza","is_final":true}]}"#)
    h.recorder.cancel()
    #expect(h.view == VoiceView())
    #expect(h.sockets[0].closed && h.mic.stops == 1)
  }

  @Test("anulowanie w trakcie spłukania ostatniej ramki zatrzymuje mikrofon od razu, nie po spłukaniu")
  func cancelWhileFlushing() async {
    let h = RecorderHarness()
    await h.recording()
    h.mic.holdFlush = true
    h.recorder.stop()
    await settle()
    #expect(h.mic.flushes == 1 && h.mic.stops == 0, "stop czeka na ostatnią ramkę")
    h.recorder.cancel()
    #expect(h.mic.stops == 1, "anulowanie (i przejęcie) nie czeka na spłukanie")
    #expect(!h.recorder.active)
    h.mic.releaseFlush()
    await settle()
    #expect(h.mic.stops == 1, "wznowione zadanie nie zatrzymuje mikrofonu drugi raz")
  }

  @Test("spóźnione zatrzymanie starego nagrania nie wyłącza sesji audio przejętej przez nowe")
  func lateStopKeepsNextRecording() async {
    let audio = FakeAudioSession()
    let old = RecorderHarness()
    old.mic.session = audio
    await old.recording()
    old.mic.holdFlush = true
    old.recorder.stop()
    await settle()
    // Przejęcie mikrofonu przez inny ekran: `DictationCenter.claim` → `handOff` → `cancel`.
    old.recorder.cancel()
    let next = RecorderHarness()
    next.mic.session = audio
    await next.recording()
    #expect(audio.active && next.recorder.active)
    old.mic.releaseFlush()
    await settle()
    #expect(audio.active, "nowe nagranie dalej ma sesję audio")
    #expect(next.recorder.active)
  }

  @Test("pisanie w trakcie zeruje bufory (przebazowanie)")
  func rebase() async {
    let h = RecorderHarness()
    await h.recording()
    h.sockets[0].reply(#"{"tokens":[{"text":"pierwsze","is_final":true}]}"#)
    h.recorder.rebase()
    #expect(h.view.buffers == .empty)
    h.sockets[0].reply(#"{"tokens":[{"text":" drugie","is_final":true}]}"#)
    #expect(h.view.buffers.committed == " drugie")
  }

  @Test("odmowa mikrofonu nie zostawia stanu „nagrywam”")
  func denied() async {
    let h = RecorderHarness()
    h.mic.failure = .denied
    await h.recorder.start()?.value
    #expect(!h.recorder.active && h.view.notice == .microphone(.denied) && h.view.notice?.isError == true)
    #expect(h.sockets.isEmpty && h.mint.calls.isEmpty, "klucza nie pobiera się na zapas")
  }

  @Test("rezygnacja w trakcie pytania o zgodę: mikrofon zwolniony, nic nie nagrane, nic nie pobrane")
  func stopWhileAsking() async {
    let h = RecorderHarness()
    h.mic.holdStart = true
    let start = h.recorder.start()
    #expect(h.view.phase == .starting, "„Łączę…” od razu, zanim mikrofon odpowie")
    await settle()
    h.recorder.stop()
    #expect(h.view == VoiceView())
    h.mic.grant()
    await start?.value
    #expect(h.mic.stops == 1 && h.sockets.isEmpty && h.mint.calls.isEmpty && !h.recorder.active)
  }

  @Test("drugi tap tuż po pierwszym kończy, a nie zaczyna drugiego nagrania; mikrofonu nie pytamy")
  func immediateSecondTap() async {
    let h = RecorderHarness()
    let start = h.recorder.start()
    #expect(h.recorder.start() == nil, "drugi start w trakcie nic nie robi")
    h.recorder.stop()
    await start?.value
    #expect(h.view == VoiceView() && h.mic.onFrame == nil && h.mic.stops == 0 && h.sockets.isEmpty)
    #expect(h.mic.starts == 0 && h.mint.calls.isEmpty)
  }

  @Test("klucz odmówiony bez tekstu mówi powód; z tekstem mówi, że tekst został")
  func mintRefusal() async {
    let h = RecorderHarness()
    h.mint.results = [.stop("Za szybko — odczekaj chwilę przed kolejnym dyktowaniem.")]
    await h.recorder.start()?.value
    await settle()
    #expect(h.view.phase == .idle && h.view.notice == .message("Za szybko — odczekaj chwilę przed kolejnym dyktowaniem."))

    let disabled = RecorderHarness()
    disabled.mint.results = [.disabled("Dyktowanie wyłączone.")]
    await disabled.recorder.start()?.value
    await settle()
    #expect(disabled.disabled == ["Dyktowanie wyłączone."] && !disabled.recorder.active)
  }

  @Test("klucz bez `snx_temp_`: zero połączeń, po budżecie prób zdanie o przerwanej transkrypcji")
  func keyWithoutPrefix() async {
    let h = RecorderHarness()
    h.mint.results = Array(repeating: .token(token(apiKey: "demo-temporary-key")), count: 8)
    await h.recorder.start()?.value
    await settle()
    await h.pass(12)
    #expect(h.sockets.isEmpty && h.mint.calls.count == 4 && h.mint.throttled == 0)
    #expect(h.view.phase == .idle && h.view.notice == .streamFailed && !h.mic.isOpen)
    h.expectMicInvariant()
  }

  @Test("ramka 429 Soniox kończy nagranie zdaniem „za szybko”; tekst zostaje w polu")
  func rateLimitFrame() async {
    let h = RecorderHarness()
    await h.recording()
    h.sockets[0].reply(#"{"tokens":[{"text":"powiedziane","is_final":true}]}"#)
    h.sockets[0].reply(limitFrame)
    await h.pass(10)
    #expect(h.view.phase == .idle && h.view.notice == .message(UICopy.voiceRateLimited))
    #expect(h.view.buffers.committed == "powiedziane")
    #expect(h.mint.calls.count == 1 && h.sockets.count == 1 && !h.mic.isOpen)
    h.expectMicInvariant()
  }

  @Test("kolejność: `prepare()` → mikrofon → `start()`; odmowa w `prepare()` nie otwiera mikrofonu")
  func prepareBeforeMicrophone() async {
    let h = RecorderHarness(fake: true)
    await h.recorder.start()?.value
    #expect(h.log.entries == ["prepare", "microphone", "start"])
    #expect(h.mic.isOpen && h.view.phase == .recording)

    let refused = RecorderHarness(fake: true)
    refused.prepareFailure = .speechDenied
    await refused.recorder.start()?.value
    #expect(refused.log.entries == ["prepare"] && refused.mic.starts == 0)
    #expect(!refused.recorder.active && refused.view == VoiceView(notice: .dictation(.speechDenied)),
            "zdanie odmowy rozpoznawania mowy, bez nagrania")
    refused.expectMicInvariant()

    // Soniox nie ma czego przygotować: klucz dopiero po mikrofonie.
    let soniox = RecorderHarness()
    await soniox.recording()
    #expect(soniox.log.entries == ["microphone", "mint"])
  }

  @Test("każda odmowa rozpoznawania w `prepare()` (siedem przypadków kontraktu): mikrofon ani razu, zdanie błędu")
  func everyPrepareFailureSays() async {
    #expect(DictationFailure.allCases == [
      .speechDenied, .speechRestricted, .localeUnsupported, .assetsMissing, .appleServerUnreachable,
      .dictationDisabled, .engineFailed,
    ])
    for failure in DictationFailure.allCases {
      let h = RecorderHarness(fake: true)
      h.prepareFailure = failure
      await h.recorder.start()?.value
      #expect(h.mic.starts == 0 && h.log.entries == ["prepare"], "\(failure)")
      #expect(h.view == VoiceView(notice: .dictation(failure)) && h.view.notice?.isError == true, "\(failure)")
    }
  }

  @Test("stop albo anulowanie w trakcie `prepare()`: mikrofon ani razu, późny wynik niczego nie zmienia")
  func endDuringPrepare() async {
    for cancel in [false, true] {
      for late in [nil, DictationFailure.assetsMissing] {
        let h = RecorderHarness(fake: true)
        h.holdPrepare = true
        h.prepareFailure = late
        let start = h.recorder.start()
        await settle()
        #expect(h.log.entries == ["prepare"] && h.view.phase == .starting)
        if cancel { h.recorder.cancel() } else { h.recorder.stop() }
        #expect(h.view == VoiceView() && !h.recorder.active)
        let views = h.views.count
        h.streams[0].release()
        await start?.value
        await settle()
        #expect(h.mic.starts == 0 && h.log.entries == ["prepare"])
        #expect(h.views.count == views && h.view == VoiceView())
      }
    }

    // Nowe nagranie, zanim wróci `prepare()` porzuconego: spóźniony wynik nie rusza nowego.
    let h = RecorderHarness(fake: true)
    h.holdPrepare = true
    let first = h.recorder.start()
    await settle()
    h.recorder.stop()
    h.holdPrepare = false
    await h.recorder.start()?.value
    #expect(h.log.entries == ["prepare", "prepare", "microphone", "start"] && h.recorder.active)
    h.streams[0].release()
    await first?.value
    await settle()
    #expect(h.mic.starts == 1 && h.view.phase == .recording)
    #expect(h.log.entries == ["prepare", "prepare", "microphone", "start"])
  }

  @Test("mikrofon otwarty ⇒ nagranie aktywne w każdym zdarzeniu widoku; faza idle ⇒ mikrofon zamknięty")
  func microphoneOnlyWhileActive() async {
    let stopped = RecorderHarness()
    await stopped.recording()
    stopped.sockets[0].reply(#"{"tokens":[{"text":"tekst","is_final":true}]}"#)
    stopped.recorder.stop()
    await settle()
    stopped.sockets[0].reply(#"{"finished":true}"#)

    let cancelled = RecorderHarness()
    await cancelled.recording()
    cancelled.recorder.cancel()

    let interrupted = RecorderHarness()
    await interrupted.recording()
    interrupted.mic.onInterrupt?()
    await settle()
    await interrupted.pass(2.5)

    let dropped = RecorderHarness()
    await dropped.recording()
    for _ in 0..<4 {
      dropped.sockets.last?.drop()
      await dropped.pass(3)
    }

    let disabled = RecorderHarness()
    disabled.mint.results = [.disabled("Wyłączone.")]
    await disabled.recorder.start()?.value
    await settle()

    let refused = RecorderHarness(fake: true)
    refused.prepareFailure = .speechRestricted
    await refused.recorder.start()?.value

    let rejected = RecorderHarness(fake: true)
    await rejected.recorder.start()?.value
    rejected.streams[0].end(.failed(.rejected(.engineFailed)))

    #expect(stopped.samples.contains { $0.micOpen }, "scenariusz z otwartym mikrofonem jest w próbie")
    for h in [stopped, cancelled, interrupted, dropped, disabled, refused, rejected] {
      #expect(h.view.phase == .idle && !h.mic.isOpen)
      h.expectMicInvariant()
    }
  }

  @Test("odmowa rozpoznawania na końcu strumienia idzie drogą `prepare()`: zdanie błędu z tekstem i bez, tekst zostaje")
  func rejectedEnd() async {
    let h = RecorderHarness(fake: true)
    await h.recorder.start()?.value
    h.streams[0].recognize("podyktowane")
    h.streams[0].end(.failed(.rejected(.appleServerUnreachable)))
    #expect(h.view == VoiceView(
      buffers: VoiceBuffers(committed: "podyktowane"), notice: .dictation(.appleServerUnreachable)))
    #expect(!h.mic.isOpen && !h.recorder.active)
    h.expectMicInvariant()

    for failure in DictationFailure.allCases {
      let empty = RecorderHarness(fake: true)
      await empty.recorder.start()?.value
      empty.streams[0].end(.failed(.rejected(failure)))
      #expect(empty.view == VoiceView(notice: .dictation(failure)), "\(failure): bez tekstu też zdanie")
      #expect(!empty.mic.isOpen && !empty.recorder.active)
    }
  }

  @Test("od 13. minuty licznik do limitu; limit sesji z serwera kończy nagranie")
  func sessionLimit() async {
    let h = RecorderHarness()
    h.mint.results = [.token(token(maxSession: 180))]
    await h.recording()
    for _ in 0..<59 {
      h.mic.frame(peak: 0.5)
      h.clock.advance(1)
    }
    #expect(h.view.secondsLeft == 121 || h.view.secondsLeft == nil)
    for _ in 0..<2 {
      h.mic.frame(peak: 0.5)
      h.clock.advance(1)
    }
    #expect(h.view.secondsLeft == 119)
    for _ in 0..<120 {
      h.mic.frame(peak: 0.5)
      h.clock.advance(1)
    }
    await settle()
    h.clock.advance(2.5)
    #expect(h.view.phase == .idle && h.view.notice == .sessionLimit)
  }

  @Test("licznik limitu milczy poza oknem ostrzeżenia")
  func countdown() {
    #expect(voiceLimitCountdown(elapsed: 0, maxSession: 900, warning: 120) == nil)
    #expect(voiceLimitCountdown(elapsed: 13 * 60, maxSession: 900, warning: 120) == 120)
    #expect(voiceLimitCountdown(elapsed: 14 * 60 + 30, maxSession: 900, warning: 120) == 30)
    #expect(voiceLimitCountdown(elapsed: 20 * 60, maxSession: 900, warning: 120) == 0)
  }
}

/// Pole wiadomości jak `ComposerView`: każda zmiana z kodu (także zapis dyktowania) idzie przez
/// `onReplace`, klawiatura przez `onEdit` — tak samo jak `textViewDidChange` i setter `text`.
@MainActor
private final class FakeField: VoiceTextTarget {
  private(set) var text: String
  var isComposing = false
  var onReplace: (() -> Void)?

  init(_ text: String) {
    self.text = text
  }

  func writeDictation(_ value: String) {
    replace(value)
  }

  func replace(_ value: String) {
    text = value
    onReplace?()
  }
}

@MainActor
@Suite("dyktowanie: zmiany pola z kodu ekranu")
struct VoiceFieldBindingTests {
  @Test("tekst oddany do pola po odmowie wysyłki w trakcie dyktowania: następny token dokleja się, nie nadpisuje")
  func refusedSendDuringDictation() async {
    // Wyślij „A" → pole puste → dyktowanie „B" → odmowa (422) oddaje „A\nB" (`SendRecovery`,
    // nieudany tekst na górze) i zdejmuje wpis kolejki — pole jest jedyną kopią „A".
    let h = RecorderHarness()
    let field = FakeField("")
    await h.recording()
    let binding = VoiceFieldBinding(target: field)
    var rebases = 0
    field.onReplace = {
      guard binding.fieldChanged() else { return }
      rebases += 1
      h.recorder.rebase()
    }
    h.sockets[0].reply(#"{"tokens":[{"text":"B","is_final":true}]}"#)
    binding.show(h.view.buffers, final: false)
    #expect(field.text == "B" && rebases == 0, "własny zapis dyktowania to nie zmiana pola")
    field.replace("A\nB")
    #expect(rebases == 1, "zmiana z kodu przebazowuje jak pisanie")
    h.sockets[0].reply(#"{"tokens":[{"text":" C","is_final":true}]}"#)
    binding.show(h.view.buffers, final: false)
    #expect(field.text == "A\nB C")
  }

  @Test("prompt po Esc wpisany do pustego pola w trakcie dyktowania zostaje; końcówka dokleja się do niego")
  func promptRestoredDuringDictation() async {
    let h = RecorderHarness()
    let field = FakeField("")
    await h.recording()
    let binding = VoiceFieldBinding(target: field)
    field.onReplace = { if binding.fieldChanged() { h.recorder.rebase() } }
    field.replace("Popraw testy")
    h.sockets[0].reply(#"{"tokens":[{"text":" i dokumentację","is_final":true}]}"#)
    binding.show(h.view.buffers, final: false)
    #expect(field.text == "Popraw testy i dokumentację")
  }

  @Test("w trakcie składania znaku (IME) dyktowanie nie pisze, koniec nagrania pisze mimo to")
  func composing() async {
    let field = FakeField("")
    let binding = VoiceFieldBinding(target: field)
    field.isComposing = true
    binding.show(VoiceBuffers(committed: "słowo"), final: false)
    #expect(field.text == "")
    binding.show(VoiceBuffers(committed: "słowo"), final: true)
    #expect(field.text == "słowo")
  }
}

@Suite("dyktowanie: sklejenie z polem i copy")
struct VoiceFieldTests {
  @Test("dyktowanie dokleja się do wpisanego tekstu z jedną spacją")
  func base() {
    #expect(VoiceFieldText.base("") == "")
    #expect(VoiceFieldText.base("Zrób") == "Zrób ")
    #expect(VoiceFieldText.base("Zrób ") == "Zrób ")
    #expect(VoiceFieldText.base("Lista:\n") == "Lista:\n")
  }

  @Test("pole = baza + oba bufory; pisanie w trakcie przebazowuje")
  func editing() {
    var field = VoiceFieldText(field: "Notatka")
    #expect(field.value(.empty) == "Notatka", "bez podyktowanego tekstu bez spacji na końcu")
    let first = field.value(VoiceBuffers(committed: "Dyktuję", provisional: " z"))
    #expect(first == "Notatka Dyktuję z")
    field.wrote(first)
    let own = field.edited(field: first)
    #expect(!own, "nasze własne wpisanie to nie edycja")
    let typed = field.edited(field: "Notatka Dyktuję, poprawione")
    #expect(typed)
    #expect(field.value(VoiceBuffers(committed: " dalej")) == "Notatka Dyktuję, poprawione dalej")
  }

  @Test("dopisek od nowej linii (notatka z dymka): koniec linii raz, bez wiodącej spacji tokenu; pisanie przebazowuje")
  func newLine() {
    #expect(VoiceFieldText.lineBase("") == "")
    #expect(VoiceFieldText.lineBase("- punkt") == "- punkt\n")
    #expect(VoiceFieldText.lineBase("- punkt\n") == "- punkt\n")
    var field = VoiceFieldText(field: "- punkt", newLine: true)
    #expect(field.value(.empty) == "- punkt", "bez podyktowanego tekstu pole nietknięte")
    #expect(field.value(VoiceBuffers(committed: " Dyktuję")) == "- punkt\nDyktuję")
    #expect(VoiceFieldText(field: "", newLine: true).value(VoiceBuffers(committed: " Pierwsza")) == "Pierwsza")
    let typed = field.edited(field: "- punkt\nDyktuję, poprawione")
    #expect(typed)
    #expect(field.value(VoiceBuffers(committed: " dalej")) == "- punkt\nDyktuję, poprawione dalej", "w linii — spacja tokenu")
  }

  @Test("dwa gospodarze nagrania (pole wiadomości, notatka projektu) dzielą jeden mikrofon przez wspólne centrum")
  func hostsShareMicrophone() throws {
    for file in ["Session/Voice/ComposerDictation.swift", "Views/Notes/NoteDictation.swift"] {
      let code = try TerminalWindowChromeSourceTests.code(file)
      #expect(code.contains(": DictationHost"), "\(file): gospodarz oddaje tekst przy przejęciu")
      #expect(code.contains("DictationCenter.shared.claim(self)"), "\(file): start przejmuje mikrofon")
    }
  }

  @Test("kursor na końcu idzie za tekstem; kursor w środku zostaje tam, gdzie człowiek poprawia")
  func selection() {
    #expect(voiceSelection(old: NSRange(location: 5, length: 0), oldLength: 5, newLength: 9) == NSRange(location: 9, length: 0))
    #expect(voiceSelection(old: NSRange(location: 2, length: 1), oldLength: 5, newLength: 9) == NSRange(location: 2, length: 1))
    #expect(voiceSelection(old: NSRange(location: 8, length: 3), oldLength: 12, newLength: 9) == NSRange(location: 8, length: 1))
  }

  @Test("wiersz mówi jedno zdanie na stan, komunikat wygrywa; licznik po maszynowemu")
  func status() {
    #expect(UICopy.voiceStatus(VoiceView()) == "")
    #expect(UICopy.voiceStatus(VoiceView(phase: .starting)) == "Łączę…")
    #expect(UICopy.voiceStatus(VoiceView(phase: .recording)) == "Nagrywam")
    #expect(UICopy.voiceStatus(VoiceView(phase: .recording, secondsLeft: 61)) == "Nagrywam · zostało 1:01")
    #expect(UICopy.voiceStatus(VoiceView(phase: .reconnecting)) == "Sieć padła — wracam do transkrypcji…")
    #expect(UICopy.voiceStatus(VoiceView(phase: .finalizing)) == "Kończę…")
    #expect(UICopy.voiceStatus(VoiceView(notice: .silence)) == "Cisza przez minutę — kończę nagrywanie.")
    #expect(UICopy.voiceStatus(VoiceView(notice: .microphone(.denied))).contains("Ustawieniach"))
    #expect(UICopy.voiceStatus(VoiceView(notice: .dictation(.speechDenied))).contains("Ustawieniach"))
    #expect(UICopy.voiceStatus(VoiceView(phase: .recording, notice: .dictation(.engineFailed)))
      == UICopy.dictationFailure(.engineFailed), "komunikat wygrywa ze stanem")
    #expect(UICopy.voiceClock(0) == "0:00" && UICopy.voiceClock(119) == "1:59")
    #expect(UICopy.voiceLimitSpoken(seconds: 120) == "Do końca nagrania zostały 2 minuty.")
    #expect(UICopy.voiceLimitSpoken(seconds: 30) == "Do końca nagrania została 1 minuta.")
  }

  @Test("wynik pobrania klucza: wyłączone ze zdaniem serwera albo apki; za szybko zawsze zdaniem apki")
  func mintCopy() {
    #expect(VoiceMint(.disabled(message: nil)) == .disabled(UICopy.voiceDisabled))
    #expect(VoiceMint(.disabled(message: "Brak klucza.")) == .disabled("Brak klucza."))
    #expect(VoiceMint(.rateLimited(message: "serwer")) == .stop(UICopy.voiceRateLimited))
    #expect(VoiceMint(.failed(message: nil)) == .retry(UICopy.voiceMintFailed))
    #expect(VoiceMint(.loggedOut) == .stop(""))
  }
}
