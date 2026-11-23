import AVFAudio
import Foundation
import RarogContract
@testable import RarogUI
import Speech
import Testing

// Dyktowanie systemowe (trasa `system`): wybór drogi z tabeli warunków, strumień
// rozpoznawania Apple pod nagrywarką i odczyt `SFSpeechRecognizer` — na atrapie rozpoznawania za protokołem
// `SpeechRecognition`, bez zgody TCC, mikrofonu i sieci. Granica prywatności: dźwięk idzie do serwerów Apple
// wyłącznie wtedy, gdy recognizer nie ma modelu na urządzeniu. Właściciel: dyktowanie.

/// Ręczny zegar strumienia (limit finalizacji bez czekania).
@MainActor
private final class StepClock: VoiceScheduler {
  private var queue: [(id: Int, at: TimeInterval, work: @MainActor () -> Void)] = []
  private var nextId = 0
  private(set) var now: TimeInterval = 0

  func schedule(after seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer {
    nextId += 1
    let id = nextId
    queue.append((id, now + seconds, work))
    return VoiceTimer { [weak self] in self?.queue.removeAll { $0.id == id } }
  }

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

/// Zadanie rozpoznawania z atrapy: zapisuje żądanie, dźwięk, koniec i anulowanie; wyniki i błędy podaje test.
@MainActor
private final class FakeSpeechTask: SpeechTask {
  let request: SpeechRequest
  private let events: SpeechTaskEvents
  private(set) var audio: [Data] = []
  private(set) var ended = false
  private(set) var cancelled = false

  init(request: SpeechRequest, events: SpeechTaskEvents) {
    self.request = request
    self.events = events
  }

  func append(_ pcm: Data) { audio.append(pcm) }
  func endAudio() { ended = true }
  func cancel() { cancelled = true }

  func partial(_ text: String) { events.result(text, .partial) }
  func segmentEnd(_ text: String) { events.result(text, .segmentEnd) }
  func final(_ text: String) { events.result(text, .final) }
  func fail(_ domain: String, _ code: Int) { events.failure(SpeechTaskError(domain: domain, code: code)) }
}

@MainActor
private final class FakeRecognizer: SpeechRecognizer {
  var facts: SpeechRecognizerFacts
  private(set) var tasks: [FakeSpeechTask] = []
  /// Starty zadania, gdy wcześniejsze nie było anulowane (na prawdziwym recognizerze kod 1100).
  private(set) var overlaps = 0

  init(facts: SpeechRecognizerFacts) {
    self.facts = facts
  }

  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask {
    if tasks.contains(where: { !$0.cancelled }) { overlaps += 1 }
    let task = FakeSpeechTask(request: request, events: events)
    tasks.append(task)
    return task
  }
}

/// Rozpoznawanie mowy z atrapy: stan zgody, odpowiedź na pytanie o zgodę i recognizer dla locale.
@MainActor
private final class FakeSpeech: SpeechRecognition {
  var status: SpeechAuthorization = .authorized
  /// Wynik pytania systemowego o zgodę.
  var answer: SpeechAuthorization = .authorized
  /// Recognizer, który dostanie każde locale; `nil` = język bez rozpoznawania.
  var facts: SpeechRecognizerFacts? = SpeechRecognizerFacts(
    locale: "pl-PL", isAvailable: true, supportsOnDeviceRecognition: true)
  private(set) var asked = 0
  private(set) var locales: [String] = []
  private(set) var recognizers: [FakeRecognizer] = []
  /// Dziennik kolejności (pytanie o zgodę wobec mikrofonu).
  var onAsk: (@MainActor () -> Void)?

  func authorization() -> SpeechAuthorization { status }

  func requestAuthorization() async -> SpeechAuthorization {
    asked += 1
    onAsk?()
    status = answer
    return answer
  }

  func recognizer(locale: String) -> (any SpeechRecognizer)? {
    locales.append(locale)
    guard let facts else { return nil }
    let recognizer = FakeRecognizer(facts: facts)
    recognizers.append(recognizer)
    return recognizer
  }
}

/// Mikrofon nagrywarki: licznik otwarć i ramki z testu.
@MainActor
private final class TapMicrophone: VoiceMicrophone {
  private(set) var starts = 0
  private(set) var isOpen = false
  var onStart: (@MainActor () -> Void)?
  private var onFrame: (@MainActor (VoiceFrame) -> Void)?

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    starts += 1
    onStart?()
    self.onFrame = onFrame
    isOpen = true
  }

  func flush() async {}

  func stop() {
    isOpen = false
    onFrame = nil
  }

  func frame() { onFrame?(VoiceFrame(pcm: Data(count: 3200), peak: 0.3)) }
}

/// Dziennik kolejności zdarzeń w teście.
@MainActor
private final class EventLog {
  var entries: [String] = []
}

@MainActor
private final class SystemHarness {
  let clock = StepClock()
  let speech = FakeSpeech()
  var buffers: [VoiceBuffers] = []
  var states: [SonioxStream.State] = []
  var done: [SonioxStream.End] = []
  var stream: SystemDictationStream!

  init(language: CopyLanguage = .pl) {
    stream = SystemDictationStream(
      language: language, speech: speech, scheduler: clock, timing: .production,
      handlers: .init(
        buffers: { [unowned self] in self.buffers.append($0) },
        state: { [unowned self] in self.states.append($0) },
        token: { _ in Issue.record("trasa systemowa nie pobiera klucza") },
        done: { [unowned self] in self.done.append($0) }))
  }

