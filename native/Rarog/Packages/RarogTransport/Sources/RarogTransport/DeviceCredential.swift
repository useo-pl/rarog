import Foundation
import RarogContract

// Klucz urządzenia z parowania kodem. Serwer oddaje go RAZ w odpowiedzi
// `POST /api/pair`; apka trzyma go wyłącznie w Keychainie (`DeviceKeychain`) i dokłada do każdego żądania
// nagłówkiem `Authorization: Rarog-Device <deviceId>.<sekret>` (REST, SSE, upgrade WebSocketu terminala).
// Sekret nie trafia do logów: opis wartości go zakrywa, a `client.log` dostaje co najwyżej `deviceId`.

/// Poświadczenie urządzenia dla JEDNEGO serwera. Trasy do serwera: `serverURL` (adres HTTPS z linku parowania, bez
/// ścieżki) i `iroh` (EndpointId i relay serwera), co najmniej jedna. `serverId` — trwały identyfikator serwera
/// z odpowiedzi parowania (zmiana adresu tego samego serwera go nie zmienia; inny `serverId` = inny serwer i inne dane
/// apki).
public struct DeviceCredential: Sendable, Equatable, Codable {
  public var deviceId: String
  public var secret: String
  /// Adres HTTPS serwera; `nil` = serwer osiągalny tylko przez iroh.
  public var serverURL: URL?
  public var serverId: String
  /// Nazwa serwera z parowania (host Maca bez `.local`) — tylko do wyświetlenia.
  public var serverName: String
  /// Etykieta, pod którą urządzenie się sparowało (`iPhone·Rarog`).
  public var label: String
  /// `kid` klucza push — wybór klucza do odszyfrowania banera.
  public var kid: String
  public var pairedAt: Date
  /// Ostatni znany system maszyny serwera z sondy `GET /api/version`: z niego słowo „Mac” albo „VPS”
  /// (``ServerMachine``) przy zimnym starcie i bez sieci, zanim sonda odpowie. `nil` = jeszcze nie wiadomo (świeże
  /// parowanie, zapis sprzed pola, serwer sprzed pola `system`). Zapisuje go `RarogStore` po sondzie.
  public var serverSystem: ServerSystem?
  /// Serwer iroh po walidacji (``ServerIrohConfig/init(validating:relay:)``); `nil` = serwer bez iroh albo para
  /// w zapisie zła (wtedy ``ignoredIroh``).
  public var iroh: ServerIrohConfig?
  /// Powód, dla którego odczyt pominął pole `iroh` zapisu (zły EndpointId, relay albo kształt) — do `client.log`, bez
  /// wartości pola. Tylko z dekodera; nie trafia do zapisu, więc następny zapis wpisu zepsutej pary już nie niesie.
  public internal(set) var ignoredIroh: String?

  public init(
    deviceId: String, secret: String, serverURL: URL?, serverId: String, serverName: String, label: String,
    kid: String, pairedAt: Date, serverSystem: ServerSystem? = nil, iroh: ServerIrohConfig? = nil
  ) {
    self.deviceId = deviceId
    self.secret = secret
    self.serverURL = serverURL
    self.serverId = serverId
    self.serverName = serverName
    self.label = label
    self.kid = kid
    self.pairedAt = pairedAt
    self.serverSystem = serverSystem
    self.iroh = iroh
  }

  enum CodingKeys: String, CodingKey {
    case deviceId, secret, serverURL, serverId, serverName, label, kid, pairedAt, serverSystem, iroh
  }

