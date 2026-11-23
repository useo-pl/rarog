import Foundation
@testable import RarogCore
import RarogTransport
import Testing

// Wskaźnik przestrzeni (`servers/.current.json`) między buildem sprzed pola `identity` a buildem bieżącym, w obie strony.
// Złote wskaźniki `main` to wyjście `ServerSpaces.writePointer` sprzed pola `identity`, zapisane testem, zanim
// `ServerSpace` dostał `identity`; wskaźniki z `identity` mają kształt bieżący. Kolejność kluczy JSON jest przypadkowa
// (`JSONEncoder` bez `.sortedKeys`), więc porównanie idzie na zdekodowanych wartościach. Zamrożony dekoder:
// `PreIdentityServerSpace.swift`.

/// Złote wskaźniki: wspólne dla testów dekoderów i magazynu.
enum GoldenPointers {
  /// `main`: adres z portem domyślnym.
  static let main = Data(
    #"{"origin":{"port":443,"host":"rarog.example","scheme":"https"},"name":"8e62cbe8f9e21edf-1654d564"}"#.utf8)
  /// `main`: adres z portem niedomyślnym.
  static let mainPort = Data(
    #"{"name":"b7142e3e33510bd1-d21b6999","origin":{"port":8443,"host":"mac-demo.example","scheme":"https"}}"#.utf8)
  /// Tożsamość po adresie: `origin` zostaje dla starszego buildu.
  static let origin = Data(
    (#"{"origin":{"scheme":"https","host":"rarog.example","port":443},"name":"8e62cbe8f9e21edf-1654d564","#
      + #""identity":"https://rarog.example:443"}"#).utf8)
  /// EndpointId serwera tylko przez iroh (wartość syntetyczna).
  static let endpointId = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
  /// Serwer tylko przez iroh: bez `origin`.
  static let iroh = Data(#"{"name":"5f1d0c2e7a9b3c41-1a2b3c4d","identity":"iroh:\#(endpointId)"}"#.utf8)

  static let rarog = ServerOrigin(URL(string: "https://rarog.example")!)!
  static let macDemo = ServerOrigin(URL(string: "https://mac-demo.example:8443")!)!
}

@Suite("wskaźnik przestrzeni: build sprzed pola identity i bieżący czytają się nawzajem")
struct PreIdentitySpaceTests {
  static func expectOrigin(
    _ old: PreIdentityServerSpace.Origin, _ origin: ServerOrigin, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    #expect(old.scheme == origin.scheme && old.host == origin.host && old.port == origin.port, sourceLocation: sourceLocation)
  }

  @Test("złoty wskaźnik main: dekoder main i bieżący dają ten sam adres i nazwę, tożsamość z adresu")
  func goldenMain() throws {
    for (golden, origin, name) in [
      (GoldenPointers.main, GoldenPointers.rarog, "8e62cbe8f9e21edf-1654d564"),
      (GoldenPointers.mainPort, GoldenPointers.macDemo, "b7142e3e33510bd1-d21b6999"),
    ] {
      let old = try #require(PreIdentityServerSpace.read(golden))
      let current = try JSONDecoder().decode(ServerSpace.self, from: golden)
      Self.expectOrigin(old.origin, origin)
      #expect(old.name == name && current.name == name)
      #expect(current.identity == .origin(origin) && current.origin == origin)
    }
  }

  @Test("wskaźnik z `identity` po adresie: dekoder main czyta `origin` i `name`, bieżący tę samą przestrzeń")
  func goldenOriginWithIdentity() throws {
    let old = try #require(PreIdentityServerSpace.read(GoldenPointers.origin))
    Self.expectOrigin(old.origin, GoldenPointers.rarog)
    #expect(old.name == "8e62cbe8f9e21edf-1654d564")
    let current = try JSONDecoder().decode(ServerSpace.self, from: GoldenPointers.origin)
    #expect(current == (try JSONDecoder().decode(ServerSpace.self, from: GoldenPointers.main)), "ta sama przestrzeń co z main")
  }

  @Test("wskaźnik `.iroh`: dekoder main go nie czyta (świadomie), bieżący czyta tożsamość iroh")
  func goldenIroh() throws {
    #expect(PreIdentityServerSpace.read(GoldenPointers.iroh) == nil)
    let current = try JSONDecoder().decode(ServerSpace.self, from: GoldenPointers.iroh)
    #expect(current.identity == .iroh(endpointId: GoldenPointers.endpointId) && current.origin == nil)
    #expect(current.name == "5f1d0c2e7a9b3c41-1a2b3c4d")
  }

  @Test("wskaźnik zapisany bieżącym kodem przestrzeni: dekoder main daje ten sam adres i nazwę")
  func currentWriterToPreIdentity() throws {
    let spaces = ServerSpacesTests.scratchSpaces()
    for raw in ["https://rarog.example", "https://Mac-Demo.example:8443/", "http://100.64.0.1:8930", "https://[fd7a::1]:8443"] {
      let origin = try #require(ServerOrigin(URL(string: raw)!))
      let space = spaces.newSpace(for: origin)
      #expect(spaces.writePointer(space))
      let old = try #require(PreIdentityServerSpace.read(Data(contentsOf: spaces.pointerFile)), "\(raw)")
      Self.expectOrigin(old.origin, origin)
      #expect(old.name == space.name, "\(raw)")
      #expect(try spaces.readPointer() == space, "\(raw)")
    }
    // Wskaźnik serwera tylko przez iroh: starszy build go nie czyta (nowa przestrzeń po powrocie).
    #expect(spaces.writePointer(spaces.newSpace(for: .iroh(endpointId: GoldenPointers.endpointId))))
    #expect(PreIdentityServerSpace.read(try Data(contentsOf: spaces.pointerFile)) == nil)
  }

  @MainActor
  @Test("wskaźnik zapisany bieżącym magazynem (klucz bez wskaźnika): dekoder main daje ten sam adres i nazwę")
  func currentStoreToPreIdentity() async throws {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let store = server.store()
    await store.start()
    let space = try #require(server.pointer)
    let old = try #require(PreIdentityServerSpace.read(Data(contentsOf: server.spaces.pointerFile)))
    Self.expectOrigin(old.origin, try #require(ServerOrigin(PairingFixtures.server)))
    #expect(old.name == space.name && store.dataSpaceDirectory == server.spaces.directory(space))
  }
}
