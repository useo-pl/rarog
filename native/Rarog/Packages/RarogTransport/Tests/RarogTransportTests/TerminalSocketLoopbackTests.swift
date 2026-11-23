import Foundation
import Network
import RarogContract
import RarogTransport
import Testing

// `TerminalSocket` na prawdziwym drucie WS: serwer z `Network.framework` na loopbacku (bez Raroga i bez
// sieci). Atrapa `URLProtocol` nie przechwyci `URLSessionWebSocketTask`, więc nagłówki handshake'u,
// kolejność zdarzeń, pong na ping serwera (serwer liczy życie gniazda wyłącznie z pongów)
// i zamknięcia sprawdza się tutaj. Treść ramek jest syntetyczna.

/// Wartość pod zamkiem, do współdzielenia w domknięciach (`Mutex` jest nieskopiowalny).
private final class Locked<Value>: @unchecked Sendable {
  private var value: Value
  private let lock = NSLock()

  init(_ value: Value) {
    self.value = value
  }

  func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return body(&value)
  }
}

/// Serwer WS na `127.0.0.1` z losowym portem. Zapisuje nagłówki handshake'u i odebrane wiadomości.
private final class LoopbackServer: @unchecked Sendable {
  struct Recorded {
    var headers: [String: String] = [:]
    var texts: [String] = []
    var pongs = 0
    var connection: NWConnection?
  }

  private let queue = DispatchQueue(label: "rarog.test.ws-loopback")
  private let listener: NWListener
  let recorded: Locked<Recorded>
  private let onConnection: @Sendable (NWConnection, LoopbackServer) -> Void
  private let destroy: Bool

  /// - Parameter destroy: goły TCP zamiast WS — serwer czyta żądanie upgrade'u i zrywa połączenie bez
  ///   odpowiedzi, jak `socket.destroy()` w `ws.ts` przy odmowie (poświadczenie, `Origin`, nieznane id).
  init(destroy: Bool = false, onConnection: @escaping @Sendable (NWConnection, LoopbackServer) -> Void) throws {
    self.onConnection = onConnection
    self.destroy = destroy
    let recorded = Locked(Recorded())
    self.recorded = recorded
    let options = NWProtocolWebSocket.Options()
    options.autoReplyPing = true
    options.setClientRequestHandler(queue) { _, headers in
      recorded.withLock { state in
        for header in headers { state.headers[header.name.lowercased()] = header.value }
      }
      return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
    }
    let parameters = NWParameters.tcp
    if !destroy { parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0) }
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  /// Startuje i oddaje port.
  func start() async throws -> Int {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, any Error>) in
      let resumed = Locked(false)
      listener.stateUpdateHandler = { [listener] state in
        let port: Int? = switch state {
        case .ready: listener.port.map { Int($0.rawValue) }
        default: nil
        }
        let failed: (any Error)? = if case let .failed(error) = state { error } else { nil }
        guard port != nil || failed != nil, resumed.withLock({ done in defer { done = true }; return !done }) else { return }
        if let port { continuation.resume(returning: port) } else if let failed { continuation.resume(throwing: failed) }
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return }
        self.recorded.withLock { $0.connection = connection }
        connection.start(queue: self.queue)
        if !self.destroy { self.receive(connection) }
        self.onConnection(connection, self)
      }
      listener.start(queue: queue)
    }
  }

  func stop() {
    recorded.withLock { $0.connection?.cancel() }
    listener.cancel()
  }

  private func receive(_ connection: NWConnection) {
    connection.receiveMessage { [weak self] content, context, _, error in
      guard let self, error == nil else { return }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      if metadata?.opcode == .text, let content {
        self.recorded.withLock { $0.texts.append(String(decoding: content, as: UTF8.self)) }
      }
      self.receive(connection)
    }
  }

  static func send(_ connection: NWConnection, _ opcode: NWProtocolWebSocket.Opcode, _ data: Data = Data()) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
    let context = NWConnection.ContentContext(identifier: "ramka", metadata: [metadata])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
  }

  /// Ping serwera; pong klienta podbija licznik (to samo robi `ws.ts`: `alive` ustawia wyłącznie pong).
  func ping(_ connection: NWConnection) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: .ping)
    metadata.setPongHandler(queue) { [weak self] error in
      if error == nil { self?.recorded.withLock { $0.pongs += 1 } }
    }
    let context = NWConnection.ContentContext(identifier: "ping", metadata: [metadata])
    connection.send(content: Data(), contentContext: context, isComplete: true, completion: .idempotent)
  }

  static func close(_ connection: NWConnection, code: NWProtocolWebSocket.CloseCode) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
    metadata.closeCode = code
    let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
    connection.send(content: Data(), contentContext: context, isComplete: true, completion: .idempotent)
  }
}

