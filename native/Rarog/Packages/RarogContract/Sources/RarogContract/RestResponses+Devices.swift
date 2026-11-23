// Klucze urządzeń i parowanie kodem — lustro schematów `pairResponseSchema` (z `serverIrohSchema`),
// `pairingIssuedSchema`, `deviceListSchema`, `deviceMeSchema` i `deviceRevokedBodySchema` z `shared/src/rest.ts`. Ta sama tolerancja co
// reszta REST: nieznane klucze odcięte, `null` tylko tam, gdzie kontrakt go zna. Złote odpowiedzi:
// `shared/fixtures/rest/pair.json`, `pairings.json`, `devices.json`, `devices.me.json`, `error.device-*.json`.
// Apka używa ich przy parowaniu i w Keychainie; tu tylko kontrakt.

/// Serwer iroh (`serverIrohSchema`): EndpointId i relay — te same wartości co `k=` i `r=` linku parowania
/// (``PairingLinkWire``). Niesie go `iroh` w ``PairServer`` i ``VersionInfo``. Dekoder sprawdza tylko kształt
/// (dwa niepuste łańcuchy), jak `deviceId`: postać sprawdza użycie (``PairingLinkWire/isEndpointId(_:)``,
/// ``PairingLinkWire/relayURL(_:)``), więc zła wartość iroh nie zablokuje parowania ani startu przez HTTPS.
public struct ServerIroh: Sendable, Equatable, Decodable {
  public var endpointId: String
  public var relay: String

  enum CodingKeys: String, CodingKey { case endpointId, relay }

  public init(endpointId: String, relay: String) {
    self.endpointId = endpointId
    self.relay = relay
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    endpointId = try c.nonEmpty(.endpointId)
    relay = try c.nonEmpty(.relay)
  }
}

/// Serwer, z którym urządzenie się sparowało: trwały `serverId`, nazwa hosta, wersja, możliwości i serwer iroh.
public struct PairServer: Sendable, Equatable, Decodable {
  public var id: String
  public var name: String
  public var version: String
  public var capabilities: [String]
  /// Serwer iroh; `nil` = serwer bez nasłuchu iroh (`null`) albo sprzed pola (brak klucza).
  public var iroh: ServerIroh?

  enum CodingKeys: String, CodingKey { case id, name, version, capabilities, iroh }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.nonEmpty(.id)
    name = try c.required(.name)
    version = try c.required(.version)
    capabilities = try c.required(.capabilities)
    iroh = try c.optionalOrNull(.iroh)
  }
}

/// `POST /api/pair` (200) — wysyłana RAZ: `secret` (do nagłówka `Authorization: Rarog-Device <deviceId>.<secret>`)
/// i `pushKey` (szyfrowanie treści banerów) nie wrócą żadną inną trasą. `kid` = 8 znaków hex
/// `sha256(surowe bajty pushKey)`.
public struct PairResponse: Sendable, Equatable, Decodable {
  public var deviceId: String
  public var secret: String
  public var pushKey: String
  public var kid: String
  public var server: PairServer

  enum CodingKeys: String, CodingKey { case deviceId, secret, pushKey, kid, server }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    deviceId = try c.nonEmpty(.deviceId)
    secret = try c.nonEmpty(.secret)
    pushKey = try c.nonEmpty(.pushKey)
    kid = try c.nonEmpty(.kid)
    server = try c.required(.server)
  }
}

/// `POST /api/pairings` (200) — kod dla NOWEGO urządzenia, wydany na tym. `expiresAt` to termin z zegara
/// serwera (ISO): apka odlicza do niego, nie od chwili odebrania odpowiedzi.
public struct PairingIssued: Sendable, Equatable, Decodable {
  public var code: String
  public var expiresAt: String

  enum CodingKeys: String, CodingKey { case code, expiresAt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    code = try c.nonEmpty(.code)
    expiresAt = try c.nonEmpty(.expiresAt)
  }
}

/// Urządzenie na liście (`GET /api/devices`, `GET /api/devices/me`). `creator` = `admin` (kod z Maca) albo
/// `deviceId` urządzenia, które wydało kod; `lastSeenAt` = `nil`, gdy urządzenie nie zrobiło jeszcze żadnego
/// żądania (pole wymagane, `null` to wartość); `current` = to urządzenie pyta.
public struct DeviceInfo: Sendable, Equatable, Decodable {
  public var id: String
  public var label: String
  public var createdAt: String
  public var lastSeenAt: String?
  public var creator: String
  public var build: String?
  public var current: Bool

  enum CodingKeys: String, CodingKey { case id, label, createdAt, lastSeenAt, creator, build, current }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.nonEmpty(.id)
    label = try c.required(.label)
    createdAt = try c.nonEmpty(.createdAt)
    lastSeenAt = try c.nullable(.lastSeenAt)
    creator = try c.nonEmpty(.creator)
    build = try c.nullable(.build)
    current = try c.required(.current)
  }
}

/// `GET /api/devices` (200) — aktywne urządzenia serwera, od najstarszego.
public struct DeviceList: Sendable, Equatable, Decodable {
  public var devices: [DeviceInfo]

  enum CodingKeys: String, CodingKey { case devices }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    devices = try c.required(.devices)
  }
}

/// `GET /api/devices/me` (200) — rekord tego urządzenia i trwały `serverId`.
public struct DeviceMe: Sendable, Equatable, Decodable {
  public var device: DeviceInfo
  public var serverId: String

  enum CodingKeys: String, CodingKey { case device, serverId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    device = try c.required(.device)
    serverId = try c.nonEmpty(.serverId)
  }
}

/// 401 `device-revoked` — urządzenie odpięto (`revokedAt` ISO). `revokedBy`: `admin` (CLI na Macu), `forget`
/// („Zapomnij serwer”), `expired` (30 dni bez użycia) albo identyfikator urządzenia — łańcuch, nie wyliczenie,
/// żeby nowa przyczyna po stronie serwera nie zepsuła odczytu odmowy. `message` to angielskie zdanie serwera,
/// `messageRef` — jego kod zdania do tłumaczenia (``translate(_:)``).
public struct DeviceRevokedBody: Sendable, Equatable, Codable, SentenceBearing {
  public var error: String
  public var message: String
  public var revokedAt: String
  public var revokedBy: String
  public var messageRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case error, message, revokedAt, revokedBy, messageRef }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    error = try c.required(.error)
    guard error == "device-revoked" else {
      throw contractViolation(c.codingPath + [CodingKeys.error], "error musi być device-revoked")
    }
    message = try c.required(.message)
    revokedAt = try c.nonEmpty(.revokedAt)
    revokedBy = try c.nonEmpty(.revokedBy)
    messageRef = try c.optional(.messageRef)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(error, forKey: .error)
    try c.encode(message, forKey: .message)
    try c.encode(revokedAt, forKey: .revokedAt)
    try c.encode(revokedBy, forKey: .revokedBy)
    try c.encodeIfPresent(messageRef, forKey: .messageRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    message = render(message, messageRef)
  }
}
