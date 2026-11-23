import Foundation

// Stałe transportu iroh wspólne z serwerem — lustro `shared/src/iroh.ts` co do bajtu. Zgodność pilnuje
// `IrohWireTests`, który czyta plik TS z repo.

/// Stałe transportu iroh: ALPN połączenia i `Origin` mutacji.
public enum IrohWire {
  /// ALPN protokołu (`IROH_ALPN`): HTTP/1.1 w strumieniu dwukierunkowym QUIC. Inny ALPN serwer odrzuca.
  public static let alpn = "rarog-http/1"
  /// ``alpn`` jako bajty dla `connect`.
  public static let alpnBytes = Data(alpn.utf8)
  /// `Origin` mutacji po iroh (`IROH_ORIGIN`). Domena `.invalid` nie rozwiązuje się nigdzie, więc nie udaje żadnej
  /// strony i nie zderza się z adresem z listy `Origin` serwera.
  public static let origin = "https://iroh.rarog.invalid"
}
