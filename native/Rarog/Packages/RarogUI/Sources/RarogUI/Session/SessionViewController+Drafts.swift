#if os(iOS)
import RarogCore
import UIKit

// Trwały szkic pola wiadomości: tekst i niewysłane załączniki przeżywają nawigację
// i zabicie apki. Zapis po krótkiej przerwie od ostatniej ZMIANY pola (pisanie, pasek, zmiana wykryta
// w renderze: wysyłka czyści pole, odmowa je oddaje), przy wyjściu z ekranu i przy zejściu apki w tło;
// regułę trzyma `DraftSaveSchedule`. Dyktowanie przy przejęciu mikrofonu woła `persistDraftNow()`.
// Właściciel: sterowanie sesją.

extension SessionViewController {
  /// Przerwa w pisaniu przed zapisem (PWA: 300 ms).
  static let draftDebounce: Duration = .milliseconds(300)

  /// Po odtworzeniu tekstu przez `+Send`: po zabiciu apki półka sesji jest pusta, więc załączniki
  /// wracają z dysku; potem dysk dostaje stan pola (szkic zabrany z dysku nie przepada).
  func installDrafts() {
    if composer.attachments.isEmpty, !AttachmentShelf.shared.isLoading(sessionId) {
      let restored = drafts.restoreAttachments(for: sessionId)
      // Półka jest jedynym stanem paska: załączniki z dysku wracają jej operacją, pasek je rysuje.
      if !restored.isEmpty { AttachmentShelf.shared.restore(restored, for: sessionId) }
    }
    let edited = composer.onEdit
    composer.onEdit = { [weak self] in
      edited?()
      self?.draftMayHaveChanged()
    }
    let status = composer.onAttachmentStatus
    composer.onAttachmentStatus = { [weak self] text, isError in
      status?(text, isError)
      guard let self else { return }
      // Paczka idzie na półkę: wynik trafi do szkicu na dysku także po zamknięciu tego ekranu.
      if AttachmentShelf.shared.isLoading(self.sessionId) { self.drafts.persistAfterLoading(self.sessionId) }
      // Zdanie o załącznikach pada przy wczytaniu i zdjęciu z paska — pasek mógł się zmienić.
      self.draftMayHaveChanged()
    }
    persistDraftNow()
  }

  /// Pisanie, pasek i każdy render (pole zmienione nie pisaniem: wysyłka, odmowa, Esc). Odliczanie
  /// rusza od nowa tylko przy NOWYM stanie pola — render przy niezmienionym polu go nie odsuwa.
  func draftMayHaveChanged() {
    guard turnChrome.draftSchedule.changed(currentDraft) else { return }
    turnChrome.draftSave?.cancel()
    turnChrome.draftSave = Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.draftDebounce)
      guard !Task.isCancelled else { return }
      self?.persistDraftNow()
    }
  }

  /// Zapis od razu (wyjście z ekranu, tło, przejęcie mikrofonu, prompt oddany po przerwaniu).
  func persistDraftNow() {
    turnChrome.draftSave?.cancel()
    turnChrome.draftSave = nil
    // A changed field replaces the session's draft, so a failed send's text that waits for this screen joins it first.
    // An unchanged one writes nothing, and the text keeps waiting, with its reason, for the next opening.
    if turnChrome.draftSchedule.writes(currentDraft) { takeWaitingDraft() }
    let snapshot = currentDraft
    guard turnChrome.draftSchedule.persist(snapshot) else { return }
    drafts.persist(text: composer.text, attachments: composer.attachments, for: sessionId) { [weak self] in
      // Dysk stanu nie przyjął: nie jest zapisany — następny render, wyjście albo tło spróbują znowu.
      self?.turnChrome.draftSchedule.failed(snapshot)
    }
  }

  /// `persistDraftNow` that waits for the disk: the queue take-back frees its bubbles only once the field with the
  /// taken texts is on disk. `false`: the disk refused, and the state counts as unsaved, as after any refused write.
  /// The caller takes a failed send's waiting text into the field first (`takeWaitingDraft`), where it wants it.
  func persistDraftConfirmed() async -> Bool {
    turnChrome.draftSave?.cancel()
    turnChrome.draftSave = nil
    let snapshot = currentDraft
    _ = turnChrome.draftSchedule.persist(snapshot)
    let saved = await drafts.persistConfirmed(text: composer.text, attachments: composer.attachments, for: sessionId)
    if !saved { turnChrome.draftSchedule.failed(snapshot) }
    return saved
  }

  private var currentDraft: DraftSnapshot {
    DraftSnapshot(text: composer.text, attachments: composer.attachments.map(\.id))
  }
}
#endif
