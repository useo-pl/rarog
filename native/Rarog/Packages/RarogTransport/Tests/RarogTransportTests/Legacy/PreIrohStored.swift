import Foundation
import RarogContract

// Zamrożony dekoder wpisu prywatnego Keychaina apki sprzed pola `iroh`.
// `PreIrohDecoderTests` dowodzi nim, że build wydany bez pola `iroh` czyta wpis zapisany nowszym buildem: ten sam klucz
// urządzenia, klucz push i konto, więc powrót do starszej wersji apki („Previous Builds” w TestFlight) nie kasuje
// parowania.
//
// Zasady kopii (wzór: `RarogContractTests/Legacy/LegacyContract.swift`):
// - `PreIrohDeviceCredential.init(from:)` i `account(for:)` to dosłowna kopia `DeviceCredential` sprzed pola `iroh`,
//   `PreIrohStored` — kopia `SystemKeychain.Stored`, a `PreIrohStored.read` — warunek odczytu z `SystemKeychain.readPrivate`
//   (dekoder i `version == 1`). Kopii NIE poprawia się razem ze źródłami: każda zmiana wpisu ma przejść
//   przez ten stary kod.
// - Kodowania kopia nie ma: zamrożony jest odczyt, zapis sprawdza się na wyjściu bieżącego kodera.
// - Współdzielone ze źródłami (pole `iroh` ich nie zmienia, więc kopia byłaby tym samym kodem): reguła
//   `KeyedDecodingContainer.storedServerSystem(forKey:)` i wyliczenie `ServerSystem` z RarogContract. Gdy któreś
//   dostanie zmianę, jego stara wersja trafia tu jako kopia w tym samym commicie.

/// `DeviceCredential` sprzed pola `iroh`: `serverURL` wymagany, nieznane klucze pominięte.
struct PreIrohDeviceCredential: Decodable, Equatable {
  var deviceId: String
  var secret: String
  var serverURL: URL
  var serverId: String
  var serverName: String
  var label: String
  var kid: String
  var pairedAt: Date
  var serverSystem: ServerSystem?

  enum CodingKeys: String, CodingKey {
    case deviceId, secret, serverURL, serverId, serverName, label, kid, pairedAt, serverSystem
  }

  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    deviceId = try c.decode(String.self, forKey: .deviceId)
    secret = try c.decode(String.self, forKey: .secret)
    serverURL = try c.decode(URL.self, forKey: .serverURL)
    serverId = try c.decode(String.self, forKey: .serverId)
    serverName = try c.decode(String.self, forKey: .serverName)
    label = try c.decode(String.self, forKey: .label)
    kid = try c.decode(String.self, forKey: .kid)
    pairedAt = try c.decode(Date.self, forKey: .pairedAt)
    serverSystem = c.storedServerSystem(forKey: .serverSystem)
  }

  /// Konto wpisu w Keychainie: host (z portem, gdy nie domyślny) małymi literami.
  var account: String { Self.account(for: serverURL) }

  static func account(for url: URL) -> String {
    let host = url.host(percentEncoded: false)?.lowercased() ?? ""
    return url.port.map { "\(host):\($0)" } ?? host
  }
}

/// `SystemKeychain.Stored` sprzed pola `iroh`.
struct PreIrohStored: Decodable {
  var version = 1
  var credential: PreIrohDeviceCredential
  var pushKey: String

  /// Odczyt wpisu tak jak `SystemKeychain.readPrivate`: `nil` = wpis nieczytelny, który `load()` buildu sprzed pola `iroh`
  /// kasuje razem z kluczem push (ponowne parowanie).
  static func read(_ data: Data) -> PreIrohStored? {
    guard let stored = try? JSONDecoder().decode(PreIrohStored.self, from: data), stored.version == 1 else { return nil }
    return stored
  }
}
