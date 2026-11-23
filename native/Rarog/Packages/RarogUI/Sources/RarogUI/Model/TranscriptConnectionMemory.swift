import Foundation
import RarogCore

/// Pamięć baneru transkryptu w prawej kolumnie. Awaria dotyczy jednego źródła,
/// więc zmiana sesji zaczyna nową próbę zamiast przenosić komunikat z poprzedniego ekranu.
public struct TranscriptConnectionMemory: Sendable, Equatable {
  public private(set) var connection = ConnectionMemory()
  public private(set) var sessionId: String?

  public init() {}

  /// Zmiana sesji tylko zeruje pamięć: status z tej chwili należy jeszcze do strumienia poprzedniej
  /// sesji (magazyn startuje nowy strumień asynchronicznie). Własne statusy nowej sesji przychodzą
  /// potem zmianą `sessionStream` z tym samym `sessionId`.
  public mutating func observe(_ status: ConnectionStatus, sessionId: String?, now: Date) {
    guard self.sessionId == sessionId else {
      self.sessionId = sessionId
      connection = ConnectionMemory()
      return
    }
    guard sessionId != nil else {
      connection = ConnectionMemory()
      return
    }
    connection.observe(status, now: now)
  }

  /// Pierwszy render nowego wyboru poprzedza callback SwiftUI: nie pokazuje jeszcze pamięci A.
  public func connection(for sessionId: String?) -> ConnectionMemory {
    self.sessionId == sessionId ? connection : ConnectionMemory()
  }
}
