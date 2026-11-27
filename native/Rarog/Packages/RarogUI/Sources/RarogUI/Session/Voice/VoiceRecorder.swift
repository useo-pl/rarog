import Foundation
import RarogContract

// Polityka dyktowania: stany, granice i to, co widzi człowiek. Widok dostaje
// jeden `VoiceView` i tylko go rysuje.
// Właściciel: dyktowanie.
//
// Dwie reguły, których nie wolno złamać:
// 1. `committed` nie ginie NIGDY: przerwanie (tło, rozmowa, padnięta sieć) to przypadek normalny,
//    który kończy się zdaniem i tekstem w polu, a nie pustym polem;
// 2. mikrofon nie zostaje otwarty dłużej, niż trzeba: każde wyjście z nagrania przechodzi przez
//    `shutdown`.

/// Dlaczego nagranie skończyło się samo albo nie zaczęło. Zdania: `UICopy.voiceNotice`.
public enum VoiceNotice: Sendable, Equatable {
  /// Minuta ciszy.
  case silence
  /// The recording reached its length limit (`seconds`: the limit, for the sentence).
  case sessionLimit(seconds: Int)
  /// Przerwanie z zewnątrz: tło, rozmowa, zmiana wyjścia audio.
  case interrupted
  /// Strumień padł po wyczerpaniu prób; tekst, który zdążył przyjść, został.
  case streamFailed
  case microphone(VoiceMicError)
  /// Rozpoznawanie mowy Apple (trasa systemowa) nie ruszyło albo przerwało nagranie; tekst, który zdążył przyjść,
  /// został. Zdanie: `UICopy.dictationFailure`.
  case dictation(DictationFailure)
  /// Zdanie z pobrania klucza (serwer albo apka).
  case message(String)

  /// Błąd (czerwona kropka), a nie stan.
  public var isError: Bool {
    switch self {
    case .streamFailed, .microphone, .dictation, .message: true
    case .silence, .sessionLimit, .interrupted: false
    }
  }

  /// Naprawa leży w ustawieniach apki w iOS (zgoda na mikrofon albo na rozpoznawanie mowy): gospodarz pokazuje przy
  /// zdaniu przycisk „Ustawienia”. Ograniczenie (Czas przed ekranem) i wyłączone dyktowanie systemu go nie mają:
  /// skrót iOS otwiera tylko stronę apki, a tam tego się nie zmienia.
  public var opensSettings: Bool {
    switch self {
    case .microphone(.denied), .dictation(.speechDenied): true
    default: false
    }
  }
}

/// Stan dyktowania do narysowania.
public struct VoiceView: Sendable, Equatable {
  public enum Phase: Sendable, Equatable { case idle, starting, recording, reconnecting, finalizing }

  public var phase: Phase = .idle
  /// Bufory strumienia — widok skleja je z tekstem pola sprzed dyktowania.
  public var buffers = VoiceBuffers.empty
  public var notice: VoiceNotice?
  /// Sekundy do limitu sesji; `nil` poza oknem ostrzeżenia.
  public var secondsLeft: Int?

  public init(
    phase: Phase = .idle, buffers: VoiceBuffers = .empty, notice: VoiceNotice? = nil, secondsLeft: Int? = nil
  ) {
    self.phase = phase
    self.buffers = buffers
    self.notice = notice
    self.secondsLeft = secondsLeft
  }

  public var active: Bool { phase != .idle }
}

/// Sekundy do pokazania przed limitem; poza oknem ostrzeżenia `nil` — licznik od pierwszej
/// sekundy byłby presją, nie informacją.
func voiceLimitCountdown(elapsed: TimeInterval, maxSession: TimeInterval, warning: TimeInterval) -> Int? {
  let left = maxSession - elapsed
  guard left <= warning else { return nil }
  return max(0, Int(left.rounded(.up)))
}

/// The session limit of a recording: the server's `maxSessionSeconds` (`fallback` when it gives none or the route
/// has no key), capped by the host's `ceiling`. A reconnect keeps counting from the microphone's open.
func voiceSessionLimit(server seconds: Int, ceiling: TimeInterval?, fallback: TimeInterval) -> TimeInterval {
  let server = seconds > 0 ? TimeInterval(seconds) : fallback
  return ceiling.map { min(server, $0) } ?? server
}

