import Foundation
import IrohLib
import RarogContract
@testable import RarogIroh
import RarogTransport
import Synchronization
import Testing

// Adapter na żywej bibliotece: serwer IrohLib i endpoint apki w jednym procesie, bez relaya (`RelayMode.disabled`),
// adresy tylko na pętli zwrotnej, więc bez sieci zewnętrznej. `bind` otwiera gniazda UDP i monitor sieci, który
// w sandboksie Claude Code pada, dlatego zestaw włącza `RAROG_TEST_IROH=1` i idzie poza sandboksem.
// The server restart suite (`IrohRestartLiveTests`) also has a variant through a real relay, enabled only by
// `RAROG_TEST_IROH_RELAY=<relay URL>`.

private let liveIroh = ProcessInfo.processInfo.environment["RAROG_TEST_IROH"] == "1"

/// Relay celu w testach: pętla zwrotna, port bez nasłuchu. Endpoint bez relaya go nie używa.
private let deadRelay = URL(string: "http://127.0.0.1:9/")!

/// Serwer IrohLib w procesie testu: ALPN Raroga, bez relaya.
final class LocalIrohServer: Sendable {
  let endpoint: Endpoint

  private init(endpoint: Endpoint) {
    self.endpoint = endpoint
  }

  static func start() async throws -> LocalIrohServer {
    let options = EndpointOptions(preset: presetMinimal(), alpns: [IrohWire.alpnBytes], relayMode: RelayMode.disabled())
    return LocalIrohServer(endpoint: try await Endpoint.bind(options: options))
  }

  var target: TunnelTarget { TunnelTarget(endpointId: endpoint.id().description, relay: deadRelay) }

  /// Gniazda serwera na pętli zwrotnej (`0.0.0.0:p` → `127.0.0.1:p`, `[::]:p` → `[::1]:p`).
  var loopback: [String] {
    endpoint.boundSockets().map { socket in
      if socket.hasPrefix("0.0.0.0:") { return "127.0.0.1:" + socket.dropFirst("0.0.0.0:".count) }
      if socket.hasPrefix("[::]:") { return "[::1]:" + socket.dropFirst("[::]:".count) }
      return socket
    }
  }

  /// Transport apki, który zna adresy tego serwera.
  var transport: IrohTunnelTransport {
    let addresses = loopback
    return IrohTunnelTransport(relays: .disabled, directAddresses: { _ in addresses })
  }

  func accept() async throws -> Connection {
    guard let incoming = await endpoint.acceptNext() else { throw TunnelFailure.unavailable("server closed") }
    return try await incoming.accept().connect()
  }

  /// Echo `streams` kolejnych strumieni (każdy do FIN), potem czeka, aż apka zamknie połączenie: porzucone
  /// `Connection` biblioteka zamyka od razu kodem 0, a wtedy odpowiedź w drodze ginie.
  static func echo(_ connection: Connection, streams: Int = 1) async throws {
    for _ in 0..<streams {
      let pair = try await connection.acceptBi()
      let data = try await pair.recv().readToEnd(sizeLimit: 1 << 20)
      try await pair.send().writeAll(buf: data)
      try await pair.send().finish()
    }
    _ = await connection.closed()
  }

  func close() async {
    try? await endpoint.close()
  }
}

/// Klucz tajny 32 B.
func freshSecret() -> Data { SecretKey.generate().toBytes() }

/// Strumień: zapis, FIN, odczyt do FIN po stronie apki.
func roundTrip(_ connection: any TunnelConnection, _ text: String) async throws -> String {
  let stream = try await connection.openStream()
  try await stream.write(Data(text.utf8))
  try await stream.finish()
  var out = Data()
  while true {
    let chunk = try await stream.read(maxBytes: 64 * 1024)
    if chunk.isEmpty { break }
    out.append(chunk)
  }
  return String(decoding: out, as: UTF8.self)
}

/// Czas wykonania.
func elapsed(_ body: () async throws -> Void) async rethrows -> Duration {
  let clock = ContinuousClock()
  let start = clock.now
  try await body()
  return clock.now - start
}

