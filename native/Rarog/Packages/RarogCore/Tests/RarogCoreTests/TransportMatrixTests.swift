import Foundation
import RarogContract
@testable import RarogCore
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Macierz wyboru transportu na magazynie złożonym jak w apce: przełącznik nad runtime'em tunelu jednej
// tożsamości, wspólna dzierżawa z tożsamością iroh z aktora `IrohIdentityStore`, klient HTTPS poświadczenia (atrapa
// protokołu URL) i klient pętli z fabryki, ten sam zatrzask odmowy. Prace w tle z `needsServer` idą do runtime'u
// tak jak z adaptera apki (start z terminem, koniec). Czas runtime'u, dzierżawy i serwera atrapy płynie na jednym
// zegarze sztucznym. Droga żądania: serwer atrapy tunelu (`iroh`) albo atrapa HTTPS (`https`).

private let sessionId = "s1"
private let seen = "POST /api/sessions/s1/seen"

@MainActor
@Suite("magazyn: macierz wyboru transportu i prace w tle", .serialized, .timeLimit(.minutes(5)))
struct TransportMatrixTests {
  @Test("para iroh, dzierżawa gotowa, pamięć pusta → iroh")
  func irohWhenReady() async throws {
    let rig = MatrixRig()
    rig.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["iroh"])
    try await rig.shutdown()
  }

  @Test("obie trasy po porażce iroh → https; generacja https żyje po terminie retryIrohAt")
  func httpsAfterIrohFailureOutlivesRetryDeadline() async throws {
    let rig = MatrixRig(script: { $0.connect = { _ in .fail(.connectFailed("test")) } })
    rig.scene(.active)
    // Pierwsza próba to iroh: porażka, żądanie dostaje `.offline` bez wysyłki.
    await #expect(throws: TransportError.self) { try await rig.switching.markSeen(sessionId: sessionId) }
    #expect(rig.route(of: seen) == [])
    try await rig.afterCooldown()
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["https"])
    let stamp = rig.switching.routeStamp
    try await rig.advance(by: .seconds(130))
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["https", "https"])
    #expect(rig.switching.routeStamp == stamp, "ta sama generacja https, bez wymiany na iroh")
    try await rig.shutdown()
  }

  @Test("tylko adres HTTPS → https, bez endpointu iroh")
  func httpsOnly() async throws {
    let rig = MatrixRig(iroh: false)
    rig.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["https"])
    #expect(rig.fake.counters.bindStarted.isEmpty)
    try await rig.shutdown()
  }

  @Test("tylko iroh, dzierżawa niedostępna (tożsamość zablokowana) → .offline bez żądania, bez nowego bind")
  func irohOnlyUnavailable() async throws {
    let rig = MatrixRig(https: false, identity: .init(locked: true))
    rig.scene(.active)
    await #expect(throws: TransportError.self) { try await rig.switching.markSeen(sessionId: sessionId) }
    try await rig.advance(by: .seconds(2))
    await #expect(throws: SwitchingTransport.noGeneration) { try await rig.switching.markSeen(sessionId: sessionId) }
    #expect(rig.served.all.isEmpty)
    #expect(rig.fake.counters.bindStarted.isEmpty, "bez klucza iroh nie ma wiązania")
    try await rig.shutdown()
  }

  @Test("tożsamość iroh zablokowana przy obu trasach → https, bez wiązania endpointu")
  func lockedIdentityFallsBackToHttps() async throws {
    let rig = MatrixRig(identity: .init(locked: true))
    rig.scene(.active)
    // Pierwsza próba odkrywa brak tożsamości (dzierżawa gotowa przy zimnym starcie): `.offline`, potem https.
    _ = try? await rig.switching.markSeen(sessionId: sessionId)
    try await rig.afterCooldown()
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen).last == "https")
    #expect(rig.fake.counters.bindStarted.isEmpty)
    try await rig.shutdown()
  }

  @Test("platforma nie zmienia wyniku (iPhone, iPad, Mac w atrapie środowiska)")
  func sameOnEveryPlatform() async throws {
    var results: [String: [String]] = [:]
    for platform in MatrixPlatform.allCases {
      var routes: [String] = []
      for (https, iroh) in [(true, true), (true, false), (false, true)] {
        let rig = MatrixRig(https: https, iroh: iroh, platform: platform)
        rig.scene(.active)
        try await rig.switching.markSeen(sessionId: sessionId)
        routes += rig.route(of: seen)
        try await rig.shutdown()
      }
      results[platform.rawValue] = routes
    }
    #expect(Set(MatrixPlatform.allCases.map(\.isiOSAppOnMac)) == [true, false])
    #expect(results["iPhone"] == ["iroh", "https", "iroh"])
    #expect(Set(results.values).count == 1, "\(results)")
  }

  @Test("zmiana sieci czyści pamięć porażki → następna generacja próbuje iroh od razu")
  func networkChangeRetriesIroh() async throws {
    let rig = MatrixRig(script: { $0.connect = { call in call == 0 ? .fail(.connectFailed("test")) : .immediate } })
    rig.scene(.active)
    _ = try? await rig.switching.markSeen(sessionId: sessionId)
    try await rig.afterCooldown()
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["https"])
    rig.network()
    try await rig.settle()
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["https", "iroh"])
    try await rig.shutdown()
  }

  @Test("tylko iroh, powrót z tła przy rebindOnReturn → iroh na nowym endpoincie, bez starego")
  func rebindingStillIroh() async throws {
    let rig = MatrixRig(https: false)
    rig.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    rig.scene(.background)
    try await rig.advance(by: TunnelMachine.backgroundGrace + .seconds(1))
    rig.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.route(of: seen) == ["iroh", "iroh"])
    let counters = rig.fake.counters
    #expect(counters.bindStarted.values.reduce(0, +) == 2, "nowy endpoint po powrocie")
    #expect(counters.endpointsPeak == 1)
    try await rig.shutdown()
  }

  // MARK: - Prace w tle

  @Test("token Live Activity na wierzchu i rotacja po końcu backgroundGrace dochodzą do serwera")
  func liveActivityTokenAndRotation() async throws {
    let rig = MatrixRig(https: false)
    rig.scene(.active)
    let register = "POST /api/push/live-activity"
    let first = rig.store.beginBackgroundWork("rarog.live-activity", needsServer: true)
    try await rig.switching.registerLiveActivity(Self.token("a1"))
    rig.store.endBackgroundWork(first)
    #expect(rig.served.count(register) == 1)
    rig.scene(.background)
    try await rig.advance(by: TunnelMachine.backgroundGrace + .seconds(1))
    try await waitFor("generacja zamknięta po czasie tła") { rig.fake.counters.connections == 0 }
    let rotation = rig.store.beginBackgroundWork("rarog.live-activity", needsServer: true)
    try await rig.switching.registerLiveActivity(Self.token("b2"))
    #expect(rig.served.count(register) == 2, "rotacja w tle otwiera jedną generację w granicach pracy")
    rig.store.endBackgroundWork(rotation)
    try await rig.settle()
    try await waitFor("generacja zamknięta po końcu pracy") { rig.fake.counters.connections == 0 }
    try await rig.shutdown()
  }

  @Test("zapis notatki rozpoczęty przed zejściem w tło, trwający 20 s → dochodzi")
  func noteSaveSurvivesBackground() async throws {
    let rig = MatrixRig(https: false, slowNotes: .seconds(20))
    rig.scene(.active)
    let outcome = try await rig.saveNoteAcrossBackground(needsServer: true)
    #expect(outcome == .saved(5))
    try await rig.shutdown()
  }

  @Test("praca bez serwera (kończenie dyktowania) nie trzyma generacji: zapis w tle po 8 s się urywa")
  func workWithoutServerDoesNotHoldGeneration() async throws {
    let rig = MatrixRig(https: false, slowNotes: .seconds(20))
    rig.scene(.active)
    let outcome = try await rig.saveNoteAcrossBackground(needsServer: false)
    #expect(outcome == nil)
    try await rig.shutdown()
  }

  static func token(_ byte: String) -> LiveActivityRegisterBody {
    LiveActivityRegisterBody(
      deviceToken: String(repeating: "0a", count: 16), activityId: "la-1",
      updateToken: String(repeating: byte, count: 32))
  }
}

