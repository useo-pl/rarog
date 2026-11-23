import Foundation
import RarogTransport
import Synchronization

// Atrapa tunelu iroh z usterkami do testów wszystkich warstw nad protokołami tunelu (proxy, lease, runtime,
// przełącznik transportu). Bez sieci i bez IrohLib: endpoint, połączenie i strumienie żyją w pamięci, serwer
// atrapy obsługuje strumienie (echo, HTTP/1.1, własna obsługa), a czas płynie na ``FakeTunnelClock``.
// Liczniki odpowiadają kryteriom stanu ustalonego: endpointy żywe i szczytowe, `bind` rozpoczęte i zakończone
// na klucz, połączenia, sesje (otwarte strumienie) oraz nasłuchy i pary proxy (``proxyCounters``).

/// Przebieg jednego wywołania natywnego atrapy (`bind`, `connect`, `openStream`, zamknięcie endpointu).
public enum FakeCall: Sendable, Equatable {
  /// Sukces od razu.
  case immediate
  /// Porażka od razu.
  case fail(TunnelFailure)
  /// Sukces po czasie zegara atrapy; anulowanie zadania wołającego przerywa czekanie (`CancellationError`).
  case delay(Duration)
  /// Wynik po czasie zegara bez względu na anulowanie (wywołanie natywne, które nie zna anulowania):
  /// `failure == nil` = sukces, czyli zasób, który wołający musi zamknąć, choć już na niego nie czeka.
  case late(Duration, failure: TunnelFailure? = nil)
  /// Nie wraca, dopóki test nie wywoła ``FakeTunnelTransport/releaseHanging()``; anulowanie go nie kończy.
  case never
}

/// Jak serwer atrapy obsługuje każdy otwarty strumień.
public enum FakeTunnelServer: Sendable {
  /// Oddaje każdy bajt; FIN po FIN apki.
  case echo
  /// Czyta i nie odpowiada.
  case silent
  /// Serwer HTTP/1.1 z keep-alive (``FakeHTTPRequest`` → ``FakeHTTPResponse``); sonda `GET /api/version`
  /// podlega ``FakeTunnelScript/probeFails``.
  case http(@Sendable (FakeHTTPRequest) async -> FakeHTTPResponse)
  /// Własna obsługa strumienia.
  case custom(@Sendable (FakeServerStream) async -> Void)
}

/// Scenariusz atrapy. Domknięcia dostają numer wywołania danego rodzaju (od 0), więc „pierwsze trzy `connect`
/// padają” to `{ $0 < 3 ? .fail(...) : .immediate }`.
public struct FakeTunnelScript: Sendable {
  public var bind: @Sendable (_ call: Int) -> FakeCall = { _ in .immediate }
  /// Zamknięcie endpointu (`closeTakes`): `.delay` i `.late` czekają bez względu na anulowanie, `.fail` = od razu.
  public var endpointClose: @Sendable (_ call: Int) -> FakeCall = { _ in .immediate }
  public var connect: @Sendable (_ call: Int) -> FakeCall = { _ in .immediate }
  public var openStream: @Sendable (_ call: Int) -> FakeCall = { _ in .immediate }
  /// Usterka strumienia o danym numerze (od 0 w całym transporcie).
  public var stream: @Sendable (_ index: Int) -> FakeStreamFault? = { _ in nil }
  /// Czy sonda o danym numerze (`GET /api/version` na serwerze HTTP) pada resetem strumienia.
  public var probeFails: @Sendable (_ probe: Int) -> Bool = { _ in false }
  public var server: FakeTunnelServer = .echo
  /// Okno strumienia w bajtach na kierunek: zapis czeka, gdy druga strona tyle nie odczytała.
  public var streamWindow = 64 * 1024

  public init() {}
}

/// Migawka liczników atrapy.
public struct FakeTunnelCounters: Sendable, Equatable {
  public var endpointsAlive = 0
  public var endpointsPeak = 0
  /// `bind` rozpoczęte i zakończone (sukcesem albo błędem) na klucz (``FakeTunnelTransport/key(_:)``).
  public var bindStarted: [String: Int] = [:]
  public var bindReturned: [String: Int] = [:]
  /// Szczyt niezakończonych `bind` na klucz.
  public var bindsInFlightPeak: [String: Int] = [:]
  public var connections = 0
  public var connectionsPeak = 0
  /// Otwarte strumienie (jedna sesja HTTP/1.1 na strumień).
  public var sessions = 0
  /// Sondy `GET /api/version`, które dotarły do serwera HTTP atrapy.
  public var probes = 0
  /// Wywołania `.never`, które wciąż wiszą.
  public var hanging = 0
  /// Z ``FakeTunnelTransport/proxyCounters``.
  public var listeners = 0
  public var pairs = 0

