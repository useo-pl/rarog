import Foundation

// Kontrakt rejestru urządzeń relaya iroh `/v1/*` (Worker `relay-auth/`) — lustro `shared/src/relay-auth.ts`: te same
// trasy, te same reguły kształtu żądań apki (z tą samą kolejnością sprawdzeń i tym samym polem odrzucenia), ten sam
// tekst do podpisu Ed25519 co do bajtu i te same kody błędów. Zgodność obu stron pilnują przypadki
// `shared/fixtures/relay-auth/manifest.json` (`RelayAuthWireTests` i `shared/test/relay-auth.test.ts`).
// Podpisuje wołający (klucz iroh apki): ten typ daje tylko bajty do podpisu i ciało do wysłania.

/// Kontrakt rejestru relaya iroh: stałe, żądania apki, tekst do podpisu, odpowiedzi.
public enum RelayAuthWire {
  /// Wersja kontraktu w ciałach (`v`).
  public static let version = 1
  /// Pierwsza linia tekstu do podpisu (`RELAY_AUTH_SIGNING_DOMAIN`).
  public static let signingDomain = "rarog-relay-auth/v1"
  /// Nagłówek wersji klienta na trasach JSON (`rarog-app/<wersja>`).
  public static let clientHeader = "x-rarog-relay-client"
  /// Dopuszczalna różnica `issuedAt` wobec zegara Workera, w obie strony (sekundy).
  public static let clockSkewSeconds: Int64 = 300
  /// Najwięcej serwerów w `renew`.
  public static let serversMax = 32
  /// Sufit długości tokenu dowodu bramki (znaki).
  public static let proofTokenMaxChars = 8192
  /// `GET /v1/health`.
  public static let healthPath = "/v1/health"
  /// Który rejestr pilnuje którego relaya iroh (`RELAY_AUTH_REGISTRIES`): klucz = relay w postaci kanonicznej `r=`
  /// (``PairingLinkWire/relayURL(_:)``), wartość = origin Workera rejestru bez ukośnika. Relay spoza mapy (własny
  /// relay użytkownika) nie ma rejestru: apka nie woła Workera dla serwera na takim relayu.
  public static let registries: [String: URL] = [
    "https://relay.rarog.ai/": URL(string: "https://relay-auth.rarog.ai")!,
  ]
  /// Największe `issuedAt`: dziesięć cyfr.
  static let issuedAtMax: Int64 = 9_999_999_999

  /// Trasy apki, podpisane kluczem iroh apki.
  public enum Route: String, Sendable, CaseIterable {
    case register, renew, sponsor, forget

    /// Ścieżka trasy (`RELAY_AUTH_PATHS`).
    public var path: String { "/v1/app/\(rawValue)" }
  }

  /// Rodzaj bramki wejścia do rejestru (`RELAY_AUTH_GATES`).
  public enum Gate: String, Sendable, Equatable, Codable, CaseIterable {
    case devicecheck, apns
  }

  /// Środowisko usługi Apple, w której apka dostała token dowodu (`RELAY_AUTH_ENVIRONMENTS`).
  public enum Environment: String, Sendable, Equatable, Codable, CaseIterable {
    case development, production
  }

  /// Dowód bramki: token z usługi Apple i środowisko, w którym go wydano.
  public struct Proof: Sendable, Equatable, Codable {
    public var kind: Gate
    public var environment: Environment
    public var token: String

    public init(kind: Gate, environment: Environment, token: String) {
      self.kind = kind
      self.environment = environment
      self.token = token
    }
  }

  /// Pola trasy (po polach wspólnych), w kolejności kontraktu.
  public enum Fields: Sendable, Equatable {
    case register(proof: Proof)
    case renew(servers: [String])
    case sponsor(server: String)
    case forget

    public var route: Route {
      switch self {
      case .register: .register
      case .renew: .renew
      case .sponsor: .sponsor
      case .forget: .forget
      }
    }

    /// Linie pól w tekście do podpisu.
    var signingLines: [String] {
      switch self {
      case let .register(proof): [proof.kind.rawValue, proof.environment.rawValue, proof.token]
      case let .renew(servers): [servers.joined(separator: ",")]
      case let .sponsor(server): [server]
      case .forget: []
      }
    }
  }