  /// `prepare()`, a po zgodzie `start()` — jak nagrywarka.
  @discardableResult
  func begin() async -> DictationFailure? {
    let failure = await stream.prepare()
    if failure == nil { stream.start() }
    return failure
  }

  var tasks: [FakeSpeechTask] { speech.recognizers.flatMap(\.tasks) }
  var task: FakeSpeechTask { tasks[tasks.count - 1] }
  var recognizer: FakeRecognizer { speech.recognizers[speech.recognizers.count - 1] }
}

private let assistant = SpeechTaskError.assistantDomain
private let lsr = SpeechTaskError.recognizerDomain

private func facts(_ locale: String = "pl-PL", available: Bool = true, onDevice: Bool) -> SpeechRecognizerFacts {
  SpeechRecognizerFacts(locale: locale, isAvailable: available, supportsOnDeviceRecognition: onDevice)
}

private func route(_ path: SystemDictationPath, _ locale: String = "pl-PL") -> SystemPrepareStep {
  .route(SystemDictationRoute(path: path, locale: locale))
}

@Suite("dyktowanie systemowe")
struct SystemDictationTests {
  @Suite("reguła drogi: tabela warunków")
  struct Policy {
    @Test("przed nagraniem: wiersze 1–7 (zgoda, język, model na urządzeniu, dostępność)")
    func prepareRows() {
      func step(_ authorization: SpeechAuthorization, _ recognizer: SpeechRecognizerFacts?, locale: String = "pl-PL")
        -> SystemPrepareStep {
        SystemDictationPolicy.prepare(authorization: authorization, locale: locale, recognizer: recognizer)
      }
      let local = facts(onDevice: true)
      // 1. zgoda nieustalona → pytanie
      #expect(step(.notDetermined, local) == .askAuthorization)
      // 2. odmowa
      #expect(step(.denied, local) == .refuse(.speechDenied))
      // 3. ograniczenie
      #expect(step(.restricted, local) == .refuse(.speechRestricted))
      // 4. brak recognizera albo zastępstwo innym językiem (klawiatura)
      #expect(step(.authorized, nil) == .refuse(.localeUnsupported))
      #expect(step(.authorized, facts("en-US", onDevice: true)) == .refuse(.localeUnsupported))
      // ten sam język w innym zapisie to nie zastępstwo
      #expect(step(.authorized, facts("pl_PL", onDevice: true)) == route(.onDevice))
      // 5. model na urządzeniu → na urządzeniu, także gdy usługa sieciowa jest niedostępna
      #expect(step(.authorized, local) == route(.onDevice))
      #expect(step(.authorized, facts(available: false, onDevice: true)) == route(.onDevice))
      // 6. bez modelu, usługa dostępna → serwery Apple
      #expect(step(.authorized, facts("en-US", onDevice: false), locale: "en-US") == route(.appleServers, "en-US"))
      // 7. bez modelu, usługa niedostępna → serwery Apple nieosiągalne
      #expect(step(.authorized, facts(available: false, onDevice: false)) == .refuse(.appleServerUnreachable))
    }

