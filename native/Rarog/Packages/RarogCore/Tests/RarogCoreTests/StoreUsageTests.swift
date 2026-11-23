import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Limity planu i sonda wersji z nazwą tailnetu: reduktor i rytm
// odpytywania w magazynie. Właściciel: lista.

private func usageBody(_ name: String) throws -> PlanUsage {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try JSONDecoder().decode(PlanUsage.self, from: Data(contentsOf: url))
}

private func versionInfo(tailnet: String = #""example.com""#, extra: String = "") -> VersionInfo {
  let json = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"s","tailnet":\#(tailnet)\#(extra)}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

/// Sonda wersji z podaną wersją serwera.
func serverVersionInfo(_ version: String) -> VersionInfo {
  let json = #"{"version":"\#(version)","protocolVersion":3,"serverStartId":"s"}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

private let unavailable503 = TransportError.http(APIFailure(status: 503, code: "usage-unavailable"))

/// Atrapa z kontrolą `GET /api/usage`, `GET /api/version` i `GET /api/mac`; strumienie i mutacje
/// z `FakeTransport`.
final class ProbeTransport: RarogTransporting, @unchecked Sendable {
  struct Probe {
    /// Kolejne odpowiedzi limitów; ostatnia powtarza się w nieskończoność.
    var usage: [Result<PlanUsage, TransportError>] = [.failure(.offline(.notConnectedToInternet))]
    var version: Result<VersionInfo, TransportError> = .failure(.offline(.notConnectedToInternet))
    /// Kolejne odpowiedzi obciążenia Maca; ostatnia powtarza się w nieskończoność.
    var mac: [Result<MacLoad, TransportError>] = [.failure(.offline(.notConnectedToInternet))]
    /// Odpowiedź `GET /api/usage/details` (arkusz „Limity”).
    var details: Result<PlanUsage, TransportError> = .failure(.offline(.notConnectedToInternet))
    var detailsCalls = 0
    var usageCalls = 0
    var versionCalls = 0
    var macCalls = 0
    /// Jak `hold`, ale wyłącznie dla odczytu Maca (biegnie obok limitów w tym samym obrocie pętli).
    var macHold = false
    /// Odczyt wywołany przy `hold` czeka na `release()` (spóźniona odpowiedź); wynik z chwili wywołania.
    var hold = false
    /// Odpowiedź już w drodze: anulowanie zadania jej nie zatrzyma (wyścig z `URLSession`).
    var holdIgnoresCancel = false
    var held: [UUID: CheckedContinuation<Void, Never>] = [:]
    var cancelledHolds: Set<UUID> = []
  }

  let base: FakeTransport
  let probe = Mutex(Probe())

  init(base: FakeTransport = FakeTransport()) {
    self.base = base
  }

  var usageCalls: Int { probe.withLock { $0.usageCalls } }
  var versionCalls: Int { probe.withLock { $0.versionCalls } }
  var macCalls: Int { probe.withLock { $0.macCalls } }
  var detailsCalls: Int { probe.withLock { $0.detailsCalls } }

  func set(_ change: (inout Probe) -> Void) { probe.withLock { change(&$0) } }

  /// Wypuszcza wstrzymane odczyty.
  func release() {
    let waiting = probe.withLock { state in
      defer { state.held = [:] }
      return Array(state.held.values)
    }
    for continuation in waiting { continuation.resume() }
  }

  /// Czeka na `release()`. Anulowane zadanie kończy się `.cancelled` jak w `URLSession` — bez odpowiedzi
  /// serwera — chyba że odpowiedź jest już w drodze (`holdIgnoresCancel`).
  private func waitIfHeld(_ hold: Bool, ignoresCancel: Bool) async throws(TransportError) {
    guard hold else { return }
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let cancelled = probe.withLock { state in
          if state.cancelledHolds.contains(id) { return true }
          state.held[id] = continuation
          return false
        }
        if cancelled { continuation.resume() }
      }
    } onCancel: {
      guard !ignoresCancel else { return }
      let continuation = probe.withLock { state in
        if let waiting = state.held.removeValue(forKey: id) { return Optional(waiting) }
        state.cancelledHolds.insert(id)
        return nil
      }
      continuation?.resume()
    }
    if !ignoresCancel, Task.isCancelled { throw .cancelled }
  }

  private func answer<Value>(_ result: Result<Value, TransportError>) throws(TransportError) -> Value {
    try result.get()
  }

  var hasCredential: Bool { base.hasCredential }


  /// Jak `URLSession`: zadanie anulowane, zanim żądanie wyszło (wylogowanie anuluje odczyt, którego
  /// zadanie jeszcze nie ruszyło), nie dociera do serwera i nie liczy się jako odczyt.
  private func notCancelled() throws(TransportError) {
    if Task.isCancelled { throw .cancelled }
  }

  func version() async throws(TransportError) -> VersionInfo {
    try notCancelled()
    let (result, hold, ignoresCancel) = probe.withLock { state in
      state.versionCalls += 1
      return (state.version, state.hold, state.holdIgnoresCancel)
    }
    try await waitIfHeld(hold, ignoresCancel: ignoresCancel)
    return try answer(result)
  }

  func usage() async throws(TransportError) -> PlanUsage {
    try notCancelled()
    let (result, hold, ignoresCancel) = probe.withLock { state in
      state.usageCalls += 1
      return (state.usage.count > 1 ? state.usage.removeFirst() : state.usage[0], state.hold, state.holdIgnoresCancel)
    }
    try await waitIfHeld(hold, ignoresCancel: ignoresCancel)
    return try answer(result)
  }

  func usageDetails() async throws(TransportError) -> PlanUsage {
    try notCancelled()
    let (result, hold, ignoresCancel) = probe.withLock { state in
      state.detailsCalls += 1
      return (state.details, state.hold, state.holdIgnoresCancel)
    }
    try await waitIfHeld(hold, ignoresCancel: ignoresCancel)
    return try answer(result)
  }

  func mac() async throws(TransportError) -> MacLoad {
    try notCancelled()
    let (result, hold, ignoresCancel) = probe.withLock { state in
      state.macCalls += 1
      return (state.mac.count > 1 ? state.mac.removeFirst() : state.mac[0], state.macHold, state.holdIgnoresCancel)
    }
    try await waitIfHeld(hold, ignoresCancel: ignoresCancel)
    return try answer(result)
  }

  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    try await base.sendMessage(sessionId: sessionId, upload, timeout: timeout, progress: progress)
  }

  func recentProjects() async throws(TransportError) -> RecentProjectList { try await base.recentProjects() }

  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    try await base.createSession(body)
  }

  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    try await base.closeSession(sessionId: sessionId, body)
  }

  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await base.decidePermission(sessionId: sessionId, permId: permId, body)
  }

  func presence(_ body: PresenceBody) async throws(TransportError) { try await base.presence(body) }

  func clientLog(_ body: ClientLogBody) async throws(TransportError) { try await base.clientLog(body) }

  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error> {
    try await base.openStream(scope, lastEventId: lastEventId, watch: watch)
  }
}

