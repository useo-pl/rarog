#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// The message field and the send: one send operation of the field with attachments and a typed result
// (`sendField`, `ComposerSendResult`) for ↑ and the voice conversation, recovery of text and attachments after a
// refusal (`SendRecovery`), "Retry" and the cells of queue entries. Owner: send.
extension SessionViewController {
  func buildComposer() {
    composer.onSend = { [weak self] in _ = self?.sendField() }
    composer.onEdit = { [weak self] in
      guard let self, self.transientHint else { return }
      self.transientHint = false
      self.applyComposerHint()
    }
    // Niewysłane załączniki sesji i paczka w trakcie wczytywania przeżywają nawigację:
    // pasek czyta i pisze półkę sesji, a wczytuje półka.
    composer.bind(to: AttachmentShelf.shared, sessionId: sessionId)
    composer.onAttachmentStatus = { [weak self] text, isError in self?.showAttachmentStatus(text, isError: isError) }
    // Tekst nieudanej wysyłki z poprzedniego ekranu tej sesji, która wróciła już po otwarciu tego.
    drafts.watch(sessionId) { [weak self] in self?.restoreDraftOnScreen() }
    composer.sources.presenter = self
    // Cały ekran sesji przyjmuje upuszczone zdjęcia i pliki (z Plików i Zdjęć).
    view.addInteraction(composer.sources.makeDropInteraction())
  }

  /// Szkic zapisany, gdy ten ekran już stoi: zabiera go wyłącznie ekran w oknie — odłączony
  /// zostawia szkic następnemu otwarciu.
  private func restoreDraftOnScreen() {
    guard isScreenAttached(store.state) else { return }
    restoreDraft()
  }

  /// Tekst nieudanej wysyłki, która wróciła, gdy ten ekran był zamknięty (``SendRecovery``).
  func restoreDraft() {
    guard let draft = drafts.take(for: sessionId) else { return }
    placeDraft(draft)
  }

  /// A failed send's text that came back while this screen lived out of the window, so it waits in the draft store
  /// (`restoreDraftOnScreen`): into the field before the field writes the session's draft, which would drop it. Only
  /// the waiting texts come, not the stored draft under them, which the field already holds.
  func takeWaitingDraft() {
    guard let draft = drafts.takeWaiting(for: sessionId) else { return }
    placeDraft(draft)
  }

  /// The text that came back on top of the field, and the reason under it.
  private func placeDraft(_ draft: ComposerDrafts.Draft) {
    restore(draft.text)
    if let note = draft.note {
      transientHint = composer.isEditable
      composer.setHint(note, isError: true)
    }
  }

  func renderComposer(_ state: AppState) {
    let model = ComposerModel.make(state: state, sessionId: sessionId, ui: ui)
    composer.isEditable = model.editable
    composer.canSend = model.sendable
    if !model.editable {
      transientHint = false
      composer.setHint(model.reason)
    } else if !transientHint {
      composer.setHint(nil)
    }
  }

  private func applyComposerHint() {
    renderComposer(store.state)
  }

  /// Zdanie o załącznikach pod polem; gaśnie przy edycji jak każde zdanie wyniku akcji.
  private func showAttachmentStatus(_ text: String?, isError: Bool) {
    guard let text else {
      transientHint = false
      applyComposerHint()
      return
    }
    guard composer.isEditable else { return }
    transientHint = true
    composer.setHint(text, isError: isError)
  }

  // MARK: - Komórki wpisów kolejki

