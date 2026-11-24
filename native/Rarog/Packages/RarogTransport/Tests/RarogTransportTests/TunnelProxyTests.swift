import Foundation
import Network
import RarogContract
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Proxy na pętli zwrotnej nad połączeniem tunelu: prawdziwy `NWListener` na `127.0.0.1`, klient TCP
// z `Network.framework` albo `RarogClient`, a po drugiej stronie atrapa tunelu z usterkami. Sprawdza półzamknięcie
// w obie strony, FIN serwera, reset strumienia, przerwanie par z terminem 2 s i liczniki nasłuchów i par.

@Suite("proxy tunelu na pętli zwrotnej", .timeLimit(.minutes(1)))
struct TunnelProxyTests {
  static let relay = URL(string: "https://relay.example/")!
  static let target = TunnelTarget(endpointId: String(repeating: "cd", count: 32), relay: relay)

  @Test("echo 300 kB z półzamknięciem: wszystko wraca, potem FIN, para i sesja znikają")
  func echoWithHalfClose() async throws {
    let (fake, _, proxy, port) = try await Self.started(FakeTunnelScript())
    let client = try await LoopbackTCP.connect(port: port)
    let payload = Data((0 ..< 300_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
    async let echoed = client.receiveToEnd()
    try await client.send(payload)
    try await client.sendFIN()
    #expect(try await echoed == payload)
    try await until("para i sesja zamknięte po FIN w obie strony") {
      fake.counters.pairs == 0 && fake.counters.sessions == 0
    }
    #expect(await proxy.close(code: 0))
    #expect(fake.counters.listeners == 0)
  }

  @Test("FIN serwera → FIN do klienta od razu, kierunek klienta zostaje otwarty")
  func serverFinIsImmediate() async throws {
    let received = AsyncStream<Data>.makeStream()
    var script = FakeTunnelScript()
    script.server = .custom { stream in
      try? await stream.write(Data("odpowiedź".utf8))
      stream.finish()
      received.continuation.yield((try? await stream.readToEnd()) ?? Data())
    }
    let (fake, _, proxy, port) = try await Self.started(script)
    let client = try await LoopbackTCP.connect(port: port)
    let started = ContinuousClock.now
    #expect(try await client.receiveToEnd() == Data("odpowiedź".utf8))
    #expect(ContinuousClock.now - started < .seconds(1))
    try await client.send(Data("po FIN serwera".utf8))
    try await client.sendFIN()
    var iterator = received.stream.makeAsyncIterator()
    #expect(await iterator.next() == Data("po FIN serwera".utf8))
    try await until("para zamknięta") { fake.counters.pairs == 0 }
    #expect(await proxy.close(code: 0))
  }

  @Test("reset strumienia przez serwer → para przerwana w ≤ 2 s, klient widzi zerwanie, bez abortTimedOut")
  func serverResetAbortsPair() async throws {
    var script = FakeTunnelScript()
    script.server = .silent
    script.stream = { _ in .reset(afterBytes: 5) }
    let (fake, _, proxy, port) = try await Self.started(script)
    let client = try await LoopbackTCP.connect(port: port)
    let started = ContinuousClock.now
    try await client.send(Data("dziesięć b".utf8))
    let end = await client.receiveEnd()
    #expect(ContinuousClock.now - started < .seconds(2))
    #expect(end.data.isEmpty)
    try await until("para przerwana", limit: .seconds(2)) { fake.counters.pairs == 0 && fake.counters.sessions == 0 }
    #expect(await proxy.close(code: 0))
    #expect(await proxy.events.first { _ in true } == nil)
  }

  @Test("oba kierunki zablokowane bez sygnału serwera → abortTimedOut po 2 s; zamknięcie połączenia sprząta")
  func blockedBothTimesOut() async throws {
    var script = FakeTunnelScript()
    script.stream = { _ in .blockedBoth }
    let clock = FakeTunnelClock()
    let fake = FakeTunnelTransport(clock: clock, script: script)
    let connection = try await Self.connection(fake)
    let proxy = TunnelProxy(connection: connection, counters: fake.proxyCounters, sleep: clock.sleep)
    let port = try await proxy.start()
    let client = try await LoopbackTCP.connect(port: port)
    try await client.send(Data("żądanie".utf8))
    try await until("para i sesja otwarte") { fake.counters.pairs == 1 && fake.counters.sessions == 1 }

    let closing = Task { await proxy.close(code: 0) }
    #expect(await clock.waitForSleepers(2))  // termin zamknięcia i termin przerwania pary
    #expect(await client.receiveEnd().data.isEmpty)  // klient lokalny zerwany od razu
    clock.advance(by: .milliseconds(1999))
    try await Task.sleep(for: .milliseconds(50))
    #expect(fake.counters.pairs == 1)
    clock.advance(by: .milliseconds(1))
    #expect(await closing.value == false)
    var events = proxy.events.makeAsyncIterator()
    #expect(await events.next() == .abortTimedOut)
    #expect(fake.liveConnections.count == 1)  // proxy nie zamyka połączenia sam
    #expect(fake.counters.listeners == 0)

    connection.close(code: 0, reason: "abortTimedOut")  // po stronie apki, bez udziału serwera
    try await until("para i sesja zamknięte po zamknięciu połączenia") {
      fake.counters.pairs == 0 && fake.counters.sessions == 0
    }
  }

  @Test("reset w trakcie POST → błąd transportu klienta, nie .cancelled")
  func resetDuringPost() async throws {
    var script = FakeTunnelScript()
    script.server = .http { _ in .json(200, #"{"ok":true}"#) }
    let opened = Mutex(0)
    script.stream = { _ in
      opened.withLock { $0 += 1 }
      return .reset(afterBytes: 4096)
    }
    let (fake, _, proxy, port) = try await Self.started(script)
    let client = RarogClient(config: .test(port: port))
    let body = NotesPutBody(cwd: "/tmp/projekt", text: String(repeating: "a", count: 200_000), updatedAt: 1)
    let outcome: TransportError?
    do {
      _ = try await client.saveNotes(body)
      outcome = nil
    } catch {
      outcome = error
    }
    let error = try #require(outcome)
    #expect(opened.withLock { $0 } >= 1)  // żądanie doszło do strumienia tunelu
    #expect(error != .cancelled)
    guard case .offline = error else {
      Issue.record("oczekiwany .offline, jest \(error)")
      return
    }
    client.invalidate()
    try await until("pary zamknięte") { fake.counters.pairs == 0 }
    #expect(await proxy.close(code: 0))
  }

  @Test("klient lokalny zrywa połączenie → abort strumienia tunelu")
  func localResetAbortsStream() async throws {
    var script = FakeTunnelScript()
    script.server = .silent
    let (fake, connection, proxy, port) = try await Self.started(script)
    let client = try await LoopbackTCP.connect(port: port)
    try await client.send(Data("upload".utf8))
    try await until("sesja otwarta") { fake.counters.sessions == 1 }
    client.reset()
    try await until("para i sesja zamknięte") { fake.counters.pairs == 0 && fake.counters.sessions == 0 }
    _ = connection
    #expect(await proxy.close(code: 0))
  }

  @Test("openStream pada → klient lokalny zamknięty, para policzona i zwolniona")
  func openStreamFailure() async throws {
    var script = FakeTunnelScript()
    script.openStream = { _ in .fail(.unavailable("limit strumieni")) }
    let (fake, _, proxy, port) = try await Self.started(script)
    let client = try await LoopbackTCP.connect(port: port)
    #expect(await client.receiveEnd().data.isEmpty)
    try await until("para zwolniona") { fake.counters.pairs == 0 }
    #expect(await proxy.close(code: 0))
  }

  @Test("liczniki nasłuchów i par wracają do zera po zamknięciu; port po zamknięciu nie przyjmuje")
  func countersReturnToZero() async throws {
    var script = FakeTunnelScript()
    script.server = .silent
    let (fake, _, proxy, port) = try await Self.started(script)
    #expect(fake.counters.listeners == 1)
    var clients: [LoopbackTCP] = []
    for _ in 0 ..< 3 {
      let client = try await LoopbackTCP.connect(port: port)
      try await client.send(Data("x".utf8))
      clients.append(client)
    }
    try await until("trzy pary") { fake.counters.pairs == 3 && fake.counters.sessions == 3 }
    #expect(await proxy.close(code: 0))
    let counters = fake.counters
    #expect(counters.listeners == 0)
    #expect(counters.pairs == 0)
    try await until("sesje zamknięte") { fake.counters.sessions == 0 }
    for client in clients { #expect(await client.receiveEnd().data.isEmpty) }
    await #expect(throws: (any Error).self) { try await LoopbackTCP.connect(port: port, limit: .seconds(2)) }
    #expect(await proxy.close(code: 0))  // drugie zamknięcie: nic do zrobienia
  }

  @Test("a stopped listener drops its handlers and is let go while the proxy lives on")
  func stoppedListenerReleased() async throws {
    let (_, _, proxy, _) = try await Self.started(FakeTunnelScript())
    var held = proxy.listener
    weak var listener = held
    #expect(held?.stateUpdateHandler != nil && held?.newConnectionHandler != nil)
    #expect(await proxy.close(code: 0))
    #expect(held?.stateUpdateHandler == nil && held?.newConnectionHandler == nil, "handlers dropped at .cancelled")
    held = nil
    try await until("listener released", limit: .seconds(5)) { listener == nil }
    #expect(proxy.listener == nil && proxy.port != nil, "the proxy is still here, without its listener")
  }

  static func connection(_ fake: FakeTunnelTransport) async throws -> any TunnelConnection {
    let endpoint = try await fake.bind(secretKey: Data(repeating: 7, count: 32), homeRelay: relay)
    return try await endpoint.connect(to: target, alpn: IrohWire.alpnBytes)
  }

  static func started(
    _ script: FakeTunnelScript
  ) async throws -> (FakeTunnelTransport, any TunnelConnection, TunnelProxy, Int) {
    let fake = FakeTunnelTransport(script: script)
    let connection = try await connection(fake)
    let proxy = TunnelProxy(connection: connection, counters: fake.proxyCounters)
    let port = try await proxy.start()
    return (fake, connection, proxy, port)
  }
}

/// Klient TCP na `127.0.0.1` z `Network.framework`: wysyłka z potwierdzeniem, FIN, odczyt do końca.
final class LoopbackTCP: Sendable {
  private let connection: NWConnection

  private init(connection: NWConnection) {
    self.connection = connection
  }

  static func connect(port: Int, limit: Duration = .seconds(5)) async throws -> LoopbackTCP {
    let options = NWProtocolTCP.Options()
    options.connectionTimeout = Int(limit.components.seconds)
    let connection = NWConnection(
      host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: NWParameters(tls: nil, tcp: options)
    )
    let resumed = Mutex(false)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      connection.stateUpdateHandler = { state in
        let outcome: Result<Void, any Error>? = switch state {
        case .ready: .success(())
        case let .failed(error), let .waiting(error): .failure(error)
        case .cancelled: .failure(NWError.posix(.ECANCELED))
        default: nil
        }
        guard let outcome, resumed.withLock({ done in defer { done = true }; return !done }) else { return }
        if case .failure = outcome { connection.cancel() }
        continuation.resume(with: outcome)
      }
      connection.start(queue: DispatchQueue(label: "rarog.test.tunnel-proxy-client"))
    }
    return LoopbackTCP(connection: connection)
  }

  func send(_ data: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      })
    }
  }

  func sendFIN() async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      })
    }
  }

  /// Zerwanie bez FIN.
  func reset() {
    connection.forceCancel()
  }

  /// Wszystko do FIN; błąd przed FIN rzuca.
  func receiveToEnd(sourceLocation: SourceLocation = #_sourceLocation) async throws -> Data {
    let end = await receiveEnd(sourceLocation: sourceLocation)
    if let error = end.error { throw error }
    return end.data
  }

  /// Bajty do FIN albo błędu i ten błąd. Bez końca w terminie test dostaje porażkę, a połączenie jest zrywane
  /// (zawieszony odczyt nie wstrzymuje całego przebiegu).
  func receiveEnd(
    limit: Duration = .seconds(10),
    sourceLocation: SourceLocation = #_sourceLocation
  ) async -> (data: Data, error: NWError?) {
    let timedOut = Mutex(false)
    let watchdog = Task { [connection] in
      try await Task.sleep(for: limit)
      timedOut.withLock { $0 = true }
      connection.forceCancel()
    }
    defer { watchdog.cancel() }
    var all = Data()
    while true {
      let (chunk, complete, error) = await receive()
      if let chunk { all.append(chunk) }
      if error != nil || complete {
        if timedOut.withLock({ $0 }) { Issue.record("brak końca odczytu w terminie", sourceLocation: sourceLocation) }
        return (all, error)
      }
    }
  }

  private func receive() async -> (Data?, Bool, NWError?) {
    await withCheckedContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, complete, error in
        continuation.resume(returning: (data, complete, error))
      }
    }
  }
}