/// Spóźniona odpowiedź odczytu sprzed wylogowania.
struct LateRead<Value: Sendable>: Sendable, CustomTestStringConvertible {
  let result: Result<Value, TransportError>
  /// Odpowiedź już w drodze: anulowanie przy wylogowaniu jej nie zatrzyma.
  let arrived: Bool
  let testDescription: String
}

private let staleUsage = try! usageBody("usage.cli.json")
private let expired401 = TransportError.unauthorized(APIFailure(status: 401))

@MainActor
func makeProbeStore(
  _ transport: ProbeTransport, timing: UsageTiming, core: CoreTiming = fastTiming,
  clock: @escaping @Sendable () -> Date = { Date() }
) -> RarogStore {
  let rules = MutationRules(timing: core)
  transport.base.gate = MutationGate(policy: rules)
  let store = RarogStore(
    transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: core, clock: clock)
  store.usageTiming = timing
  return store
}

/// Magazyn z rytmem na wirtualnym zegarze: terminy liczy `clock.now`, pętla śpi na `clock.sleep`.
/// Testy rytmu idą krokami czasu, więc nie zależą od obciążenia maszyny.
@MainActor
func makeVirtualStore(
  _ transport: ProbeTransport, timing: UsageTiming, clock: VirtualClock, core: CoreTiming = fastTiming
) -> RarogStore {
  let store = makeProbeStore(transport, timing: timing, core: core, clock: { clock.now })
  store.useVirtualSleep(clock)
  return store
}

private let hello = #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#

/// Strumień globalny otwarty i `hello` jak z serwera, który zaczyna nim każde połączenie
/// (`server/src/sse.ts`, `openGlobal`); atrapa transportu sama go nie wysyła.
@MainActor
func connected(_ store: RarogStore, _ transport: ProbeTransport) async {
  await until("online") { store.state.global == .online }
  transport.base.push(.global, json: hello)
}

