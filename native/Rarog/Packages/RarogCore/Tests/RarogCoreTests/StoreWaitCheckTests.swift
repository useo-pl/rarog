import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// "Check" next to a subagent that waits long on its own command: one tap sends the main agent one message through
// the outbox, and the guard in the store state keeps a second one from going out for the same wait. Fake:
// `FakeTransport` (the message route through `MutationRules`). Owner: send.

/// Two waits of one subagent: the second is a new standby (a new `waitingSince`), so a new key.
private let key = "agent-a/standby-1"
private let nextKey = "agent-a/standby-2"
private let message = "[Rarog check] Subagent a1 has been in standby, waiting on its own background command(s)."

extension RarogStore {
  fileprivate func check(_ wait: String = key, in sessionId: String = "s1") async -> SendOutcome {
    await checkWait(wait, text: message, in: sessionId)
  }

  fileprivate func status(_ wait: String = key) -> WaitCheckStatus? {
    state.waitCheck(wait, in: "s1")
  }
}

/// The echo of the entry `id` in the open stream of `s1`.
private func echo(_ id: UUID, seq: Int = 1) -> String {
  #"""
  {"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"user",
  "blocks":[{"type":"text","text":"\#(message)"}],"at":"\#(ISOTime.string(Date()))",
  "clientMessageId":"\#(id.uuidString.lowercased())"}}
  """#
}

/// Every byte under the outbox directory (manifests and content files).
private func diskBytes(_ directory: URL) -> String {
  guard let walker = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { return "" }
  var out = ""
  for case let url as URL in walker {
    if let data = try? Data(contentsOf: url) { out += String(decoding: data, as: UTF8.self) }
  }
  return out
}

@MainActor
@Suite("store: Check of a long wait, once per wait")
struct StoreWaitCheckTests {
  @Test("a tap sends the text once through the outbox; the 202 makes it sent at that moment")
  func tapSends() async throws {
    let (store, transport) = try await readyStore()
    #expect(store.status() == .ready)
    guard case let .accepted(id) = await store.check() else {
      Issue.record("expected accepted")
      return
    }
    #expect(transport.read { $0.messages.map(\.body.text) } == [message])
    #expect(transport.read { $0.messages.first?.body.clientMessageId } == id.uuidString.lowercased())
    guard case let .sent(acceptedAt) = store.status(), case let .sent(at)? = store.state.outbox.first?.state else {
      Issue.record("expected sent, is \(String(describing: store.status()))")
      return
    }
    #expect(acceptedAt == at)
  }

  @Test("a second tap while the entry is queued and after its 202 sends nothing")
  func secondTapWhileQueuedOrSent() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let first = Task { await store.check() }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    #expect(store.state.outbox.first?.state == .queued)
    #expect(store.status() == .sending)
    #expect(await store.check() == .ignored)
    await valve.release()
    guard case .accepted = await first.value else {
      Issue.record("expected accepted")
      return
    }
    #expect(await store.check() == .ignored)
    #expect(transport.read { $0.messages.count } == 1)
    #expect(store.state.outbox.count == 1)
  }

  @Test("a tap at Not confirmed or at a refusal with Retry sends the same entry again, no new one", arguments: [
    TransportError.timedOut, .forbidden(APIFailure(status: 403, code: "bad-origin")),
  ])
  func tapRetriesTheSameEntry(error: TransportError) async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = error }
    let first = await store.check()
    let id = try #require(store.state.outbox.first?.id)
    #expect(first == .unconfirmed(id) || first == .refused(id, code: "bad-origin", message: nil))
    #expect(store.status() == .retry(id))
    transport.set { $0.sendResult = nil }
    #expect(await store.check() == .accepted(id))
    let wire = id.uuidString.lowercased()
    #expect(transport.read { $0.messages.map(\.body.clientMessageId) } == [wire, wire])
    #expect(store.state.outbox.map(\.id) == [id])
  }

  @Test("a final refusal frees the wait: the button is back and the next tap makes a new entry")
  func finalRefusalFreesTheWait() async throws {
    let (store, transport) = try await readyStore()
    transport.set {
      $0.sendResult = .http(APIFailure(status: 409, code: OutboxEntry.RefusalCode.clientIdConflict))
    }
    guard case let .refused(first, _, _) = await store.check() else {
      Issue.record("expected refused")
      return
    }
    #expect(store.status() == .ready)
    transport.set { $0.sendResult = nil }
    guard case let .accepted(second) = await store.check() else {
      Issue.record("expected accepted")
      return
    }
    #expect(second != first)
    #expect(store.state.outbox.map(\.id) == [first, second])
    #expect(transport.read { $0.messages.count } == 2)
  }

  @Test("a second tap while the first entry is still being written to disk makes no second entry")
  func secondTapDuringTheWrite() async throws {
    let (store, transport) = try await readyStore()
    await store.flushPersistence()
    let valve = Valve()
    let held = Task { await valve.wait() }
    store.persistChain = held
    let first = Task { await store.check() }
    await until("the entry waits for its write") { store.persistChain != held }
    #expect(store.state.outbox.isEmpty)
    #expect(store.status() == .sending)
    #expect(await store.check() == .ignored)
    await valve.release()
    guard case .accepted = await first.value else {
      Issue.record("expected accepted")
      return
    }
    #expect(store.state.outbox.count == 1)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("the echo before the 202: sent from the echo on, the 202 keeps that moment, a tap sends nothing")
  func echoBeforeTheAnswer() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let first = Task { await store.check() }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    let id = try #require(store.state.outbox.first?.id)
    transport.push(.session(id: "s1"), json: echo(id))
    await until("echo") { store.state.echoed[id] != nil }
    guard case let .sent(echoedAt) = store.status() else {
      Issue.record("expected sent after the echo, is \(String(describing: store.status()))")
      return
    }
    await valve.release()
    #expect(await first.value == .accepted(id))
    #expect(store.status() == .sent(echoedAt))
    #expect(await store.check() == .ignored)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("the echo after the 202: still sent at the 202, and with the entry gone a tap sends nothing")
  func echoAfterTheAnswer() async throws {
    let (store, transport) = try await readyStore()
    guard case let .accepted(id) = await store.check(), case let .sent(at) = store.status() else {
      Issue.record("expected accepted and sent")
      return
    }
    transport.push(.session(id: "s1"), json: echo(id))
    await until("echo") { store.state.outbox.isEmpty }
    #expect(store.status() == .sent(at))
    #expect(await store.check() == .ignored)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("an entry discarded by hand frees the wait: the next tap makes a new entry")
  func discardFreesTheWait() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .timedOut }
    guard case let .unconfirmed(first) = await store.check() else {
      Issue.record("expected unconfirmed")
      return
    }
    store.discard(first)
    #expect(store.status() == .ready)
    transport.set { $0.sendResult = nil }
    guard case let .accepted(second) = await store.check() else {
      Issue.record("expected accepted")
      return
    }
    #expect(second != first)
    #expect(transport.read { $0.messages.map(\.body.clientMessageId) }
      == [first.uuidString.lowercased(), second.uuidString.lowercased()])
  }

  @Test("another server during the send: the guard is emptied with the queue, and a tap after it sends anew")
  func serverChangeEmptiesTheGuard() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let first = Task { await store.check() }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    store.dispatch(.pairing(.dataWiped))
    #expect(store.state.outbox.isEmpty && store.state.waitChecks.checks.isEmpty)
    await valve.release()
    _ = await first.value
    // The late 202 of the previous space's entry settles nothing here.
    #expect(store.state.waitChecks.checks.isEmpty)
    transport.set { $0.onSendAsync = nil }
    guard case .accepted = await store.check() else {
      Issue.record("expected accepted")
      return
    }
    #expect(transport.read { $0.messages.count } == 2)
  }

  @Test("the guard follows the queue: a logout keeps both, entering another data space empties both")
  func guardFollowsTheQueue() {
    var state = AppState(clientBuild: 7)
    let id = UUID()
    state.apply(.waitCheck(.reserved(key: key, entryId: id)), now: Date())
    state.apply(.outboxEnqueued(OutboxEntry(id: id, sessionId: "s1", text: message, createdAt: Date())), now: Date())
    state.apply(.loggedOut(.notLoggedIn), now: Date())
    #expect(state.outbox.map(\.id) == [id])
    #expect(state.waitChecks.checks[key]?.entryId == id)
    state.apply(.pairing(.dataWiped), now: Date())
    #expect(state.outbox.isEmpty && state.waitChecks.checks.isEmpty)
  }

  @Test("the guard lives in the store: a tap from a reopened popover or from the inspector sends nothing more")
  func guardOutlivesTheView() async throws {
    let (store, transport) = try await readyStore()
    guard case .accepted = await store.check() else {
      Issue.record("expected accepted")
      return
    }
    // Each view asks the store for the same key; none keeps its own copy of the guard.
    let popover = store.status()
    let inspector = store.state.waitCheck(key, in: "s1")
    #expect(popover == inspector)
    #expect(await store.check() == .ignored)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("a new standby is a new key: its button is ready next to the sent one, and its tap sends")
  func newStandbyNewKey() async throws {
    let (store, transport) = try await readyStore()
    guard case .accepted = await store.check(key) else {
      Issue.record("expected accepted")
      return
    }
    #expect(store.status(nextKey) == .ready)
    guard case .accepted = await store.check(nextKey) else {
      Issue.record("expected accepted for the new key")
      return
    }
    #expect(transport.read { $0.messages.count } == 2)
  }

  @Test("no button and no send: send gate closed, a list from the cache, a session out of contact, a session done")
  func gates() async throws {
    let fresh = try JSONDecoder().decode(SessionSummary.self, from: Data(Frames.summary("s1", state: "waiting-input").utf8))
    var state = AppState(clientBuild: 7)
    state.sessions["s1"] = fresh
    #expect(state.waitCheck(key, in: "s1") == .ready)
    #expect(state.waitCheck(key, in: "s2") == nil)
    var cached = state
    cached.listCache.staleSince = Date()
    #expect(cached.waitCheck(key, in: "s1") == nil)
    let rows: [(String, String)] = [
      ("starting", "send gate"), ("waiting-permission", "decision"), ("done", "phantom agent"),
      ("resumable", "phantom agent"),
    ]
    for (value, why) in rows {
      var gated = state
      gated.sessions["s1"] = try JSONDecoder().decode(
        SessionSummary.self, from: Data(Frames.summary("s1", state: value).utf8))
      #expect(gated.waitCheck(key, in: "s1") == nil, "\(value): \(why)")
    }
    var outOfContact = state
    outOfContact.sessions["s1"] = try JSONDecoder().decode(
      SessionSummary.self, from: Data(Frames.summary("s1", state: "waiting-input", extra: #","stale":true"#).utf8))
    #expect(outOfContact.waitCheck(key, in: "s1") == nil)

    let (store, transport) = try await readyStore(state: "done")
    #expect(await store.check() == .ignored)
    #expect(transport.read { $0.messages.count } == 0)
    #expect(store.state.waitChecks.checks.isEmpty)
  }

  @Test("the outbox entry on disk carries the message, never the subagent's command from the list")
  func noRawCommandOnDisk() async throws {
    // The bug this guards: the check put the command text of the subagent's own task into the outbox manifest, which
    // lies on the device's disk; the list cache strips commands before the disk for the same reason.
    let raw = "until ! pgrep -f 'deploy --token=sk-live-123'; do sleep 30; done"
    let task = #"""
      "backgroundTasks":[{"id":"a1","kind":"agent","description":"Coverage review",
      "waitingSince":"2026-11-26T08:00:00.000Z","ownCommandWait":"stuck",
      "ownTasks":[{"id":"b7","command":"\#(raw)","startedAt":"2026-11-26T07:59:00.000Z"}]}]
      """#
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", extra: "," + task))}"#)
    await until("list with the task") { store.state.sessions["s1"]?.backgroundTasks?.isEmpty == false }
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let first = Task { await store.check() }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    await store.flushPersistence()
    let disk = diskBytes(outbox)
    #expect(disk.contains("Rarog check"), "the manifest is on disk while the request is in flight")
    #expect(!disk.contains("pgrep") && !disk.contains("sk-live-123"))
    await valve.release()
    _ = await first.value
  }
}
