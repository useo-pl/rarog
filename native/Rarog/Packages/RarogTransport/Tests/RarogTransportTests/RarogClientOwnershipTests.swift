import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogTransport
import Synchronization
import Testing

// Kontrakt własności klienta: jeden zatrzask odmowy na poświadczenie dzielony przez klientów
// (generacje iroh, drzwi uploadu, klient HTTPS) i `invalidate()` właściciela, które kończy żądania w locie jako
// `.cancelled`, a każde późniejsze wywołanie kończy `.cancelled` bez zadania sesji URL. Wszystko na prawdziwym
// `RarogClient` z atrapą `URLProtocol` w konfiguracji sesji. Zadanie na unieważnionej sesji kończy proces wyjątkiem
// Foundation, więc scenariusze, w których błąd klienta by je utworzył, biegną w procesie potomnym: błąd daje
// porażkę testu, a nie koniec całego przebiegu.

private func golden(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

/// Odmowa `device-revoked` ze złotego pliku, przypięta do ``testDevice``.
private let revokedForTestDevice = CredentialRejection.revoked(
  deviceId: testDevice.deviceId, revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")

/// Klient z kluczem ``testDevice`` przypiętym do adresu atrapy; `rejections` = zatrzask poświadczenia
/// (`nil` = domyślny parametr `init`, czyli własny zatrzask klienta).
private func ownedClient(
  port: Int, protocolClass: AnyClass, rejections: CredentialRejectionLatch?
) -> RarogClient {
  let config = RarogConfig.test(port: port, build: 42, clientLabel: "iPhone·Rarog")
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [protocolClass]
  var device = testDevice
  device.serverURL = config.baseURL
  let renderer = ServerText.renderer(language: .pl)
  guard let rejections else {
    return RarogClient(config: config, configuration: configuration, device: device, renderer: renderer)
  }
  return RarogClient(
    config: config, configuration: configuration, device: device, renderer: renderer, rejections: rejections)
}

/// Klient na ``MockURLProtocol`` z odpowiedzią `handler`.
private func mockClient(
  rejections: CredentialRejectionLatch?, handler: @escaping MockURLProtocol.Handler
) -> RarogClient {
  ownedClient(port: MockURLProtocol.register(handler), protocolClass: MockURLProtocol.self, rejections: rejections)
}

/// Atrapa serwera, który przyjmuje żądanie i milknie: `silent` nie odpowiada wcale, `streamHeaders` oddaje
/// nagłówki strumienia SSE i jedną ramkę, potem cisza. `invalidate()` zastaje więc żądanie w locie. Rejestr
/// per port, jak w ``MockURLProtocol``, żeby testy mogły biec równolegle.
private final class StallingURLProtocol: URLProtocol, @unchecked Sendable {
  enum Mode: Sendable { case silent, streamHeaders }

  private static let modes = Mutex<[Int: Mode]>([:])
  private static let started = Mutex<[Int: Int]>([:])
  private static let stopped = Mutex<[Int: Int]>([:])
  private static let nextPort = Atomic<Int>(47_000)

  static func register(_ mode: Mode) -> Int {
    let port = nextPort.add(1, ordering: .relaxed).newValue
    modes.withLock { $0[port] = mode }
    return port
  }

  static func startedCount(port: Int) -> Int { started.withLock { $0[port] ?? 0 } }
  static func stoppedCount(port: Int) -> Int { stopped.withLock { $0[port] ?? 0 } }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let port = url.port, let mode = Self.modes.withLock({ $0[port] }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    if mode == .streamHeaders {
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data("data: {}\n\n".utf8))
    }
    Self.started.withLock { $0[port, default: 0] += 1 }
  }

  override func stopLoading() {
    guard let port = request.url?.port else { return }
    Self.stopped.withLock { $0[port, default: 0] += 1 }
  }
}

/// Czeka (najwyżej `limit`), aż warunek będzie prawdą; zwraca, czy się doczekał.
private func eventually(_ limit: Duration = .seconds(10), _ condition: () -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + limit
  while ContinuousClock.now < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return condition()
}

/// Wynik wywołania z typowanym błędem transportu (zadanie w tle zwraca go jako wartość). Błąd spoza
/// `TransportError` wraca jako `.invalidResponse` z opisem, więc test go zobaczy.
private func outcome<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, TransportError> {
  do {
    return .success(try await body())
  } catch let error as TransportError {
    return .failure(error)
  } catch {
    return .failure(.invalidResponse("błąd spoza TransportError: \(error)"))
  }
}

/// Wstrzymanie wywołania: klient czeka w `park()` (albo `parkBlocking()` na wątku wołającego), test czeka na jego
/// przybycie (`arrivals`) i puszcza je `release()`.
private final class Hold: Sendable {
  private struct State {
    var arrivals = 0
    var released = false
    var parked: [CheckedContinuation<Void, Never>] = []
  }

  private let state = Mutex(State())
  private let blocked = DispatchSemaphore(value: 0)

  var arrivals: Int { state.withLock { $0.arrivals } }

  func park() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let go = state.withLock { state in
        state.arrivals += 1
        guard !state.released else { return true }
        state.parked.append(continuation)
        return false
      }
      if go { continuation.resume() }
    }
  }

  func parkBlocking() {
    let wait = state.withLock { state in
      state.arrivals += 1
      return !state.released
    }
    if wait { blocked.wait() }
  }

  func release() {
    let parked = state.withLock { state in
      state.released = true
      defer { state.parked = [] }
      return state.parked
    }
    for continuation in parked { continuation.resume() }
    blocked.signal()
  }
}

