import Foundation
import RarogContract
@testable import RarogCore
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Przełącznik transportu na prawdziwym runtime'ie tunelu, prawdziwej dzierżawie, prawdziwym proxy na pętli
// zwrotnej i prawdziwym `RarogClient`; serwer to atrapa tunelu z HTTP/1.1. Czas runtime'u, dzierżawy, proxy
// i limitu wysyłki płynie na jednym zegarze sztucznym, więc terminy (200 s wysyłki, 2 s zamykania) nie zależą od
// obciążenia maszyny. Mapowanie wyników: anulowanie wołającego → `.cancelled`, zamknięcie generacji przez runtime
// → `.offline`, wycofanie → `.cancelled`, brak generacji → `.offline` bez żądania; przełącznik nie ponawia.

private let sessionId = "s1"
private let cwd = "/Users/demo/Projects/rarog"
private let termId = "0123456789abcdef"

@Suite("przełącznik transportu: bramka, bilet, drzwi uploadu, mapowanie", .timeLimit(.minutes(5)))
struct SwitchingTransportTests {
  @Test("routeStamp rośnie z każdą generacją")
  func routeStampGrows() async throws {
    let rig = SwitchRig.make()
    #expect(rig.switching.routeStamp == 0)
    await rig.runtime.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.switching.routeStamp == 1)
    for expected in UInt64(2) ... 4 {
      await rig.runtime.networkChanged()
      try await rig.switching.markSeen(sessionId: sessionId)
      #expect(rig.switching.routeStamp == expected)
    }
    #expect(rig.served.count("POST /api/sessions/s1/seen") == 4)
    try await rig.shutdown()
  }

  @Test("tło bez pracy: bramka daje od razu .offline, żądanie nie wychodzi")
  func gateOfflineWithoutGeneration() async throws {
    let rig = SwitchRig.make()
    await rig.runtime.scene(.background)
    await #expect(throws: SwitchingTransport.noGeneration) { try await rig.switching.markSeen(sessionId: sessionId) }
    #expect(rig.served.all.isEmpty)
    #expect(rig.fake.counters.bindStarted.isEmpty)
    try await rig.shutdown()
  }

  @Test("generacja w zamykaniu między wydaniem a wejściem → czekanie na następną, zero żądań na starej")
  func closingGenerationWaitsForNext() async throws {
    let injected = Mutex(false)
    let rig = SwitchRig.make(source: { runtime in
      GenerationSource(
        generation: {
          let outcome = await runtime.generation()
          // Pierwsze wydanie: runtime zaczyna zamykać generację, zanim przełącznik weźmie bilet.
          let first = injected.withLock { done -> Bool in
            defer { done = true }
            return !done
          }
          if first { await runtime.networkChanged() }
          return outcome
        },
        openUploadDoor: { budget in try await runtime.openUploadDoor(budget: budget) })
    })
    await rig.runtime.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(injected.withLock { $0 })
    #expect(rig.switching.routeStamp == 2)
    let lines = rig.served.lines
    #expect(lines.filter { $0 == "POST /api/sessions/s1/seen" }.count == 1)
    // Sonda pierwszej generacji, sonda drugiej, potem jedyne żądanie: przyszło już nową generacją.
    let probes = lines.indices.filter { lines[$0] == "GET /api/version" }
    #expect(probes.count == 2)
    #expect(lines.firstIndex(of: "POST /api/sessions/s1/seen").map { $0 > (probes.last ?? 0) } == true)
    try await rig.shutdown()
  }

  @Test("stary transport po retire → .cancelled, zero nowych generacji")
  func retiredTransportCancels() async throws {
    let rig = SwitchRig.make()
    await rig.runtime.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    let binds = rig.fake.counters.bindStarted.values.reduce(0, +)
    let connects = rig.fake.endpoints.first?.targets.count
    await rig.runtime.retire()
    await #expect(throws: TransportError.cancelled) { try await rig.switching.markSeen(sessionId: sessionId) }
    await #expect(throws: TransportError.cancelled) { _ = try await rig.switching.openStream(.global, lastEventId: nil, watch: StreamStallGuard()) }
    // Wysyłka z załącznikiem też nie dostaje drzwi.
    let file = try SwitchRig.uploadFile()
    defer { try? FileManager.default.removeItem(at: file) }
    await #expect(throws: TransportError.cancelled) {
      _ = try await rig.switching.sendMessage(
        sessionId: sessionId, MessageUpload(body: .file(file), clientMessageId: nil), timeout: .seconds(200),
        progress: nil)
    }
    try await rig.advance(by: .seconds(30))
    #expect(rig.fake.counters.bindStarted.values.reduce(0, +) == binds)
    #expect(rig.fake.endpoints.first?.targets.count == connects)
    #expect(rig.served.count("POST /api/sessions/s1/seen") == 1)
    try await rig.shutdown()
  }

  @Test("afterPair raz po każdym powrocie pair: odpowiedź, błąd HTTP, brak generacji; inne wywołania go nie wołają")
  func afterPairAfterEveryPairReturn() async throws {
    let calls = Mutex(0)
    let pairCount = Mutex(0)
    let rig = SwitchRig.make(respond: { request in
      guard request.path == "/api/pair" else { return nil }
      let pairs = pairCount.withLock { count -> Int in
        count += 1
        return count
      }
      return pairs == 1 ? .json(200, SwitchRig.pairJSON) : .json(409, #"{"error":"pairing-code-invalid"}"#)
    }, afterPair: { calls.withLock { $0 += 1 } })
    await rig.runtime.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(calls.withLock { $0 } == 0)
    let body = PairBody(code: "ABCD-EFGH", label: "test·Rarog", build: 1)
    let response = try await rig.switching.pair(body)
    #expect(response.deviceId == "d-new")
    #expect(calls.withLock { $0 } == 1)
    await #expect(throws: TransportError.self) { _ = try await rig.switching.pair(body) }
    #expect(calls.withLock { $0 } == 2)
    await rig.runtime.scene(.background)
    await #expect(throws: SwitchingTransport.noGeneration) { _ = try await rig.switching.pair(body) }
    #expect(calls.withLock { $0 } == 3)
    try await rig.shutdown()
  }

  /// The protocol's default answer (404 without a request) would swallow the cancel without a word.
  @MainActor
  @Test("cancelPairingCode: DELETE /api/pairings reaches the server over HTTPS and over iroh")
  func cancelPairingCodeForwarded() async throws {
    for (https, iroh, route) in [(true, false, "https"), (false, true, "iroh")] {
      let rig = MatrixRig(https: https, iroh: iroh)
      rig.scene(.active)
      try await rig.switching.cancelPairingCode()
      #expect(rig.route(of: "DELETE /api/pairings") == [route])
      try await rig.shutdown()
    }
  }

  @Test("mapowanie błędu generacji")
  func mappingTable() async {
    let open = GenerationTicket()
    let closing = GenerationTicket()
    closing.startClosing()
    // `.cancelled` z generacji zamkniętej przez runtime to zerwanie, nie rezygnacja.
    #expect(SwitchingTransport.mapped(.cancelled, closing) == .offline(.networkConnectionLost))
    #expect(SwitchingTransport.mapped(.cancelled, open) == .cancelled)
    #expect(SwitchingTransport.mapped(.offline(.networkConnectionLost), closing) == .offline(.networkConnectionLost))
    #expect(SwitchingTransport.mapped(.timedOut, closing) == .timedOut)
    // Zadanie wołającego anulowane → `.cancelled`, także gdy generacja zamyka się w tej samej chwili.
    let cancelled = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return (SwitchingTransport.mapped(.cancelled, closing), SwitchingTransport.mapped(.offline(.timedOut), closing))
    }
    let (first, second) = await cancelled.value
    #expect(first == .cancelled)
    #expect(second == .cancelled)
  }

  @Test("401 device-revoked z drzwi uploadu → wspólny zatrzask; późniejsze 401 go nie zastępuje; bez ponowienia")
  func revokedFromDoorLatched() async throws {
    let rig = SwitchRig.make(respond: { request in
      switch request.path {
      case "/api/sessions/s1/messages":
        return .json(401, #"{"error":"device-revoked","message":"odpięte","revokedAt":"2026-11-08T10:00:00Z","revokedBy":"admin"}"#)
      case "/api/sessions/s1/seen":
        return .json(401, #"{"error":"device-unknown","message":"nieznane"}"#)
      default:
        return nil
      }
    })
    await rig.runtime.scene(.active)
    let file = try SwitchRig.uploadFile()
    defer { try? FileManager.default.removeItem(at: file) }
    await #expect(throws: TransportError.self) {
      _ = try await rig.switching.sendMessage(
        sessionId: sessionId, MessageUpload(body: .file(file), clientMessageId: nil), timeout: .seconds(200),
        progress: nil)
    }
    guard case .revoked = rig.switching.credentialRejection else {
      Issue.record("zatrzask bez device-revoked: \(String(describing: rig.switching.credentialRejection))")
      return
    }
    try await eventually("drzwi zamknięte") { await rig.runtime.counters.doors == 0 }
    await #expect(throws: TransportError.self) { try await rig.switching.markSeen(sessionId: sessionId) }
    guard case .revoked = rig.switching.credentialRejection else {
      Issue.record("device-revoked zastąpione: \(String(describing: rig.switching.credentialRejection))")
      return
    }
    #expect(rig.served.count("POST /api/sessions/s1/messages") == 1)
    try await rig.shutdown()
  }

  @Test("reset strumienia iroh w trakcie żądania (serwer zamiast 400/408 resetuje strumień) → .offline")
  func streamResetIsOffline() async throws {
    let hold = Hold()
    let rig = SwitchRig.make(respond: { request in
      guard request.path == "/api/sessions/s1/seen" else { return nil }
      await hold.wait()
      return .json(200, #"{"ok":true}"#)
    })
    await rig.runtime.scene(.active)
    let request = Task { () -> TransportError? in
      do throws(TransportError) {
        try await rig.switching.markSeen(sessionId: sessionId)
        return nil
      } catch {
        return error
      }
    }
    try await eventually("żądanie u serwera") { rig.served.count("POST /api/sessions/s1/seen") == 1 }
    rig.fake.resetStreams()
    let outcome = await request.value
    guard case .offline = outcome else {
      Issue.record("oczekiwane .offline, jest \(String(describing: outcome))")
      return
    }
    #expect(rig.served.count("POST /api/sessions/s1/seen") == 1)  // bez ponowienia
    hold.release()
    try await rig.shutdown()
  }

  @Test("anulowanie po wysłaniu całego ciała, przed odpowiedzią → .cancelled, drzwi zamknięte, jedno żądanie")
  func cancelAfterWholeBody() async throws {
    let hold = Hold()
    let rig = SwitchRig.make(respond: { request in
      guard request.path == "/api/sessions/s1/messages" else { return nil }
      await hold.wait()
      return .json(202, "{}")
    })
    await rig.runtime.scene(.active)
    try await rig.switching.markSeen(sessionId: sessionId)
    let generationConnections = rig.fake.liveConnections
    let file = try SwitchRig.uploadFile(bytes: 48 * 1024)
    defer { try? FileManager.default.removeItem(at: file) }
    let send = Task {
      try await rig.switching.sendMessage(
        sessionId: sessionId, MessageUpload(body: .file(file), clientMessageId: nil), timeout: .seconds(200),
        progress: nil)
    }
    try await eventually("całe ciało u serwera") { rig.served.count("POST /api/sessions/s1/messages") == 1 }
    #expect(rig.served.bodies("/api/sessions/s1/messages").first?.count == 48 * 1024)
    #expect(await rig.runtime.counters.doors == 1)
    let doorConnections = rig.fake.liveConnections.filter { connection in
      !generationConnections.contains { $0 === connection }
    }
    #expect(doorConnections.count == 1)
    let before = rig.clock.now
    send.cancel()
    await #expect(throws: TransportError.cancelled) { _ = try await send.value }
    // Drzwi zamknięte bez kroku zegara (≤ 2 s): połączenie drzwi i jego nasłuch zniknęły, generacja główna została.
    try await eventually("drzwi zamknięte") {
      await rig.runtime.counters.doors == 0 && rig.fake.counters.connections == 1 && rig.fake.counters.listeners == 1
    }
    #expect(rig.clock.now - before <= .seconds(2))
    // Anulowany upload zamyka połączenie drzwi kodem aplikacji 1.
    #expect(doorConnections.first?.closedByApp?.code == 1)
    try await rig.settle()
    try await Task.sleep(for: .milliseconds(50))
    #expect(rig.served.count("POST /api/sessions/s1/messages") == 1)  // bez ponowienia
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(rig.switching.routeStamp == 1)
    hold.release()
    try await rig.shutdown()
  }

  @Test("50 cykli anulowania uploadu: drzwi zamknięte po każdym, generacja główna i SSE nietknięte")
  func fiftyUploadCancellations() async throws {
    let hold = Hold()
    let rig = SwitchRig.make(respond: { request in
      guard request.path == "/api/sessions/s1/messages" else { return nil }
      await hold.wait()
      return .json(202, "{}")
    })
    await rig.runtime.scene(.active)
    let stream = try await rig.switching.openStream(.global, lastEventId: nil, watch: StreamStallGuard())
    let sseFailure = Mutex<String?>(nil)
    let sse = Task {
      do {
        for try await _ in stream {}
        sseFailure.withLock { $0 = "koniec strumienia" }
      } catch {
        sseFailure.withLock { $0 = "\(error)" }
      }
    }
    let file = try SwitchRig.uploadFile()
    defer { try? FileManager.default.removeItem(at: file) }
    for cycle in 1 ... 50 {
      let send = Task {
        try await rig.switching.sendMessage(
          sessionId: sessionId, MessageUpload(body: .file(file), clientMessageId: nil), timeout: .seconds(200),
          progress: nil)
      }
      try await eventually("cykl \(cycle): ciało u serwera") {
        rig.served.count("POST /api/sessions/s1/messages") == cycle
      }
      send.cancel()
      await #expect(throws: TransportError.cancelled) { _ = try await send.value }
      try await eventually("cykl \(cycle): drzwi zamknięte") {
        await rig.runtime.counters.doors == 0 && rig.fake.counters.connections == 1 && rig.fake.counters.listeners == 1
      }
    }
    #expect(rig.switching.routeStamp == 1)
    #expect(sseFailure.withLock { $0 } == nil)
    try await rig.switching.markSeen(sessionId: sessionId)
    #expect(await rig.runtime.counters.clients == 1)
    sse.cancel()
    hold.release()
    try await rig.shutdown()
  }

  @Test("limit 200 s liczony od wejścia w sendMessage: 10 s czekania na generację zostawia 190 s")
  func uploadBudgetFromEntry() async throws {
    let hold = Hold()
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .delay(.seconds(10)) : .immediate }
    let rig = SwitchRig.make(script: script, respond: { request in
      guard request.path == "/api/sessions/s1/messages" else { return nil }
      await hold.wait()
      return .json(202, "{}")
    })
    await rig.runtime.scene(.active)
    let file = try SwitchRig.uploadFile()
    defer { try? FileManager.default.removeItem(at: file) }
    let done = Mutex<TransportError?>(nil)
    let send = Task {
      do throws(TransportError) {
        _ = try await rig.switching.sendMessage(
          sessionId: sessionId, MessageUpload(body: .file(file), clientMessageId: nil), timeout: .seconds(200),
          progress: nil)
        done.withLock { $0 = .invalidResponse("przyjęte") }
      } catch {
        done.withLock { $0 = error }
      }
    }
    try await eventually("connect generacji w toku") { rig.fake.endpoints.first?.targets.count == 1 }
    rig.clock.advance(by: .seconds(10))
    try await eventually("ciało u serwera drzwiami") { rig.served.count("POST /api/sessions/s1/messages") == 1 }
    #expect(rig.clock.now == .seconds(10))
    rig.clock.advance(by: .milliseconds(189_750))
    try await Task.sleep(for: .milliseconds(100))
    #expect(done.withLock { $0 } == nil, "wysyłka skończona przed 200 s od wejścia")
    rig.clock.advance(by: .milliseconds(250))
    await send.value
    #expect(done.withLock { $0 } == .timedOut)
    try await eventually("drzwi zamknięte") { await rig.runtime.counters.doors == 0 }
    #expect(rig.served.count("POST /api/sessions/s1/messages") == 1)
    hold.release()
    try await rig.shutdown()
  }
}

