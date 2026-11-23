import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// The queue take-back in the store: the hand-over before the outbox entries leave, refusals, the gesture gate and one
// `operationId` per take-back across retries. Owner: send.

@MainActor
@Suite("store: queue take-back")
struct StoreQueueTakeBackTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  /// An entry accepted with a held echo: the queued bubble.
  private func queued(_ store: RarogStore, _ sessionId: String, _ text: String) -> OutboxEntry {
    let entry = OutboxEntry(sessionId: sessionId, text: text, createdAt: t0)
    store.dispatch(.outboxEnqueued(entry))
    store.dispatch(.outboxQueued(entry.id, at: t0))
    return entry
  }

  private func reply(_ items: [(String, OutboxEntry?)], incomplete: Bool = false) -> String {
    let list = items.map { text, entry in
      entry.map { #"{"text":"\#(text)","clientMessageId":"\#($0.clientMessageId)"}"# } ?? #"{"text":"\#(text)"}"#
    }
    return #"{"items":[\#(list.joined(separator: ","))]\#(incomplete ? #","incomplete":true"# : "")}"#
  }

  @Test("200: the hand-over runs while the entries still stand, then the named entries leave and the others stay")
  func handOverBeforeRemoval() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running"), Frames.summary("s2", state: "running")])
    let first = queued(store, "s1", "A")
    let second = queued(store, "s1", "B")
    let unnamed = queued(store, "s1", "C")
    let other = queued(store, "s2", "D")
    probe.set { $0.takeBackResults = [.success(reply([("A", first), ("B", second), ("Typed at the Mac", nil)], incomplete: true))] }
    #expect(store.state.hasQueuedBubble("s1"))
    var handed: QueueTakeBackResponse?
    var outboxAtHandOver: [UUID] = []
    let outcome = await store.takeBackQueue("s1") { response in
      handed = response
      outboxAtHandOver = store.state.outbox.map(\.id)
      return true
    }
    #expect(handed?.items.map(\.text) == ["A", "B", "Typed at the Mac"])
    #expect(handed?.incomplete == true)
    #expect(Set(outboxAtHandOver) == [first.id, second.id, unnamed.id, other.id], "nothing left before the hand-over")
    #expect(store.state.outbox.map(\.id) == [unnamed.id, other.id], "only the named entries of this session leave")
    guard case .taken = outcome else { Issue.record("outcome \(outcome)"); return }
    #expect(!store.state.isTakingBackQueue("s1"))
    #expect(store.state.queueTakeBack.operations.isEmpty, "a definitive answer drops the id")
  }

  @Test("refusal 409 and 404: entries stay, no hand-over; 404 is a server without the route")
  func refusals() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let entry = queued(store, "s1", "A")
    let sentence = "A dialog stands in the terminal. Answer it, then take the queue back."
    probe.set {
      $0.takeBackResults = [
        .failure(.http(APIFailure(status: 409, code: "bad-state", message: sentence))),
        .failure(.http(APIFailure(status: 404))),
      ]
    }
    var handOvers = 0
    #expect(await store.takeBackQueue("s1") { _ in handOvers += 1; return true } == .refused(sentence))
    #expect(await store.takeBackQueue("s1") { _ in handOvers += 1; return true } == .serverTooOld)
    #expect(handOvers == 0)
    #expect(store.state.outbox.map(\.id) == [entry.id])
    #expect(store.state.queueTakeBack.operations.isEmpty, "the server freed the id of a refusal")
    let ids = probe.read { $0.takeBacks.map(\.operationId) }
    #expect(ids.count == 2 && ids[0] != ids[1], "after a refusal the next gesture is a new take-back")
  }

  @Test("a second gesture while the request is in flight sends nothing")
  func secondGestureInFlight() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    _ = queued(store, "s1", "A")
    let gate = AsyncStream<Void>.makeStream()
    probe.set { $0.onTakeBack = { _ in for await _ in gate.stream { return } } }
    let first = Task { await store.takeBackQueue("s1") { _ in true } }
    await until("in flight") { store.state.isTakingBackQueue("s1") && probe.read(\.takeBacks).count == 1 }
    #expect(await store.takeBackQueue("s1") { _ in true } == .inFlight)
    gate.continuation.yield()
    guard case .taken = await first.value else { Issue.record("first gesture"); return }
    #expect(probe.read(\.takeBacks).count == 1)
  }

  @Test("the start is synchronous: in flight before any request; a second start and a start after logout are ignored")
  func synchronousStart() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    _ = queued(store, "s1", "A")
    let ticket = try #require(store.startTakeBack("s1"))
    #expect(store.state.isTakingBackQueue("s1"), "the screen sees the take-back in the gesture's own turn")
    #expect(probe.read(\.takeBacks).isEmpty, "nothing went out yet")
    #expect(store.startTakeBack("s1") == nil, "a second gesture while one is in flight is ignored")
    guard case .taken = await store.finishTakeBack(ticket, handOver: { _ in true }) else {
      Issue.record("finish")
      return
    }
    #expect(probe.read(\.takeBacks).count == 1)
    #expect(!store.state.isTakingBackQueue("s1"))

    _ = queued(store, "s1", "B")
    let stale = try #require(store.startTakeBack("s1"))
    store.handleUnauthorized()
    #expect(store.startTakeBack("s1") == nil, "logged out: ignored")
    store.enterLoggedIn()
    #expect(await store.finishTakeBack(stale, handOver: { _ in true }) == .loggedOut)
    #expect(probe.read(\.takeBacks).count == 1, "a ticket of the old login sends nothing")
  }

  @Test("network failure: one retry with the same id; without an answer the next gesture reuses it; 200 drops it")
  func sameOperationAcrossRetries() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let entry = queued(store, "s1", "A")
    probe.set {
      $0.takeBackResults = [
        .failure(.timedOut), .failure(.offline(.networkConnectionLost)),
        .failure(.timedOut), .success(reply([("A", entry)])),
        .success(reply([])),
      ]
    }
    #expect(await store.takeBackQueue("s1") { _ in true } == .unsure)
    #expect(store.state.outbox.map(\.id) == [entry.id], "no answer: the bubble stays")
    var handed: [String] = []
    guard case .taken = await store.takeBackQueue("s1", handOver: { handed = $0.items.map(\.text); return true }) else {
      Issue.record("second gesture")
      return
    }
    #expect(handed == ["A"])
    #expect(store.state.outbox.isEmpty)
    guard case .taken = await store.takeBackQueue("s1", handOver: { _ in true }) else {
      Issue.record("third gesture")
      return
    }
    let ids = probe.read { $0.takeBacks.map(\.operationId) }
    #expect(ids.count == 5)
    #expect(Set(ids.prefix(4)).count == 1, "the retry and the next gesture carry the same operationId")
    #expect(ids[4] != ids[0], "a take-back after a 200 is a new one")
  }

  @Test("a refusal that does not come from the route (the app's gate, 403, 429) keeps an id without an answer")
  func gateRefusalKeepsUnresolvedId() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let entry = queued(store, "s1", "A")
    let gate = MutationRefusal(gate: .compatibility, message: "Update the app.")
    probe.set {
      $0.takeBackResults = [
        .failure(.timedOut), .failure(.timedOut),
        .failure(.refused(gate)),
        .failure(.forbidden(APIFailure(status: 403, code: "bad-origin", message: "Origin not allowed."))),
        .failure(.rateLimited(APIFailure(status: 429, code: "too-many-requests", message: "Too many requests."))),
        .success(reply([("A", entry)])),
      ]
    }
    #expect(await store.takeBackQueue("s1") { _ in true } == .unsure)
    let kept = try #require(store.state.queueTakeBack.operations["s1"])
    #expect(await store.takeBackQueue("s1") { _ in true } == .refused("Update the app."))
    #expect(store.state.queueTakeBack.operations["s1"] == kept, "nothing went out: the server may still hold the 200")
    #expect(await store.takeBackQueue("s1") { _ in true } == .refused("Origin not allowed."))
    #expect(await store.takeBackQueue("s1") { _ in true } == .refused("Too many requests."))
    #expect(store.state.queueTakeBack.operations["s1"] == kept, "a gate before the route decides nothing")
    var handed: [String] = []
    guard case .taken = await store.takeBackQueue("s1", handOver: { handed = $0.items.map(\.text); return true }) else {
      Issue.record("replay")
      return
    }
    #expect(handed == ["A"])
    #expect(Set(probe.read { $0.takeBacks.map(\.operationId) }) == [kept], "every request carries the kept id")
  }

  @Test("a gate refusal on the retry keeps the id the first attempt may have delivered; a fresh refused id is not kept")
  func gateRefusalOnRetryKeepsId() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    _ = queued(store, "s1", "A")
    let gate = MutationRefusal(gate: .compatibility, message: "Update the app.")
    probe.set {
      $0.takeBackResults = [
        .failure(.refused(gate)), .failure(.timedOut), .failure(.refused(gate)), .success(reply([])),
      ]
    }
    #expect(await store.takeBackQueue("s1") { _ in true } == .refused("Update the app."))
    #expect(store.state.queueTakeBack.operations.isEmpty, "an id that never went out is not kept")
    #expect(await store.takeBackQueue("s1") { _ in true } == .refused("Update the app."))
    let ids = probe.read { $0.takeBacks.map(\.operationId) }
    #expect(ids.count == 3 && ids[1] == ids[2] && ids[0] != ids[1])
    #expect(store.state.queueTakeBack.operations["s1"] == ids[1], "the timed-out attempt may have reached the server")
    guard case .taken = await store.takeBackQueue("s1", handOver: { _ in true }) else {
      Issue.record("replay")
      return
    }
    #expect(probe.read { $0.takeBacks.last?.operationId } == ids[1])
  }
}
