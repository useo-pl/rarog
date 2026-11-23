#if DEBUG
import Foundation
import RarogCore

// Dyktowanie ze scenariusza — WYŁĄCZNIE build Debug i zmienna `RAROG_UI_TEST_VOICE` (testy UI,
// `VoiceUITests`). Symulator nie ma mikrofonu, a testy nie łączą się z Soniox ani z rozpoznawaniem mowy Apple:
// klucz Soniox przychodzi prawdziwą drogą z serwera demo, a mikrofon, gniazdo i rozpoznawanie systemowe grają
// ustalony scenariusz. Wybór dyktowania w testach UI: `DictationTestMode`. The English script for screenshots:
// `RAROG_UI_TEST_VOICE_SCRIPT=en`. Właściciel: dyktowanie.

enum ScriptedVoice {
  static let environmentKey = "RAROG_UI_TEST_VOICE"

  /// Tryb z zmiennej uruchomienia: `1` = scenariusz, `denied` = odmowa mikrofonu; brak = produkcja.
  static var mode: String? { ProcessInfo.processInfo.environment[environmentKey] }

  /// `RAROG_UI_TEST_VOICE_SCRIPT=en`: the English script (for screenshots); without it, or with any
  /// other value, the default script.
  static let scriptKey = "RAROG_UI_TEST_VOICE_SCRIPT"

  /// The Soniox frames of one script: a hypothesis after three frames (a final part and a pending one) and the end
  /// after finalization, which repeats the pending part as final.
  struct Script: Equatable {
    let partial: String
    let tail: String

    /// Cały tekst zadania rozpoznawania Apple: hipoteza po trzech ramkach, wynik końcowy po końcu dźwięku.
    var systemPartial: String { ScriptedVoice.spoken(partial).text }
    var systemFinal: String { ScriptedVoice.spoken(partial, tail).text }
  }

  /// Hipoteza po trzech ramkach i domknięcie po finalizacji — razem „Dyktuję z iPada.". Rozpoznawanie systemowe
  /// ze scenariusza oddaje ten sam tekst, złożony z tych ramek (`systemPartial`, `systemFinal`).
  static let polish = Script(
    partial: #"{"tokens":[{"text":"Dyktuję","is_final":true},{"text":" z","is_final":false}]}"#,
    tail: #"{"tokens":[{"text":" z iPada.","is_final":true},{"text":"<fin>","is_final":true}]}"#)
  /// The hypothesis is the whole sentence without its full stop, so the field reads well mid-recording.
  static let english = Script(
    partial: #"{"tokens":[{"text":"Then do the same for the","is_final":true},"#
      + #"{"text":" September export","is_final":false}]}"#,
    tail: #"{"tokens":[{"text":" September export.","is_final":true},{"text":"<fin>","is_final":true}]}"#)

  static func script(environment: [String: String]) -> Script {
    environment[scriptKey] == "en" ? english : polish
  }

  /// The script of this launch.
  static var current: Script { script(environment: ProcessInfo.processInfo.environment) }

  static var partial: String { current.partial }
  static var tail: String { current.tail }
  static let finished = #"{"finished":true}"#
  /// Końcówka przychodzi z opóźnieniem (poniżej limitu finalizacji 2,5 s) — test zdąży stuknąć
  /// „Wyślij" w trakcie kończenia i sprawdzić, że wysyłka na nią czeka.
  static let tailDelay: TimeInterval = 1.5
  static var systemPartial: String { current.systemPartial }
  static var systemFinal: String { current.systemFinal }

  /// Tekst pola po ramkach scenariusza Soniox — rozpoznawanie systemowe niesie cały tekst zadania naraz.
  fileprivate static func spoken(_ frames: String...) -> VoiceBuffers {
    frames.reduce(.empty) { buffers, frame in SonioxText.apply(buffers, SonioxReply.parse(frame)?.tokens ?? []) }
  }
}

/// Wybór dyktowania w testach UI (build Debug): `RAROG_UI_TEST_DICTATION` = `none` | `system` | `soniox`; bez niej,
/// ze scenariuszem `RAROG_UI_TEST_VOICE`, wybór Soniox — testy dyktowania sprzed ekranu wyboru grają dalej bez
/// niego. Wybór zawsze w pamięci, nigdy w prawdziwych `UserDefaults`. Apka woła to z `AppEnvironment`.
public enum DictationTestMode {
  public static let environmentKey = "RAROG_UI_TEST_DICTATION"

  /// `nil` = produkcja (wybór w `UserDefaults`). Nieznana wartość zmiennej = brak wyboru (ekran).
  public static func services(environment: [String: String], sonioxAllowed: Bool) -> DictationServices? {
    if let mode = environment[environmentKey] {
      return .memory(sonioxAllowed: sonioxAllowed, choice: DictationChoice(rawValue: mode))
    }
    guard environment[ScriptedVoice.environmentKey] != nil else { return nil }
    return .memory(sonioxAllowed: sonioxAllowed, choice: .soniox)
  }

  /// `RAROG_UI_TEST_RESET`: wybór z poprzedniego przebiegu znika, następne stuknięcie mikrofonu otwiera ekran.
  public static func reset(defaults: UserDefaults) {
    DictationChoiceStore(defaults: defaults).clear()
  }
}

/// Mikrofon ze scenariusza: ramka 100 ms ze szczytem 0,3 (mowa, nie cisza) co 100 ms.
@MainActor
final class ScriptedMicrophone: VoiceMicrophone {
  private let scheduler: any VoiceScheduler
  private let denied: Bool
  private var timer: VoiceTimer?
  private var onFrame: (@MainActor (VoiceFrame) -> Void)?

  init(scheduler: any VoiceScheduler, denied: Bool) {
    self.scheduler = scheduler
    self.denied = denied
  }

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    if denied { throw .denied }
    self.onFrame = onFrame
    tick()
  }

  func flush() async {}

  func stop() {
    timer?.cancel()
    timer = nil
    onFrame = nil
  }

  private func tick() {
    timer = scheduler.schedule(after: 0.1) { [weak self] in
      guard let self, let onFrame = self.onFrame else { return }
      onFrame(VoiceFrame(pcm: Data(count: PCMFramer.frameSamples * 2), peak: 0.3))
      self.tick()
    }
  }
}

/// Gniazdo ze scenariusza: otwiera się po chwili, po trzech ramkach odsyła hipotezę, po końcu
/// strumienia — z opóźnieniem — domknięcie i `finished`.
@MainActor
final class ScriptedSocket: VoiceSocket {
  private let scheduler: any VoiceScheduler
  private let events: VoiceSocketEvents
  private var frames = 0
  private var closed = false
  private var timers: [VoiceTimer] = []