@Suite("adapter iroh na żywej bibliotece (RAROG_TEST_IROH=1)", .serialized, .enabled(if: liveIroh), .timeLimit(.minutes(1)))
struct IrohLiveTests {
  @Test("connect bez online(): endpoint bez relaya domowego łączy się z serwerem i przenosi strumień")
  func connectWithoutOnline() async throws {
    let server = try await LocalIrohServer.start()
    let secret = freshSecret()
    let endpoint = try await server.transport.bind(secretKey: secret, homeRelay: deadRelay)
    #expect(endpoint.endpointId == (try SecretKey.fromBytes(bytes: secret)).public().description)
    #expect(endpoint.endpointId.count == 64)
    #expect(endpoint.endpointId.allSatisfy { "0123456789abcdef".contains($0) })

    let serving = Task { try await LocalIrohServer.echo(try await server.accept()) }
    var connection: (any TunnelConnection)?
    let took = try await elapsed { connection = try await endpoint.connect(to: server.target, alpn: IrohWire.alpnBytes) }
    #expect(took < .seconds(5))
    #expect(try await roundTrip(try #require(connection), "GET /health HTTP/1.1\r\n\r\n") == "GET /health HTTP/1.1\r\n\r\n")
    connection?.close(code: 0, reason: "")
    try await serving.value
    await endpoint.close()
    await server.close()
  }

  @Test("Connection.close przy wiszącym writeAll i read kończy oba w ≤ 50 ms")
  func closeEndsPendingWrite() async throws {
    let server = try await LocalIrohServer.start()
    let endpoint = try await server.transport.bind(secretKey: freshSecret(), homeRelay: deadRelay)
    // Serwer przyjmuje strumień i nic z niego nie czyta ani nie pisze: zapis staje na kontroli przepływu, odczyt
    // czeka bez końca.
    let held = Task { () -> (Connection, BiStream) in
      let connection = try await server.accept()
      return (connection, try await connection.acceptBi())
    }
    let connection = try await endpoint.connect(to: server.target, alpn: IrohWire.alpnBytes)
    let stream = try await connection.openStream()
    let writing = Task { () -> (any Error)? in
      do { try await stream.write(Data(count: 64 << 20)); return nil } catch { return error }
    }
    let reading = Task { () -> (any Error)? in
      do { _ = try await stream.read(maxBytes: 1024); return nil } catch { return error }
    }
    let serverSide = try await held.value
    try await Task.sleep(for: .milliseconds(300))

    let clock = ContinuousClock()
    let start = clock.now
    connection.close(code: 0, reason: "generation end")
    let writeError = await writing.value
    let writeTook = clock.now - start
    let readError = await reading.value
    let readTook = clock.now - start

    #expect(writeError is TunnelFailure)
    #expect(readError is TunnelFailure)
    #expect(writeTook <= .milliseconds(50), "writeAll po close: \(writeTook)")
    #expect(readTook <= .milliseconds(50), "read po close: \(readTook)")
    #expect(await connection.closed() == .closed(code: nil, reason: "closed"))
    _ = serverSide
    await endpoint.close()
    await server.close()
  }

  @Test("zamknięcie przez serwer z kodem 3 → .closed(code: 3) w closed(), w wiszącym read i w read po zamknięciu",
        arguments: ["", "revoked"])
  func peerCloseCode(reason: String) async throws {
    // Seria, bo wynik odczytu mógłby zależeć od chwili, w której zamknięcie dochodzi do apki.
    for _ in 0..<10 { try await peerCloseRound(reason: reason) }
  }

  func peerCloseRound(reason: String) async throws {
    let server = try await LocalIrohServer.start()
    let endpoint = try await server.transport.bind(secretKey: freshSecret(), homeRelay: deadRelay)
    let closing = Task {
      let connection = try await server.accept()
      // Strumień zostaje przy życiu do końca: porzucony `SendStream` biblioteka kończy FIN-em, a wtedy pusty odczyt
      // apki byłby prawdziwym FIN, nie zamknięciem.
      let pair = try await connection.acceptBi()
      try connection.close(errorCode: 3, reason: Data(reason.utf8))
      _ = await connection.closed()
      withExtendedLifetime(pair) {}
    }
    let connection = try await endpoint.connect(to: server.target, alpn: IrohWire.alpnBytes)
    let stream = try await connection.openStream()
    try await stream.write(Data("x".utf8))
    let pending = await Self.readFailure(stream)
    let failure = await connection.closed()
    try await closing.value
    // Odczyt zaczęty po zamknięciu też oddaje powód z kodem, nie pusty bufor (FIN).
    let afterClose = await Self.readFailure(stream)

    #expect(failure == .closed(code: 3, reason: reason.isEmpty ? "closed by peer: 3" : "closed by peer: \(reason) (code 3)"))
    #expect(pending == failure)
    #expect(afterClose == failure)
    await endpoint.close()
    await server.close()
  }

