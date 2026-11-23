#if os(iOS)
import UIKit

// Kopiowanie z transkryptu po stronie ekranu sesji: powrót fokusu do pola po kopii zaznaczenia kursorem.
// Właściciel: transkrypt, markdown.
extension SessionViewController: TranscriptCopyFocusReturning {
  /// Po kopii zaznaczenia kursorem: fokus do pola wiadomości, żeby od razu pisać.
  @objc func rarogFocusComposerAfterCopy(_ sender: Any?) {
    guard composer.isEditable, view.window != nil else { return }
    composer.textView.becomeFirstResponder()
  }
}
#endif
