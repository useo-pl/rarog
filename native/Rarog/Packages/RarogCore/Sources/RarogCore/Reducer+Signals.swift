import Foundation
import RarogContract

// Sygnał „inna sesja czegoś od Ciebie chce" — źródło dymka w apce. Właściciel: łączność.
//
// Rdzeń mówi, ŻE sesja weszła w stan, o którym warto powiedzieć; czy dymek stanie, rozstrzyga
// widok (tylko gdy człowiek ogląda INNĄ sesję — na liście dymek dublowałby kropkę). Reguły:
// tylko WEJŚCIE w stan (powtórzona ramka tego samego stanu nic nie daje),
// nigdy przy pierwszym poznaniu sesji (start z 17 panelami dałby lawinę), „skończył" tylko po realnej
// pracy. Sygnał rodzi się i przy ramce `state`, i przy `session-changed` — której by nie przyszła
// pierwsza, druga widzi już ten sam stan i milczy; czekanie na jedną z nich gubi dymek.

/// Ostatni sygnał o sesji. Nowy zastępuje stary: jeden dymek naraz, jeden sygnał na sesję.
public struct SessionSignal: Sendable, Equatable {
  /// Rodzaj zdarzenia — ten sam słownik co push (`@rarog/shared/notify-copy`).
  public enum Kind: Sendable, Equatable {
    case permission, question, error, limit, done
  }

  public let sessionId: String
  public let kind: Kind
  /// Numer kolejny: ta sama sesja prosząca drugi raz to NOWY sygnał (odświeża dymek i jego czas).
  public let serial: Int

  public init(sessionId: String, kind: Kind, serial: Int) {
    self.sessionId = sessionId
    self.kind = kind
    self.serial = serial
  }
}

extension AppState {
  /// Zapisuje sygnał, gdy przejście stanu `before → after` na niego zasługuje.
  mutating func noteSignal(before: SessionSummary?, after: SessionSummary) {
    guard let before, before.state != after.state, let kind = Self.signalKind(from: before.state, to: after.state) else {
      return
    }
    signal = SessionSignal(sessionId: after.id, kind: kind, serial: (signal?.serial ?? 0) + 1)
  }

  /// Stany, w których sesja CZEGOŚ CHCE albo właśnie skończyła realną pracę.
  static func signalKind(from before: SessionState, to after: SessionState) -> SessionSignal.Kind? {
    switch after {
    case .waitingPermission: .permission
    case .waitingQuestion: .question
    case .error: .error
    case .limitReached: .limit
    // Świeża sesja też startuje w `waiting-input` — „skończył" o pustej sesji byłby kłamstwem.
    case .waitingInput: before == .running || before == .starting ? .done : nil
    case .starting, .running, .interrupted, .resumable, .done, .unsupported: nil
    }
  }
}