@Suite("przełącznik transportu: prawdziwy StreamSupervisor", .timeLimit(.minutes(2)))
struct SwitchingStreamSupervisorTests {
  @Test("zamknięcie generacji w trakcie iteracji SSE → .offline, nadzorca wraca do pętli z nową generacją")
  func supervisorReturnsToLoop() async throws {
    let rig = SwitchRig.make()
    await rig.runtime.scene(.active)
    let signals = Mutex<[String]>([])
    let supervisor = StreamSupervisor(
      scope: .global, transport: rig.switching,
      timing: CoreTiming(backoffMin: .milliseconds(10), backoffMax: .milliseconds(40)),
      render: ServerText.renderer(language: .current),
      deliver: { signal in
        let name: String = switch signal {
        case .connecting: "connecting"
        case .opened: "opened"
        case .frame: "frame"
        case .oversized: "oversized"
        case .dropped: "dropped"
        case .unauthorized: "unauthorized"
        case .sessionGone: "sessionGone"
        }
        signals.withLock { $0.append(name) }
      })
    let finished = Mutex(false)
    let loop = Task {
      await supervisor.run(cursor: nil)
      finished.withLock { $0 = true }
    }
    try await eventually("strumień otwarty") { signals.withLock { $0.contains("opened") } }
    #expect(rig.switching.routeStamp == 1)
    await rig.runtime.networkChanged()
    try await eventually("drugi strumień na nowej generacji") {
      signals.withLock { $0.filter { $0 == "opened" }.count } == 2
    }
    let seen = signals.withLock { $0 }
    #expect(seen.contains("dropped"))
    #expect(!seen.contains("unauthorized") && !seen.contains("sessionGone"))
    #expect(rig.switching.routeStamp == 2)
    // Wycofanie kończy pętlę: `.cancelled` to koniec, nie zerwanie.
    await rig.runtime.retire()
    try await eventually("nadzorca skończył po retire") { finished.withLock { $0 } }
    loop.cancel()
    try await rig.shutdown()
  }
}