  /// Wpis w locie stoi tym samym renderem markdownu co jego przyszłe echo (wiadomość człowieka, `markdown.text`):
  /// interlinia, kod w linii i bloki kodu są identyczne, więc dymek nie skacze, gdy wpis zamienia się w echo.
  func pendingConfiguration(
    entry: UUID, voice: VoiceLabel?, text: String, inFlight: Bool = true, queued: Bool = false,
    replaysTakeBack: Bool = false, takingBack: Bool = false, turn: TurnMark = TurnMark()
  ) -> MessageContentConfiguration {
    // The density is part of the echo's style too, so the entry and its echo share one render.
    let style = MarkdownRenderer.Style(
      textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: traitCollection,
      spacing: transcriptSpacing)
    // Wpis w kolejce CLI czeka nieraz minutami i też niesie pasmo poświaty, w fazie innych dymków w kolejce;
    // czytnik słyszy „w kolejce”. Wysokość ta sama co echa, więc przejście w wiadomość nie rusza transkryptu.
    // While the queue is being taken back the bubble says so to VoiceOver too, not only in the status row under it.
    let prefix = takingBack ? UICopy.takingBackRolePrefix : queued ? UICopy.queuedRolePrefix : UICopy.pendingRolePrefix
    var config = MessageContentConfiguration(
      voice: voice.map(UICopy.roleLabel), text: markdown.text(text, style: style), plate: true, dimmed: true,
      accessibilityIdentifier: "pending.\(entry.uuidString)", accessibilityPrefix: prefix, gap: turn.gap)
    config.inFlight = inFlight
    config.takingBack = takingBack
    config.spacing = transcriptSpacing
    // A queued bubble takes the whole queue back into the field on a tap and on its VoiceOver action; a Not confirmed
    // one does while the session keeps a take-back without an answer, which the gesture replays.
    if queued || replaysTakeBack { config.takeBack = { [weak self] in self?.takeBackQueue(tapped: entry) } }
    placePromptClock(&config, turn: turn)
    // Ta sama reguła zwijania co echo, klucz wiersza wpisu — rozwinięcie przechodzi na echo (`TranscriptReading`).
    placePromptFold(&config, rowId: "o\(entry.uuidString)", turn: turn)
    return config
  }

  /// The thumbnails of an entry's attachments with the progress ring and the stop in its center.
  /// The stop ends the send in flight; the store leaves an entry without one alone.
  func pendingMediaView(_ model: PendingMediaModel) -> some View {
    PendingMediaRowView(
      model: model, loader: PendingThumbnailLoader(store: store, sessionId: sessionId, entry: model.entry),
      stop: { [weak self] in self?.store.cancelSend(model.entry) })
  }

  /// Wpis, który od poprzedniego renderu zgasł echem, oddaje zdekodowane miniatury kaflom echa — PRZED
  /// konfiguracją komórek, bo kafel echa czyta pamięć miniatur w chwili powstania.
  func handOffPendingThumbnails(previous: some Sequence<TranscriptRow>, state: AppState) {
    for pair in EchoThumbnailHandoff.pairs(previous: previous, state: state, sessionId: sessionId) {
      ThumbnailImageCache.shared.handOff(pair, login: store.uploadLogin)
    }
  }

  func pendingStatusView(entry: UUID, status: PendingStatus, retrying: Bool) -> some View {
    PendingStatusView(
      status: status,
      retrying: retrying,
      retryBlocked: { [weak self] in
        guard let self else { return nil }
        return self.store.state.sessionStale(self.sessionId) ? UICopy.staleAction : nil
      },
      retry: { [weak self] in self?.retry(entry) },
      discard: { [weak self] in self?.store.discard(entry) })
      .id(entry)
  }

  // MARK: - Akcje