/// Atrapa środowiska: platforma procesu. Złożenie transportu bierze z niej tylko etykietę urządzenia.
enum MatrixPlatform: String, CaseIterable {
  case iPhone, iPad, mac

  var isiOSAppOnMac: Bool { self == .mac }
  var label: String { self == .iPhone ? "iPhone·Rarog" : "iPad·Rarog" }
}

/// Magazyn z transportem złożonym jak w koordynatorze apki.
@MainActor
final class MatrixRig {
  nonisolated static let relay = URL(string: "https://relay.example/")!
  nonisolated static let target = TunnelTarget(endpointId: String(repeating: "ab", count: 32), relay: relay)

  let clock = FakeTunnelClock()
  let fake: FakeTunnelTransport
  let served = Served()
  let arrivals = MatrixArrivals()
  let https: MatrixHTTPS.Port
  let lease: EndpointLease
  let runtime: TunnelRuntime
  let switching: SwitchingTransport
  let timing: TunnelRuntime.Timing
  let store: RarogStore

  init(
    https: Bool = true, iroh: Bool = true, identity: MemoryIrohIdentityKeychain.Contents = .init(),
    platform: MatrixPlatform = .iPhone, slowNotes: Duration? = nil,
    script configure: (inout FakeTunnelScript) -> Void = { _ in }
  ) {
    var script = FakeTunnelScript()
    configure(&script)
    let clock = clock
    let arrivals = arrivals
    script.server = SwitchRig.server(served) { request in
      if request.path != "/api/version" { arrivals.append("iroh", "\(request.method) \(request.path)") }
      guard request.path == "/api/notes" else { return nil }
      if let slowNotes { try? await clock.sleep(for: slowNotes) }
      return .json(200, #"{"updatedAt":5}"#)
    }
    fake = FakeTunnelTransport(clock: clock, script: script)
    self.https = MatrixHTTPS.register(arrivals)
    let box = SwitchRuntimeBox()
    let identities = IrohIdentityStore(keychain: MemoryIrohIdentityKeychain(identity))
    lease = EndpointLease(
      transport: fake,
      identity: {
        guard case let .ready(identity) = await identities.identity() else { return nil }
        return LeaseIdentity(secretKey: identity.secretKey, homeRelay: MatrixRig.relay)
      },
      clock: SwitchLeaseClock(fake: clock),
      closeUsers: { users in await box.runtime?.closeUsers(users) },
      onReadiness: { readiness in box.runtime?.leaseChanged(readiness) })
    let base = ContinuousClock.now
    timing = TunnelRuntime.Timing(now: { base + clock.now }, sleep: clock.sleep)
    let latch = CredentialRejectionLatch()
    let credential = PairingFixtures.credential(
      server: https ? self.https.url : nil, iroh: iroh ? PairingFixtures.iroh() : nil)
    let label = platform.label
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MatrixHTTPS.self]
    let httpsClient = credential.serverURL.map { url in
      RarogClient(
        config: RarogConfig(baseURL: url, clientLabel: label, build: 7), configuration: configuration,
        device: credential, rejections: latch)
    }
    runtime = TunnelRuntime(
      target: iroh ? Self.target : nil, httpsClient: httpsClient, lease: lease,
      makeClient: { url in
        RarogClient(
          config: RarogConfig(baseURL: url, origin: IrohWire.origin, clientLabel: label, build: 7),
          device: credential, rejections: latch)
      },
      timing: timing, proxyCounters: fake.proxyCounters)
    box.set(runtime)
    switching = SwitchingTransport(runtime: runtime, rejections: latch, timing: timing)
    let rules = MutationRules(timing: fastTiming)
    store = RarogStore(
      transport: switching, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    store.attachSystem(
      push: FakePushSystem(status: .authorized), background: TunnelWorkForwarder(runtime: runtime, timing: timing),
      preferences: MemoryPreferences())
  }

  /// Scena najpierw do runtime'u, potem do magazynu (kolejność z apki).
  func scene(_ phase: ScenePhase) {
    let next: TunnelMachine.Scene =
      switch phase {
      case .active: .active
      case .inactive: .inactive
      case .background: .background
      }
    let runtime = runtime
    Task.immediate { await runtime.scene(next) }
    store.setScenePhase(phase)
  }

  func network() {
    let runtime = runtime
    Task.immediate { await runtime.networkChanged() }
  }

  /// Drogi, którymi doszło żądanie `line`, po kolei.
  func route(of line: String) -> [String] {
    arrivals.all.filter { $0.line == line }.map(\.route)
  }

  /// Zapis notatki w pracy w tle rozpoczętej na wierzchu; scena schodzi w tło, gdy serwer już ma żądanie.
  /// Wynik `nil` = zapis nie doszedł (błąd transportu).
  func saveNoteAcrossBackground(needsServer: Bool) async throws -> NotesSaveResult? {
    let work = store.beginBackgroundWork("notatka", needsServer: needsServer)
    let switching = switching
    let save = Task { try? await switching.saveNotes(NotesPutBody(cwd: "/Users/demo/rarog", text: "x", updatedAt: 1)) }
    try await waitFor("serwer ma zapis") { served.count("PUT /api/notes") == 1 }
    scene(.background)
    try await advance(by: .seconds(21))
    let outcome = await save.value
    store.endBackgroundWork(work)
    return outcome
  }

  /// Koniec przerwy po nieudanej próbie: zamknięcie częściowych zasobów, potem `cooldown` 1 s.
  func afterCooldown() async throws {
    try await waitFor("przerwa po porażce") {
      if case .cooldown = await runtime.machineState { return true }
      return false
    }
    try await advance(by: TunnelMachine.cooldown + .milliseconds(250))
  }

  func settle() async throws {
    try await waitFor("runtime bez pracy") {
      guard await runtime.busyTasks == 0, await lease.unfinishedNativeOperations == 0 else { return false }
      try? await Task.sleep(for: .milliseconds(3))
      return await runtime.busyTasks == 0
    }
  }

  func advance(by total: Duration) async throws {
    var left = total
    while left > .zero {
      let step = min(.milliseconds(250), left)
      clock.advance(by: step)
      left -= step
      try await settle()
    }
  }

  func shutdown(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    await runtime.shutdown()
    fake.releaseHanging()
    try await waitFor("zero sesji po shutdown", sourceLocation: sourceLocation) { fake.counters.sessions == 0 }
    #expect(fake.counters.endpointsAlive == 0, sourceLocation: sourceLocation)
    #expect(await runtime.counters == TunnelRuntime.Counters(), sourceLocation: sourceLocation)
  }
}

/// Żądania przyjęte przez obie atrapy (tunel i HTTPS) w kolejności przyjęcia.
final class MatrixArrivals: Sendable {
  private let state = Mutex<[(route: String, line: String)]>([])