  /// Porażka odczytu; pusty bufor i dane to `nil`.
  static func readFailure(_ stream: any TunnelStream) async -> TunnelFailure? {
    do {
      _ = try await stream.read(maxBytes: 1024)
      return nil
    } catch {
      return error as? TunnelFailure
    }
  }

  @Test("trzy połączenia naraz na jednym endpoincie")
  func threeConnections() async throws {
    let server = try await LocalIrohServer.start()
    let endpoint = try await server.transport.bind(secretKey: freshSecret(), homeRelay: deadRelay)
    let serving = Task {
      try await withThrowingTaskGroup(of: Void.self) { group in
        for _ in 0..<3 {
          let connection = try await server.accept()
          group.addTask { try await LocalIrohServer.echo(connection) }
        }
        try await group.waitForAll()
      }
    }
    let replies = try await withThrowingTaskGroup(of: String.self) { group in
      for index in 0..<3 {
        group.addTask {
          let connection = try await endpoint.connect(to: server.target, alpn: IrohWire.alpnBytes)
          defer { connection.close(code: 0, reason: "") }
          return try await roundTrip(connection, "conn-\(index)")
        }
      }
      return try await group.reduce(into: Set<String>()) { $0.insert($1) }
    }
    #expect(replies == ["conn-0", "conn-1", "conn-2"])
    try await serving.value
    await endpoint.close()
    await server.close()
  }

  @Test("ensureRelay na żywym endpoincie dokłada relay raz i nie zrywa połączenia")
  func ensureRelayOnLiveEndpoint() async throws {
    let server = try await LocalIrohServer.start()
    let bound = try await server.transport.bind(secretKey: freshSecret(), homeRelay: deadRelay)
    let endpoint = try #require(bound as? IrohTunnelEndpoint)
    let serving = Task {
      try await LocalIrohServer.echo(try await server.accept(), streams: 2)
    }
    let connection = try await endpoint.connect(to: server.target, alpn: IrohWire.alpnBytes)
    #expect(try await roundTrip(connection, "przed") == "przed")

    let relay = URL(string: "http://127.0.0.1:7/")!
    try await endpoint.ensureRelay(relay)
    try await endpoint.ensureRelay(relay)
    #expect(endpoint.relaysInserted == 1)

    #expect(try await roundTrip(connection, "po") == "po")
    connection.close(code: 0, reason: "")
    try await serving.value
    await endpoint.close()
    await server.close()
  }

  @Test("równoczesne ensureRelay czekają na jedno dołożenie i dostają jego błąd; następne wywołanie próbuje od nowa")
  func ensureRelayConcurrentSharesResult() async throws {
    let bound = try await IrohTunnelTransport(relays: .disabled, directAddresses: { _ in [] })
      .bind(secretKey: freshSecret(), homeRelay: deadRelay)
    let live = try #require(bound as? IrohTunnelEndpoint)
    let calls = Mutex(0)
    let (gate, open) = AsyncStream<Bool>.makeStream()
    let endpoint = IrohTunnelEndpoint(live.endpoint, knownRelays: [], directAddresses: { _ in [] }) { _, _ in
      calls.withLock { $0 += 1 }
      var iterator = gate.makeAsyncIterator()
      if await iterator.next() == false { throw TunnelFailure.unavailable("insert refused") }
    }
    let relay = URL(string: "http://127.0.0.1:7/")!
    let first = Task { try await endpoint.ensureRelay(relay) }
    while calls.withLock({ $0 }) == 0 { await Task.yield() }
    let second = Task { try await endpoint.ensureRelay(relay) }
    try await Task.sleep(for: .milliseconds(50))
    #expect(calls.withLock { $0 } == 1, "drugie wywołanie nie dokłada drugi raz")
    open.yield(false)
    await #expect(throws: TunnelFailure.self) { try await first.value }
    await #expect(throws: TunnelFailure.self) { try await second.value }
    #expect(endpoint.relaysInserted == 0)
    open.yield(true)
    try await endpoint.ensureRelay(relay)
    #expect(calls.withLock { $0 } == 2)
    #expect(endpoint.relaysInserted == 1)
    open.finish()
    await live.close()
  }

