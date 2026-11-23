import Foundation
import RarogContract
import RarogTransport
import RarogTransportTesting
import Testing

// Granice klienta rejestru relaya iroh w źródłach: kod klienta leży w `RelayAccess/`, tunel
// (`Tunnel/` i przełącznik transportu w `RarogCore`) go nie zna, a `RelayAccess/` nie zna `RarogCore`, IrohLib,
// DeviceCheck ani UIKit (podpis i dowód przychodzą przez protokoły). Każda atrapa rejestru niesie znacznik
// `RAROG_TEST_ONLY_RELAY_FAKE`, po którym oględziny wydania poznają atrapę w pliku wykonywalnym.

@Suite("granice klienta rejestru relaya iroh w źródłach")
struct RelayAccessBoundaryTests {
  static let marker = "RAROG_TEST_ONLY_RELAY_FAKE"
  static let transport = "Packages/RarogTransport/Sources"

  @Test("tunel nie zna klienta rejestru: pliki Tunnel/ i SwitchingTransport bez RelayAccess i RelayAuth")
  func tunnelDoesNotKnowRelayAccess() throws {
    let files = try IrohBoundaryTests.swiftFiles("\(Self.transport)/RarogTransport/Tunnel")
      + [IrohBoundaryTests.native.appending(path: "Packages/RarogCore/Sources/RarogCore/Transport/SwitchingTransport.swift")]
    #expect(files.count >= 8)
    for url in files {
      let hits = try String(contentsOf: url, encoding: .utf8).split(separator: "\n")
        .filter { $0.contains("RelayAccess") || $0.contains("RelayAuth") }
      #expect(hits == [], "\(url.lastPathComponent)")
    }
  }

  /// Moduł z linii importu (`import X`, `@preconcurrency import X`, `import struct X.Y`); `nil` = to nie import.
  static func importedModule(_ line: String) -> String? {
    let words = line.split(whereSeparator: \.isWhitespace)
    guard let index = words.firstIndex(of: "import"), words[..<index].allSatisfy({ $0.hasPrefix("@") }) else {
      return nil
    }
    var rest = words[(index + 1)...]
    let kinds: Set<Substring> = ["struct", "class", "enum", "protocol", "typealias", "func", "var", "let"]
    if let kind = rest.first, kinds.contains(kind) { rest = rest.dropFirst() }
    return rest.first.flatMap { $0.split(separator: ".").first }.map(String.init)
  }

  @Test("RelayAccess/ nie importuje RarogCore, IrohLib, DeviceCheck ani UIKit")
  func relayAccessImports() throws {
    let files = try IrohBoundaryTests.swiftFiles("\(Self.transport)/RarogTransport/RelayAccess")
    #expect(files.count >= 3)
    let forbidden: Set = ["RarogCore", "IrohLib", "DeviceCheck", "UIKit"]
    for url in files {
      let modules = try IrohBoundaryTests.code(url).compactMap(Self.importedModule)
      #expect(!modules.isEmpty && forbidden.isDisjoint(with: modules), "\(url.lastPathComponent): \(modules)")
    }
    #expect(Self.importedModule("@preconcurrency import UIKit") == "UIKit")
    #expect(Self.importedModule("import struct IrohLib.SecretKey") == "IrohLib")
    #expect(Self.importedModule("  @testable import RarogCore") == "RarogCore")
    #expect(Self.importedModule("let x = 1 // import UIKit") == nil)
  }

  @Test("klient rejestru leży tylko w RelayAccess/: reszta RarogTransport nie wymienia jego typów")
  func oneDirectory() throws {
    let files = try IrohBoundaryTests.swiftFiles("\(Self.transport)/RarogTransport")
      .filter { !$0.path.contains("/RelayAccess/") }
    #expect(files.count > 20)
    for url in files {
      let names = ["RelayAccess", "RelayAuthClient", "RelayAuthReply", "RelayAuthTransport", "RelayGate", "RelayOptOut"]
      let hits = try IrohBoundaryTests.code(url).filter { line in names.contains { line.contains($0) } }
      #expect(hits == [], "\(url.lastPathComponent)")
    }
  }