@MainActor
final class VoiceRecorder {
  struct Deps {
    var microphone: @MainActor () -> any VoiceMicrophone
    var mint: @MainActor () async -> VoiceMint
    var connect: VoiceSocketFactory
    var scheduler: any VoiceScheduler
    var timing: VoiceTiming
    /// Strumień rozpoznawania pod nagraniem; `nil` = Soniox z `mint` i `connect`.
    var makeStream: (@MainActor (SonioxStream.Handlers) -> any DictationStream)? = nil
    /// The microphone permission is already granted (no system prompt on start). Only then may a stream that
    /// `startsBeforeMicrophone` start before the microphone opens.
    var microphoneGranted: @MainActor () -> Bool = { false }
    /// Debug trace channel (`client.log`): one line when the recording gets ready, without text.
    var trace: @MainActor (String) -> Void = { _ in }
    /// The host's cap on the recording's length, in seconds: the recording ends at the lower of it and the server's
    /// limit (`VoiceTiming.defaultMaxSession` when the server gives none or the route has no key). `nil`: no cap.
    var sessionCeiling: TimeInterval? = nil
  }

  struct Handlers {
    var view: @MainActor (VoiceView) -> Void
    /// Szczyt amplitudy każdej ramki (0…1) — do kropki poziomu.
    var level: @MainActor (Float) -> Void = { _ in }
    /// Serwer odmówił drogi Soniox — jedno zdanie zamiast błędu; mikrofon zostaje, a następne stuknięcie
    /// otwiera ekran „Dyktowanie”.
    var disabled: @MainActor (String) -> Void = { _ in }
  }

  private let deps: Deps
  private let handlers: Handlers
  private(set) var view = VoiceView()
  private var microphone: (any VoiceMicrophone)?
  private var stream: (any DictationStream)?
  private var tickTimer: VoiceTimer?
  private var startedAt: TimeInterval = 0
  private var lastVoiceAt: TimeInterval = 0
  private var maxSession: TimeInterval
  /// Zdanie, które stanie po domknięciu strumienia (cisza, limit, przerwanie).
  private var pendingNotice: VoiceNotice?
  /// Mikrofon zwalniany ze spłukaniem ostatniej ramki — drugie zatrzymanie w tym oknie nic nie robi.
  private var stopping = false
  /// Numer startu: start porzucony w trakcie pytania o zgodę nie przejmuje mikrofonu następnego.
  private var startGeneration = 0
  /// Pole zmieniło się, zanim strumień ruszył (pytanie o zgodę, otwieranie mikrofonu): strumień dostaje
  /// przebazowanie przed `start()`, inaczej pierwszy fragment dyktowania systemowego skleiłby się z polem bez spacji.
  private var pendingRebase = false
  /// Number of the stream whose events count: a stream dropped after a refused microphone stays silent.
  private var streamID = 0
  /// The tap, the microphone open and whether the stream has streamed: the ready line of this recording.
  private var tappedAt: TimeInterval = 0
  private var microphoneOpenedAt: TimeInterval?
  private var streamed = false
  private var readyTraced = false
  /// The clock time of the last microphone frame of this recording.
  private var lastFrameAt: TimeInterval?
  /// The stream's connection streams (Soniox: its socket); `false` while it connects or reconnects.
  private var streaming = false

  init(deps: Deps, handlers: Handlers) {
    self.deps = deps
    self.handlers = handlers
    maxSession = voiceSessionLimit(
      server: 0, ceiling: deps.sessionCeiling, fallback: deps.timing.defaultMaxSession)
  }

  /// Mikrofon otwarty albo właśnie się otwiera.
  var active: Bool { view.active }

  /// The running recording's microphone has opened: it records now, or finishes what it recorded. While the
  /// recording prepares (permission, the speech key, the microphone opening) it is active but not opened.
  var microphoneOpened: Bool { active && microphoneOpenedAt != nil }

