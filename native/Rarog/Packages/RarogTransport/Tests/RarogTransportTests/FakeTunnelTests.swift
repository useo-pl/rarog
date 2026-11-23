import Foundation
import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Atrapa tunelu z usterkami, na której stoją testy proxy, lease, runtime i przełącznika transportu. Test sprawdza
// każdą usterkę z osobna: czasy wywołań natywnych na sztucznym zegarze (`delay`, `late`, `never`, `bindTakes`,
// `closeTakes`), usterki strumienia (`reset`, `fin`, `blockedBoth`), sondę `probeFails` na serwerze HTTP atrapy
// i liczniki stanu ustalonego.

@Suite("atrapa tunelu: usterki, zegar i liczniki", .timeLimit(.minutes(1)))
struct FakeTunnelTests {
  static let relay = URL(string: "https://relay.example/")!
  static let keyA = Data(repeating: 0xA1, count: 32)
  static let keyB = Data(repeating: 0xB2, count: 32)
  static let target = TunnelTarget(endpointId: String(repeating: "cd", count: 32), relay: relay)
  static let alpn = Data("rarog-http/1".utf8)

  @Test("zegar: sen kończy krok czasu, anulowanie kończy go od razu")
  func clock() async throws {
    let clock = FakeTunnelClock()
    let sleeper = Task { try await clock.sleep(for: .seconds(2)) }
    #expect(await clock.waitForSleepers(1))
    clock.advance(by: .milliseconds(1999))
    #expect(clock.sleepers == 1)
    clock.advance(by: .milliseconds(1))
    try await sleeper.value
    #expect(clock.now == .seconds(2))

    let cancelled = Task { try await clock.sleep(for: .seconds(60)) }
    #expect(await clock.waitForSleepers(1))
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    #expect(clock.sleepers == 0)
  }

  @Test("bindTakes: bind na kluczu wisi do kroku zegara, liczniki na klucz i szczyt endpointów")
  func bindTakes() async throws {
    var script = FakeTunnelScript()
    script.bind = { _ in .delay(.milliseconds(300)) }
    let fake = FakeTunnelTransport(script: script)
    let keyA = FakeTunnelTransport.key(Self.keyA)
    let pending = Task { try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay) }
    #expect(await fake.clock.waitForSleepers(1))
    #expect(fake.counters.bindsInFlight(keyA) == 1)
    #expect(fake.counters.endpointsAlive == 0)
    fake.clock.advance(by: .milliseconds(300))
    let first = try await pending.value
    #expect(first.endpointId == keyA)
    #expect(fake.counters.bindsInFlight(keyA) == 0)

