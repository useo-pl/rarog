#if os(iOS)
import RarogContract
import RarogCore
import UIKit

// Ekran sesji, sterowanie sesją: przycisk pola jako „Wyślij"/Stop i wynik przerwania, „obejrzane" przy wyniku na ekranie,
// ekran bez wygaszania przy pracującej sesji. Esc w `+KeysInterrupt`, szkic
// w `+Drafts`, pasek promptu w `+PromptBar`. Rdzeń kontrolera woła `installTurnControl` (koniec
// `viewDidLoad`), `appearTurnControl` (`viewDidAppear`), `renderTurnControl` (każdy render)
// i `leaveTurnControl` (`viewWillDisappear`). Właściciel: przerwanie i sterowanie sesją.

/// Stan sterowania sesją w kontrolerze sesji (pole `turnChrome`).
@MainActor
final class TurnChrome {
  /// Odroczony zapis szkicu po przerwie od ostatniej zmiany pola (`+Drafts`).
  var draftSave: Task<Void, Never>?
  /// Stan zapisany i stan, na który czeka odliczanie — zapis tylko przy zmianie (`+Drafts`).
  var draftSchedule = DraftSaveSchedule()
  /// Obserwatorzy cyklu życia apki (tło, powrót).
  var observers: [NSObjectProtocol] = []
  /// Ten ekran trzyma wyłączone wygaszanie — oddaje je tylko on.
  var keepsAwake = false
  /// Pasek cytatu promptu nad transkryptem (`+PromptBar`).
  var promptBar: PromptBarView?
  /// The bar's leading and trailing constraints: they follow the transcript's side margin (`+Spacing`).
  var promptBarLeading: NSLayoutConstraint?
  var promptBarTrailing: NSLayoutConstraint?
  /// Ostatni cytat paska — przebudowa tylko przy zmianie.
  var promptQuote: PromptQuote?
  /// Obserwacja przewinięcia transkryptu dla paska promptu (delegat listy należy do transkryptu).
  var offsetObservation: NSKeyValueObservation?
  /// Chwila ostatniej wysyłki z pola: przez `ComposerPrimaryTiming.sendGrace` przycisk zostaje „Wyślij".
  var sentAt: Date?
  /// Przeliczenie przycisku po końcu tego okna.
  var graceEnd: Task<Void, Never>?

  /// Ekran zdjęty bez `viewWillDisappear` (wymiana widoku przez SwiftUI) nie zostawia wyłączonego
  /// wygaszania ani obserwatorów centrum powiadomień.
  isolated deinit {
    graceEnd?.cancel()
    if keepsAwake { UIApplication.shared.isIdleTimerDisabled = false }
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }
}