  init(scheduler: any VoiceScheduler, events: VoiceSocketEvents) {
    self.scheduler = scheduler
    self.events = events
    later(0.05) { $0.events.opened() }
  }

  func send(text: String) {
    guard !closed, text.isEmpty else { return }
    later(ScriptedVoice.tailDelay) { socket in
      socket.events.message(ScriptedVoice.tail)
      socket.events.message(ScriptedVoice.finished)
    }
  }

  func send(data: Data) {
    guard !closed else { return }
    frames += 1
    if frames == 3 { later(0) { $0.events.message(ScriptedVoice.partial) } }
  }

  func close() {
    closed = true
    for timer in timers { timer.cancel() }
    timers = []
  }

  private func later(_ seconds: TimeInterval, _ work: @escaping @MainActor (ScriptedSocket) -> Void) {
    timers.append(scheduler.schedule(after: seconds) { [weak self] in
      guard let self, !self.closed else { return }
      work(self)
    })
  }
}

/// Rozpoznawanie mowy Apple ze scenariusza (trasa systemowa): zgoda jest, recognizer każdego języka ma model mowy
/// na urządzeniu.
@MainActor
final class ScriptedSpeech: SpeechRecognition {
  private let scheduler: any VoiceScheduler

  init(scheduler: any VoiceScheduler) {
    self.scheduler = scheduler
  }

  func authorization() -> SpeechAuthorization { .authorized }
  func requestAuthorization() async -> SpeechAuthorization { .authorized }

  func recognizer(locale: String) -> (any SpeechRecognizer)? {
    ScriptedRecognizer(locale: locale, scheduler: scheduler)
  }
}

@MainActor
final class ScriptedRecognizer: SpeechRecognizer {
  let facts: SpeechRecognizerFacts
  private let scheduler: any VoiceScheduler

  init(locale: String, scheduler: any VoiceScheduler) {
    facts = SpeechRecognizerFacts(locale: locale, isAvailable: true, supportsOnDeviceRecognition: true)
    self.scheduler = scheduler
  }

  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask {
    ScriptedSpeechTask(scheduler: scheduler, events: events)
  }
}

/// Zadanie ze scenariusza: po trzech ramkach hipoteza, po końcu dźwięku — z opóźnieniem jak gniazdo — wynik
/// końcowy. Zdarzenia nigdy synchronicznie i nigdy po `cancel()`.
@MainActor
final class ScriptedSpeechTask: SpeechTask {
  private let scheduler: any VoiceScheduler
  private let events: SpeechTaskEvents
  private var frames = 0
  private var cancelled = false
  private var timers: [VoiceTimer] = []

  init(scheduler: any VoiceScheduler, events: SpeechTaskEvents) {
    self.scheduler = scheduler
    self.events = events
  }

  func append(_ pcm: Data) {
    guard !cancelled else { return }
    frames += 1
    if frames == 3 { later(0) { $0.events.result(ScriptedVoice.systemPartial, .partial) } }
  }

  func endAudio() {
    later(ScriptedVoice.tailDelay) { $0.events.result(ScriptedVoice.systemFinal, .final) }
  }

  func cancel() {
    cancelled = true
    for timer in timers { timer.cancel() }
    timers = []
  }

  private func later(_ seconds: TimeInterval, _ work: @escaping @MainActor (ScriptedSpeechTask) -> Void) {
    guard !cancelled else { return }
    timers.append(scheduler.schedule(after: seconds) { [weak self] in
      guard let self, !self.cancelled else { return }
      work(self)
    })
  }
}
#endif
