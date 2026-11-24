import Foundation
import RarogContract
import RarogCore

// A turn interrupt on screen: what the line under the field says, what VoiceOver hears and what the field gets
// (only the prompt Claude Code handed back); when Esc belongs to the interrupt. Rules tested on macOS. Owner: session control.

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
  /// The field after the interrupt; `nil` = untouched. Only the prompt Claude Code handed back to its own field
  /// comes in, so the app's field ends as the terminal's does, never with a copy of a queued text the CLI runs next.
  public let field: String?
  /// UTF-16 units the text typed in the field moved right (the handed-back prompt stands before it), so the cursor
  /// can move with it; `nil` = the field was empty or untouched.
  public let keptTextShift: Int?

  public init(line: String?, isError: Bool, spoken: String, field: String? = nil, keptTextShift: Int? = nil) {
    self.line = line
    self.isError = isError
    self.spoken = spoken
    self.field = field
    self.keptTextShift = keptTextShift
  }

  /// A handed-back prompt placed against a text that stands: the message field, or the session's stored draft when no
  /// screen of the session lives (`ComposerDrafts.saveReturnedPrompt`).
  public struct Placed: Sendable, Equatable {
    public let text: String
    /// UTF-16 units the standing text moved right (`NSString`, `UITextView.selectedRange`); `nil` = it was blank and
    /// the prompt took its place.
    public let keptTextShift: Int?
  }

  /// One rule for the field and the stored draft. A blank text gives way to the prompt. Any other text stays, with the
  /// prompt on its own line before it, the order the queue take-back uses, because the next send clears the CLI's
  /// field and the prompt would be lost.
  public static func place(_ prompt: String, before kept: String) -> Placed {
    guard !kept.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return Placed(text: prompt, keptTextShift: nil)
    }
    let block = "\(prompt)\n"
    return Placed(text: block + kept, keptTextShift: (block as NSString).length)
  }

  /// `field` is the text in the message field when the answer arrived.
  ///
  /// Returns `nil` when the gesture sent nothing (the gesture gate, nothing to interrupt, logout): nothing changes on
  /// screen, because "interrupting" stands in the activity row from the first gesture.
  public static func make(_ outcome: InterruptOutcome, field: String, machine: ServerMachine) -> InterruptPresentation? {
    switch outcome {
    case let .delivered(returnedPrompt):
      guard let prompt = returnedPrompt else {
        return InterruptPresentation(line: nil, isError: false, spoken: UICopy.interrupted)
      }
      let placed = place(prompt, before: field)
      return InterruptPresentation(
        line: nil, isError: false, spoken: UICopy.interruptedRestored, field: placed.text,
        keptTextShift: placed.keptTextShift)
    case .notDelivered:
      let failed = UICopy.interruptFailed(machine)
      return InterruptPresentation(line: failed, isError: true, spoken: failed)
    case .unsure:
      return InterruptPresentation(line: UICopy.interruptUnsure, isError: false, spoken: UICopy.interruptUnsure)
    case let .refused(message):
      // Zdanie serwera nazywa konkretną zaporę — lepsze od ogólnego.
      let text = message.flatMap { $0.isEmpty ? nil : $0 } ?? UICopy.interruptGate
      return InterruptPresentation(line: text, isError: true, spoken: text)
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