  @Test("close endpointu bez rywala kończy się, drugie close wraca od razu")
  func closeWithoutRival() async throws {
    let bound = try await IrohTunnelTransport(relays: .disabled, directAddresses: { _ in [] })
      .bind(secretKey: freshSecret(), homeRelay: deadRelay)
    let endpoint = try #require(bound as? IrohTunnelEndpoint)
    let first = await elapsed { await endpoint.close() }
    #expect(endpoint.endpoint.isClosed())
    #expect(first < .seconds(2), "Endpoint.close: \(first)")
    let second = await elapsed { await endpoint.close() }
    #expect(second < .milliseconds(50))
  }

  @Test("bind z budżetem 1 ms: wołający dostaje .timedOut, spóźniony endpoint przychodzi mimo anulowania i da się zamknąć")
  func bindBudget() async throws {
    let transport = IrohTunnelTransport(relays: .disabled, directAddresses: { _ in [] })
    let binding = Task { try await transport.bind(secretKey: freshSecret(), homeRelay: deadRelay) }
    let outcome = await Budget.race(binding, within: .milliseconds(1))
    #expect(outcome == .timedOut)
    binding.cancel()
    // Anulowanie zadania Swifta nie dochodzi do Rusta: wynik i tak przychodzi.
    let late = try await binding.value
    let endpoint = try #require(late as? IrohTunnelEndpoint)
    await endpoint.close()
    #expect(endpoint.endpoint.isClosed())
  }
}

// MARK: - Server restart with the same key

/// Relay of the restart measurement through a relay (`RAROG_TEST_IROH_RELAY`, e.g. `https://relay.rarog.ai/`); without
/// it only the variant without a relay runs. The relay variant opens four relay connections (two server binds, two
/// app endpoints) and a handful of iroh connections.
private let restartRelay = ProcessInfo.processInfo.environment["RAROG_TEST_IROH_RELAY"].flatMap(URL.init(string:))

/// Server endpoint that restarts with the same secret key, like the Rarog server after `SIGTERM`: the same EndpointId
/// on new UDP ports. Every accepted connection echoes its streams until the app closes it.
final class RestartingIrohServer: Sendable {
  let secret = freshSecret()
  let relay: URL?
  private let state = Mutex<(endpoint: Endpoint?, serving: Task<Void, Never>?)>((nil, nil))

  init(relay: URL?) {
    self.relay = relay
  }

  var endpoint: Endpoint? { state.withLock { $0.endpoint } }

  func start() async throws {
    let mode = try relay.map { try RelayMode.customFromUrls(urls: [$0.absoluteString]) } ?? RelayMode.disabled()
    let options = EndpointOptions(preset: presetMinimal(), secretKey: secret, alpns: [IrohWire.alpnBytes],
                                  relayMode: mode)
    let endpoint = try await Endpoint.bind(options: options)
    let serving = Task {
      while let incoming = await endpoint.acceptNext() {
        guard let connection = try? await incoming.accept().connect() else { continue }
        Task { try? await LocalIrohServer.echo(connection, streams: 1000) }
      }
    }
    state.withLock { $0 = (endpoint, serving) }
  }

  func close() async {
    let (endpoint, serving) = state.withLock { state in
      defer { state = (nil, nil) }
      return (state.endpoint, state.serving)
    }
    try? await endpoint?.close()
    serving?.cancel()
  }

  /// Bound sockets on loopback (`0.0.0.0:p` → `127.0.0.1:p`, `[::]:p` → `[::1]:p`).
  var loopback: [String] {
    (endpoint?.boundSockets() ?? []).map { socket in
      if socket.hasPrefix("0.0.0.0:") { return "127.0.0.1:" + socket.dropFirst("0.0.0.0:".count) }
      if socket.hasPrefix("[::]:") { return "[::1]:" + socket.dropFirst("[::]:".count) }
      return socket
    }
  }
}