    @Test("granica prywatności: serwery Apple tylko bez modelu na urządzeniu; droga po zgodzie, w żądanym języku")
    func privacyBoundary() throws {
      let all: [SpeechAuthorization] = [.notDetermined, .denied, .restricted, .authorized]
      var recognizers: [SpeechRecognizerFacts?] = [nil]
      for locale in ["pl-PL", "en-US"] {
        for available in [false, true] {
          for onDevice in [false, true] { recognizers.append(facts(locale, available: available, onDevice: onDevice)) }
        }
      }
      var routes = 0
      for authorization in all {
        for recognizer in recognizers {
          guard case let .route(found) = SystemDictationPolicy.prepare(
            authorization: authorization, locale: "pl-PL", recognizer: recognizer)
          else { continue }
          routes += 1
          let recognizer = try #require(recognizer)
          #expect(authorization == .authorized)
          #expect(recognizer.locale == "pl-PL" && found.locale == "pl-PL")
          #expect((found.path == .onDevice) == recognizer.supportsOnDeviceRecognition, "\(recognizer)")
          if found.path == .appleServers { #expect(recognizer.isAvailable && !recognizer.supportsOnDeviceRecognition) }
          let request = SystemDictationPolicy.request(for: found.path)
          #expect(request.requiresOnDeviceRecognition == recognizer.supportsOnDeviceRecognition)
        }
      }
      #expect(routes == 3, "na urządzeniu (dostępny i nie) oraz serwery Apple")
    }

    @Test("żądanie: na urządzeniu wymusza `requiresOnDeviceRecognition`, serwery Apple — nie")
    func requestFlag() {
      #expect(SystemDictationPolicy.request(for: .onDevice) == SpeechRequest(requiresOnDeviceRecognition: true))
      #expect(SystemDictationPolicy.request(for: .appleServers) == SpeechRequest(requiresOnDeviceRecognition: false))
    }

    @Test("w trakcie zadania: wiersze 9–13 (sieć, zasoby, brak mowy, zgoda, dyktowanie wyłączone)")
    func taskErrorRows() {
      func outcome(_ domain: String, _ code: Int, _ path: SystemDictationPath = .onDevice, available: Bool = true,
                   finishing: Bool = false) -> SystemTaskErrorOutcome {
        SystemDictationPolicy.taskError(SpeechTaskError(domain: domain, code: code), path: path, isAvailable: available,
                                        finishing: finishing)
      }
      // 9. droga serwerowa bez dostępnej usługi → serwery nieosiągalne; inny błąd → silnik
      #expect(outcome(assistant, 203, .appleServers, available: false) == .fail(.appleServerUnreachable))
      #expect(outcome(assistant, 1101, .appleServers, available: false) == .fail(.appleServerUnreachable))
      #expect(outcome(assistant, 203, .appleServers, available: true) == .fail(.engineFailed))
      #expect(outcome(assistant, 203, .onDevice, available: false) == .fail(.engineFailed), "na urządzeniu bez sieci")
      #expect(outcome(lsr, 300) == .fail(.engineFailed))
      // 10. zasoby (kod 102) — jedyne źródło `assetsMissing`
      #expect(outcome(lsr, 102) == .fail(.assetsMissing))
      #expect(outcome(lsr, 102, .appleServers, available: false) == .fail(.assetsMissing))
      // 11. brak mowy po stopie → zwykły koniec; w trakcie nagrania → kolejne zadanie
      #expect(outcome(assistant, 1110, finishing: true) == .finished)
      #expect(outcome(assistant, 1110) == .nextTask)
      // 13. zgoda cofnięta w trakcie
      #expect(outcome(assistant, 1700) == .fail(.speechDenied))
      #expect(outcome(assistant, 1700, finishing: true) == .fail(.speechDenied))
      // kod 201: Siri albo dyktowanie wyłączone w ustawieniach systemu
      #expect(outcome(lsr, 201) == .fail(.dictationDisabled))
      // kod liczy się razem z domeną
      #expect(outcome(lsr, 1110) == .fail(.engineFailed))
      #expect(outcome(assistant, 102) == .fail(.engineFailed))
      #expect(outcome("NSURLErrorDomain", -1009, .onDevice) == .fail(.engineFailed))
    }

    @Test("język rozpoznawania z języka apki: pl → pl-PL, en → en-US")
    func localeFromLanguage() {
      #expect(SystemDictationPolicy.locale(for: .pl) == "pl-PL")
      #expect(SystemDictationPolicy.locale(for: .en) == "en-US")
    }
  }

  @Suite("strumień: przed mikrofonem (`prepare`)")
  @MainActor
  struct Prepare {
    @Test("zgoda nieustalona → jedno pytanie, potem dalej; odmowa, ograniczenie i brak decyzji kończą bez drogi")
    func authorization() async {
      let granted = SystemHarness()
      granted.speech.status = .notDetermined
      #expect(await granted.stream.prepare() == nil)
      #expect(granted.speech.asked == 1)
      #expect(granted.stream.route == SystemDictationRoute(path: .onDevice, locale: "pl-PL"))

      let refused = SystemHarness()
      refused.speech.status = .notDetermined
      refused.speech.answer = .denied
      #expect(await refused.stream.prepare() == .speechDenied)
      #expect(refused.speech.asked == 1 && refused.stream.route == nil)

      let undecided = SystemHarness()
      undecided.speech.status = .notDetermined
      undecided.speech.answer = .notDetermined
      #expect(await undecided.stream.prepare() == .speechDenied, "bez decyzji dźwięk nie wychodzi")
      #expect(undecided.speech.asked == 1)

      let denied = SystemHarness()
      denied.speech.status = .denied
      #expect(await denied.stream.prepare() == .speechDenied)
      #expect(denied.speech.asked == 0 && denied.speech.locales.isEmpty, "bez zgody nie ma recognizera")

      let restricted = SystemHarness()
      restricted.speech.status = .restricted
      #expect(await restricted.stream.prepare() == .speechRestricted)
      #expect(restricted.speech.asked == 0 && restricted.stream.route == nil)

      for h in [granted, refused, undecided, denied, restricted] {
        #expect(h.tasks.isEmpty && h.done.isEmpty && h.states.isEmpty, "`prepare()` niczego nie startuje")
      }
    }

    @Test("język bez rozpoznawania, zastępstwo innym językiem, serwery Apple nieosiągalne: bez drogi i zadania")
    func refusals() async {
      let missing = SystemHarness()
      missing.speech.facts = nil
      #expect(await missing.stream.prepare() == .localeUnsupported)

      let fallback = SystemHarness()
      fallback.speech.facts = facts("en-US", onDevice: true)
      #expect(await fallback.stream.prepare() == .localeUnsupported)

      let offline = SystemHarness()
      offline.speech.facts = facts(available: false, onDevice: false)
      #expect(await offline.stream.prepare() == .appleServerUnreachable)

      for h in [missing, fallback, offline] {
        #expect(h.stream.route == nil && h.tasks.isEmpty)
      }
    }

    @Test("język z apki: recognizer dla pl-PL albo en-US")
    func localeOfApp() async {
      let pl = SystemHarness(language: .pl)
      await pl.begin()
      #expect(pl.speech.locales == ["pl-PL"])

      let en = SystemHarness(language: .en)
      en.speech.facts = facts("en-US", onDevice: true)
      await en.begin()
      #expect(en.speech.locales == ["en-US"] && en.stream.route?.locale == "en-US")
    }

