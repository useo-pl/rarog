import Foundation
import RarogContract
import RarogCore
import RarogTransport

// Atrapa drutu terminala dla testów ekranu z prawdziwą powierzchnią SwiftTerm: `POST` zawsze przyjęty, gniazdo
// zapisuje wysłane ramki, a zdarzenia serwera pcha test. Treść to wyłącznie próbki syntetyczne.

final class RecordingSocket: TerminalSocketing, @unchecked Sendable {
  let events: AsyncStream<TerminalSocketEvent>
  private let continuation: AsyncStream<TerminalSocketEvent>.Continuation
  private let lock = NSLock()
  private var frames: [TerminalClientFrame] = []

  init() {
    (events, continuation) = AsyncStream<TerminalSocketEvent>.makeStream()
  }

  var sent: [TerminalClientFrame] { lock.withLock { frames } }

  func emit(_ event: TerminalSocketEvent) { continuation.yield(event) }

  func send(_ frame: TerminalClientFrame) async -> Bool {
    lock.withLock { frames.append(frame) }
    return true
  }

  func close() {
    continuation.yield(.closed)
    continuation.finish()
  }
}

final class FakeTerminalWire: TerminalTransporting, @unchecked Sendable {
  static let id = "0123456789abcdef"
  private let lock = NSLock()
  private var opened: [RecordingSocket] = []

  var sockets: [RecordingSocket] { lock.withLock { opened } }

  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    do {
      return try JSONDecoder().decode(
        TerminalOpenResponse.self, from: Data(#"{"id":"\#(Self.id)","slot":1,"role":"shell"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa")
    }
  }

  func terminals() async throws(TransportError) -> TerminalList {
    throw .invalidResponse("atrapa")
  }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    throw .invalidResponse("atrapa")
  }

  func closeTerminal(id: String) async throws(TransportError) {}

  func checkTerminalInput() async throws(MutationRefusal) {}

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    let socket = RecordingSocket()
    lock.withLock { opened.append(socket) }
    return socket
  }
}

/// Czeka (zegar ścienny, sufit 3 s), aż warunek stanie — gniazdo i kolejka wyjścia są asynchroniczne.
@MainActor
func waitUntil(_ condition: () -> Bool) async {
  for _ in 0..<300 where !condition() {
    try? await Task.sleep(for: .milliseconds(10))
  }
}