@Suite("przełącznik transportu: prawdziwy TerminalSession", .timeLimit(.minutes(2)))
@MainActor
struct SwitchingTerminalSessionTests {
  @Test("nieudane czekanie na generację w checkTerminalInput → bez niezgodności, gniazdo pada, terminal ponawia")
  func terminalRetriesAfterFailedWait() async throws {
    let rig = SwitchRig.make(respond: { request in
      guard request.method == "POST", request.path == "/api/term" else { return nil }
      return .json(200, #"{"id":"\#(termId)","slot":1,"role":"shell"}"#)
    })
    await rig.runtime.scene(.background)
    let entry = try #require(TerminalList.make([(termId, cwd, 1, .shell)]).terminals.first)
    let clock = VirtualClock()
    let session = TerminalSession(target: .existing(entry), transport: rig.switching, sleep: { await clock.sleep($0) })
    session.start()
    await until("ponawianie po nieudanym czekaniu") { session.phase == .reconnecting(attempt: 1) }
    #expect(rig.served.all.isEmpty)
    await rig.runtime.scene(.active)
    await until("budzik ponowienia") { clock.sleeping.count == 1 }
    clock.advance(by: .seconds(1))
    await until("upgrade terminala przez nową generację", timeout: .seconds(10)) {
      rig.served.lines.contains { $0.hasPrefix("GET /api/term/\(termId)") }
    }
    if case .failed = session.phase { Issue.record("terminal zatrzymany: \(session.phase)") }
    session.stop()
    try await rig.shutdown()
  }
}

// MARK: - Stanowisko

/// Runtime tunelu tylko-iroh z atrapą transportu, dzierżawą, zegarem sztucznym i przełącznikiem nad nim.
struct SwitchRig {
  static let relay = URL(string: "https://relay.example/")!
  static let target = TunnelTarget(endpointId: String(repeating: "ab", count: 32), relay: relay)
  static let secret = Data(repeating: 9, count: 32)

