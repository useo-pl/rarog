// Link parowania, strona Swift — lustro `shared/test/pairing-link.test.ts` na tych samych przypadkach
// (`shared/fixtures/pairing-links/manifest.json`): tekst → pola albo kod błędu, pola → link w postaci kanonicznej.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("link parowania: manifest → PairingLinkWire")
struct PairingLinkWireTests {
  struct Fields: Sendable, Decodable {
    let server: String?
    let iroh: ServerIroh?
    let code: String
  }

  struct Case: Sendable, Decodable {
    let text: String
    let ok: Fields?
    let link: String?
    let error: String?
  }

  struct Manifest: Sendable, Decodable {
    let sources: [String: String]
    let cases: [String: Case]
  }

  static let manifest: Manifest = {
    do {
      let file = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/pairing-links/manifest.json")
      return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: file))
    } catch {
      fatalError("link parowania: nie da się wczytać manifestu — \(error)")
    }
  }()

  static let names = manifest.cases.keys.sorted()

  @Test("przypadek manifestu: wynik parsowania, a dla `ok` złożenie i round-trip", arguments: PairingLinkWireTests.names)
  func manifestCase(_ name: String) throws {
    let entry = try #require(Self.manifest.cases[name])
    let result = PairingLinkWire.parse(entry.text)
    if let fields = entry.ok {
      let expected = PairingLinkWire(server: fields.server, iroh: fields.iroh, code: fields.code)
      #expect(result == .success(expected))
      let link = try #require(entry.link, "przypadek ok bez linku")
      #expect(expected.link == link)
      #expect(PairingLinkWire.parse(link) == .success(expected))
    } else {
      let raw = try #require(entry.error, "przypadek bez `ok` i bez `error`")
      let error = try #require(PairingLinkWireError(rawValue: raw), "kod spoza PairingLinkWireError: \(raw)")
      #expect(result == .failure(error))
    }
  }

  @Test("kody błędów Swift = kody z manifestu (TS sprawdza, że manifest ma każdy kod `PAIRING_LINK_ERRORS`)")
  func errorCodes() {
    let used = Set(Self.manifest.cases.values.compactMap(\.error))
    #expect(Set(PairingLinkWireError.allCases.map(\.rawValue)) == used)
    #expect(Self.manifest.sources.keys.sorted() == ["endpointId", "relay"])
  }

  @Test("postać kanoniczna jest punktem stałym reguł; schemat i wersja ze stałych")
  func canonicalFixedPoint() {
    for case let fields? in Self.manifest.cases.values.map(\.ok) {
      if let server = fields.server { #expect(PairingLinkWire.serverURL(server) == server) }
      if let iroh = fields.iroh {
        #expect(PairingLinkWire.isEndpointId(iroh.endpointId))
        #expect(PairingLinkWire.relayURL(iroh.relay) == iroh.relay)
      }
    }
    #expect(PairingLinkWire.scheme == "rarog")
    #expect(PairingLinkWire.version == String(PairBody.protocolVersion))
  }
}