  /// What of the running recording lives (the locked-phone monitor's heartbeat): a microphone frame within
  /// `MicrophoneUse.frameWindow` seconds, and the stream's connection streaming.
  var live: (audio: Bool, stream: Bool) {
    let fresh = lastFrameAt.map { deps.scheduler.now - $0 < MicrophoneUse.frameWindow } ?? false
    return (active && fresh, active && stream != nil && streaming)
  }

  /// Zaczyna nagranie: „Łączę…" od razu, więc drugi tap w tej samej chwili już kończy (a nie
  /// zaczyna drugiego nagrania), mikrofon otwiera się w zadaniu. Zadanie oddaje się testom.
  @discardableResult
  func start() -> Task<Void, Never>? {
    guard !active else { return nil }
    pendingNotice = nil
    pendingRebase = false
    tappedAt = deps.scheduler.now
    microphoneOpenedAt = nil
    streamed = false
    readyTraced = false
    lastFrameAt = nil
    streaming = false
    startGeneration += 1
    let generation = startGeneration
    emit(VoiceView(phase: .starting))
    return Task { [weak self] in await self?.open(generation: generation) }
  }

  /// Strumień pod to nagranie: z fabryki gospodarza albo Soniox. Zdarzenia przychodzą dopiero po `start()`.
  private func makeStream() -> any DictationStream {
    streamID += 1
    let id = streamID
    let handlers = SonioxStream.Handlers(
      buffers: { [weak self] buffers in
        guard let self, self.streamID == id, self.view.active else { return }
        self.emit(VoiceView(
          phase: self.view.phase, buffers: buffers, notice: self.view.notice, secondsLeft: self.view.secondsLeft))
      },
      state: { [weak self] state in
        guard let self, self.streamID == id else { return }
        self.streamState(state)
      },
      token: { [weak self] token in
        guard let self, self.streamID == id else { return }
        self.maxSession = voiceSessionLimit(
          server: token.maxSessionSeconds, ceiling: self.deps.sessionCeiling,
          fallback: self.deps.timing.defaultMaxSession)
      },
      done: { [weak self] end in
        guard let self, self.streamID == id else { return }
        self.finish(end)
      })
    if let makeStream = deps.makeStream { return makeStream(handlers) }
    return SonioxStream(
      mint: deps.mint, connect: deps.connect, scheduler: deps.scheduler, timing: deps.timing, handlers: handlers)
  }

  /// Kolejność: `prepare()` strumienia → mikrofon → `start()` strumienia. Rezygnacja w trakcie którejkolwiek
  /// z dwóch pierwszych nie zostawia otwartego mikrofonu. A stream that `startsBeforeMicrophone` starts right after
  /// `prepare()` when the microphone permission is already granted, so the key fetch and the connection run while
  /// the microphone opens; a refused microphone then ends that stream without a word.
  private func open(generation: Int) async {
    // Rezygnacja, zanim zadanie ruszyło: mikrofonu nawet nie pytamy.
    guard generation == startGeneration, view.phase == .starting else { return }
    let stream = makeStream()
    // Zgoda na rozpoznawanie, język i zasoby PRZED mikrofonem: odmowa nie otwiera go ani na chwilę.
    let failure = await stream.prepare()
    // Rezygnacja w trakcie (stop, wysyłka, zmiana ekranu, nowe nagranie): porzucony strumień nie startuje,
    // a jego spóźniony wynik niczego nie zmienia.
    guard generation == startGeneration, view.phase == .starting else { return }
    if let failure {
      rejected(failure, buffers: .empty)
      return
    }
    // No permission prompt can stand before the microphone, so the connection may start now.
    let early = stream.startsBeforeMicrophone && deps.microphoneGranted()
    if early {
      attach(stream)
      // `start()` only enqueues the key fetch on the main actor, and with the permission granted `microphone.start`
      // does not suspend before its synchronous audio setup. One yield lets the fetch run up to its request (its
      // first suspension) before that setup, so the two overlap instead of running one after the other.
      await Task.yield()
      // A stop, a cancel or an immediate refusal of the key during the yield: the recording is over, no microphone.
      guard generation == startGeneration, view.phase == .starting else { return }
    }
    let microphone = deps.microphone()
    do {
      try await microphone.start(
        onFrame: { [weak self] frame in self?.frame(frame) },
        onInterrupt: { [weak self] in self?.interrupt() })
    } catch {
      // The stream started for this microphone ends: no socket stays. While this start still owns the view it goes
      // silently and the notice is the microphone's; after a stop its end is the recording's end.
      if self.stream === stream {
        if generation == startGeneration, view.phase == .starting {
          streamID += 1
          self.stream = nil
        }
        stream.abort()
      }
      // Nikt nie zdążył zrezygnować — odmowa mikrofonu jest zdaniem, nie stanem „nagrywam".
      if generation == startGeneration, view.phase == .starting { emit(VoiceView(notice: .microphone(error))) }
      return
    }
    // Rezygnacja w trakcie pytania o zgodę (stop, wysyłka, zmiana ekranu): mikrofon od razu w dół.
    guard generation == startGeneration, view.phase == .starting else {
      microphone.stop()
      return
    }
    self.microphone = microphone
    startedAt = deps.scheduler.now
    lastVoiceAt = startedAt
    microphoneOpenedAt = startedAt
    // The microphone records from now on, whether or not the stream is ready: speech waits in its backlog.
    emit(VoiceView(phase: .recording, buffers: view.buffers, notice: nil, secondsLeft: view.secondsLeft))
    if !early { attach(stream) }
    traceReady()
    armTick()
  }

