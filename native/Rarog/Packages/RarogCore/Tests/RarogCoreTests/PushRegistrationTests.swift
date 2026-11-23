import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Synchronization
import Testing

// Powiadomienia APNs w rdzeniu: token i rejestracja, zgoda, wylogowanie, baner „Włącz"
// z odłożeniem, push próbny, cel tapnięcia, plakietka i praca w tle wokół `visible: false`.

/// Wspólny dziennik kolejności atrap (praca w tle i obecność w transporcie).
final class EventLog: Sendable {
  private let entries = Mutex<[String]>([])

  func append(_ entry: String) { entries.withLock { $0.append(entry) } }
  var all: [String] { entries.withLock { $0 } }
}

@MainActor
final class FakePushSystem: PushSystem {
  /// Bundle id atrapy — celowo inny niż apki, żeby test widział, że temat rejestracji idzie z `PushSystem`.
  static let appTopic = "ai.example.app"

  var environment: ApnsEnvironment = .development
  var profile: PushProfile = .withEnvironment
  var topic: String? = FakePushSystem.appTopic
  /// Bieżąca zgoda (to, co zwraca `authorization()`).
  var status: PushAuthorization
  /// Odpowiedź człowieka na systemowe pytanie.
  var answer: PushAuthorization = .authorized
  var registerCalls = 0
  var unregisterCalls = 0
  var requests = 0
  var badges: [Int] = []

  init(status: PushAuthorization = .authorized) {
    self.status = status
  }

  func registerForRemoteNotifications() { registerCalls += 1 }
  func unregisterForRemoteNotifications() { unregisterCalls += 1 }
  func authorization() async -> PushAuthorization { status }

  func requestAuthorization() async -> PushAuthorization {
    requests += 1
    status = answer
    return answer
  }

  func setBadgeCount(_ count: Int) { badges.append(count) }
}