/// Zdarzenia gniazda zebrane do końca strumienia (albo do limitu czasu).
private func collect(_ socket: TerminalSocket, until stop: @escaping @Sendable ([TerminalSocketEvent]) -> Bool) async
  -> [TerminalSocketEvent]
{
  await withTaskGroup(of: [TerminalSocketEvent].self) { group in
    group.addTask {
      var seen: [TerminalSocketEvent] = []
      for await event in socket.events {
        seen.append(event)
        if stop(seen) { break }
      }
      return seen
    }
    group.addTask {
      try? await Task.sleep(for: .seconds(15))
      return []
    }
    let first = await group.next() ?? []
    group.cancelAll()
    return first
  }
}

private func waitFor(_ condition: @escaping @Sendable () -> Bool) async -> Bool {
  for _ in 0..<300 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(20))
  }
  return condition()
}

@Suite("gniazdo terminala na prawdziwym drucie WS (loopback)", .serialized)
struct TerminalSocketLoopbackTests {
  static let id = "000284dd20c58f49"

  private func request(port: Int, credential: Bool = true) throws -> URLRequest {
    let config = RarogConfig.test(port: port, build: 1207, clientLabel: "iPad·Rarog")
    return try TerminalRequestBuilder.request(
      config: config, authorization: credential ? testDeviceHeader : nil, id: Self.id, fresh: true,
      grid: TerminalGrid(cols: 104, rows: 41))
  }

  @Test("handshake z kluczem urządzenia, Origin i UA, bez nagłówka etykiety; `hello`, potem bajty, w kolejności; ramki dochodzą; pong na ping")
  func roundTrip() async throws {
    let server = try LoopbackServer { connection, server in
      // Serwer Raroga: `hello` po `attach`, potem bajty PTY; tu dodatkowo ping (25 s w produkcji).
      LoopbackServer.send(connection, .text, Data(#"{"t":"hello","backend":"herdr"}"#.utf8))
      LoopbackServer.send(connection, .binary, Data([0x1B, 0x5B, 0x32, 0x4A, 0x24]))
      LoopbackServer.send(connection, .text, Data(#"{"t":"przyszla"}"#.utf8))
      server.ping(connection)
    }
    defer { server.stop() }
    let port = try await server.start()
    let socket = TerminalSocket(request: try request(port: port))
    let events = await collect(socket) { $0.count >= 3 }
    #expect(events == [.opened, .frame(.hello(backend: "herdr")), .bytes(Data([0x1B, 0x5B, 0x32, 0x4A, 0x24]))])

    let headers = server.recorded.withLock { $0.headers }
    #expect(headers["authorization"] == testDeviceHeader)
    #expect(headers["origin"] == "http://127.0.0.1:\(port)")
    #expect(headers["user-agent"] == "RarogApp/1207")
    #expect(headers["x-rarog-client"] == nil)

    #expect(await socket.send(.input("ls -la ~/x\r")))
    #expect(await socket.send(.resize(try #require(TerminalGrid(cols: 80, rows: 24)))))
    #expect(await waitFor { server.recorded.withLock { $0.texts.count == 2 } })
    #expect(server.recorded.withLock { $0.texts } == [#"{"d":"ls -la ~/x\r","t":"in"}"#, #"{"c":80,"r":24,"t":"rs"}"#])
    #expect(await waitFor { server.recorded.withLock { $0.pongs == 1 } })
    socket.close()
  }

  @Test("zamknięcie przez serwer (1008 po `err`): `err`, potem `closed`, strumień się kończy; wysyłka już nie idzie")
  func serverClose() async throws {
    let server = try LoopbackServer { connection, _ in
      LoopbackServer.send(connection, .text, Data(#"{"t":"err","msg":"Limit otwartych terminali."}"#.utf8))
      LoopbackServer.close(connection, code: .protocolCode(.policyViolation))
    }
    defer { server.stop() }
    let port = try await server.start()
    let socket = TerminalSocket(request: try request(port: port))
    let events = await collect(socket) { $0.last == .closed }
    #expect(events == [.opened, .frame(.error(message: "Limit otwartych terminali.")), .closed])
    #expect(await socket.send(.input("x")) == false)
  }

  @Test("odmowa upgrade'u (serwer: `socket.destroy()`): samo `closed`, bez `opened`")
  func rejectedUpgrade() async throws {
    let server = try LoopbackServer(destroy: true) { connection, _ in
      connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in connection.forceCancel() }
    }
    defer { server.stop() }
    let port = try await server.start()
    let socket = TerminalSocket(request: try request(port: port, credential: false))
    let events = await collect(socket) { $0.last == .closed }
    #expect(events == [.closed])
  }

  @Test("`close()` klienta: `closed` dokładnie raz, potem nic; ponowne `close()` bez skutku")
  func clientClose() async throws {
    let server = try LoopbackServer { _, _ in }
    defer { server.stop() }
    let port = try await server.start()
    let socket = TerminalSocket(request: try request(port: port))
    let opened = await collect(socket) { $0.contains(.opened) }
    #expect(opened == [.opened])
    socket.close()
    socket.close()
    var rest: [TerminalSocketEvent] = []
    for await event in socket.events { rest.append(event) }
    #expect(rest == [.closed])
  }
}