@Suite("server restart with the same key on live iroh (RAROG_TEST_IROH=1)", .serialized, .enabled(if: liveIroh),
       .timeLimit(.minutes(4)))
struct IrohRestartLiveTests {
  @Test("server restart without a relay: the reused app endpoint and a fresh one connect to the same EndpointId on new ports")
  func restartWithoutRelay() async throws {
    try await measureRestart(relay: nil)
  }

  @Test("server restart through the relay (RAROG_TEST_IROH_RELAY): the reused app endpoint and a fresh one",
        .enabled(if: restartRelay != nil))
  func restartThroughRelay() async throws {
    try await measureRestart(relay: restartRelay)
  }

  /// The measured sequence: the app endpoint `first` connects; the server closes its endpoint; `first` tries while the
  /// server is down; the server binds again with the same key; `first` tries again; the new endpoint `fresh` tries;
  /// `first` tries once more.
  /// Every line goes to stdout; only the control results are expectations.
  func measureRestart(relay: URL?) async throws {
    let lines = Mutex<[String]>([])
    let clock = ContinuousClock()
    let start = clock.now
    let note: @Sendable (String) -> Void = { line in
      let at = Double((clock.now - start) / .milliseconds(1)) / 1000
      lines.withLock { $0.append(String(format: "%7.2f  ", at) + line) }
    }
    defer { Swift.print("=== restart, relay \(relay?.absoluteString ?? "none")\n" + lines.withLock { $0 }.joined(separator: "\n")) }

    let server = RestartingIrohServer(relay: relay)
    try await server.start()
    let serverId = try #require(server.endpoint).id().description
    if relay != nil { await online(server, note) }
    note("server \(serverId.prefix(10)) bound: \(server.endpoint?.boundSockets() ?? [])")
    let addresses = Mutex(server.loopback)
    let transport = relay == nil
      ? IrohTunnelTransport(relays: .disabled, directAddresses: { _ in addresses.withLock { $0 } })
      : IrohTunnelTransport()
    let home = relay ?? deadRelay
    let target = TunnelTarget(endpointId: serverId, relay: home)
    let first = try await transport.bind(secretKey: freshSecret(), homeRelay: home)

    let initial = await Self.attempt(first, target, label: "E1 before the restart", limit: .seconds(20), note)
    let connection = try #require(initial, "the first connection is the precondition of the measurement")
    if relay != nil {
      // Several round trips over a few seconds: the connection can move from the relay to a direct path.
      for _ in 0..<5 {
        try await Task.sleep(for: .seconds(1))
        _ = try await roundTrip(connection, "keep")
      }
      Self.paths(connection, "E1 connection after 5 s", note)
    }
    await Self.cached(first, serverId, "E1 knows the server as", note)

    note("server closes its endpoint")
    await server.close()
    let closed = Task<TunnelFailure, any Error> { await connection.closed() }
    switch await Budget.race(closed, within: .seconds(10)) {
    case .finished: note("E1 connection ended: \((try? await closed.value).map { "\($0)" } ?? "?")")
    case .failed, .timedOut: note("E1 connection still open 10 s after the server closed")
    }
    let down = await Self.attempt(first, target, label: "E1 while the server is down", limit: .seconds(12), note)
    down?.close(code: 0, reason: "")

    try await server.start()
    if relay != nil { await online(server, note) }
    #expect(try #require(server.endpoint).id().description == serverId, "same key, same EndpointId")
    note("server bound again: \(server.endpoint?.boundSockets() ?? [])")
    addresses.withLock { $0 = server.loopback }
    await Self.cached(first, serverId, "E1 knows the server as", note)

    let reused = await Self.attempt(first, target, label: "E1 (reused) after the restart", limit: .seconds(30), note)
    reused?.close(code: 0, reason: "")
    await Self.cached(first, serverId, "E1 knows the server as", note)
    let fresh = try await transport.bind(secretKey: freshSecret(), homeRelay: home)
    let control = await Self.attempt(fresh, target, label: "E2 (fresh) after the restart", limit: .seconds(30), note)
    #expect(control != nil, "a fresh endpoint reaches the restarted server")
    control?.close(code: 0, reason: "")
    let again = await Self.attempt(first, target, label: "E1 (reused) once more", limit: .seconds(30), note)
    again?.close(code: 0, reason: "")

    connection.close(code: 0, reason: "")
    await first.close()
    await fresh.close()
    await server.close()
  }