/// Zapis punktów testowych sesji: wydane przepustki (każda to zadanie sesji URL albo gniazdo, które powstaje)
/// i prawdziwe unieważnienie sesji URL.
private final class ProbeLog: Sendable {
  private let admittedCalls = Mutex<[SessionCall]>([])
  private let endedCount = Mutex(0)

  var admitted: [SessionCall] { admittedCalls.withLock { $0 } }
  var ended: Int { endedCount.withLock { $0 } }

  /// `before`/`after` = wstrzymanie wywołania danego rodzaju przed przepustką albo po niej; gniazdo czeka w `before`.
  func probe(before: (SessionCall, Hold)? = nil, after: (SessionCall, Hold)? = nil) -> SessionProbe {
    SessionProbe(
      beforePass: { call in if let before, before.0 == call { await before.1.park() } },
      afterPass: { call in if let after, after.0 == call { await after.1.park() } },
      beforeSocket: { if let before, before.0 == .terminalSocket { before.1.parkBlocking() } },
      admitted: { call in self.admittedCalls.withLock { $0.append(call) } },
      ended: { self.endedCount.withLock { $0 += 1 } })
  }
}

/// Polityka, która trzyma każdą mutację w bramce zgodności, aż test ją puści (jak mutacja czekająca na `hello`).
private struct HoldingPolicy: MutationPolicy {
  let hold: Hold

  func compatibilityRefusal() async -> PolicyRefusal? {
    await hold.park()
    return nil
  }

  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

/// Klient z punktami testowymi sesji na ``MockURLProtocol`` (odpowiedź 200 `{}` na każde żądanie). Zwraca też port,
/// żeby test sprawdził, że żądanie do atrapy nie dotarło.
private func probedClient(
  policy: any MutationPolicy = AllowAllMutations(), probe: SessionProbe
) -> (client: RarogClient, port: Int) {
  let port = MockURLProtocol.register { _ in .json(200, "{}") }
  let config = RarogConfig.test(port: port, build: 42, clientLabel: "iPhone·Rarog")
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [MockURLProtocol.self]
  var device = testDevice
  device.serverURL = config.baseURL
  let client = RarogClient(
    config: config, policy: policy, configuration: configuration, device: device,
    renderer: ServerText.renderer(language: .pl), rejections: CredentialRejectionLatch(), probe: probe)
  return (client, port)
}

/// Wywołanie synchroniczne na osobnym wątku (gniazdo terminala czeka w punkcie testowym, blokując wątek).
private func onThread<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
  try await withCheckedThrowingContinuation { continuation in
    Thread { continuation.resume(with: Result { try body() }) }.start()
  }
}

/// Scenariusz unieważnienia: udane `begin()`, wywołanie wstrzymane przed utworzeniem zadania, `startClosing()`, termin
/// drenowania mija, `invalidate()`, zwolnienie wywołania. Oczekiwane `.cancelled`, bez przepustki i bez żądania do
/// atrapy, a sesja URL kończy się od razu przy `invalidate()` (żadna przepustka nie jest wydana).
private func expectCancelledAfterInvalidate<T: Sendable>(
  client: RarogClient, port: Int, hold: Hold, log: ProbeLog, _ call: @escaping @Sendable () async throws -> T
) async {
  let ticket = GenerationTicket()
  #expect(ticket.begin())
  let running = Task {
    let result = await outcome(call)
    ticket.end()
    return result
  }
  #expect(await eventually { hold.arrivals == 1 })
  ticket.startClosing()
  #expect(!ticket.begin())
  #expect(await ticket.drained(within: .milliseconds(20)) == false)
  client.invalidate()
  #expect(log.ended == 1)
  hold.release()

  let result = await running.value
  if case .failure(.cancelled) = result {} else { Issue.record("oczekiwane .cancelled, jest \(result)") }
  #expect(log.admitted.isEmpty, "przepustka po invalidate(): \(log.admitted)")
  #expect(MockURLProtocol.requests(port: port).isEmpty)
  #expect(await ticket.drained(within: .seconds(5)))
  #expect(log.ended == 1)
}