  /// One send of the message field, for ↑ and for the voice conversation's `send_prompt` (`+VoiceAgent`). The checks
  /// and the taking of the text and the attachments run before the first `await`, so a second call finds the field
  /// already empty; the task gives the typed result (`ComposerSendResult`). It never stops a running turn. `byVoice`:
  /// the login of the moment the field is taken must still hold when the request starts.
  @discardableResult
  func sendField(byVoice: Bool = false) -> Task<ComposerSendResult, Never> {
    // Start agenta: tekst zostaje w polu, wiersz aktywności nad polem mówi, że wyśle się po gotowości.
    guard composer.isEditable, composer.canSend else {
      // A fixed name, not the sentence under the field: the voice conversation passes it to OpenAI.
      return Self.finished(.readOnly(reason: VoiceAgentToolText.closedField(state: store.state, sessionId: sessionId)))
    }
    // Komenda apki (`/model`, `/effort`) przed wszystkim innym: nic nie wychodzi, kolejka i okno
    // „Wyślij” stoją nietknięte, załączniki zostają w pasku (`+AppCommands`).
    if runAppCommand() { return Self.finished(.appCommand) }
    if composer.isLoadingAttachments {
      showAttachmentStatus(UICopy.attachmentsStillLoading, isError: false)
      return Self.finished(.attachmentsLoading)
    }
    let attachments = composer.attachments
    // Pasek po przywróceniu nieudanej wysyłki bywa pełniejszy niż limit — nic nie ginie, człowiek wybiera.
    guard AttachmentCounts.withinLimits(attachments) else {
      showAttachmentStatus(UICopy.attachmentsOverLimit, isError: true)
      return Self.finished(.attachmentsOverLimit)
    }
    let raw = composer.text
    // A voice conversation shows "Sent to the session" only for what this send takes, and the send takes its prompt:
    // text that comes back to the field is the user's (`+VoiceAgent`).
    let voiceAgent = voiceAgentSendMark()
    voiceAgentTakePrompt()
    // A voice send keeps the login and the interface (the space of the server) of the moment it takes the field: a
    // pairing or a server that changes before the request starts gets nothing (`giveBack`). ↑ is not checked: the
    // user sends what the screen shows.
    let login = byVoice ? (epoch: store.loginEpoch, interface: store.interfaceEpoch) : nil
    // Okno „Wyślij" po wysyłce PRZED czyszczeniem pola: puste pole przy pracującej turze dałoby od razu Stop.
    // Tap w pustym polu okna nie odnawia — drugi tap podwójnego „Wyślij" nie przedłuża go bez końca.
    if ComposerPrimaryAction.opensGrace(rawText: raw, attachments: attachments.count) { noteSent() }
    // Pole i pasek czyszczą się od razu; nieudana wysyłka odda tekst i załączniki.
    composer.text = ""
    composer.removeSent(attachments)
    transientHint = false
    applyComposerHint()
    pinned = true
    return Task { [weak self] in
      guard let self else { return .notSent }
      if let login, self.store.loginEpoch != login.epoch {
        self.giveBack(raw, attachments, sameSpace: self.store.interfaceEpoch == login.interface)
        return .notSent
      }
      let outcome = await self.store.send(text: raw, attachments: attachments.map(\.outgoing), to: self.sessionId)
      var queued = false
      if case let .accepted(id) = outcome {
        queued = self.store.state.outbox.first { $0.id == id }?.isQueued == true
      }
      self.handleSend(outcome, raw: raw, attachments: attachments, voiceAgent: voiceAgent)
      return ComposerSendResult(outcome, queued: queued)
    }
  }

  /// A voice send that did not start because the login changed. The screen still attached in the same space: the text
  /// and the attachments come back to the field as after a refusal before the request. Otherwise nothing goes to the
  /// shelf, which is global and keyed by the session id alone (a session of another server can have the same id):
  /// the files of the attachments are discarded, and the text goes to the draft of the session only in the same space.
  /// `sameSpace`: the interface was not built again (`RarogStore.interfaceEpoch`), so `drafts` is still the store of
  /// the space the field was taken in (`RarogRootView` makes one per space); after a change the text is lost.
  private func giveBack(_ raw: String, _ attachments: [ComposerAttachment], sameSpace: Bool) {
    if sameSpace, isScreenAttached(store.state) {
      restore(raw)
      composer.restoreAttachments(attachments)
      return
    }
    AttachmentStaging.discard(attachments)
    if sameSpace { drafts.save(raw, note: nil, for: sessionId) }
  }

  /// A send refused before the field was taken.
  private static func finished(_ result: ComposerSendResult) -> Task<ComposerSendResult, Never> {
    Task { result }
  }

