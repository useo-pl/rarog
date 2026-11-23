import Foundation
import RarogContract

// Strumień dyktowania systemowego (trasa `system`): rozpoznawanie mowy Apple pod tą samą nagrywarką co Soniox
// (`DictationStream`). Właściciel: dyktowanie.
//
// Pięć rzeczy jest tu całą treścią decyzji:
// 1. drogę wybiera `SystemDictationPolicy` w `prepare()`, przed mikrofonem: na urządzeniu wszędzie, gdzie jest
//    model mowy, serwery Apple tylko bez niego; strumień nie ma klucza ani gniazda, więc nic nie idzie do Soniox
//    ani do serwera Rarog;
// 2. zadanie `SFSpeechRecognizer` trwa najwyżej około minuty: wynik końcowy przed stopem zamyka zadanie, a nagranie
//    trwa dalej na nowym zadaniu tą samą drogą, z tekstem zatwierdzonym nietkniętym;
// 3. edycja pola w trakcie nagrania zamyka bieżące zadanie, a dalszy dźwięk idzie do nowego (`resetBuffers()`);
// 4. jedno `done` na nagranie; zdarzenia zadań, które strumień sam zamknął, przepadają;
// 5. koniec fragmentu po pauzie (`SpeechResultKind.segmentEnd`) zatwierdza tekst fragmentu, a zadanie trwa: dalsze
//    wyniki niosą tylko nowy fragment i doklejają się po spacji.

@MainActor
final class SystemDictationStream: DictationStream {
  private let locale: String
  private let speech: any SpeechRecognition
  private let scheduler: any VoiceScheduler
  private let timing: VoiceTiming
  private let handlers: SonioxStream.Handlers

  /// Droga po udanym `prepare()` (gospodarz pisze ją do śladu); `nil` przed nim i po odmowie.
  private(set) var route: SystemDictationRoute?
  private(set) var buffers = VoiceBuffers.empty
  private var state = SonioxStream.State.idle
  private var text = SystemDictationText()
  private var recognizer: (any SpeechRecognizer)?
  private var task: (any SpeechTask)?
  /// Numer zadania: po nim zdarzenia zadania zamkniętego przez strumień (limit, edycja pola, anulowanie, koniec)
  /// rozpoznają, że są nieaktualne.
  private var generation = 0
  private var finalizeTimer: VoiceTimer?
  /// Od `finish()`: wynik końcowy kończy nagranie, zamiast otwierać kolejne zadanie.
  private var finishing = false
  /// Liczby do linii śladu końca nagrania: fragmenty zatwierdzone po pauzie, wyniki zamykające pominięte jako
  /// powtórka zamkniętego fragmentu i zadania otwarte w tym nagraniu.
  private(set) var segmentEnds = 0
  private(set) var repeats = 0
  private(set) var tasksOpened = 0
  private var stopped = false

  init(
    language: CopyLanguage, speech: any SpeechRecognition, scheduler: any VoiceScheduler, timing: VoiceTiming,
    handlers: SonioxStream.Handlers
  ) {
    locale = SystemDictationPolicy.locale(for: language)
    self.speech = speech
    self.scheduler = scheduler
    self.timing = timing
    self.handlers = handlers
  }

  /// Zgoda (przy nieustalonej pytanie systemowe), język i droga. Niczego nie startuje.
  func prepare() async -> DictationFailure? {
    var step = decide(speech.authorization())
    if step == .askAuthorization { step = decide(await speech.requestAuthorization()) }
    switch step {
    case .askAuthorization:
      // Pytanie wróciło bez decyzji: bez zgody dźwięk nie wychodzi.
      return .speechDenied
    case let .refuse(failure):
      recognizer = nil
      return failure
    case let .route(route):
      self.route = route
      return nil
    }
  }

  /// Wołane raz, po udanym `prepare()` i otwarciu mikrofonu.
  func start() {
    guard let route, recognizer != nil else {
      settle(.failed(.rejected(.engineFailed)))
      return
    }
    openTask(route.path)
    setState(.streaming)
  }

  func sendAudio(_ pcm: Data) {
    guard !stopped else { return }
    task?.append(pcm)
  }

  /// Stop z zatwierdzeniem: koniec dźwięku i wynik końcowy najwyżej `finalizeTimeout`.
  func finish() {
    guard !stopped else { return }
    finishing = true
    guard let task else {
      settle(.finished)
      return
    }
    task.endAudio()
    finalizeTimer = scheduler.schedule(after: timing.finalizeTimeout) { [weak self] in
      self?.finalizeTimer = nil
      self?.settle(.finished)
    }
  }

