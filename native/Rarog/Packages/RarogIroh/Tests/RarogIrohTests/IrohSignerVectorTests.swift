import Foundation
import RarogContract
import RarogContractFixtures
import RarogIroh
import Testing

// Podpis kluczem iroh apki na wektorach rejestru relaya (`shared/fixtures/relay-auth/manifest.json`): `IrohSigner`
// z kluczem testowym manifestu (ziarno 0x07 × 32) ma jego EndpointId, a podpis `signingBytes` każdego przyjętego
// żądania to `sig` manifestu co do bajtu. Ed25519 z IrohLib jest deterministyczny (RFC 8032), więc te same bajty
// podpisuje TS (`shared/test/relay-auth.test.ts`) i apka, a Worker przyjmie podpis apki.

@Suite("podpis iroh na wektorach rejestru relaya")
struct IrohSignerVectorTests {
  struct RequestCase: Sendable, Decodable {
    let route: String
    let body: JSONValue
    let signingText: String?
    let signingBytes: String?
  }

  struct Key: Sendable, Decodable {
    let secretKey: String
    let endpointId: String
  }

  struct Manifest: Sendable, Decodable {
    let key: Key
    let requests: [String: RequestCase]
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

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  static func bytes(hex: String) throws -> Data {
    let utf8 = Array(hex.utf8)
    try #require(utf8.count.isMultiple(of: 2), "hex o nieparzystej długości")
    return try Data(stride(from: 0, to: utf8.count, by: 2).map { index in
      try #require(UInt8(String(decoding: utf8[index...index + 1], as: UTF8.self), radix: 16), "zły hex")
    })
  }

  static func signer() throws -> IrohSigner {
    try IrohSigner(secretKey: bytes(hex: manifest.key.secretKey))
  }

  @Test("klucz testowy manifestu: ziarno 0x07 × 32, IrohSigner ma EndpointId manifestu")
  func endpointId() throws {
    #expect(try Self.bytes(hex: Self.manifest.key.secretKey) == Data(repeating: 7, count: 32))
    #expect(try Self.signer().endpointId == Self.manifest.key.endpointId)
    #expect(RelayAuthWire.isEndpointId(Self.manifest.key.endpointId))
  }

  @Test("podpis signingBytes przyjętego żądania = sig manifestu co do bajtu", arguments: IrohSignerVectorTests.accepted)
  func signatureVector(_ name: String) throws {
    let entry = try #require(Self.manifest.requests[name])
    let route = try #require(RelayAuthWire.Route(rawValue: entry.route))
    let request = try RelayAuthWire.parse(route: route, json: entry.body.data).get()
    #expect(request.endpointId == Self.manifest.key.endpointId, "wektor podpisany kluczem testowym")
    #expect(Self.hex(request.signingBytes) == entry.signingBytes)
    let signature = try Self.signer().sign(request.signingBytes)
    #expect(signature.count == 64)
    #expect(Self.hex(signature) == request.sig)
  }

  @Test("wektorów jest tyle, ile tras apki z wariantami; każdy ma tekst do podpisu")
  func coverage() {
    #expect(Self.accepted.count >= RelayAuthWire.Route.allCases.count)
    let routes = Set(Self.accepted.compactMap { Self.manifest.requests[$0]?.route })
    #expect(routes == Set(RelayAuthWire.Route.allCases.map(\.rawValue)))
  }
}
