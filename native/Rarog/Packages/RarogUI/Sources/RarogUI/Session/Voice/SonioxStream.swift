import Foundation
import RarogContract

// Klient strumienia Soniox, zbudowany na wstrzykniętym zegarze, gnieździe i kluczu.
// Właściciel: dyktowanie.
//
// Cztery reguły tego strumienia:
// 1. dźwięk idzie z urządzenia PROSTO do Soniox w UE; serwer Raroga wydaje wyłącznie klucz
//    tymczasowy, a stały klucz nie opuszcza Maca;
// 2. każde otwarcie strumienia to NOWY klucz (`single_use`) — także druga i trzecia próba;
// 3. `committed` jest nietykalne: przy zerwaniu hipoteza jest DOPISYWANA, nie kasowana;
// 4. próby się kończą: budżet wraca do pełna dopiero przy ramce wyniku, próba czeka na dławik serwera,
//    a ramka 429 kończy nagranie bez ponowienia.
//
// Speech from the moment the microphone opens reaches Soniox: until the first connection streams, audio waits in a
// backlog (the last `backlogLimit` seconds) and goes in one burst right after the config frame. A failed first
// attempt keeps it for the next one; once a connection has streamed, audio while reconnecting is dropped.

/// Którędy klucz tymczasowy jedzie do Soniox: wyłącznie listą protokołów WebSocket, z samym połączeniem.
/// Pole `api_key` ramki startowej Soniox wycofuje, więc ramka klucza nie niesie nigdy. Nagłówek
/// `Authorization` odpada: Apple zastrzega go dla systemu (`URLRequest`, „Reserved HTTP headers”: może go
/// pominąć albo nadpisać). Listę protokołów Soniox przyjmuje tylko od kluczy `snx_temp_`, więc klucza w innym
/// formacie apka nie wysyła wcale.
enum SonioxKey {
  static let protocolName = "soniox-api-key"
  static let protocolPrefix = "snx_temp_"

  /// Lista protokołów połączenia: nazwa i klucz; `nil` = klucza nie da się wysłać (bez prefiksu `snx_temp_`).
  static func protocols(_ key: String) -> [String]? {
    key.hasPrefix(protocolPrefix) ? [protocolName, key] : nil
  }
}

/// Ramka konfiguracyjna Soniox; wszystko pochodzi z serwera. Klucza nie niesie: ten jedzie listą protokołów
/// (`SonioxKey`).
struct SonioxConfigFrame: Encodable, Equatable {
  let model: String
  let audioFormat: String
  let sampleRate: Int
  let numChannels: Int
  let languageHints: [String]
  /// Podpowiedź, nie ograniczenie: dyktujemy po polsku z wtrąceniami angielskich nazw.
  let languageHintsStrict = false
  /// No endpoint detection. With it on, a pause to think commits a fragment with a period and `<end>` (a new
  /// line), and Soniox does not correct committed text; sensitivity -0.3 and -0.7 does not prevent that. The stop
  /// (`finalize`) ends dictation, not a pause.
  let enableEndpointDetection = false
  // `context` is deliberately not sent: in a bake-off it induced hallucinated names.

  enum CodingKeys: String, CodingKey {
    case model, audioFormat = "audio_format", sampleRate = "sample_rate"
    case numChannels = "num_channels", languageHints = "language_hints"
    case languageHintsStrict = "language_hints_strict", enableEndpointDetection = "enable_endpoint_detection"
  }

  init(_ token: VoiceToken) {
    model = token.model
    audioFormat = token.config.audioFormat
    sampleRate = token.config.sampleRate
    numChannels = token.config.numChannels
    languageHints = token.config.languageHints
  }

  var json: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}

@MainActor
final class SonioxStream {
  enum State: Sendable, Equatable { case idle, connecting, streaming, reconnecting, failed }

  /// Dlaczego strumień padł.
  enum Failure: Sendable, Equatable {
    /// Serwer: funkcja wyłączona.
    case disabled(String)
    /// Klucza nie dało się pobrać; zdanie gotowe do pokazania.
    case mint(String)
    /// Połączenie zerwane albo odrzucone, a próby się skończyły.
    case dropped
    /// Soniox odpowiedział ramką 429 (limit konta): ponowienie trafiłoby w ten sam limit.
    case rateLimited
    /// Rozpoznawanie Apple odmówiło (trasa systemowa); koniec bez ponowienia.
    case rejected(DictationFailure)
  }

  enum End: Sendable, Equatable {
    case finished
    case failed(Failure)
  }

  struct Handlers {
    var buffers: @MainActor (VoiceBuffers) -> Void
    var state: @MainActor (State) -> Void
    /// Pierwszy udany klucz — stąd limit sesji dla licznika w UI.
    var token: @MainActor (VoiceToken) -> Void
    /// Strumień domknięty po `finish()`, `abort()` albo po wyczerpaniu prób. Jedno wywołanie.
    var done: @MainActor (End) -> Void
  }