  /// Niezakończone `bind` na klucz.
  public func bindsInFlight(_ key: String) -> Int {
    (bindStarted[key] ?? 0) - (bindReturned[key] ?? 0)
  }

  /// Wszystkie `bind` zakończone.
  public var bindsSettled: Bool { bindStarted.keys.allSatisfy { bindsInFlight($0) == 0 } }
}

public final class FakeTunnelTransport: TunnelTransport {
  private struct State {
    var script: FakeTunnelScript
    var counters = FakeTunnelCounters()
    var calls: [String: Int] = [:]
    var nextStream = 0
    var hanging: [Int: CheckedContinuation<Void, Never>] = [:]
    var nextHanging = 0
    var endpoints: [FakeTunnelEndpoint] = []
    var connections: [ObjectIdentifier: FakeTunnelConnection] = [:]
  }

  public let clock: FakeTunnelClock
  /// Liczniki proxy: test przekazuje je do każdego ``TunnelProxy`` nad połączeniami atrapy.
  public let proxyCounters: TunnelProxyCounters
  private let state: Mutex<State>

  public init(
    clock: FakeTunnelClock = FakeTunnelClock(),
    proxyCounters: TunnelProxyCounters = TunnelProxyCounters(),
    script: FakeTunnelScript = FakeTunnelScript()
  ) {
    self.clock = clock
    self.proxyCounters = proxyCounters
    state = Mutex(State(script: script))
  }

  /// Klucz liczników `bind`: hex klucza tajnego (64 znaki dla 32 B, jak EndpointId).
  public static func key(_ secretKey: Data) -> String {
    secretKey.map { String(format: "%02x", $0) }.joined()
  }

  /// Zmiana scenariusza w trakcie testu.
  public func configure(_ body: (inout FakeTunnelScript) -> Void) {
    state.withLock { body(&$0.script) }
  }

  public var counters: FakeTunnelCounters {
    var snapshot = state.withLock { state in
      var counters = state.counters
      counters.hanging = state.hanging.count
      return counters
    }
    snapshot.listeners = proxyCounters.listeners
    snapshot.pairs = proxyCounters.pairs
    return snapshot
  }

  /// Endpointy w kolejności `bind`.
  public var endpoints: [FakeTunnelEndpoint] { state.withLock { $0.endpoints } }

  /// Żywe połączenia (niezamknięte).
  public var liveConnections: [FakeTunnelConnection] { state.withLock { Array($0.connections.values) } }

