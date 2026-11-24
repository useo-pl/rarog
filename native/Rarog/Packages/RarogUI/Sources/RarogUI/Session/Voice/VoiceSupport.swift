import Foundation
import RarogContract
import RarogCore

// Styki dyktowania: zegar, gniazdo strumienia, mikrofon i wynik pobrania klucza. Nagrywarka
// (`VoiceRecorder`) i klient strumienia (`SonioxStream`) dostają je wstrzyknięte, więc ich reguły
// testują się na macOS bez mikrofonu, sieci i czekania. Właściciel: dyktowanie.

/// Rytm dyktowania, w sekundach.
public struct VoiceTiming: Sendable, Equatable {
  /// Opóźnienia kolejnych prób połączenia. Trzy próby — potem decyduje człowiek, nie pętla. Budżet wraca do
  /// pełna dopiero przy ramce wyniku (`SonioxStream`), nie przy samym otwarciu gniazda.
  public var reconnectDelays: [TimeInterval] = [0.4, 1.2, 3]
  /// Najkrótszy odstęp między pobraniami klucza. Lustro `VOICE_TOKEN_MIN_INTERVAL_MS` serwera (jeden klucz
  /// na 3 s): próba czeka co najmniej tyle od poprzedniego pobrania, inaczej serwer odpowie 429. To nie
  /// jest limit apki (godzinnego sufitu apka nie liczy), tylko zgranie rytmu prób z dławikiem serwera.
  public var minMintInterval: TimeInterval = 3
  /// Soniox wymaga ruchu co ≤ 20 s; keepalive leci tylko wtedy, gdy audio nie płynie.
  public var keepalive: TimeInterval = 15
  /// Ile czekamy na ostatnie słowa po `finalize` i końcu strumienia.
  public var finalizeTimeout: TimeInterval = 2.5
  /// Speech recorded before the first connection is ready waits for it (`SonioxStream`); above this much audio the
  /// oldest goes. The backlog goes in one burst and Soniox catches up at about speech rate, so the wait for the last
  /// words grows by the backlog sent.
  public var backlogLimit: TimeInterval = 5
  /// How long a stop waits for the first connection when speech is still waiting for it. Past it (or when that
  /// attempt fails) the recording ends with the failure notice and the text already in the field.
  public var stopConnectWait: TimeInterval = 3
  /// Tyknięcie licznika (cisza, limit, odliczanie).
  public var tick: TimeInterval = 1
  /// Minuta ciszy kończy nagrywanie — otwarty mikrofon kosztuje baterię i sesję.
  public var silenceLimit: TimeInterval = 60
  /// Od ilu sekund przed limitem sesji widać „zostało m:ss" (2 min przed 15 = od 13. minuty).
  public var limitWarning: TimeInterval = 120
  /// Limit sesji, gdy serwer nie podał `maxSessionSeconds`.
  public var defaultMaxSession: TimeInterval = 900

  public init() {}

  public static let production = VoiceTiming()
}

/// Próg „to nie jest mowa" na szczycie amplitudy ramki (0…1), ok. −40 dBFS: cisza z redukcją szumu
/// ma szczyty 0,001–0,005, najcichsza wypowiedź w tramwaju przebija 0,05.
let voiceSilencePeak: Float = 0.01

/// Zegar dyktowania: czas monotoniczny i timery na głównym aktorze.
@MainActor
protocol VoiceScheduler: AnyObject {
  /// Sekundy czasu monotonicznego.
  var now: TimeInterval { get }
  func schedule(after seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer
}

/// Uchwyt timera; `cancel()` jest idempotentne.
@MainActor
final class VoiceTimer {
  private var onCancel: (@MainActor () -> Void)?

  init(onCancel: @escaping @MainActor () -> Void) {
    self.onCancel = onCancel
  }

  func cancel() {
    onCancel?()
    onCancel = nil
  }
}

/// Zegar produkcyjny: zadanie na głównym aktorze z `Task.sleep`.
@MainActor
final class TaskVoiceScheduler: VoiceScheduler {
  var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