    fake.configure { $0.bind = { _ in .immediate } }
    let second = try await fake.bind(secretKey: Self.keyB, homeRelay: Self.relay)
    var counters = fake.counters
    #expect(counters.endpointsAlive == 2)
    #expect(counters.endpointsPeak == 2)
    #expect(counters.bindStarted == [keyA: 1, FakeTunnelTransport.key(Self.keyB): 1])
    #expect(counters.bindsInFlightPeak[keyA] == 1)
    await first.close()
    await second.close()
    await second.close()  // drugie zamknięcie nic nie liczy
    counters = fake.counters
    #expect(counters.endpointsAlive == 0)
    #expect(counters.endpointsPeak == 2)
    #expect(counters.bindsSettled)
  }

  @Test("never: bind nie wraca mimo anulowania, zwolnienie przez test kończy go błędem i domyka licznik")
  func bindNever() async throws {
    var script = FakeTunnelScript()
    script.bind = { _ in .never }
    let fake = FakeTunnelTransport(script: script)
    let key = FakeTunnelTransport.key(Self.keyA)
    let pending = Task { try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay) }
    try await until("bind wisi") { fake.counters.hanging == 1 }
    pending.cancel()
    try await Task.sleep(for: .milliseconds(50))
    #expect(fake.counters.bindsInFlight(key) == 1)
    fake.releaseHanging()
    await #expect(throws: TunnelFailure.unavailable("call released by the test")) { try await pending.value }
    #expect(fake.counters.bindsInFlight(key) == 0)
    #expect(fake.counters.hanging == 0)
    #expect(fake.counters.endpointsAlive == 0)
  }

  @Test("closeTakes: endpoint żyje, dopóki zamknięcie nie wróci (krok zegara albo zwolnienie)")
  func closeTakes() async throws {
    var script = FakeTunnelScript()
    script.endpointClose = { $0 == 0 ? .delay(.seconds(8)) : .never }
    let fake = FakeTunnelTransport(script: script)
    let slow = try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay)
    let closing = Task { await slow.close() }
    #expect(await fake.clock.waitForSleepers(1))
    closing.cancel()  // zamknięcie nie zna anulowania
    #expect(fake.counters.endpointsAlive == 1)
    fake.clock.advance(by: .seconds(8))
    await closing.value
    #expect(fake.counters.endpointsAlive == 0)

    let stuck = try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay)
    let hanging = Task { await stuck.close() }
    try await until("zamknięcie wisi") { fake.counters.hanging == 1 }
    #expect(fake.counters.endpointsAlive == 1)
    fake.releaseHanging()
    await hanging.value
    #expect(fake.counters.endpointsAlive == 0)
  }

  @Test("late: connect oddaje połączenie po terminie mimo anulowania wołającego; delay anulowanie przerywa")
  func connectLateAndDelay() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .late(.seconds(11)) : .delay(.seconds(5)) }
    let fake = FakeTunnelTransport(script: script)
    let endpoint = try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay)
    let late = Task { try await endpoint.connect(to: Self.target, alpn: Self.alpn) }
    #expect(await fake.clock.waitForSleepers(1))
    late.cancel()
    fake.clock.advance(by: .seconds(11))
    let connection = try await late.value  // spóźniony wynik: wołający musi go zamknąć
    #expect(fake.counters.connections == 1)
    connection.close(code: 0, reason: "spóźniony wynik")
    #expect(fake.counters.connections == 0)

    let delayed = Task { try await endpoint.connect(to: Self.target, alpn: Self.alpn) }
    #expect(await fake.clock.waitForSleepers(1))
    delayed.cancel()
    await #expect(throws: CancellationError.self) { try await delayed.value }
    #expect(fake.counters.connections == 0)
    let fakeEndpoint = try #require(fake.endpoints.first)
    #expect(fakeEndpoint.targets == [Self.target, Self.target])
    #expect(fakeEndpoint.alpns == [Self.alpn, Self.alpn])
  }

  @Test("scenariusz po numerze wywołania: dwa connect padają, trzeci łączy; ensureRelay dopisuje relay")
  func scriptByCall() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 < 2 ? .fail(.connectFailed("relay milczy")) : .immediate }
    let fake = FakeTunnelTransport(script: script)
    let endpoint = try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay)
    for _ in 0 ..< 2 {
      await #expect(throws: TunnelFailure.connectFailed("relay milczy")) {
        try await endpoint.connect(to: Self.target, alpn: Self.alpn)
      }
    }
    let connection = try await endpoint.connect(to: Self.target, alpn: Self.alpn)
    let other = URL(string: "https://relay.other/")!
    try await endpoint.ensureRelay(other)
    try await endpoint.ensureRelay(other)
    #expect(fake.endpoints.first?.relays == [Self.relay, other])
    await endpoint.close()  // zamknięcie endpointu zamyka jego połączenia
    #expect(await connection.closed() == .closed(code: 0, reason: "endpoint closed"))
    #expect(fake.counters.connections == 0)
    await #expect(throws: TunnelFailure.unavailable("endpoint closed")) {
      try await endpoint.connect(to: Self.target, alpn: Self.alpn)
    }
  }

  @Test("connect równo z zamknięciem endpointu (300 prób): po każdej zero żywych połączeń i licznik 0")
  func connectRacingEndpointClose() async throws {
    for _ in 0 ..< 300 {
      let fake = FakeTunnelTransport(script: FakeTunnelScript())
      let endpoint = try await fake.bind(secretKey: Self.keyA, homeRelay: Self.relay)
      async let connected: (any TunnelConnection)? = try? endpoint.connect(to: Self.target, alpn: Self.alpn)
      async let closing: Void = endpoint.close()
      let connection = await connected
      await closing
      if let connection { _ = await connection.closed() }
      #expect(fake.liveConnections.isEmpty)
      #expect(fake.counters.connections == 0)
    }
  }

  @Test("okno strumienia: zapis czeka, aż serwer odczyta; echo oddaje bajty i FIN")
  func streamWindowAndEcho() async throws {
    let release = AsyncStream<Void>.makeStream()
    var script = FakeTunnelScript()
    script.streamWindow = 1024
    script.server = .custom { stream in
      for await _ in release.stream { break }
      while let chunk = try? await stream.read(), !chunk.isEmpty {
        try? await stream.write(chunk)
      }
      stream.finish()
    }
    let (fake, connection) = try await Self.connected(script)
    let stream = try await connection.openStream()
    try await stream.write(Data(repeating: 1, count: 1024))  // okno pełne
    let blocked = Task { try await stream.write(Data(repeating: 2, count: 10)) }
    try await Task.sleep(for: .milliseconds(50))
    #expect(fake.counters.sessions == 1)
    release.continuation.yield()
    let reader = Task {
      var all = Data()
      while true {
        let chunk = try await stream.read(maxBytes: 300)
        if chunk.isEmpty { return all }
        all.append(chunk)
      }
    }
    try await blocked.value
    try await stream.finish()
    let echoed = try await reader.value
    #expect(echoed == Data(repeating: 1, count: 1024) + Data(repeating: 2, count: 10))
    try await until("sesja zamknięta po FIN w obie strony") { fake.counters.sessions == 0 }
  }

  @Test("reset i fin po N bajtach żądania: odczyt apki rzuca albo dostaje FIN")
  func resetAndFin() async throws {
    var script = FakeTunnelScript()
    script.server = .silent
    script.stream = { $0 == 0 ? .reset(afterBytes: 10, code: 4) : .fin(afterBytes: 0) }
    let (fake, connection) = try await Self.connected(script)
    let reset = try await connection.openStream()
    try await reset.write(Data(repeating: 0, count: 6))
    try await reset.write(Data(repeating: 0, count: 6))
    await #expect(throws: TunnelFailure.closed(code: 4, reason: "stream reset by the server")) {
      try await reset.read(maxBytes: 100)
    }
    await #expect(throws: TunnelFailure.self) { try await reset.write(Data([1])) }
    let fin = try await connection.openStream()
    #expect(try await fin.read(maxBytes: 100).isEmpty)  // FIN serwera od razu
    try await fin.write(Data("po FIN serwera".utf8))  // półzamknięcie: kierunek apki wciąż otwarty
    try await fin.finish()
    try await until("obie sesje zamknięte") { fake.counters.sessions == 0 }
  }

  @Test("blockedBoth: odczyt i zapis wiszą, abort ich nie budzi, zamknięcie połączenia tak")
  func blockedBoth() async throws {
    var script = FakeTunnelScript()
    script.stream = { _ in .blockedBoth }
    let (fake, connection) = try await Self.connected(script)
    let stream = try await connection.openStream()
    let reading = Task { try await stream.read(maxBytes: 100) }
    let writing = Task { try await stream.write(Data([1, 2, 3])) }
    await stream.abort(code: 0)
    try await Task.sleep(for: .milliseconds(100))
    #expect(fake.counters.sessions == 1)
    connection.close(code: 0, reason: "koniec generacji")
    await #expect(throws: TunnelFailure.closed(code: 0, reason: "koniec generacji")) { try await reading.value }
    await #expect(throws: TunnelFailure.closed(code: 0, reason: "koniec generacji")) { try await writing.value }
    try await until("sesja zamknięta") { fake.counters.sessions == 0 }
    #expect(fake.counters.connections == 0)
  }

  @Test("probeFails: sonda GET /api/version pada resetem strumienia, następna dostaje odpowiedź HTTP")
  func probeFails() async throws {
    var script = FakeTunnelScript()
    script.probeFails = { $0 == 0 }
    script.server = .http { request in .json(200, #"{"path":"\#(request.path)"}"#) }
    let (fake, connection) = try await Self.connected(script)
    let request = Data("GET /api/version HTTP/1.1\r\nHost: x\r\n\r\n".utf8)

    let failed = try await connection.openStream()
    try await failed.write(request)
    await #expect(throws: TunnelFailure.self) { try await failed.read(maxBytes: 1000) }

    let answered = try await connection.openStream()
    try await answered.write(request)
    try await answered.finish()
    var reply = Data()
    while true {
      let chunk = try await answered.read(maxBytes: 1000)
      if chunk.isEmpty { break }
      reply.append(chunk)
    }
    let text = String(decoding: reply, as: UTF8.self)
    #expect(text.hasPrefix("HTTP/1.1 200 OK\r\n"))
    #expect(text.hasSuffix(#"{"path":"/api/version"}"#))
    #expect(fake.counters.probes == 2)
  }

  @Test("serwer zamyka połączenie: closed() oddaje powód, strumienie padają, liczniki wracają do zera")
  func serverDropsConnection() async throws {
    var script = FakeTunnelScript()
    script.server = .silent
    let (fake, connection) = try await Self.connected(script)
    let stream = try await connection.openStream()
    let reading = Task { try await stream.read(maxBytes: 10) }
    fake.dropConnections(code: 3, reason: "serwer wyłączony")
    #expect(await connection.closed() == .closed(code: 3, reason: "serwer wyłączony"))
    await #expect(throws: TunnelFailure.closed(code: 3, reason: "serwer wyłączony")) { try await reading.value }
    await #expect(throws: TunnelFailure.closed(code: 3, reason: "serwer wyłączony")) {
      try await connection.openStream()
    }
    try await until("zero połączeń i sesji") { fake.counters.connections == 0 && fake.counters.sessions == 0 }
  }

  static func connected(_ script: FakeTunnelScript) async throws -> (FakeTunnelTransport, any TunnelConnection) {
    let fake = FakeTunnelTransport(script: script)
    let endpoint = try await fake.bind(secretKey: keyA, homeRelay: relay)
    return (fake, try await endpoint.connect(to: target, alpn: alpn))
  }
}

/// Czeka w czasie rzeczywistym (do `limit`) na warunek; po terminie zgłasza porażkę z opisem.
func until(
  _ what: String,
  limit: Duration = .seconds(5),
  sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () -> Bool
) async throws {
  let deadline = ContinuousClock.now + limit
  while !condition() {
    guard ContinuousClock.now < deadline else {
      Issue.record("nie doczekano: \(what)", sourceLocation: sourceLocation)
      return
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}