  let clock: FakeTunnelClock
  let fake: FakeTunnelTransport
  let lease: EndpointLease
  let runtime: TunnelRuntime
  let switching: SwitchingTransport
  let served: Served

  /// - Parameters:
  ///   - respond: odpowiedź serwera na żądanie; `nil` = domyślna (SSE z pingiem dla `/api/stream`, inaczej 200).
  ///   - source: źródło generacji nad runtime'em (domyślnie sam runtime).
  static func make(
    script: FakeTunnelScript = FakeTunnelScript(),
    respond: (@Sendable (FakeHTTPRequest) async -> FakeHTTPResponse?)? = nil,
    source: ((TunnelRuntime) -> GenerationSource)? = nil,
    afterPair: (@Sendable () -> Void)? = nil
  ) -> SwitchRig {
    let clock = FakeTunnelClock()
    let served = Served()
    var script = script
    script.server = server(served, respond: respond)
    let fake = FakeTunnelTransport(clock: clock, script: script)
    let box = SwitchRuntimeBox()
    let lease = EndpointLease(
      transport: fake,
      identity: { LeaseIdentity(secretKey: secret, homeRelay: relay) },
      clock: SwitchLeaseClock(fake: clock),
      closeUsers: { users in await box.runtime?.closeUsers(users) },
      onReadiness: { readiness in box.runtime?.leaseChanged(readiness) })
    let base = ContinuousClock.now
    let timing = TunnelRuntime.Timing(now: { base + clock.now }, sleep: clock.sleep)
    let latch = CredentialRejectionLatch()
    let credential = PairingFixtures.credential()
    let runtime = TunnelRuntime(
      target: target, httpsClient: nil, lease: lease,
      makeClient: { url in
        RarogClient(
          config: RarogConfig(baseURL: url, origin: IrohWire.origin, clientLabel: "test·Rarog", build: 1),
          device: credential, rejections: latch)
      },
      timing: timing, proxyCounters: fake.proxyCounters)
    box.set(runtime)
    let switching = SwitchingTransport(
      source: source?(runtime) ?? GenerationSource(runtime), rejections: latch, requestTimeout: .seconds(10),
      timing: timing, afterPair: afterPair)
    return SwitchRig(clock: clock, fake: fake, lease: lease, runtime: runtime, switching: switching, served: served)
  }