  /// `online()` of the server within 15 s: without it the relay does not know the server yet.
  func online(_ server: RestartingIrohServer, _ note: @Sendable (String) -> Void) async {
    guard let endpoint = server.endpoint else { return }
    let clock = ContinuousClock()
    let start = clock.now
    let waiting = Task<Void, any Error> { await endpoint.online() }
    let outcome = await Budget.race(waiting, within: .seconds(15))
    note("server online: \(outcome) after \(clock.now - start)")
  }

  /// One `connect` within `limit` and one round trip on the connection; the connection or `nil`. A `connect` still
  /// running after the limit keeps going in Rust (fact 4): its late result lands in the trace and is closed.
  static func attempt(_ endpoint: any TunnelEndpoint, _ target: TunnelTarget, label: String, limit: Duration,
                      _ note: @escaping @Sendable (String) -> Void) async -> (any TunnelConnection)? {
    let clock = ContinuousClock()
    let start = clock.now
    let connecting = Task { try await endpoint.connect(to: target, alpn: IrohWire.alpnBytes) }
    switch await Budget.race(connecting, within: limit) {
    case .finished:
      let connection = try? await connecting.value
      let took = clock.now - start
      guard let connection else { return nil }
      let echo = Task { try await roundTrip(connection, "ping") }
      let ok = await Budget.race(echo, within: .seconds(10)) == .finished
      note("\(label): connected in \(took), round trip \(ok ? "ok" : "failed")")
      paths(connection, label, note)
      return ok ? connection : nil
    case .failed:
      let took = clock.now - start
      let error = await connecting.result
      note("\(label): failed in \(took): \(error)")
      return nil
    case .timedOut:
      note("\(label): no result within \(limit)")
      Task {
        let late = await connecting.result
        note("\(label): late result after \(clock.now - start): \(late)")
        if case let .success(connection) = late { connection.close(code: 0, reason: "late") }
      }
      return nil
    }
  }

  /// Paths of an iroh connection: selected path first, relay or IP, round trip time.
  static func paths(_ connection: any TunnelConnection, _ label: String, _ note: @Sendable (String) -> Void) {
    guard let iroh = connection as? IrohTunnelConnection else { return }
    let paths = iroh.connection.paths().map { path in
      "\(path.isSelected ? "*" : "")\(path.isRelay ? "relay" : "ip") \(path.remoteAddr) \(path.rttMs) ms"
    }
    note("\(label): paths \(paths)")
  }

  /// What the app endpoint has cached about the server (relay and direct addresses).
  static func cached(_ endpoint: any TunnelEndpoint, _ serverId: String, _ label: String,
                     _ note: @Sendable (String) -> Void) async {
    guard let iroh = endpoint as? IrohTunnelEndpoint, let id = try? EndpointId.fromString(s: serverId) else { return }
    guard let addr = await iroh.endpoint.remoteAddr(id: id) else {
      note("\(label): nothing")
      return
    }
    note("\(label): relay \(addr.relayUrl() ?? "none"), direct \(addr.directAddresses())")
  }
}

/// Wyścig zadania z budżetem, jak u wołającego z terminem: kto pierwszy, ten wygrywa, a zadanie biegnie dalej.
enum Budget {
  enum Outcome: Equatable { case finished, failed, timedOut }

  private final class Once: Sendable {
    let continuation = Mutex<CheckedContinuation<Outcome, Never>?>(nil)
  }

  static func race<T: Sendable>(_ task: Task<T, any Error>, within budget: Duration) async -> Outcome {
    let once = Once()
    return await withCheckedContinuation { continuation in
      once.continuation.withLock { $0 = continuation }
      let resume: @Sendable (Outcome) -> Void = { outcome in
        once.continuation.withLock { $0.take() }?.resume(returning: outcome)
      }
      Task {
        do { _ = try await task.value; resume(.finished) } catch { resume(.failed) }
      }
      Task {
        try? await Task.sleep(for: budget)
        resume(.timedOut)
      }
    }
  }
}
