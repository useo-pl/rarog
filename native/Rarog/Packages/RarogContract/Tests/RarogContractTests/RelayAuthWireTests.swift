// Rejestr relaya iroh, strona Swift — lustro `shared/test/relay-auth.test.ts` na tych samych przypadkach
// (`shared/fixtures/relay-auth/manifest.json`): ciało → żądanie albo pole odrzucenia, żądanie → tekst do podpisu co do
// bajtu, odpowiedzi → typy. Podpis z manifestu sprawdza CryptoKit kluczem publicznym z `endpointId`.
import CryptoKit
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("rejestr relaya iroh: manifest → RelayAuthWire")
struct RelayAuthWireTests {
  struct RequestCase: Sendable, Decodable {
    let route: String
    let body: JSONValue
    let signingText: String?
    let signingBytes: String?
    let field: String?
  }

  struct ResponseCase: Sendable, Decodable {
    let route: String?
    let status: Int
    let body: JSONValue
  }

  struct Key: Sendable, Decodable {
    let endpointId: String
  }

  struct Manifest: Sendable, Decodable {
    let key: Key
    let registries: [String: String]
    let paths: [String: String]
    let errorStatus: [String: Int]
    let requests: [String: RequestCase]
    let responses: [String: ResponseCase]
  }

  static let manifest: Manifest = {
    do {
      let file = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/relay-auth/manifest.json")
      return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: file))
    } catch {
      fatalError("rejestr relaya iroh: nie da się wczytać manifestu — \(error)")
    }
  }()

  static let accepted = manifest.requests.filter { $0.value.signingText != nil }.keys.sorted()
  static let rejected = manifest.requests.filter { $0.value.field != nil }.keys.sorted()
  static let responseNames = manifest.responses.keys.sorted()

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  static func bytes(hex: String) throws -> Data {
    let utf8 = Array(hex.utf8)
    try #require(utf8.count.isMultiple(of: 2), "hex o nieparzystej długości")
    return try Data(stride(from: 0, to: utf8.count, by: 2).map { index in
      try #require(UInt8(String(decoding: utf8[index...index + 1], as: UTF8.self), radix: 16), "zły hex")
    })
  }

  @Test("żądanie przyjęte: kształt, tekst do podpisu co do bajtu, podpis Ed25519, ciało w obie strony",
    arguments: RelayAuthWireTests.accepted)
  func acceptedCase(_ name: String) throws {
    let entry = try #require(Self.manifest.requests[name])
    let route = try #require(RelayAuthWire.Route(rawValue: entry.route))
    let request = try RelayAuthWire.parse(route: route, json: entry.body.data).get()
    #expect(request.route == route)
    #expect(request.signingText == entry.signingText)
    #expect(Self.hex(request.signingBytes) == entry.signingBytes)
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: Self.bytes(hex: request.endpointId))
    #expect(key.isValidSignature(try Self.bytes(hex: request.sig), for: request.signingBytes))
    // Tekst nie zależy od `sig`: apka liczy go przed podpisem.
    var unsigned = request
    unsigned.sig = ""
    #expect(unsigned.signingText == entry.signingText)
    #expect(RelayAuthWire.parse(route: route, json: try request.body()) == .success(request))
  }

  @Test("żądanie odrzucone na polu z manifestu (ta sama kolejność sprawdzeń co TS)", arguments: RelayAuthWireTests.rejected)
  func rejectedCase(_ name: String) throws {
    let entry = try #require(Self.manifest.requests[name])
    let route = try #require(RelayAuthWire.Route(rawValue: entry.route))
    let field = try #require(entry.field)
    #expect(RelayAuthWire.parse(route: route, json: entry.body.data) == .failure(.init(field: field)))
  }

  @Test("odpowiedź z manifestu dekoduje się do typu trasy albo do błędu ze znanym kodem i statusem",
    arguments: RelayAuthWireTests.responseNames)
  func responseCase(_ name: String) throws {
    let entry = try #require(Self.manifest.responses[name])
    let data = entry.body.data
    guard entry.status == 200 else {
      let failure = try RelayAuthWire.decode(RelayAuthWire.Failure.self, from: data)
      let code = try #require(failure.code, "kod spoza ErrorCode: \(failure.error)")
      #expect(code.status == entry.status)
      #expect((failure.gateKind != nil) == (code == .gateMismatch))
      return
    }
    switch entry.route {
    case "register": _ = try RelayAuthWire.decode(RelayAuthWire.Registered.self, from: data)
    case "renew": _ = try RelayAuthWire.decode(RelayAuthWire.Renewed.self, from: data)
    case "sponsor": _ = try RelayAuthWire.decode(RelayAuthWire.Sponsored.self, from: data)
    case "forget": #expect(try RelayAuthWire.decode(RelayAuthWire.Forgotten.self, from: data).forgotten)
    case "deny", "allow": _ = try RelayAuthWire.decode(RelayAuthWire.AdminState.self, from: data)
    case "health":
      let health = try RelayAuthWire.decode(RelayAuthWire.Health.self, from: data)
      #expect((health.gate == nil) == (health.gateKind == nil))
    default: Issue.record("odpowiedź 200 bez znanej trasy: \(entry.route ?? "null")")
    }
  }

  @Test("stałe Swift = manifest: ścieżki tras, kody błędów ze statusem")
  func constants() {
    for route in RelayAuthWire.Route.allCases {
      #expect(Self.manifest.paths[route.rawValue] == route.path)
    }
    #expect(Self.manifest.paths["health"] == RelayAuthWire.healthPath)
    #expect(Dictionary(uniqueKeysWithValues: RelayAuthWire.ErrorCode.allCases.map { ($0.rawValue, $0.status) })
      == Self.manifest.errorStatus)
    #expect(RelayAuthWire.isEndpointId(Self.manifest.key.endpointId))
  }

  @Test("mapa relay → rejestr = manifest; klucz w postaci kanonicznej `r=`, wartość to origin bez ścieżki")
  func registries() {
    #expect(RelayAuthWire.registries.mapValues(\.absoluteString) == Self.manifest.registries)
    #expect(!RelayAuthWire.registries.isEmpty)
    for (relay, registry) in RelayAuthWire.registries {
      #expect(PairingLinkWire.relayURL(relay) == relay)
      #expect(registry.scheme == "https" && registry.path.isEmpty && registry.query == nil, "\(registry)")
    }
  }

  @Test("odpowiedź z innym `v` albo bez `v` nie dekoduje się; nieznany kod i bramka zostają jako tekst")
  func tolerance() throws {
    #expect(throws: DecodingError.self) {
      try RelayAuthWire.decode(RelayAuthWire.Forgotten.self, from: Data(#"{"v":2,"forgotten":true}"#.utf8))
    }
    #expect(throws: DecodingError.self) {
      try RelayAuthWire.decode(RelayAuthWire.Forgotten.self, from: Data(#"{"forgotten":true}"#.utf8))
    }
    let failure = try RelayAuthWire.decode(RelayAuthWire.Failure.self,
      from: Data(#"{"v":1,"error":"nowy-kod","gate":"nowa","extra":1}"#.utf8))
    #expect(failure.code == nil && failure.error == "nowy-kod")
    #expect(failure.gate == "nowa" && failure.gateKind == nil)
  }
}