  private func attach(_ stream: any DictationStream) {
    self.stream = stream
    if pendingRebase {
      pendingRebase = false
      stream.resetBuffers()
    }
    stream.start()
  }

  /// The ready line, once per recording: the microphone open and the first connection streaming.
  private func traceReady() {
    guard !readyTraced, let opened = microphoneOpenedAt, let readiness = stream?.readiness else { return }
    readyTraced = true
    deps.trace(DictationReadyTrace.line(tap: tappedAt, microphoneOpen: opened, readiness: readiness))
  }

  /// Stop z zatwierdzeniem: ostatnia ramka, finalizacja, tekst zostaje.
  func stop() {
    stop(with: nil)
  }

  /// Przerwanie z zewnątrz (tło, rozmowa, zmiana wyjścia audio): nie błąd, tylko zdanie
  /// „nagrywanie przerwane" i tekst, który został.
  func interrupt() {
    stop(with: .interrupted)
  }

  /// Anulowanie: tekst dyktowania przepada w całości.
  func cancel() {
    guard active else { return }
    pendingNotice = nil
    guard let stream else {
      // Jeszcze przed strumieniem (pytanie o zgodę): `start` zwolni mikrofon, gdy wróci.
      shutdownNow()
      emit(VoiceView())
      return
    }
    emit(VoiceView(phase: .finalizing))
    shutdownNow()
    stream.abort()
  }

  /// Człowiek dopisał coś z klawiatury: podyktowany tekst jest już jego, bufory od zera — bez tego
  /// następny token dokleiłby się do zdania, którego w polu nie ma.
  func rebase() {
    if let stream {
      stream.resetBuffers()
    } else if active {
      pendingRebase = true
    }
    view.buffers = .empty
  }

  // MARK: - Wnętrze

  private func stop(with notice: VoiceNotice?) {
    guard active, !stopping, view.phase != .finalizing else { return }
    guard let stream else {
      // Rezygnacja w trakcie pytania o zgodę: nic nie zdążyło się nagrać.
      emit(VoiceView(notice: notice == .interrupted ? nil : notice))
      return
    }
    pendingNotice = notice
    stopping = true
    emit(VoiceView(phase: .finalizing, buffers: view.buffers, notice: nil, secondsLeft: view.secondsLeft))
    Task { [weak self] in
      await self?.shutdown(flush: true)
      guard let self else { return }
      self.stopping = false
      stream.finish()
    }
  }

  /// The phase follows the microphone (`.recording` from its open); the stream only marks a lost connection after it
  /// has streamed once. Before that a retry keeps the speech in the stream's backlog, so the phase stays.
  private func streamState(_ state: SonioxStream.State) {
    streaming = state == .streaming
    switch state {
    case .streaming:
      streamed = true
      traceReady()
      guard view.phase == .reconnecting else { return }
      emit(VoiceView(phase: .recording, buffers: view.buffers, notice: nil, secondsLeft: view.secondsLeft))
    case .reconnecting:
      guard streamed, view.phase == .recording else { return }
      emit(VoiceView(phase: .reconnecting, buffers: view.buffers, notice: nil, secondsLeft: view.secondsLeft))
    case .idle, .connecting, .failed:
      break
    }
  }