    @Test("droga po `prepare()`: API, na urządzeniu albo serwery Apple, locale; bez tekstu")
    func reportedRoute() async throws {
      let local = SystemHarness()
      #expect(local.stream.route == nil, "przed `prepare()` drogi nie ma")
      await local.begin()
      let onDevice = try #require(local.stream.route)
      #expect(onDevice.api == "SFSpeechRecognizer" && onDevice.path == .onDevice && onDevice.locale == "pl-PL")
      #expect(onDevice.summary == "api=SFSpeechRecognizer path=on-device locale=pl-PL")

      let server = SystemHarness(language: .en)
      server.speech.facts = facts("en-US", onDevice: false)
      await server.begin()
      #expect(server.stream.route?.summary == "api=SFSpeechRecognizer path=apple-servers locale=en-US")

      local.task.partial("Tajne zdanie")
      #expect(local.stream.route == onDevice, "wynik nie zmienia drogi")
      #expect(!onDevice.summary.contains("Tajne"))
    }
  }

  @Suite("strumień: zadanie rozpoznawania")
  @MainActor
  struct Recognition {
    @Test("na urządzeniu żądanie wymusza model lokalny; serwery Apple tylko bez modelu; nowe zadanie tą drogą")
    func requestPerPath() async {
      let local = SystemHarness()
      #expect(await local.stream.prepare() == nil)
      #expect(local.tasks.isEmpty, "zadanie dopiero w `start()`")
      local.stream.start()
      #expect(local.task.request.requiresOnDeviceRecognition)
      local.task.final("Pierwsze.")
      #expect(local.tasks.count == 2 && local.task.request.requiresOnDeviceRecognition)

      let server = SystemHarness()
      server.speech.facts = facts(onDevice: false)
      await server.begin()
      #expect(!server.task.request.requiresOnDeviceRecognition)
      server.task.final("Pierwsze.")
      #expect(server.tasks.count == 2 && !server.task.request.requiresOnDeviceRecognition)
    }

    @Test("błąd na drodze serwerowej przy niedostępnej usłudze → serwery Apple nieosiągalne; tekst zostaje")
    func serverUnreachable() async {
      let h = SystemHarness()
      h.speech.facts = facts(onDevice: false)
      await h.begin()
      h.task.partial("Dyktuję")
      h.recognizer.facts.isAvailable = false
      h.task.fail(assistant, 203)
      #expect(h.done == [.failed(.rejected(.appleServerUnreachable))])
      #expect(h.stream.buffers == VoiceBuffers(committed: "Dyktuję"))

      let online = SystemHarness()
      online.speech.facts = facts(onDevice: false)
      await online.begin()
      online.task.fail(assistant, 203)
      #expect(online.done == [.failed(.rejected(.engineFailed))])
    }

    @Test("limit zadania: wynik końcowy przed stopem → nowe zadanie, tekst zatwierdzony zostaje")
    func limitStartsNextTask() async {
      let h = SystemHarness()
      await h.begin()
      #expect(h.states == [.streaming])
      h.stream.sendAudio(Data(count: 3200))
      h.task.partial("Ala ma")
      h.task.partial("Ala ma kota")
      #expect(h.buffers.last == VoiceBuffers(committed: "", provisional: "Ala ma kota"), "hipoteza zastępowana")
      let first = h.task
      first.final("Ala ma kota.")
      #expect(h.tasks.count == 2 && first.cancelled && h.recognizer.overlaps == 0, "stare przed nowym (kod 1100)")
      #expect(h.buffers.last == VoiceBuffers(committed: "Ala ma kota."))
      h.stream.sendAudio(Data(count: 3200))
      #expect(first.audio.count == 1 && h.task.audio.count == 1, "dźwięk po limicie idzie do nowego zadania")
      h.task.partial("I psa")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota.", provisional: " I psa"))
      first.partial("Ala ma kota i")
      first.fail(lsr, 301)
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota.", provisional: " I psa"), "stare milczy")
      h.task.final("I psa.")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota. I psa."))
      #expect(h.done.isEmpty && h.states == [.streaming], "nagranie trwa dalej")
    }

    // Regresja: po dłuższej pauzie i dalszym dyktowaniu pole traciło tekst
    // sprzed pauzy. Recognizer z modelem na urządzeniu kończy po pauzie fragment wynikiem bez `isFinal`, a kolejne
    // hipotezy tego samego zadania liczy od zera (Apple Developer Forums, wątek 764809).
    @Test("pauza w zadaniu: koniec fragmentu zatwierdza tekst, dalsze hipotezy się doklejają, zadanie trwa")
    func pauseKeepsEarlierFragment() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Ala ma")
      h.task.partial("Ala ma kota")
      h.task.segmentEnd("Ala ma kota.")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota."))
      #expect(h.tasks.count == 1 && !h.task.cancelled, "to samo zadanie trwa, bez nowego")
      h.task.partial("I")
      h.task.partial("I psa")
      #expect(
        h.stream.buffers == VoiceBuffers(committed: "Ala ma kota.", provisional: " I psa"), "tekst sprzed pauzy zostaje")
      h.task.segmentEnd("I psa.")
      h.task.partial("Koniec")
      h.stream.finish()
      h.task.final("Koniec.")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota. I psa. Koniec."))
      #expect(h.done == [.finished] && h.stream.segmentEnds == 2 && h.stream.tasksOpened == 1)
    }

