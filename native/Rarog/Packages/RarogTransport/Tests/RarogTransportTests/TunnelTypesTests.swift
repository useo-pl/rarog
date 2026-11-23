import Foundation
@testable import RarogTransport
import Testing

// Typy tunelu iroh bez biblioteki natywnej: cel połączenia, porażki i protokoły, które spełnia adapter IrohLib
// w osobnym pakiecie i atrapa testów. Test sprawdza, że protokoły da się spełnić czystym Swiftem (bez IrohLib)
// i że zapis `ServerIrohConfig` ma pola z formatu poświadczenia (`endpointId`, `relay`).

@Suite("typy tunelu iroh: cel, porażki, protokoły")
struct TunnelTypesTests {
  static let id = String(repeating: "ab", count: 32)
  static let relay = URL(string: "https://relay.example/")!

  @Test("cel tunelu: równość i hasz po EndpointId i relayu")
  func target() {
    let first = TunnelTarget(endpointId: Self.id, relay: Self.relay)
    let same = TunnelTarget(endpointId: Self.id, relay: Self.relay)
    let other = TunnelTarget(endpointId: String(repeating: "cd", count: 32), relay: Self.relay)
    let otherRelay = TunnelTarget(endpointId: Self.id, relay: URL(string: "https://relay.other/")!)
    #expect(first == same)
    #expect(first != other)
    #expect(first != otherRelay)
    #expect(Set([first, same, other]).count == 2)
  }

  @Test("porażki tunelu porównują się po rodzaju i treści")
  func failures() {
    #expect(TunnelFailure.closed(code: 3, reason: "x") == .closed(code: 3, reason: "x"))
    #expect(TunnelFailure.closed(code: nil, reason: "x") != .closed(code: 0, reason: "x"))
    #expect(TunnelFailure.bindFailed("a") != .connectFailed("a"))
    #expect(TunnelFailure.timedOut == .timedOut)
    #expect(TunnelFailure.unavailable("tożsamość") != .unavailable("lease"))
  }

  @Test("protokoły tunelu spełnia atrapa bez IrohLib: bind, connect, strumień z FIN, zamknięcie")
  func protocolsWithoutNativeLibrary() async throws {
    let transport: any TunnelTransport = EchoTransport()
    let endpoint = try await transport.bind(secretKey: Data(repeating: 1, count: 32), homeRelay: Self.relay)
    #expect(endpoint.endpointId == Self.id)
    try await endpoint.ensureRelay(Self.relay)
    let target = TunnelTarget(endpointId: Self.id, relay: Self.relay)
    let connection = try await endpoint.connect(to: target, alpn: Data("rarog-http/1".utf8))
    let stream = try await connection.openStream()
    try await stream.write(Data("GET / HTTP/1.1\r\n\r\n".utf8))
    try await stream.finish()
    #expect(try await stream.read(maxBytes: 4) == Data("GET ".utf8))
    _ = try await stream.read(maxBytes: 1024)
    #expect(try await stream.read(maxBytes: 1024).isEmpty)  // pusty Data = FIN
    connection.close(code: 0, reason: "koniec generacji")
    #expect(await connection.closed() == .closed(code: 0, reason: "koniec generacji"))
    await endpoint.close()
  }

  @Test("ServerIrohConfig: pola endpointId i relay jak w formacie poświadczenia")
  func serverIrohConfig() throws {
    let config = ServerIrohConfig(endpointId: Self.id, relay: Self.relay)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let json = try #require(String(data: try encoder.encode(config), encoding: .utf8))
    #expect(json == #"{"endpointId":"\#(Self.id)","relay":"https://relay.example/"}"#)
    #expect(try JSONDecoder().decode(ServerIrohConfig.self, from: Data(json.utf8)) == config)
  }
}

/// Atrapa tunelu: strumień oddaje zapisane bajty po FIN zapisu, połączenie pamięta powód zamknięcia.
private final class EchoTransport: TunnelTransport {
  func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint { EchoEndpoint() }
}

private final class EchoEndpoint: TunnelEndpoint {
  let endpointId = TunnelTypesTests.id
  func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection { EchoConnection() }
  func ensureRelay(_ relay: URL) async throws {}
  func close() async {}
}

private final class EchoConnection: TunnelConnection, @unchecked Sendable {
  private let lock = NSLock()
  private var reason: TunnelFailure = .timedOut
  func openStream() async throws -> any TunnelStream { EchoStream() }
  func close(code: UInt64, reason: String) { lock.withLock { self.reason = .closed(code: code, reason: reason) } }
  func closed() async -> TunnelFailure { lock.withLock { reason } }
}

private final class EchoStream: TunnelStream, @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = Data()
  private var finished = false
  func read(maxBytes: Int) async throws -> Data {
    lock.withLock {
      guard finished else { return Data() }
      let chunk = buffer.prefix(maxBytes)
      buffer.removeFirst(chunk.count)
      return Data(chunk)
    }
  }
  func write(_ data: Data) async throws { lock.withLock { buffer.append(data) } }
  func finish() async throws { lock.withLock { finished = true } }
  func abort(code: UInt64) async { lock.withLock { buffer.removeAll() } }
}