@Suite("reduktor: limity planu i sonda wersji")
struct ReducerUsageTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  @Test("szkielet → liczby → sieć padła (przygaszone) → 503 (bez liczb, „niedostępne”)")
  func phases() throws {
    var state = AppState(clientBuild: 1)
    #expect(state.planUsage.phase == .loading)
    state.apply(.planUsageResult(.failed, at: t0), now: t0)
    #expect(state.planUsage.phase == .unavailable, "porażka przed pierwszymi liczbami")
    let fresh = try usageBody("usage.json")
    state.apply(.planUsageResult(.loaded(fresh), at: t0), now: t0)
    #expect(state.planUsage.phase == .ready && state.planUsage.usage == fresh && state.planUsage.receivedAt == t0)
    state.apply(.planUsageResult(.failed, at: t0.addingTimeInterval(300)), now: t0)
    #expect(state.planUsage.phase == .stale && state.planUsage.usage == fresh, "liczby zostają, przygaszone")
    #expect(state.planUsage.receivedAt == t0, "godzina odczytu to godzina liczb, nie porażki")
    state.apply(.planUsageResult(.unavailable, at: t0), now: t0)
    #expect(state.planUsage.phase == .unavailable && state.planUsage.usage == nil, "503 = nie wiem, liczb nie zgadujemy")
  }

  @Test("ostatni dobry odczyt serwera i zapas z paska CLI są przygaszone; odpowiedź bez okien to porażka")
  func staleFromServer() throws {
    var state = AppState(clientBuild: 1)
    state.apply(.planUsageResult(.loaded(try usageBody("usage.stale.json")), at: t0), now: t0)
    #expect(state.planUsage.phase == .stale)
    state.apply(.planUsageResult(.loaded(try usageBody("usage.cli.json")), at: t0), now: t0)
    #expect(state.planUsage.phase == .stale && state.planUsage.usage?.source == "cli")
    let empty = try JSONDecoder().decode(PlanUsage.self, from: Data(#"{"account":"a@b.c"}"#.utf8))
    var blank = AppState(clientBuild: 1)
    blank.apply(.planUsageResult(.loaded(empty), at: t0), now: t0)
    #expect(blank.planUsage.phase == .unavailable && blank.planUsage.usage == nil)
  }

  @Test("sonda wersji: flagi z ustalonym znaczeniem braku, tailnet przycięty, pusty = nil")
  func version() {
    var state = AppState(clientBuild: 1)
    state.apply(.versionProbed(versionInfo(tailnet: #"" example.com ""#, extra: #","notesEnabled":true"#)), now: t0)
    #expect(state.tailnet == "example.com")
    #expect(state.capabilities?.voice == true, "brak voiceEnabled = włączone")
    #expect(state.capabilities?.notes == true && state.capabilities?.terminal == false)
    state.apply(.versionProbed(versionInfo(tailnet: "null")), now: t0)
    #expect(state.tailnet == nil)
    state.apply(.versionProbed(versionInfo(tailnet: #""  ""#)), now: t0)
    #expect(state.tailnet == nil)
  }

  @Test("logowanie i wylogowanie kasują limity, flagi i tailnet")
  func reset() throws {
    var state = AppState(clientBuild: 1)
    state.apply(.planUsageResult(.loaded(try usageBody("usage.json")), at: t0), now: t0)
    state.apply(.versionProbed(versionInfo()), now: t0)
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(state.planUsage == PlanUsageState() && state.tailnet == nil && state.capabilities == nil)
    #expect(state.serverVersion == nil, "wersja serwera należy do połączenia")
    state.apply(.versionProbed(versionInfo()), now: t0)
    state.apply(.loggedIn, now: t0)
    #expect(state.tailnet == nil && state.capabilities == nil && state.serverVersion == nil)
  }

  @Test("sonda wersji zapisuje wersję serwera; każda udana sonda ją nadpisuje")
  func serverVersion() {
    var state = AppState(clientBuild: 1)
    state.apply(.versionProbed(versionInfo()), now: t0)
    #expect(state.serverVersion == "0.1.0")
    state.apply(.versionProbed(serverVersionInfo("0.2.0")), now: t0)
    #expect(state.serverVersion == "0.2.0")
  }

  @Test("system maszyny serwera: z sondy; brak pola zostawia ostatni znany; logowanie go nie kasuje; słowo z reguły")
  func serverSystem() {
    var state = AppState(clientBuild: 1)
    #expect(state.serverSystem == nil && state.serverMachine == .mac, "przed pierwszą sondą: Mac")
    state.apply(.versionProbed(versionInfo(extra: #","system":"linux""#)), now: t0)
    #expect(state.serverSystem == .linux && state.serverMachine == .vps)
    state.apply(.versionProbed(versionInfo()), now: t0)
    #expect(state.serverSystem == .linux, "serwer sprzed pola: ostatni znany")
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    state.apply(.loggedIn, now: t0)
    #expect(state.serverSystem == .linux, "system należy do poświadczenia, nie do połączenia")
    state.apply(.versionProbed(versionInfo(extra: #","system":"freebsd""#)), now: t0)
    #expect(state.serverSystem == .unsupported && state.serverMachine == .vps)
    state.apply(.versionProbed(versionInfo(extra: #","system":"macos""#)), now: t0)
    #expect(state.serverMachine == .mac)
  }

  @Test("związanie z poświadczeniem daje jego system do pierwszej sondy; bez klucza słowo z odpięcia")
  func serverSystemFromBinding() {
    var state = AppState(clientBuild: 1)
    var credential = PairingFixtures.credential()
    credential.serverSystem = .other
    state.apply(.pairing(.bound(.device(PairedServer(credential)))), now: t0)
    #expect(state.serverSystem == .other && state.serverMachine == .vps)
    // Inne poświadczenie (świeże parowanie) jeszcze bez systemu: Mac do sondy.
    state.apply(.pairing(.bound(.device(PairedServer(PairingFixtures.credential(deviceId: "0a"))))), now: t0)
    #expect(state.serverSystem == nil && state.serverMachine == .mac)
    state.apply(.versionProbed(versionInfo(extra: #","system":"linux""#)), now: t0)
    let revocation = DeviceRevocation(
      deviceId: "0a", server: "rarog.example", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin",
      serverSystem: state.serverSystem)
    state.apply(.pairing(.revoked(revocation)), now: t0)
    state.apply(.pairing(.bound(.none)), now: t0)
    #expect(state.serverSystem == nil && state.serverMachine == .vps, "ekran odpięcia: system z odpięcia")
    state.apply(.pairing(.revoked(nil)), now: t0)
    #expect(state.serverMachine == .mac, "bez serwera i bez odpięcia: nie wiadomo")
  }
}

@MainActor
@Suite("magazyn: odpytywanie limitów i sonda wersji")
struct StoreUsageTests {
  @Test("start: limity od razu, potem co `refresh`; liczby w stanie")
  func pollsOnStartAndPeriodically() async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set { $0.usage = [.success(fresh)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .milliseconds(400), retry: .milliseconds(40), floor: .zero), clock: clock)
    await store.start()
    await until("pierwszy odczyt") { store.state.planUsage.phase == .ready }
    await until("pętla śpi") { clock.sleeping.count == 1 }
    #expect(transport.usageCalls == 1)
    await clock.step(.milliseconds(120))
    #expect(transport.usageCalls == 1, "przy liczbach nie częściej niż co `refresh`")
    await clock.stepPast(.milliseconds(280))
    #expect(transport.usageCalls == 2, "drugi odczyt po `refresh`")
  }

  /// Rytm apki: limity co 60 s, gdy apka jest na wierzchu. Odczyt serwera to milisekundy.
  @Test("rytm apki: limity co 15 s na wierzchu, nie co minutę")
  func productionRefreshIsFifteenSeconds() async throws {
    #expect(UsageTiming.production.refresh == .seconds(15))
    let transport = ProbeTransport()
    transport.set { $0.usage = [.success(try! usageBody("usage.json"))] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: .production, clock: clock)
    await store.start()
    await until("pierwszy odczyt") { store.state.planUsage.phase == .ready }
    await until("pętla śpi") { clock.sleeping.count == 1 }
    await clock.step(.seconds(14))
    #expect(transport.usageCalls == 1, "przed 15 s bez drugiego odczytu")
    await clock.stepPast(.seconds(1))
    #expect(transport.usageCalls == 2, "drugi odczyt po 15 s")
  }

  @Test("503: bez liczb i ponowienie co `retry`; potem liczby")
  func retriesWhenUnavailable() async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set { $0.usage = [.failure(unavailable503), .success(fresh)] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .milliseconds(60), floor: .zero))
    await store.start()
    await until("niedostępne") { store.state.planUsage.phase == .unavailable }
    await until("ponowienie i liczby") { store.state.planUsage.phase == .ready }
    #expect(transport.usageCalls == 2)
  }

  @Test("sieć padła przy odświeżeniu: ostatnie liczby zostają, przygaszone")
  func keepsNumbersOnNetworkFailure() async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set { $0.usage = [.success(fresh), .failure(.timedOut)] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .milliseconds(60), retry: .milliseconds(60), floor: .zero))
    await store.start()
    await until("przygaszone") { store.state.planUsage.phase == .stale }
    #expect(store.state.planUsage.usage == fresh)
  }

  @Test("tło i nieaktywna scena zatrzymują odpytywanie; wejście na wierzch czyta od razu")
  func onlyWhenActive() async throws {
    let transport = ProbeTransport()
    transport.set { $0.usage = [.success(try! usageBody("usage.json"))] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await until("pierwszy odczyt") { transport.usageCalls == 1 }
    store.setScenePhase(.inactive)
    store.setScenePhase(.background)
    try await Task.sleep(for: .milliseconds(60))
    #expect(transport.usageCalls == 1)
    store.setScenePhase(.inactive)
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.usageCalls == 1, "scena nieaktywna nie czyta")
    store.setScenePhase(.active)
    await until("odczyt po wejściu na wierzch") { transport.usageCalls == 2 }
  }

  @Test("podłoga: szybki powrót na wierzch nie czyta drugi raz; tap czyta zawsze")
  func floorAndManualRefresh() async throws {
    let transport = ProbeTransport()
    transport.set { $0.usage = [.success(try! usageBody("usage.json"))] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .seconds(30)))
    await store.start()
    await until("pierwszy odczyt") { transport.usageCalls == 1 }
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    try await Task.sleep(for: .milliseconds(60))
    #expect(transport.usageCalls == 1)
    store.refreshUsageNow()
    await until("odczyt z tapnięcia") { transport.usageCalls == 2 }
  }

  @Test("hello → sonda wersji (flagi, tailnet) od razu")
  func versionAfterHello() async throws {
    let transport = ProbeTransport()
    transport.set { $0.version = .success(versionInfo(extra: #","voiceEnabled":false"#)) }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero), clock: clock)
    await store.start()
    await until("online") { store.state.global == .online }
    // Pierwszy obrót pętli (z sondą, jeśli zdążył po połączeniu) za nami — inaczej jego sonda
    // i sonda po `hello` mogły wpaść obie po odczycie `before`.
    await until("pętla śpi") { clock.sleeping.count == 1 }
    let before = transport.versionCalls
    transport.base.push(.global, json: hello)
    await until("sonda po hello") { transport.versionCalls == before + 1 }
    await until("tailnet") { store.state.tailnet == "example.com" }
    #expect(store.state.capabilities?.voice == false)
  }

  @Test("wiersz aktualizacji: starszy serwer go stawia, przerwa łącza zostawia, sonda po aktualizacji zdejmuje")
  func serverUpdateFollowsProbe() async throws {
    let transport = ProbeTransport()
    transport.set { $0.version = .success(serverVersionInfo("0.0.1")) }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await connected(store, transport)
    await until("wiersz po sondzie") { store.state.serverUpdate?.server == "0.0.1" }
    transport.base.end(.global, error: .offline(.notConnectedToInternet))
    await until("łącze zerwane") { store.state.global != .online }
    #expect(store.state.serverUpdate != nil, "offline zostaje ostatnia znana wersja, wiersz nie miga")
    transport.set { $0.version = .success(serverVersionInfo(ServerRelease.version)) }
    await connected(store, transport)
    await until("sonda po aktualizacji zdejmuje wiersz") { store.state.serverUpdate == nil }
    #expect(store.state.serverVersion == ServerRelease.version)
  }

  @Test("podłoga: hello zaraz po sondzie nie pyta ponownie (migoczące łącze)")
  func versionFloor() async throws {
    let transport = ProbeTransport()
    transport.set { $0.version = .success(versionInfo()) }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .seconds(30)))
    await store.start()
    await until("online") { store.state.global == .online }
    transport.base.push(.global, json: hello)
    await until("tailnet") { store.state.tailnet == "example.com" }
    let calls = transport.versionCalls
    transport.base.push(.global, json: hello)
    transport.base.push(.global, json: hello)
    try await Task.sleep(for: .milliseconds(60))
    #expect(transport.versionCalls == calls)
  }

  @Test("bez żywego strumienia nie pyta o wersję; pusta nazwa → ponowienie co `retry`")
  func versionRetriesWhenEmpty() async throws {
    let transport = ProbeTransport()
    transport.set { $0.version = .success(versionInfo(tailnet: "null")) }
    // Strumień leży, dopóki test go nie podniesie (jedna porażka i 5 ms czekania ścigałyby się
    // z ponownym łączeniem po 10 ms).
    transport.base.set { $0.openFailures = Array(repeating: .offline(.notConnectedToInternet), count: 10_000) }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(60), retry: .milliseconds(80), floor: .zero), clock: clock)
    await store.start()
    await until("pętla śpi") { clock.sleeping.count == 1 }
    await clock.stepPast(.milliseconds(80))
    #expect(transport.versionCalls == 0, "przed połączeniem nie pyta")
    transport.base.set { $0.openFailures = [] }
    await until("online") { store.state.global == .online }
    await clock.stepPast(.milliseconds(80))
    #expect(transport.versionCalls == 1, "pierwsza sonda z pętli")
    await clock.stepPast(.milliseconds(80))
    #expect(transport.versionCalls == 2, "ponowienie przy pustej nazwie po `retry`")
  }

  @Test("401 strumienia: wylogowanie kasuje limity i tailnet, pętla staje")
  func logoutStopsPolling() async throws {
    let transport = ProbeTransport()
    transport.set {
      $0.usage = [.success(try! usageBody("usage.json"))]
      $0.version = .success(versionInfo())
    }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .milliseconds(80), retry: .milliseconds(80), floor: .zero), clock: clock)
    await store.start()
    await until("online") { store.state.global == .online }
    transport.base.push(.global, json: hello)
    await until("dane") { store.state.planUsage.phase == .ready && store.state.tailnet != nil }
    transport.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(store.state.planUsage == PlanUsageState() && store.state.tailnet == nil)
    await until("pętla stoi") { clock.sleeping.isEmpty && store.usagePolling.loop == nil }
    let calls = transport.usageCalls
    clock.advance(by: .seconds(1))
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.usageCalls == calls, "po wylogowaniu nikt nie pyta")
  }

  @Test("ponowne logowanie czyta limity od razu — podłoga sprzed wylogowania nie obowiązuje")
  func reloginReadsImmediately() async throws {
    let transport = ProbeTransport()
    transport.set { $0.usage = [.success(try! usageBody("usage.json"))] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .seconds(30)))
    await store.start()
    await until("pierwszy odczyt") { transport.usageCalls == 1 }
    await until("online") { store.state.global == .online }
    transport.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    store.enterLoggedIn()
    await until("odczyt po ponownym logowaniu") { store.state.planUsage.phase == .ready }
    #expect(transport.usageCalls == 2)
  }

  @Test("tap w trakcie snu pętli: 503 → ponowienie po `retry`, nie po końcu snu")
  func tapWakesLoop() async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set {
      $0.usage = [.success(fresh), .failure(unavailable503), .success(fresh)]
      $0.version = .success(versionInfo())
    }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(3), retry: .milliseconds(80), floor: .zero), clock: clock)
    await store.start()
    await connected(store, transport)
    await until("liczby i tailnet") { store.state.planUsage.phase == .ready && store.state.tailnet != nil }
    // Sonda po `hello` budzi pętlę i zamawia kontrolną po `retry`; po niej pętla śpi do terminu `refresh`.
    await until("pętla śpi do kontrolnej sondy") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80) }
    await clock.stepPast(.milliseconds(80))
    #expect(clock.sleeping.allSatisfy { $0 > .seconds(2) }, "sen do terminu `refresh`")
    store.refreshUsageNow()
    await until("503 z tapnięcia") { store.state.planUsage.phase == .unavailable }
    await until("pętla obudzona: sen do `retry`") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80) }
    #expect(transport.usageCalls == 2)
    await clock.stepPast(.milliseconds(80))
    #expect(store.state.planUsage.phase == .ready, "ponowienie po `retry`, nie po końcu snu")
    #expect(transport.usageCalls == 3)
  }

  @Test("powrót łącza: sonda po `hello`, potem kontrolna po `retry`, nie po końcu snu pętli")
  func recheckAfterReconnect() async throws {
    let transport = ProbeTransport()
    transport.set {
      $0.usage = [.success(try! usageBody("usage.json"))]
      $0.version = .success(versionInfo())
    }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(3), retry: .milliseconds(80), floor: .zero), clock: clock)
    await store.start()
    await connected(store, transport)
    await until("liczby i tailnet") { store.state.planUsage.phase == .ready && store.state.tailnet != nil }
    await until("pętla śpi do kontrolnej sondy") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80) }
    await clock.stepPast(.milliseconds(80))
    #expect(clock.sleeping.allSatisfy { $0 > .seconds(2) }, "po kontrolnej sondzie sen do terminu `refresh`")
    let before = transport.versionCalls
    transport.base.end(.global)
    await until("ponownie online") {
      transport.base.streamCalls.filter { $0.scope == .global }.count >= 2 && store.state.global == .online
    }
    transport.base.push(.global, json: hello)
    await until("sonda po hello") { transport.versionCalls == before + 1 }
    await until("pętla obudzona: sen do `retry`") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80) }
    await clock.stepPast(.milliseconds(80))
    #expect(transport.versionCalls == before + 2, "kontrolna sonda po `retry`, nie po końcu snu pętli")
  }

  @Test("przerwa strumienia po minionym terminie sondy: pętla nie wiruje, po `hello` wraca do rytmu sondy")
  func noSpinWhileOffline() async throws {
    let transport = ProbeTransport()
    transport.set {
      $0.usage = [.success(try! usageBody("usage.json"))]
      $0.version = .success(versionInfo(tailnet: "null"))
    }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(5), retry: .milliseconds(60), floor: .seconds(10)), clock: clock)
    await store.start()
    await connected(store, transport)
    await until("sonda po hello przy pustej nazwie") { transport.versionCalls >= 1 }
    await until("pętla śpi do terminu sondy") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(60) }
    // Przerwa trwa, dopóki test nie podniesie strumienia.
    transport.base.set { $0.openFailures = Array(repeating: .offline(.notConnectedToInternet), count: 10_000) }
    transport.base.end(.global, error: .timedOut)
    await until("przerwa") { store.state.global != .online }
    // Termin sondy (60 ms) mija w trakcie przerwy; `versionDue` bez strumienia odmawia, a sen idzie
    // do terminu limitów — nie 20 ms w kółko.
    let calls = transport.versionCalls
    await clock.stepPast(.milliseconds(100))
    #expect(clock.sleeping.allSatisfy { $0 > .seconds(4) }, "pętla śpi do terminu limitów, nie budzi się co 20 ms")
    #expect(transport.versionCalls == calls, "bez strumienia nie pyta")
    transport.base.set { $0.openFailures = [] }
    await until("powrót łącza") { store.state.global == .online }
    // `hello` tuż po ostatniej sondzie trafia w podłogę (10 s): budzi pętlę, a ona robi sondę, bo jej
    // termin minął w przerwie.
    transport.base.push(.global, json: hello)
    await until("sonda z pętli po powrocie") { transport.versionCalls > calls }
  }

  @Test(
    "odczyt limitów sprzed wylogowania: spóźnione 200, 503 i 401 nie ruszają nowego logowania",
    arguments: [
      LateRead(result: .success(staleUsage), arrived: false, testDescription: "200"),
      LateRead(result: .failure(unavailable503), arrived: false, testDescription: "503"),
      LateRead(result: .failure(expired401), arrived: false, testDescription: "401"),
      LateRead(result: .success(staleUsage), arrived: true, testDescription: "200 już w drodze"),
      LateRead(result: .failure(unavailable503), arrived: true, testDescription: "503 już w drodze"),
    ])
  func lateUsageAcrossRelogin(_ late: LateRead<PlanUsage>) async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set { $0.usage = [.success(fresh)] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await until("liczby i online") { store.state.planUsage.phase == .ready && store.state.global == .online }
    // Odczyt z tapnięcia wisi na sieci, a strumień dostaje 401: wylogowanie i od razu nowe logowanie.
    transport.set {
      $0.hold = true
      $0.holdIgnoresCancel = late.arrived
      $0.usage = [late.result]
    }
    store.refreshUsageNow()
    await until("odczyt w drodze") { transport.usageCalls == 2 }
    transport.base.end(.global, error: expired401)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    transport.set {
      $0.hold = false
      $0.usage = [.success(fresh)]
    }
    store.enterLoggedIn()
    await until("odczyt nowego logowania") { transport.usageCalls == 3 && store.state.planUsage.phase == .ready }
    // Dalszy odczyt nie nadpisałby śladu: porażka sieci zostawia, co już stoi.
    transport.set { $0.usage = [.failure(.timedOut)] }
    transport.release()
    try await Task.sleep(for: .milliseconds(80))
    #expect(store.state.auth == .loggedIn, "stary 401 nie wylogowuje nowego")
    #expect(store.state.planUsage.usage == fresh && store.state.planUsage.phase == .ready, "stare liczby nie wracają")
  }

  @Test(
    "sonda wersji sprzed wylogowania: spóźnione 200 i 401 nie ruszają nowego logowania",
    arguments: [
      LateRead(result: .success(versionInfo(tailnet: #""stary.pl""#)), arrived: false, testDescription: "200"),
      LateRead(result: .failure(expired401), arrived: false, testDescription: "401"),
      LateRead(result: .success(versionInfo(tailnet: #""stary.pl""#)), arrived: true, testDescription: "200 już w drodze"),
    ])
  func lateVersionAcrossRelogin(_ late: LateRead<VersionInfo>) async throws {
    let transport = ProbeTransport()
    transport.set {
      $0.usage = [.success(try! usageBody("usage.json"))]
      $0.version = .success(versionInfo())
    }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await connected(store, transport)
    await until("tailnet") { store.state.tailnet == "example.com" }
    // Sonda po kolejnym `hello` wisi na sieci, a strumień dostaje 401: wylogowanie i nowe logowanie.
    transport.set {
      $0.hold = true
      $0.holdIgnoresCancel = late.arrived
      $0.version = late.result
    }
    let before = transport.versionCalls
    transport.base.push(.global, json: hello)
    await until("sonda w drodze") { transport.versionCalls == before + 1 }
    transport.base.end(.global, error: expired401)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    transport.set {
      $0.hold = false
      $0.version = .success(versionInfo())
    }
    store.enterLoggedIn()
    await connected(store, transport)
    await until("sonda nowego logowania") { store.state.tailnet == "example.com" }
    // Dalsza sonda nie nadpisałaby śladu: porażka zostawia ostatnią znaną nazwę.
    transport.set { $0.version = .failure(.timedOut) }
    transport.release()
    try await Task.sleep(for: .milliseconds(80))
    #expect(store.state.auth == .loggedIn, "stary 401 nie wylogowuje nowego")
    #expect(store.state.tailnet == "example.com", "stara nazwa nie wraca")
  }

  @Test("pętla anulowana w trakcie odczytu nie nadpisuje snu pętli, która wstała po niej")
  func cancelledLoopKeepsNewNap() async throws {
    let transport = ProbeTransport()
    let fresh = try usageBody("usage.json")
    transport.set { $0.usage = [.success(fresh)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(3), retry: .seconds(3), floor: .zero), clock: clock)
    await store.start()
    await until("pierwszy odczyt") { store.state.planUsage.phase == .ready }
    // Wejście na wierzch czyta od razu; odczyt wisi, a scena znów gaśnie i wraca, zanim wróci odpowiedź.
    transport.set { $0.hold = true }
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    await until("odczyt w drodze") { transport.usageCalls == 2 }
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    // Trzecia pętla weszła w obrót (zdjęła `entering`) i czeka na ten sam odczyt: najwyżej jeden w drodze.
    await until("trzecia pętla czeka na odczyt") { !store.usagePolling.entering && clock.sleeping.isEmpty }
    #expect(transport.usageCalls == 2)
    transport.set { $0.hold = false }
    transport.release()
    await until("odczyt doszedł") { store.usagePolling.usageRead == nil }
    await until("żywa pętla śpi") { clock.sleeping.count == 1 }
    let nap = try #require(store.usagePolling.nap)
    #expect(!nap.isCancelled, "zapamiętany sen należy do żywej pętli — tylko taki da się przerwać")
  }

  @Test("401 z odczytu limitów wylogowuje jak 401 strumienia")
  func unauthorizedUsage() async throws {
    let transport = ProbeTransport()
    transport.set { $0.usage = [.failure(.unauthorized(APIFailure(status: 401)))] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero))
    await store.start()
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
  }

  /// A probe after `hello` that joins a loop probe sent before the link came back must keep the order for the
  /// control probe; without it the next probe comes only after the full interval (5 min in the app).
  @Test("hello w trakcie sondy z pętli: kontrolna sonda i tak po `retry`")
  func helloJoiningLoopProbeRechecks() async throws {
    let transport = ProbeTransport()
    transport.set {
      $0.usage = [.success(try! usageBody("usage.json"))]
      $0.version = .success(versionInfo())
    }
    let clock = VirtualClock()
    let store = makeVirtualStore(
      transport, timing: UsageTiming(refresh: .seconds(3), retry: .milliseconds(80), floor: .zero), clock: clock)
    await store.start()
    await connected(store, transport)
    await until("pętla śpi do kontrolnej sondy") { clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80) }
    // Kontrolna sonda z pętli wisi na sieci, a w tym czasie łącze wraca z nowym `hello`.
    transport.set { $0.hold = true }
    let before = transport.versionCalls
    clock.advance(by: .milliseconds(81))
    await until("sonda z pętli w drodze") { transport.versionCalls == before + 1 }
    transport.base.push(.global, json: hello)
    await until("hello dołączyło do sondy w drodze i zamówiło kontrolną") { store.usagePolling.versionRecheck }
    transport.set { $0.hold = false }
    transport.release()
    await until("pętla śpi do kontrolnej sondy po `hello`") {
      clock.sleeping.count == 1 && clock.sleeping[0] <= .milliseconds(80)
    }
    #expect(transport.versionCalls == before + 1, "hello nie wysłało drugiej sondy")
    await clock.stepPast(.milliseconds(80))
    #expect(transport.versionCalls == before + 2)
  }
}
