import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// Pamięć podręczna listy: plik, reduktor, bramki nieświeżości i magazyn. Właściciel: łączność.

private func summary(_ id: String, state: String = "waiting-input", extra: String = "") throws -> SessionSummary {
  try JSONDecoder().decode(SessionSummary.self, from: Data(Frames.summary(id, state: state, extra: extra).utf8))
}

private func temporaryCache() -> URL {
  FileManager.default.temporaryDirectory.appending(path: "rarog-cache-tests/\(UUID().uuidString)", directoryHint: .isDirectory)
}

@Suite("pamięć podręczna listy: plik")
struct ListCacheFileTests {
  let now = Date(timeIntervalSince1970: 1_790_000_000)

  @Test("zapis zdejmuje treść decyzji, ekranu i zadań; odczyt oddaje resztę listy w kolejności")
  func scrubAndRoundTrip() throws {
    let rich = try summary("s1", state: "waiting-permission", extra: #"""
      ,"label":"zapis notatek","stateDetail":"Error: tajne","lastSummary":"Zrobione: sekret",
      "herdrDialog":"trust","herdrDialogScreen":"$ rm -rf /","cliDialog":"sandbox",
      "waitingFor":{"kind":"permission","tool":"Shell","text":"npm test"},
      "activity":{"kind":"tool","toolName":"Shell","summary":"cat ~/.ssh"},
      "backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test","description":"testy","summary":"ok"}]
      """#)
    let plain = try summary("s2", state: "running")
    let data = try #require(SnapshotCacheFile.encode([rich, plain], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for secret in ["tajne", "sekret", "rm -rf", "npm test", ".ssh", "pnpm test", "testy", "trust", "waitingFor", "cliDialog"] {
      #expect(!text.contains(secret), "na dysku nie ma prawa leżeć: \(secret)")
    }
    let list = try #require(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(60)))
    #expect(list.savedAt == now)
    #expect(list.sessions.map(\.id) == ["s1", "s2"])
    #expect(list.sessions[0].label == "zapis notatek" && list.sessions[0].state == .waitingPermission)
    #expect(list.sessions[0].backgroundTasks?.map(\.id) == ["t1"], "zadanie zostaje (ton pracy), bez opisu i komendy")
  }

  @Test("subagent w postoju: treść jego własnych komend nie idzie na dysk; od kiedy stoi i na co czeka — zostaje")
  func scrubOwnTasks() throws {
    let session = try summary("s1", extra: #"""
      ,"backgroundTasks":[{"id":"a1","kind":"agent","description":"przegląd logu","startedAt":"2026-10-10T07:00:00.000Z",
      "waitingSince":"2026-10-10T07:30:00.000Z","ownTasks":[
        {"id":"b1","command":"until grep -q HASLO wynik.log; do sleep 5; done","startedAt":"2026-10-10T07:10:00.000Z"},
        {"id":"b2","command":"tail -f wynik.log"},{"id":"b3"}]}]
      """#)
    let data = try #require(SnapshotCacheFile.encode([session], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for secret in ["HASLO", "grep", "tail -f", "wynik.log", "przegląd logu", "command"] {
      #expect(!text.contains(secret), "na dysku nie ma prawa leżeć: \(secret)")
    }
    let list = try #require(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(60)))
    let task = try #require(list.sessions.first?.backgroundTasks?.first)
    #expect(task.id == "a1" && task.startedAt == "2026-10-10T07:00:00.000Z")
    #expect(task.waitingSince == "2026-10-10T07:30:00.000Z", "od kiedy agent stoi to fakt bez treści")
    #expect(task.ownTasks?.map(\.id) == ["b1", "b2", "b3"], "liczba i identyfikatory własnych komend zostają")
    #expect(task.ownTasks?.allSatisfy { $0.command == nil } == true)
    #expect(task.ownTasks?.first?.startedAt == "2026-10-10T07:10:00.000Z")
    // Zadanie bez własnych komend zostaje bez pola: `scrub` nie dopisuje pustej listy.
    let plain = try summary("s2", extra: #","backgroundTasks":[{"id":"a2","kind":"agent"}]"#)
    #expect(SnapshotCacheFile.scrub(plain).backgroundTasks?.first?.ownTasks == nil)
  }

  @Test("artefakty sesji nie idą na dysk: tytuł to tekst agenta, adres prowadzi do strony konta")
  func scrubArtifacts() throws {
    let session = try summary("s1", extra: #"""
      ,"artifacts":[
        {"url":"https://claude.ai/artifact/ArtefaktTestowyH000001","title":"Tajny raport","publishedAt":"2026-10-10T07:00:00.000Z"},
        {"url":"https://claude.ai/artifact/ArtefaktTestowyB000002","title":"Szkic","publishedAt":"2026-10-09T07:00:00.000Z","gone":true}]
      """#)
    #expect(session.artifacts?.map(\.gone) == [false, true], "dekoder zna pole")
    let data = try #require(SnapshotCacheFile.encode([session], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for secret in ["Tajny raport", "Szkic", "claude.ai", "ArtefaktTestowyH000001", "artifacts"] {
      #expect(!text.contains(secret), "na dysku nie ma prawa leżeć: \(secret)")
    }
    let list = try #require(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(60)))
    #expect(list.sessions.first?.id == "s1")
    #expect(list.sessions.first?.artifacts == nil, "sekcja wraca z pierwszą ramką strumienia")
  }

  @Test("pull requesty sesji nie idą na dysk: tytuł to tekst agenta, adres zdradza prywatne repo")
  func scrubPullRequests() throws {
    let session = try summary("s1", extra: #"""
      ,"pullRequests":[
        {"url":"https://github.com/tajna-firma/tajne-repo/pull/42","repo":"tajna-firma/tajne-repo","number":42,
         "createdAt":"2026-11-10T07:00:00.000Z","title":"Tajna poprawka"},
        {"url":"https://github.com/tajna-firma/tajne-repo/pull/41","repo":"tajna-firma/tajne-repo","number":41,
         "createdAt":"2026-11-09T07:00:00.000Z"}]
      """#)
    #expect(session.pullRequests?.map(\.number) == [42, 41], "dekoder zna pole")
    #expect(session.pullRequests?.map(\.title) == ["Tajna poprawka", nil])
    let data = try #require(SnapshotCacheFile.encode([session], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for secret in ["Tajna poprawka", "tajna-firma", "tajne-repo", "github.com", "pullRequests"] {
      #expect(!text.contains(secret), "na dysku nie ma prawa leżeć: \(secret)")
    }
    let list = try #require(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(60)))
    #expect(list.sessions.first?.id == "s1")
    #expect(list.sessions.first?.pullRequests == nil, "sekcja wraca z pierwszą ramką strumienia")
  }

  @Test("scheduled tasks stay off the disk: the prompt is text the session will run later")
  func scrubScheduledTasks() throws {
    let session = try summary("s1", extra: #"""
      ,"scheduledTasks":[
        {"id":"9bc70ce1","cron":"*/30 * * * *","recurring":true,"prompt":"Rotate the staging certificate",
         "createdAt":"2026-11-19T21:00:00.000Z","expiresAt":"2026-11-26T21:00:00.000Z"},
        {"id":"bac11b20","cron":"13 22 19 11 *","recurring":false,"prompt":"Ping the private channel"}]
      """#)
    #expect(session.scheduledTasks?.map(\.id) == ["9bc70ce1", "bac11b20"], "the decoder knows the field")
    let data = try #require(SnapshotCacheFile.encode([session], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for content in ["Rotate the staging certificate", "Ping the private channel", "9bc70ce1", "scheduledTasks"] {
      #expect(!text.contains(content), "must not be on the disk: \(content)")
    }
    let list = try #require(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(60)))
    #expect(list.sessions.first?.id == "s1")
    #expect(list.sessions.first?.scheduledTasks == nil, "the section comes back with the first stream frame")
  }

  @Test("nieważny: inna wersja formatu, inny protokół, starszy albo „z przyszłości” niż doba, śmieć")
  func rejects() throws {
    let data = try #require(SnapshotCacheFile.encode([try summary("s1")], savedAt: now))
    #expect(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(24 * 3600)) != nil)
    #expect(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(24 * 3600 + 1)) == nil)
    #expect(SnapshotCacheFile.decode(data, now: now.addingTimeInterval(-(24 * 3600 + 1))) == nil)
    var object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["version"] = 2
    #expect(SnapshotCacheFile.decode(try JSONSerialization.data(withJSONObject: object), now: now) == nil)
    object["version"] = 1
    object["protocolVersion"] = 4
    #expect(SnapshotCacheFile.decode(try JSONSerialization.data(withJSONObject: object), now: now) == nil)
    object["protocolVersion"] = 3
    object["sessions"] = [["id": "s1"]]
    #expect(SnapshotCacheFile.decode(try JSONSerialization.data(withJSONObject: object), now: now) == nil, "uszkodzony kształt")
    #expect(SnapshotCacheFile.decode(Data("nie json".utf8), now: now) == nil)
  }

  @Test("za duża lista traci sesje od końca (najmniej pilne), mieści się w suficie")
  func trims() throws {
    let sessions = try (0..<40).map { try summary("s\($0)") }
    let full = try #require(SnapshotCacheFile.encode(sessions, savedAt: now))
    let ceiling = full.count / 2
    let trimmed = try #require(SnapshotCacheFile.encode(sessions, savedAt: now, maxBytes: ceiling))
    #expect(trimmed.count <= ceiling)
    let list = try #require(SnapshotCacheFile.decode(trimmed, now: now))
    #expect(!list.sessions.isEmpty && list.sessions.count < 40)
    #expect(list.sessions.map(\.id) == sessions.prefix(list.sessions.count).map(\.id))
  }

  @Test("dysk: zapis i odczyt, plik za stary znika przy odczycie, `clear` kasuje")
  func disk() async throws {
    let cache = SnapshotCache(directory: temporaryCache())
    #expect(await cache.load(now: now) == nil)
    #expect(await cache.save([try summary("s1")], at: now))
    #expect(await cache.load(now: now)?.sessions.map(\.id) == ["s1"])
    #expect(await cache.load(now: now.addingTimeInterval(25 * 3600)) == nil)
    #expect(!FileManager.default.fileExists(atPath: cache.fileURL.path), "nieważny plik nie wraca przy każdym starcie")
    #expect(await cache.save([try summary("s1")], at: now))
    await cache.clear()
    #expect(await cache.load(now: now) == nil)
  }

  @Test("`scrub` zdejmuje `stateDetail` razem ze `stateDetailRef`: argumentów zdania nie ma w pliku")
  func scrubStateDetailRef() throws {
    let session = try summary("s1", state: "limit-reached", extra: #"""
      ,"stateDetail":"resetAt=SEKRET-ARG","stateDetailRef":{"code":"state.limit-reached","args":["SEKRET-ARG"]}
      """#)
    #expect(SnapshotCacheFile.scrub(session).stateDetailRef == nil)
    let data = try #require(SnapshotCacheFile.encode([session], savedAt: now))
    let text = String(decoding: data, as: UTF8.self)
    for absent in ["stateDetail", "stateDetailRef", "SEKRET-ARG"] {
      #expect(!text.contains(absent), "na dysku nie ma prawa leżeć: \(absent)")
    }
  }
}

@Suite("pamięć podręczna listy: reduktor i bramki")
struct ListCacheStateTests {
  let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func cachedState(_ sessions: [SessionSummary]) -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: now)
    state.apply(.listCache(.restored(CachedList(sessions: sessions, savedAt: now))), now: now)
    return state
  }

  @Test("lista z pamięci wchodzi tylko przed świeżą listą, tylko zalogowana i niepusta")
  func restoreRules() throws {
    let list = CachedList(sessions: [try summary("s1")], savedAt: now)
    var fresh = AppState(clientBuild: 1)
    fresh.apply(.loggedIn, now: now)
    fresh.apply(.frame(try Frames.snapshot([Frames.summary("s2")]), source: .global, cursor: nil), now: now)
    fresh.apply(.listCache(.restored(list)), now: now)
    #expect(fresh.sessions.keys.sorted() == ["s2"] && !fresh.listStale, "pamięć nigdy nie przykrywa prawdy")

    var loggedOut = AppState(clientBuild: 1)
    loggedOut.apply(.listCache(.restored(list)), now: now)
    #expect(loggedOut.sessions.isEmpty)

    let empty = cachedState([])
    #expect(!empty.sessionsLoaded && !empty.listStale, "pusto z pamięci to „nie wiem”, nie „brak sesji”")
  }

  @Test("świeży `sessions-snapshot` gasi znacznik, podmienia całość i zleca zapis; wylogowanie gasi")
  func freshSnapshot() throws {
    var state = cachedState([try summary("s1"), try summary("s2")])
    #expect(state.listStale && state.sessionsLoaded && state.sessions.count == 2)
    let effects = state.apply(.frame(try Frames.snapshot([Frames.summary("s2")]), source: .global, cursor: nil), now: now)
    #expect(effects == [.persistListCache])
    #expect(!state.listStale && state.sessions.keys.sorted() == ["s2"])

    var expired = cachedState([try summary("s1")])
    #expect(expired.apply(.loggedOut(.deviceUnknown), now: now) == [.clearCaches])
    #expect(!expired.listStale && expired.sessions.isEmpty)
  }

  @Test("zero akcji: bez kart, bez Stopu, bez „Wznów”, bez „obejrzane”, bez „nie znam”")
  func gates() throws {
    var state = cachedState([
      try summary("s1", state: "waiting-permission", extra: #","herdrDialog":"trust","paneId":"p1""#),
      try summary("s2", state: "running", extra: #","paneId":"p2""#),
      try summary("s3", state: "resumable"),
      try summary("s4", state: "waiting-input"),
    ])
    state.global = .online
    state.compat = .ok
    state.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(!state.herdrDialogShown(for: "s1"))
    #expect(state.interruptAvailability(for: "s2") == .hidden)
    #expect(!state.canResume("s3"))
    #expect(state.seenTarget("s4") == nil)
    #expect(state.transcriptPhase(for: "nieznana") == .loading)

    state.apply(.frame(try Frames.snapshot([
      Frames.summary("s1", state: "waiting-permission", extra: #","herdrDialog":"trust","paneId":"p1""#),
      Frames.summary("s2", state: "running", extra: #","paneId":"p2""#),
      Frames.summary("s3", state: "resumable"), Frames.summary("s4", state: "waiting-input"),
    ]), source: .global, cursor: nil), now: now)
    #expect(state.herdrDialogShown(for: "s1"))
    #expect(state.interruptAvailability(for: "s2") == .hidden)
    #expect(!state.canResume("s3") && state.seenTarget("s4") == nil)
    for id in ["s2", "s3", "s4"] {
      state.apply(.frame(try Frames.transcript(id), source: .session(id), cursor: nil), now: now)
    }
    #expect(state.interruptAvailability(for: "s2") == .enabled)
    #expect(state.canResume("s3") && state.seenTarget("s4") != nil)
    #expect(state.transcriptPhase(for: "nieznana") == .unknownSession)
  }

  /// Catches the screen sending a person's receipt over the voice agent's pick-up from a cached list: the list does
  /// not know whether that result still stands.
  @Test("a result the voice agent picked up: no receipt from a cached list, one target after the fresh list")
  func pickedUpResultWaitsForFreshList() throws {
    let picked = #","seen":true,"seenBy":"voice-agent""#
    var state = cachedState([try summary("s1", extra: picked)])
    state.global = .online
    state.compat = .ok
    #expect(state.seenTarget("s1") == nil)
    state.apply(.frame(try Frames.snapshot([Frames.summary("s1", state: "waiting-input", extra: picked)]),
                       source: .global, cursor: nil), now: now)
    state.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(state.seenTarget("s1") == "2026-10-03T08:00:00.000Z")
  }
}

@MainActor
@Suite("pamięć podręczna listy: magazyn")
struct ListCacheStoreTests {
  private func makeCachedStore(
    cache: URL, transport: FakeTransport = FakeTransport(), clock: @escaping @Sendable () -> Date = { Date() },
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .pl)
  ) -> RarogStore {
    let rules = MutationRules(timing: fastTiming)
    transport.gate = MutationGate(policy: rules)
    return RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
      clock: clock, listCacheDirectory: cache, renderer: renderer)
  }

  @Test("pamięć trzyma tekst przetłumaczony: po zmianie języka `sesja 3` do pierwszej świeżej listy, potem `session 3`")
  func translatedTextAcrossLanguages() async throws {
    let directory = temporaryCache()
    let summary = Frames.summary(
      "s3", label: "session 3", extra: #","labelRef":{"code":"session.fallback-label","args":["3"]}"#)
    let polishTransport = FakeTransport()
    let polishStore = makeCachedStore(cache: directory, transport: polishTransport)
    await polishStore.start()
    await until("online") { polishStore.state.global == .online }
    polishTransport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(summary)]}"#)
    await until("lista") { polishStore.state.sessionsLoaded }
    #expect(polishStore.state.sessions["s3"]?.label == "sesja 3")
    await polishStore.flushListCache()
    let saved = try #require(await SnapshotCache(directory: directory).load(now: Date()))
    #expect(saved.sessions.first?.label == "sesja 3", "na dysku tekst przetłumaczony")
    #expect(saved.sessions.first?.labelRef == SentenceRef(code: "session.fallback-label", args: ["3"]))
    polishStore.setScenePhase(.background)

    let englishTransport = FakeTransport()
    let englishStore = makeCachedStore(
      cache: directory, transport: englishTransport, renderer: ServerText.renderer(language: .en))
    await englishStore.start()
    #expect(englishStore.state.listStale)
    #expect(englishStore.state.sessions["s3"]?.label == "sesja 3", "pamięć w poprzednim języku, jak `lastSummary`")
    await until("online") { englishStore.state.global == .online }
    englishTransport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(summary)]}"#)
    await until("świeża lista") { !englishStore.state.listStale }
    #expect(englishStore.state.sessions["s3"]?.label == "session 3")
  }

  @Test("zimny start z kluczem: lista z pamięci od pierwszej klatki, bez strumienia sesji do świeżej listy")
  func coldStart() async throws {
    let directory = temporaryCache()
    let savedAt = Date().addingTimeInterval(-600)
    #expect(await SnapshotCache(directory: directory).save([try summary("s1"), try summary("s2")], at: savedAt))
    let transport = FakeTransport()
    let store = makeCachedStore(cache: directory, transport: transport)
    await store.start()
    #expect(store.state.listStale && store.state.sessions.count == 2, "lista od razu, nie szkielet")
    store.openSession("s1")
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    try await Task.sleep(for: .milliseconds(40))
    #expect(!transport.streamCalls.contains { $0.scope == .session(id: "s1") }, "transkrypt dopiero po świeżej liście")

    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("świeża lista") { !store.state.listStale }
    #expect(store.state.sessions.keys.sorted() == ["s1"])
    await until("strumień sesji") { transport.streamCalls.contains { $0.scope == .session(id: "s1") } }
    await store.flushListCache()
    let saved = try #require(await SnapshotCache(directory: directory).load(now: Date()))
    #expect(saved.sessions.map(\.id) == ["s1"] && saved.savedAt > savedAt, "świeża lista zastępuje plik")
  }

  @Test("mutacja na liście z pamięci czeka na świeży stan; bez niego odmowa „brak połączenia”")
  func mutationWaits() async throws {
    let directory = temporaryCache()
    #expect(await SnapshotCache(directory: directory).save([try summary("s1")], at: Date()))
    let transport = FakeTransport()
    let store = makeCachedStore(cache: directory, transport: transport)
    await store.start()
    store.openSession("s1")
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    await until("zgodność") { store.state.compat == .ok }

    let refused = await store.send(text: "bez świeżej listy", to: "s1")
    guard case let .refused(_, _, message) = refused else {
      Issue.record("oczekiwana odmowa, jest \(refused)")
      return
    }
    #expect(message == CoreCopy.noConnection)
    #expect(transport.read { $0.messages.isEmpty })

    let pending = Task { await store.send(text: "po świeżej liście", to: "s1") }
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.read { $0.messages.isEmpty }, "czeka w bramce")
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    let outcome = await pending.value
    if case .refused = outcome {} else { Issue.record("do transkryptu wysyłka powinna być odmówiona: \(outcome)") }
    await until("strumień sesji") { transport.streamCalls.contains { $0.scope == .session(id: "s1") } }
    transport.push(.session(id: "s1"), json: #"{"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[],"pendingQuestions":[]}"#)
    await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
    let afterTranscript = await store.send(text: "po świeżym transkrypcie", to: "s1")
    if case .accepted = afterTranscript {} else { Issue.record("wysyłka po transkrypcie powinna przejść: \(afterTranscript)") }
    #expect(transport.read { $0.messages.map { $0.body.text } } == ["po świeżym transkrypcie"])
  }

  @Test("401 kasuje plik; start bez klucza go nie pokazuje, ale zostawia; lista z pamięci nie jest przestemplowana")
  func clearAndNoRestamp() async throws {
    let directory = temporaryCache()
    // Pełne sekundy: plik niesie czas ISO z milisekundami.
    let savedAt = Date(timeIntervalSince1970: (Date().timeIntervalSince1970 - 3600).rounded(.down))
    #expect(await SnapshotCache(directory: directory).save([try summary("s1")], at: savedAt))
    let transport = FakeTransport()
    let store = makeCachedStore(cache: directory, transport: transport)
    await store.start()
    store.setScenePhase(.background)
    await store.flushListCache()
    #expect(await SnapshotCache(directory: directory).load(now: Date())?.savedAt == savedAt)

    store.setScenePhase(.active)
    await until("online") { store.state.global == .online }
    transport.set { $0.openFailures = [.unauthorized(APIFailure(status: 401))] }
    transport.end(.global, error: .offline(.networkConnectionLost))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    await store.flushListCache()
    #expect(!FileManager.default.fileExists(atPath: directory.appending(path: "sessions.json").path))

    #expect(await SnapshotCache(directory: directory).save([try summary("s1")], at: Date()))
    let anonymous = makeCachedStore(cache: directory, transport: FakeTransport(credential: false))
    await anonymous.start()
    await anonymous.flushListCache()
    #expect(anonymous.state.sessions.isEmpty, "bez klucza lista z pliku nie trafia na ekran")
    // Plik należy do serwera przestrzeni: wraca przy parowaniu z nim, inny serwer kasuje go `dataWiped`.
    #expect(FileManager.default.fileExists(atPath: directory.appending(path: "sessions.json").path))
  }

  @Test("zejście w tło zapisuje świeżą listę (ostatni znany stan, w kolejności rangi)")
  func backgroundSave() async throws {
    let directory = temporaryCache()
    let transport = FakeTransport()
    let store = makeCachedStore(cache: directory, transport: transport)
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("a", state: "running")),\#(Frames.summary("b", state: "waiting-question"))]}"#)
    await until("lista") { store.state.sessions.count == 2 }
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("a", state: "waiting-permission"))}"#)
    await until("zmiana") { store.state.sessions["a"]?.state == .waitingPermission }
    store.setScenePhase(.background)
    await store.flushListCache()
    let saved = try #require(await SnapshotCache(directory: directory).load(now: Date()))
    #expect(Set(saved.sessions.map(\.id)) == ["a", "b"])
    #expect(saved.sessions.first { $0.id == "a" }?.state == .waitingPermission)
  }
}
