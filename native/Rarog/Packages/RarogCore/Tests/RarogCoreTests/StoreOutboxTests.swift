import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

/// Magazyn zalogowany, z listą jednej sesji i jej transkryptem, po `hello` (zgodność `ok`).
@MainActor
func readyStore(
  transport: FakeTransport = FakeTransport(), outbox: URL = temporaryOutbox(), state: String = "waiting-input",
  hello: String = #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#
) async throws -> (RarogStore, FakeTransport) {
  let (store, transport) = makeStore(transport: transport, outbox: outbox)
  await store.start()
  await until("online") { store.state.global == .online }
  transport.push(.global, json: hello)
  transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: state))]}"#)
  await until("lista") { store.state.sessionsLoaded }
  store.openSession("s1")
  await until("strumień sesji") { transport.streamCalls.contains { $0.scope == .session(id: "s1") } }
  let card = Frames.permission("s1", permId: "p1")
  transport.push(.session(id: "s1"), json: #"""
    {"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[\#(card)],"pendingQuestions":[]}
    """#)
  await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
  return (store, transport)
}

private func files(_ directory: URL) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
}

@MainActor
@Suite("magazyn: trwała kolejka wysyłki (WYS)")
struct StoreOutboxTests {
  @Test("wpis na dysku PRZED żądaniem; 202 → sent; echo → zniknął z dysku i z kolejki")
  func sentThenEchoed() async throws {
    let outbox = temporaryOutbox()
    let transport = FakeTransport()
    transport.set { state in
      state.onSend = { _, _ in
        let names = (try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? []
        #expect(names.count == 1, "wpis musi leżeć na dysku przed pierwszym bajtem")
      }
    }
    let (store, _) = try await readyStore(transport: transport, outbox: outbox)
    let outcome = await store.send(text: "  zrób testy \n", to: "s1")
    guard case let .accepted(id) = outcome else {
      Issue.record("oczekiwano accepted, jest \(outcome)")
      return
    }
    #expect(transport.read { $0.messages.map(\.body.text) } == ["zrób testy"])
    #expect(store.state.outbox.first?.state.isSent == true)

    transport.push(.session(id: "s1"), json: #"""
      {"type":"message","sessionId":"s1","message":{"seq":3,"role":"user",
      "blocks":[{"type":"text","text":"zrób testy"}],"at":"\#(ISOTime.string(Date()))"}}
      """#, id: "s:3")
    await until("echo") { store.state.echoed[id] == 3 }
    #expect(store.state.outbox.isEmpty)
    await store.flushPersistence()
    #expect(files(outbox).isEmpty)
  }

  @Test("brak echa 15 s od 202 → „Nie potwierdzono” (zapisane na dysku); Ponów wysyła TEN SAM wpis")
  func unconfirmedThenRetry() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    guard case let .accepted(id) = await store.send(text: "raz", to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    await until("unconfirmed") { store.state.outbox.first?.state == .unconfirmed }
    await store.flushPersistence()
    let stored = try JSONDecoder().decode(OutboxEntry.self, from: Data(contentsOf: outbox.appending(path: "\(id.uuidString).json")))
    #expect(stored.state == .unconfirmed)

    #expect(await store.retry(id) == .accepted(id))
    #expect(transport.read { $0.messages.map(\.body.text) } == ["raz", "raz"])
    #expect(store.state.outbox.map(\.id) == [id])
    #expect(await store.retry(id) == .ignored, "wpis w drodze nie ponawia się drugi raz")
  }

  @Test("odmowa serwera z powodem → `refused`; zerwana sieć → `unconfirmed`; Odrzuć zdejmuje z dysku")
  func refusedAndOffline() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .http(APIFailure(status: 429, code: "rate-limited", message: "Za szybko — odczekaj chwilę.")) }
    let refused = await store.send(text: "a", to: "s1")
    guard case let .refused(refusedId, code, message) = refused else {
      Issue.record("brak refused: \(refused)")
      return
    }
    #expect(code == "rate-limited" && message == "Za szybko — odczekaj chwilę.")
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(lostId) = await store.send(text: "b", to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    #expect(store.state.outbox.map(\.state) == [.refused(code: "rate-limited", message: "Za szybko — odczekaj chwilę."), .unconfirmed])
    store.discard(refusedId)
    store.discard(lostId)
    await store.flushPersistence()
    #expect(store.state.outbox.isEmpty)
    #expect(files(outbox).isEmpty)
  }

  @Test("restart apki: wpis „w locie” wraca jako „Nie potwierdzono”, zepsuty plik nie przewraca startu")
  func restoreAfterRestart() async throws {
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let queued = OutboxEntry(sessionId: "s1", text: "w locie", createdAt: Date().addingTimeInterval(-60))
    let sent = OutboxEntry(sessionId: "s1", text: "przyjęta", createdAt: Date().addingTimeInterval(-50),
                           state: .sent(acceptedAt: Date().addingTimeInterval(-40)))
    try await persistence.save(queued)
    try await persistence.save(sent)
    try Data("{zepsuty".utf8).write(to: outbox.appending(path: "zepsuty.json"))

    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    #expect(store.state.outbox.map(\.text) == ["w locie", "przyjęta"])
    #expect(store.state.outbox.map(\.state) == [.unconfirmed, .unconfirmed])
  }

  // `fastTiming`: one second = 10 ms (text 15 s → 150 ms, attachments 120 s → 1200 ms).
  @Test("app restart 30 s after 202: attachment entry stays `.sent`, `.unconfirmed` 120 s after 202; text keeps 15 s")
  func restoreUsesAttachmentDeadline() async throws {
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let photo = OutboxEntry.Attachment(name: "", bytes: 3, kind: .image, mime: "image/jpeg")
    // One base for every 202 time, so file setup before the restart does not shorten the measured wait.
    let base = Date()
    let fresh = OutboxEntry(
      sessionId: "s1", text: "photo 30 s", attachments: [photo], createdAt: base.addingTimeInterval(-0.4),
      state: .sent(acceptedAt: base.addingTimeInterval(-0.3)))
    let stale = OutboxEntry(
      sessionId: "s1", text: "photo 130 s", attachments: [photo], createdAt: base.addingTimeInterval(-1.4),
      state: .sent(acceptedAt: base.addingTimeInterval(-1.3)))
    let text = OutboxEntry(
      sessionId: "s1", text: "text 30 s", createdAt: base.addingTimeInterval(-0.35),
      state: .sent(acceptedAt: base.addingTimeInterval(-0.3)))
    for entry in [fresh, stale] {
      let source = FileManager.default.temporaryDirectory.appending(path: "rarog-core-sources/\(UUID().uuidString).jpg")
      try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data([1, 2, 3]).write(to: source)
      _ = try await persistence.stage(entry, payloads: [source])
    }
    try await persistence.save(text)

    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    let byText = { (name: String) in store.state.outbox.first { $0.text == name }?.state }
    #expect(byText("photo 130 s") == .unconfirmed, "past the attachment deadline at restore")
    #expect(byText("text 30 s") == .unconfirmed, "text keeps the 15 s deadline")
    #expect(byText("photo 30 s")?.isSent == true, "30 s after 202 an attachment entry still waits for the echo")
    await until("unconfirmed") { byText("photo 30 s") == .unconfirmed }
    // 202 was 0.3 s (≙ 30 s) before `base`, so the 1.2 s deadline ends about 0.9 s after it.
    #expect(Date().timeIntervalSince(base) >= 0.85)
  }

  @Test("start agenta: wysyłka i „Ponów” nic nie wysyłają; wpis czeka na `waiting-input`")
  func startingBlocksSendAndRetry() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "raz", to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    transport.set { $0.sendResult = nil }
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "starting"))}"#)
    await until("starting") { store.state.sessions["s1"]?.state == .starting }

    #expect(await store.send(text: "dwa", to: "s1") == .blocked(.starting))
    #expect(await store.retry(id) == .blocked(.starting))
    #expect(transport.read { $0.messages.map(\.body.text) } == ["raz"], "w starcie nic nie wychodzi")
    #expect(store.state.outbox.map(\.state) == [.unconfirmed], "wpis stoi nietknięty")

    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input"))}"#)
    await until("waiting-input") { store.state.sessions["s1"]?.state == .waitingInput }
    #expect(await store.retry(id) == .accepted(id))
    #expect(transport.read { $0.messages.map(\.body.text) } == ["raz", "raz"])
  }

  @Test("start agenta przy herdr tylko do odczytu: „Ponów” dalej nic nie wysyła, choć pole blokuje herdr")
  func startingBlocksRetryBehindHerdrReadOnly() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "raz", to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    transport.set { $0.sendResult = nil }
    transport.push(.global, json: #"{"type":"herdr-status","available":true,"agentCount":1,"readOnly":true}"#)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "starting"))}"#)
    await until("starting za herdr tylko do odczytu") {
      store.state.sessions["s1"]?.state == .starting && store.state.herdr?.readOnly == true
    }
    // Przyczyna pola to herdr, a nie start; „Ponów” patrzy na stan sesji wprost.
    #expect(store.state.sendBlock(for: "s1") == .herdrReadOnly)

    #expect(await store.retry(id) == .blocked(.starting))
    #expect(transport.read { $0.messages.map(\.body.text) } == ["raz"], "w starcie nic nie wychodzi")
    #expect(store.state.outbox.map(\.state) == [.unconfirmed], "wpis stoi nietknięty")
  }

  @Test("pusta wysyłka i pole wygaszone nie trafiają do kolejki")
  func emptyAndBlocked() async throws {
    let (store, transport) = try await readyStore(state: "waiting-permission")
    #expect(await store.send(text: "  \n", to: "s1") == .empty)
    #expect(await store.send(text: "tak", to: "s1") == .blocked(.decisionPending))
    #expect(store.state.outbox.isEmpty)
    #expect(transport.read { $0.messages.isEmpty })
  }
}

@MainActor
@Suite("magazyn: zgodność i bramki mutacji (ZGOD)")
struct StoreCompatibilityTests {
  @Test("przed `hello` mutacja czeka ≤ compatWait, potem odmowa „brak połączenia”")
  func waitsForHello() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    let started = ContinuousClock.now
    let outcome = await store.send(text: "x", to: "s1")
    guard case let .refused(_, _, message) = outcome else {
      Issue.record("brak odmowy: \(outcome)")
      return
    }
    #expect(message == CoreCopy.noConnection)
    #expect(ContinuousClock.now - started >= fastTiming.compatWait)
    #expect(transport.read { $0.messages.isEmpty })
  }

  @Test("`hello` w trakcie czekania wpuszcza mutację od razu")
  func helloReleasesWaiters() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    async let outcome = store.send(text: "x", to: "s1")
    try await Task.sleep(for: .milliseconds(20))
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    guard case .accepted = await outcome else {
      Issue.record("hello nie wpuścił mutacji")
      return
    }
  }

  @Test("apka za stara: mutacje odmówione od razu, obecność i log przechodzą")
  func tooOld() async throws {
    let (store, transport) = try await readyStore(hello: #"{"type":"hello","protocolVersion":3,"serverStartId":"s","minClientBuild":99}"#)
    #expect(store.state.compat == .tooOld(minClientBuild: 99))
    guard case let .refused(_, _, message) = await store.send(text: "x", to: "s1") else {
      Issue.record("brak odmowy")
      return
    }
    #expect(message == CoreCopy.updateApp)
    #expect(await store.decidePermission(sessionId: "s1", permId: "p1", decision: .deny) == .refusedByClient(message: CoreCopy.updateApp))
    await until("obecność mimo niezgodności") { transport.read { !$0.presence.isEmpty } }
  }

  @Test("sesja nieobsługiwana: decyzja i wiadomość nie wychodzą (bramka sesji)")
  func unsupportedSession() async throws {
    let (store, transport) = try await readyStore(state: "paused")
    #expect(store.state.sessions["s1"]?.isUnsupported == true)
    let outcome = await store.decidePermission(sessionId: "s1", permId: "p1", decision: .deny)
    #expect(outcome == .refusedByClient(message: CoreCopy.unsupportedSession))
    #expect(transport.read { $0.decisions.isEmpty })
    #expect(await store.send(text: "x", to: "s1") == .blocked(.unsupported))
  }

  @Test("Ponów: stan `queued` leży na dysku, ZANIM wyjdzie żądanie")
  func retryPersistsBeforeRequest() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .http(APIFailure(status: 429, code: "too-many-requests")) }
    guard case let .refused(id, _, _) = await store.send(text: "raz", to: "s1") else {
      Issue.record("brak refused")
      return
    }
    await store.flushPersistence()
    let file = outbox.appending(path: "\(id.uuidString).json")
    let seen = SeenStates()
    transport.set { state in
      state.sendResult = nil
      state.onSend = { _, _ in
        let entry = try? JSONDecoder().decode(OutboxEntry.self, from: Data(contentsOf: file))
        seen.add(entry?.state)
      }
    }
    #expect(await store.retry(id) == .accepted(id))
    #expect(seen.states == [.queued])
  }

  @Test("Ponów przy odmowie dysku: nic nie wychodzi, wpis zostaje w poprzednim stanie")
  func retryWithoutDisk() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .http(APIFailure(status: 429, code: "too-many-requests")) }
    guard case let .refused(id, _, _) = await store.send(text: "raz", to: "s1") else {
      Issue.record("brak refused")
      return
    }
    await store.flushPersistence()
    // Katalog kolejki zamieniony w plik: każdy zapis pada.
    try FileManager.default.removeItem(at: outbox)
    try Data("nie katalog".utf8).write(to: outbox)
    transport.set { $0.sendResult = nil }
    guard case .notPersisted = await store.retry(id) else {
      Issue.record("oczekiwano notPersisted")
      return
    }
    #expect(transport.read { $0.messages.count } == 1, "ponowienie nie wyszło")
    #expect(store.state.outbox.first?.state == .refused(code: "too-many-requests", message: nil))
  }

  @Test("dwa identyczne teksty: pierwszy z echem, drugi niedostarczony; restart → stare echo nie gasi drugiego")
  func oldEchoAfterRestart() async throws {
    let outbox = temporaryOutbox()
    let (first, transport) = try await readyStore(outbox: outbox)
    guard case let .accepted(confirmed) = await first.send(text: "ok", to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    let echoAt = ISOTime.string(Date())
    let echo = #"{"seq":3,"role":"user","blocks":[{"type":"text","text":"ok"}],"at":"\#(echoAt)"}"#
    transport.push(.session(id: "s1"), json: #"{"type":"message","sessionId":"s1","message":\#(echo)}"#, id: "s:3")
    await until("echo pierwszego") { first.state.echoed[confirmed] == 3 }
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(lost) = await first.send(text: "ok", to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    #expect(first.state.outbox.first?.boundary?.maxSeq == 3)
    await first.flushPersistence()
    first.setScenePhase(.background)

    // Zimny start: transkryptu w pamięci nie ma, snapshot niesie tylko pierwsze echo.
    let second = FakeTransport()
    let (store, _) = makeStore(transport: second, outbox: outbox)
    await store.start()
    await until("online") { store.state.global == .online }
    second.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    second.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    store.openSession("s1")
    await until("strumień sesji") { second.streamCalls.contains { $0.scope == .session(id: "s1") } }
    second.push(.session(id: "s1"), json: #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(echo)],"pendingPermissions":[],"pendingQuestions":[]}
      """#)
    await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
    #expect(store.state.outbox.map(\.id) == [lost], "drugi wpis zostaje")
    #expect(store.state.echoed.isEmpty)
  }
}

/// Stany wpisu widziane przez atrapę w chwili żądania.
final class SeenStates: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [OutboxEntry.State?] = []
  func add(_ state: OutboxEntry.State?) { lock.withLock { values.append(state) } }
  var states: [OutboxEntry.State?] { lock.withLock { values } }
}