  func append(_ route: String, _ line: String) { state.withLock { $0.append((route, line)) } }
  var all: [(route: String, line: String)] { state.withLock { $0 } }
}

/// Prace w tle magazynu do runtime'u tunelu, jak adapter apki: tylko z `needsServer`, start z terminem 30 s.
@MainActor
final class TunnelWorkForwarder: BackgroundWork {
  private let runtime: TunnelRuntime
  private let timing: TunnelRuntime.Timing
  private var next = 0
  private var live: [Int: Bool] = [:]

  init(runtime: TunnelRuntime, timing: TunnelRuntime.Timing) {
    self.runtime = runtime
    self.timing = timing
  }

  func begin(_ name: String, needsServer: Bool) -> BackgroundWorkToken? {
    next += 1
    live[next] = needsServer
    if needsServer {
      let id = TunnelMachine.WorkID(UInt64(next))
      let expiresAt = timing.now() + .seconds(30)
      let runtime = runtime
      Task.immediate { await runtime.backgroundWorkStarted(id, expiresAt: expiresAt) }
    }
    return BackgroundWorkToken(raw: next)
  }

  func end(_ token: BackgroundWorkToken) {
    guard live.removeValue(forKey: token.raw) == true else { return }
    let id = TunnelMachine.WorkID(UInt64(token.raw))
    let runtime = runtime
    Task.immediate { await runtime.backgroundWorkFinished(id) }
  }
}

/// Atrapa serwera HTTPS: odpowiedź `{"ok":true}` (notatki: `updatedAt`), zapis linii żądań per port.
final class MatrixHTTPS: URLProtocol, @unchecked Sendable {
  struct Port {
    let number: Int
    var url: URL { URL(string: "https://matrix.test:\(number)")! }
  }

  private static let sinks = Mutex<[Int: MatrixArrivals]>([:])
  private static let nextPort = Atomic<Int>(48_000)

  static func register(_ arrivals: MatrixArrivals) -> Port {
    let port = nextPort.add(1, ordering: .relaxed).newValue
    sinks.withLock { $0[port] = arrivals }
    return Port(number: port)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let port = url.port else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    let sink = Self.sinks.withLock { $0[port] }
    sink?.append("https", "\(request.httpMethod ?? "GET") \(url.path)")
    let body = url.path == "/api/notes" ? #"{"updatedAt":5}"# : #"{"ok":true}"#
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// `eventually` na głównym aktorze (warunki czytają magazyn i rig).
@MainActor
func waitFor(
  _ what: String, limit: Duration = .seconds(10), sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () async -> Bool
) async throws {
  let deadline = ContinuousClock.now + limit
  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("nie doczekano: \(what)", sourceLocation: sourceLocation)
      return
    }
    try await Task.sleep(for: .milliseconds(2))
  }
}