  /// Odpowiedź `POST /api/pair` (200) w kształcie `shared/fixtures/rest/pair.json`.
  static let pairJSON = #"{"deviceId":"d-new","secret":"s","pushKey":"cHVzaA==","kid":"0a1b2c3d","#
    + #""server":{"id":"srv","name":"mac-demo","version":"1.0.0","capabilities":[],"iroh":null}}"#

  static func server(
    _ served: Served, respond: (@Sendable (FakeHTTPRequest) async -> FakeHTTPResponse?)?
  ) -> FakeTunnelServer {
    .http { request in
      served.append(request)
      if let response = await respond?(request) { return response }
      if request.path == "/api/stream" {
        // Kodowanie `chunked` jak serwer Raroga: urwane połączenie to błąd, nie koniec ciała.
        let headers = [("Content-Type", "text/event-stream"), ("Transfer-Encoding", "chunked")]
        return FakeHTTPResponse(headers: headers) { stream in
          try await stream.write(Data("8\r\n: ping\n\n\r\n".utf8))
          _ = try await stream.readToEnd()
        }
      }
      return .json(200, #"{"ok":true}"#)
    }
  }

  /// Plik ciała wysyłki z załącznikiem (treść bez znaczenia dla atrapy serwera).
  static func uploadFile(bytes: Int = 4096) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "rarog-switching-\(UUID().uuidString).json")
    try Data(repeating: 0x41, count: bytes).write(to: url)
    return url
  }