extension SessionViewController {
  /// Koniec `viewDidLoad` (po odtworzeniu szkicu przez `+Send`).
  func installTurnControl() {
    // Przycisk pola idzie za trybem z ekranu; Enter sprzętowy zostaje przy `onSend` i nigdy nie przerywa.
    composer.onPrimaryAction = { [weak self] mode in self?.primaryAction(mode) }
    composer.onContentChange = { [weak self] in self?.renderPrimaryAction() }
    dictation.onActiveChange = { [weak self] in
      guard let self else { return }
      self.renderPrimaryAction()
      // Mikrofon jest jeden: w trakcie dyktowania rozmowa z agentem głosowym nie rusza (`+VoiceAgent`).
      self.renderVoiceAgent(self.store.state)
    }
    installInterruptKeys()
    installQueueTakeBack()
    installDrafts()
    installPromptBar()
    let center = NotificationCenter.default
    turnChrome.observers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.persistDraftNow()
        self?.syncKeepAwake()
      }
    })
    turnChrome.observers.append(center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.appearTurnControl() }
    })
    // Nowe wejście w sesję zwalnia ręczne „nieprzeczytane”. Tu, a nie w `viewDidAppear`: kontroler powstaje
    // na każde wejście (`.id(id)` w `DetailView`), a `viewDidAppear` odpala też po zamknięciu pełnoekranowego
    // podglądu obrazka — wtedy wynik oznaczony jako nieprzeczytany odebrałby się sam.
    store.enterResultView(sessionId)
  }

  /// Ekran stanął na wierzchu (wejście, powrót apki na wierzch): odbiór wyniku i wygaszanie.
  func appearTurnControl() {
    syncKeepAwake()
    noteResultViewed(store.state)
  }

  /// Każdy render: przycisk pola, ekran bez wygaszania, „obejrzane", szkic i pasek promptu.
  func renderTurnControl(_ state: AppState) {
    renderPrimaryAction(state)
    syncKeepAwake()
    noteResultViewed(state)
    draftMayHaveChanged()
    renderPromptBar(state)
  }

  /// Zejście z ekranu (`viewWillDisappear`).
  func leaveTurnControl() {
    persistDraftNow()
    releaseKeepAwake()
    store.leaveResultView(sessionId)
  }

  // MARK: - Przycisk pola: „Wyślij" albo Stop

  /// Tryb przycisku z reguły rdzenia: Stop przy pracującej turze i pustym polu (bez załącznika i dyktowania,
  /// także kończonego), poza oknem po wysyłce. Woła go render, zmiana pola i paska, dyktowanie i koniec okna.
  /// Wpis to SUROWY tekst pola: „   ” w trakcie tury daje „Wyślij”, nie Stop. Wypełnienie „Wyślij” liczy pole samo
  /// z tekstu po przycięciu (`ComposerView.applyPrimaryFill`), więc taki „Wyślij” stoi w obrysie.
  func renderPrimaryAction(_ state: AppState? = nil) {
    let state = state ?? store.state
    composer.isDictating = dictation.isActive
    composer.primaryAction = .resolve(
      availability: state.interruptAvailability(for: sessionId), hasDraft: !composer.text.isEmpty,
      hasAttachments: composer.hasAttachmentEntry, dictationActive: dictation.isActive,
      sentAt: turnChrome.sentAt, now: Date())
  }

  /// Wysyłka z treścią (przycisk albo Enter): przez okno po niej przycisk zostaje „Wyślij" — drugi tap
  /// podwójnego „Wyślij" trafia w pustą wysyłkę, nie w Stop świeżo wysłanej tury. Po oknie jedno przeliczenie.
  func noteSent() {
    let now = Date()
    turnChrome.sentAt = now
    turnChrome.graceEnd?.cancel()
    guard let end = ComposerPrimaryAction.graceEnds(sentAt: now, now: now) else { return }
    turnChrome.graceEnd = Task { @MainActor [weak self] in
      // Margines: przeliczenie ma wypaść już po końcu okna, nie tuż przed nim.
      try? await Task.sleep(for: .seconds(end.timeIntervalSinceNow + 0.02))
      guard !Task.isCancelled else { return }
      self?.renderPrimaryAction()
    }
  }

  /// Tap w przycisk pola, w trybie, który był na ekranie.
  private func primaryAction(_ mode: ComposerPrimaryAction) {
    switch mode {
    case .send: composer.onSend?()
    case .stop(enabled: true): interruptTurn(trigger: .stop)
    case .stop(enabled: false): break
    }
  }

  // MARK: - Przerwanie

  /// Stop (przycisk pola w trybie Stopu) i Esc — jedna droga. Prompt bierzemy PRZED żądaniem: render w trakcie mógłby podmienić
  /// stan pod ręką. Wynik dotyczy tylko TEGO ekranu: po zmianie sesji albo wylogowaniu przepada.
  /// Czas od gestu do rozstrzygnięcia zostaje śladem w `client.log` (`DiagnosticsTrace`).
  func interruptTurn(trigger: InterruptTrigger = .stop) {
    guard store.state.interruptAvailability(for: sessionId) == .enabled,
      !store.state.interruptHeld(sessionId, now: Date())
    else { return }
    let prompt = store.state.lastPrompt(for: sessionId)
    Announcer.shared.say(UICopy.interruptSent)
    let started = ContinuousClock.now
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.store.interrupt(self.sessionId)
      let elapsed = ContinuousClock.now - started
      let milliseconds = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
      self.store.trace(DiagnosticsTrace.interrupt(trigger: trigger, outcome: outcome, milliseconds: milliseconds))
      self.presentInterrupt(outcome, prompt: prompt)
    }
  }

  private func presentInterrupt(_ outcome: InterruptOutcome, prompt: String) {
    guard isViewLoaded, view.window != nil, store.state.auth == .loggedIn else { return }
    let fieldEmpty = composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    guard let shown = InterruptPresentation.make(
      outcome, prompt: prompt, fieldEmpty: fieldEmpty, machine: store.state.serverMachine) else { return }
    if shown.restorePrompt {
      composer.text = prompt
      persistDraftNow()
    }
    if let line = shown.line {
      // Linia zostaje do edycji pola (jak wynik wysyłki); błąd ogłasza samo pole.
      transientHint = composer.isEditable
      composer.setHint(line, isError: shown.isError)
      if !shown.isError { Announcer.shared.say(shown.spoken) }
    } else {
      transientHint = false
      renderComposer(store.state)
      Announcer.shared.say(shown.spoken)
    }
  }

  // MARK: - „Obejrzane"

  /// Wynik na ekranie na wierzchu = odbiór. Zmiana stanu poza renderem (render czyta magazyn
  /// pod obserwacją), i tylko gdy jest co zmienić — dedup trzyma rdzeń.
  private func noteResultViewed(_ state: AppState) {
    guard isViewLoaded, view.window != nil, UIApplication.shared.applicationState == .active else { return }
    guard state.seenTarget(sessionId) != state.turnControl.seen[sessionId] else { return }
    Task { @MainActor [weak self] in
      guard let self, self.isViewLoaded, self.view.window != nil else { return }
      self.store.noteResultViewed(self.sessionId)
    }
  }

  // MARK: - Ekran bez wygaszania

  /// Pracująca sesja na wierzchu: ekran nie gaśnie (człowiek patrzy, jak agent pracuje). Tło,
  /// koniec tury i zejście z ekranu oddają wygaszanie systemowi.
  func syncKeepAwake() {
    let session = store.state.sessions[sessionId]
    let working = session?.state == .running || session?.state == .starting
    let wanted = working && isViewLoaded && view.window != nil && UIApplication.shared.applicationState != .background
    guard wanted != turnChrome.keepsAwake else { return }
    turnChrome.keepsAwake = wanted
    UIApplication.shared.isIdleTimerDisabled = wanted
  }

  private func releaseKeepAwake() {
    guard turnChrome.keepsAwake else { return }
    turnChrome.keepsAwake = false
    UIApplication.shared.isIdleTimerDisabled = false
  }
}
#endif
