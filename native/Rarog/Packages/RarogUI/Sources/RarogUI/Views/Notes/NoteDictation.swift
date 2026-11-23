#if os(iOS)
import Observation
import RarogContract
import RarogCore
import UIKit

// Dyktowanie do notatki projektu: drugi gospodarz nagrania obok pola wiadomości (`ComposerDictation`), na tych
// samych częściach — nagrywarka, sklejenie z polem, trasa z rdzenia (`RarogStore.dictationRoute`). Dwa gospodarze
// napisani wprost są czytelniejsze niż jeden uogólniony (reguła trzech). Zachowanie pola wiadomości: tap zaczyna
// (albo otwiera stronę „Dyktowanie” w stosie formularza, gdy trasa pyta — nagrywa dopiero następny tap), drugi kończy
// z zatwierdzeniem (anulowania nie ma). Apka nigdy sama nie przełącza dostawcy. Tekst trafia do MODELU
// dokumentu, nie tylko do pola: po zniknięciu edytora (zamknięcie formularza w trakcie nagrania) dokończenie nie
// ginie. Jeden nagrywający naraz (`DictationCenter`). Właściciel: notatki (apka natywna).

/// Pole notatki widziane przez dyktowanie: tekst modelu, składanie znaku w edytorze, gdy żyje.
@MainActor
final class NoteVoiceTarget: VoiceTextTarget {
  let doc: NoteDocument
  weak var editor: NoteTextView?
  /// Dyktowanie doszło do sufitu dokumentu: weszło tyle, ile się mieści.
  private(set) var full = false

  init(doc: NoteDocument, editor: NoteTextView?) {
    self.doc = doc
    self.editor = editor
  }

  var text: String { doc.text }
  var isComposing: Bool { editor?.markedTextRange != nil }

  /// Zapis dyktowania; ponad sufit wchodzi tyle pełnych znaków, ile się mieści, a gospodarz kończy nagranie.
  func writeDictation(_ value: String) {
    var fitted = value
    if NotesRules.units(value) > NotesRules.maxUnits {
      full = true
      fitted = Self.prefix(value, units: NotesRules.maxUnits)
    }
    doc.edit(fitted)
    editor?.adopt(fitted)
  }

  /// Najdłuższy początek z pełnych znaków (bez rozcinania emoji i liter złożonych) w `units` jednostkach UTF-16.
  static func prefix(_ value: String, units: Int) -> String {
    var used = 0
    var end = value.startIndex
    for index in value.indices {
      used += value[index].utf16.count
      guard used <= units else { break }
      end = value.index(after: index)
    }
    return String(value[..<end])
  }
}

@MainActor
@Observable
final class NoteDictation: DictationHost {
  /// Widok nagrywarki: faza, bufory, komunikat — wiersz stanu formularza i mikrofon czytają go wprost.
  private(set) var view = VoiceView()
  /// Serwer odmówił drogi Soniox przy pobraniu klucza: zdanie zamiast stanu nagrania.
  private(set) var disabled: String?
  /// Strona „Dyktowanie” stoi na stosie formularza: stuknięcie mikrofonu przy trasie, która pyta. Zamyka ją wybór,
  /// „Wstecz” i zamknięcie formularza.
  var choosing = false
  /// Nagranie skończyło się na suficie dokumentu.
  private(set) var limited = false

  @ObservationIgnored private weak var store: RarogStore?
  @ObservationIgnored private let services: VoiceServices
  @ObservationIgnored private var recorder: VoiceRecorder?
  @ObservationIgnored private var recording = 0
  @ObservationIgnored private var field: VoiceFieldBinding?
  @ObservationIgnored private var target: NoteVoiceTarget?
  @ObservationIgnored private var spoken: VoiceView.Phase?
  /// Praca w tle kończenia nagrania (przez magazyn, `RarogStore.beginBackgroundWork`).
  @ObservationIgnored private var backgroundWork: BackgroundWorkToken?
  @ObservationIgnored private var observer: (any NSObjectProtocol)?

