import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Shared doubles for the dictation tests (`VoiceTests`, `SonioxBacklogTests`): a server-like key fetch with the
// server's throttle, a stream double for the recorder, and harnesses for the Soniox stream and the recorder on the
// manual clock.

private let dictationTokenJSON = #"""
  {"apiKey":"snx_temp_test_a","expiresAt":"2026-08-23T12:00:00.000Z",
   "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
   "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
  """#

func dictationToken(maxSession: Int = 900, apiKey: String = "snx_temp_test_a") -> VoiceToken {
  Sample.decode(
    VoiceToken.self,
    dictationTokenJSON.replacing(#""maxSessionSeconds":900"#, with: #""maxSessionSeconds":\#(maxSession)"#)
      .replacing(#""apiKey":"snx_temp_test_a""#, with: #""apiKey":"\#(apiKey)""#))
}

/// Domyka zadania na głównym aktorze (pobranie klucza jest asynchroniczne).
@MainActor
func dictationSettle() async {
  for _ in 0..<20 { await Task.yield() }
}

/// Czas płynie krokami po 0,25 s, a zadania na głównym aktorze domykają się po każdym kroku: próba uzbrojona
/// na 0,4 s pobiera klucz o 0,5 s, a nie dopiero po całym przesunięciu zegara — dławik widzi prawdziwy rytm.
@MainActor
func dictationElapse(_ clock: ManualScheduler, _ seconds: TimeInterval) async {
  var left = seconds
  while left > 0 {
    let step = min(0.25, left)
    clock.advance(step)
    left -= step
    await dictationSettle()
  }
}

/// Pobieranie klucza jak serwer (`takeSlot`, `VOICE_TOKEN_MIN_INTERVAL_MS`): wywołanie w mniej niż 3 s od
/// poprzedniego przyjętego to 429, czyli `VoiceMint(.rateLimited)`. Bez dławika test zaliczyłby budżet prób za
/// darmo. Kolejne klucze: `snx_temp_test_a`, `snx_temp_test_b`…
@MainActor
final class ThrottledMint {
  private let clock: ManualScheduler
  /// Wyniki kolejnych przyjętych pobrań; po ich wyczerpaniu — klucz z kolejną literą.
  var results: [VoiceMint] = []
  /// Chwila każdego wywołania, także odrzuconego przez dławik.
  private(set) var calls: [TimeInterval] = []
  /// Odpowiedzi 429 dławika.
  private(set) var throttled = 0
  /// Pobrania, które wróciły w anulowanym zadaniu.
  private(set) var cancelled = 0
  /// Pobranie czeka na `release()` (klucz w drodze).
  var hold = false
  /// Woła się przy każdym wywołaniu (dziennik kolejności w testach).
  var onCall: (@MainActor () -> Void)?
  private var waiting: CheckedContinuation<Void, Never>?
  private var accepted: TimeInterval?
  private var issued = 0

  init(clock: ManualScheduler) {
    self.clock = clock
  }

  func callAsFunction() async -> VoiceMint {
    calls.append(clock.now)
    onCall?()
    if let accepted, clock.now - accepted < 3 {
      throttled += 1
      return VoiceMint(.rateLimited(message: nil))
    }
    accepted = clock.now
    if hold { await withCheckedContinuation { waiting = $0 } }
    if Task.isCancelled { cancelled += 1 }
    if !results.isEmpty { return results.removeFirst() }
    let letters = Array("abcdefghijklmnopqrstuvwxyz")
    defer { issued += 1 }
    return .token(dictationToken(apiKey: "snx_temp_test_\(letters[issued % letters.count])"))
  }

  func release() {
    waiting?.resume()
    waiting = nil
  }

  /// Odstępy między kolejnymi wywołaniami.
  var gaps: [TimeInterval] { zip(calls, calls.dropFirst()).map { $1 - $0 } }
}

/// Każde `connect` ma protokoły dokładnie `["soniox-api-key", <klucz snx_temp_…>]`, a ramka startowa
/// (pierwszy tekst po otwarciu) jest JSON-em bez pola `api_key` i bez klucza.
@MainActor
func expectKeyOnlyInProtocols(_ sockets: [MockSocket], sourceLocation: SourceLocation = #_sourceLocation) {
  for socket in sockets {
    let key = socket.protocols.count == 2 && socket.protocols[0] == "soniox-api-key" ? socket.protocols[1] : nil
    #expect(key?.hasPrefix("snx_temp_") == true, "protokoły połączenia: \(socket.protocols)", sourceLocation: sourceLocation)
    guard let frame = socket.texts.first else { continue }
    let object = (try? JSONSerialization.jsonObject(with: Data(frame.utf8))) as? [String: Any]
    #expect(object != nil && object?["api_key"] == nil, "ramka startowa bez `api_key`: \(frame)", sourceLocation: sourceLocation)
    if let key { #expect(!frame.contains(key), "ramka startowa bez klucza", sourceLocation: sourceLocation) }
  }
}

@MainActor
final class CallLog {
  var entries: [String] = []
}

/// Strumień pod nagrywarką bez sieci: zapisuje kolejność wywołań; `prepare()` może czekać i odmówić.
@MainActor
final class FakeDictationStream: DictationStream {
  private let handlers: SonioxStream.Handlers
  private let log: CallLog
  private let failure: DictationFailure?
  private let holdPrepare: Bool
  private var preparing: CheckedContinuation<Void, Never>?
  private(set) var buffers = VoiceBuffers.empty

  init(handlers: SonioxStream.Handlers, log: CallLog, failure: DictationFailure?, holdPrepare: Bool) {
    self.handlers = handlers
    self.log = log
    self.failure = failure
    self.holdPrepare = holdPrepare
  }

  func prepare() async -> DictationFailure? {
    log.entries.append("prepare")
    if holdPrepare { await withCheckedContinuation { preparing = $0 } }
    return failure
  }

  /// Koniec czekania w `prepare()` (zgoda, pobrane zasoby).
  func release() {
    preparing?.resume()
    preparing = nil
  }

  func start() {
    log.entries.append("start")
    handlers.state(.streaming)
  }

  func sendAudio(_ pcm: Data) {}

  func finish() {
    log.entries.append("finish")
    handlers.done(.finished)
  }

  func abort() {
    log.entries.append("abort")
    buffers = .empty
    handlers.done(.finished)
  }

  func resetBuffers() {
    buffers = .empty
  }

  func recognize(_ text: String) {
    buffers = VoiceBuffers(committed: text)
    handlers.buffers(buffers)
  }

  func end(_ end: SonioxStream.End) {
    handlers.done(end)
  }
}

@MainActor
final class StreamHarness {
  let clock = ManualScheduler()
  let mint: ThrottledMint
  var sockets: [MockSocket] = []
  var buffers: [VoiceBuffers] = []
  var states: [SonioxStream.State] = []
  var done: [SonioxStream.End] = []
  var stream: SonioxStream!

  init() {
    mint = ThrottledMint(clock: clock)
    stream = SonioxStream(
      mint: { [unowned self] in await self.mint() },
      connect: { [unowned self] url, protocols, events in
        let socket = MockSocket(url: url, protocols: protocols, events: events)
        self.sockets.append(socket)
        return socket
      },
      scheduler: clock, timing: .production,
      handlers: .init(
        buffers: { [unowned self] in self.buffers.append($0) },
        state: { [unowned self] in self.states.append($0) },
        token: { _ in },
        done: { [unowned self] in self.done.append($0) }))
  }

  var mints: Int { mint.calls.count }
  var last: MockSocket { sockets[sockets.count - 1] }

  func pass(_ seconds: TimeInterval) async {
    await dictationElapse(clock, seconds)
  }
}

@MainActor
final class RecorderHarness {
  let clock = ManualScheduler()
  let mic = FakeMicrophone()
  let mint: ThrottledMint
  let log = CallLog()
  var sockets: [MockSocket] = []
  var views: [VoiceView] = []
  /// Każde zdarzenie widoku razem z tym, czy mikrofon był wtedy otwarty.
  var samples: [(view: VoiceView, micOpen: Bool)] = []
  var disabled: [String] = []
  /// Strumienie-atrapy w kolejności utworzenia (`fake: true`).
  var streams: [FakeDictationStream] = []
  var prepareFailure: DictationFailure?
  var holdPrepare = false
  /// Trace lines the recorder wrote.
  var traces: [String] = []
  var recorder: VoiceRecorder!

  /// `fake`: strumień-atrapa zamiast Soniox (kolejność `prepare` → mikrofon → `start`, odmowa rozpoznawania).
  /// `micGranted`: the microphone permission is already granted, so no system prompt stands before it opens.
  /// `ceiling`: the host's cap on the recording's length (`VoiceRecorder.Deps.sessionCeiling`).
  init(fake: Bool = false, micGranted: Bool = false, ceiling: TimeInterval? = nil) {
    mint = ThrottledMint(clock: clock)
    mic.onStart = { [unowned self] in self.log.entries.append("microphone") }
    mint.onCall = { [unowned self] in self.log.entries.append("mint") }
    var deps = VoiceRecorder.Deps(
      microphone: { [unowned self] in self.mic },
      mint: { [unowned self] in await self.mint() },
      connect: { [unowned self] url, protocols, events in
        let socket = MockSocket(url: url, protocols: protocols, events: events)
        self.sockets.append(socket)
        return socket
      },
      scheduler: clock, timing: .production)
    deps.microphoneGranted = { micGranted }
    deps.sessionCeiling = ceiling
    deps.trace = { [unowned self] in self.traces.append($0) }
    if fake {
      deps.makeStream = { [unowned self] handlers in
        let stream = FakeDictationStream(
          handlers: handlers, log: self.log, failure: self.prepareFailure, holdPrepare: self.holdPrepare)
        self.streams.append(stream)
        return stream
      }
    }
    recorder = VoiceRecorder(
      deps: deps,
      handlers: .init(
        view: { [unowned self] view in
          self.views.append(view)
          self.samples.append((view, self.mic.isOpen))
        },
        disabled: { [unowned self] in self.disabled.append($0) }))
  }

  /// Nagranie w toku: mikrofon otwarty, klucz pobrany, gniazdo otwarte.
  func recording() async {
    await recorder.start()?.value
    await dictationSettle()
    sockets.last?.open()
  }

  func pass(_ seconds: TimeInterval) async {
    await dictationElapse(clock, seconds)
  }

  var view: VoiceView { recorder.view }

  /// Mikrofon otwarty tylko przy aktywnym nagraniu, na całej historii widoku.
  func expectMicInvariant(sourceLocation: SourceLocation = #_sourceLocation) {
    for sample in samples {
      if sample.micOpen {
        #expect(sample.view.active, "mikrofon otwarty przy widoku \(sample.view)", sourceLocation: sourceLocation)
      }
      if sample.view.phase == .idle {
        #expect(!sample.micOpen, "faza idle przy otwartym mikrofonie", sourceLocation: sourceLocation)
      }
    }
  }
}
