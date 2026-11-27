import Foundation
@testable import RarogUI

// Fakes of a recording's parts for the dictation tests on real hosts (`DictationRouteTests`, `LockScreenSendTests`):
// the microphones of the hosts with their log, a Soniox socket, and Apple speech recognition with a task whose
// results the test gives. Owner: dictation.

/// Dziennik mikrofonów obu gospodarzy: otwarcia po znaczniku, kolejność, otwarte teraz.
@MainActor
final class MicLog {
  var denied = false
  private(set) var starts: [String: Int] = [:]
  private(set) var events: [String] = []
  private(set) var open: [String] = []
  private(set) var maxOpen = 0
  /// Frame delivery of each open microphone.
  var feeds: [String: @MainActor (VoiceFrame) -> Void] = [:]

  /// 100 ms of speech from the open microphone with this tag.
  func speak(_ tag: String) {
    feeds[tag]?(VoiceFrame(pcm: Data(count: VoiceFrame.bytesPerSecond / 10), peak: 0.5))
  }

  func started(_ tag: String) { starts[tag, default: 0] += 1 }

  func opened(_ tag: String) {
    events.append("open \(tag)")
    open.append(tag)
    maxOpen = max(maxOpen, open.count)
  }

  func closed(_ tag: String) {
    events.append("close \(tag)")
    open.removeAll { $0 == tag }
  }
}

@MainActor
final class RouteMicrophone: VoiceMicrophone {
  private let tag: String
  private let log: MicLog
  private var isOpen = false

  init(tag: String, log: MicLog) {
    self.tag = tag
    self.log = log
  }

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    log.started(tag)
    if log.denied { throw .denied }
    isOpen = true
    log.feeds[tag] = onFrame
    log.opened(tag)
  }

  func flush() async {}

  func stop() {
    guard isOpen else { return }
    isOpen = false
    log.feeds[tag] = nil
    log.closed(tag)
  }
}

/// Gniazdo Soniox: otwiera się w następnym obrocie; pusta ramka (koniec strumienia) daje `finished`.
@MainActor
final class RouteSocket: VoiceSocket {
  private let events: VoiceSocketEvents
  private(set) var isOpen = false
  private var closed = false
  /// Final words Soniox gives only after the end of the audio (the tail of a recording); `nil` = none.
  var tail: String?

  /// `opens: false` = the connection hangs and never opens.
  init(events: VoiceSocketEvents, opens: Bool = true) {
    self.events = events
    guard opens else { return }
    Task { @MainActor [weak self] in
      guard let self, !self.closed else { return }
      self.isOpen = true
      events.opened()
    }
  }

  /// What Soniox does after the end frame: the tail and `finished`, a drop, or a 429 error frame.
  enum End { case finished, drop, limit }
  var end = End.finished

  func send(text: String) {
    guard !closed, text.isEmpty else { return }
    Task { @MainActor [weak self] in
      guard let self, !self.closed else { return }
      switch self.end {
      case .finished:
        if let tail = self.tail { self.events.message(#"{"tokens":[{"text":"\#(tail)","is_final":true}]}"#) }
        self.events.message(#"{"finished":true}"#)
      case .drop:
        self.drop()
      case .limit:
        self.events.message(#"{"error_code":429,"error_type":"limit_exceeded","error_message":"Limit exceeded."}"#)
      }
    }
  }

  /// Opens a socket made with `opens: false`.
  func open() {
    guard !closed, !isOpen else { return }
    isOpen = true
    events.opened()
  }

  func send(data: Data) {}

  func close() { closed = true }

  var isClosed: Bool { closed }

  func message(_ json: String) { events.message(json) }

  /// Zerwanie z zewnątrz (sieć).
  func drop() {
    closed = true
    events.closed()
  }
}

/// Rozpoznawanie mowy Apple: zgoda, odpowiedź na pytanie, recognizer dla locale.
@MainActor
final class RouteSpeech: SpeechRecognition {
  var status: SpeechAuthorization = .authorized
  var answer: SpeechAuthorization = .authorized
  var facts: SpeechRecognizerFacts? = SpeechRecognizerFacts(
    locale: "pl-PL", isAvailable: true, supportsOnDeviceRecognition: true)
  private(set) var asked = 0
  /// Ostatnie zadanie rozpoznawania.
  private(set) var task: RouteSpeechTask?

  func authorization() -> SpeechAuthorization { status }

  func requestAuthorization() async -> SpeechAuthorization {
    asked += 1
    status = answer
    return answer
  }

  func recognizer(locale: String) -> (any SpeechRecognizer)? {
    guard let facts else { return nil }
    return RouteRecognizer(facts: facts) { [weak self] in self?.task = $0 }
  }
}

@MainActor
final class RouteRecognizer: SpeechRecognizer {
  let facts: SpeechRecognizerFacts
  private let made: @MainActor (RouteSpeechTask) -> Void

  init(facts: SpeechRecognizerFacts, made: @escaping @MainActor (RouteSpeechTask) -> Void) {
    self.facts = facts
    self.made = made
  }

  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask {
    let task = RouteSpeechTask(request: request, events: events)
    made(task)
    return task
  }
}

/// Zadanie: wyniki i błędy podaje test; koniec dźwięku oddaje ostatnią hipotezę jako wynik końcowy.
@MainActor
final class RouteSpeechTask: SpeechTask {
  let request: SpeechRequest
  private let events: SpeechTaskEvents
  private(set) var cancelled = false
  private var last = ""
  /// The final result only the end of the audio gives (a recording's last words); `nil` = the last hypothesis.
  var tail: String?
  /// `true`: the end of the audio waits for `answerEnd()`.
  var holdsEnd = false
  private(set) var audioEnded = false

  init(request: SpeechRequest, events: SpeechTaskEvents) {
    self.request = request
    self.events = events
  }

  func append(_ pcm: Data) {}

  func endAudio() {
    audioEnded = true
    if !holdsEnd { answerEnd() }
  }

  /// The recognizer's answer to the end of the audio: the tail, or else the last hypothesis, as the final result.
  func answerEnd() {
    Task { @MainActor [weak self] in
      guard let self, !self.cancelled else { return }
      self.events.result(self.tail ?? self.last, .final)
    }
  }

  func cancel() { cancelled = true }

  func partial(_ text: String) {
    last = text
    events.result(text, .partial)
  }

  /// Koniec fragmentu po pauzie: kolejne wyniki liczą się od zera.
  func segmentEnd(_ text: String) {
    last = ""
    events.result(text, .segmentEnd)
  }

  func fail(_ error: SpeechTaskError) { events.failure(error) }
}
