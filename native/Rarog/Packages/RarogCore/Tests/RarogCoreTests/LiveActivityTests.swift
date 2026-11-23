import Foundation
import RarogActivity
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Testing

// Zbiorcza Live Activity w rdzeniu: cykl życia z atrapą systemu — start tylko na wierzchu i przy
// pracy, jedna aktywność, token i rotacja → rejestracja, zapis liczników z apki (nakładka na treść systemu,
// znacznik z zegara serwera, jeden pisarz), koniec po 30 min ciszy, przy wylogowaniu i bez kanału. Stan startowy
// kafla z listy, warunek „zajęty", prywatność i adres tapnięcia: `LiveActivityInputTests.swift`.

/// Atrapa ActivityKit: aktywności pokazane „żyją" w liście `running`, wejścia systemu wysyła test (`emit`, `push`).
/// Porządek jak w ActivityKit (`timestamp` zapisu, `aps.timestamp` pusha): treść ze znacznikiem starszym niż
/// ostatnia przyjęta przepada, zapis do zakończonej aktywności też. Push niesie znacznik równy `updatedEpoch`
/// (tak wysyła serwer: `outgoing` w `server/src/notify/live-activity.ts`).
@MainActor
final class FakeActivities: ActivityRequesting {
  struct Refusal: Error {}
  /// Zapis z apki, jak go zlecił rdzeń (także odrzucony).
  struct Update: Equatable {
    let id: String
    let content: LiveActivityContent
    let timestamp: Date
  }

  var enabled = true
  /// Zgoda na częste aktualizacje (`frequentPushesEnabled`).
  var frequent = true
  /// Treść, którą „system” trzyma dla aktywności o danym id; brak wpisu = `nil`.
  var displayed: [String: LiveActivityContent] = [:]
  /// Aktywności, które „system” pokazuje: żywe i zakończone, a widoczne (także z „poprzedniego procesu").
  var running: [String] = []
  var requests: [LiveActivityContent] = []
  /// System serwera w atrybutach każdego startu (słowo maszyny na kaflu), w kolejności `requests`.
  var requestSystems: [ServerSystem?] = []
  var ended: [String] = []
  /// Zapisy z apki w kolejności wywołań.
  var updates: [Update] = []
  /// Zapis czeka na otwarcie zaworu, zanim „system” go obsłuży (system zapisuje asynchronicznie).
  var updateGate: AsyncGate?
  /// Najwięcej zapisów w toku naraz.
  private(set) var maxUpdatesInFlight = 0
  /// Następny `request` rzuca (limit aktywności, wyłączone w Ustawieniach).
  var refuse = false
  /// Koniec aktywności czeka na otwarcie zaworu (system kończy asynchronicznie).
  var endGate: AsyncGate?
  /// System zwleka: po `end` aktywność nadal jest na liście pokazanych (`running`).
  var endKeepsShown = false
  private var sink: (@MainActor (ActivitySystemEvent) -> Void)?
  private var next = 0
  private var updatesInFlight = 0
  /// Znacznik ostatniej przyjętej treści (push albo zapis) per aktywność.
  private var lastTimestamp: [String: Date] = [:]

  var activitiesEnabled: Bool { enabled }

  var frequentPushesEnabled: Bool { frequent }

  func displayedContent(_ id: String) -> LiveActivityContent? { displayed[id] }

  func shownActivityIds() -> [String] { running }

  func request(_ content: LiveActivityContent, serverSystem: ServerSystem?) throws -> String {
    if refuse { throw Refusal() }
    next += 1
    let id = "la-\(next)"
    running.append(id)
    requests.append(content)
    requestSystems.append(serverSystem)
    displayed[id] = content
    return id
  }

  func update(_ id: String, state: LiveActivityContentState, staleDate: Date?, timestamp: Date) async {
    let content = LiveActivityContent(state: state, staleDate: staleDate)
    updates.append(Update(id: id, content: content, timestamp: timestamp))
    updatesInFlight += 1
    maxUpdatesInFlight = max(maxUpdatesInFlight, updatesInFlight)
    await updateGate?.wait()
    updatesInFlight -= 1
    accept(id, content, timestamp: timestamp)
  }

  func end(_ id: String) async {
    ended.append(id)
    await endGate?.wait()
    guard !endKeepsShown else { return }
    running.removeAll { $0 == id }
    displayed[id] = nil
  }

  func observe(_ sink: @escaping @MainActor (ActivitySystemEvent) -> Void) { self.sink = sink }

  func emit(_ event: ActivitySystemEvent) { sink?(event) }

  /// Push serwera ze znacznikiem `updatedEpoch`; przyjęty idzie do rdzenia wejściem `content` (`contentUpdates`).
  func push(_ id: String, _ state: LiveActivityContentState, staleDate: Date? = nil) {
    let at = Date(timeIntervalSince1970: TimeInterval(state.updatedEpoch))
    let content = LiveActivityContent(state: state, staleDate: staleDate)
    guard accept(id, content, timestamp: at) else { return }
    emit(.content(activityId: id, content))
  }

  /// System wbrew dokumentacji pokazuje tę treść bez względu na znacznik (zapis cofnięty) i zgłasza ją wejściem.
  func show(_ id: String, _ state: LiveActivityContentState) {
    let content = LiveActivityContent(state: state, staleDate: displayed[id]?.staleDate)
    displayed[id] = content
    emit(.content(activityId: id, content))
  }

  /// Porządek ActivityKit: zakończona aktywność i treść starsza niż ostatnia przyjęta przepadają.
  @discardableResult
  private func accept(_ id: String, _ content: LiveActivityContent, timestamp: Date) -> Bool {
    guard running.contains(id) else { return false }
    if let last = lastTimestamp[id], timestamp < last { return false }
    lastTimestamp[id] = timestamp
    displayed[id] = content
    return true
  }
}