/// Scenariusze w procesie potomnym (bez przechwyconych wartości, każdy buduje własnego klienta).
private enum InvalidationScenarios {
  /// REST: mutacja czeka w bramce mutacji, gdy właściciel unieważnia klienta.
  static func data() async {
    let hold = Hold()
    let log = ProbeLog()
    let (client, port) = probedClient(policy: HoldingPolicy(hold: hold), probe: log.probe())
    await expectCancelledAfterInvalidate(client: client, port: port, hold: hold, log: log) {
      try await client.perform(APIRequest(method: "POST", path: "/api/term"))
    }
  }

  /// Wysyłka z ciałem: czeka w bramce mutacji.
  static func upload() async {
    let hold = Hold()
    let log = ProbeLog()
    let (client, port) = probedClient(policy: HoldingPolicy(hold: hold), probe: log.probe())
    await expectCancelledAfterInvalidate(client: client, port: port, hold: hold, log: log) {
      try await client.sendMessage(
        sessionId: "s1", MessageUpload(body: .data(Data("{}".utf8)), clientMessageId: nil), timeout: .seconds(30),
        progress: nil)
    }
  }

  /// Strumień bajtów (SSE i zdjęcie): odczyt bez bramki mutacji, wstrzymany w punkcie przed przepustką.
  static func bytes() async {
    for read in [ByteRead.stream, .image] {
      let hold = Hold()
      let log = ProbeLog()
      let (client, port) = probedClient(probe: log.probe(before: (.bytes, hold)))
      await expectCancelledAfterInvalidate(client: client, port: port, hold: hold, log: log) {
        switch read {
        case .stream: _ = try await client.openStream(.global)
        case .image: _ = try await client.uploadImage(sessionId: "s1", file: "0123456789abcdef.png")
        }
      }
    }
  }

  enum ByteRead: Sendable { case stream, image }

  /// Wywołanie z przepustką wstrzymane przed `URLSession`: `invalidate()` nie unieważnia jeszcze sesji URL (wywołanie
  /// mogłoby tworzyć zadanie), robi to dopiero jego powrót z `.cancelled`.
  static func admittedCall() async {
    let hold = Hold()
    let log = ProbeLog()
    let (client, port) = probedClient(probe: log.probe(after: (.data, hold)))
    let call = Task { await outcome { try await client.perform(.get("/api/version")) } }
    #expect(await eventually { hold.arrivals == 1 })

    client.invalidate()
    #expect(log.ended == 0, "sesja URL unieważniona przy wydanej przepustce")
    hold.release()
    let result = await call.value
    if case .failure(.cancelled) = result {} else { Issue.record("oczekiwane .cancelled, jest \(result)") }
    #expect(await eventually { log.ended == 1 })
    #expect(log.admitted == [.data])
    #expect(MockURLProtocol.requests(port: port).isEmpty)
  }
}

@Suite("własność klienta: wspólny zatrzask odmowy i invalidate()")
struct RarogClientOwnershipTests {
  // MARK: Zatrzask odmowy wspólny dla klientów jednego poświadczenia

  @Test("dwa klienty z jednym zatrzaskiem: device-revoked z jednego → oba widzą revoked")
  func sharedLatchRevoked() async throws {
    let revoked = try golden("error.device-revoked.json")
    let latch = CredentialRejectionLatch()
    #expect(latch.value == nil)
    let refused = mockClient(rejections: latch) { _ in .json(401, revoked) }
    let healthy = mockClient(rejections: latch) { _ in .json(204, "") }

    let refusal = await outcome { _ = try await refused.perform(.get("/api/version")) }
    guard case .failure(.unauthorized) = refusal else {
      Issue.record("oczekiwane .unauthorized, jest \(refusal)")
      return
    }
    #expect(refused.credentialRejection == revokedForTestDevice)
    #expect(healthy.credentialRejection == revokedForTestDevice)
    #expect(latch.value == revokedForTestDevice)

    // Udana odpowiedź drugiego klienta nie zdejmuje odmowy (zatrzask nie ma drogi wstecz).
    _ = try await healthy.perform(.get("/api/version"))
    #expect(healthy.credentialRejection == revokedForTestDevice)
    #expect(refused.credentialRejection == revokedForTestDevice)
  }