    @Test("stop w ciszy po pauzie: koniec fragmentu i wynik końcowy, które go powtarzają bez nowej hipotezy, nie dublują")
    func repeatOfClosedFragment() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Ala ma kota")
      h.task.segmentEnd("Ala ma kota.")
      h.task.segmentEnd("Ala ma kota.")
      h.task.partial(" ")
      h.task.segmentEnd(" ")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota."), "powtórzony i pusty koniec, pusta hipoteza")
      h.stream.finish()
      h.task.final("ala ma kota")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota.") && h.done == [.finished])
      #expect(h.stream.segmentEnds == 1 && h.stream.repeats == 2, "licznik liczy fragmenty, nie wyniki")
    }

    @Test("ten sam tekst po pauzie przychodzi najpierw jako hipoteza: powiedziany dwa razy zostaje dwa razy")
    func sameWordsAgainAfterNewSpeech() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Tak")
      h.task.segmentEnd("Tak.")
      h.task.partial("Tak")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Tak.", provisional: " Tak"))
      h.task.segmentEnd("Tak.")
      h.task.partial("Tak")
      h.stream.finish()
      h.task.final("Tak.")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Tak. Tak. Tak."))
      #expect(h.stream.segmentEnds == 2 && h.stream.repeats == 0)
    }

    @Test("pusty koniec fragmentu albo pusty wynik końcowy: hipoteza, którą człowiek widział, zostaje tekstem")
    func blankResultKeepsHypothesis() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Ala ma kota")
      h.task.segmentEnd("")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota"))
      h.task.partial("I psa")
      h.stream.finish()
      h.task.final(" ")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota I psa") && h.done == [.finished])
    }

    @Test("przebazowanie po końcu fragmentu: zamknięty fragment nie blokuje tego samego tekstu w nowym zadaniu")
    func rebaseAfterFragment() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Tak")
      h.task.segmentEnd("Tak.")
      h.stream.resetBuffers()
      #expect(h.tasks.count == 2 && h.stream.buffers == VoiceBuffers.empty)
      h.task.partial("Tak.")
      #expect(h.stream.buffers == VoiceBuffers(committed: "", provisional: " Tak."))
      #expect(h.stream.tasksOpened == 2 && h.stream.segmentEnds == 1)
    }

    @Test("stop: koniec dźwięku, wynik końcowy w limicie finalizacji, jedno `done(.finished)`")
    func finishWithFinal() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Dyktuję z")
      h.stream.finish()
      #expect(h.task.ended && h.done.isEmpty)
      h.task.partial("Dyktuję z iPada")
      h.task.final("Dyktuję z iPada.")
      #expect(h.done == [.finished] && h.tasks.count == 1, "po stopie bez kolejnego zadania")
      #expect(h.stream.buffers == VoiceBuffers(committed: "Dyktuję z iPada."))
      h.clock.advance(5)
      h.task.final("Inny tekst.")
      #expect(h.done == [.finished] && h.stream.buffers == VoiceBuffers(committed: "Dyktuję z iPada."))
      #expect(h.states == [.streaming, .idle])
    }

    @Test("stop bez wyniku końcowego: koniec po `finalizeTimeout`, hipoteza zostaje")
    func finishTimesOut() async {
      let h = SystemHarness()
      await h.begin()
      h.task.partial("Dyktuję")
      h.stream.finish()
      h.clock.advance(VoiceTiming.production.finalizeTimeout - 0.1)
      #expect(h.done.isEmpty)
      h.clock.advance(0.1)
      #expect(h.done == [.finished] && h.task.cancelled)
      #expect(h.stream.buffers.text == "Dyktuję")
    }

    @Test("anulowanie: bufory na zero, zadanie anulowane, jedno `done`; spóźniony wynik i 301 bez skutku")
    func abort() async {
      let h = SystemHarness()
      await h.begin()
      h.task.final("Ala ma kota.")
      h.task.partial("I psa")
      let task = h.task
      h.stream.abort()
      #expect(h.buffers.last == .empty && h.stream.buffers == .empty)
      #expect(h.done == [.finished] && task.cancelled)
      let events = h.buffers.count
      task.partial("I psa i")
      task.final("I psa i kota.")
      task.fail(lsr, 301)
      #expect(h.buffers.count == events && h.stream.buffers == .empty && h.done == [.finished])
      h.stream.finish()
      h.stream.abort()
      #expect(h.done == [.finished], "jedno zakończenie")
    }

    @Test("przebazowanie: bieżące zadanie anulowane, nowe tą samą drogą, kolejny fragment od spacji")
    func resetBuffers() async {
      let h = SystemHarness()
      await h.begin()
      h.task.final("Ala ma kota.")
      let old = h.task
      old.partial("I psa")
      h.stream.resetBuffers()
      #expect(h.stream.buffers == .empty)
      #expect(old.cancelled && h.tasks.count == 3 && h.recognizer.overlaps == 0, "stare przed nowym (kod 1100)")
      #expect(h.task.request.requiresOnDeviceRecognition && h.done.isEmpty && h.states == [.streaming])
      h.stream.sendAudio(Data(count: 3200))
      #expect(old.audio.isEmpty && h.task.audio.count == 1, "dźwięk po edycji idzie do nowego zadania")
      h.task.partial("Dalej")
      // Spacja na początku: pole po edycji nie dostaje separatora.
      #expect(h.stream.buffers == VoiceBuffers(committed: "", provisional: " Dalej"))
      h.task.final("Dalej.")
      #expect(h.stream.buffers == VoiceBuffers(committed: " Dalej."))
      h.task.partial("I tyle")
      #expect(h.stream.buffers.text == " Dalej. I tyle")

      let server = SystemHarness()
      server.speech.facts = facts(onDevice: false)
      await server.begin()
      server.stream.resetBuffers()
      #expect(server.tasks.count == 2 && !server.task.request.requiresOnDeviceRecognition, "ta sama droga")

      // Przebazowanie przed pierwszym słowem: tekst zaczyna się od spacji, nic nie przepada.
      let early = SystemHarness()
      await early.begin()
      early.stream.resetBuffers()
      early.task.partial("Kot")
      #expect(early.stream.buffers.text == " Kot")
    }

    @Test("przebazowanie: stare zadanie scala albo dzieli słowa sprzed edycji; pole nie gubi ani nie dubluje")
    func resetBuffersWordBoundaries() async {
      // Hipoteza w polu przed edycją, spóźniony wynik starego zadania, czy końcowy.
      let cases: [(String, String, Bool)] = [
        ("na prawdę", "naprawdę działa", false), ("na prawdę", "naprawdę działa.", true),
        ("naprawdę", "na prawdę działa", false), ("naprawdę", "na prawdę działa.", true),
      ]
      for (before, late, isFinal) in cases {
        let h = SystemHarness()
        await h.begin()
        let old = h.task
        old.partial(before)
        h.stream.resetBuffers()
        #expect(old.cancelled && h.tasks.count == 2 && h.recognizer.overlaps == 0, "\(late)")
        let events = h.buffers.count
        if isFinal { old.final(late) } else { old.partial(late) }
        #expect(h.stream.buffers == .empty && h.buffers.count == events, "\(late): stare zadanie milczy")
        #expect(h.tasks.count == 2 && h.done.isEmpty, "\(late)")
        h.task.partial("działa")
        #expect(h.stream.buffers == VoiceBuffers(committed: "", provisional: " działa"), "\(late)")
        h.task.final("działa.")
        #expect(h.stream.buffers == VoiceBuffers(committed: " działa."), "\(late)")
      }
    }

    @Test("przebazowanie: spóźnione wyniki i błędy starego zadania (301, 1110, 203) bez skutku dla nowego")
    func resetBuffersLateEvents() async {
      for (domain, code) in [(lsr, 301), (assistant, 1110), (assistant, 203)] {
        let h = SystemHarness()
        await h.begin()
        let old = h.task
        old.partial("Ala ma")
        h.stream.resetBuffers()
        let fresh = h.task
        fresh.partial("kota")
        let events = h.buffers.count
        old.partial("Ala ma kota")
        old.final("Ala ma kota.")
        old.fail(domain, code)
        #expect(h.buffers.count == events, "\(domain) \(code)")
        #expect(h.stream.buffers == VoiceBuffers(committed: "", provisional: " kota"), "\(domain) \(code)")
        #expect(h.done.isEmpty && h.states == [.streaming], "\(domain) \(code): nagranie trwa")
        #expect(h.tasks.count == 2 && !fresh.cancelled, "\(domain) \(code): nowe zadanie żyje")
      }
    }

    @Test("przebazowanie po stopie: dźwięk już nie przyjdzie, więc koniec bez wyniku starego zadania")
    func resetBuffersWhileFinishing() async {
      let h = SystemHarness()
      await h.begin()
      h.task.final("Ala ma kota.")
      let old = h.task
      old.partial("I psa")
      h.stream.finish()
      h.stream.resetBuffers()
      #expect(h.done == [.finished] && old.cancelled && h.tasks.count == 2)
      #expect(h.stream.buffers == .empty)
      old.final("I psa.")
      old.fail(lsr, 301)
      h.clock.advance(5)
      #expect(h.done == [.finished] && h.stream.buffers == .empty)
    }

    @Test("błąd silnika w trakcie: `done(.failed(.rejected(.engineFailed)))`, tekst zatwierdzony zostaje")
    func engineFailure() async {
      let h = SystemHarness()
      await h.begin()
      h.task.final("Ala ma kota.")
      h.task.partial("I psa")
      h.task.fail(assistant, 203)
      #expect(h.done == [.failed(.rejected(.engineFailed))])
      #expect(h.stream.buffers == VoiceBuffers(committed: "Ala ma kota. I psa"), "hipoteza staje się tekstem")
      #expect(h.states == [.streaming, .failed] && h.task.cancelled)
      h.task.fail(assistant, 203)
      #expect(h.done.count == 1)
    }

    @Test("kody błędów: 1110 po stopie to koniec; 102, 1700 i 201 kończą nagranie swoim błędem")
    func errorCodes() async {
      let quiet = SystemHarness()
      await quiet.begin()
      quiet.stream.finish()
      quiet.task.fail(assistant, 1110)
      #expect(quiet.done == [.finished] && quiet.stream.buffers == .empty)

      let cases: [(String, Int, DictationFailure)] = [
        (lsr, 102, .assetsMissing), (assistant, 1700, .speechDenied), (lsr, 201, .dictationDisabled),
      ]
      for (domain, code, failure) in cases {
        for finishing in [false, true] {
          let h = SystemHarness()
          await h.begin()
          h.task.partial("Tekst")
          if finishing { h.stream.finish() }
          h.task.fail(domain, code)
          #expect(h.done == [.failed(.rejected(failure))], "\(domain) \(code)")
          #expect(h.stream.buffers == VoiceBuffers(committed: "Tekst"))
        }
      }
    }

    @Test("brak mowy (1110) w trakcie nagrania: system zamknął zadanie, nagranie trwa na nowym")
    func noSpeechMidRecording() async {
      let h = SystemHarness()
      await h.begin()
      h.task.final("Ala.")
      let quiet = h.task
      quiet.fail(assistant, 1110)
      #expect(h.done.isEmpty && h.tasks.count == 3 && quiet.cancelled)
      #expect(h.task.request.requiresOnDeviceRecognition && h.stream.buffers == VoiceBuffers(committed: "Ala."))
    }

    @Test("wiersz 12: kod 301 starego zadania pomijany; 301 bieżącego, którego nikt nie anulował, to błąd")
    func cancellation() async {
      let h = SystemHarness()
      await h.begin()
      let old = h.task
      old.final("Raz.")
      old.fail(lsr, 301)
      #expect(h.done.isEmpty)
      h.task.fail(lsr, 301)
      #expect(h.done == [.failed(.rejected(.engineFailed))])
    }
  }

  @Suite("strumień: granice")
  @MainActor
  struct Boundaries {
    @Test("typ strumienia nie przyjmuje pobrania klucza ani fabryki gniazda (sprawdzenie w kompilacji)")
    func noMintNoSocket() throws {
      // Jedyny inicjator: język, rozpoznawanie, zegar, rytm i zdarzenia. Inicjator z kluczem albo gniazdem nie
      // skompilowałby tej linii z tą sygnaturą.
      let make: @MainActor (CopyLanguage, any SpeechRecognition, any VoiceScheduler, VoiceTiming, SonioxStream.Handlers)
        -> SystemDictationStream = SystemDictationStream.init(language:speech:scheduler:timing:handlers:)
      _ = make
      let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appending(path: "Sources/RarogUI/Session/Voice/System")
      let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        .filter { $0.pathExtension == "swift" }
      #expect(files.count >= 3)
      for file in files {
        let code = try String(contentsOf: file, encoding: .utf8)
        for banned in ["VoiceMint", "VoiceSocket", "VoiceToken", "mintVoiceToken", "URLSession"] {
          #expect(!code.contains(banned), "\(file.lastPathComponent): \(banned)")
        }
      }
    }

    @Test("pod nagrywarką: zgoda i droga przed mikrofonem, dźwięk do zadania, stop kończy tekstem")
    func underRecorder() async {
      let h = SystemHarness()
      let mic = TapMicrophone()
      let log = EventLog()
      h.speech.status = .notDetermined
      h.speech.onAsk = { log.entries.append("speech") }
      mic.onStart = { log.entries.append("microphone") }
      let recorder = systemRecorder(h, mic)
      await recorder.start()?.value
      #expect(log.entries == ["speech", "microphone"] && recorder.view.phase == .recording)
      mic.frame()
      mic.frame()
      #expect(h.task.audio.count == 2 && h.task.audio.allSatisfy { $0.count == 3200 })
      h.task.partial("Dyktuję")
      #expect(recorder.view.buffers.text == "Dyktuję")
      recorder.stop()
      for _ in 0..<20 { await Task.yield() }
      #expect(h.task.ended)
      h.task.final("Dyktuję z iPada.")
      #expect(recorder.view == VoiceView(buffers: VoiceBuffers(committed: "Dyktuję z iPada.")))
      #expect(!mic.isOpen && !recorder.active)

      // Odmowa zgody na rozpoznawanie: mikrofon ani razu.
      let refused = SystemHarness()
      refused.speech.status = .denied
      let closed = TapMicrophone()
      let blocked = systemRecorder(refused, closed)
      await blocked.start()?.value
      #expect(closed.starts == 0 && !blocked.active && refused.tasks.isEmpty)
    }

    @Test("pod nagrywarką: edycja pola w nagraniu i w kończeniu; dźwięk do nowego zadania, jedno zakończenie")
    func rebaseUnderRecorder() async {
      let h = SystemHarness()
      let mic = TapMicrophone()
      let recorder = systemRecorder(h, mic)
      await recorder.start()?.value
      let old = h.task
      old.partial("na prawdę")
      recorder.rebase()
      #expect(recorder.view.buffers == .empty && old.cancelled && h.tasks.count == 2)
      old.partial("naprawdę działa")
      mic.frame()
      #expect(old.audio.isEmpty && h.task.audio.count == 1)
      h.task.partial("działa")
      #expect(recorder.view.buffers.text == " działa" && recorder.view.phase == .recording)

      recorder.stop()
      for _ in 0..<20 { await Task.yield() }
      #expect(h.task.ended && recorder.view.phase == .finalizing)
      let last = h.task
      recorder.rebase()
      #expect(!recorder.active && !mic.isOpen && last.cancelled && recorder.view == VoiceView())
      last.final("działa.")
      #expect(recorder.view == VoiceView() && h.tasks.count == 2)
    }

    @Test("pod nagrywarką: edycja pola przed startem strumienia (zgoda, mikrofon) → pierwszy fragment od spacji")
    func rebaseBeforeStreamStarts() async {
      for window in ["zgoda", "mikrofon"] {
        let h = SystemHarness()
        let mic = TapMicrophone()
        let recorder = systemRecorder(h, mic)
        if window == "zgoda" {
          h.speech.status = .notDetermined
          h.speech.onAsk = { recorder.rebase() }
        } else {
          mic.onStart = { recorder.rebase() }
        }
        await recorder.start()?.value
        #expect(recorder.view.phase == .recording, "\(window)")
        h.task.partial("dalej")
        // Pole po edycji nie ma separatora (`VoiceFieldText.edited`): bez spacji wyszłoby „Poprawkadalej”.
        #expect(recorder.view.buffers.text == " dalej", "\(window)")
      }

      // Start porzucony po edycji nie przenosi przebazowania na następne nagranie.
      let h = SystemHarness()
      let mic = TapMicrophone()
      let recorder = systemRecorder(h, mic)
      h.speech.status = .notDetermined
      h.speech.onAsk = {
        recorder.rebase()
        recorder.stop()
      }
      await recorder.start()?.value
      #expect(!recorder.active && mic.starts == 0)
      h.speech.onAsk = nil
      await recorder.start()?.value
      h.task.partial("dalej")
      #expect(recorder.view.buffers.text == "dalej")
    }

    /// Nagrywarka z trasą systemową: bez klucza i bez gniazda.
    private func systemRecorder(_ h: SystemHarness, _ mic: TapMicrophone) -> VoiceRecorder {
      VoiceRecorder(
        deps: .init(
          microphone: { mic },
          mint: { Issue.record("trasa systemowa bez klucza"); return .stop("") },
          connect: { _, _, _ in fatalError("trasa systemowa bez gniazda") },
          scheduler: h.clock, timing: .production,
          makeStream: { handlers in
            SystemDictationStream(
              language: .pl, speech: h.speech, scheduler: h.clock, timing: .production, handlers: handlers)
          }),
        handlers: .init(view: { _ in }))
    }
  }

  @Suite("odczyt `SFSpeechRecognizer` (produkcja, bez rozpoznawania)")
  @MainActor
  struct Apple {
    @Test("PCM s16le 16 kHz mono → bufor Int16 16 kHz mono, próbka w próbkę (format natywny żądania)")
    func pcmBuffer() throws {
      let samples: [Int16] = [0, 32767, -32768, 16384]
      let data = samples.map(\.littleEndian).withUnsafeBufferPointer { Data(buffer: $0) }
      let buffer = try #require(AppleSpeechRecognition.buffer(data))
      #expect(buffer.format.sampleRate == 16_000 && buffer.format.channelCount == 1)
      #expect(buffer.format.commonFormat == .pcmFormatInt16 && buffer.frameLength == 4)
      #expect(Array(UnsafeBufferPointer(start: buffer.int16ChannelData![0], count: 4)) == samples)
      #expect(AppleSpeechRecognition.buffer(Data()) == nil)
      #expect(AppleSpeechRecognition.buffer(Data(count: 3201))?.frameLength == 1600, "nieparzysty bajt odpada")
      let native = SFSpeechAudioBufferRecognitionRequest().nativeAudioFormat
      #expect(native.commonFormat == buffer.format.commonFormat && native.sampleRate == buffer.format.sampleRate
        && native.channelCount == buffer.format.channelCount, "format natywny żądania: \(native)")
    }

    @Test("żądanie `SFSpeechAudioBufferRecognitionRequest`: flaga drogi, wyniki częściowe, interpunkcja")
    func request() {
      let local = AppleSpeechRecognition.request(SystemDictationPolicy.request(for: .onDevice))
      #expect(local.requiresOnDeviceRecognition)
      let server = AppleSpeechRecognition.request(SystemDictationPolicy.request(for: .appleServers))
      #expect(!server.requiresOnDeviceRecognition)
      for request in [local, server] {
        #expect(request.shouldReportPartialResults && request.addsPunctuation && request.taskHint == .dictation)
      }
    }

    @Test("rodzaj wyniku: `isFinal` → końcowy; bez niego czas mowy z metadanych powyżej zera → koniec fragmentu")
    func resultKind() {
      #expect(AppleSpeechRecognition.kind(isFinal: true, speechDuration: nil) == .final)
      #expect(AppleSpeechRecognition.kind(isFinal: true, speechDuration: 2.5) == .final)
      #expect(AppleSpeechRecognition.kind(isFinal: false, speechDuration: 2.5) == .segmentEnd)
      #expect(AppleSpeechRecognition.kind(isFinal: false, speechDuration: 0) == .partial)
      #expect(AppleSpeechRecognition.kind(isFinal: false, speechDuration: nil) == .partial)
    }

    @Test("stan zgody `SFSpeechRecognizerAuthorizationStatus` → `SpeechAuthorization`")
    func authorization() {
      #expect(AppleSpeechRecognition.authorization(.notDetermined) == .notDetermined)
      #expect(AppleSpeechRecognition.authorization(.denied) == .denied)
      #expect(AppleSpeechRecognition.authorization(.restricted) == .restricted)
      #expect(AppleSpeechRecognition.authorization(.authorized) == .authorized)
    }
  }
}