  /// Zapis sprzed pola `serverSystem`, zepsute i nieznane pole systemu dekodują się dalej
  /// (``Swift/KeyedDecodingContainer/storedServerSystem(forKey:)``): nieczytelny wpis Keychain kasuje, a z nim
  /// parowanie. Tak samo zła para `iroh` przy adresie HTTPS: wpis zostaje, para wypada (``ignoredIroh``). Bez adresu
  /// i bez poprawnej pary wpis jest nieczytelny.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    deviceId = try c.decode(String.self, forKey: .deviceId)
    secret = try c.decode(String.self, forKey: .secret)
    serverURL = try c.decodeIfPresent(URL.self, forKey: .serverURL)
    serverId = try c.decode(String.self, forKey: .serverId)
    serverName = try c.decode(String.self, forKey: .serverName)
    label = try c.decode(String.self, forKey: .label)
    kid = try c.decode(String.self, forKey: .kid)
    pairedAt = try c.decode(Date.self, forKey: .pairedAt)
    serverSystem = c.storedServerSystem(forKey: .serverSystem)
    (iroh, ignoredIroh) = c.storedIroh(forKey: .iroh)
    guard hasRoute else {
      throw DecodingError.dataCorruptedError(
        forKey: .serverURL, in: c, debugDescription: "credential without an HTTPS address and without a valid iroh pair")
    }
  }

  /// Poświadczenie z odpowiedzi `POST /api/pair`: adres z linku (`nil` przy linku bez `u`) i para iroh po walidacji.
  public init(pair response: PairResponse, serverURL: URL?, iroh: ServerIrohConfig? = nil, label: String, pairedAt: Date) {
    self.init(
      deviceId: response.deviceId, secret: response.secret, serverURL: serverURL, serverId: response.server.id,
      serverName: response.server.name, label: label, kid: response.kid, pairedAt: pairedAt, iroh: iroh)
  }

  /// Schemat nagłówka — nazwany, żeby wariant z podpisem (`Rarog-Sig`) mógł stanąć obok.
  public static let scheme = "Rarog-Device"

  /// Wartość nagłówka `Authorization`.
  public var authorization: String { "\(Self.scheme) \(deviceId).\(secret)" }

  /// Czy jest choć jedna trasa, którą przeczyta dekoder. Bez niej wpis jest nieczytelny, więc `save` go nie zapisuje:
  /// para iroh liczy się dopiero po tej samej walidacji co przy odczycie (`ServerIrohConfig(validating:relay:)`), bo
  /// zapisana para ze złym EndpointId albo relayem dałaby przy odczycie wpis bez trasy, a ten odczyt kasuje.
  var hasRoute: Bool {
    if serverURL != nil { return true }
    guard let iroh else { return false }
    return ServerIrohConfig(validating: iroh.endpointId, relay: iroh.relay.absoluteString) != nil
  }

  /// Konto wpisu w Keychainie: host (z portem, gdy nie domyślny) małymi literami, gdy jest adres HTTPS, inaczej
  /// `iroh:<EndpointId>`.
  public var account: String {
    if let serverURL { return Self.account(for: serverURL) }
    return iroh.map { Self.irohAccountPrefix + $0.endpointId } ?? ""
  }

  static let irohAccountPrefix = "iroh:"

  public static func account(for url: URL) -> String {
    let host = url.host(percentEncoded: false)?.lowercased() ?? ""
    return url.port.map { "\(host):\($0)" } ?? host
  }
}

extension ServerIrohConfig {
  /// Para iroh z linku, odpowiedzi serwera albo zapisu po walidacji: EndpointId jak ``PairingLinkWire/isEndpointId(_:)``,
  /// relay w postaci kanonicznej ``PairingLinkWire/relayURL(_:)``. `nil` = para zła.
  public init?(validating endpointId: String, relay: String) {
    guard PairingLinkWire.isEndpointId(endpointId), let canonical = PairingLinkWire.relayURL(relay),
      let url = URL(string: canonical)
    else { return nil }
    self.init(endpointId: endpointId, relay: url)
  }
}

/// Pole `iroh` zapisu przed walidacją.
private struct StoredIroh: Decodable {
  let endpointId: String
  let relay: String
}

extension KeyedDecodingContainer {
  /// Pole `iroh` zapisu: para po walidacji albo powód pominięcia. Brak pola i `null` to brak pary bez powodu.
  func storedIroh(forKey key: Key) -> (ServerIrohConfig?, String?) {
    guard contains(key), (try? decodeNil(forKey: key)) == false else { return (nil, nil) }
    guard let raw = try? decode(StoredIroh.self, forKey: key) else { return (nil, "field shape") }
    guard PairingLinkWire.isEndpointId(raw.endpointId) else { return (nil, "bad EndpointId") }
    guard let config = ServerIrohConfig(validating: raw.endpointId, relay: raw.relay) else { return (nil, "bad relay") }
    return (config, nil)
  }
}

extension DeviceCredential: CustomStringConvertible, CustomDebugStringConvertible {
  /// Bez sekretu: wartość trafia czasem do opisu błędu albo asercji testu.
  public var description: String {
    "DeviceCredential(\(deviceId) @ \(account), serwer \(serverId))"
  }

  public var debugDescription: String { description }
}

/// Odmowa klucza urządzenia z ostatniego 401 — magazyn wybiera po niej ekran: odpięte (trwały ekran z datą
/// i przyczyną, klucz kasowany) albo nieznane (klucz zostaje: serwer mógł zgubić `devices.json`).
public enum CredentialRejection: Sendable, Equatable {
  /// 401 `device-revoked`: `revokedAt` (ISO z serwera) i `revokedBy` (`admin`, `forget`, `expired` albo `deviceId`).
  case revoked(deviceId: String, revokedAt: String, revokedBy: String)
  /// 401 bez `device-revoked` (`device-unknown` albo inny kod).
  case unknown(deviceId: String)

  public var deviceId: String {
    switch self {
    case let .revoked(deviceId, _, _), let .unknown(deviceId): deviceId
    }
  }
}
