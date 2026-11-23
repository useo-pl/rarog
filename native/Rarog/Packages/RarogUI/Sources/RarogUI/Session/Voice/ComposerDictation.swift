#if os(iOS)
import RarogCore
import UIKit

/// Dyktowanie w polu wiadomości jednego ekranu sesji.
/// Właściciel: dyktowanie.
///
/// - Mikrofon stoi zawsze, gdy pole przyjmuje tekst: brak dyktowania na serwerze zmienia trasę, nie chowa go.
/// - Tap mikrofonu (albo ⌥⌘M, `DictationShortcut`) bierze trasę z rdzenia (`RarogStore.dictationRoute`): ekran
///   „Dyktowanie” (`onAsk`, bez mikrofonu — po wyborze nagrywa dopiero następne stuknięcie), rozpoznawanie mowy
///   Apple albo Soniox z kluczem tymczasowym z serwera. Apka nigdy sama nie przełącza dostawcy: błąd jednej trasy
///   kończy nagranie zdaniem, a nie przejściem na drugą. Drugi tap kończy z zatwierdzeniem: tekst zostaje w polu,
///   nic się nie wysyła.
/// - During a voice agent conversation the tap and ⌥⌘M mute or unmute the conversation (`onConversationMic`)
///   instead of dictating; to dictate, the user ends the conversation first.
/// - Pisanie w trakcie ustawia nowy punkt startu; kursor zostaje tam, gdzie człowiek poprawia. Tak samo
///   zmiana pola z kodu ekranu (tekst oddany po odmowie wysyłki, szkic, prompt po Esc) — inaczej
///   następny token nadpisałby ją wartością sprzed zmiany (`VoiceFieldBinding`).
/// - Send during a recording, or while it finishes, ends it and waits for the last words, then sends the whole text.
/// - Tło, rozmowa, wygaszone pole: nagranie kończy się, tekst zostaje w polu. Zamknięcie ekranu
///   i przejęcie mikrofonu: hipoteza staje się tekstem, a trwały szkic dostaje stan pola
///   (`persistDraftNow` ekranu — pole JEST szkicem, więc bez doklejania drugiej kopii).
@MainActor
final class ComposerDictation: DictationHost {
  private weak var composer: ComposerView?
  private weak var store: RarogStore?
  /// Zapis stanu pola do trwałego szkicu sesji (`SessionViewController.persistDraftNow`).
  private var persistDraft: (@MainActor () -> Void)?
  private let services: VoiceServices
  let buttons = VoiceButtons()
  let status = VoiceStatusView()

  private var recorder: VoiceRecorder?
  /// Numer nagrania: widok od nagrywarki, której już nie ma, nie rusza ekranu.
  private var recording = 0
  /// Sklejenie z polem; `nil` = dyktowanie już nie pisze do pola (wysyłka, odejście).
  private var field: VoiceFieldBinding?
  /// Ostatni stan ogłoszony czytnikowi — mówimy ZMIANĘ stanu, nie każde tyknięcie.
  private var spoken: VoiceView.Phase?
  private var warned = false
  /// Kto czeka na kompletny tekst (wysyłka w trakcie kończenia).
  private var idleWaiters: [@MainActor () -> Void] = []
  private var sendWaiting = false
  private var editable = true
  /// A voice agent conversation runs (`nil` = none) and whether it is muted: the mic mutes it instead of dictating.
  private var conversationMuted: Bool?
  private var renderedButtons: (recording: Bool, editable: Bool, conversationMuted: Bool?)?
  /// Praca w tle kończenia nagrania (przez magazyn, `RarogStore.beginBackgroundWork`).
  private var backgroundWork: BackgroundWorkToken?
  private var observers: [any NSObjectProtocol] = []

  init(services: VoiceServices = .current) {
    self.services = services
  }

