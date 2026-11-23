import Foundation
@testable import RarogCore
import RarogTransport
import Testing

// Tożsamość serwera (`ServerIdentity`) i wskaźnik przestrzeni z polem `identity`: napisy tożsamości,
// kodowanie wskaźnika, odczyt wskaźnika bez pola i nazwa katalogu przestrzeni. Zgodność ze starszym buildem:
// `Legacy/PreIdentitySpaceTests.swift`.

@Suite("przestrzeń danych: tożsamość serwera i wskaźnik z `identity`")
struct ServerSpacesTests {
  static func scratchSpaces() -> ServerSpaces {
    let base = FileManager.default.temporaryDirectory.appending(path: "rarog-spaces-\(UUID())", directoryHint: .isDirectory)
    return ServerSpaces(
      root: base.appending(path: "servers", directoryHint: .isDirectory),
      trash: base.appending(path: "trash", directoryHint: .isDirectory))
  }

  static let endpointId = GoldenPointers.endpointId

  static func origin(_ raw: String) -> ServerOrigin { ServerOrigin(URL(string: raw)!)! }

  static func json(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  // MARK: - ServerIdentity

  @Test("napisy tożsamości: adres jak `ServerOrigin` (małe litery, port), iroh z przedrostkiem")
  func descriptions() {
    #expect(ServerIdentity.origin(Self.origin("https://Host:443")).description == "https://host:443")
    #expect(ServerIdentity.origin(Self.origin("https://RAROG.example/")).description == "https://rarog.example:443")
    #expect(ServerIdentity.origin(Self.origin("http://100.64.0.1:8930")).description == "http://100.64.0.1:8930")
    #expect(ServerIdentity.iroh(endpointId: Self.endpointId).description == "iroh:\(Self.endpointId)")
  }

  @Test("odczyt napisu tożsamości: postać kanoniczna wraca tą samą wartością, inna to brak")
  func parsing() {
    let identities: [ServerIdentity] = [
      .origin(Self.origin("https://rarog.example")), .origin(Self.origin("https://mac-demo.example:8443")),
      .origin(Self.origin("http://100.64.0.1:8930")), .origin(Self.origin("https://[fd7a::1]:8443")),
      .iroh(endpointId: Self.endpointId),
    ]
    for identity in identities {
      #expect(ServerIdentity(description: identity.description) == identity, "\(identity)")
    }
    let rejected = [
      "", "iroh:", "iroh:\(Self.endpointId.dropLast())", "iroh:\(Self.endpointId.uppercased())", "iroh:\(Self.endpointId)0",
      "https://Host:443", "https://host", "https://host:443/", "https://host:443/api", "ftp://host:21", "host:443",
      "IROH:\(Self.endpointId)",
    ]
    for text in rejected {
      #expect(ServerIdentity(description: text) == nil, "\(text)")
    }
  }

  @Test("tożsamość z poświadczenia: adres z `serverURL`, znormalizowany; bez adresu EndpointId iroh; bez tras nil")
  func fromCredential() {
    var credential = PairingFixtures.credential(server: URL(string: "https://RAROG.example:443/")!)
    #expect(ServerIdentity(credential) == .origin(Self.origin("https://rarog.example")))
    credential.iroh = ServerIrohConfig(endpointId: Self.endpointId, relay: URL(string: "https://relay.rarog.ai/")!)
    #expect(ServerIdentity(credential) == .origin(Self.origin("https://rarog.example")), "adres wygrywa z iroh")
    credential.serverURL = nil
    #expect(ServerIdentity(credential) == .iroh(endpointId: Self.endpointId))
    #expect(ServerIdentity(credential)?.description == "iroh:\(Self.endpointId)")
    credential.iroh = nil
    #expect(ServerIdentity(credential) == nil)
  }

  // MARK: - Kodowanie wskaźnika

  @Test("zapis wskaźnika po adresie: `origin`, `name` i `identity`; odczyt tę samą wartość")
  func encodesOrigin() throws {
    let space = ServerSpace(origin: Self.origin("https://rarog.example"), name: "8e62cbe8f9e21edf-1654d564")
    let data = try JSONEncoder().encode(space)
    let json = try Self.json(data)
    #expect(json["identity"] as? String == "https://rarog.example:443")
    #expect(json["name"] as? String == "8e62cbe8f9e21edf-1654d564")
    let origin = try #require(json["origin"] as? [String: Any])
    #expect(origin["scheme"] as? String == "https" && origin["host"] as? String == "rarog.example" && origin["port"] as? Int == 443)
    #expect(Set(json.keys) == ["origin", "name", "identity"])
    #expect(try JSONDecoder().decode(ServerSpace.self, from: data) == space)
  }

  @Test("zapis wskaźnika serwera tylko przez iroh: bez `origin`; odczyt tę samą wartość")
  func encodesIroh() throws {
    let space = ServerSpace(identity: .iroh(endpointId: Self.endpointId), name: "5f1d0c2e7a9b3c41-1a2b3c4d")
    let data = try JSONEncoder().encode(space)
    let json = try Self.json(data)
    #expect(Set(json.keys) == ["name", "identity"] && json["identity"] as? String == "iroh:\(Self.endpointId)")
    let decoded = try JSONDecoder().decode(ServerSpace.self, from: data)
    #expect(decoded == space && decoded.origin == nil)
  }

  @Test("odczyt: bez `identity` albo z nieczytelną tożsamość z `origin`; bez obu albo bez nazwy wskaźnik nieczytelny")
  func decodingRules() throws {
    let rarog = ServerIdentity.origin(Self.origin("https://rarog.example"))
    let origin = #""origin":{"scheme":"https","host":"rarog.example","port":443}"#
    let readable: [(String, ServerIdentity)] = [
      (#"{\#(origin),"name":"a"}"#, rarog),
      (#"{\#(origin),"name":"a","identity":"iroh:zz"}"#, rarog),
      (#"{\#(origin),"name":"a","identity":7}"#, rarog),
      (#"{\#(origin),"name":"a","identity":null}"#, rarog),
      (#"{\#(origin),"name":"a","identity":"https://rarog.example:443","migrating":true}"#, rarog),
      (#"{"name":"a","identity":"https://mac-demo.example:8443"}"#, .origin(Self.origin("https://mac-demo.example:8443"))),
      (#"{\#(origin),"name":"a","identity":"iroh:\#(Self.endpointId)"}"#, .iroh(endpointId: Self.endpointId)),
    ]
    for (text, identity) in readable {
      let space = try JSONDecoder().decode(ServerSpace.self, from: Data(text.utf8))
      #expect(space.identity == identity && space.name == "a", "\(text)")
    }
    let unreadable = [
      #"{"name":"a"}"#, #"{"name":"a","identity":"iroh:zz"}"#, #"{\#(origin)}"#,
      #"{\#(origin.replacingOccurrences(of: "443", with: "\"443\"")),"name":"a"}"#,
    ]
    for text in unreadable {
      #expect(throws: DecodingError.self, "\(text)") { try JSONDecoder().decode(ServerSpace.self, from: Data(text.utf8)) }
    }
  }

  // MARK: - Następca we wskaźniku

  @Test("wskaźnik z następcą: zapis niesie `successor` (napis tożsamości), odczyt tę samą wartość; bez następcy bez pola")
  func encodesSuccessor() throws {
    let space = ServerSpace(
      identity: .iroh(endpointId: Self.endpointId), name: "5f1d0c2e7a9b3c41-1a2b3c4d",
      successor: .origin(Self.origin("https://rarog.example")))
    let data = try JSONEncoder().encode(space)
    let json = try Self.json(data)
    #expect(Set(json.keys) == ["name", "identity", "successor"] && json["successor"] as? String == "https://rarog.example:443")
    #expect(try JSONDecoder().decode(ServerSpace.self, from: data) == space)
    let settled = space.settled
    #expect(settled.successor == nil && settled.identity == space.identity && settled.name == space.name)
    #expect(try Self.json(JSONEncoder().encode(settled))["successor"] == nil)
    // Następca przy tożsamości po adresie: `origin` zostaje dla starszego buildu.
    let origin = ServerSpace(
      identity: .origin(Self.origin("https://rarog.example")), name: "a", successor: .iroh(endpointId: Self.endpointId))
    let both = try Self.json(JSONEncoder().encode(origin))
    #expect(Set(both.keys) == ["origin", "name", "identity", "successor"])
  }

  @Test("odczyt następcy: nieczytelny `successor` to brak pola, wskaźnik czytelny; złote wskaźniki bez następcy")
  func decodingSuccessor() throws {
    let base = #""name":"a","identity":"iroh:\#(Self.endpointId)""#
    let rarog = ServerIdentity.origin(Self.origin("https://rarog.example"))
    let cases: [(String, ServerIdentity?)] = [
      (#"{\#(base),"successor":"https://rarog.example:443"}"#, rarog),
      (#"{\#(base),"successor":"https://Rarog.example"}"#, nil),
      (#"{\#(base),"successor":"iroh:zz"}"#, nil),
      (#"{\#(base),"successor":7}"#, nil),
      (#"{\#(base),"successor":null}"#, nil),
      (#"{\#(base)}"#, nil),
    ]
    for (text, successor) in cases {
      let space = try JSONDecoder().decode(ServerSpace.self, from: Data(text.utf8))
      #expect(space.identity == .iroh(endpointId: Self.endpointId) && space.name == "a", "\(text)")
      #expect(space.successor == successor, "\(text)")
    }
    for golden in [GoldenPointers.main, GoldenPointers.mainPort, GoldenPointers.origin, GoldenPointers.iroh] {
      #expect(try JSONDecoder().decode(ServerSpace.self, from: golden).successor == nil)
    }
  }

  @Test("dekoder starszego buildu na wskaźniku z `successor` daje to co na tym samym wskaźniku bez pola")
  func preIdentityIgnoresSuccessor() throws {
    let spaces = Self.scratchSpaces()
    let rarog = Self.origin("https://rarog.example")
    for space in [
      ServerSpace(origin: rarog, name: "8e62cbe8f9e21edf-1654d564"),
      ServerSpace(identity: .iroh(endpointId: Self.endpointId), name: "5f1d0c2e7a9b3c41-1a2b3c4d"),
    ] {
      let announced = ServerSpace(
        identity: space.identity, name: space.name,
        successor: space.origin == nil ? .origin(rarog) : .iroh(endpointId: Self.endpointId))
      #expect(spaces.writePointer(space))
      let plain = PreIdentityServerSpace.read(try Data(contentsOf: spaces.pointerFile))
      #expect(spaces.writePointer(announced))
      #expect(try Self.json(Data(contentsOf: spaces.pointerFile))["successor"] != nil)
      #expect(PreIdentityServerSpace.read(try Data(contentsOf: spaces.pointerFile)) == plain, "\(space.identity)")
      #expect(try spaces.readPointer() == announced)
    }
    // Wskaźnik po adresie z następcą: starszy build czyta ten sam adres i nazwę co ze złotego wskaźnika.
    let golden = try #require(PreIdentityServerSpace.read(GoldenPointers.origin))
    let announced = ServerSpace(identity: .origin(rarog), name: golden.name, successor: .iroh(endpointId: Self.endpointId))
    #expect(spaces.writePointer(announced))
    #expect(PreIdentityServerSpace.read(try Data(contentsOf: spaces.pointerFile)) == golden)
  }

  // MARK: - Dysk i nazwa przestrzeni

  @Test("wskaźnik na dysku: zapis niesie `identity`, wskaźnik `.iroh` czytelny, nieczytelny = brak przestrzeni")
  func pointerOnDisk() throws {
    let spaces = Self.scratchSpaces()
    let space = spaces.newSpace(for: Self.origin("https://rarog.example"))
    #expect(spaces.writePointer(space))
    #expect(try Self.json(Data(contentsOf: spaces.pointerFile))["identity"] as? String == "https://rarog.example:443")
    #expect(try spaces.readPointer() == space)
    try GoldenPointers.iroh.write(to: spaces.pointerFile)
    #expect(try spaces.readPointer()?.identity == .iroh(endpointId: Self.endpointId))
    try Data(#"{"name":"a","identity":"iroh:zz"}"#.utf8).write(to: spaces.pointerFile)
    #expect(try spaces.readPointer() == nil)
  }

  @Test("nazwa przestrzeni po adresie: ta sama część stała co w main (skrót opisu adresu), sufiks jednorazowy")
  func namesMatchMain() {
    let spaces = Self.scratchSpaces()
    // Części stałe z nazw złotych wskaźników `main` (`GoldenPointers`).
    for (origin, prefix) in [
      (GoldenPointers.rarog, "8e62cbe8f9e21edf-"), (GoldenPointers.macDemo, "b7142e3e33510bd1-"),
    ] {
      let (a, b) = (spaces.newSpace(for: origin), spaces.newSpace(for: .origin(origin)))
      #expect(a.name.hasPrefix(prefix) && b.name.hasPrefix(prefix) && a.name != b.name, "\(origin)")
      #expect(a.name.count == 25 && a.identity == .origin(origin))
    }
  }

  @Test("nazwa przestrzeni serwera tylko przez iroh: skrót napisu `iroh:<id>`, inna niż każdego adresu")
  func namesForIroh() {
    let spaces = Self.scratchSpaces()
    let identity = ServerIdentity.iroh(endpointId: Self.endpointId)
    let (a, b) = (spaces.newSpace(for: identity), spaces.newSpace(for: identity))
    #expect(a.name.prefix(17) == b.name.prefix(17) && a.name != b.name && a.identity == identity)
    #expect(!a.name.hasPrefix("8e62cbe8f9e21edf-") && a.name.count == 25)
  }
}