  /// Kończy każde wiszące wywołanie `.never`: `bind`, `connect` i `openStream` rzucają `.unavailable`,
  /// zamknięcie endpointu wraca.
  public func releaseHanging() {
    let woken = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      defer { state.hanging.removeAll() }
      return Array(state.hanging.values)
    }
    for continuation in woken { continuation.resume() }
  }

  /// Serwer resetuje każdy otwarty strumień.
  public func resetStreams(code: UInt64 = 0) {
    for connection in liveConnections { connection.resetStreams(code: code) }
  }

  /// Serwer zamyka każde żywe połączenie (`closed()` oddaje powód, strumienie padają).
  public func dropConnections(code: UInt64? = nil, reason: String = "connection closed by the server") {
    for connection in liveConnections { connection.end(.closed(code: code, reason: reason)) }
  }

  public func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint {
    let key = Self.key(secretKey)
    let call = state.withLock { state -> FakeCall in
      state.counters.bindStarted[key, default: 0] += 1
      let inFlight = state.counters.bindsInFlight(key)
      state.counters.bindsInFlightPeak[key] = max(state.counters.bindsInFlightPeak[key] ?? 0, inFlight)
      return state.script.bind(nextCall("bind", &state))
    }
    do {
      try await perform(call)
    } catch {
      state.withLock { $0.counters.bindReturned[key, default: 0] += 1 }
      throw error
    }
    let endpoint = FakeTunnelEndpoint(transport: self, endpointId: key, homeRelay: homeRelay)
    state.withLock { state in
      state.counters.bindReturned[key, default: 0] += 1
      state.counters.endpointsAlive += 1
      state.counters.endpointsPeak = max(state.counters.endpointsPeak, state.counters.endpointsAlive)
      state.endpoints.append(endpoint)
    }
    return endpoint
  }

  // MARK: - Dla endpointu, połączenia i serwera

  var script: FakeTunnelScript { state.withLock { $0.script } }

  func nextCall(_ kind: String) -> Int {
    state.withLock { nextCall(kind, &$0) }
  }

  private func nextCall(_ kind: String, _ state: inout State) -> Int {
    defer { state.calls[kind, default: 0] += 1 }
    return state.calls[kind, default: 0]
  }

  func nextProbe() -> Int {
    state.withLock { state in
      defer { state.counters.probes += 1 }
      return state.counters.probes
    }
  }

  func nextStreamIndex() -> Int {
    state.withLock { state in
      defer { state.nextStream += 1 }
      return state.nextStream
    }
  }

  func endpointClosed() {
    state.withLock { $0.counters.endpointsAlive -= 1 }
  }

  func connectionOpened(_ connection: FakeTunnelConnection) {
    state.withLock { state in
      state.connections[ObjectIdentifier(connection)] = connection
      state.counters.connections += 1
      state.counters.connectionsPeak = max(state.counters.connectionsPeak, state.counters.connections)
    }
  }

  func connectionClosed(_ connection: FakeTunnelConnection) {
    state.withLock { state in
      guard state.connections.removeValue(forKey: ObjectIdentifier(connection)) != nil else { return }
      state.counters.connections -= 1
    }
  }

  func sessionOpened() { state.withLock { $0.counters.sessions += 1 } }
  func sessionEnded() { state.withLock { $0.counters.sessions -= 1 } }

  /// Wykonuje przebieg wywołania rzucającego.
  func perform(_ call: FakeCall) async throws {
    switch call {
    case .immediate: return
    case let .fail(failure): throw failure
    case let .delay(duration): try await clock.sleep(for: duration)
    case let .late(duration, failure):
      await clock.sleepIgnoringCancellation(for: duration)
      if let failure { throw failure }
    case .never:
      await hang()
      throw TunnelFailure.unavailable("call released by the test")
    }
  }

  /// Wykonuje przebieg wywołania bez błędu (zamknięcie endpointu): każde czekanie ignoruje anulowanie.
  func performClose(_ call: FakeCall) async {
    switch call {
    case .immediate, .fail: return
    case let .delay(duration), let .late(duration, _): await clock.sleepIgnoringCancellation(for: duration)
    case .never: await hang()
    }
  }

  private func hang() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      state.withLock { state in
        state.hanging[state.nextHanging] = continuation
        state.nextHanging += 1
      }
    }
  }
}

/// Endpoint atrapy: EndpointId = hex klucza tajnego.
public final class FakeTunnelEndpoint: TunnelEndpoint {
  private struct State {
    var closed = false
    var relays: [URL]
    var targets: [TunnelTarget] = []
    var alpns: [Data] = []
    var connections: [FakeTunnelConnection] = []
  }

  public let endpointId: String
  private let transport: FakeTunnelTransport
  private let state: Mutex<State>

  init(transport: FakeTunnelTransport, endpointId: String, homeRelay: URL) {
    self.transport = transport
    self.endpointId = endpointId
    state = Mutex(State(relays: [homeRelay]))
  }

  /// Relaye endpointu: domowy i dopisane przez `ensureRelay`.
  public var relays: [URL] { state.withLock { $0.relays } }
  /// Cele i ALPN kolejnych `connect`.
  public var targets: [TunnelTarget] { state.withLock { $0.targets } }
  public var alpns: [Data] { state.withLock { $0.alpns } }
  public var isClosed: Bool { state.withLock { $0.closed } }

  public func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection {
    let closed = state.withLock { state -> Bool in
      state.targets.append(target)
      state.alpns.append(alpn)
      return state.closed
    }
    guard !closed else { throw TunnelFailure.unavailable("endpoint closed") }
    try await transport.perform(transport.script.connect(transport.nextCall("connect")))
    let connection = FakeTunnelConnection(transport: transport)
    // Najpierw rejestr transportu, potem endpoint: `close()` endpointu widzi połączenie dopiero, gdy transport już je
    // zna, więc jego `end` zawsze zdejmie je z rejestru i licznika (odwrotna kolejność zostawiała zamknięte połączenie
    // w `liveConnections`).
    transport.connectionOpened(connection)
    let late = state.withLock { state -> Bool in
      if state.closed { return true }
      state.connections.append(connection)
      return false
    }
    if late { connection.end(.closed(code: nil, reason: "endpoint closed")) }
    return connection
  }