  /// Runtime bez pracy w toku i dzierżawa bez operacji natywnych.
  func settle(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    try await eventually("runtime bez pracy", sourceLocation: sourceLocation) {
      guard await runtime.busyTasks == 0, await lease.unfinishedNativeOperations == 0 else { return false }
      try? await Task.sleep(for: .milliseconds(3))
      let busy = await runtime.busyTasks
      let native = await lease.unfinishedNativeOperations
      return busy == 0 && native == 0
    }
  }

  /// Czas naprzód krokami po 250 ms z dojściem runtime'u do spoczynku po każdym kroku.
  func advance(by total: Duration) async throws {
    var left = total
    while left > .zero {
      let step = min(.milliseconds(250), left)
      clock.advance(by: step)
      left -= step
      try await settle()
    }
  }

  /// Po `shutdown()` runtime'u wszystkie liczniki są zerem.
  func shutdown(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    await runtime.shutdown()
    fake.releaseHanging()
    try await eventually("zero sesji po shutdown", sourceLocation: sourceLocation) { fake.counters.sessions == 0 }
    let counters = fake.counters
    #expect(counters.endpointsAlive == 0, sourceLocation: sourceLocation)
    #expect(counters.connections == 0, sourceLocation: sourceLocation)
    #expect(counters.listeners == 0, sourceLocation: sourceLocation)
    #expect(await runtime.counters == TunnelRuntime.Counters(), sourceLocation: sourceLocation)
  }
}

