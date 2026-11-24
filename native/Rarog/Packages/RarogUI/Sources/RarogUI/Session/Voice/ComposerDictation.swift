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
/// - The background, a conversation and a locked field end the recording; its text stays in the field. With the
///   locked-phone trial on, the background keeps a recording whose microphone opened (`LockedPhoneTrial`): its text
///   keeps landing in this field, which is the session's draft. Closing the screen and a takeover of the microphone
///   turn the hypothesis into text, and the durable draft gets the field's state (`persistDraftNow` of the screen:
///   the field IS the draft, so no second copy is appended).
/// - Every end of a recording of this field writes the durable draft once the last words are in the field: the
///   dictation writes the field through its replace path, which persists nothing. An end that a waiting Send takes
///   writes none: `draftOnDisk` waits for that send, which stores the message or gives the text back.
/// - A recording that finishes while the app is in the background holds a background task (`holdFinalization`)
///   from its finalization until the disk confirmed the draft write (`draftOnDisk`): the open microphone keeps the
///   app running, and once it stops nothing else does. An end without a finalization (a stream that failed for
///   good) takes it for the draft write alone.
/// - Each recording ends with one `client.log` line, `dictation: ended <reason>`, never its text; a field that goes
///   away with its screen mid-recording writes `hand-off`.
@MainActor
final class ComposerDictation: DictationHost {
  private weak var composer: ComposerView?
  private weak var store: RarogStore?
  /// The session of this message field (`install`).
  private var sessionId: String?
  /// Zapis stanu pola do trwałego szkicu sesji (`SessionViewController.persistDraftNow`).
  private var persistDraft: (@MainActor () -> Void)?
  /// Waits until the disk ran the draft write `persistDraft` asked for (`ComposerDrafts.written`); a held background
  /// work ends after it. `nil`: the work ends once the write is asked for.
  private var draftOnDisk: (@MainActor () async -> Void)?
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
  /// The route of the running recording; `nil` once its end line is written.
  private var engine: DictationEngine?
  /// Why this field ended the running recording, for its end line; `nil` = it ended by itself.
  private var ending: String?
  /// The app's microphone that holds this field: it learns each change of the recording and the deinit
  /// (`DictationCenter.changed(_:)`).
  private weak var microphoneCenter: DictationCenter?
  private var observers: [any NSObjectProtocol] = []
  /// The app is in the background: between its background and foreground notifications.
  private var inBackground = false

  init(services: VoiceServices = .current) {
    self.services = services
  }

  isolated deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    // The recorder's view does not reach a field in its deinit, so the end line of a running recording goes here.
    traceEnd(ending ?? "hand-off")
    // Ekran zniknął bez `leave` — mikrofon i strumień nie mogą żyć dłużej niż on.
    recorder?.cancel()
    finishBackgroundWork()
    // The recorder's view no longer reaches this field, so the center learns the end here.
    microphoneCenter?.changed(self)
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