  static let finalizeFrame = #"{"type":"finalize"}"#
  static let keepaliveFrame = #"{"type":"keepalive"}"#

  private let mint: @MainActor () async -> VoiceMint
  private let connect: VoiceSocketFactory
  private let scheduler: any VoiceScheduler
  private let timing: VoiceTiming
  private let handlers: Handlers

  private(set) var buffers = VoiceBuffers.empty
  /// The latest audio time of a token on the current connection, the hypothesis of the last message and the cut
  /// set by the last edit (`resetBuffers`). All belong to one connection: Soniox counts time from zero on each new one.
  private var heardUntilMs: Int?
  private var shownHypothesis: [SonioxToken] = []
  private var cut: SonioxCut?
  private(set) var state = State.idle
  private var socket: (any VoiceSocket)?
  /// Numer próby połączenia: callbacki gniazda i klucza, którego już nie chcemy (anulowanie
  /// w trakcie, kolejna próba), rozpoznają po nim, że są nieaktualne.
  private var generation = 0
  /// Ponowienia od ostatniej ramki wyniku. Otwarcie gniazda jej nie zeruje: zły klucz Soniox odrzuca ramką
  /// błędu tuż po otwarciu, więc dopiero ramka wyniku dowodzi, że połączenie działa.
  private var attempt = 0
  /// Chwila ostatniego wyniku pobrania klucza — od niej liczy się odstęp kolejnej próby (`minMintInterval`).
  private var lastMintAt: TimeInterval?
  private var keepaliveTimer: VoiceTimer?
  private var retryTimer: VoiceTimer?
  private var finalizeTimer: VoiceTimer?
  private var mintTask: Task<Void, Never>?
  private var lastSendAt: TimeInterval = 0
  /// Od `finish()` — zerwanie nie jest już powodem do kolejnej próby.
  private var finishing = false
  private var stopped = false
  /// Audio recorded before the first connection streamed, oldest first; `nil` once it streamed (no more backlog).
  private var backlog: [Data]? = []
  private var backlogBytes = 0
  /// Seconds of audio the current connection took in its opening burst: the wait for the last words grows by it.
  private var burst: TimeInterval = 0
  /// A stop came while the backlog waits for the first connection (`stopConnectWait`).
  private var connectWaitTimer: VoiceTimer?
  /// The stop waited for the first connection and no result frame has come from it yet: if that connection fails
  /// now, the speech it took is lost, so the end is a failure, not a clean finish.
  private var stopAwaitsResult = false
  /// The clock times of the current attempt's key request and key.
  private var keyRequestedAt: TimeInterval = 0
  private var keyReceivedAt: TimeInterval = 0
  private(set) var readiness: DictationReadiness?

  init(
    mint: @escaping @MainActor () async -> VoiceMint, connect: @escaping VoiceSocketFactory,
    scheduler: any VoiceScheduler, timing: VoiceTiming, handlers: Handlers
  ) {
    self.mint = mint
    self.connect = connect
    self.scheduler = scheduler
    self.timing = timing
    self.handlers = handlers
  }

  /// Otwiera strumień. Wołane raz; kolejne próby robi sam klient.
  func start() {
    stopped = false
    finishing = false
    attempt = 0
    open(.connecting)
  }

  /// A PCM frame. Before the first connection streams it waits in the backlog. After that, outside `streaming` it is
  /// dropped: a late, glued stream after a reconnect transcribes worse than none.
  func sendAudio(_ pcm: Data) {
    guard !stopped else { return }
    if let socket, state == .streaming {
      socket.send(data: pcm)
      lastSendAt = scheduler.now
    } else if backlog != nil {
      keep(pcm)
    }
  }

  /// Stop with commit: finalization and the end of the stream; the wait for the last words is at most
  /// `finalizeTimeout` plus the audio the connection took in its opening burst. With speech still waiting for the
  /// first connection, the stop waits for it at most `stopConnectWait`, then sends the backlog and finalizes.
  func finish() {
    guard !stopped else { return }
    finishing = true
    retryTimer?.cancel()
    keepaliveTimer?.cancel()
    if socket != nil, state == .streaming {
      finalize()
      return
    }
    // No socket with a config frame: nothing was sent, and `finalize` before the config Soniox rejects as an error.
    guard backlogBytes > 0 else {
      settle(.finished)
      return
    }
    // Speech waits and nothing is connecting (between attempts): no new attempt starts after a stop.
    guard mintTask != nil || socket != nil else {
      settle(.failed(.dropped))
      return
    }
    stopAwaitsResult = true
    connectWaitTimer = scheduler.schedule(after: timing.stopConnectWait) { [weak self] in
      self?.connectWaitTimer = nil
      self?.settle(.failed(.dropped))
    }
  }

