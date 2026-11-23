import Foundation
import IrohLib
import RarogTransport

/// Błędy IrohLib jako napisy i porażki tunelu.
enum IrohFailure {
  /// Treść błędu do `TunnelFailure`: komunikat Rusta dla `IrohError`, opis Swifta dla reszty.
  static func describe(_ error: any Error) -> String {
    if let failure = error as? TunnelFailure { return "\(failure)" }
    if let iroh = error as? IrohError { return iroh.message() }
    return String(describing: error)
  }

  /// Błąd operacji na strumieniu: przy zamkniętym połączeniu powód połączenia (z kodem drugiej strony), inaczej
  /// zamknięcie bez kodu z treścią błędu (np. reset strumienia przez serwer).
  static func stream(_ error: any Error, connection: Connection) -> TunnelFailure {
    if let reason = connection.closeReason() { return IrohCloseReason.failure(reason) }
    return .closed(code: nil, reason: describe(error))
  }
}

/// Powód zamknięcia połączenia z napisu `closed()` / `closeReason()` IrohLib.
enum IrohCloseReason {
  /// Kod aplikacji drugiej strony, gdy połączenie zamknęła ona przez `close(errorCode:reason:)`; inaczej `nil`
  /// (zamknięcie lokalne, limit bezczynności, utrata drogi).
  static func failure(_ text: String) -> TunnelFailure {
    .closed(code: peerCode(text), reason: text)
  }

  /// Napis zamknięcia przez drugą stronę: `closed by peer: <kod>` albo `closed by peer: <powód> (code <kod>)`.
  static func peerCode(_ text: String) -> UInt64? {
    let prefix = "closed by peer: "
    guard let start = text.range(of: prefix)?.upperBound else { return nil }
    let rest = text[start...]
    if let code = UInt64(rest) { return code }
    guard rest.hasSuffix(")"), let open = rest.range(of: " (code ", options: .backwards) else { return nil }
    return UInt64(rest[open.upperBound..<rest.index(before: rest.endIndex)])
  }
}
