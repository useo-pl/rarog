import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// Echo odroczone: prompt wysłany w trakcie pracy agenta serwer trzyma, aż CLI go weźmie (202 `queued`).
// Wpis kolejki czeka wtedy bez progu 15 s: „Nie potwierdzono” dopiero po 15 s CIĄGŁEJ bezczynności sesji
// bez echa albo po suficie 30 min. Właściciel: wysyłka.

@Suite("reduktor: wpis w kolejce CLI")
struct ReducerQueuedEchoTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
  private let timing = CoreTiming(queuedIdleAfter: .seconds(15), queuedUnconfirmedAfter: .seconds(1800))

  private func state(_ sessionState: String = "running") throws -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: t0)
    state.apply(.frame(try Frames.snapshot([Frames.summary("s1", state: sessionState)]), source: .global, cursor: nil), now: t0)
    return state
  }

  private func change(_ state: inout AppState, to sessionState: String, at time: Date) throws {
    state.apply(.frame(try Frames.sessionChanged(Frames.summary("s1", state: sessionState)), source: .global, cursor: nil),
                now: time)
  }

  /// Wpis przyjęty z `queued` o `t0`.
  private func queued(_ state: inout AppState) throws -> UUID {
    let entry = OutboxEntry(sessionId: "s1", text: "dopisek", createdAt: t0)
    state.apply(.outboxEnqueued(entry), now: t0)
    state.apply(.outboxQueued(entry.id, at: t0), now: t0, timing: timing)
    return entry.id
  }

  @Test("202 `queued`: wpis `sent` z `queuedAt`, stary licznik 15 s go nie rusza, powtórka nie przesuwa sufitu")
  func queuedEntry() throws {
    var state = try state()
    let id = try queued(&state)
    #expect(state.outbox.first?.isQueued == true)
    #expect(state.outbox.first?.queuedAt == t0)
    state.apply(.outboxUnconfirmedIfStillSent(id), now: t0.addingTimeInterval(20), timing: timing)
    #expect(state.outbox.first?.isQueued == true, "licznik 15 s nie dotyczy wpisu w kolejce CLI")
    state.apply(.outboxQueued(id, at: t0.addingTimeInterval(60)), now: t0.addingTimeInterval(60), timing: timing)
    #expect(state.outbox.first?.queuedAt == t0, "sufit od PIERWSZEGO przyjęcia")
  }

  @Test("okres bezczynności: w turze nic; po wyjściu z tury sprawdzenie, za wcześnie nic, po 15 s „Nie potwierdzono”")
  func idleRule() throws {
    var state = try state()
    let id = try queued(&state)
    #expect(state.syncQueuedIdle(now: t0).isEmpty, "sesja w pracy — okresu nie ma")

    let t1 = t0.addingTimeInterval(30)
    try change(&state, to: "waiting-input", at: t1)
    #expect(state.syncQueuedIdle(now: t1) == [.scheduleQueuedIdleCheck(sessionId: "s1", since: t1)])
    #expect(state.syncQueuedIdle(now: t1.addingTimeInterval(1)).isEmpty, "okres otwiera się raz")

    state.apply(.outboxQueuedIdle(sessionId: "s1", since: t1), now: t1.addingTimeInterval(10), timing: timing)
    #expect(state.outbox.first?.isQueued == true, "za wcześnie")
    let effects = state.apply(.outboxQueuedIdle(sessionId: "s1", since: t1), now: t1.addingTimeInterval(15), timing: timing)
    #expect(state.outbox.first?.state == .unconfirmed)
    #expect(effects.count == 1)
    #expect(state.outbox.first?.id == id)
  }

  @Test("karta decyzji to dalej tura: okres bezczynności się nie otwiera")
  func decisionIsTurn() throws {
    var state = try state()
    _ = try queued(&state)
    let t1 = t0.addingTimeInterval(30)
    try change(&state, to: "waiting-permission", at: t1)
    #expect(state.syncQueuedIdle(now: t1).isEmpty)
    try change(&state, to: "waiting-question", at: t1)
    #expect(state.syncQueuedIdle(now: t1).isEmpty)
    #expect(state.queuedIdleSince.isEmpty)
  }

  @Test("bezczynność → tura → bezczynność: sprawdzenie starego okresu nic nie robi")
  func newIdlePeriod() throws {
    var state = try state()
    _ = try queued(&state)
    let t1 = t0.addingTimeInterval(30)
    try change(&state, to: "waiting-input", at: t1)
    _ = state.syncQueuedIdle(now: t1)
    try change(&state, to: "running", at: t1.addingTimeInterval(5))
    _ = state.syncQueuedIdle(now: t1.addingTimeInterval(5))
    let t2 = t1.addingTimeInterval(10)
    try change(&state, to: "waiting-input", at: t2)
    #expect(state.syncQueuedIdle(now: t2) == [.scheduleQueuedIdleCheck(sessionId: "s1", since: t2)])

    state.apply(.outboxQueuedIdle(sessionId: "s1", since: t1), now: t1.addingTimeInterval(16), timing: timing)
    #expect(state.outbox.first?.isQueued == true, "stary okres się skończył — jego sprawdzenie nie liczy się")
    state.apply(.outboxQueuedIdle(sessionId: "s1", since: t2), now: t2.addingTimeInterval(15), timing: timing)
    #expect(state.outbox.first?.state == .unconfirmed)
  }

  @Test("sufit: wpis w kolejce w trwającej turze kończy jako „Nie potwierdzono” po 30 min od pierwszego przyjęcia")
  func ceiling() throws {
    var state = try state()
    let id = try queued(&state)
    state.apply(.outboxUnconfirmedIfQueued(id), now: t0.addingTimeInterval(1799), timing: timing)
    #expect(state.outbox.first?.isQueued == true)
    state.apply(.outboxUnconfirmedIfQueued(id), now: t0.addingTimeInterval(1800), timing: timing)
    #expect(state.outbox.first?.state == .unconfirmed)
  }

  @Test("Stop: wpis w kolejce CLI dowodzi tury tylko wtedy, gdy sesja w niej jest")
  func stop() throws {
    var state = try state()
    _ = try queued(&state)
    #expect(state.interruptAvailability(for: "s1") == .enabled)
    try change(&state, to: "waiting-input", at: t0.addingTimeInterval(30))
    #expect(state.interruptAvailability(for: "s1") == .hidden, "Esc nad stojącym panelem cofa rozmowę")
  }

  @Test("granica świeżości: najpóźniejszy znany czas, nie czas wiadomości o największym `seq`")
  func boundaryWatermark() throws {
    var state = try state()
    let messages = [
      Frames.messageJSON(seq: 1, role: "assistant", text: "odpowiedź", at: "2026-10-14T10:05:00.000Z"),
      // Wchłonięty prompt odtworzony z pliku: czas WYSYŁKI, wcześniejszy niż poprzednia odpowiedź.
      Frames.messageJSON(seq: 2, role: "user", text: "wchłonięty", at: "2026-10-14T10:00:00.000Z"),
    ]
    state.apply(.frame(try Frames.decode(#"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(messages.joined(separator: ","))],
      "pendingPermissions":[],"pendingQuestions":[]}
      """#), source: .session("s1"), cursor: nil), now: t0)
    let boundary = try #require(state.echoBoundary(for: "s1"))
    #expect(boundary.maxSeq == 2)
    #expect(boundary.lastAt == "2026-10-14T10:05:00.000Z")
  }
}

@MainActor
@Suite("magazyn: wpis w kolejce CLI")
struct StoreQueuedEchoTests {
  @Test("ciało: sam tekst niesie `queueAware: true`, ciało z załącznikiem — nie")
  func body() async throws {
    let (store, transport) = try await readyStore(state: "running")
    _ = await store.send(text: "dopisek", to: "s1")
    #expect(transport.read { $0.messages.last?.body.queueAware } == true)

    let data = Data("treść".utf8)
    let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-core-sources/\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "log.txt")
    try data.write(to: file)
    let attachment = OutgoingAttachment(kind: .file, name: "log.txt", mime: "text/plain", bytes: data.count, file: file)
    _ = await store.send(text: "z plikiem", attachments: [attachment], to: "s1")
    #expect(transport.read { $0.messages.last?.body.queueAware } == nil)
  }

  @Test("202 `queued`: wpis czeka dłużej niż próg 15 s, gaśnie echem z identyfikatorem")
  func waitsForEcho() async throws {
    let (store, transport) = try await readyStore(state: "running")
    transport.set { $0.replyQueued = true }
    guard case let .accepted(id) = await store.send(text: "dopisek", to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    #expect(store.state.outbox.first?.isQueued == true)
    try await Task.sleep(for: fastTiming.unconfirmedAfter + .milliseconds(100))
    #expect(store.state.outbox.first?.isQueued == true, "bez progu 15 s")

    transport.push(.session(id: "s1"), json: #"""
      {"type":"message","sessionId":"s1","message":{"seq":5,"role":"user",
      "blocks":[{"type":"text","text":"dopisek"}],"at":"\#(ISOTime.string(Date()))","clientMessageId":"\#(id.uuidString.lowercased())"}}
      """#)
    await until("echo") { store.state.echoed[id] == 5 }
    #expect(store.state.outbox.isEmpty)
  }

  @Test("sesja wychodzi z tury bez echa → po okresie bezczynności „Nie potwierdzono”")
  func idleToUnconfirmed() async throws {
    let (store, transport) = try await readyStore(state: "running")
    transport.set { $0.replyQueued = true }
    _ = await store.send(text: "dopisek", to: "s1")
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input"))}"#)
    await until("„Nie potwierdzono”") { store.state.outbox.first?.state == .unconfirmed }
  }

  @Test("sufit: sesja w turze, echo nie przychodzi → „Nie potwierdzono” po suficie")
  func ceiling() async throws {
    let (store, transport) = try await readyStore(state: "running")
    transport.set { $0.replyQueued = true }
    _ = await store.send(text: "dopisek", to: "s1")
    try await Task.sleep(for: .milliseconds(300))
    #expect(store.state.outbox.first?.isQueued == true)
    await until("sufit") { store.state.outbox.first?.state == .unconfirmed }
  }

  @Test("zgubione 202, restart serwera, „Ponów” dostaje samo `replayed`: wpis z `queueAware` nie znika")
  func replayedKeepsQueued() async throws {
    let (store, transport) = try await readyStore(state: "running")
    transport.set { $0.sendResult = .timedOut }
    guard case let .unconfirmed(id) = await store.send(text: "dopisek", to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    #expect(store.state.outbox.first?.queueAware == true, "zapisane przed żądaniem")
    #expect(store.state.outbox.first?.queuedAt == nil, "odpowiedź z `queued` zginęła")
    transport.set { state in
      state.sendResult = nil
      state.sendReply = #"{"ok":true,"clientMessageId":"\#(id.uuidString.lowercased())","replayed":true}"#
    }
    #expect(await store.retry(id) == .accepted(id))
    #expect(store.state.outbox.first?.isQueued == true, "czeka na echo po podpisie albo na „Nie potwierdzono”")
  }

  @Test("wpis z załącznikiem (bez `queueAware`) po samym `replayed` gaśnie jak dotąd")
  func replayedAttachmentRemoved() async throws {
    let (store, transport) = try await readyStore(state: "running")
    let data = Data("treść".utf8)
    let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-core-sources/\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "log.txt")
    try data.write(to: file)
    let attachment = OutgoingAttachment(kind: .file, name: "log.txt", mime: "text/plain", bytes: data.count, file: file)
    transport.set { $0.sendResult = .timedOut }
    guard case let .unconfirmed(id) = await store.send(text: "z plikiem", attachments: [attachment], to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    #expect(store.state.outbox.first?.queueAware == nil)
    transport.set { state in
      state.sendResult = nil
      state.sendReply = #"{"ok":true,"clientMessageId":"\#(id.uuidString.lowercased())","replayed":true}"#
    }
    #expect(await store.retry(id) == .accepted(id))
    #expect(store.state.outbox.isEmpty)
  }

  @Test("restart apki: wpis w kolejce nie spada po progu 15 s, tylko po suficie")
  func restore() async throws {
    // A ceiling of 3 s instead of 600 ms: `start()` must finish while the first entry is still under the ceiling,
    // and under a parallel package run it can take more than the 300 ms the shared timing leaves.
    var timing = fastTiming
    timing.queuedUnconfirmedAfter = .seconds(3)
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let acceptedAt = Date().addingTimeInterval(-0.3)
    var entry = OutboxEntry(sessionId: "s1", text: "w kolejce", createdAt: acceptedAt, state: .sent(acceptedAt: acceptedAt))
    entry.queuedAt = acceptedAt
    try await persistence.save(entry)
    // Drugi wpis w kolejce, z sufitem tuż-tuż: jego timer nie może odpalić, zanim kolejka wróci do stanu.
    let nearly = Date().addingTimeInterval(-2.99)
    var second = OutboxEntry(sessionId: "s1", text: "prawie po suficie", createdAt: nearly, state: .sent(acceptedAt: nearly))
    second.queuedAt = nearly
    try await persistence.save(second)

    let (store, _) = makeStore(outbox: outbox, timing: timing)
    await store.start()
    #expect(store.state.outbox.first { $0.text == "w kolejce" }?.isQueued == true,
            "0,3 s po przyjęciu to więcej niż próg 15 s (150 ms) w testach")
    await until("sufit obu") { store.state.outbox.allSatisfy { $0.state == .unconfirmed } }
  }
}