  /// Anulowanie: strumień w dół, oba bufory na zero.
  func abort() {
    buffers = .empty
    handlers.buffers(buffers)
    settle(.finished)
  }

  /// Człowiek pisał w polu: podyktowany tekst jest już jego, bufory zaczynają od zera.
  /// Words already heard up to that moment are the person's text now, so later tokens from before the cut
  /// (the hypothesis Soniox confirms after a pause) do not come back.
  /// Speech still waiting for the first connection goes too: none of it was shown, and the text is the person's now.
  func resetBuffers() {
    buffers = .empty
    cut = heardUntilMs.map { SonioxCut(ms: $0, shown: shownHypothesis) }
    if backlog != nil {
      backlog = []
      backlogBytes = 0
    }
  }

  // MARK: - Backlog

  /// Keeps a frame for the first connection; above `backlogLimit` the oldest whole frames go.
  private func keep(_ pcm: Data) {
    backlog?.append(pcm)
    backlogBytes += pcm.count
    let limit = Int(timing.backlogLimit * Double(VoiceFrame.bytesPerSecond))
    while backlogBytes > limit, let oldest = backlog?.first {
      backlog?.removeFirst()
      backlogBytes -= oldest.count
    }
  }

  /// The first connection opened: the backlog goes in one burst after the config frame, and from now on there is
  /// no backlog (frames while reconnecting are dropped).
  private func sendBacklog(to socket: any VoiceSocket) {
    guard let frames = backlog else { return }
    for frame in frames { socket.send(data: frame) }
    burst = TimeInterval(backlogBytes) / TimeInterval(VoiceFrame.bytesPerSecond)
    backlog = nil
    backlogBytes = 0
    readiness = DictationReadiness(
      keyRequested: keyRequestedAt, keyReceived: keyReceivedAt, streaming: scheduler.now, backlog: burst)
  }

  /// `finalize` and the end frame, then the wait for the last words.
  private func finalize() {
    guard let socket else { return }
    socket.send(text: Self.finalizeFrame)
    // Pusta ramka to udokumentowany koniec strumienia: serwer domyka tokeny i odsyła `finished`.
    socket.send(text: "")
    finalizeTimer = scheduler.schedule(after: timing.finalizeTimeout + burst) { [weak self] in
      self?.finalizeTimer = nil
      self?.settle(.finished)
    }
  }

  // MARK: - Połączenie

  private func current(_ generation: Int) -> Bool {
    self.generation == generation && !stopped
  }

  private func setState(_ next: State) {
    guard state != next else { return }
    state = next
    handlers.state(next)
  }

  private func open(_ next: State) {
    heardUntilMs = nil
    shownHypothesis = []
    cut = nil
    burst = 0
    generation += 1
    let generation = generation
    setState(next)
    keyRequestedAt = scheduler.now
    mintTask = Task { [weak self] in
      guard let mint = self?.mint else { return }
      // NOWY klucz przy każdej próbie — `single_use` znaczy dokładnie to.
      let result = await mint()
      guard let self else { return }
      // Odstęp od WYNIKU, nie od wysłania: serwer stawia znacznik dławika po przyjęciu żądania, czyli między
      // jednym a drugim, więc tak liczony odstęp nie trafi w dławik przy żadnym opóźnieniu sieci.
      self.lastMintAt = self.scheduler.now
      guard self.current(generation) else { return }
      self.mintTask = nil
      self.keyReceivedAt = self.scheduler.now
      switch result {
      case let .token(token):
        self.attach(token, generation: generation)
      case let .disabled(message):
        self.afterDrop(.disabled(message))
      case let .stop(message):
        self.afterDrop(.mint(message), retry: false)
      case let .retry(message):
        self.afterDrop(.mint(message))
      }
    }
  }