  /// `sessionId`: the session whose message field this is; the app's microphone names it by its project and name
  /// (`nil`: a session without names).
  func install(
    in composer: ComposerView, store: RarogStore, sessionId: String? = nil,
    persistDraft: @escaping @MainActor () -> Void, draftOnDisk: (@MainActor () async -> Void)? = nil
  ) {
    self.composer = composer
    self.store = store
    self.sessionId = sessionId
    self.persistDraft = persistDraft
    self.draftOnDisk = draftOnDisk
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
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.inBackground = false }
    })
  }

  /// Stan z rdzenia przy każdym renderze ekranu: czy pole przyjmuje tekst.
  func render(editable: Bool) {
    self.editable = editable
    // Pole przestało przyjmować tekst (decyzja, koniec sesji): nagranie kończy się z zatwierdzeniem.
    if !editable, let recorder, recorder.active {
      ending = ending ?? "field-locked"
      recorder.stop()
    }
    renderButtons()
  }

  // MARK: - Gesty

  func toggle() {
    if let recorder, recorder.active {
      // Drugie stuknięcie = „koniec, bierz to": ostatnie słowa wchodzą do pola.
      ending = ending ?? "stopped"
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
    traceEnd(ending ?? "hand-off")
    if let field { field.write(field.value(SonioxText.fold(recorder.view.buffers))) }
    // A Send waiting for the last words still goes, with what the field holds now: leaving the screen is not
    // taking the message back.
    let pendingSend = sendWaiting ? idleWaiters : []
    detach()
    recorder.cancel()
    for wake in pendingSend { wake() }
    persistDraft?()
    finishBackgroundWorkAfterDraft()
  }

  /// The recording's use while its microphone is open (a recording still preparing reports none): it dictates into
  /// the field of its session, named by the session's project and name, never by the field's text.
  var microphoneUse: MicrophoneUse? {
    guard let recorder, recorder.microphoneOpened else { return nil }
    let live = recorder.live
    let session = sessionId.flatMap { store?.state.sessions[$0] }
    return MicrophoneUse(
      kind: .dictation, audio: live.audio, openAI: false, soniox: engine == .soniox && live.stream,
      phase: .dictating, subject: .of(session))
  }

  /// Ends the recording as the second tap does: the last words land in the field; its end line says
  /// `live-activity`.
  func endFromLockScreen() {
    guard let recorder, recorder.active else { return }
    ending = ending ?? "live-activity"
    // The background time comes before the stop, while the open microphone still keeps the app running.
    if inBackground { holdFinalization() }
    recorder.stop()
  }

  func claimed(by center: DictationCenter) { microphoneCenter = center }

  // MARK: - Nagranie

  private func start(_ composer: ComposerView, engine: DictationEngine) {
    DictationCenter.shared.claim(self)
    self.engine = engine
    ending = nil
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
    // A recording of this field that starts finishing in the background (silence, the session limit, a locked
    // field): its first finalizing view comes before the recorder closes the microphone.
    if view.phase == .finalizing, inBackground, field != nil { holdFinalization() }
    field?.show(view.buffers, final: view.phase == .idle)
    status.render(view)
    renderButtons()
    onActiveChange?()
    announce(view)
    if view.phase == .idle { finished(view) }
    microphoneCenter?.changed(self)
  }

  private func finished(_ view: VoiceView) {
    traceEnd(ending ?? view.notice.map(DictationEndTrace.reason) ?? "ended")
    // A field `handOff` detached writes its draft and ends the background work there, after its waiting Send.
    guard field != nil else { return }
    field = nil
    // An end with no finalizing view (a stream that failed for good) took no background time yet, and its microphone
    // is closed: the draft write below gets it here.
    if inBackground { holdFinalization() }
    let waiters = idleWaiters
    idleWaiters = []
    for wake in waiters { wake() }
    // The last words are in the field: it goes to the durable draft, words said after the lock included, and a held
    // background work ends once the disk has it. A waiting Send took the field instead: writing the emptied field
    // here would delete the draft before the message is stored, and `draftOnDisk` waits for that send.
    if waiters.isEmpty { persistDraft?() }
    finishBackgroundWorkAfterDraft()
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
    ending = ending ?? "send"
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
    inBackground = true
    guard let recorder, recorder.active else { return }
    // With the locked-phone trial on, a recording whose microphone opened goes on: its text keeps landing in this
    // field. A recording still preparing ends as with the trial off, so its microphone never opens in the background.
    if store?.voiceAgent.lockedPhoneTrial.keeps(running: recorder.microphoneOpened) == true {
      // One that already finishes gets the background time for its last words.
      if recorder.view.phase == .finalizing { holdFinalization() }
      return
    }
    // Zejście w tło kończy nagranie; finalizacja dostaje chwilę w tle, tekst zostaje w polu.
    holdFinalization()
    ending = ending ?? "background"
    recorder.interrupt()
  }

  /// Background time for the finalization of this field's recording and the draft write after it; one at a time,
  /// ended in `finished`, `handOff` or the deinit. Without the server: the audio goes straight to Soniox, and the key
  /// of a retry has its own background work (`RarogStore.mintVoiceToken`). When the system's time runs out the
  /// adapter closes the task, and an end after that does nothing.
  private func holdFinalization() {
    guard backgroundWork == nil else { return }
    backgroundWork = store?.beginBackgroundWork("dyktowanie", needsServer: false)
  }

  /// One end line per recording of this field, on the voice agent budget: the app's 20 lines per hour would drop it
  /// behind other lines during a long recording. Only the reason word, never the text.
  private func traceEnd(_ reason: String) {
    guard engine != nil else { return }
    engine = nil
    store?.trace("dictation: ended \(reason)", budget: .voiceAgent)
  }

  private func finishBackgroundWork() {
    guard let work = backgroundWork else { return }
    backgroundWork = nil
    store?.endBackgroundWork(work)
  }

  /// Ends a held background work once the disk confirmed the draft the field just handed over: the screen only
  /// queues that write, and a process suspended right after the work ends could be removed before the queue ran.
  /// The work is taken out first, so a recording that starts meanwhile holds its own.
  private func finishBackgroundWorkAfterDraft() {
    guard let work = backgroundWork else { return }
    guard let draftOnDisk else { return finishBackgroundWork() }
    backgroundWork = nil
    Task { @MainActor [store] in
      await draftOnDisk()
      store?.endBackgroundWork(work)
    }
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