  @Test("revoked po unknown zostaje revoked: unknown → revoked nadpisuje, revoked → unknown nie ustępuje")
  func revokedStaysAfterUnknown() async throws {
    let revoked = try golden("error.device-revoked.json")
    let unknown = try golden("error.device-unknown.json")
    let latch = CredentialRejectionLatch()
    let first = mockClient(rejections: latch) { _ in .json(401, unknown) }
    let second = mockClient(rejections: latch) { _ in .json(401, revoked) }

    _ = await outcome { try await first.version() }
    #expect(latch.value == .unknown(deviceId: testDevice.deviceId))
    #expect(second.credentialRejection == .unknown(deviceId: testDevice.deviceId))

    _ = await outcome { try await second.version() }
    #expect(first.credentialRejection == revokedForTestDevice)

    // Późniejsze „nieznane” (SSE i REST) nie cofa zatrzasku do słabszego stanu.
    _ = await outcome { _ = try await first.openStream(.global) }
    _ = await outcome { try await first.usage() }
    #expect(first.credentialRejection == revokedForTestDevice)
    #expect(second.credentialRejection == revokedForTestDevice)
    #expect(latch.value == revokedForTestDevice)
  }

  @Test("równoczesne 401 klientów jednego zatrzasku: jedno revoked wśród wielu unknown → revoked w każdej kolejności")
  func concurrentRejections() async throws {
    let revoked = try golden("error.device-revoked.json")
    let unknown = try golden("error.device-unknown.json")
    for _ in 0..<20 {
      let latch = CredentialRejectionLatch()
      let unknowns = (0..<8).map { _ in mockClient(rejections: latch) { _ in .json(401, unknown) } }
      let revoker = mockClient(rejections: latch) { _ in .json(401, revoked) }
      var calls: [RarogClient] = Array(repeating: unknowns, count: 4).flatMap { $0 } + [revoker]
      calls.shuffle()
      await withTaskGroup(of: Void.self) { group in
        for client in calls {
          group.addTask { _ = await outcome { try await client.version() } }
        }
      }
      #expect(latch.value == revokedForTestDevice)
      #expect(unknowns.allSatisfy { $0.credentialRejection == revokedForTestDevice })
    }
  }

  @Test("klient bez parametru rejections ma własny zatrzask")
  func defaultLatchIsPrivate() async throws {
    let revoked = try golden("error.device-revoked.json")
    let refused = mockClient(rejections: nil) { _ in .json(401, revoked) }
    let other = mockClient(rejections: nil) { _ in .json(204, "") }
    _ = await outcome { try await refused.version() }
    #expect(refused.credentialRejection == revokedForTestDevice)
    #expect(other.credentialRejection == nil)
  }

  @Test("generacja iroh i klient HTTPS jednego poświadczenia dzielą zatrzask przez TunnelGeneration")
  func generationsShareLatch() async throws {
    let revoked = try golden("error.device-revoked.json")
    let latch = CredentialRejectionLatch()
    let iroh = TunnelGeneration(
      number: 7, choice: .iroh, client: mockClient(rejections: latch) { _ in .json(401, revoked) },
      ticket: GenerationTicket())
    let https = TunnelGeneration(
      number: 8, choice: .https, client: mockClient(rejections: latch) { _ in .json(204, "") },
      ticket: GenerationTicket())
    #expect(iroh.number == 7 && iroh.choice == .iroh)
    #expect(https.number == 8 && https.choice == .https)

    #expect(iroh.ticket.begin())
    _ = await outcome { try await iroh.client.version() }
    iroh.ticket.end()
    #expect(await iroh.ticket.drained(within: .zero))
    #expect(https.client.credentialRejection == revokedForTestDevice)
  }

  @Test("drzwi uploadu: klient, bilet i zamknięcie z kodem (1 = anulowany upload)")
  func uploadDoorCarriesClose() async {
    let codes = Mutex<[UInt64]>([])
    let door = UploadDoor(
      client: mockClient(rejections: CredentialRejectionLatch()) { _ in .json(204, "") },
      ticket: GenerationTicket(), close: { code in codes.withLock { $0.append(code) } })
    #expect(door.ticket.begin())
    door.ticket.end()
    await door.close(1)
    #expect(codes.withLock { $0 } == [1])
  }

