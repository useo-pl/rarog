import Foundation
import RarogContract
import RarogCore

// Przerwanie tury na ekranie: co mówi linia pod polem, co słyszy czytnik i czy prompt
// wraca do pola; kiedy Esc należy do przerwania. Reguły
// testowane na macOS. Właściciel: sterowanie sesją.

/// Wynik przerwania na ekranie. Podział: transkrypt niesie SUKCES (pisze
/// go serwer, trwale i widocznie z drugiego urządzenia), linia pod polem — każde inne zakończenie.
public struct InterruptPresentation: Sendable, Equatable {
  /// Linia pod polem; `nil` = gaśnie (po udanym przerwaniu jedno zdarzenie zostawia ślad w jednym miejscu).
  public let line: String?
  /// Czerwień wyłącznie dla odmowy; „nie wiem" jest neutralne.
  public let isError: Bool
  /// Zdanie dla czytnika przy każdym zakończeniu — przy sukcesie linia gaśnie, więc mowa to jedyny
  /// natychmiastowy nośnik.
  public let spoken: String
  /// Prompt wraca do pola: wyłącznie po udanym przerwaniu i wyłącznie do PUSTEGO pola.
  public let restorePrompt: Bool

  /// `nil` = gest nic nie wysłał (bramka gestu, nie ma czego przerywać, wylogowanie) — bez zmiany
  /// na ekranie: „przerywa" stoi w wierszu aktywności od pierwszego gestu.
  public static func make(
    _ outcome: InterruptOutcome, prompt: String, fieldEmpty: Bool, machine: ServerMachine
  ) -> InterruptPresentation? {
    switch outcome {
    case .delivered:
      if prompt.isEmpty { return InterruptPresentation(line: nil, isError: false, spoken: UICopy.interrupted, restorePrompt: false) }
      if !fieldEmpty {
        // Pole zajęte to nie cisza: okno kolizji z pisaniem sięga czasu odpowiedzi.
        return InterruptPresentation(line: nil, isError: false, spoken: UICopy.interruptedTyping, restorePrompt: false)
      }
      return InterruptPresentation(line: nil, isError: false, spoken: UICopy.interruptedRestored, restorePrompt: true)
    case .notDelivered:
      let failed = UICopy.interruptFailed(machine)
      return InterruptPresentation(line: failed, isError: true, spoken: failed, restorePrompt: false)
    case .unsure:
      return InterruptPresentation(line: UICopy.interruptUnsure, isError: false, spoken: UICopy.interruptUnsure, restorePrompt: false)
    case let .refused(message):
      // Zdanie serwera nazywa konkretną zaporę — lepsze od ogólnego.
      let text = message.flatMap { $0.isEmpty ? nil : $0 } ?? UICopy.interruptGate
      return InterruptPresentation(line: text, isError: true, spoken: text, restorePrompt: false)
    case .inFlight, .notAllowed, .loggedOut:
      return nil
    }
  }
}

/// Czy Esc z klawiatury przerywa turę. Esc ma trzech właścicieli i ta reguła
/// rozdziela ich bez kolizji: karta z fokusem (Esc = „Odrzuć", obszar kart), otwarte okno (arkusz,
/// popover — Esc należy do okna, nigdy do tury pod nim) i składanie znaku w polu
/// (Esc należy do edytora). Dopiero potem tura — i tylko, gdy Stop działa. Esc tuż po zamknięciu prezentacji
/// Esc-em (`afterEscapeClose`, okno łaski ``EscapeGrace``) należy jeszcze do niej: dwa szybkie naciśnięcia
/// miały zamknąć okno, nie zamknąć okno i przerwać pracę. Tak samo przełącznik sesji
/// (`switcherAbsorbs`): przy jego otwartym oknie Esc tury NIE przerywa. Lista
/// podpowiedzi slash-komend nad polem (`suggestionsOpen`) też: Esc zamyka ją i nic więcej.
public enum EscapeInterruptRule {
  public static func allows(
    cardFocused: Bool, overlayPresented: Bool, composing: Bool, afterEscapeClose: Bool = false,
    switcherAbsorbs: Bool = false, suggestionsOpen: Bool = false, availability: InterruptAvailability
  ) -> Bool {
    guard !switcherAbsorbs, !cardFocused, !overlayPresented, !composing, !afterEscapeClose, !suggestionsOpen else {
      return false
    }
    return availability == .enabled
  }
}
