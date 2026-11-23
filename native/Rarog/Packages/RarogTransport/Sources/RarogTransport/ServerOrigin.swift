import Foundation

/// Tożsamość serwera po adresie — JEDNA postać dla wszystkiego, co pyta „czy to ten sam serwer”: przestrzeń danych
/// apki (`ServerSpaces` w rdzeniu). Schemat i host małymi literami, port efektywny (443 dla `https`, 80 dla `http`,
/// gdy adres go nie podaje), bez ścieżki, zapytania i ukośnika: `https://RAROG.example:443/` i `https://rarog.example`
/// to ten sam serwer, a `http://` albo port niedomyślny — inny. Kodowanie: `scheme`, `host`, `port`.
public struct ServerOrigin: Sendable, Hashable, Codable, CustomStringConvertible {
  public let scheme: String
  public let host: String
  public let port: Int

  /// `nil` = adres bez hosta albo schemat inny niż `https`/`http`.
  public init?(_ url: URL) {
    guard let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
      let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty
    else { return nil }
    self.scheme = scheme
    self.host = host
    port = url.port ?? (scheme == "https" ? 443 : 80)
  }

  public var description: String { "\(scheme)://\(host):\(port)" }
}
