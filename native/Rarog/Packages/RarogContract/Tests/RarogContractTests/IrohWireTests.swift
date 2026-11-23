// Stałe transportu iroh, strona Swift — lustro `shared/src/iroh.ts` co do bajtu: ALPN, który serwer przyjmuje,
// i `Origin` mutacji po iroh. Test czyta plik TS z repo, więc zmiana jednej strony bez drugiej przewraca go.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("stałe iroh: lustro shared/src/iroh.ts")
struct IrohWireTests {
  /// Wartość `export const <name> = '<wartość>';` z `shared/src/iroh.ts`.
  private static func constant(_ name: String) throws -> String {
    let file = try GoldenFrames.repoRoot().appending(path: "shared/src/iroh.ts")
    let source = try String(contentsOf: file, encoding: .utf8)
    let pattern = try Regex("export const \(name) = '([^']*)';")
    let match = try #require(source.firstMatch(of: pattern), "brak \(name) w shared/src/iroh.ts")
    return try #require(match.output[1].substring.map(String.init))
  }

  @Test("ALPN = rarog-http/1, ten sam co IROH_ALPN serwera")
  func alpn() throws {
    #expect(IrohWire.alpn == "rarog-http/1")
    #expect(IrohWire.alpn == (try Self.constant("IROH_ALPN")))
    #expect(IrohWire.alpnBytes == Data("rarog-http/1".utf8))
  }

  @Test("Origin = https://iroh.rarog.invalid, ten sam co IROH_ORIGIN serwera")
  func origin() throws {
    #expect(IrohWire.origin == "https://iroh.rarog.invalid")
    #expect(IrohWire.origin == (try Self.constant("IROH_ORIGIN")))
  }
}