  init(store: RarogStore?, services: VoiceServices = .current) {
    self.store = store
    self.services = services
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.enteredBackground() }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    recorder?.cancel()
    finishBackgroundWork()
  }

  /// Nagranie trwa — z obserwowanego widoku nagrywarki: mikrofon odświeża się także po zatrzymaniu samym (sufit,
  /// cisza, tło).
  var active: Bool { view.active }

  /// Wiersz stanu formularza w trakcie nagrania i po nim (komunikat do następnej zmiany pola); `nil` = stan zapisu.
  /// Odmowa zgody, którą naprawia się w Ustawieniach iOS, ma akcję „Ustawienia”.
  var statusLine: NoteStatusLine? {
    if limited { return NoteStatusLine(UICopy.noteDictationFull, tone: .error) }
    if let disabled { return NoteStatusLine(disabled, tone: .error) }
    let text = UICopy.voiceStatus(view)
    guard !text.isEmpty else { return nil }
    let settings = view.notice?.opensSettings == true
    return NoteStatusLine(text, tone: view.notice?.isError == true ? .error : .quiet, action: settings ? .settings : nil)
  }

  /// Mikrofon w pasku formularza i ⌥⌘M: przy polu, które przyjmuje tekst, i w trakcie nagrania (trzeba móc je
  /// skończyć). Stan serwera nie gra roli: brak dyktowania na serwerze zmienia trasę, nie chowa mikrofonu.
  static func offersMicrophone(editable: Bool, recording: Bool) -> Bool {
    editable || recording
  }

  /// Mikrofon i ⌥⌘M: zaczyna według trasy, gdy pole przyjmuje tekst; kończy zawsze. `newLine` = dopisek od nowej
  /// linii na końcu (wejście z mikrofonu w dymku), inaczej spacja jak w polu wiadomości. Trasa, która pyta, stawia
  /// stronę „Dyktowanie” i niczego nie nagrywa.
  func toggle(doc: NoteDocument, editor: NoteTextView?, newLine: Bool = false) {
    if let recorder, recorder.active {
      recorder.stop()
      return
    }
    guard doc.editable, doc.conflict == nil, let store else { return }
    switch store.dictationRoute {
    case .ask:
      choosing = true
    case .system:
      start(doc: doc, editor: editor, newLine: newLine, engine: .system)
    case .soniox:
      start(doc: doc, editor: editor, newLine: newLine, engine: .soniox)
    }
  }

  /// „Ustawienia” w wierszu stanu: ustawienia apki w iOS (zgoda na mikrofon, na rozpoznawanie mowy).
  func openSettings() {
    services.openSettings()
  }

  /// Edytor zmienił się pod nagraniem (nowe pole po przebudowie widoku).
  func attach(editor: NoteTextView?) {
    target?.editor = editor
  }

  /// Człowiek pisał: w trakcie nagrania nowy punkt startu (jak w polu wiadomości), po nagraniu — odpowiedź na
  /// komunikat, który znika razem z nim.
  func noticeEdit() {
    guard let recorder, recorder.active else {
      if view.notice != nil || limited || disabled != nil {
        view = VoiceView()
        limited = false
        disabled = nil
      }
      return
    }
    if field?.fieldChanged() == true { recorder.rebase() }
  }

  /// Formularz znika albo mikrofon przejmuje inne miejsce: hipoteza staje się tekstem, nagranie w dół od razu.
  /// Pole odpina się PRZED anulowaniem: anulowanie mówi pustymi buforami, które nadpisałyby podyktowany tekst.
  func handOff() {
    guard let recorder, recorder.active else { return }
    if let field { field.write(field.value(SonioxText.fold(recorder.view.buffers))) }
    field = nil
    spoken = .finalizing
    recorder.cancel()
    finished()
  }

  private func start(doc: NoteDocument, editor: NoteTextView?, newLine: Bool, engine: DictationEngine) {
    DictationCenter.shared.claim(self)
    let target = NoteVoiceTarget(doc: doc, editor: editor)
    self.target = target
    field = VoiceFieldBinding(target: target, newLine: newLine)
    spoken = nil
    disabled = nil
    limited = false
    doc.setDictating(true)
    recording += 1
    let id = recording
    let services = services
    let recorder = VoiceRecorder(
      deps: services.recorder(
        engine, mint: { [weak self] in await self?.mint() ?? .stop("") },
        trace: { [weak self] line in self?.store?.trace(line) }),
      handlers: .init(
        view: { [weak self] view in
          guard let self, self.recording == id else { return }
          self.show(view)
        },
        level: { _ in },
        disabled: { [weak self] message in self?.serverDisabled(message) }))
    self.recorder = recorder
    recorder.start()
  }

  private func mint() async -> VoiceMint {
    guard let store else { return .stop("") }
    return VoiceMint(await store.mintVoiceToken())
  }

  private func show(_ next: VoiceView) {
    field?.show(next.buffers, final: next.phase == .idle)
    view = next
    announce(next)
    if next.phase == .idle {
      finished()
    } else if target?.full == true, !limited {
      // Sufit dokumentu w trakcie nagrania: koniec z tym, co weszło (wiersz stanu mówi dlaczego).
      limited = true
      Announcer.shared.say(UICopy.noteDictationFull)
      recorder?.stop()
    }
  }

  private func finished() {
    field = nil
    let doc = target?.doc
    doc?.setDictating(false)
    guard backgroundWork != nil else { return }
    guard let doc else {
      finishBackgroundWork()
      return
    }
    // Koniec nagrania przerwanego zejściem w tło: zapis zejścia apki stał, bo trwało nagranie, a odliczenia szkicu
    // i autozapisu mogłyby nie zdążyć przed uśpieniem. Końcówka na dysk i do serwera teraz. Zapis to praca
    // z serwerem: osobne zadanie tła zaczyna się przed końcem zadania nagrania i czeka na zapis do 25 s.
    let store = store
    let save = store?.beginBackgroundWork("notatka", needsServer: true)
    doc.flush()
    doc.syncDraft()
    finishBackgroundWork()
    Task {
      let deadline = ContinuousClock.now + NoteBackgroundSave.limit
      while doc.saving, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(100))
      }
      store?.endBackgroundWork(save)
    }
  }

  private func enteredBackground() {
    guard let recorder, recorder.active else { return }
    // Bez serwera: dźwięk idzie prosto do Soniox, klucz do ponownej próby ma własną pracę w tle
    // (`RarogStore.mintVoiceToken`). Wygaśnięcie czasu zamyka zadanie adapter; późniejszy koniec jest bez skutku.
    if backgroundWork == nil {
      backgroundWork = store?.beginBackgroundWork("dyktowanie notatki", needsServer: false)
    }
    recorder.interrupt()
  }

  private func finishBackgroundWork() {
    guard let work = backgroundWork else { return }
    backgroundWork = nil
    store?.endBackgroundWork(work)
  }

  private func serverDisabled(_ message: String) {
    disabled = message
    Announcer.shared.say(message)
  }

  private func announce(_ view: VoiceView) {
    guard spoken != view.phase else { return }
    spoken = view.phase
    var quiet = view
    quiet.secondsLeft = nil
    let text = UICopy.voiceStatus(quiet)
    if !text.isEmpty { Announcer.shared.say(text) }
  }
}
#endif