/// Zawór dla atrapy: żądanie wisi do `open()`.
actor AsyncGate {
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if opened { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    opened = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

@MainActor
final class FakeBackgroundWork: BackgroundWork {
  let log: EventLog
  private var next = 0
  /// Rozpoczęte prace w kolejności, z flagą `needsServer` (wejście maszyny tunelu).
  private(set) var begun: [(name: String, needsServer: Bool)] = []

  init(log: EventLog) {
    self.log = log
  }

  func begin(_ name: String, needsServer: Bool) -> BackgroundWorkToken? {
    next += 1
    begun.append((name, needsServer))
    log.append("begin \(name)")
    return BackgroundWorkToken(raw: next)
  }

  /// Flagi `needsServer` prac o tej nazwie, po kolei.
  func needsServer(_ name: String) -> [Bool] {
    begun.filter { $0.name == name }.map(\.needsServer)
  }

  func end(_ token: BackgroundWorkToken) {
    log.append("end \(token.raw)")
  }
}

@MainActor
@Suite("magazyn: powiadomienia APNs")
struct PushRegistrationTests {
  /// Token o wzorze 0a b0 (zero z przodu i z tyłu bajtu): hex niesie oba przypadki, a wartość jest jawnie syntetyczna.
  static let tokenData = Data([UInt8]([[UInt8]](repeating: [0x0a, 0xb0], count: 8).joined()))
  static let tokenHex = String(repeating: "0ab0", count: 8)
  static let otherData = Data(repeating: 0xab, count: 32)

  private func attach(
    _ store: RarogStore, _ system: FakePushSystem, log: EventLog = EventLog(),
    preferences: MemoryPreferences = MemoryPreferences()
  ) {
    store.pushTiming = PushTiming(testWait: .milliseconds(150), snooze: 7 * 24 * 3600)
    store.attachSystem(push: system, background: FakeBackgroundWork(log: log), preferences: preferences)
  }

  /// Żywy strumień globalny ze świeżą listą — dopiero wtedy rejestracja wychodzi.
  private func bringOnline(_ store: RarogStore, _ transport: FakeTransport, sessions: [String] = [Frames.summary("s1")]) async {
    await until("strumień globalny") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
    await until("świeża lista") { store.state.sessionsLoaded && store.state.compat == .ok }
  }

  private func registrations(_ transport: FakeTransport) -> [FakeTransport.ApnsRegistrationCall] {
    transport.read { $0.apnsRegistrations }
  }

  @Test("token sprzed logowania czeka i wychodzi po zalogowaniu, przy żywym strumieniu; potem status")
  func tokenBeforeLogin() async throws {
    let (store, transport) = makeStore(transport: FakeTransport(credential: false))
    let system = FakePushSystem(status: .authorized)
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    #expect(store.state.auth == .loggedOut(.notLoggedIn))
    // Brak klucza przy starcie to nie wylogowanie: token zostaje, system go nie traci.
    #expect(system.unregisterCalls == 0 && system.registerCalls == 0)
    try await Task.sleep(for: .milliseconds(30))
    #expect(registrations(transport).isEmpty)

    store.enterLoggedIn()
    #expect(system.registerCalls == 1)
    await until("zgoda odczytana") { store.state.push.authorization == .authorized }
    // Dłużej niż `compatWait`: żądanie wysłane za wcześnie bramka mutacji by odrzuciła i rejestracja by
    // przepadła do następnego cyklu.
    try await Task.sleep(for: .milliseconds(200))
    #expect(registrations(transport).isEmpty, "bez `hello` i świeżej listy nic nie wychodzi")
    await bringOnline(store, transport)
    await until("rejestracja") { registrations(transport).count == 1 }
    #expect(registrations(transport) == [
      .init(token: Self.tokenHex, environment: .development, topic: FakePushSystem.appTopic, alerts: true, test: false),
    ])
    await until("status tokenu") { transport.read { $0.apnsStatusCalls } == [Self.tokenHex] }
  }

  @Test("nowy token po zalogowaniu = upsert; ten sam token nie wysyła drugi raz")
  func tokenChange() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .authorized)
    system.environment = .production
    attach(store, system)
    await store.start()
    await bringOnline(store, transport)
    store.deviceTokenReceived(Self.tokenData)
    await until("pierwsza rejestracja") { registrations(transport).count == 1 }
    store.deviceTokenReceived(Self.tokenData)
    try await Task.sleep(for: .milliseconds(40))
    #expect(registrations(transport).count == 1)
    store.deviceTokenReceived(Self.otherData)
    await until("upsert nowego tokenu") { registrations(transport).count == 2 }
    #expect(registrations(transport)[1].token == String(repeating: "ab", count: 32))
    #expect(registrations(transport).allSatisfy { $0.environment == .production && !$0.test })
  }

  @Test("temat APNs z `PushSystem` w KAŻDEJ rejestracji (start, nowy token, próbny); bez bundle id — bez pola")
  func topicFromPushSystem() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .notDetermined)
    system.topic = "pl.example.inna"
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja startowa") { registrations(transport).count == 1 }
    store.deviceTokenReceived(Self.otherData)
    await until("upsert nowego tokenu") { registrations(transport).count == 2 }
    await store.enablePush()
    await until("rejestracja z próbnym") { registrations(transport).count == 3 }
    #expect(registrations(transport).map(\.topic) == Array(repeating: "pl.example.inna", count: 3))
    #expect(registrations(transport)[2].test)

    let (quiet, quietTransport) = makeStore()
    let unknown = FakePushSystem(status: .authorized)
    unknown.topic = nil
    attach(quiet, unknown)
    quiet.deviceTokenReceived(Self.tokenData)
    await quiet.start()
    await bringOnline(quiet, quietTransport)
    await until("rejestracja bez tematu") { registrations(quietTransport).count == 1 }
    #expect(registrations(quietTransport)[0].topic == nil)
  }

  @Test("odmowa zgody: rejestracja z `alerts: false`, bez wyrejestrowania (token zostaje dla Live Activity)")
  func deniedKeepsToken() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .denied)
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja") { registrations(transport).count == 1 }
    #expect(registrations(transport)[0].alerts == false)
    #expect(system.unregisterCalls == 0)
    #expect(!store.state.pushPromptVisible(now: Date()), "po odmowie baner „Włącz” nic nie naprawi")
  }

  @Test("„Włącz” → odmowa: dymek o Ustawieniach i rejestracja `alerts: false`, bez pusha próbnego")
  func enableDenied() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .notDetermined)
    system.answer = .denied
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja startowa") { registrations(transport).count == 1 }
    await store.enablePush()
    #expect(system.requests == 1)
    #expect(store.state.push.notice?.kind == .denied)
    await until("rejestracja po odmowie") { registrations(transport).count == 2 }
    #expect(registrations(transport)[1] == .init(
      token: Self.tokenHex, environment: .development, topic: FakePushSystem.appTopic, alerts: false, test: false))
    #expect(system.unregisterCalls == 0)
  }

  @Test("wylogowanie (401): token oddany systemowi, plakietka zdjęta, nic nie wychodzi do zalogowania")
  func logoutUnregisters() async throws {
    let transport = FakeTransport()
    transport.set { $0.openFailures = [.unauthorized(APIFailure(status: 401))] }
    let (store, _) = makeStore(transport: transport)
    let system = FakePushSystem(status: .authorized)
    attach(store, system)
    await store.start()
    #expect(system.registerCalls == 1)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(system.unregisterCalls == 1)
    #expect(system.badges.last == 0)
    store.deviceTokenReceived(Self.tokenData)
    try await Task.sleep(for: .milliseconds(40))
    #expect(registrations(transport).isEmpty)
    store.enterLoggedIn()
    #expect(system.registerCalls == 2, "po zalogowaniu token wraca od systemu")
    await bringOnline(store, transport)
    await until("rejestracja po zalogowaniu") { registrations(transport).count == 1 }
  }

  @Test("401 ze statusu tokenu wylogowuje tą samą drogą")
  func statusUnauthorized() async throws {
    let (store, transport) = makeStore()
    transport.set { $0.apnsStatusResult = .unauthorized(APIFailure(status: 401)) }
    let system = FakePushSystem(status: .authorized)
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await until("strumień globalny") { store.state.global == .online }
    // Bez `bringOnline`: rejestracja i status idą zaraz po liście, a 401 wylogowuje, zanim lista
    // zdąży być „świeża" dla czekającego testu.
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(transport.read { $0.apnsStatusCalls } == [Self.tokenHex])
    #expect(system.unregisterCalls == 1)
  }

  @Test("status tokenu: degradacja daje baner; bez kanału (`enabled: false`) baneru nie ma")
  func degradedStatus() async throws {
    let (store, transport) = makeStore()
    transport.set {
      $0.apnsStatus = #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":"2026-10-07T09:15:00.000Z"}"#
    }
    attach(store, FakePushSystem(status: .authorized))
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("baner degradacji") { store.state.banners.contains(.pushDegraded(since: "2026-10-07T09:15:00.000Z")) }

    let (quiet, quietTransport) = makeStore()
    quietTransport.set {
      $0.apnsStatus = #"{"enabled":false,"registered":false,"alerts":false,"degradedSince":"2026-10-07T09:15:00.000Z"}"#
    }
    attach(quiet, FakePushSystem(status: .authorized))
    quiet.deviceTokenReceived(Self.tokenData)
    await quiet.start()
    await bringOnline(quiet, quietTransport)
    await until("status") { quietTransport.read { $0.apnsStatusCalls.count } == 1 }
    try await Task.sleep(for: .milliseconds(20))
    #expect(!quiet.state.push.apnsStatusKnown && quiet.state.notificationsDegradedSince == nil)
  }

  @Test("status tokenu z przyczyną: baner niesie przyczynę; bez pola baner jak dotąd, bez przyczyny")
  func degradedStatusReason() async throws {
    let since = "2026-10-07T09:15:00.000Z"
    for (field, reason) in [
      (#","degradedReason":"pass-missing""#, ApnsDegradedReason.passMissing),
      (#","degradedReason":"env-mismatch""#, .envMismatch),
      ("", nil),
      (#","degradedReason":"relay-down""#, nil),
    ] as [(String, ApnsDegradedReason?)] {
      let (store, transport) = makeStore()
      transport.set {
        $0.apnsStatus = #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":"\#(since)"\#(field)}"#
      }
      attach(store, FakePushSystem(status: .authorized))
      store.deviceTokenReceived(Self.tokenData)
      await store.start()
      await bringOnline(store, transport)
      await until("baner degradacji \(field)") {
        store.state.banners.contains(.pushDegraded(since: since, reason: reason))
      }
      #expect(store.state.push.apnsDegradedReason == reason, "\(field)")
    }
  }

  @Test("przyczyna w stanie: tylko razem z `degradedSince` i kanałem; zdrowy token, `enabled: false` i wylogowanie ją zdejmują")
  func degradedReasonState() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var state = AppState(clientBuild: 1)
    state.apply(.push(.status(enabled: true, degradedSince: "t", reason: .envMismatch)), now: now)
    #expect(state.banners == [.pushDegraded(since: "t", reason: .envMismatch)])
    state.apply(.push(.status(enabled: true, degradedSince: nil, reason: .envMismatch)), now: now)
    #expect(state.push.apnsDegradedReason == nil && state.banners.isEmpty, "przyczyna bez chwili nic nie znaczy")
    state.apply(.push(.status(enabled: true, degradedSince: "t", reason: .passMissing)), now: now)
    state.apply(.push(.status(enabled: false, degradedSince: "t", reason: .passMissing)), now: now)
    #expect(state.push.apnsDegradedReason == nil && state.banners.isEmpty, "bez kanału status nic nie mówi")
    state.apply(.push(.status(enabled: true, degradedSince: "t", reason: .passMissing)), now: now)
    state.apply(.push(.status(enabled: true, degradedSince: "t")), now: now)
    #expect(state.banners == [.pushDegraded(since: "t")], "status bez przyczyny zdejmuje poprzednią")
    state.apply(.push(.status(enabled: true, degradedSince: "t", reason: .passMissing)), now: now)
    _ = state.apply(.loggedOut(.notLoggedIn), now: now)
    #expect(state.push.apnsDegradedReason == nil && state.push.apnsDegradedSince == nil)
  }

  @Test("ramka `push-degraded` starszego serwera (Web Push) nie zapala banera — ani przy zdrowym tokenie, ani bez kanału")
  func webPushFrameIgnored() async throws {
    let degraded = #"{"type":"push-degraded","since":"2026-10-07T08:00:00.000Z"}"#
    let marker = #"{"type":"session-changed","session":\#(Frames.summary("s2"))}"#
    for status in [
      #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":null}"#,
      #"{"enabled":false,"registered":false,"alerts":false,"degradedSince":null}"#,
    ] {
      let (store, transport) = makeStore()
      transport.set { $0.apnsStatus = status }
      attach(store, FakePushSystem(status: .authorized))
      store.deviceTokenReceived(Self.tokenData)
      await store.start()
      await bringOnline(store, transport)
      await until("status") { transport.read { $0.apnsStatusCalls.count } == 1 }
      transport.push(.global, json: degraded)
      // Ramka za nią: strumień idzie po kolei, więc po niej `push-degraded` jest już przetworzona.
      transport.push(.global, json: marker)
      await until("ramka za nią") { store.state.sessions["s2"] != nil }
      #expect(store.state.notificationsDegradedSince == nil, "\(status)")
      #expect(!store.state.banners.contains { if case .pushDegraded = $0 { true } else { false } }, "\(status)")
    }
  }

  @Test("rejestracja, która padła (sieć), wraca przy NASTĘPNYM połączeniu listy, nie przy każdej ramce")
  func transientFailureRetriesOnReconnect() async throws {
    let (store, transport) = makeStore()
    transport.set { $0.apnsRegisterResult = .offline(.notConnectedToInternet) }
    attach(store, FakePushSystem(status: .authorized))
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("pierwsza próba") { registrations(transport).count == 1 }
    transport.set { $0.apnsRegisterResult = nil }
    for state in ["running", "waiting-input", "running"] {
      transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: state))}"#)
    }
    try await Task.sleep(for: .milliseconds(40))
    #expect(registrations(transport).count == 1, "ramki tego samego połączenia nie ponawiają")
    let opened = transport.streamCalls.count
    transport.end(.global)
    await until("ponowne połączenie") { transport.streamCalls.count > opened && store.state.global == .online }
    try await Task.sleep(for: .milliseconds(20))
    #expect(registrations(transport).count == 1, "przed pełnym stanem nowego połączenia nic nie wychodzi")
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("ponowienie") { registrations(transport).count == 2 }
  }

  @Test("ciepły powrót z tła: cel z pusha i rejestracja czekają na pełny stan listy NOWEGO połączenia")
  func warmReturnWaitsForLiveList() async throws {
    let (store, transport) = makeStore()
    attach(store, FakePushSystem(status: .authorized))
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja startowa") { registrations(transport).count == 1 }
    store.setScenePhase(.background)
    let target = PushTarget(sessionId: "s-nowa")
    store.openPushTarget(target)
    #expect(store.state.readyPushTarget == nil, "lista sprzed tła nie zna sesji założonej w międzyczasie")
    let opened = transport.streamCalls.count
    store.setScenePhase(.active)
    await until("strumień po powrocie") { transport.streamCalls.count > opened && store.state.global == .online }
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.readyPushTarget == nil)
    #expect(registrations(transport).count == 1, "rejestracja po powrocie też czeka na listę")
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1")),\#(Frames.summary("s-nowa"))]}"#)
    await until("cel gotowy") { store.state.readyPushTarget == target }
    await until("rejestracja po powrocie") { registrations(transport).count == 2 }
  }

  @Test("ślad rejestracji w `client.log`: raz na parę (token, środowisko) w procesie, bez tokenu")
  func registrationTrace() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .authorized)
    system.environment = .production
    system.profile = .missing
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja startowa") { registrations(transport).count == 1 }
    let line = "push: rejestracja APNs — środowisko production, profil: brak"
    func traced() -> [String] {
      transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }.filter { $0.hasPrefix("push: rejestracja APNs") }
    }
    await until("ślad rejestracji") { traced() == [line] }

    // Powrót z tła z tą samą parą: rejestracja wychodzi znowu, ślad — nie.
    store.setScenePhase(.background)
    let opened = transport.streamCalls.count
    store.setScenePhase(.active)
    await until("strumień po powrocie") { transport.streamCalls.count > opened && store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("rejestracja po powrocie") { registrations(transport).count == 2 }
    try await Task.sleep(for: .milliseconds(40))
    #expect(traced() == [line])

    // Nowy token: druga linia.
    store.deviceTokenReceived(Self.otherData)
    await until("rejestracja nowego tokenu") { registrations(transport).count == 3 }
    await until("drugi ślad") { traced() == [line, line] }
    let all = transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }
    #expect(!all.contains { $0.contains(Self.tokenHex) || $0.contains(String(repeating: "ab", count: 32)) })
  }

  @Test("plakietka po powrocie z tła wychodzi znowu, także przy tej samej liczbie (push w tle ją przestawił)")
  func badgeAfterBackground() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .authorized)
    attach(store, system)
    await store.start()
    await bringOnline(store, transport)
    await until("plakietka 0") { system.badges.last == 0 }
    let before = system.badges.count
    store.setScenePhase(.background)
    store.setScenePhase(.active)
    await until("strumień po powrocie") { store.state.global == .online }
    #expect(system.badges.count == before, "lista sprzed tła nie ustawia plakietki")
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("plakietka 0 drugi raz") { system.badges.count == before + 1 }
    #expect(system.badges.last == 0)
  }

  @Test("status tokenu sprzed wylogowania nie wraca do nowego zalogowania")
  func staleStatusAfterRelogin() async throws {
    let gate = AsyncGate()
    let (store, transport) = makeStore()
    transport.set {
      $0.apnsStatus = #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":"2026-10-07T08:00:00.000Z","degradedReason":"pass-missing"}"#
      $0.onApnsStatus = { await gate.wait() }
    }
    attach(store, FakePushSystem(status: .authorized))
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("status w drodze") { transport.read { $0.apnsStatusCalls.count } == 1 }
    store.handleUnauthorized()
    store.enterLoggedIn()
    transport.set { $0.onApnsStatus = nil }
    await gate.open()
    try await Task.sleep(for: .milliseconds(40))
    #expect(!store.state.push.apnsStatusKnown && store.state.push.apnsDegradedSince == nil)
    #expect(store.state.push.apnsDegradedReason == nil)
  }

  @Test("baner „Włącz”: kanał na serwerze, zgoda nieznana; „×” odkłada na 7 dni i przeżywa restart apki")
  func snoozeSevenDays() async throws {
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let clock = Mutex(start)
    let prefs = MemoryPreferences()
    let rules = MutationRules(timing: fastTiming)
    let transport = FakeTransport()
    transport.gate = MutationGate(policy: rules)
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
      clock: { clock.withLock { $0 } })
    attach(store, FakePushSystem(status: .notDetermined), preferences: prefs)
    await store.start()
    await until("zgoda odczytana") { store.state.push.authorization == .notDetermined }
    #expect(!store.state.pushPromptVisible(now: start), "bez kanału APNs na serwerze baneru nie ma")
    let version = try JSONDecoder().decode(
      VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","apnsEnabled":true}"#.utf8))
    store.dispatch(.versionProbed(version))
    #expect(store.state.pushPromptVisible(now: start))

    store.snoozePushPrompt()
    let week: TimeInterval = 7 * 24 * 3600
    #expect(!store.state.pushPromptVisible(now: start))
    #expect(!store.state.pushPromptVisible(now: start.addingTimeInterval(week - 60)))
    #expect(store.state.pushPromptVisible(now: start.addingTimeInterval(week + 1)))

    let (again, _) = makeStore()
    attach(again, FakePushSystem(status: .notDetermined), preferences: prefs)
    #expect(again.state.push.snoozedUntil == start.addingTimeInterval(week))
  }

  @Test("„Włącz” → zgoda: rejestracja z pushem próbnym; dymek sukcesu dopiero po ODEBRANYM pushu próbnym")
  func successOnlyAfterTestPush() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .notDetermined)
    attach(store, system)
    store.simulateApnsChannelForUITests()
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await until("rejestracja startowa") { registrations(transport).count == 1 }
    #expect(registrations(transport)[0].alerts == false)
    #expect(store.state.pushPromptVisible(now: Date()))

    await store.enablePush()
    #expect(store.state.push.authorization == .authorized && !store.state.pushPromptVisible(now: Date()))
    await until("rejestracja z próbnym") { registrations(transport).count == 2 }
    #expect(registrations(transport)[1] == .init(
      token: Self.tokenHex, environment: .development, topic: FakePushSystem.appTopic, alerts: true, test: true))
    // 204 to nie dowód: serwer przyjął, urządzenie jeszcze nic nie dostało.
    try await Task.sleep(for: .milliseconds(40))
    #expect(store.state.push.notice == nil)
    store.pushReceived(PushNote(kind: .done, target: PushTarget(sessionId: "s1")))
    #expect(store.state.push.notice == nil)
    store.pushReceived(PushNote(kind: .test, target: nil))
    #expect(store.state.push.notice?.kind == .working)
    try await Task.sleep(for: .milliseconds(200))
    #expect(store.state.push.notice?.kind == .working, "zegar pusha próbnego zatrzymany")
  }

  @Test("push próbny nie dotarł w czasie: zdanie o tym, bez dymka sukcesu; porażka rejestracji: zdanie o porażce")
  func testMissingAndFailure() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .notDetermined)
    attach(store, system)
    store.deviceTokenReceived(Self.tokenData)
    await store.start()
    await bringOnline(store, transport)
    await store.enablePush()
    await until("brak pusha próbnego") { store.state.push.notice?.kind == .testMissing }

    let (failing, failingTransport) = makeStore()
    failingTransport.set { $0.apnsRegisterResult = .http(APIFailure(status: 500)) }
    let other = FakePushSystem(status: .notDetermined)
    attach(failing, other)
    failing.deviceTokenReceived(Self.tokenData)
    await failing.start()
    await bringOnline(failing, failingTransport)
    await failing.enablePush()
    await until("porażka") { failing.state.push.notice?.kind == .failed }
    try await Task.sleep(for: .milliseconds(200))
    #expect(failing.state.push.notice?.kind == .failed, "porażka nie zamienia się w „nie dotarł”")
  }

  @Test("cel tapnięcia czeka na zalogowanie i świeżą listę; przeżywa wylogowanie; zdjęty po wejściu")
  func targetWaitsForLoginAndFreshList() async throws {
    let (store, transport) = makeStore(transport: FakeTransport(credential: false))
    attach(store, FakePushSystem())
    let target = PushTarget(sessionId: "s1")
    store.openPushTarget(target)
    #expect(store.state.readyPushTarget == nil)
    await store.start()
    #expect(store.state.readyPushTarget == nil, "przed zalogowaniem")
    store.enterLoggedIn()
    #expect(store.state.readyPushTarget == nil, "zalogowany, ale lista jeszcze nie przyszła")
    await bringOnline(store, transport)
    #expect(store.state.readyPushTarget == target)
    store.consumePushTarget(PushTarget(sessionId: "inna"))
    #expect(store.state.readyPushTarget == target, "zdjęcie innego celu nie rusza bieżącego")
    store.consumePushTarget(target)
    #expect(store.state.readyPushTarget == nil)
  }

  @Test("link z kafla czeka na zalogowanie i świeżą listę jak cel tapnięcia; zdjęty po wejściu")
  func linkWaitsForLoginAndFreshList() async throws {
    let (store, transport) = makeStore(transport: FakeTransport(credential: false))
    attach(store, FakePushSystem())
    store.openLink(.jump(.waiting))
    #expect(store.state.readyLink == nil)
    await store.start()
    store.enterLoggedIn()
    #expect(store.state.readyLink == nil, "zalogowany, ale lista jeszcze nie przyszła")
    await bringOnline(store, transport)
    #expect(store.state.readyLink == .jump(.waiting))
    store.consumeLink(.list)
    #expect(store.state.readyLink == .jump(.waiting), "zdjęcie innego linku nie rusza bieżącego")
    store.consumeLink(.jump(.waiting))
    #expect(store.state.readyLink == nil)
    store.openLink(.session(PushTarget(sessionId: "s1")))
    #expect(store.state.readyPushTarget == PushTarget(sessionId: "s1") && store.state.readyLink == nil, "sesja drogą powiadomienia")
    // Ostatnie tapnięcie wygrywa w obie strony: dwa czekające cele nawigowałyby oba.
    store.openLink(.list)
    #expect(store.state.readyLink == .list && store.state.readyPushTarget == nil)
    store.openPushTarget(PushTarget(sessionId: "s1"))
    #expect(store.state.readyPushTarget == PushTarget(sessionId: "s1") && store.state.readyLink == nil)
  }

  @Test("plakietka na wierzchu = sesje na decyzji ze świeżej listy, bez powtórzeń; zgoda daje drugą szansę")
  func badge() async throws {
    let (store, transport) = makeStore()
    let system = FakePushSystem(status: .authorized)
    attach(store, system)
    await store.start()
    await bringOnline(store, transport, sessions: [
      Frames.summary("s1", state: "waiting-permission"), Frames.summary("s2", state: "waiting-question"),
      Frames.summary("s3", state: "waiting-input"), Frames.summary("s4"),
    ])
    #expect(system.badges.last == 2)
    let count = system.badges.count
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s4", state: "running"))}"#)
    try await Task.sleep(for: .milliseconds(30))
    #expect(system.badges.count == count, "ta sama liczba nie idzie drugi raz")
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "running"))}"#)
    await until("plakietka 1") { system.badges.last == 1 }
  }

  @Test("zejście w tło: praca w tle PRZED `visible: false`, koniec po odpowiedzi")
  func backgroundWorkAroundPresence() async throws {
    let log = EventLog()
    let transport = FakeTransport()
    transport.set { $0.onPresence = { body in log.append(body.visible ? "obecność widoczna" : "obecność w tle") } }
    let (store, _) = makeStore(transport: transport)
    let work = FakeBackgroundWork(log: log)
    store.pushTiming = PushTiming(testWait: .milliseconds(150), snooze: 7 * 24 * 3600)
    store.attachSystem(push: FakePushSystem(), background: work, preferences: MemoryPreferences())
    await store.start()
    await bringOnline(store, transport)
    store.setScenePhase(.background)
    await until("koniec pracy w tle") { log.all.contains { $0.hasPrefix("end") } }
    let tail = Array(log.all.drop { $0 != "begin rarog.presence" })
    #expect(tail == ["begin rarog.presence", "obecność w tle", "end 1"])
    #expect(work.needsServer("rarog.presence") == [true], "obecność idzie do serwera: praca z needsServer")
    // Na wierzchu obecność idzie bez pracy w tle.
    #expect(!log.all.prefix { $0 != "begin rarog.presence" }.contains { $0.hasPrefix("begin") })
  }
}

