import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

@MainActor
@Suite("regresje review cache i logowania")
struct ListCacheReviewTests {
  private func cachedStore(
    transport: any RarogTransporting, base: FakeTransport, directory: URL,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) -> RarogStore {
    let rules = MutationRules(timing: fastTiming)
    base.gate = MutationGate(policy: rules)
    return RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7,
      timing: fastTiming, clock: clock, listCacheDirectory: directory)
  }

  private func writeCache(_ directory: URL, savedAt: Date, extra: String = "") async throws {
    let session = try JSONDecoder().decode(
      SessionSummary.self, from: Data(Frames.summary("s1", state: "waiting-input", extra: extra).utf8))
    #expect(await SnapshotCache(directory: directory).save([session], at: savedAt))
  }

  @Test("gest trybu czekający na świeżą listę nie wychodzi po 401 i nowym logowaniu")
  func waitingMutationCannotCrossLogin() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date(), extra: #","herdrMode":"plan""#)
    let probe = SessionProbe()
    let store = cachedStore(transport: probe, base: probe.base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("hello") { store.state.compat == .ok }
    let gesture = Task { await store.toggleMode("s1") }
    await until("gest czeka") { store.state.modeToggleInFlight("s1", now: Date()) }
    try await Task.sleep(for: .milliseconds(10))
    #expect(probe.read { $0.mode.isEmpty })
    store.handleUnauthorized()
    store.enterLoggedIn()
    await until("nowy strumień") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s2"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", extra: #","herdrMode":"plan""#))]}"#)
    _ = await gesture.value
    #expect(probe.read { $0.mode.isEmpty }, "stary gest nie należy do nowego logowania")
  }

  @Test("świeża lista przed transkryptem nie oznacza niewidzianego wyniku jako obejrzanego ani nie wysyła")
  func freshListStillNeedsTranscript() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date())
    let probe = TurnProbe()
    let store = cachedStore(transport: probe, base: probe.base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    store.openSession("s1")
    await until("online") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(store.state.transcriptPhase(for: "s1") == .loading)
    #expect(store.state.seenTarget("s1") == nil)
    store.noteResultViewed("s1")
    _ = await store.send(text: "nad szkieletem", to: "s1")
    #expect(probe.read { $0.seen.isEmpty })
    #expect(probe.base.read { $0.messages.isEmpty })
    await until("strumień sesji") { probe.base.streamCalls.contains { $0.scope == .session(id: "s1") } }
    probe.base.push(.session(id: "s1"), json: #"{"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[],"pendingQuestions":[]}"#)
    await until("świeży transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
    #expect(store.state.seenTarget("s1") != nil)
    store.noteResultViewed("s1")
    _ = await store.send(text: "po odczycie", to: "s1")
    await until("wynik obejrzany") { probe.read { $0.seen == ["s1"] } }
    #expect(probe.base.read { $0.messages.map { $0.body.text } } == ["po odczycie"])
  }

  @Test("agent w terminalu Raroga z cache nie czeka na transkrypt: świeża lista wystarcza do odbioru wyniku")
  func hostedSessionNeedsOnlyFreshList() async throws {
    let directory = temporaryOutbox()
    let hosted = #","termId":"0123456789abcdef""#
    try await writeCache(directory, savedAt: Date(), extra: hosted)
    let probe = TurnProbe()
    let store = cachedStore(transport: probe, base: probe.base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    #expect(store.state.listCache.awaitingTranscripts.isEmpty, "ekranem tej sesji jest terminal")
    #expect(store.state.seenTarget("s1") == nil, "lista z pamięci: odbioru jeszcze nie ma")
    await until("online") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input", extra: hosted))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(!store.state.sessionStale("s1"))
    #expect(store.state.seenTarget("s1") != nil)
    #expect(store.state.transcriptTarget("s1") == nil, "strumienia transkryptu nie otwieramy")
    store.noteResultViewed("s1")
    await until("wynik obejrzany") { probe.read { $0.seen == ["s1"] } }
  }

  @Test("`termId` przychodzi ramką `session-changed` po liście: sesja z cache przestaje czekać na transkrypt")
  func lateTerminalStopsAwaitingTranscript() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date())
    let probe = TurnProbe()
    let store = cachedStore(transport: probe, base: probe.base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(store.state.listCache.awaitingTranscripts == ["s1"])
    #expect(store.state.seenTarget("s1") == nil)
    // Terminal odzyskał token po restarcie herdr: karta dostaje `termId`, jej ekranem jest odtąd terminal.
    let hosted = Frames.summary("s1", state: "waiting-input", extra: #","termId":"0123456789abcdef""#)
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(hosted)}"#)
    await until("karta z terminalem") { store.state.sessions["s1"]?.termId != nil }
    #expect(store.state.listCache.awaitingTranscripts.isEmpty)
    #expect(store.state.seenTarget("s1") != nil)
  }

  @Test("zamknięcie z listy sesji z cache czeka tylko na świeżą listę, wysyłka dalej na transkrypt")
  func closeNeedsOnlyFreshList() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date())
    let base = FakeTransport()
    let store = cachedStore(transport: base, base: base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(store.state.listCache.awaitingTranscripts == ["s1"], "nikt nie otworzył s1, transkryptu nie ma")
    #expect(await store.closeSession("s1") == .closed, "lista mówi, że sesja istnieje — to wystarcza do zamknięcia")
    #expect(base.read { $0.closed.map(\.sessionId) } == ["s1"])
    _ = await store.send(text: "nad szkieletem", to: "s1")
    #expect(base.read { $0.messages.isEmpty }, "wysyłka działa na treści sesji i czeka na jej transkrypt")
  }

  @Test("przełącznik odbioru z listy dla sesji z cache czeka tylko na świeżą listę, nie na transkrypt")
  func readToggleNeedsOnlyFreshList() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date())
    let probe = TurnProbe()
    let store = cachedStore(transport: probe, base: probe.base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    #expect(store.state.readToggle("s1") == nil, "lista z pamięci podręcznej nie wie, czy wynik stoi")
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(store.state.listCache.awaitingTranscripts == ["s1"], "nikt nie otworzył s1, transkryptu nie ma")
    #expect(store.state.readToggle("s1") == .markRead)
    store.setResultRead("s1", read: true)
    store.setResultRead("s1", read: false)
    await until("oba żądania wyszły") { probe.read(\.seen) == ["s1"] && probe.read(\.unseen) == ["s1"] }
  }

  @Test("cache blokuje szybki start i formularz nowej sesji ze zdaniem o łączności; świeża lista je oddaje")
  func cachedLaunchIsBlocked() async throws {
    let directory = temporaryOutbox()
    try await writeCache(directory, savedAt: Date())
    let base = FakeTransport()
    let store = cachedStore(transport: base, base: base, directory: directory)
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("hello") { store.state.compat == .ok }
    #expect(store.state.launchBlocked)
    #expect(store.state.launchBlockedDetail == CoreCopy.noConnection)
    #expect(await store.createSession(in: "/Users/demo/projekt", defaults: NewSessionDefaults()) == .blocked(CoreCopy.noConnection))
    #expect(await store.launchSession(CreateSessionBody(cwd: "/Users/demo/projekt")) == .blocked(CoreCopy.noConnection))
    #expect(base.read { $0.created.isEmpty })
    base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))],"herdrStatus":{"available":true,"agentCount":1,"readOnly":false,"canLaunch":true}}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(!store.state.launchBlocked && store.state.launchBlockedDetail == nil)
    let after = await store.createSession(in: "/Users/demo/projekt", defaults: NewSessionDefaults())
    if case .created = after {} else { Issue.record("start po świeżej liście powinien przejść: \(after)") }
    #expect(base.read { $0.created.count } == 1)
  }

  @Test("zejście w tło po utracie sieci nie odmładza listy i jej terminu 24 godzin", arguments: [false, true])
  func offlineBackgroundDoesNotRenewCache(reopened: Bool) async throws {
    let clock = VirtualClock()
    let directory = temporaryOutbox()
    let base = FakeTransport()
    let store = cachedStore(transport: base, base: base, directory: directory, clock: { clock.now })
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    await store.flushListCache()
    let original = try #require(await SnapshotCache(directory: directory).load(now: clock.now))
    store.dispatch(.streamDropped(.global))
    clock.advance(by: .seconds(23 * 3600))
    if reopened {
      store.dispatch(.streamOpened(.global, resumedWithCursor: false))
      store.dispatch(.frame(
        try Frames.decode(#"{"type":"hello","protocolVersion":3,"serverStartId":"s2"}"#), source: .global, cursor: nil))
    }
    store.setScenePhase(.background)
    await store.flushListCache()
    let saved = try #require(await SnapshotCache(directory: directory).load(now: clock.now))
    #expect(saved.savedAt == original.savedAt, "bez sieci nie było nowego potwierdzenia")
    clock.advance(by: .seconds(2 * 3600))
    #expect(await SnapshotCache(directory: directory).load(now: clock.now) == nil, "prawdziwy wiek listy przekroczył dobę")
  }
}