  public func ensureRelay(_ relay: URL) async throws {
    state.withLock { state in
      if !state.relays.contains(relay) { state.relays.append(relay) }
    }
  }

  /// Zamyka połączenia endpointu, potem czeka według ``FakeTunnelScript/endpointClose``. Drugie wywołanie
  /// wraca od razu.
  public func close() async {
    let connections = state.withLock { state -> [FakeTunnelConnection]? in
      guard !state.closed else { return nil }
      state.closed = true
      defer { state.connections.removeAll() }
      return state.connections
    }
    guard let connections else { return }
    for connection in connections { connection.end(.closed(code: 0, reason: "endpoint closed")) }
    await transport.performClose(transport.script.endpointClose(transport.nextCall("endpointClose")))
    transport.endpointClosed()
  }
}

/// Połączenie atrapy z serwerem.
public final class FakeTunnelConnection: TunnelConnection {
  private struct State {
    var ended: TunnelFailure?
    var closedByApp: (code: UInt64, reason: String)?
    var streams: [Int: FakeStreamCore] = [:]
    var waiters: [CheckedContinuation<TunnelFailure, Never>] = []
  }

  private let transport: FakeTunnelTransport
  private let state = Mutex(State())

  init(transport: FakeTunnelTransport) {
    self.transport = transport
  }

  /// Kod i powód `close` wywołanego przez apkę.
  public var closedByApp: (code: UInt64, reason: String)? { state.withLock { $0.closedByApp } }
  public var isClosed: Bool { state.withLock { $0.ended != nil } }

  public func openStream() async throws -> any TunnelStream {
    if let ended = state.withLock({ $0.ended }) { throw ended }
    try await transport.perform(transport.script.openStream(transport.nextCall("openStream")))
    let script = transport.script
    let index = transport.nextStreamIndex()
    let transport = transport
    let core = FakeStreamCore(index: index, window: script.streamWindow, fault: script.stream(index)) { [weak self] core in
      self?.state.withLock { _ = $0.streams.removeValue(forKey: core.index) }
      transport.sessionEnded()
    }
    let ended = state.withLock { state -> TunnelFailure? in
      if let ended = state.ended { return ended }
      state.streams[index] = core
      return nil
    }
    if let ended { throw ended }
    transport.sessionOpened()
    core.applyFault()
    let server = FakeServerStream(core: core)
    Task { await FakeTunnelServing.serve(server, with: script, transport: transport) }
    return FakeTunnelStream(core: core)
  }

  public func close(code: UInt64, reason: String) {
    state.withLock { state in
      if state.closedByApp == nil, state.ended == nil { state.closedByApp = (code, reason) }
    }
    end(.closed(code: code, reason: reason))
  }

  public func closed() async -> TunnelFailure {
    await withCheckedContinuation { (continuation: CheckedContinuation<TunnelFailure, Never>) in
      let ended = state.withLock { state -> TunnelFailure? in
        if let ended = state.ended { return ended }
        state.waiters.append(continuation)
        return nil
      }
      if let ended { continuation.resume(returning: ended) }
    }
  }

  /// Serwer resetuje każdy otwarty strumień tego połączenia.
  public func resetStreams(code: UInt64 = 0) {
    for stream in state.withLock({ Array($0.streams.values) }) { stream.reset(code: code) }
  }

  /// Koniec połączenia (apka albo serwer): pierwszy powód wygrywa, strumienie padają z tym powodem.
  func end(_ failure: TunnelFailure) {
    let ended = state.withLock { state -> (streams: [FakeStreamCore], waiters: [CheckedContinuation<TunnelFailure, Never>])? in
      guard state.ended == nil else { return nil }
      state.ended = failure
      defer { state.waiters.removeAll() }
      return (Array(state.streams.values), state.waiters)
    }
    guard let ended else { return }
    transport.connectionClosed(self)
    for stream in ended.streams { stream.connectionClosed(failure) }
    for waiter in ended.waiters { waiter.resume(returning: failure) }
  }
}