/// Żądania, które doszły do serwera atrapy, w kolejności.
final class Served: Sendable {
  private let state = Mutex<[FakeHTTPRequest]>([])

  func append(_ request: FakeHTTPRequest) { state.withLock { $0.append(request) } }
  var all: [FakeHTTPRequest] { state.withLock { $0 } }
  var lines: [String] { all.map { "\($0.method) \($0.path)" } }
  func count(_ line: String) -> Int { lines.filter { $0 == line }.count }
  func bodies(_ path: String) -> [Data] { all.filter { $0.path == path }.map(\.body) }
}

/// Odpowiedź serwera wstrzymana do `release()`.
final class Hold: Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let now = state.withLock { state -> Bool in
        if state.open { return true }
        state.waiters.append(continuation)
        return false
      }
      if now { continuation.resume() }
    }
  }

  func release() {
    let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}

/// Runtime dla domknięć dzierżawy, które powstają przed nim.
final class SwitchRuntimeBox: Sendable {
  private let state = Mutex<TunnelRuntime?>(nil)
  var runtime: TunnelRuntime? { state.withLock { $0 } }
  func set(_ runtime: TunnelRuntime) { state.withLock { $0 = runtime } }
}

/// Zegar dzierżawy na czasie ``FakeTunnelClock``: ten sam czas co runtime i proxy.
struct SwitchLeaseClock: Clock {
  struct Instant: InstantProtocol {
    var offset: Duration
    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  let fake: FakeTunnelClock
  var now: Instant { Instant(offset: fake.now) }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    try await fake.sleep(for: deadline.offset - fake.now)
  }
}

/// Czeka w czasie rzeczywistym (do `limit`) na warunek asynchroniczny; po terminie zgłasza porażkę.
func eventually(
  _ what: String,
  limit: Duration = .seconds(10),
  sourceLocation: SourceLocation = #_sourceLocation,
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
