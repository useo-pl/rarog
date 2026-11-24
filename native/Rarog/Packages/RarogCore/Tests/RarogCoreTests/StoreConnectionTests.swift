import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
@testable import RarogCore
import Testing

@MainActor
@Suite("magazyn: pętla połączenia (SIEC, AUTH)")
struct StoreConnectionTests {
  @Test("bez klucza: ekran parowania, żadnego strumienia; zalogowanie startuje strumień globalny")
  func noCredential() async throws {
    let (store, transport) = makeStore(transport: FakeTransport(credential: false))
    await store.start()
    #expect(store.state.auth == .loggedOut(.notLoggedIn))
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.streamCalls.isEmpty)
    store.enterLoggedIn()
    #expect(store.state.auth == .loggedIn)
    await until("strumień globalny") { transport.streamCalls.first?.scope == .global }
  }

  @Test("start z kluczem: hello + snapshot strumieniem globalnym → lista i zgodność")
  func globalStream() async throws {
    let (store, transport) = makeStore(build: 12)
    await store.start()
    await until("połączenie") { store.state.global == .online }
    try transport.pushGolden(.global, "hello.max.json")
    try transport.pushGolden(.global, "sessions-snapshot.max.json")
    await until("lista") { store.state.sessionsLoaded }
    #expect(store.state.compat == .ok)
    #expect(store.state.sessions.count == 10)
  }

  @Test("a second start in the same process keeps what the store knows about the server, with no second login")
  func secondStartKeepsServerState() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("list") { store.state.sessionsLoaded && store.state.compat == .ok }
    let version = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":["files"]}"#
    store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    let fixture = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/usage.json")
    let usage = try JSONDecoder().decode(PlanUsage.self, from: Data(contentsOf: fixture))
    store.dispatch(.planUsageResult(.loaded(usage), at: Date()))
    #expect(store.fileTree.source("s1") == .files)
    let streams = transport.streamCalls.count

    // The scene root runs its `.task` again each time a full-screen cover over it closes.
    await store.start()
    try await Task.sleep(for: .milliseconds(40))
    #expect(store.state.auth == .loggedIn && store.state.global == .online && store.state.compat == .ok)
    #expect(store.state.filesAvailable)
    #expect(store.state.sessions["s1"] != nil)
    #expect(store.fileTree.source("s1") == .files)
    #expect(store.state.planUsage.usage == usage)
    #expect(transport.streamCalls.count == streams, "no second login: the global stream stays the one it was")
  }

  @Test("401 strumienia: wylogowanie, bez ponawiania")
  func unauthorized() async throws {
    let transport = FakeTransport()
    transport.set { $0.openFailures = [.unauthorized(APIFailure(status: 401))] }
    let (store, _) = makeStore(transport: transport)
    await store.start()
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    try await Task.sleep(for: .milliseconds(80))
    #expect(transport.streamCalls.count == 1)
  }

  @Test("zerwanie bez sieci nie wylogowuje: ponowienie z odstępem, potem online")
  func reconnectAfterDrop() async throws {
    let transport = FakeTransport()
    transport.set { $0.openFailures = [.offline(.notConnectedToInternet), .timedOut] }
    let (store, _) = makeStore(transport: transport)
    await store.start()
    await until("trzecia próba i online") { transport.streamCalls.count == 3 && store.state.global == .online }
    #expect(store.state.auth == .loggedIn)
    // Serwer zamyka strumień — pętla łączy ponownie.
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.end(.global)
    await until("ponowne połączenie") { transport.streamCalls.count == 4 }
  }

  @Test("strumień sesji: tylko dla znanej sesji; kursor wraca jako Last-Event-ID; „…” przy powrocie")
  func sessionStreamCursor() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    store.openSession("herdr-w1-p2")
    try await Task.sleep(for: .milliseconds(30))
    #expect(!transport.streamCalls.contains { $0.scope == .session(id: "herdr-w1-p2") }, "sesja jeszcze nieznana")

    try transport.pushGolden(.global, "sessions-snapshot.max.json")
    await until("strumień sesji po poznaniu sesji") { transport.streamCalls.contains { $0.scope == .session(id: "herdr-w1-p2") } }
    #expect(transport.streamCalls.last?.lastEventId == nil)
    try transport.pushGolden(.session(id: "herdr-w1-p2"), "transcript-snapshot.max.json")
    transport.push(.session(id: "herdr-w1-p2"), json: #"{"type":"delta","sessionId":"herdr-w1-p2","text":"Połowa"}"#)
    transport.push(
      .session(id: "herdr-w1-p2"),
      json: #"{"type":"question-resolved","sessionId":"herdr-w1-p2","qId":"x"}"#, id: "s1:42")
    await until("kursor") { store.state.transcripts["herdr-w1-p2"]?.cursor == "s1:42" }

    transport.end(.session(id: "herdr-w1-p2"), error: .offline(.networkConnectionLost))
    await until("ponowienie z kursorem") {
      transport.streamCalls.last == FakeTransport.StreamCall(scope: .session(id: "herdr-w1-p2"), lastEventId: "s1:42")
    }
    await until("„…” w otwartej wiadomości") { store.state.transcripts["herdr-w1-p2"]?.open?.gap == true }
    #expect(store.state.transcripts["herdr-w1-p2"]?.open?.text == "Połowa…")
  }

  @Test("przejście do innej sesji nie przenosi na nią statusu strumienia poprzedniej")
  func sessionSwitchDropsPreviousStatus() async throws {
    let (store, transport) = makeStore()
    await store.start()
    defer { store.setScenePhase(.background) }
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("A")),\#(Frames.summary("B"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    store.openSession("A")
    await until("strumień A") { store.state.sessionStream == .online }
    transport.set { $0.openFailures = Array(repeating: .offline(.notConnectedToInternet), count: 100) }
    transport.end(.session(id: "A"), error: .offline(.networkConnectionLost))
    await until("A w ponowieniach") {
      if case .offline = store.state.sessionStream { true } else { false }
    }
    store.openSession("B")
    #expect(store.state.sessionStream == .idle, "awaria A nie należy do B, zanim pętla B coś zgłosi")
  }

  @Test("404 strumienia sesji: koniec pętli bez ponawiania")
  func sessionGone() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    try transport.pushGolden(.global, "sessions-snapshot.max.json")
    await until("lista") { store.state.sessionsLoaded }
    transport.set { $0.openFailures = [.http(APIFailure(status: 404, code: "not-found"))] }
    store.openSession("herdr-w1-p1")
    await until("stop strumienia sesji") {
      transport.streamCalls.contains { $0.scope == .session(id: "herdr-w1-p1") } && store.state.sessionStream == .idle
    }
    try await Task.sleep(for: .milliseconds(80))
    #expect(transport.streamCalls.filter { $0.scope == .session(id: "herdr-w1-p1") }.count == 1)
  }

  @Test("tło zamyka strumienie i melduje `visible: false`; powrót otwiera świeże połączenie")
  func scenePhases() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    store.setScenePhase(.background)
    #expect(store.state.global == .idle)
    await until("obecność false") { transport.read { $0.presence.last?.visible == false } }
    let calls = transport.streamCalls.count
    store.setScenePhase(.active)
    await until("świeże połączenie") { transport.streamCalls.count == calls + 1 && store.state.global == .online }
    await until("obecność true") { transport.read { $0.presence.last?.visible == true } }
  }

  @Test("obecność: przy widocznej apce cyklicznie, z otwartą sesją w polu `sessionId`")
  func presence() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("dwa meldunki") { transport.read { $0.presence.count } >= 2 }
    store.openSession("s1")
    await until("sesja w obecności") { transport.read { $0.presence.last?.sessionId } == "s1" }
    let ids = Set(transport.read { $0.presence.map(\.clientId) })
    #expect(ids == [store.clientId])
  }

  @Test("raport `kontrakt:` po otwarciu strumienia: degradacja i odrzucenie, bez duplikatów")
  func contractReport() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    try transport.pushGolden(.global, "sessions-snapshot.unknown-state.json")
    try transport.pushGolden(.global, "sessions-snapshot.unknown-state.json")
    try transport.pushGolden(.global, "x-future.unknown-type.json")
    await until("dwie linie w logu") {
      transport.read { $0.clientLogs.flatMap(\.events).count } == 2
    }
    let lines = transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }
    #expect(Set(lines) == ["kontrakt: /sessions/state=paused", "kontrakt: odrzucona x-future"])
    #expect(transport.read { $0.clientLogs.flatMap(\.events).allSatisfy { $0.level == "debug" } })
  }

  @Test("nieobsłużony błąd apki: przed zalogowaniem czeka, potem jedna linia `błąd:` z poziomem error")
  func unhandledReport() async throws {
    let (store, transport) = makeStore(transport: FakeTransport(credential: false))
    await store.start()
    store.reportUnhandled("awaria poprzedniego uruchomienia:\nsygnał 11")
    store.reportUnhandled("awaria poprzedniego uruchomienia:\nsygnał 11")
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.read { $0.clientLogs.isEmpty }, "przed zalogowaniem nic nie wychodzi")
    store.enterLoggedIn()
    await until("linia w logu") { transport.read { $0.clientLogs.flatMap(\.events).count } == 1 }
    let event = try #require(transport.read { $0.clientLogs.flatMap(\.events).first })
    #expect(event.msg == "błąd: awaria poprzedniego uruchomienia: sygnał 11")
    #expect(event.level == "error")
  }

  @Test("powrót `background → inactive → active` (zwykły na iOS) wznawia OBA strumienie")
  func returnThroughInactive() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    try transport.pushGolden(.global, "sessions-snapshot.max.json")
    store.openSession("herdr-w1-p2")
    await until("strumień sesji") { store.state.sessionStream == .online }
    store.setScenePhase(.background)
    #expect(store.state.global == .idle && store.state.sessionStream == .idle)
    let calls = transport.streamCalls.count
    store.setScenePhase(.inactive)
    // Back from the background as `inactive`, the streams stay stopped until `active` (the tunnel also leaves its
    // background grace only on `active`); the connection card covers that gap in the UI.
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.streamCalls.count == calls && store.state.global == .idle && store.state.sessionStream == .idle)
    store.setScenePhase(.active)
    await until("oba strumienie wstały") {
      transport.streamCalls.count == calls + 2 && store.state.global == .online && store.state.sessionStream == .online
    }
    let resumed = transport.streamCalls.suffix(2).map(\.scope)
    #expect(resumed.contains(.global) && resumed.contains(.session(id: "herdr-w1-p2")))
    // Wznowienie w `inactive` (zmiana sieci) nie dubluje się przy wejściu w `active`.
    store.setScenePhase(.background)
    store.setScenePhase(.inactive)
    store.reconnectNow()
    await until("wznowione w inactive") { transport.streamCalls.count == calls + 4 }
    store.setScenePhase(.active)
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.streamCalls.count == calls + 4)
    // `inactive → active` bez tła (np. Centrum sterowania) nie zrywa żywych strumieni.
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    try await Task.sleep(for: .milliseconds(40))
    #expect(transport.streamCalls.count == calls + 4)
  }
}