  /// Żądanie trasy apki. `sig` = podpis Ed25519 bajtów ``signingBytes`` (128 znaków hex), pusty przed podpisem.
  public struct Request: Sendable, Equatable {
    public var endpointId: String
    public var issuedAt: Int64
    public var fields: Fields
    public var sig: String

    public init(endpointId: String, issuedAt: Int64, fields: Fields, sig: String = "") {
      self.endpointId = endpointId
      self.issuedAt = issuedAt
      self.fields = fields
      self.sig = sig
    }

    public var route: Route { fields.route }

    /// Tekst do podpisu (`relayAuthSigningText`): domena, ścieżka, `endpointId`, `issuedAt`, pola trasy; linie
    /// rozdziela `\n`, bez `\n` na końcu.
    public var signingText: String {
      ([RelayAuthWire.signingDomain, route.path, endpointId, String(issuedAt)] + fields.signingLines)
        .joined(separator: "\n")
    }

    /// Bajty UTF-8 tekstu do podpisu.
    public var signingBytes: Data { Data(signingText.utf8) }

    /// Ciało JSON do wysłania (klucze posortowane).
    public func body() throws -> Data {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      return try encoder.encode(Encoded(request: self))
    }
  }

  /// Pole, na którym walidacja kształtu stanęła (`body` = ciało nie jest obiektem JSON); błąd to zawsze `bad-request`.
  public struct ValidationError: Error, Sendable, Equatable {
    public let field: String

    public init(field: String) { self.field = field }
  }

  /// Ciało żądania apki → żądanie albo pole odrzucenia. Kolejność sprawdzeń jak `parseRelayAuthRequest` w TS
  /// (pierwsza porażka wygrywa): obiekt, `v`, `endpointId`, `issuedAt`, pola trasy, `sig`. Nieznane pola odpadają.
  public static func parse(route: Route, json: Data) -> Result<Request, ValidationError> {
    let decoder = JSONDecoder()
    decoder.userInfo[routeKey] = route
    do {
      return .success(try decoder.decode(Decoded.self, from: json).request)
    } catch let error as ValidationError {
      return .failure(error)
    } catch {
      return .failure(ValidationError(field: "body"))
    }
  }

  // MARK: Reguły kształtu

  /// EndpointId iroh: 64 znaki hex małymi literami (ta sama reguła co `k=` linku parowania).
  public static func isEndpointId(_ raw: String) -> Bool { PairingLinkWire.isEndpointId(raw) }