  private func handleSend(
    _ outcome: SendOutcome, raw: String, attachments: [ComposerAttachment], voiceAgent: VoiceAgentSendMark?
  ) {
    let state = store.state
    let result = UICopy.sendResult(outcome, session: state.sessions[sessionId])
    // A voice conversation says so in the status row (`+VoiceAgent`).
    if case .accepted = outcome { voiceAgentFieldSent(voiceAgent) }
    if case let .notPersisted(reason) = outcome {
      store.reportUnhandled("kolejka wysyłki: zapis na dysk nie powiódł się (\(reason.prefix(80)))")
    }
    // Ekran mógł zniknąć w trakcie żądania (inna sesja, wylogowanie po 401): tekst nie trafia do
    // odłączonego pola, a wpis kolejki zostaje, dopóki tekst nie stanie tam, gdzie go widać.
    switch SendRecovery.plan(outcome, screenAttached: isScreenAttached(state)) {
    case let .restoreToField(discard):
      restore(raw)
      // Nieudane załączniki na początku paska; dołożone w trakcie wysyłki nie giną.
      composer.restoreAttachments(attachments)
      // Tekst wrócił do żywego pola — wpis w transkrypcie byłby drugą kopią tej samej wiadomości.
      if let discard { store.discard(discard) }
    case .keepEntry:
      // Odmowa stoi w transkrypcie sesji z treścią i „Ponów"/„Odrzuć" (także po zabiciu apki);
      // kolejka ma własne kopie plików.
      AttachmentStaging.discard(attachments)
      return
    case .saveDraft:
      // Półka i szkic same oddają treść ekranowi tej sesji otwartemu w międzyczasie (albo następnemu).
      AttachmentShelf.shared.restore(attachments, for: sessionId)
      drafts.save(raw, note: result.text, for: sessionId)
      return
    case .none:
      // Accepted, not confirmed or stopped in the ring: the content lies in the outbox, the shelf does not need its
      // files.
      AttachmentStaging.discard(attachments)
    }
    if let text = result.text {
      transientHint = composer.isEditable
      composer.setHint(text, isError: result.isError)
    }
    if case .empty = outcome { composer.textView.becomeFirstResponder() }
  }

  /// Ekran tej sesji wciąż jest na wierzchu: w oknie i przy zalogowaniu (401 zdejmuje go dopiero
  /// w następnym przebiegu SwiftUI, a stan rdzenia jest już wylogowany).
  func isScreenAttached(_ state: AppState) -> Bool {
    isViewLoaded && view.window != nil && state.auth == .loggedIn
  }

  /// Oddanie tekstu do pola: gdy człowiek zdążył coś dopisać, nieudany tekst stoi na górze.
  private func restore(_ raw: String) {
    guard !raw.isEmpty else { return }
    let current = composer.text
    composer.text = current.isEmpty ? raw : "\(raw)\n\(current)"
  }

  private func retry(_ entry: UUID) {
    guard !ui.retrying.contains(entry) else { return }
    // Przed świeżym stanem nic nie wychodzi; wzrok ma to samo zdanie w podpowiedzi pod polem.
    guard !store.state.sessionStale(sessionId) else {
      if canAnnounce(in: announcementScope) { announcer.say(UICopy.staleAction) }
      return
    }
    pinned = true
    ui.retrying.insert(entry)
    scheduleRender()
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.store.retry(entry)
      // Każdy wynik zwalnia „Ponów" — po odmowie dysku przycisk znów działa, bez wychodzenia z sesji.
      self.ui.retrying.remove(entry)
      if case let .notPersisted(reason) = outcome {
        self.store.reportUnhandled("kolejka wysyłki: zapis ponowienia nie powiódł się (\(reason.prefix(80)))")
        self.transientHint = true
        self.composer.setHint(UICopy.notPersisted, isError: true)
      }
      self.scheduleRender()
    }
  }
}
#endif