@Suite("powiadomienia: odczyt `userInfo`, adresu `rarog://` i profilu podpisu")
struct PushRoutingTests {
  @Test("`userInfo` z blokiem `rarog`: rodzaj i cel; próbny bez celu; cudzy, zepsuty i nowa wersja = nic")
  func userInfo() {
    let session: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "t", "body": "b"], "badge": 1],
      "rarog": ["v": 1, "sessionId": "s-1", "termId": "0123456789abcdef", "kind": "permission"],
    ]
    #expect(PushRouting.note(userInfo: session, keys: MemoryKeychain())
      == PushNote(kind: .permission, target: PushTarget(sessionId: "s-1", termId: "0123456789abcdef")))
    #expect(
      PushRouting.note(userInfo: ["rarog": ["v": 3, "sessionId": "s-1", "kind": "done"]], keys: MemoryKeychain()) == nil,
      "v3 bez koperty apka odrzuca, nie czyta jak v1")
    for version in [2, 4] {
      #expect(
        PushRouting.note(userInfo: ["rarog": ["v": version, "sessionId": "s-1", "kind": "done"]], keys: MemoryKeychain())
          == nil, "wersji spoza znanych (v: \(version)) apka nie interpretuje")
    }
    let test: [AnyHashable: Any] = ["aps": ["alert": "x"], "rarog": ["v": 1, "kind": "test"]]
    #expect(PushRouting.note(userInfo: test, keys: MemoryKeychain()) == PushNote(kind: .test, target: nil))
    #expect(PushRouting.note(userInfo: ["aps": ["alert": "cudzy"]], keys: MemoryKeychain()) == nil)
    #expect(PushRouting.note(userInfo: ["rarog": ["v": 1, "sessionId": "", "kind": "done"]], keys: MemoryKeychain())
      == nil)
  }

  @Test("`rarog://session/<id>`: cel z odkodowanym id; inne adresy nic nie znaczą; adres z celu wraca do celu")
  func url() throws {
    #expect(PushRouting.target(url: try #require(URL(string: "rarog://session/s-1"))) == PushTarget(sessionId: "s-1"))
    #expect(PushRouting.target(url: try #require(URL(string: "rarog://session/a%20b"))) == PushTarget(sessionId: "a b"))
    for raw in ["rarog://", "rarog://session", "rarog://session/", "rarog://terminal/abc", "https://session/s-1",
                "rarog://session/a/b"] {
      #expect(PushRouting.target(url: try #require(URL(string: raw))) == nil, "\(raw)")
    }
    let round = try #require(PushRouting.url(sessionId: "herdr-w1 p2"))
    #expect(PushRouting.target(url: round) == PushTarget(sessionId: "herdr-w1 p2"))
  }

  @Test("token urządzenia → hex małymi literami, bajt po bajcie")
  func hex() {
    #expect(PushRouting.hex(Data([0x00, 0x0f, 0xab, 0xff])) == "000fabff")
  }

  @Test("profil podpisu: `aps-environment` z plisty w CMS; brak wpisu i śmieci = nil")
  func provisioning() {
    func profile(_ entitlements: String) -> Data {
      var data = Data([0x30, 0x82, 0x2f, 0x1a, 0x06, 0x09])
      data.append(Data(#"""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>AppIDName</key><string>Rarog</string>
        <key>Entitlements</key><dict>\#(entitlements)</dict></dict></plist>
        """#.utf8))
      data.append(Data([0xa0, 0x82, 0x0d, 0x00]))
      return data
    }
    #expect(ProvisioningProfile.apsEnvironment(
      profile: profile("<key>aps-environment</key><string>development</string>")) == .development)
    #expect(ProvisioningProfile.apsEnvironment(
      profile: profile("<key>aps-environment</key><string>production</string>")) == .production)
    #expect(ProvisioningProfile.apsEnvironment(profile: profile("<key>get-task-allow</key><true/>")) == nil)
    #expect(ProvisioningProfile.apsEnvironment(profile: Data("bez plisty".utf8)) == nil)
  }

  @Test("środowisko push: profil z wartością, profil bez niej, brak profilu na urządzeniu i na symulatorze")
  func pushEnvironment() {
    func profile(_ entitlements: String) -> Data {
      Data(#"""
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>Entitlements</key><dict>\#(entitlements)</dict></dict></plist>
        """#.utf8)
    }
    let withProduction = profile("<key>aps-environment</key><string>production</string>")
    let withDevelopment = profile("<key>aps-environment</key><string>development</string>")
    let without = profile("<key>get-task-allow</key><true/>")
    // Profil z `aps-environment` → ta wartość, na urządzeniu i na symulatorze.
    for isSimulator in [false, true] {
      #expect(ProvisioningProfile.pushEnvironment(profile: withProduction, isSimulator: isSimulator)
        == PushEnvironmentReading(environment: .production, profile: .withEnvironment))
      #expect(ProvisioningProfile.pushEnvironment(profile: withDevelopment, isSimulator: isSimulator)
        == PushEnvironmentReading(environment: .development, profile: .withEnvironment))
    }
    // Profil bez wartości (także nieczytelny) → `development`.
    #expect(ProvisioningProfile.pushEnvironment(profile: without, isSimulator: false)
      == PushEnvironmentReading(environment: .development, profile: .withoutEnvironment))
    #expect(ProvisioningProfile.pushEnvironment(profile: Data(), isSimulator: false)
      == PushEnvironmentReading(environment: .development, profile: .withoutEnvironment))
    // Brak profilu: urządzenie = TestFlight albo App Store → `production`; symulator → `development`.
    #expect(ProvisioningProfile.pushEnvironment(profile: nil, isSimulator: false)
      == PushEnvironmentReading(environment: .production, profile: .missing))
    #expect(ProvisioningProfile.pushEnvironment(profile: nil, isSimulator: true)
      == PushEnvironmentReading(environment: .development, profile: .missing))
  }
}