  private func attach(_ token: VoiceToken, generation: Int) {
    // Klucz bez prefiksu `snx_temp_` nie jedzie nigdzie: próba przepada jak zerwanie, w budżecie prób.
    guard let protocols = SonioxKey.protocols(token.apiKey) else {
      afterDrop(.dropped)
      return
    }
    handlers.token(token)
    let events = VoiceSocketEvents(
      opened: { [weak self] in
        guard let self, self.current(generation), let socket = self.socket else { return }
        socket.send(text: SonioxConfigFrame(token).json)
        self.lastSendAt = self.scheduler.now
        self.sendBacklog(to: socket)
        self.setState(.streaming)
        if self.finishing {
          // The stop that waited for this connection: the backlog went, now the end.
          self.connectWaitTimer?.cancel()
          self.connectWaitTimer = nil
          self.finalize()
        } else {
          self.armKeepalive()
        }
      },
      message: { [weak self] text in
        guard let self, self.current(generation) else { return }
        self.receive(text)
      },
      closed: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.socket = nil
        self.keepaliveTimer?.cancel()
        // After a stop no other attempt starts. A connection the stop waited for, closed before any result, lost
        // the speech: that is a failure.
        if self.finishing {
          self.settle(self.stopAwaitsResult ? .failed(.dropped) : .finished)
        } else {
          self.afterDrop(.dropped)
        }
      })
    socket = connect(token.webSocketURL, protocols, events)
  }

  private func receive(_ text: String) {
    guard let reply = SonioxReply.parse(text) else { return }
    if let code = reply.errorCode {
      socket?.close()
      socket = nil
      keepaliveTimer?.cancel()
      if finishing {
        // The connection the stop waited for refused the speech before any result: a failure with its reason.
        settle(stopAwaitsResult ? .failed(code == 429 ? .rateLimited : .dropped) : .finished)
      } else if code == 429 {
        // Limit konta Soniox: próba z nowym kluczem trafiłaby w ten sam limit.
        afterDrop(.rateLimited, retry: false)
      } else {
        // Inny kod jak zerwanie: kolejna próba i tak dostaje nowy klucz, a wygasły albo zużyty klucz
        // to najczęstsza przyczyna tej ramki.
        afterDrop(.dropped)
      }
      return
    }
    if let tokens = reply.tokens {
      // Ramka wyniku (także pusta): klucz i połączenie działają, budżet prób wraca do pełna.
      attempt = 0
      stopAwaitsResult = false
      if let heard = SonioxText.heardUntil(tokens) { heardUntilMs = max(heardUntilMs ?? heard, heard) }
      if !tokens.isEmpty { shownHypothesis = tokens.filter { !$0.isFinal } }
      let next = SonioxText.apply(buffers, tokens, cut: cut)
      if next != buffers {
        buffers = next
        handlers.buffers(next)
      }
    }
    if reply.finished { settle(.finished) }
  }

  /// Wspólne wyjście po utracie strumienia: `committed` rośnie o hipotezę, potem próba albo koniec.
  private func afterDrop(_ failure: Failure, retry: Bool = true) {
    guard !stopped else { return }
    let folded = SonioxText.fold(buffers)
    if folded != buffers {
      buffers = folded
      handlers.buffers(folded)
    }
    if case .disabled = failure {
      settle(.failed(failure))
      return
    }
    guard retry, !finishing, attempt < timing.reconnectDelays.count else {
      settle(.failed(failure))
      return
    }
    // Rytm prób, ale najwcześniej `minMintInterval` od poprzedniego pobrania klucza: inaczej szybkie zerwanie
    // zaraz po otwarciu dostałoby od serwera 429 i skończyło nagranie przed budżetem prób.
    var delay = timing.reconnectDelays[attempt]
    if let lastMintAt { delay = max(delay, timing.minMintInterval - (scheduler.now - lastMintAt)) }
    attempt += 1
    setState(.reconnecting)
    retryTimer = scheduler.schedule(after: delay) { [weak self] in
      self?.retryTimer = nil
      self?.open(.reconnecting)
    }
  }

  private func armKeepalive() {
    keepaliveTimer?.cancel()
    keepaliveTimer = scheduler.schedule(after: timing.keepalive) { [weak self] in
      guard let self else { return }
      self.keepaliveTimer = nil
      guard let socket = self.socket, self.state == .streaming else { return }
      // Tylko gdy dźwięk nie płynie: przy nagraniu ramka leci co 100 ms.
      if self.scheduler.now - self.lastSendAt >= self.timing.keepalive {
        socket.send(text: Self.keepaliveFrame)
        self.lastSendAt = self.scheduler.now
      }
      self.armKeepalive()
    }
  }

  /// Jedno wyjście dla wszystkich zakończeń — nie ma drugiej drogi do `idle`.
  private func settle(_ end: End) {
    guard !stopped else { return }
    stopped = true
    retryTimer?.cancel()
    keepaliveTimer?.cancel()
    finalizeTimer?.cancel()
    connectWaitTimer?.cancel()
    retryTimer = nil
    keepaliveTimer = nil
    finalizeTimer = nil
    connectWaitTimer = nil
    // Klucz w drodze nie jest już potrzebny: anulowanie zadania anuluje żądanie.
    mintTask?.cancel()
    mintTask = nil
    socket?.close()
    socket = nil
    setState(end == .finished ? .idle : .failed)
    handlers.done(end)
  }
}

extension SonioxStream: DictationStream {
  /// Soniox has nothing to prepare before the microphone: `start()` fetches the key.
  func prepare() async -> DictationFailure? { nil }

  /// The key fetch and the connection may run while the microphone opens: the backlog keeps the speech until then.
  var startsBeforeMicrophone: Bool { true }
}