  func schedule(after seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer {
    let task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      work()
    }
    return VoiceTimer { task.cancel() }
  }
}

/// Zdarzenia gniazda strumienia. **Gniazdo nie woła ich synchronicznie** w trakcie zakładania
/// (otwarcie przychodzi najwcześniej w następnym obrocie), a po `close()` nie woła żadnego.
struct VoiceSocketEvents {
  var opened: @MainActor () -> Void
  var message: @MainActor (String) -> Void
  /// Zamknięcie ORAZ błąd — dla klienta to ten sam przypadek: strumienia już nie ma.
  var closed: @MainActor () -> Void
}

/// Gniazdo WebSocket do Soniox (produkcja: `URLSessionVoiceSocket`).
@MainActor
protocol VoiceSocket: AnyObject {
  func send(text: String)
  func send(data: Data)
  func close()
}

/// Adres, lista protokołów WebSocket (`Sec-WebSocket-Protocol`, niesie klucz tymczasowy — `SonioxKey`)
/// i zdarzenia.
typealias VoiceSocketFactory = @MainActor (URL, [String], VoiceSocketEvents) -> any VoiceSocket

/// Ramka dźwięku: PCM s16le 16 kHz mono, 100 ms, i szczyt amplitudy (z niego liczy się cisza).
struct VoiceFrame: Sendable, Equatable {
  let pcm: Data
  let peak: Float

  /// 16 000 samples of 2 bytes per second.
  static let bytesPerSecond = 32_000
}

/// Odmowa mikrofonu — zdanie po polsku składa `UICopy`.
public enum VoiceMicError: Error, Sendable, Equatable {
  /// Człowiek nie dał zgody (albo ją cofnął) — ponawianie bez Ustawień nie ma sensu.
  case denied
  /// Urządzenie nie ma wejścia audio.
  case unavailable
  /// Mikrofon zajęty (rozmowa, inna apka nagrywa).
  case busy
  case failed
}

/// Mikrofon: ramki z wątku audio dostarczane na głównym aktorze, w kolejności.
@MainActor
protocol VoiceMicrophone: AnyObject {
  /// Prosi o zgodę (pytanie systemowe potrafi stać minutę) i otwiera wejście.
  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError)
  /// Wypycha ostatnią, niepełną ramkę — po wszystkich wcześniejszych.
  func flush() async
  /// Zwalnia mikrofon. Idempotentne.
  func stop()
}

/// Wynik pobrania klucza w języku strumienia: zdania już złożone (`UICopy`).
enum VoiceMint: Sendable, Equatable {
  case token(VoiceToken)
  /// Serwer odmówił drogi Soniox — jedno zdanie; mikrofon zostaje, a następne stuknięcie otwiera ekran
  /// „Dyktowanie”.
  case disabled(String)
  /// Bez kolejnej próby: za szybko, bramka wersji, wylogowanie, koniec dyktowania.
  case stop(String)
  /// Kolejna próba ma sens (sieć, 5xx).
  case retry(String)

  init(_ outcome: VoiceTokenOutcome) {
    switch outcome {
    case let .token(token): self = .token(token)
    case let .disabled(message): self = .disabled(message ?? UICopy.voiceDisabled)
    // Zdanie apki: mówi, co zrobić (odczekać), a nie tylko co się stało.
    case .rateLimited: self = .stop(UICopy.voiceRateLimited)
    case let .refused(message): self = .stop(message)
    case .loggedOut, .cancelled: self = .stop("")
    case let .failed(message): self = .retry(message ?? UICopy.voiceMintFailed)
    }
  }
}