  /// Anulowanie: zadanie w dół, oba bufory na zero.
  func abort() {
    guard !stopped else { return }
    text = SystemDictationText()
    buffers = .empty
    handlers.buffers(buffers)
    settle(.finished)
  }

  /// Człowiek pisał w polu: podyktowany tekst jest już jego, kolejne wyniki liczą się od tego miejsca.
  ///
  /// Granicą jest zadanie, nie liczba słów: wynik zadania niesie cały jego tekst, a kolejne hipotezy scalają
  /// i dzielą słowa sprzed edycji („na prawdę” → „naprawdę”), więc żadna liczba słów nie oddziela tego, co pole już
  /// ma, od reszty. Bieżące zadanie odpada (anulowane, jego spóźnione wyniki i błędy przepadają po numerze), dalszy
  /// dźwięk rozpoznaje nowe zadanie tą samą drogą.
  func resetBuffers() {
    guard !stopped else { return }
    text.rebase()
    buffers = text.buffers
    guard task != nil, let route else { return }
    if finishing {
      // Po stopie dźwięk już nie przyjdzie: nowe zadanie nie miałoby czego rozpoznać.
      settle(.finished)
    } else {
      openTask(route.path)
    }
  }

  // MARK: - Zadania

  private func decide(_ authorization: SpeechAuthorization) -> SystemPrepareStep {
    // Recognizer dopiero po zgodzie: przy odmowie apka nie pyta systemu o język.
    if authorization == .authorized, recognizer == nil { recognizer = speech.recognizer(locale: locale) }
    return SystemDictationPolicy.prepare(authorization: authorization, locale: locale, recognizer: recognizer?.facts)
  }

  /// Nowe zadanie tą samą drogą; poprzednie zamknięte przed startem następnego (dwa naraz to kod 1100).
  private func openTask(_ path: SystemDictationPath) {
    guard let recognizer else { return }
    tasksOpened += 1
    generation += 1
    let generation = generation
    task?.cancel()
    let events = SpeechTaskEvents(
      result: { [weak self] text, kind in
        guard let self, self.current(generation) else { return }
        self.result(text, kind: kind)
      },
      failure: { [weak self] error in
        guard let self, self.current(generation) else { return }
        self.failed(error)
      })
    task = recognizer.recognize(SystemDictationPolicy.request(for: path), events: events)
  }

  private func current(_ generation: Int) -> Bool {
    self.generation == generation && !stopped
  }

  private func result(_ value: String, kind: SpeechResultKind) {
    switch kind {
    case .final:
      if text.finishTask(value) == .repeated { repeats += 1 }
      emit()
      if finishing {
        settle(.finished)
      } else if let route {
        // Limit długości zadania albo koniec zadania przez system: nagranie trwa na nowym.
        openTask(route.path)
      }
    case .segmentEnd:
      switch text.finishSegment(value) {
      case .committed: segmentEnds += 1
      case .repeated: repeats += 1
      case .empty: break
      }
      emit()
    case .partial:
      text.partial(value)
      emit()
    }
  }

  private func failed(_ error: SpeechTaskError) {
    guard let route else { return }
    let outcome = SystemDictationPolicy.taskError(
      error, path: route.path, isAvailable: recognizer?.facts.isAvailable ?? false, finishing: finishing)
    switch outcome {
    case .finished:
      settle(.finished)
    case .nextTask:
      text.finishTask(nil)
      emit()
      openTask(route.path)
    case let .fail(failure):
      // Hipoteza, którą człowiek już przeczytał w polu, zostaje tekstem.
      text.finishTask(nil)
      emit()
      settle(.failed(.rejected(failure)))
    }
  }

  private func emit() {
    let next = text.buffers
    guard next != buffers else { return }
    buffers = next
    handlers.buffers(next)
  }

  private func setState(_ next: SonioxStream.State) {
    guard state != next else { return }
    state = next
    handlers.state(next)
  }

  /// Jedno wyjście dla wszystkich zakończeń.
  private func settle(_ end: SonioxStream.End) {
    guard !stopped else { return }
    stopped = true
    finalizeTimer?.cancel()
    finalizeTimer = nil
    generation += 1
    task?.cancel()
    task = nil
    setState(end == .finished ? .idle : .failed)
    handlers.done(end)
  }
}