  @Test("każda atrapa rejestru niesie znacznik: pole marker z init, token bramki ze znacznikiem")
  func fakesCarryMarker() throws {
    #expect(relayFakeMarker == Self.marker)
    #expect(FakeRelayAuthTransport().marker == Self.marker)
    #expect(FakeRelayGate().marker == Self.marker)
    #expect(FakeRelaySigner().marker == Self.marker)
    #expect(FakeRelayAccessStore().marker == Self.marker)
    for attempt in 1...3 {
      let devicecheck = FakeRelayGate.token(.devicecheck, attempt: attempt)
      let decoded = try #require(Data(base64Encoded: devicecheck))
      #expect(String(decoding: decoded, as: UTF8.self) == "\(Self.marker)-\(attempt)")
      let apns = FakeRelayGate.token(.apns, attempt: attempt)
      #expect(apns.count >= 32 && apns.count <= 512 && apns.allSatisfy(\.isHexDigit))
    }

    // Źródło: każdy publiczny typ atrapy ustawia `marker` w swoim `init`, więc nowa atrapa bez znacznika przewraca test.
    let source = try String(
      contentsOf: IrohBoundaryTests.native.appending(path: "\(Self.transport)/RarogTransportTesting/FakeRelayAuth.swift"),
      encoding: .utf8)
    let types = source.matches(of: try Regex(#"(?m)^public (final class|struct|actor|enum) (Fake\w+)"#)).count
    let markers = source.matches(of: try Regex(#"(?m)^    marker = relayFakeMarker$"#)).count
    #expect(types == 4 && markers == types)
    #expect(source.components(separatedBy: "\"\(Self.marker)\"").count == 2, "literał znacznika stoi w jednym miejscu")
  }

  @Test("atrapa bramki: nowy token na każdą próbę w kształcie kontraktu; porażki z kolejki; brak wsparcia")
  func fakeGate() async throws {
    let gate = FakeRelayGate()
    let first = try await gate.proof()
    let second = try await gate.proof()
    #expect(first.token != second.token && first.kind == .devicecheck && gate.attempts == 2)
    for kind in RelayAuthWire.Gate.allCases {
      let proof = try await FakeRelayGate(kind: kind, environment: .production).proof()
      let request = RelayAuthWire.Request(
        endpointId: String(repeating: "c3", count: 32), issuedAt: 1, fields: .register(proof: proof),
        sig: String(repeating: "0", count: 128))
      #expect(RelayAuthWire.parse(route: .register, json: try request.body()) == .success(request), "\(kind)")
    }
    gate.failNext(.failed("apple"), .unsupported)
    await #expect(throws: RelayGateFailure.failed("apple")) { try await gate.proof() }
    await #expect(throws: RelayGateFailure.unsupported) { try await gate.proof() }
    _ = try await gate.proof()
    gate.isSupported = false
    #expect(!gate.isSupported && FakeRelayGate(isSupported: false).isSupported == false)
  }

  @Test("atrapa rejestru: kolejka odpowiedzi trasy, potem responder; zapis żądań i najwięcej naraz")
  func fakeTransport() async {
    let signer = FakeRelaySigner()
    let registry = URL(string: "https://relay-auth.rarog.ai")!
    let transport = FakeRelayAuthTransport { _ in FakeRelayAuthTransport.failure(.limited) }
    transport.enqueue(.forget, FakeRelayAuthTransport.forgotten())
    #expect(await transport.send(.forget, signer: signer, issuedAt: 7, registry: registry)
      == FakeRelayAuthTransport.forgotten())
    #expect(await transport.send(.forget, signer: signer, issuedAt: 8, registry: registry)
      == .failure(status: 429, code: .limited, gate: nil))
    #expect(transport.routes == [.forget, .forget] && transport.calls.map(\.issuedAt) == [7, 8])
    #expect(transport.calls.allSatisfy { $0.endpointId == signer.endpointId && $0.registry == registry })
    #expect(transport.maxInFlight == 1)
    let silent = FakeRelayAuthTransport()
    guard case .unreachable = await silent.send(.forget, signer: signer, issuedAt: 1, registry: registry) else {
      Issue.record("atrapa bez odpowiedzi to .unreachable")
      return
    }
  }
}