/// Zadanie workflow w tle (`backgroundTasks[]`) w JSON-ie podsumowania sesji. `agents` = flagi `done`
/// kolejnych agentów; `run: false` = rozkład jeszcze nieodczytany (pola `run` nie ma).
func workflowTask(
  _ id: String, name: String = "audyt-docs", runId: String? = nil, startedAt: String? = nil,
  phases: [String] = [], agents: [Bool] = [], run: Bool = true, kind: String = "workflow"
) -> String {
  var fields = [#""id":"\#(id)""#, #""kind":"\#(kind)""#, #""description":"\#(name)""#]
  if let runId { fields.append(#""runId":"\#(runId)""#) }
  if let startedAt { fields.append(#""startedAt":"\#(startedAt)""#) }
  if run {
    let phaseList = phases.map { #""\#($0)""# }.joined(separator: ",")
    let agentList = agents.enumerated().map { index, done in
      let phase = phases.isEmpty ? "" : #","phase":"\#(phases[min(index / 2, phases.count - 1)])""#
      return #"{"id":"\#(id)-a\#(index)"\#(phase),"done":\#(done)}"#
    }.joined(separator: ",")
    fields.append(#""run":{"phases":[\#(phaseList)],"agents":[\#(agentList)]}"#)
  }
  return "{" + fields.joined(separator: ",") + "}"
}

/// Subagent w tle (`backgroundTasks[]`) w JSON-ie podsumowania sesji. `waitingSince` = stoi i czeka na
/// własne zadanie; `ownTask` = treść jednej jego otwartej komendy.
func agentTask(_ id: String, waitingSince: String? = nil, ownTask: String? = nil) -> String {
  var fields = [#""id":"\#(id)""#, #""kind":"agent""#, #""description":"wspólne widoki sekcji panelu""#]
  if let waitingSince { fields.append(#""waitingSince":"\#(waitingSince)""#) }
  if let ownTask { fields.append(#""ownTasks":[{"id":"\#(id)-c","command":"\#(ownTask)"}]"#) }
  return "{" + fields.joined(separator: ",") + "}"
}

/// `,"backgroundTasks":[…]` do `Frames.summary(extra:)`.
func backgroundTasks(_ tasks: String...) -> String {
  #","backgroundTasks":[\#(tasks.joined(separator: ","))]"#
}

// MARK: - Cykl życia (atrapa systemu)

@MainActor
@Suite("Live Activity: cykl życia w rdzeniu (v2)")
struct LiveActivityLifecycleTests {
  static let deviceData = Data((0..<16).map { UInt8($0 * 17) })
  static let deviceHex = "00112233445566778899aabbccddeeff"
  static let tokenA = Data(repeating: 0xa1, count: 32)
  static let tokenB = Data(repeating: 0xb2, count: 32)

  struct Rig {
    let store: RarogStore
    let transport: FakeTransport
    let activities: FakeActivities
    let clock: VirtualClock
    let log: EventLog
    let work: FakeBackgroundWork
  }

  /// Magazyn z atrapami systemu; zegar magazynu i sen zegara ciszy idą za zegarem wirtualnym.
  private func rig(
    credential: Bool = true, channel: Bool = true, running: [String] = [], quietEnd: Duration = .seconds(1800)
  ) -> Rig {
    let clock = VirtualClock()
    let log = EventLog()
    let transport = FakeTransport(credential: credential)
    let rules = MutationRules(timing: fastTiming)
    transport.gate = MutationGate(policy: rules)
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
      clock: { clock.now })
    let work = FakeBackgroundWork(log: log)
    store.attachSystem(push: FakePushSystem(status: .authorized), background: work, preferences: MemoryPreferences())
    let activities = FakeActivities()
    activities.running = running
    store.liveActivityTiming = LiveActivityTiming(quietEnd: quietEnd, sleep: { await clock.sleep($0) })
    store.attachActivities(activities)
    if channel { store.simulateApnsChannelForUITests() }
    return Rig(store: store, transport: transport, activities: activities, clock: clock, log: log, work: work)
  }

  /// Zalogowany start, token urządzenia, żywy strumień i pełna lista.
  private func online(_ rig: Rig, _ sessions: [String]) async {
    rig.store.deviceTokenReceived(Self.deviceData)
    await rig.store.start()
    await until("strumień globalny") { rig.store.state.global == .online }
    rig.transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
    await until("świeża lista") { rig.store.state.listLive && rig.store.state.compat == .ok }
  }

  private func change(_ rig: Rig, _ summary: String) {
    rig.transport.push(.global, json: #"{"type":"session-changed","session":\#(summary)}"#)
  }

  private func registrations(_ rig: Rig) -> [LiveActivityRegisterBody] {
    rig.transport.read { $0.liveRegistrations }
  }

  /// Krótka chwila na skutki asynchroniczne, które NIE powinny nastąpić.
  private func settle() async {
    try? await Task.sleep(for: .milliseconds(40))
  }

  /// Czas listy w dniu `Frames.summary` o godzinie `hhmmss` w UTC, z milisekundami.
  static func t(_ hhmmss: String) -> String { "2026-10-03T\(hhmmss)Z" }

  static func at(_ iso: String) -> Date { ISOTime.parse(iso) ?? .distantPast }

  /// Treść pusha serwera z chwili `iso`: liczniki i pola, których apka nie zna (`top`, przebieg, limity, Mac).
  static func served(
    _ waiting: Int, _ working: Int, _ finished: Int, at iso: String, limit: Int = 42
  ) -> LiveActivityContentState {
    LiveActivityContentState(
      waiting: waiting, working: working, finished: finished, top: .init(sessionId: "serwer"),
      workflows: [.init(sessionId: "s1", project: "rarog", name: "audyt-docs", agents: 2, done: 1, segments: [50])],
      limits: .init(fiveHour: limit, weekly: 81), mac: .init(cpu: 35, ram: 60, disk: 80),
      updatedEpoch: Int(at(iso).timeIntervalSince1970))
  }

  /// Treść „w systemie” o danym `updatedEpoch` (detektor wieku kafla).
  static func shown(epoch: Int) -> LiveActivityContent {
    LiveActivityContent(
      state: LiveActivityContentState(waiting: 0, working: 1, finished: 0, updatedEpoch: epoch), staleDate: nil)
  }

  static func counts(_ state: LiveActivityContentState) -> [Int] { [state.waiting, state.working, state.finished] }

  static let hello = #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#

  @Test("start tylko przy pracy albo decyzji; jedna aktywność — osierocona kończy się przed startem")
  func startOnlyWhenBusy() async throws {
    let rig = rig(running: ["stara"])
    await online(rig, [Frames.summary("s1", state: "waiting-input")])
    await settle()
    #expect(rig.activities.requests.isEmpty, "cisza przy otwarciu apki nie stawia pustego kafla")
    change(rig, Frames.summary("s1", state: "running"))
    await until("start") { rig.activities.requests.count == 1 }
    #expect(rig.activities.ended == ["stara"] && rig.activities.running == ["la-1"])
    #expect(rig.activities.requests[0].state.working == 1 && rig.store.liveActivityId == "la-1")
    change(rig, Frames.summary("s2", state: "waiting-question"))
    await settle()
    #expect(rig.activities.requests.count == 1, "druga zmiana nie stawia drugiej aktywności")
  }

  @Test("stan startowy: liczniki i cel tapnięcia, bez przebiegów, limitów i Maca; data nieświeżości 15 min")
  func startContent() async throws {
    let rig = rig()
    await online(rig, [
      Frames.summary("s1", state: "running", stateSince: "2026-10-03T07:00:00.000Z",
                     extra: backgroundTasks(workflowTask("w", agents: [true, false]))),
      Frames.summary("s2", state: "waiting-input"),
    ])
    await until("start") { rig.activities.requests.count == 1 }
    let content = rig.activities.requests[0]
    #expect(content.state.waiting == 0 && content.state.working == 1 && content.state.finished == 1)
    #expect(content.state.top == .init(sessionId: "s1"))
    #expect(content.state.workflows == nil && content.state.limits == nil && content.state.mac == nil)
    #expect(content.staleDate == rig.clock.now.addingTimeInterval(900))
  }

  @Test("po starcie zmiany listy nie stawiają drugiego kafla i go nie kończą; liczniki idą zapisem z apki")
  func changesAfterStart() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.clock.advance(by: .seconds(5))
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: "2026-10-03T08:02:00.000Z"))
    change(rig, Frames.summary("s2", state: "running"))
    change(rig, Frames.summary("s3", state: "waiting-input"))
    await settle()
    // Zmiana liczników to zapis z apki (`update`, testy pisarza niżej), nigdy drugi start ani koniec.
    #expect(rig.activities.requests.count == 1 && rig.activities.ended.isEmpty)
    #expect(rig.clock.sleeping.isEmpty, "przy pracy zegar ciszy stoi")
    await until("zapis najnowszych liczników") {
      rig.activities.updates.last.map { Self.counts($0.content.state) } == [1, 1, 1]
    }
  }

  @Test("w tle bez startu; powrót na wierzch i lista NOWEGO połączenia — start")
  func startOnlyInForeground() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "waiting-input")])
    rig.store.setScenePhase(.background)
    rig.store.setScenePhase(.inactive)
    await settle()
    #expect(rig.activities.requests.isEmpty)
    let opened = rig.transport.streamCalls.count
    rig.store.setScenePhase(.active)
    await until("nowe połączenie") { rig.transport.streamCalls.count > opened && rig.store.state.global == .online }
    rig.transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "running"))]}"#)
    await until("start po powrocie") { rig.activities.requests.count == 1 }
  }

  @Test("bez kanału APNs bez startu; kanał znika (`apnsEnabled: false`) — koniec bez trasy `…/end`")
  func channel() async throws {
    let rig = rig(channel: false)
    await online(rig, [Frames.summary("s1", state: "running")])
    await settle()
    #expect(rig.activities.requests.isEmpty, "serwer bez kanału nie zaktualizuje kafla")
    let on = try JSONDecoder().decode(VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","apnsEnabled":true}"#.utf8))
    rig.store.dispatch(.versionProbed(on))
    await until("start z kanałem") { rig.activities.requests.count == 1 }
    let off = try JSONDecoder().decode(VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","apnsEnabled":false}"#.utf8))
    rig.store.dispatch(.versionProbed(off))
    #expect(rig.store.liveActivityId == nil)
    await until("koniec bez kanału") { rig.activities.ended == ["la-1"] }
    change(rig, Frames.summary("s1", state: "waiting-question"))
    await settle()
    #expect(rig.activities.requests.count == 1 && rig.transport.read { $0.liveEnds }.isEmpty)
  }

  @Test("odmowa systemu albo wyłączone aktywności: jedna próba na pobyt na wierzchu")
  func refusal() async throws {
    let rig = rig()
    rig.activities.enabled = false
    await online(rig, [Frames.summary("s1", state: "running")])
    change(rig, Frames.summary("s2", state: "running"))
    await settle()
    #expect(rig.activities.requests.isEmpty)
    rig.activities.enabled = true
    rig.activities.refuse = true
    change(rig, Frames.summary("s3", state: "running"))
    await settle()
    #expect(rig.activities.requests.isEmpty, "po odmowie nie pytamy przy każdej ramce")
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    change(rig, Frames.summary("s4", state: "running"))
    await settle()
    #expect(rig.activities.requests.isEmpty, "system odmówił")
    rig.activities.refuse = false
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    await until("start po powrocie na wierzch") { rig.activities.requests.count == 1 }
  }

  /// Linie `client.log`, które poszły na serwer.
  private func traces(_ rig: Rig) -> [String] {
    rig.transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }
  }

  @Test("linia startu mówi, czy częste aktualizacje są włączone")
  func startTraceFrequentUpdates() async throws {
    for (frequent, word) in [(true, "tak"), (false, "nie")] {
      let rig = rig()
      rig.activities.frequent = frequent
      await online(rig, [Frames.summary("s1", state: "running")])
      let line = "live-activity: start (czeka 0, pracuje 1, skończyło 0, częste aktualizacje: \(word))"
      await until("linia startu (\(word))") { traces(rig).contains(line) }
    }
  }

  /// Dopisek linii „na wierzchu” bez zapisów z apki.
  static let noWrites = ", zapisy z apki od poprzedniej: 0 (przyjęte 0, odrzucone 0, cofnięte 0)"

  @Test("powrót na wierzch z żywym kaflem: wiek treści albo „nieznana”, najwyżej raz na 15 min; `active → active` nic")
  func foregroundTraceDisplayedAge() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.store.setScenePhase(.active)
    rig.activities.displayed["la-1"] = Self.shown(epoch: Int(rig.clock.now.timeIntervalSince1970) - 125)
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    await until("wiek treści") {
      traces(rig).contains(
        "live-activity: na wierzchu — treść kafla sprzed 125 s, częste aktualizacje: tak" + Self.noWrites)
    }
    // Drugi powrót przed upływem 15 min: bez linii (wspólny budżet śladów).
    rig.clock.advance(by: .seconds(15 * 60 - 1))
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    await settle()
    #expect(traces(rig).filter { $0.hasPrefix("live-activity: na wierzchu") }.count == 1)
    rig.clock.advance(by: .seconds(1))
    // Zegar urządzenia za zegarem Maca: wiek ujemny zostaje, jaki wyszedł (rozjazd zegarów widać w logu).
    rig.activities.displayed["la-1"] = Self.shown(epoch: Int(rig.clock.now.timeIntervalSince1970) + 3)
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    await until("wiek ujemny") {
      traces(rig).contains(
        "live-activity: na wierzchu — treść kafla sprzed -3 s, częste aktualizacje: tak" + Self.noWrites)
    }
    rig.clock.advance(by: .seconds(15 * 60))
    rig.activities.displayed["la-1"] = nil
    rig.activities.frequent = false
    rig.store.setScenePhase(.background)
    rig.store.setScenePhase(.active)
    await until("treść nieznana") {
      traces(rig).contains("live-activity: na wierzchu — treść kafla nieznana, częste aktualizacje: nie" + Self.noWrites)
    }
    #expect(traces(rig).filter { $0.hasPrefix("live-activity: na wierzchu") }.count == 3)
    // Bez tokenów i id aktywności.
    #expect(!traces(rig).contains { $0.contains("la-1") })
  }

  @Test("powrót na wierzch bez żywej aktywności tego procesu (także z osieroconą w systemie) — bez linii")
  func foregroundTraceWithoutActivity() async throws {
    let rig = rig(running: ["stara"])
    rig.activities.displayed["stara"] = Self.shown(epoch: Int(rig.clock.now.timeIntervalSince1970) - 60)
    await online(rig, [Frames.summary("s1", state: "waiting-input")])
    rig.store.setScenePhase(.background)
    rig.store.setScenePhase(.active)
    await settle()
    #expect(rig.store.liveActivityId == nil)
    #expect(!traces(rig).contains { $0.hasPrefix("live-activity: na wierzchu") })
  }

  @Test("token aktywności → rejestracja z przyjętym tokenem urządzenia; rotacja → druga; ten sam — nic")
  func tokenRegistration() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    await until("urządzenie przyjęte") { rig.store.pushRuntime.registeredToken == Self.deviceHex }
    rig.activities.emit(.token(activityId: "la-1", Self.tokenA))
    await until("rejestracja") { registrations(rig).count == 1 }
    #expect(registrations(rig).first == LiveActivityRegisterBody(
      deviceToken: Self.deviceHex, activityId: "la-1", updateToken: String(repeating: "a1", count: 32)))
    rig.activities.emit(.token(activityId: "la-1", Self.tokenA))
    rig.activities.emit(.token(activityId: "obca", Self.tokenB))
    await settle()
    #expect(registrations(rig).count == 1, "ten sam token i token cudzej aktywności nic nie wysyłają")
    rig.activities.emit(.token(activityId: "la-1", Self.tokenB))
    await until("rotacja") { registrations(rig).count == 2 }
    #expect(registrations(rig).dropFirst().first?.updateToken == String(repeating: "b2", count: 32))
  }

  @Test("token i rotacja W TLE idą na serwer w pracy w tle (bez żywej listy i bez wierzchu)")
  func tokenInBackground() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    await until("urządzenie przyjęte") { rig.store.pushRuntime.registeredToken == Self.deviceHex }
    rig.store.setScenePhase(.background)
    #expect(!rig.store.state.listLive, "w tle strumień listy stoi")
    rig.activities.emit(.token(activityId: "la-1", Self.tokenA))
    await until("rejestracja w tle") { registrations(rig).count == 1 }
    rig.activities.emit(.token(activityId: "la-1", Self.tokenB))
    await until("rotacja w tle") { registrations(rig).count == 2 }
    await until("praca w tle zamknięta") { rig.log.all.filter { $0 == "end 2" || $0 == "end 3" }.count == 2 }
    #expect(rig.log.all.filter { $0 == "begin rarog.live-activity" }.count == 2)
    #expect(rig.work.needsServer("rarog.live-activity") == [true, true], "rejestracja idzie do serwera")
  }

  @Test("dwa 409 z rzędu: jedna ponowna rejestracja urządzenia na połączenie, potem czekanie na następne")
  func repeatedDeviceUnknown() async throws {
    let rig = rig()
    let unknown = TransportError.http(APIFailure(status: 409, code: "apns-device-unknown"))
    rig.transport.set { $0.liveRegisterResults = [unknown, unknown] }
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    await until("urządzenie przyjęte") { rig.transport.read { $0.apnsRegistrations.count } == 1 }
    rig.activities.emit(.token(activityId: "la-1", Self.tokenA))
    await until("dwie próby tokenu") { registrations(rig).count == 2 }
    await settle()
    #expect(registrations(rig).count == 2, "bez pętli 409 ↔ rejestracja urządzenia")
    #expect(rig.transport.read { $0.apnsRegistrations.count } == 2, "urządzenie od nowa tylko raz")
    let opened = rig.transport.streamCalls.count
    rig.transport.end(.global)
    await until("nowe połączenie") { rig.transport.streamCalls.count > opened && rig.store.state.global == .online }
    rig.transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "running"))]}"#)
    await until("token po nowym połączeniu") { registrations(rig).count == 3 }
    await until("przyjęty") { registrations(rig).dropFirst(2).first.map { $0 == rig.store.liveRuntime.registered } == true }
  }

  @Test("token przed przyjęciem urządzenia czeka; 409 `apns-device-unknown` → urządzenie od nowa, potem token")
  func deviceFirst() async throws {
    let rig = rig()
    rig.transport.set { $0.apnsRegisterResult = .offline(.notConnectedToInternet) }
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.emit(.token(activityId: "la-1", Self.tokenA))
    await until("próba urządzenia") { rig.transport.read { $0.apnsRegistrations.count } == 1 }
    await settle()
    #expect(registrations(rig).isEmpty, "serwer nie zna urządzenia — token aktywności dostałby 409")
    // Następne połączenie: urządzenie przechodzi, ale serwer zgubił wpis między żądaniami (409).
    rig.transport.set {
      $0.apnsRegisterResult = nil
      $0.liveRegisterResults = [.http(APIFailure(status: 409, code: "apns-device-unknown"))]
    }
    let opened = rig.transport.streamCalls.count
    rig.transport.end(.global)
    await until("nowe połączenie") { rig.transport.streamCalls.count > opened && rig.store.state.global == .online }
    rig.transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "running"))]}"#)
    await until("token po 409 i ponownej rejestracji urządzenia") { registrations(rig).count == 2 }
    #expect(rig.transport.read { $0.apnsRegistrations.count } == 3, "409 odesłał urządzenie do ponownej rejestracji")
    // Atrapa notuje wywołanie, zanim odpowiedź wróci do magazynu — przyjęcie dopiero po niej.
    await until("przyjęty") { registrations(rig).dropFirst().first.map { $0 == rig.store.liveRuntime.registered } == true }
  }

  @Test("koniec po 30 min ciszy na wierzchu: 29:59 nic, 30:00 koniec i `…/end`; praca w 29. minucie zeruje zegar")
  func quietEnd() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    await until("urządzenie przyjęte") { rig.store.pushRuntime.registeredToken != nil }
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("cisza — zegar rusza") { rig.clock.sleeping.count == 1 }
    rig.clock.advance(by: .seconds(29 * 60 + 59))
    await settle()
    #expect(rig.activities.ended.isEmpty)
    // Praca w 29. minucie: zegar od nowa.
    change(rig, Frames.summary("s1", state: "running"))
    await until("praca — zegar stoi") { rig.clock.sleeping.isEmpty }
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("znów cisza") { rig.clock.sleeping.count == 1 }
    rig.clock.advance(by: .seconds(1))
    await settle()
    #expect(rig.activities.ended.isEmpty, "stary termin anulowany razem z pracą")
    rig.clock.advance(by: .seconds(29 * 60 + 58))
    await settle()
    #expect(rig.activities.ended.isEmpty)
    rig.clock.advance(by: .seconds(1))
    await until("koniec po ciszy") { rig.activities.ended == ["la-1"] }
    await until("serwer wie") { rig.transport.read { $0.liveEnds.count } == 1 }
    #expect(rig.transport.read { $0.liveEnds } == [LiveActivityEndBody(deviceToken: Self.deviceHex, activityId: "la-1")])
    #expect(rig.store.liveActivityId == nil)
    await settle()
    #expect(rig.activities.requests.count == 1, "cisza nie stawia nowego kafla")
  }

  @Test("przebieg workflow w tle trzyma kafel bez pracy sesji; wszyscy agenci skończyli — zegar ciszy rusza")
  func backgroundWorkflowHoldsQuietClock() async throws {
    let rig = rig()
    // Sesja skończyła turę („odpaliłem, dam znać"), a przebieg mieli dalej — to wystarcza do startu.
    let milling = Frames.summary(
      "s1", state: "waiting-input", extra: backgroundTasks(workflowTask("w", agents: [true, false])))
    await online(rig, [milling])
    await until("start przy samym przebiegu w tle") { rig.activities.requests.count == 1 }
    // „Pracuje w tle" jak na liście: praca, nie wynik do odebrania.
    #expect(rig.activities.requests[0].state.working == 1 && rig.activities.requests[0].state.finished == 0)
    await settle()
    #expect(rig.clock.sleeping.isEmpty, "przebieg z agentem w locie: zegar ciszy stoi")
    rig.clock.advance(by: .seconds(31 * 60))
    await settle()
    #expect(rig.activities.ended.isEmpty, "31 min bez pracy sesji, ale z przebiegiem — kafel żyje")
    // Rozkład jeszcze nieodczytany: „nie wiem" też trzyma kafel.
    change(rig, Frames.summary("s1", state: "waiting-input", extra: backgroundTasks(workflowTask("w", run: false))))
    await settle()
    #expect(rig.clock.sleeping.isEmpty)
    // Wszyscy agenci skończyli: przebieg już nie trzyma — 30 min i koniec.
    change(rig, Frames.summary(
      "s1", state: "waiting-input", extra: backgroundTasks(workflowTask("w", agents: [true, true]))))
    await until("zegar ciszy rusza") { rig.clock.sleeping.count == 1 }
    rig.clock.advance(by: .seconds(29 * 60 + 59))
    await settle()
    #expect(rig.activities.ended.isEmpty)
    rig.clock.advance(by: .seconds(1))
    await until("koniec po ciszy") { rig.activities.ended == ["la-1"] }
  }

  @Test("sen zegara ciszy skończony tuż przed terminem (inny zegar niż zegar magazynu) nie gubi końca")
  func quietWakesEarly() async throws {
    let rig = rig()
    let clock = rig.clock
    // Sen budzi się 1 ms przed terminem — jak monotoniczny `Task.sleep` wobec ściennego `Date`.
    rig.store.liveActivityTiming = LiveActivityTiming(
      quietEnd: .seconds(1800),
      sleep: { await clock.sleep($0 > .milliseconds(1) ? $0 - .milliseconds(1) : $0) })
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("cisza") { rig.clock.sleeping.count == 1 }
    rig.clock.advance(by: .seconds(1800) - .milliseconds(1))
    await until("zegar staje na resztę") { rig.clock.sleeping == [.milliseconds(1)] }
    #expect(rig.activities.ended.isEmpty)
    rig.clock.advance(by: .milliseconds(1))
    await until("koniec po pełnym terminie") { rig.activities.ended == ["la-1"] }
  }

  @Test("w tle zegar ciszy stoi — kończy wtedy serwer; po powrocie zegar od nowa")
  func quietClockStopsInBackground() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("cisza") { rig.clock.sleeping.count == 1 }
    rig.store.setScenePhase(.background)
    await until("zegar ciszy zatrzymany") { rig.clock.sleeping.isEmpty }
    rig.clock.advance(by: .seconds(31 * 60))
    await settle()
    #expect(rig.activities.ended.isEmpty)
    // Powrót: pełne 30 min od świeżej listy NOWEGO połączenia (czas tła się nie liczy).
    let opened = rig.transport.streamCalls.count
    rig.store.setScenePhase(.active)
    await until("nowe połączenie") { rig.transport.streamCalls.count > opened && rig.store.state.global == .online }
    rig.clock.advance(by: .seconds(60))
    rig.transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("zegar od nowa") { rig.clock.sleeping.count == 1 }
    rig.clock.advance(by: .seconds(29 * 60 + 59))
    await settle()
    #expect(rig.activities.ended.isEmpty)
    rig.clock.advance(by: .seconds(1))
    await until("koniec po pełnych 30 min od powrotu") { rig.activities.ended == ["la-1"] }
  }

  @Test("wylogowanie (401): koniec naszej i osieroconej lokalnie, bez trasy `…/end` (klucz odrzucony)")
  func logout() async throws {
    let rig = rig(running: ["stara"])
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.running.append("stara-2")
    rig.store.handleUnauthorized()
    #expect(rig.store.liveActivityId == nil)
    await until("koniec wszystkich") { Set(rig.activities.ended) == ["stara", "la-1", "stara-2"] }
    #expect(rig.activities.running.isEmpty)
    await settle()
    #expect(rig.transport.read { $0.liveEnds }.isEmpty)
  }

  @Test("brak logowania przy starcie: osierocone aktywności kończą się")
  func coldStartLoggedOut() async throws {
    let rig = rig(credential: false, running: ["stara"])
    await rig.store.start()
    await until("osierocona zakończona") { rig.activities.ended == ["stara"] }
  }

  @Test("zimny start z kluczem, osierocona aktywność i serwer bez kanału (`apnsEnabled: false`) — koniec osieroconej")
  func coldStartWithoutChannel() async throws {
    let rig = rig(channel: false, running: ["stara"])
    await online(rig, [Frames.summary("s1", state: "running")])
    await settle()
    #expect(rig.activities.ended.isEmpty, "kanał nieznany (sonda wersji nie przyszła) — nic nie przesądzamy")
    let off = try JSONDecoder().decode(VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","apnsEnabled":false}"#.utf8))
    rig.store.dispatch(.versionProbed(off))
    await until("osierocona bez kanału zakończona") { rig.activities.ended == ["stara"] }
    change(rig, Frames.summary("s2", state: "running"))
    await settle()
    #expect(rig.activities.ended == ["stara"] && rig.activities.requests.isEmpty, "raz, bez startu")
  }

  @Test("start czeka, aż system NAPRAWDĘ zakończy osieroconą (koniec jest asynchroniczny, system liczy aktywności)")
  func startWaitsForOrphanEnd() async throws {
    let rig = rig(running: ["stara"])
    let gate = AsyncGate()
    rig.activities.endGate = gate
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("koniec osieroconej w toku") { rig.activities.ended == ["stara"] }
    change(rig, Frames.summary("s2", state: "running"))
    await settle()
    #expect(rig.activities.requests.isEmpty, "przed końcem osieroconej nie ma startu")
    #expect(rig.activities.ended == ["stara"], "kolejne ramki nie kończą jej drugi raz")
    await gate.open()
    await until("start po końcu osieroconej") { rig.activities.requests.count == 1 }
    #expect(rig.activities.running == ["la-1"])
  }

  @Test("koniec z zewnątrz (8 h, `end` z serwera): stan znika; przy pracy na wierzchu wstaje nowa")
  func externalEnd() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.running.removeAll()
    rig.activities.emit(.ended(activityId: "la-1"))
    #expect(rig.activities.requests.count == 2 && rig.store.liveActivityId == "la-2")
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("cisza") { rig.clock.sleeping.count == 1 }
    rig.activities.emit(.ended(activityId: "la-2"))
    #expect(rig.store.liveActivityId == nil && rig.activities.requests.count == 2, "w ciszy bez nowego kafla")
  }

  @Test("koniec z zewnątrz (8 h): zakończony, a widoczny kafel znika od razu (`end`); przy pracy wstaje nowy")
  func externalEndRemovesEndedTile() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    // System zakończył la-1 sam, kafel wisi dalej na ekranie blokady (na liście pokazanych).
    rig.activities.endKeepsShown = true
    rig.activities.emit(.ended(activityId: "la-1"))
    #expect(rig.store.liveActivityId == "la-2" && rig.activities.requests.count == 2, "nowy kafel od razu")
    await until("zdjęcie zakończonego kafla") { rig.activities.ended == ["la-1"] }
    // Następny start (po końcu la-2 w pracy) nie kończy la-1 drugi raz, choć system nadal ją pokazuje.
    rig.activities.emit(.ended(activityId: "la-2"))
    await until("zdjęcie la-2") { rig.activities.ended == ["la-1", "la-2"] }
    #expect(rig.store.liveActivityId == "la-3" && rig.activities.requests.count == 3)
    await settle()
    #expect(rig.activities.ended == ["la-1", "la-2"], "każdy kafel raz")
  }

  @Test("koniec z zewnątrz w ciszy: kafel zdjęty, stanu brak, nowy nie wstaje")
  func externalEndInQuietRemovesTile() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    change(rig, Frames.summary("s1", state: "waiting-input"))
    await until("cisza") { rig.clock.sleeping.count == 1 }
    rig.activities.endKeepsShown = true
    rig.activities.emit(.ended(activityId: "la-1"))
    #expect(rig.store.liveActivityId == nil)
    await until("zdjęcie zakończonego kafla") { rig.activities.ended == ["la-1"] }
    await settle()
    #expect(rig.activities.requests.count == 1 && rig.activities.ended == ["la-1"])
  }

  @Test("start przy zakończonym, a widocznym kaflu z poprzedniego procesu: najpierw `end`, potem start; system zwleka — bez drugiego `end`")
  func startEndsShownEndedTileOnce() async throws {
    // „stara” = kafel w stanie `ended` z poprzedniego procesu; adapter podaje go na liście pokazanych.
    let rig = rig(running: ["stara"])
    rig.activities.endKeepsShown = true
    let gate = AsyncGate()
    rig.activities.endGate = gate
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("koniec starej w toku") { rig.activities.ended == ["stara"] }
    await settle()
    #expect(rig.activities.requests.isEmpty, "start czeka na `end` starej")
    await gate.open()
    await until("start po końcu starej") { rig.activities.requests.count == 1 }
    #expect(rig.activities.running == ["stara", "la-1"], "system nadal pokazuje starą")
    change(rig, Frames.summary("s2", state: "running"))
    await settle()
    #expect(rig.activities.ended == ["stara"] && rig.activities.requests.count == 1, "stara raz, start nie stoi")
  }

  @Test("wylogowanie przy zakończonym, a widocznym kaflu z poprzedniego procesu: `end` także jego")
  func logoutEndsShownEndedTile() async throws {
    let rig = rig(running: ["stara"])
    await online(rig, [Frames.summary("s1", state: "waiting-input")])
    await settle()
    #expect(rig.activities.ended.isEmpty && rig.activities.requests.isEmpty)
    rig.store.handleUnauthorized()
    await until("koniec starej") { rig.activities.ended == ["stara"] }
  }

  /// `GET /api/version` z danym systemem maszyny serwera (sonda po `hello`).
  private func probe(_ rig: Rig, system: String) throws {
    let json = PairingFixtures.json("version.json")
      .replacingOccurrences(of: #""system": "macos""#, with: #""system": "\#(system)""#)
    let info = try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
    try #require(info.system?.rawValue == system)
    rig.transport.set { $0.version = info }
  }

  @Test("słowo maszyny: kafel z atrybutem systemu; inne słowo po sondzie — koniec z `…/end` i nowy kafel; to samo słowo — bez zmian")
  func machineWordRestartsTile() async throws {
    let rig = rig()
    // Każde `hello` to sonda wersji (bez podłogi), a pętla odczytów nie wraca sama w trakcie testu.
    rig.store.usageTiming = UsageTiming(refresh: .seconds(600), retry: .seconds(600), floor: .zero)
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    #expect(rig.activities.requestSystems == [nil], "przed sondą system nieznany: kafel mówi „Mac”")
    #expect(rig.store.state.serverMachine == .mac)

    // Ten sam wyraz (nieznany → macOS): kafel stoi.
    try probe(rig, system: "macos")
    rig.transport.push(.global, json: Self.hello)
    await until("sonda macos") { rig.store.state.serverSystem == .macos }
    await settle()
    #expect(rig.activities.requests.count == 1 && rig.activities.ended.isEmpty && rig.store.liveActivityId == "la-1")

    // Serwer na Linuksie: atrybutów żywej aktywności zmienić się nie da — koniec la-1 i nowy kafel z `linux`,
    // ale dopiero po prawdziwym końcu la-1 (koniec jest asynchroniczny) i z jednym `end`.
    let gate = AsyncGate()
    rig.activities.endGate = gate
    try probe(rig, system: "linux")
    rig.transport.push(.global, json: Self.hello)
    await until("koniec la-1 w toku") { rig.activities.ended == ["la-1"] }
    await settle()
    #expect(rig.activities.requests.count == 1, "przed końcem starego kafla nie ma nowego")
    await gate.open()
    await until("nowy kafel") { rig.activities.requests.count == 2 && rig.activities.running == ["la-2"] }
    #expect(rig.activities.requestSystems == [nil, .linux] && rig.store.liveActivityId == "la-2")
    #expect(rig.activities.ended == ["la-1"], "jeden `end` starego kafla")
    await until("…/end starego kafla") { rig.transport.read { $0.liveEnds }.map(\.activityId) == ["la-1"] }

    // Linux → inny system: to samo słowo „VPS”, kafel stoi.
    try probe(rig, system: "other")
    rig.transport.push(.global, json: Self.hello)
    await until("sonda other") { rig.store.state.serverSystem == .other }
    await settle()
    #expect(rig.activities.requests.count == 2 && rig.store.liveActivityId == "la-2")
  }

  @Test("słowo maszyny: poza wierzchem (`inactive`) kafel z innym słowem stoi — wymiana dopiero na wierzchu")
  func machineWordWaitsForActive() async throws {
    let rig = rig()
    rig.store.usageTiming = UsageTiming(refresh: .seconds(600), retry: .seconds(600), floor: .zero)
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.store.setScenePhase(.inactive)
    try probe(rig, system: "linux")
    rig.transport.push(.global, json: Self.hello)
    await until("sonda linux") { rig.store.state.serverSystem == .linux }
    await settle()
    #expect(rig.activities.requests.count == 1 && rig.activities.ended.isEmpty, "poza wierzchem apka kafla nie stawia")
    rig.store.setScenePhase(.active)
    await until("nowy kafel na wierzchu") { rig.activities.requests.count == 2 }
    #expect(rig.activities.requestSystems == [nil, .linux])
  }

  // MARK: - Zapis liczników z apki

  @Test("zapis z apki: znacznik = najnowszy `stateSince` listy do pełnej sekundy minus 1 s; starszy niż znany znacznik kafla odrzucony bez `update`, kafel bez zmian")
  func writeTimestamp() async throws {
    let rig = rig()
    await online(rig, [
      Frames.summary("s1", state: "running", stateSince: Self.t("08:00:00.000")),
      Frames.summary("s2", state: "waiting-input", stateSince: Self.t("08:01:30.250")),
    ])
    await until("start") { rig.activities.requests.count == 1 }
    let stale = rig.clock.now.addingTimeInterval(900)
    let first = Self.served(0, 1, 1, at: Self.t("08:02:00.000"))
    rig.activities.push("la-1", first, staleDate: stale)
    // Decyzja na liście, przejście nowsze niż push: liczniki listy na treści serwera, znacznik 08:03:00.500 → 08:02:59.
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:03:00.500")))
    await until("zapis") { rig.activities.updates.count == 1 }
    var expected = first
    expected.waiting = 1
    expected.working = 0
    #expect(rig.activities.updates[0] == FakeActivities.Update(
      id: "la-1", content: LiveActivityContent(state: expected, staleDate: stale),
      timestamp: Self.at(Self.t("08:02:59.000"))))
    await until("przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
    #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: expected, staleDate: stale))
    // Push nowszy niż następne przejście listy: zapis odrzucony bez `update`, kafel zostaje przy pushu.
    let second = Self.served(1, 0, 1, at: Self.t("08:05:00.000"), limit: 55)
    rig.activities.push("la-1", second)
    change(rig, Frames.summary("s2", state: "running", stateSince: Self.t("08:04:00.000")))
    await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    #expect(rig.activities.updates.count == 1, "system i tak by go odrzucił")
    #expect(rig.store.liveRuntime.writeStats.issued == 2 && rig.store.liveRuntime.writeStats.accepted == 1)
    #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: second, staleDate: nil))
  }

  /// Granice znacznika `floor(przejście) − 1 s` wobec pushy serwera (pełne sekundy, nie mniej niż sekunda wysłania).
  enum StampBoundary: CaseIterable, Sendable {
    /// Push wysłany po przejściu, w tej samej sekundzie: znacznik o sekundę nowszy od zapisu — system go przyjmuje.
    case pushAfterInSameSecond
    /// Push z sekundy przejścia wysłany tuż przed nim (albo z podbitym `last + 1`): zapis starszy — odrzucony.
    case pushBeforeInSameSecond
    /// Push z poprzedniej sekundy: znacznik równy zapisowi; atrapa przyjmuje równy (Apple: „older than”).
    case pushPreviousSecond
  }

  @Test("granice znacznika: push z sekundy przejścia wygrywa z zapisem; push z poprzedniej sekundy — znacznik równy", arguments: StampBoundary.allCases)
  func writeStampBoundaries(_ boundary: StampBoundary) async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running", stateSince: Self.t("08:00:00.000"))])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:00:30.000")))
    switch boundary {
    case .pushAfterInSameSecond:
      change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.400")))
      await until("przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
      #expect(rig.activities.updates.map(\.timestamp) == [Self.at(Self.t("08:00:59.000"))])
      let after = Self.served(1, 0, 0, at: Self.t("08:01:00.000"), limit: 55)
      rig.activities.push("la-1", after)
      #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: after, staleDate: nil), "push nie przepada")
    case .pushBeforeInSameSecond:
      // Push sprzed przejścia (stare liczniki) ze znacznikiem jego sekundy: zapis przepada, kafel czeka na push.
      let before = Self.served(0, 1, 0, at: Self.t("08:01:00.000"), limit: 55)
      rig.activities.push("la-1", before)
      change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.400")))
      await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
      #expect(rig.activities.updates.isEmpty && rig.activities.displayed["la-1"]?.state == before)
    case .pushPreviousSecond:
      rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:00:59.000"), limit: 55))
      change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.400")))
      await until("przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
      #expect(rig.activities.updates.map(\.timestamp) == [Self.at(Self.t("08:00:59.000"))])
      #expect(rig.activities.displayed["la-1"]?.state.waiting == 1 && rig.activities.displayed["la-1"]?.state.limits?.fiveHour == 55)
    }
  }

  @Test("zapis tylko przy zmianie liczników, poza tłem (także `inactive`), z własną aktywnością i na świeżej liście; push go nie budzi")
  func writeTriggers() async throws {
    // Bez aktywności (cisza przy otwarciu apki): zmiana liczników nic nie zapisuje.
    let quiet = rig()
    await online(quiet, [Frames.summary("s1", state: "waiting-input")])
    change(quiet, Frames.summary("s1", state: "waiting-input", extra: #","seen":true"#))
    await settle()
    #expect(quiet.activities.requests.isEmpty && quiet.activities.updates.isEmpty)

    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    // Zmiana listy bez zmiany liczników i push z innymi licznikami: bez zapisu.
    change(rig, Frames.summary("s2", state: "done", stateSince: Self.t("08:00:30.000")))
    rig.activities.push("la-1", Self.served(3, 0, 0, at: Self.t("08:00:40.000")))
    await settle()
    #expect(rig.activities.updates.isEmpty, "push nie budzi zapisu")
    // `inactive` (Centrum sterowania, przełącznik apek) to nie tło: zapis idzie.
    rig.store.setScenePhase(.inactive)
    change(rig, Frames.summary("s1", state: "waiting-question", stateSince: Self.t("08:01:00.000")))
    await until("zapis w `inactive`") { rig.activities.updates.count == 1 }
    #expect(Self.counts(rig.activities.updates[0].content.state) == [1, 0, 0])
    rig.store.setScenePhase(.active)
    // Nowe połączenie przed pełnym stanem: lista nieświeża, zmiana czeka; pełny stan — zapis najnowszych.
    let opened = rig.transport.streamCalls.count
    rig.transport.end(.global)
    await until("nowe połączenie") { rig.transport.streamCalls.count > opened && rig.store.state.global == .online }
    rig.transport.push(.global, json: Self.hello)
    change(rig, Frames.summary("s1", state: "running", stateSince: Self.t("08:02:00.000")))
    await settle()
    #expect(rig.activities.updates.count == 1, "lista bez pełnego stanu nie jest świeża")
    let snapshot = [
      Frames.summary("s1", state: "running", stateSince: Self.t("08:02:00.000")),
      Frames.summary("s3", state: "running", stateSince: Self.t("08:02:30.000")),
    ]
    rig.transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(snapshot.joined(separator: ","))]}"#)
    await until("zapis po pełnym stanie") { rig.activities.updates.count == 2 }
    #expect(Self.counts(rig.activities.updates[1].content.state) == [0, 2, 0])
    // Tło: strumień listy stoi, push nic nie budzi.
    rig.store.setScenePhase(.background)
    rig.activities.push("la-1", Self.served(0, 0, 2, at: Self.t("08:10:00.000")))
    await settle()
    #expect(rig.activities.updates.count == 2)
  }

  @Test("seria A, B, C w trakcie zablokowanego zapisu: jeden zapis naraz, B przepada, na końcu najnowsze C; seria wracająca do liczników kafla — bez zapisu")
  func writeSeriesCoalesces() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    let gate = AsyncGate()
    rig.activities.updateGate = gate
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.000")))
    await until("pierwszy zapis w toku") { rig.activities.updates.count == 1 }
    change(rig, Frames.summary("s1", state: "running", stateSince: Self.t("08:02:00.000")))
    change(rig, Frames.summary("s1", state: "waiting-input", stateSince: Self.t("08:03:00.000")))
    await settle()
    #expect(rig.activities.updates.count == 1, "następny zapis czeka na pierwszy")
    await gate.open()
    await until("zapis najnowszych") { rig.activities.updates.count == 2 }
    await settle()
    #expect(rig.activities.updates.count == 2 && rig.activities.maxUpdatesInFlight == 1)
    #expect(Self.counts(rig.activities.updates[1].content.state) == [0, 0, 1])
    #expect(rig.activities.updates[1].timestamp == Self.at(Self.t("08:02:59.000")))
    #expect(rig.activities.displayed["la-1"]?.state.finished == 1 && rig.store.liveRuntime.writer == nil)
    // A, B, A: po zapisie A najnowsze liczniki są już na kaflu — drugiego zapisu nie ma i nie liczy się do zleconych.
    let second = AsyncGate()
    rig.activities.updateGate = second
    change(rig, Frames.summary("s1", state: "running", stateSince: Self.t("08:04:00.000")))
    await until("zapis A w toku") { rig.activities.updates.count == 3 }
    change(rig, Frames.summary("s1", state: "waiting-question", stateSince: Self.t("08:05:00.000")))
    change(rig, Frames.summary("s1", state: "running", stateSince: Self.t("08:06:00.000")))
    await until("A czeka") { rig.store.liveRuntime.pendingWrite.map { Self.counts($0.local) } == [0, 1, 0] }
    await second.open()
    await until("pisarz skończył") { rig.store.liveRuntime.writer == nil }
    #expect(rig.activities.updates.count == 3 && rig.store.liveRuntime.writeStats.issued == 3)
  }

  @Test("push z nowymi limitami między odczytem treści a zapisem: starszy zapis odrzucony, limity zostają")
  func pushDuringWrite() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:00:30.000"), limit: 40))
    let gate = AsyncGate()
    rig.activities.updateGate = gate
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.000")))
    await until("zapis w toku") { rig.activities.updates.count == 1 }
    #expect(rig.activities.updates[0].content.state.limits?.fiveHour == 40, "nakładka na treść sprzed pusha")
    let newer = Self.served(1, 0, 0, at: Self.t("08:01:05.000"), limit: 70)
    rig.activities.push("la-1", newer)
    await gate.open()
    await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: newer, staleDate: nil))
    await settle()
    #expect(rig.activities.updates.count == 1, "push nie budzi następnego zapisu")
  }

  @Test("push starszy niż zapis przychodzi w trakcie `update`: jeden zapis naprawczy przywraca jego limity, przebiegi, `updatedEpoch` i `staleDate`, liczniki z apki")
  func pushDuringWriteRepaired() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running", stateSince: Self.t("08:00:00.000"))])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:00:30.000"), limit: 40))
    let gate = AsyncGate()
    rig.activities.updateGate = gate
    // Przejście 08:02:00 → znacznik zapisu 08:01:59; baza z pusha 08:00:30.
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:02:00.000")))
    await until("zapis w toku") { rig.activities.updates.count == 1 }
    // Push 08:01:00 (nowe limity, przebieg i data nieświeżości) przychodzi, zanim system obsłużył zapis.
    var later = Self.served(0, 1, 0, at: Self.t("08:01:00.000"), limit: 70)
    later.workflows = [.init(sessionId: "s1", project: "rarog", name: "audyt-docs", agents: 2, done: 2, segments: [100])]
    let laterStale = rig.clock.now.addingTimeInterval(1800)
    rig.activities.push("la-1", later, staleDate: laterStale)
    await gate.open()
    await until("pisarz skończył") { rig.store.liveRuntime.writer == nil }
    var expected = later
    expected.waiting = 1
    expected.working = 0
    #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: expected, staleDate: laterStale))
    #expect(rig.activities.updates.map(\.timestamp) == [
      Self.at(Self.t("08:01:59.000")), Self.at(Self.t("08:01:59.000")).addingTimeInterval(0.001),
    ])
    let stats = rig.store.liveRuntime.writeStats
    #expect(stats.issued == 2 && stats.accepted == 2 && stats.rejected == 0 && stats.reverted == 0)
    // Push wysłany po przejściu ma znacznik nowszy od zapisu naprawczego i zastępuje go bez kolejnego zapisu.
    let after = Self.served(1, 0, 0, at: Self.t("08:02:00.000"), limit: 75)
    rig.activities.push("la-1", after)
    await settle()
    #expect(rig.activities.displayed["la-1"] == LiveActivityContent(state: after, staleDate: nil))
    #expect(rig.activities.updates.count == 2)
  }

  @Test("strumień oglądanej sesji wyprzedza globalny: nowszy `stateSince` sesji B nie zeruje decyzji A, którą push już pokazał")
  func sessionStreamAhead() async throws {
    let rig = rig()
    await online(rig, [
      Frames.summary("s1", state: "running", stateSince: Self.t("08:00:00.000")),
      Frames.summary("s2", state: "running", stateSince: Self.t("08:00:00.000")),
    ])
    await until("start") { rig.activities.requests.count == 1 }
    rig.store.openSession("s2")
    await until("strumień sesji B") { rig.transport.streamCalls.contains { $0.scope == .session(id: "s2") } }
    // A czeka na decyzję (08:00:59.900): push już ją pokazał, ramka globalna A jeszcze nie doszła.
    rig.activities.push("la-1", Self.served(1, 1, 0, at: Self.t("08:01:00.000")))
    // Strumień sesji B dowozi jej przejście nowsze niż push — lista `sessions` je ma, obraz globalny nie.
    rig.transport.push(.session(id: "s2"), json: #"""
      {"type":"session-changed","session":\#(Frames.summary("s2", state: "waiting-input", stateSince: Self.t("08:01:30.500")))}
      """#)
    await until("B na liście") { rig.store.state.sessions["s2"]?.state == .waitingInput }
    await settle()
    #expect(rig.activities.updates.isEmpty, "ramka strumienia sesji nie budzi zapisu")
    // Ramka globalna innej sesji, starsza niż push: liczniki obrazu się zmieniają, znacznik starszy — bez `update`.
    change(rig, Frames.summary("s3", state: "waiting-input", stateSince: Self.t("08:00:30.000")))
    await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    #expect(rig.activities.updates.isEmpty && rig.activities.displayed["la-1"]?.state.waiting == 1)
    // Strumień globalny dogania: A czeka, B po turze — zapis przyjęty, decyzja A dalej na kaflu.
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:00:59.900")))
    change(rig, Frames.summary("s2", state: "waiting-input", stateSince: Self.t("08:01:30.500")))
    await until("przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
    #expect(rig.activities.updates.allSatisfy { $0.content.state.waiting == 1 })
    #expect(Self.counts(try #require(rig.activities.displayed["la-1"]).state) == [1, 0, 2])
    #expect(rig.activities.updates.last?.timestamp == Self.at(Self.t("08:01:29.000")))
  }

  @Test("kafel ma już liczniki listy z pusha: zapisu ze starszym znacznikiem nie ma, przyjęte i ostatni przyjęty zapis bez zmian")
  func tileAlreadyAgrees() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running", stateSince: Self.t("08:00:00.000"))])
    await until("start") { rig.activities.requests.count == 1 }
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.000")))
    await until("przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
    let accepted = try #require(rig.store.liveRuntime.acceptedWrite)
    // Push wcześniej ustawia docelowe liczniki; lista dochodzi do nich przejściem starszym niż ten push.
    rig.activities.push("la-1", Self.served(1, 1, 0, at: Self.t("08:02:00.000")))
    change(rig, Frames.summary("s2", state: "running", stateSince: Self.t("08:01:30.000")))
    await settle()
    let stats = rig.store.liveRuntime.writeStats
    #expect(rig.activities.updates.count == 1 && stats.issued == 1 && stats.accepted == 1 && stats.rejected == 0)
    #expect(rig.store.liveRuntime.acceptedWrite?.asOf == accepted.asOf)
    #expect(rig.store.liveRuntime.acceptedWrite?.counts == accepted.counts)
    // Inne liczniki, znacznik wciąż starszy niż push: odrzucony bez `update`, ostatni przyjęty bez zmian.
    change(rig, Frames.summary("s3", state: "waiting-input", stateSince: Self.t("08:01:40.000")))
    await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    #expect(rig.activities.updates.count == 1 && rig.store.liveRuntime.acceptedWrite?.asOf == accepted.asOf)
  }

  enum Interruption: CaseIterable, Sendable { case externalEnd, newActivity, logout }

  @Test(
    "koniec aktywności, nowa aktywność albo wylogowanie w trakcie zapisu: stare zadanie nic nie zmienia",
    arguments: Interruption.allCases)
  func writeOutlived(_ interruption: Interruption) async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    let gate = AsyncGate()
    rig.activities.updateGate = gate
    // Koniec z zewnątrz w ciszy nie stawia nowego kafla; przy decyzji na wierzchu wstaje nowa aktywność.
    let busy = interruption != .externalEnd
    change(rig, Frames.summary(
      "s1", state: busy ? "waiting-permission" : "waiting-input", stateSince: Self.t("08:01:00.000")))
    await until("zapis w toku") { rig.activities.updates.count == 1 }
    // Następny zapis czeka na pisarza w chwili, gdy aktywność znika.
    change(rig, Frames.summary(
      "s1", state: busy ? "running" : "waiting-input", stateSince: Self.t(busy ? "08:02:00.000" : "08:01:00.000"),
      extra: busy ? "" : #","seen":true"#))
    await until("następny zapis czeka") { rig.store.liveRuntime.pendingWrite != nil }
    switch interruption {
    case .externalEnd, .newActivity:
      rig.activities.running.removeAll()
      rig.activities.emit(.ended(activityId: "la-1"))
    case .logout:
      rig.store.handleUnauthorized()
    }
    #expect(rig.store.liveActivityId == (interruption == .newActivity ? "la-2" : nil))
    await gate.open()
    await settle()
    #expect(rig.activities.updates.map(\.id) == ["la-1"], "czekający zapis starej aktywności przepadł")
    let stats = rig.store.liveRuntime.writeStats
    #expect(stats.issued == 1 && stats.accepted == 0 && stats.rejected == 0, "wynik starego zapisu się nie liczy")
    #expect(rig.store.liveRuntime.writer == nil && rig.store.liveRuntime.pendingWrite == nil)
    guard interruption == .newActivity else { return }
    // Nowa aktywność ma liczniki startu i własnego pisarza.
    #expect(Self.counts(rig.activities.requests[1].state) == [0, 1, 0])
    change(rig, Frames.summary("s1", state: "waiting-question", stateSince: Self.t("08:03:00.000")))
    await until("zapis nowej aktywności") { rig.activities.updates.last?.id == "la-2" }
  }

  @Test("zapis odrzucony nie blokuje następnego; zegar ciszy dochodzi do 30 min mimo zapisów i wejść `content`")
  func quietClockIgnoresWrites() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:10:00.000")))
    change(rig, Frames.summary("s1", state: "waiting-input", stateSince: Self.t("08:05:00.000")))
    await until("cisza — zegar rusza") { rig.clock.sleeping.count == 1 }
    await until("zapis odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    change(rig, Frames.summary("s2", state: "waiting-input", stateSince: Self.t("08:11:00.000")))
    await until("następny przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
    #expect(rig.activities.displayed["la-1"]?.state.finished == 2)
    rig.activities.push("la-1", Self.served(0, 0, 2, at: Self.t("08:12:00.000")))
    rig.clock.advance(by: .seconds(29 * 60 + 59))
    await settle()
    #expect(rig.activities.ended.isEmpty && rig.clock.sleeping.count == 1)
    rig.clock.advance(by: .seconds(1))
    await until("koniec po ciszy") { rig.activities.ended == ["la-1"] }
  }

  @Test("dopisek linii „na wierzchu”: zapisy zlecone, przyjęte, odrzucone i cofnięte od poprzedniej; echo zapisu to nie cofnięcie")
  func foregroundTraceWrites() async throws {
    let rig = rig()
    await online(rig, [Frames.summary("s1", state: "running")])
    await until("start") { rig.activities.requests.count == 1 }
    rig.activities.push("la-1", Self.served(0, 1, 0, at: Self.t("08:00:30.000")))
    // Dwa zapisy przyjęte.
    change(rig, Frames.summary("s1", state: "waiting-permission", stateSince: Self.t("08:01:00.000")))
    await until("pierwszy przyjęty") { rig.store.liveRuntime.writeStats.accepted == 1 }
    let firstWrite = try #require(rig.activities.displayed["la-1"]).state
    change(rig, Frames.summary("s2", state: "running", stateSince: Self.t("08:02:00.000")))
    await until("drugi przyjęty") { rig.store.liveRuntime.writeStats.accepted == 2 }
    // Jeden odrzucony: push nowszy niż następne przejście listy.
    rig.activities.push("la-1", Self.served(1, 1, 0, at: Self.t("08:03:00.000")))
    change(rig, Frames.summary("s3", state: "waiting-input", stateSince: Self.t("08:02:30.000")))
    await until("odrzucony") { rig.store.liveRuntime.writeStats.rejected == 1 }
    // Echo pierwszego zapisu (starsze liczniki, `updatedEpoch` pusha) — własny zapis, nie cofnięcie.
    rig.activities.show("la-1", firstWrite)
    // Push sprzed przyjętego zapisu z innymi licznikami, który system mimo znacznika pokazuje — cofnięcie.
    let old = Self.served(0, 0, 0, at: Self.t("08:00:40.000"))
    rig.activities.show("la-1", old)
    // Spóźnione wejście treści, którą system już zastąpił — też nie.
    rig.activities.emit(.content(activityId: "la-1", LiveActivityContent(
      state: Self.served(0, 0, 3, at: Self.t("08:00:50.000")), staleDate: nil)))
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    let age = Int(rig.clock.now.timeIntervalSince1970) - old.updatedEpoch
    await until("dopisek z liczbami") {
      traces(rig).contains(
        "live-activity: na wierzchu — treść kafla sprzed \(age) s, częste aktualizacje: tak,"
          + " zapisy z apki od poprzedniej: 3 (przyjęte 2, odrzucone 1, cofnięte 1)")
    }
    // Od poprzedniej linii: następna, po 15 min, ma zera.
    rig.clock.advance(by: .seconds(15 * 60))
    rig.store.setScenePhase(.inactive)
    rig.store.setScenePhase(.active)
    let later = Int(rig.clock.now.timeIntervalSince1970) - old.updatedEpoch
    await until("dopisek od poprzedniej linii") {
      traces(rig).contains(
        "live-activity: na wierzchu — treść kafla sprzed \(later) s, częste aktualizacje: tak" + Self.noWrites)
    }
  }
}