/// Tekst rozpoznawania Apple w buforach nagrywarki. Czyste, testowane na macOS.
///
/// Wynik zadania niesie CAŁY tekst bieżącego fragmentu i potrafi poprawić wcześniejsze słowa, więc fragment jest
/// hipotezą (`provisional`), a tekstem zatwierdzonym (`committed`) staje się dopiero na końcu fragmentu (pauza)
/// albo zadania. Kolejny fragment i kolejne zadanie (po limicie albo po przebazowaniu) doklejają się po spacji.
/// Przebazowanie zeruje oba bufory; strumień zamyka wtedy bieżące zadanie, więc nic z niego tu nie wraca.
struct SystemDictationText: Equatable {
  /// Fragmenty i wyniki końcowe zadań od ostatniego przebazowania.
  private(set) var committed = ""
  /// Ostatni tekst bieżącego fragmentu, w całości.
  private var task = ""
  /// Przed bieżącym tekstem pole ma już podyktowany albo wpisany tekst: kolejny fragment zaczyna się od spacji
  /// (pole po edycji nie dostaje separatora, `VoiceFieldText.edited`).
  private var continues = false
  /// Fragment zamknięty po pauzie, dopóki zadanie nie przyniosło nowej hipotezy. Wynik zamykający bez nowej
  /// hipotezy (wynik końcowy po stopie w ciszy, powtórzony koniec fragmentu) z tymi samymi słowami tylko go powtarza,
  /// więc nie dokleja go drugi raz. Założenie: nowa mowa przychodzi najpierw jako hipoteza, więc ten sam tekst
  /// powiedziany drugi raz zostaje. Kontrakt Apple tej kolejności nie obiecuje; ile wyników poszło jako powtórka,
  /// mówi linia śladu końca nagrania (`powtórki=`).
  private var closed: String?

  var buffers: VoiceBuffers { VoiceBuffers(committed: committed, provisional: piece(task)) }

  /// Hipoteza bieżącego fragmentu. Pusta na początku fragmentu nie niesie mowy i niczego nie zmienia.
  mutating func partial(_ value: String) {
    if task.isEmpty, Self.blank(value) { return }
    task = value
    closed = nil
  }

  /// Co zrobił wynik zamykający fragment albo zadanie.
  enum Closing: Equatable {
    /// Tekst doszedł do zatwierdzonego.
    case committed
    /// Powtórka fragmentu zamkniętego po pauzie: bez zmiany tekstu.
    case repeated
    /// Pusty wynik bez hipotezy: bez zmiany tekstu.
    case empty
  }

  /// Koniec fragmentu po pauzie: tekst fragmentu (albo ostatnia hipoteza, gdy wynik jest pusty) staje się tekstem,
  /// a zadanie liczy dalej od zera.
  @discardableResult
  mutating func finishSegment(_ value: String) -> Closing {
    let value = Self.blank(value) ? task : value
    guard !Self.blank(value) else { return .empty }
    let closing = finishTask(value)
    closed = value
    return closing
  }

  /// Koniec bieżącego zadania: wynik końcowy (albo ostatnia hipoteza, gdy wynik jest pusty albo `nil`) staje się
  /// tekstem.
  @discardableResult
  mutating func finishTask(_ value: String?) -> Closing {
    let value = value.flatMap { Self.blank($0) ? nil : $0 } ?? task
    let closing: Closing = repeatsClosed(value) ? .repeated : Self.blank(value) ? .empty : .committed
    if closing == .committed { committed += piece(value) }
    task = ""
    closed = nil
    return closing
  }

  /// Nowy punkt startu po edycji pola: bez tekstu, kolejny fragment od spacji.
  mutating func rebase() {
    committed = ""
    task = ""
    continues = true
    closed = nil
  }

  /// Wynik bez nowej hipotezy od końca fragmentu, z tymi samymi słowami co ten fragment (bez względu na wielkość
  /// liter, interpunkcję i odstępy).
  private func repeatsClosed(_ value: String) -> Bool {
    guard task.isEmpty, let closed else { return false }
    return Self.words(value) == Self.words(closed)
  }

  private static func words(_ value: String) -> [Substring] {
    value.lowercased().split { !$0.isLetter && !$0.isNumber }
  }

  private static func blank(_ value: String) -> Bool {
    value.allSatisfy(\.isWhitespace)
  }

  private func piece(_ value: String) -> String {
    let fresh = value.drop(while: \.isWhitespace)
    guard !fresh.isEmpty else { return "" }
    return (committed.isEmpty && !continues ? "" : " ") + fresh
  }
}
