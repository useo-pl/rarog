#if os(iOS)
import RarogCore
import UIKit

// Dyktowanie w ekranie sesji: rdzeń kontrolera woła te funkcje po jednej linii
// (`viewDidLoad`, `render`, `viewDidDisappear`), most SwiftUI wpina nawigację (`SessionControllerHost`).
// Logika w `ComposerDictation`. Właściciel: dyktowanie.
extension SessionViewController {
  /// Mikrofon i wiersz stanu w polu wiadomości; po `buildComposer` (opakowuje jego `onSend`/`onEdit`).
  func buildVoice() {
    // Przejęcie mikrofonu i wyjście z ekranu zapisują pole tą samą drogą co reszta szkicu (`+Drafts`).
    dictation.install(in: composer, store: store) { [weak self] in self?.persistDraftNow() }
    buildVoiceAgent()
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