  /// Podpis: 128 znaków hex małymi literami.
  static func isSig(_ raw: String) -> Bool {
    raw.utf8.count == 128 && raw.utf8.allSatisfy { isDigit($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }
  }

  /// Token dowodu w kształcie swojego rodzaju: DeviceCheck — base64 standardowe z dopełnieniem (`=` tylko na końcu,
  /// długość podzielna przez 4); APNs — 32–512 znaków hex. Niepusty, najwyżej ``proofTokenMaxChars`` znaków.
  static func isProofToken(_ kind: Gate, _ raw: String) -> Bool {
    let bytes = Array(raw.utf8)
    guard !bytes.isEmpty, bytes.count <= proofTokenMaxChars else { return false }
    switch kind {
    case .devicecheck:
      guard bytes.count.isMultiple(of: 4) else { return false }
      let padding = bytes.reversed().prefix(while: { $0 == UInt8(ascii: "=") }).count
      guard padding <= 2 else { return false }
      return bytes.dropLast(padding).allSatisfy(isBase64)
    case .apns:
      return (32...512).contains(bytes.count) && bytes.allSatisfy(isHex)
    }
  }

  private static func isDigit(_ byte: UInt8) -> Bool { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) }
  private static func isHex(_ byte: UInt8) -> Bool {
    isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
      || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(byte)
  }
  private static func isBase64(_ byte: UInt8) -> Bool {
    isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
      || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) || byte == UInt8(ascii: "+") || byte == UInt8(ascii: "/")
  }

  // MARK: Dekodowanie i kodowanie ciała

  static let routeKey = CodingUserInfoKey(rawValue: "relayAuthRoute")!

  private enum Key: String, CodingKey {
    case v, endpointId, issuedAt, proof, servers, server, sig
  }

  private enum ProofKey: String, CodingKey {
    case kind, environment, token
  }

  private struct Decoded: Decodable {
    let request: Request

    init(from decoder: any Decoder) throws {
      guard let route = decoder.userInfo[RelayAuthWire.routeKey] as? Route else {
        throw ValidationError(field: "body")
      }
      let container = try decoder.container(keyedBy: Key.self)
      guard try RelayAuthWire.read(Int.self, container, .v, "v") == RelayAuthWire.version else {
        throw ValidationError(field: "v")
      }
      let endpointId = try RelayAuthWire.read(String.self, container, .endpointId, "endpointId")
      guard RelayAuthWire.isEndpointId(endpointId) else { throw ValidationError(field: "endpointId") }
      let issuedAt = try RelayAuthWire.read(Int64.self, container, .issuedAt, "issuedAt")
      guard (1...RelayAuthWire.issuedAtMax).contains(issuedAt) else { throw ValidationError(field: "issuedAt") }
      let fields = try Self.fields(route, container, endpointId: endpointId)
      let sig = try RelayAuthWire.read(String.self, container, .sig, "sig")
      guard RelayAuthWire.isSig(sig) else { throw ValidationError(field: "sig") }
      request = Request(endpointId: endpointId, issuedAt: issuedAt, fields: fields, sig: sig)
    }

    private static func fields(_ route: Route, _ container: KeyedDecodingContainer<Key>, endpointId: String) throws
      -> Fields {
      switch route {
      case .register:
        let proof: KeyedDecodingContainer<ProofKey>
        do { proof = try container.nestedContainer(keyedBy: ProofKey.self, forKey: .proof) } catch {
          throw ValidationError(field: "proof")
        }
        guard let kind = Gate(rawValue: try RelayAuthWire.read(String.self, proof, .kind, "proof.kind")) else {
          throw ValidationError(field: "proof.kind")
        }
        guard let environment = Environment(rawValue: try RelayAuthWire.read(String.self, proof, .environment, "proof.environment"))
        else { throw ValidationError(field: "proof.environment") }
        let token = try RelayAuthWire.read(String.self, proof, .token, "proof.token")
        guard RelayAuthWire.isProofToken(kind, token) else { throw ValidationError(field: "proof.token") }
        return .register(proof: Proof(kind: kind, environment: environment, token: token))
      case .renew:
        let servers = try RelayAuthWire.read([String].self, container, .servers, "servers")
        guard servers.count <= RelayAuthWire.serversMax, servers.allSatisfy(RelayAuthWire.isEndpointId),
          Set(servers).count == servers.count
        else { throw ValidationError(field: "servers") }
        return .renew(servers: servers)
      case .sponsor:
        let server = try RelayAuthWire.read(String.self, container, .server, "server")
        guard RelayAuthWire.isEndpointId(server), server != endpointId else { throw ValidationError(field: "server") }
        return .sponsor(server: server)
      case .forget:
        return .forget
      }
    }
  }

  /// Wartość pola albo odrzucenie na tym polu (brak, `null`, zły typ, liczba spoza typu albo z ułamkiem).
  private static func read<T: Decodable, K: CodingKey>(
    _ type: T.Type, _ container: KeyedDecodingContainer<K>, _ key: K, _ field: String
  ) throws -> T {
    do { return try container.decode(type, forKey: key) } catch { throw ValidationError(field: field) }
  }

  private struct Encoded: Encodable {
    let request: Request

    func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: Key.self)
      try container.encode(RelayAuthWire.version, forKey: .v)
      try container.encode(request.endpointId, forKey: .endpointId)
      try container.encode(request.issuedAt, forKey: .issuedAt)
      switch request.fields {
      case let .register(proof): try container.encode(proof, forKey: .proof)
      case let .renew(servers): try container.encode(servers, forKey: .servers)
      case let .sponsor(server): try container.encode(server, forKey: .server)
      case .forget: break
      }
      try container.encode(request.sig, forKey: .sig)
    }
  }

  // MARK: Odpowiedzi

  /// 200 `register`: wpis apki z terminem (sekundy epoki).
  public struct Registered: Sendable, Equatable, Decodable {
    public let endpointId: String
    public let expiresAt: Int64
  }

  /// 200 `renew`: nowy termin wpisu i serwery z listy bez żywego poręczenia tej apki (dla nich `sponsor`).
  public struct Renewed: Sendable, Equatable, Decodable {
    public let expiresAt: Int64
    public let unsponsored: [String]
  }

  /// 200 `sponsor`: poręczenie serwera z terminem.
  public struct Sponsored: Sendable, Equatable, Decodable {
    public let server: String
    public let expiresAt: Int64
  }

  /// 200 `forget`: wpisu nie ma.
  public struct Forgotten: Sendable, Equatable, Decodable {
    public let forgotten: Bool
  }

  /// 200 `deny` i `allow` (trasy administracyjne; apka ich nie woła).
  public struct AdminState: Sendable, Equatable, Decodable {
    public let endpointId: String
    public let denied: Bool
  }

  /// `GET /v1/health`: `ok` = Worker przyjmuje rejestracje, `gate` = bramka z konfiguracji albo `nil`,
  /// `enforce` = egzekwowanie odmów (`false` = tryb cienia).
  public struct Health: Sendable, Equatable, Decodable {
    public let ok: Bool
    public let version: String
    /// Nazwa bramki jak przyszła (nowszy Worker może znać inną), ``gateKind`` = znana bramka.
    public let gate: String?
    public let enforce: Bool

    public var gateKind: Gate? { gate.flatMap(Gate.init(rawValue:)) }
  }

  /// Kody błędów (`RELAY_AUTH_ERROR_STATUS`) ze statusem HTTP.
  public enum ErrorCode: String, Sendable, CaseIterable {
    case badRequest = "bad-request"
    case gateMismatch = "gate-mismatch"
    case badSignature = "bad-signature"
    case clockSkew = "clock-skew"
    case unauthorized
    case denied
    case notFound = "not-found"
    case notRegistered = "not-registered"
    case methodNotAllowed = "method-not-allowed"
    case kindConflict = "kind-conflict"
    case proofRejected = "proof-rejected"
    case quotaExceeded = "quota-exceeded"
    case limited
    case `internal`
    case notImplemented = "not-implemented"
    case gateUnreachable = "gate-unreachable"
    case unavailable

    public var status: Int {
      switch self {
      case .badRequest, .gateMismatch: 400
      case .badSignature, .clockSkew, .unauthorized: 401
      case .denied: 403
      case .notFound, .notRegistered: 404
      case .methodNotAllowed: 405
      case .kindConflict: 409
      case .proofRejected: 422
      case .quotaExceeded, .limited: 429
      case .internal: 500
      case .notImplemented: 501
      case .gateUnreachable: 502
      case .unavailable: 503
      }
    }
  }

  /// Błąd `{v: 1, error, …}`. Kod spoza ``ErrorCode`` (nowszy Worker) zostaje jako tekst, `code` jest wtedy `nil`.
  public struct Failure: Sendable, Equatable, Decodable {
    public let error: String
    /// Bramka Workera przy `gate-mismatch`, jak przyszła; ``gateKind`` = znana bramka.
    public let gate: String?

    public var code: ErrorCode? { ErrorCode(rawValue: error) }
    public var gateKind: Gate? { gate.flatMap(Gate.init(rawValue:)) }
  }

  private struct Versioned: Decodable {
    let v: Int
  }

  /// Odpowiedź JSON z `v: 1` jako `type`; inne `v` to `DecodingError.dataCorrupted`. Nieznane pola są pomijane.
  public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    let decoder = JSONDecoder()
    guard try decoder.decode(Versioned.self, from: data).v == version else {
      throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "v ≠ \(version)"))
    }
    return try decoder.decode(type, from: data)
  }
}