  /// Zwalnia mikrofon; `flush` tylko przy zatwierdzeniu — przy anulowaniu nie ma po co.
  ///
  /// Mikrofon zostaje pod `self.microphone` do końca spłukania: anulowanie, przejęcie przez inny
  /// ekran i koniec strumienia w tym oknie zatrzymują go od razu (`shutdownNow`). Wznowione zadanie
  /// zatrzymuje go tylko wtedy, gdy nikt tego nie zrobił — inaczej jego `stop` wyłączyłby wspólną
  /// sesję audio, którą zdążyło włączyć nowe nagranie.
  private func shutdown(flush: Bool) async {
    tickTimer?.cancel()
    tickTimer = nil
    guard let microphone else { return }
    if flush { await microphone.flush() }
    guard self.microphone === microphone else { return }
    self.microphone = nil
    microphone.stop()
  }

  private func shutdownNow() {
    tickTimer?.cancel()
    tickTimer = nil
    microphone?.stop()
    microphone = nil
  }

  private func finish(_ end: SonioxStream.End) {
    shutdownNow()
    let stream = stream
    self.stream = nil
    stopping = false
    // Hipoteza, której nikt już nie potwierdzi, zostaje tekstem.
    let buffers = SonioxText.fold(stream?.buffers ?? view.buffers)
    let notice: VoiceNotice?
    switch end {
    case .finished:
      notice = pendingNotice
    case let .failed(.disabled(message)):
      emit(VoiceView(buffers: buffers))
      handlers.disabled(message)
      pendingNotice = nil
      return
    case let .failed(.mint(message)):
      // Bez żadnego tekstu liczy się powód (np. „za szybko"); z tekstem — to, że został.
      notice = buffers.text.isEmpty ? (message.isEmpty ? nil : .message(message)) : .streamFailed
    case .failed(.dropped):
      notice = .streamFailed
    case .failed(.rateLimited):
      notice = .message(UICopy.voiceRateLimited)
    case let .failed(.rejected(failure)):
      pendingNotice = nil
      rejected(failure, buffers: buffers)
      return
    }
    pendingNotice = nil
    emit(VoiceView(buffers: buffers, notice: notice))
  }

  /// Odmowa rozpoznawania mowy (z `prepare()` albo z końca strumienia): jedna droga dla obu. Zdanie błędu
  /// zawsze, z tekstem i bez; tekst zostaje.
  private func rejected(_ failure: DictationFailure, buffers: VoiceBuffers) {
    emit(VoiceView(buffers: buffers, notice: .dictation(failure)))
  }

  private func frame(_ frame: VoiceFrame) {
    lastFrameAt = deps.scheduler.now
    if frame.peak >= voiceSilencePeak { lastVoiceAt = deps.scheduler.now }
    stream?.sendAudio(frame.pcm)
    handlers.level(frame.peak)
  }

  private func armTick() {
    tickTimer?.cancel()
    tickTimer = deps.scheduler.schedule(after: deps.timing.tick) { [weak self] in
      guard let self else { return }
      self.tickTimer = nil
      guard self.active, self.view.phase != .finalizing else { return }
      let now = self.deps.scheduler.now
      let elapsed = now - self.startedAt
      if elapsed >= self.maxSession {
        self.stop(with: .sessionLimit(seconds: Int(self.maxSession.rounded())))
        return
      }
      if now - self.lastVoiceAt >= self.deps.timing.silenceLimit {
        self.stop(with: .silence)
        return
      }
      if self.view.phase == .recording {
        let left = voiceLimitCountdown(elapsed: elapsed, maxSession: self.maxSession, warning: self.deps.timing.limitWarning)
        if left != self.view.secondsLeft {
          self.emit(VoiceView(phase: .recording, buffers: self.view.buffers, notice: nil, secondsLeft: left))
        }
      }
      self.armTick()
    }
  }

  private func emit(_ next: VoiceView) {
    view = next
    handlers.view(next)
  }
}