  isolated deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    // Ekran zniknął bez `leave` — mikrofon i strumień nie mogą żyć dłużej niż on.
    recorder?.cancel()
    finishBackgroundWork()
  }

  var isActive: Bool { recorder?.active ?? false }

  /// Zmiana stanu nagrania (start, kończenie, koniec): ekran przelicza przycisk pola — trwające dyktowanie,
  /// także kończone, to wpis, więc przycisk zostaje „Wyślij".
  var onActiveChange: (() -> Void)?

  /// Stuknięcie przy trasie, która pyta: ekran „Dyktowanie” (`RarogNavigation.openDictation`, wpina ekran sesji).
  var onAsk: (@MainActor () -> Void)?

  /// The mic (and ⌥⌘M) during a voice agent conversation: mute or unmute it (`SessionViewController+VoiceAgent`).
  var onConversationMic: (@MainActor () -> Void)?

  /// Skrót dyktowania i mikrofon: zaczyna (albo pyta o trasę), gdy pole przyjmuje tekst; kończy zawsze.
  /// During a voice agent conversation they mute it, also with a read-only field.
  var canToggle: Bool { isActive || editable || conversationMuted != nil }

  /// The voice agent conversation of the screen: `nil` = none runs, otherwise whether it is muted.
  func renderConversation(muted: Bool?) {
    conversationMuted = muted
    renderButtons()
  }

  // MARK: - Wpięcie

  func install(in composer: ComposerView, store: RarogStore, persistDraft: @escaping @MainActor () -> Void) {
    self.composer = composer
    self.store = store
    self.persistDraft = persistDraft
    composer.installVoice(mic: buttons.mic, status: status)
    buttons.onMic = { [weak self] in self?.toggle() }
    let services = services
    status.onSettings = { services.openSettings() }
    let edit = composer.onEdit
    composer.onEdit = { [weak self] in
      edit?()
      self?.noticeEdit()
    }
    // Zmiana pola z kodu ekranu (tekst nieudanej wysyłki, szkic, prompt po Esc) w trakcie nagrania
    // to nowy punkt startu jak pisanie — `textViewDidChange` jej nie zgłasza.
    let replace = composer.onReplace
    composer.onReplace = { [weak self] in
      replace?()
      self?.noticeReplace()
    }
    let send = composer.onSend
    composer.onSend = { [weak self] in
      guard let self else {
        send?()
        return
      }
      self.send(send)
    }
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.enteredBackground() }
    })
  }

  /// Stan z rdzenia przy każdym renderze ekranu: czy pole przyjmuje tekst.
  func render(editable: Bool) {
    self.editable = editable
    // Pole przestało przyjmować tekst (decyzja, koniec sesji): nagranie kończy się z zatwierdzeniem.
    if !editable, let recorder, recorder.active { recorder.stop() }
    renderButtons()
  }

  // MARK: - Gesty

  func toggle() {
    if let recorder, recorder.active {
      // Drugie stuknięcie = „koniec, bierz to": ostatnie słowa wchodzą do pola.
      recorder.stop()
      return
    }
    // A running conversation owns the microphone: the mic mutes it; dictation waits for the conversation's end.
    if conversationMuted != nil {
      onConversationMic?()
      return
    }
    guard editable, let composer, let store else { return }
    switch store.dictationRoute {
    case .ask:
      onAsk?()
    case .system:
      start(composer, engine: .system)
    case .soniox:
      start(composer, engine: .soniox)
    }
  }

  /// Ekran znika (inna sesja, wylogowanie, wyjście do listy).
  func leave() {
    handOff()
  }

  /// Ekran znika albo mikrofon przejmuje inne miejsce: hipoteza staje się tekstem, strumień w dół
  /// bez czekania (pola zaraz nie będzie), a stan pola ląduje w trwałym szkicu sesji.
  func handOff() {
    guard let recorder, recorder.active else { return }
    if let field { field.write(field.value(SonioxText.fold(recorder.view.buffers))) }
    // A Send waiting for the last words still goes, with what the field holds now: leaving the screen is not
    // taking the message back.
    let pendingSend = sendWaiting ? idleWaiters : []
    detach()
    recorder.cancel()
    for wake in pendingSend { wake() }
    persistDraft?()
  }

  // MARK: - Nagranie

  private func start(_ composer: ComposerView, engine: DictationEngine) {
    DictationCenter.shared.claim(self)
    field = VoiceFieldBinding(target: composer)
    spoken = nil
    warned = false
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
        level: { [weak self] peak in self?.status.level(peak) },
        disabled: { [weak self] message in self?.serverDisabled(message) }))
    self.recorder = recorder
    recorder.start()
  }

  private func mint() async -> VoiceMint {
    guard let store else { return .stop("") }
    return VoiceMint(await store.mintVoiceToken())
  }

  private func show(_ view: VoiceView) {
    field?.show(view.buffers, final: view.phase == .idle)
    status.render(view)
    renderButtons()
    onActiveChange?()
    announce(view)
    if view.phase == .idle { finished() }
  }

  private func finished() {
    field = nil
    finishBackgroundWork()
    let waiters = idleWaiters
    idleWaiters = []
    for wake in waiters { wake() }
  }

  /// Człowiek pisał: w trakcie nagrania to nowy punkt startu, po nagraniu — odpowiedź na komunikat,
  /// który znika razem z nim.
  private func noticeEdit() {
    guard let recorder, recorder.active else {
      // Notices go; a running voice conversation keeps its row (`VoiceStatusOwner`).
      if !status.isHidden { status.noticeEdit() }
      return
    }
    if field?.fieldChanged() == true { recorder.rebase() }
  }

  /// Pole zmienione z kodu: w trakcie nagrania nowy punkt startu (własny zapis dyktowania się nie
  /// liczy); poza nagraniem nic — to nie odpowiedź człowieka na komunikat.
  private func noticeReplace() {
    guard let recorder, recorder.active, field?.fieldChanged() == true else { return }
    recorder.rebase()
  }

  private func send(_ send: (() -> Void)?) {
    guard let recorder, recorder.active else {
      send?()
      return
    }
    // Send ends the recording like a second mic tap and waits for the last words (at most the finalization limit),
    // so the message carries the whole sentence and no late word lands in the emptied field.
    guard !sendWaiting else { return }
    // The waiter goes in before `stop()`: a recording with no stream yet (asking for the microphone permission) ends
    // synchronously, and a waiter added after that would miss this end and fire at the next recording's.
    sendWaiting = true
    idleWaiters.append { [weak self] in
      self?.sendWaiting = false
      send?()
    }
    if recorder.view.phase != .finalizing { recorder.stop() }
  }

  /// Dyktowanie przestaje pisać do pola i nikogo już nie budzi. „Kończę…" porzuconego nagrania nie
  /// idzie do czytnika: po anulowaniu to zdanie byłoby nieprawdą.
  private func detach() {
    field = nil
    idleWaiters = []
    sendWaiting = false
    spoken = .finalizing
  }

  private func enteredBackground() {
    guard let recorder, recorder.active else { return }
    // Zejście w tło kończy nagranie; finalizacja dostaje chwilę w tle, tekst zostaje w polu. Bez serwera: dźwięk
    // idzie prosto do Soniox, a klucz do ponownej próby ma własną pracę w tle (`RarogStore.mintVoiceToken`).
    // Wygaśnięcie czasu zamyka zadanie adapter; późniejszy koniec jest wtedy bez skutku.
    if backgroundWork == nil {
      backgroundWork = store?.beginBackgroundWork("dyktowanie", needsServer: false)
    }
    recorder.interrupt()
  }

  private func finishBackgroundWork() {
    guard let work = backgroundWork else { return }
    backgroundWork = nil
    store?.endBackgroundWork(work)
  }

  /// Serwer odmówił drogi Soniox przy pobraniu klucza (404, 503 `voice_unconfigured`): rdzeń zapisuje odmowę
  /// (`sonioxOnServer`), tekst zostaje w polu, mikrofon też — następne stuknięcie otwiera ekran „Dyktowanie”.
  private func serverDisabled(_ message: String) {
    status.render(VoiceView(notice: .message(message)))
    Announcer.shared.say(message)
  }

  private func renderButtons() {
    let next = (recording: recorder?.active ?? false, editable: editable, conversationMuted: conversationMuted)
    if let last = renderedButtons, last == next { return }
    renderedButtons = next
    buttons.render(
      available: true, recording: next.recording, enabled: next.editable, conversationMuted: next.conversationMuted)
  }

  private func announce(_ view: VoiceView) {
    if spoken != view.phase {
      spoken = view.phase
      var quiet = view
      quiet.secondsLeft = nil
      let text = UICopy.voiceStatus(quiet)
      if !text.isEmpty { Announcer.shared.say(text) }
    }
    if let left = view.secondsLeft, !warned {
      warned = true
      Announcer.shared.say(UICopy.voiceLimitSpoken(seconds: left))
    }
  }
}

extension ComposerView: VoiceTextTarget {
  var isComposing: Bool { textView.markedTextRange != nil }

  /// Zapis dyktowania; kursor na końcu tylko, gdy tam był.
  func writeDictation(_ value: String) {
    let old = (textView.text ?? "") as NSString
    let selection = voiceSelection(
      old: textView.selectedRange, oldLength: old.length, newLength: (value as NSString).length)
    text = value
    textView.selectedRange = selection
    textView.scrollRangeToVisible(selection)
  }
}
#endif
