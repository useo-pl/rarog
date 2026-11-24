#if os(iOS)
import RarogCore
import UIKit

// Dyktowanie w ekranie sesji: rdzeń kontrolera woła te funkcje po jednej linii
// (`viewDidLoad`, `render`, `viewDidDisappear`), most SwiftUI wpina nawigację (`SessionControllerHost`).
// Logika w `ComposerDictation`. Właściciel: dyktowanie.
extension SessionViewController {
  /// Mikrofon i wiersz stanu w polu wiadomości; po `buildComposer` (opakowuje jego `onSend`/`onEdit`).
  func buildVoice() {
    // Every end of a recording, a takeover of the microphone and leaving the screen write the field the same way as
    // the rest of the draft (`+Drafts`); an end in the background waits (`dictationEndWait`) before its background
    // work ends.
    dictation.install(
      in: composer, store: store, sessionId: sessionId, persistDraft: { [weak self] in self?.persistDraftNow() },
      draftOnDisk: dictationEndWait())
    buildVoiceAgent()
  }

  /// What the background work of a recording's end waits for. A Send that end woke has its answer: the message is
  /// stored in the queue, or its text is back in the field and goes to the draft. Then the disk ran the draft write.
  /// The wait holds the send and the draft store, not this screen: it stands also when the screen went with the
  /// recording.
  func dictationEndWait() -> @MainActor () async -> Void {
    { [weak self, turnChrome, drafts] in
      if let send = turnChrome.fieldSend {
        _ = await send.value
        self?.persistDraftNow()
      }
      await drafts.written()
    }
  }

  /// Ekran „Dyktowanie” jako arkusz, gdy trasa dyktowania pyta (brak wyboru, Soniox niedostępny).
  func installVoice(navigation: RarogNavigation) {
    dictation.onAsk = { [weak navigation] in navigation?.openDictation() }
  }

  /// Po `renderComposer` — mikrofon przy każdym polu, które przyjmuje tekst; trasę bierze stuknięcie.
  func renderVoice(_ state: AppState) {
    dictation.render(editable: composer.isEditable)
    renderVoiceAgent(state)
  }

  /// Ekran zniknął (inna sesja, wylogowanie, lista): nagranie kończy się, tekst zostaje w szkicu.
  /// The voice conversation ends too.
  func leaveVoice() {
    dictation.leave()
    leaveVoiceAgent()
  }
}
#endif