  // MARK: invalidate() właściciela

  @Test("invalidate() w trakcie żądania REST → TransportError.cancelled u wołającego, także przez kopię klienta")
  func invalidateCancelsRequest() async {
    let port = StallingURLProtocol.register(.silent)
    let client = ownedClient(port: port, protocolClass: StallingURLProtocol.self, rejections: nil)
    let owner = client  // kopia wartości: ta sama sesja URL
    let call = Task { await outcome { try await client.version() } }
    #expect(await eventually { StallingURLProtocol.startedCount(port: port) == 1 })

    owner.invalidate()
    let result = await call.value
    guard case .failure(.cancelled) = result else {
      Issue.record("oczekiwane .cancelled, jest \(result)")
      return
    }
    #expect(await eventually { StallingURLProtocol.stoppedCount(port: port) == 1 })
    #expect(client.credentialRejection == nil)
  }

  @Test("invalidate() w trakcie otwierania strumienia SSE → .cancelled")
  func invalidateCancelsStreamOpen() async {
    let port = StallingURLProtocol.register(.silent)
    let client = ownedClient(port: port, protocolClass: StallingURLProtocol.self, rejections: nil)
    let call = Task { await outcome { _ = try await client.openStream(.global) } }
    #expect(await eventually { StallingURLProtocol.startedCount(port: port) == 1 })

    client.invalidate()
    let result = await call.value
    guard case .failure(.cancelled) = result else {
      Issue.record("oczekiwane .cancelled, jest \(result)")
      return
    }
  }

  @Test("invalidate() przy otwartym strumieniu SSE → strumień kończy się .cancelled")
  func invalidateEndsOpenStream() async throws {
    let port = StallingURLProtocol.register(.streamHeaders)
    let client = ownedClient(port: port, protocolClass: StallingURLProtocol.self, rejections: nil)
    let stream = try await client.openStream(.global)
    var frames = stream.makeAsyncIterator()
    #expect(try await frames.next() != nil)

    client.invalidate()
    do {
      while try await frames.next() != nil {}
      Issue.record("strumień skończył się bez błędu")
    } catch let error as TransportError {
      #expect(error == .cancelled)
    }
  }

  // MARK: Wywołanie po invalidate(): `.cancelled` bez zadania sesji URL

  @Test("REST czekające w bramce mutacji dłużej niż termin drenowania → po invalidate() .cancelled bez zadania")
  func heldRequestAfterInvalidate() async {
    await #expect(processExitsWith: .success) { await InvalidationScenarios.data() }
  }

  @Test("wysyłka czekająca w bramce mutacji dłużej niż termin drenowania → po invalidate() .cancelled bez zadania")
  func heldUploadAfterInvalidate() async {
    await #expect(processExitsWith: .success) { await InvalidationScenarios.upload() }
  }

  @Test("strumień SSE i zdjęcie wstrzymane przed zadaniem → po invalidate() .cancelled bez zadania")
  func heldBytesAfterInvalidate() async {
    await #expect(processExitsWith: .success) { await InvalidationScenarios.bytes() }
  }

  @Test("gniazdo terminala wstrzymane przed utworzeniem → po invalidate() .cancelled bez gniazda")
  func heldSocketAfterInvalidate() async {
    let hold = Hold()
    let log = ProbeLog()
    let (client, port) = probedClient(probe: log.probe(before: (.terminalSocket, hold)))
    await expectCancelledAfterInvalidate(client: client, port: port, hold: hold, log: log) {
      try await onThread { try client.terminalSocket(id: "0123456789abcdef", fresh: true, direct: false, grid: nil) }
    }
  }

  @Test("invalidate() przy wywołaniu z przepustką: sesja URL kończy się dopiero po jego powrocie z .cancelled")
  func invalidateWaitsForAdmittedCall() async {
    await #expect(processExitsWith: .success) { await InvalidationScenarios.admittedCall() }
  }

  @Test("invalidate() bez wywołań w locie kończy sesję URL od razu i tylko raz, także przez kopię klienta")
  func invalidateIdleClient() async {
    let log = ProbeLog()
    let (client, port) = probedClient(probe: log.probe())
    let copy = client
    _ = try? await client.version()
    #expect(log.admitted == [.data])
    #expect(MockURLProtocol.requests(port: port).count == 1)

    client.invalidate()
    copy.invalidate()
    #expect(log.ended == 1)
  }
}