/// Dlaczego rozpoznawanie mowy Apple (trasa systemowa) nie ruszyło albo przerwało nagranie. Strumień Soniox
/// tego błędu nie zwraca.
public enum DictationFailure: Sendable, Equatable, CaseIterable {
  /// Brak zgody na rozpoznawanie mowy (odmowa albo cofnięta w Ustawieniach).
  case speechDenied
  /// Rozpoznawanie mowy zablokowane na urządzeniu (Czas przed ekranem, profil).
  case speechRestricted
  /// Język bez rozpoznawania.
  case localeUnsupported
  /// Brak zasobów rozpoznawania na urządzeniu.
  case assetsMissing
  /// Serwery rozpoznawania Apple nieosiągalne.
  case appleServerUnreachable
  /// Dyktowanie (albo Siri) wyłączone w ustawieniach systemu.
  case dictationDisabled
  case engineFailed
}

/// Strumień rozpoznawania pod nagrywarką: Soniox (`SonioxStream`) albo rozpoznawanie Apple (trasa systemowa).
/// Zdarzenia oddaje przez `SonioxStream.Handlers`, dopiero po `start()`; `done` woła raz.
@MainActor
protocol DictationStream: AnyObject {
  /// Wołane PRZED otwarciem mikrofonu: zgoda na rozpoznawanie, język, zasoby. Błąd = nagranie się nie zaczyna,
  /// a mikrofon zostaje zamknięty. Strumień porzucony po `prepare()` nie dostaje już żadnego wywołania.
  func prepare() async -> DictationFailure?
  func start()
  /// PCM s16le 16 kHz mono, ramki 100 ms (`VoiceFrame`).
  func sendAudio(_ pcm: Data)
  func finish()
  func abort()
  func resetBuffers()
  var buffers: VoiceBuffers { get }
  /// `true`: `start()` may run before the microphone opens, so the connection is set up while the microphone opens
  /// and the stream keeps the speech until it is ready (`SonioxStream`). The recorder does it only when the
  /// microphone permission is already granted, so no system prompt stands between the tap and the key fetch.
  /// Default (extension): `false`, `start()` after the microphone.
  var startsBeforeMicrophone: Bool { get }
  /// Times of the first connection that carried audio; `nil` until then and for a stream without one.
  var readiness: DictationReadiness? { get }
}

extension DictationStream {
  var startsBeforeMicrophone: Bool { false }
  var readiness: DictationReadiness? { nil }
}

/// Clock times (`VoiceScheduler.now`) of the connection that first carried audio, and the audio sent to it in one
/// burst when it opened.
struct DictationReadiness: Sendable, Equatable {
  /// The key request of that attempt.
  var keyRequested: TimeInterval
  /// The key in hand.
  var keyReceived: TimeInterval
  /// The socket open and configured: audio flows.
  var streaming: TimeInterval
  /// Seconds of audio sent in the burst.
  var backlog: TimeInterval
}

/// The trace line of a recording that got ready (microphone open and the first connection streaming): stage times in
/// whole milliseconds from the tap, never any text or audio.
enum DictationReadyTrace {
  static func line(tap: TimeInterval, microphoneOpen: TimeInterval, readiness: DictationReadiness) -> String {
    func ms(_ seconds: TimeInterval) -> Int { Int((seconds * 1000).rounded()) }
    let ready = max(microphoneOpen, readiness.streaming)
    return "dictation: ready after \(ms(ready - tap)) ms (microphone \(ms(microphoneOpen - tap)) ms, "
      + "key \(ms(readiness.keyReceived - readiness.keyRequested)) ms, "
      + "socket \(ms(readiness.streaming - readiness.keyReceived)) ms), backlog \(ms(readiness.backlog)) ms"
  }
}

/// The reason word of `dictation: ended <reason>` for a recording that ended by itself, from its notice; never the
/// notice's sentence (a key refusal carries the server's text).
enum DictationEndTrace {
  static func reason(_ notice: VoiceNotice) -> String {
    switch notice {
    case .silence: "silence"
    case .sessionLimit: "session-limit"
    case .interrupted: "interrupted"
    case .streamFailed: "stream-failed"
    case .microphone: "microphone"
    case .dictation: "dictation-failed"
    case .message: "refused"
    }
  }
}
