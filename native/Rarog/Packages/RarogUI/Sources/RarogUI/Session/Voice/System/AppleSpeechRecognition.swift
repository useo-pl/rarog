import AVFAudio
import Foundation
import Speech

// Rozpoznawanie mowy Apple na `SFSpeechRecognizer`: produkcyjne `SpeechRecognition` trasy systemowej. Tu jest
// tylko odczyt systemu i przekład na styki strumienia; drogę wybiera `SystemDictationPolicy`. Do działania potrzebny
// `NSSpeechRecognitionUsageDescription` w Info.plist apki (bez niego system zatrzymuje apkę przy pytaniu o zgodę).
// Właściciel: dyktowanie.

@MainActor
final class AppleSpeechRecognition: SpeechRecognition {
  init() {}

  func authorization() -> SpeechAuthorization {
    Self.authorization(SFSpeechRecognizer.authorizationStatus())
  }

  func requestAuthorization() async -> SpeechAuthorization {
    Self.authorization(await Self.ask())
  }

  func recognizer(locale: String) -> (any SpeechRecognizer)? {
    SFSpeechRecognizer(locale: Locale(identifier: locale)).map(AppleSpeechRecognizer.init(recognizer:))
  }

  /// Odpowiedź przychodzi na dowolnej kolejce (dokumentacja `requestAuthorization(_:)`), więc domknięcie nie może
  /// dziedziczyć izolacji głównego aktora.
  nonisolated private static func ask() async -> SFSpeechRecognizerAuthorizationStatus {
    await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
  }

  /// Nieznany przyszły stan to brak zgody: bez niej dźwięk nie wychodzi.
  nonisolated static func authorization(_ status: SFSpeechRecognizerAuthorizationStatus) -> SpeechAuthorization {
    switch status {
    case .notDetermined: .notDetermined
    case .denied: .denied
    case .restricted: .restricted
    case .authorized: .authorized
    @unknown default: .denied
    }
  }

  /// Żądanie zadania: flaga drogi z `SpeechRequest`, reszta stała.
  static func request(_ request: SpeechRequest) -> SFSpeechAudioBufferRecognitionRequest {
    let result = SFSpeechAudioBufferRecognitionRequest()
    result.requiresOnDeviceRecognition = request.requiresOnDeviceRecognition
    result.shouldReportPartialResults = true
    result.addsPunctuation = true
    result.taskHint = .dictation
    return result
  }

  /// Rodzaj wyniku z `isFinal` i czasu mowy w `speechRecognitionMetadata`. Recognizer z modelem na urządzeniu
  /// (od iOS 18) po pauzie oddaje wynik bez `isFinal`, ale z metadanymi mowy, a kolejne hipotezy tego samego zadania
  /// zaczyna od pustego tekstu (Apple Developer Forums, wątek 764809). Taki wynik zamyka fragment; potraktowany jak
  /// hipoteza zniknąłby z pola przy pierwszym słowie po pauzie.
  nonisolated static func kind(isFinal: Bool, speechDuration: TimeInterval?) -> SpeechResultKind {
    if isFinal { return .final }
    return (speechDuration ?? 0) > 0 ? .segmentEnd : .partial
  }

  /// Format próbek zadania: Int16 16 kHz mono, czyli ramka nagrywarki bez przeliczania. Ten sam format zgłasza
  /// `SFSpeechAudioBufferRecognitionRequest.nativeAudioFormat` (macOS 27.2: 1 kanał, 16000 Hz, Int16), a `append`
  /// wymaga formatu natywnego.
  static let audioFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

  /// Ramka PCM s16le 16 kHz mono → bufor zadania; nieparzysty ostatni bajt odpada.
  static func buffer(_ pcm: Data) -> AVAudioPCMBuffer? {
    let count = pcm.count / 2
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(count)),
      let samples = buffer.int16ChannelData?[0]
    else { return nil }
    pcm.withUnsafeBytes { raw in
      for index in 0..<count {
        samples[index] = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
      }
    }
    buffer.frameLength = AVAudioFrameCount(count)
    return buffer
  }
}

@MainActor
final class AppleSpeechRecognizer: SpeechRecognizer {
  private let recognizer: SFSpeechRecognizer

  init(recognizer: SFSpeechRecognizer) {
    self.recognizer = recognizer
  }

  var facts: SpeechRecognizerFacts {
    SpeechRecognizerFacts(
      locale: recognizer.locale.identifier(.bcp47), isAvailable: recognizer.isAvailable,
      supportsOnDeviceRecognition: recognizer.supportsOnDeviceRecognition)
  }

  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask {
    let sfRequest = AppleSpeechRecognition.request(request)
    let task = AppleSpeechTask(request: sfRequest, events: events)
    task.attach(recognizer.recognitionTask(with: sfRequest, resultHandler: AppleSpeechTask.handler(for: task)))
    return task
  }
}

/// Zadanie na `SFSpeechRecognitionTask`. Wyniki przychodzą na kolejce recognizera; tekst i kod błędu idą dalej
/// przez główną kolejkę, w kolejności przyjścia. Po `cancel()` żadne zdarzenie nie wychodzi.
@MainActor
final class AppleSpeechTask: SpeechTask {
  private let request: SFSpeechAudioBufferRecognitionRequest
  private let events: SpeechTaskEvents
  private var task: SFSpeechRecognitionTask?
  private var cancelled = false

  init(request: SFSpeechAudioBufferRecognitionRequest, events: SpeechTaskEvents) {
    self.request = request
    self.events = events
  }

  func attach(_ task: SFSpeechRecognitionTask) {
    self.task = task
  }

  func append(_ pcm: Data) {
    guard !cancelled, let buffer = AppleSpeechRecognition.buffer(pcm) else { return }
    request.append(buffer)
  }

  func endAudio() {
    guard !cancelled else { return }
    request.endAudio()
  }

  func cancel() {
    guard !cancelled else { return }
    cancelled = true
    task?.cancel()
  }

  /// Obsługa wyniku poza izolacją głównego aktora: domknięcie zbudowane w metodzie tej klasy dziedziczyłoby
  /// izolację, a sprawdzenie izolacji doklejone do domknięcia dla API Objective-C zatrzymuje apkę, gdy system woła
  /// je z innej kolejki (wzór: `MicrophoneCapture.installTap`).
  nonisolated static func handler(
    for task: AppleSpeechTask
  ) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
    { [weak task] result, error in
      let text = result?.bestTranscription.formattedString
      let kind = AppleSpeechRecognition.kind(
        isFinal: result?.isFinal ?? false, speechDuration: result?.speechRecognitionMetadata?.speechDuration)
      let failure = error.map { error in
        let error = error as NSError
        return SpeechTaskError(domain: error.domain, code: error.code)
      }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let task, !task.cancelled else { return }
          if let text { task.events.result(text, kind) }
          if let failure, !task.cancelled { task.events.failure(failure) }
        }
      }
    }
  }
}
