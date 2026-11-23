#if os(iOS)
import Foundation
import RarogContract
import UIKit

/// Zależności dyktowania na urządzeniu: mikrofon, gniazdo Soniox, rozpoznawanie mowy Apple, zegar. Produkcja:
/// `AVAudioEngine`, `URLSessionWebSocketTask` i `SFSpeechRecognizer`; build Debug ze zmienną `RAROG_UI_TEST_VOICE`
/// gra scenariusz (`ScriptedVoice`) — klucz Soniox i tak idzie prawdziwą drogą z serwera. Właściciel: dyktowanie.
@MainActor
struct VoiceServices {
  var microphone: @MainActor () -> any VoiceMicrophone
  var connect: VoiceSocketFactory
  /// Rozpoznawanie mowy Apple trasy systemowej (`SystemDictationStream`); nowe na każde nagranie.
  var speech: @MainActor () -> any SpeechRecognition
  var scheduler: any VoiceScheduler
  var timing: VoiceTiming
  /// Język rozpoznawania trasy systemowej: język apki (`SystemDictationPolicy.locale`).
  var language: CopyLanguage = .current
  /// Otwiera adres: przycisk „Ustawienia” przy odmowie zgody na mikrofon albo na rozpoznawanie mowy.
  var open: @MainActor (URL) -> Void = { UIApplication.shared.open($0) }
  /// The microphone permission is already granted: the Soniox key fetch then starts while the microphone opens.
  var microphoneGranted: @MainActor () -> Bool = { MicrophoneCapture.permissionGranted }

  static let current: VoiceServices = {
    let scheduler = TaskVoiceScheduler()
    #if DEBUG
    if let mode = ScriptedVoice.mode {
      return VoiceServices(
        microphone: { ScriptedMicrophone(scheduler: scheduler, denied: mode == "denied") },
        connect: { _, _, events in ScriptedSocket(scheduler: scheduler, events: events) },
        speech: { ScriptedSpeech(scheduler: scheduler) },
        scheduler: scheduler, timing: .production, microphoneGranted: { mode != "denied" })
    }
    #endif
    return VoiceServices(
      microphone: { MicrophoneCapture() }, connect: URLSessionVoiceSocket.factory,
      speech: { AppleSpeechRecognition() }, scheduler: scheduler, timing: .production)
  }()

  /// Ustawienia apki w iOS — tam człowiek przywraca zgodę na mikrofon i na rozpoznawanie mowy.
  func openSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    open(url)
  }

  /// Zależności nagrywarki dla trasy, która nagrywa (ekran wyboru nie nagrywa nic). `soniox`: klucz tymczasowy
  /// z serwera (`mint`) i gniazdo. `system`: rozpoznawanie mowy Apple bez klucza i bez gniazda — `mint` gospodarza
  /// nie trafia do nagrywarki, więc nic nie idzie do Soniox ani do serwera Rarog, a start nagrania zapisuje drogę
  /// do śladu (`trace`). On the Soniox route the trace gets the line of the recording that got ready.
  func recorder(
    _ engine: DictationEngine, mint: @escaping @MainActor () async -> VoiceMint,
    trace: @escaping @MainActor (String) -> Void
  ) -> VoiceRecorder.Deps {
    switch engine {
    case .soniox:
      return VoiceRecorder.Deps(
        microphone: microphone, mint: mint, connect: connect, scheduler: scheduler, timing: timing,
        microphoneGranted: microphoneGranted, trace: trace)
    case .system:
      let speech = speech, language = language, scheduler = scheduler, timing = timing
      return VoiceRecorder.Deps(
        microphone: microphone, mint: { .stop("") }, connect: connect, scheduler: scheduler, timing: timing,
        makeStream: { handlers in
          SystemRecordingTrace.stream(
            language: language, speech: speech(), scheduler: scheduler, timing: timing, handlers: handlers,
            trace: trace)
        })
    }
  }
}

/// Trasa nagrania: ``DictationRoute`` bez ekranu wyboru.
enum DictationEngine: Sendable, Equatable {
  case system
  case soniox
}

/// Linie śladu nagrania na trasie systemowej, bez tekstu i dźwięku: na starcie API, droga i locale,
/// na końcu liczba fragmentów zatwierdzonych po pauzie, wyników pominiętych jako powtórka i zadań rozpoznawania.
enum DictationTrace {
  static func systemStart(_ route: SystemDictationRoute) -> String {
    "dyktowanie systemowe: \(route.summary)"
  }

  static func systemEnd(segments: Int, repeats: Int, tasks: Int) -> String {
    "dyktowanie systemowe: koniec fragmenty=\(segments) powtórki=\(repeats) zadania=\(tasks)"
  }
}

/// Strumień systemowy z linią śladu w chwili, gdy nagranie rusza (`streaming` po udanym `prepare()` i otwarciu
/// mikrofonu), i drugą przy jego `done`: odbiór na urządzeniach czyta drogę każdej próby i to, czy recognizer
/// zamykał fragmenty po pauzie, z `client.log`, nie z ekranu.
@MainActor
private final class SystemRecordingTrace {
  weak var stream: SystemDictationStream?
  private let trace: @MainActor (String) -> Void
  private var started = false
  private var ended = false

  private init(trace: @escaping @MainActor (String) -> Void) {
    self.trace = trace
  }

  static func stream(
    language: CopyLanguage, speech: any SpeechRecognition, scheduler: any VoiceScheduler, timing: VoiceTiming,
    handlers: SonioxStream.Handlers, trace: @escaping @MainActor (String) -> Void
  ) -> SystemDictationStream {
    let recording = SystemRecordingTrace(trace: trace)
    var wrapped = handlers
    let state = handlers.state, done = handlers.done
    wrapped.state = { next in
      if next == .streaming { recording.start() }
      state(next)
    }
    wrapped.done = { end in
      recording.end()
      done(end)
    }
    let stream = SystemDictationStream(
      language: language, speech: speech, scheduler: scheduler, timing: timing, handlers: wrapped)
    recording.stream = stream
    return stream
  }

  private func start() {
    guard !started, let route = stream?.route else { return }
    started = true
    trace(DictationTrace.systemStart(route))
  }

  /// Tylko po starcie: odmowa w `prepare()` nie ma nagrania, więc nie ma też jego końca.
  private func end() {
    guard started, !ended, let stream else { return }
    ended = true
    trace(
      DictationTrace.systemEnd(segments: stream.segmentEnds, repeats: stream.repeats, tasks: stream.tasksOpened))
  }
}

/// Miejsce, które nagrywa: pole wiadomości (`ComposerDictation`) albo notatka projektu (`NoteDictation`).
@MainActor
protocol DictationHost: AnyObject {
  /// Mikrofon przechodzi gdzie indziej: hipoteza staje się tekstem, nagranie w dół od razu.
  func handOff()
}

/// Mikrofon jest JEDEN na apkę: start w jednym miejscu przejmuje go od poprzedniego, a przejęcie
/// utrwala tekst poprzedniego miejsca.
@MainActor
final class DictationCenter {
  static let shared = DictationCenter()

  private weak var active: (any DictationHost)?

  func claim(_ next: any DictationHost) {
    if let previous = active, previous !== next { previous.handOff() }
    active = next
  }
}
#endif
