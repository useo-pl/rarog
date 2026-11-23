#if os(iOS)
import GameController
import RarogCore
import UIKit

// Ślady diagnostyczne z ekranu sesji: kto trzyma klawiaturę po powrocie do apki (z iPada
// „nie piszę po Cmd+Tab" wygląda jak martwy klawisz). Ślad przerwania z czasem: `+Interrupt`.
// Rdzeń kontrolera woła `installDiagnostics` na końcu `viewDidLoad`. Właściciel: łączność.

/// Chwila zejścia apki w tło — jedna dla wszystkich ekranów sesji (apka ma jedną scenę).
@MainActor private var enteredBackgroundAt: Date?

extension SessionViewController {
  /// Obserwatorzy z selektorem: centrum zdejmuje ich samo razem z kontrolerem.
  func installDiagnostics() {
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(diagnosticsEnteredBackground), name: UIApplication.didEnterBackgroundNotification,
      object: nil)
    center.addObserver(
      self, selector: #selector(diagnosticsBecameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  @objc private func diagnosticsEnteredBackground() {
    enteredBackgroundAt = Date()
  }

  /// Powrót z tła (nie z centrum sterowania: bez zejścia w tło nie ma śladu). Ślad po chwili, gdy
  /// fokus się ułoży — liczy się to, gdzie trafi pierwszy klawisz, a nie stan w pół przywracania.
  @objc private func diagnosticsBecameActive() {
    guard let since = enteredBackgroundAt, view.window != nil else { return }
    enteredBackgroundAt = nil
    let away = Int(Date().timeIntervalSince(since).rounded())
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard let self, self.view.window != nil else { return }
      self.store.trace(DiagnosticsTrace.resume(
        awaySeconds: away, responder: self.keyboardResponder, hardwareKeyboard: GCKeyboard.coalesced != nil))
    }
  }

  private var keyboardResponder: DiagnosticsTrace.Responder {
    if composer.textView.isFirstResponder { return .field }
    if composer.isEditable { return .fieldUnfocused }
    return isFirstResponder ? .screen : .nobody
  }
}
#endif
