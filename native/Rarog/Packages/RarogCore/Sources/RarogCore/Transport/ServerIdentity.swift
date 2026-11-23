import Foundation
import RarogContract
import RarogTransport

// Tożsamość serwera dla przestrzeni danych apki: po niej `RarogStore+Spaces` rozstrzyga „czy klucz
// należy do serwera ze wskaźnika”, a `ServerSpaces` liczy z niej nazwę katalogu. Serwer z adresem HTTPS to jego
// `ServerOrigin` (wskaźnik zapisany przez starszy build daje więc tę samą przestrzeń), serwer
// osiągalny wyłącznie przez iroh to jego EndpointId. Zapis we wskaźniku: napis `description`.

/// Kto jest serwerem przestrzeni: adres (`.origin`), gdy poświadczenie ma `serverURL`, inaczej EndpointId iroh.
public enum ServerIdentity: Sendable, Hashable, CustomStringConvertible {
  case origin(ServerOrigin)
  /// EndpointId iroh: 64 znaki hex małymi literami (`PairingLinkWire.isEndpointId`).
  case iroh(endpointId: String)

  static let irohPrefix = "iroh:"

  /// Tożsamość z poświadczenia: adres serwera, a bez adresu EndpointId iroh. `nil` = adres bez hosta albo ze
  /// schematem innym niż `https`/`http` (bez sięgania po iroh: przestrzeń idzie za adresem, gdy ten jest) albo
  /// poświadczenie bez obu tras.
  public init?(_ credential: DeviceCredential) {
    if let url = credential.serverURL {
      guard let origin = ServerOrigin(url) else { return nil }
      self = .origin(origin)
    } else if let iroh = credential.iroh {
      self = .iroh(endpointId: iroh.endpointId)
    } else {
      return nil
    }
  }

  /// Odczyt napisu ``description``, wyłącznie w postaci kanonicznej: `iroh:` z poprawnym EndpointId albo adres
  /// równy opisowi swojego `ServerOrigin` (`https://host:443`). Inny napis = `nil`.
  public init?(description text: String) {
    if text.hasPrefix(Self.irohPrefix) {
      let endpointId = String(text.dropFirst(Self.irohPrefix.count))
      guard PairingLinkWire.isEndpointId(endpointId) else { return nil }
      self = .iroh(endpointId: endpointId)
      return
    }
    guard let origin = Self.canonicalOrigin(text) else { return nil }
    self = .origin(origin)
  }

  /// Napis tożsamości: `scheme://host:port` (jak `ServerOrigin`) albo `iroh:<64 hex>`.
  public var description: String {
    switch self {
    case let .origin(origin): origin.description
    case let .iroh(endpointId): Self.irohPrefix + endpointId
    }
  }

  /// Adres z napisu, gdy napis to dokładnie opis tego adresu. Host IPv6 `ServerOrigin` opisuje bez nawiasów, więc
  /// druga próba dokłada nawiasy przed portem.
  private static func canonicalOrigin(_ text: String) -> ServerOrigin? {
    var candidates = [text]
    if let separator = text.range(of: "://"), let colon = text.lastIndex(of: ":"), colon > separator.upperBound {
      let host = text[separator.upperBound..<colon]
      if host.contains(":") { candidates.append("\(text[..<separator.upperBound])[\(host)]\(text[colon...])") }
    }
    for candidate in candidates {
      if let url = URL(string: candidate), let origin = ServerOrigin(url), origin.description == text { return origin }
    }
    return nil
  }
}
