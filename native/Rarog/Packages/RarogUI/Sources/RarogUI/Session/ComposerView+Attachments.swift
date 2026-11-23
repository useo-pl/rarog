#if os(iOS)
import RarogContract
import RarogCore
import UIKit

// Attachments of the message field: the strip bound to the session shelf, intake from the paper
// clip, the pasteboard and drag and drop, removal and the paper clip menu. Split out of `ComposerView.swift` without
// a change of behavior. Owner: send.
extension ComposerView {
  /// Wiąże pasek z półką sesji: pasek rysuje półkę przy otwarciu i po każdej jej zmianie (także
  /// przywróceniu nieudanej wysyłki z ekranu, którego już nie ma), wynik wczytywania (także paczki
  /// zaczętej na poprzednim ekranie tej sesji) przychodzi z półki.
  func bind(to shelf: AttachmentShelf, sessionId: String) {
    self.shelf = shelf
    self.sessionId = sessionId
    shelf.observe(sessionId) { [weak self] result in self?.attachmentsLoaded(result) }
    shelf.watch(sessionId) { [weak self] in self?.showShelf() }
    showShelf()
  }

  /// „Wyślij": wysłane schodzą z półki; dołożone w międzyczasie zostają. Pliki zostają — sprząta je
  /// ten, kto wie, czy wiadomość poszła (ekran sesji).
  func removeSent(_ sent: [ComposerAttachment]) {
    shelf?.remove(Set(sent.map(\.id)), for: sessionId)
    showShelf()
  }

  /// Odmowa przy żywym ekranie: nieudane wracają na początek paska, dołożone w trakcie zostają.
  func restoreAttachments(_ failed: [ComposerAttachment]) {
    shelf?.restore(failed, for: sessionId)
    showShelf()
  }

  /// Rysuje pasek ze stanu półki. Tylko odczyt: zmiany człowieka idą operacjami półki, więc pasek
  /// nigdy nie nadpisze półki swoją, starszą kopią.
  private func showShelf() {
    attachments = AttachmentCounts.ordered(shelf?.attachments(for: sessionId) ?? [])
    strip.update(attachments)
    let visible = !attachments.isEmpty
    if strip.isHidden == visible {
      strip.isHidden = !visible
      textTopToActivity.isActive = !visible
      textTopToStrip.isActive = visible
    }
    contentChanged()
  }

  /// Wspólna droga spinacza, schowka i przeciągania: limity, przygotowanie, zdanie pod polem.
  /// Wczytuje półka sesji — wynik przeżywa zamknięcie ekranu.
  func ingest(_ candidates: [AttachmentCandidate]) {
    guard !candidates.isEmpty, let shelf else { return }
    guard isEditable else {
      announceStatus(UICopy.attachmentsNotAccepted, isError: false)
      return
    }
    guard shelf.ingest(candidates, for: sessionId) else {
      // Ciche zignorowanie drugiej paczki byłoby najgorsze: widać, że nic się nie stało, i nie wiadomo czemu.
      announceStatus(UICopy.attachmentsBusy, isError: false)
      return
    }
    // Bez zdania „Wczytuję…": przy wklejce zdjęcia mignęłoby pod polem na ułamek
    // sekundy. Pusty status gasi poprzednie zdanie (odrzucenie, „Chwila…") i budzi zapis szkicu po wczytaniu
    // (`+Drafts`). Wysyłka w trakcie wczytywania dalej mówi „Chwila — wczytuję załączniki.".
    onAttachmentStatus?(nil, false)
    // Wczytywana paczka to już wpis: przycisk wraca do „Wyślij", zanim pasek ją pokaże.
    contentChanged()
  }

  /// Koniec wczytywania: półka ma już wynik, pasek go pokazuje; zdanie pod polem i czytnik.
  private func attachmentsLoaded(_ result: AttachmentIntake.Result) {
    showShelf()
    let problems = UICopy.attachmentRejections(result.rejections)
    onAttachmentStatus?(problems.isEmpty ? nil : problems.joined(separator: "\n"), !problems.isEmpty)
    let added = UICopy.attachmentsAdded(
      images: AttachmentCounts.images(result.added), files: AttachmentCounts.files(result.added))
    if let spoken = added ?? (problems.isEmpty ? nil : UICopy.list(problems, .sentence)) {
      Announcer.shared.say(spoken)
    }
  }

  func pasteAttachments(_ providers: [NSItemProvider]) -> Bool {
    let candidates = AttachmentSources.candidates(providers)
    guard !candidates.isEmpty else { return false }
    // Kursor zostaje w polu: wklejenie nie zmienia pierwszego respondera.
    ingest(candidates)
    return true
  }

  /// „×" na kafelku: fokus czytnika idzie na sąsiedni „×" albo spinacz, NIGDY do pola
  /// (na dotyku wysunęłaby się klawiatura, o którą nikt nie prosił).
  func removeAttachment(_ id: UUID) {
    guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
    let removed = attachments[index]
    shelf?.remove([id], for: sessionId)
    showShelf()
    AttachmentStaging.discard([removed])
    onAttachmentStatus?(nil, false)
    let buttons = strip.removeButtons
    let neighbour: UIView = buttons.isEmpty ? actionBar.attachButton : buttons[min(index, buttons.count - 1)]
    UIAccessibility.post(notification: .layoutChanged, argument: neighbour)
    Announcer.shared.say(UICopy.attachmentRemoved(removed.kind, remaining: attachments))
  }

  private func announceStatus(_ text: String, isError: Bool) {
    onAttachmentStatus?(text, isError)
    Announcer.shared.say(text)
  }

  /// Menu spinacza budowane przy każdym otwarciu: „Zdjęcia" z limitem tego, co jeszcze się mieści.
  func attachMenu() -> UIMenu {
    UIMenu(children: [
      UIDeferredMenuElement.uncached { [weak self] completion in
        guard let self else { return completion([]) }
        let room = AttachmentLimits.maxImages - AttachmentCounts.images(self.attachments)
        let photos = UIAction(title: UICopy.attachPhotos, image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in
          self?.sources.presentPhotos(limit: room)
        }
        photos.accessibilityIdentifier = "composer.attach.photos"
        let files = UIAction(title: UICopy.attachFiles, image: UIImage(systemName: "folder")) { [weak self] _ in
          self?.sources.presentFiles()
        }
        files.accessibilityIdentifier = "composer.attach.files"
        completion([photos, files])
      },
    ])
  }
}
#endif
