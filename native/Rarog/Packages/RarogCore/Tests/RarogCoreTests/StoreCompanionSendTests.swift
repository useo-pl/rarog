import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
@testable import RarogCore
import Testing

// The voice agent across sessions sends a prompt through the outbox: the entry keeps the sender pair (`source`,
// `expectedConversation`) for every attempt, and the action names the server's answer. Fake: `FakeTransport` (the
// message route through `MutationRules`).
// Owner: voice agent; the outbox belongs to the send area.

private let sender = OutboxEntry.Sender(MessageSender(source: .voiceAgent, expectedConversation: "Tjo8_3W"))

/// A 409 `bad-state` refusal as the client builds it from the server's body (golden file `name`).
private func badState(_ name: String) throws -> TransportError {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  let body = try JSONDecoder().decode(APIErrorBody.self, from: Data(contentsOf: url))
  return .http(APIFailure(status: 409, code: body.error, message: body.message, sentenceCode: body.messageRef?.code))
}

/// A store started from the list cache with `s1` in it, after `hello`, and the session never opened. `fresh`: the
/// first fresh list came, so `s1` waits only for its first transcript. `probe`: the voice agent's routes over its base
/// fake, behind the same gate (also `VoiceAgentSessionStoreTests`).
@MainActor
func cachedStore(fresh: Bool, probe: VoiceProbe? = nil) async throws -> (RarogStore, FakeTransport) {
  let cache = temporaryOutbox()
  let row = Frames.summary("s1", state: "waiting-input")
  let session = try JSONDecoder().decode(SessionSummary.self, from: Data(row.utf8))
  #expect(await SnapshotCache(directory: cache).save([session], at: Date()))
  let transport = probe?.base ?? FakeTransport()
  let rules = MutationRules(timing: fastTiming)
  transport.gate = MutationGate(policy: rules)
  let routes: any RarogTransporting = probe ?? transport
  let store = RarogStore(
    transport: routes, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
    listCacheDirectory: cache)
  await store.start()
  await until("online") { store.state.global == .online }
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  await until("hello") { store.state.compat == .ok }
  if fresh {
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(row)]}"#)
    await until("fresh list") { !store.state.listStale }
  }
  #expect(store.state.listCache.awaitingTranscripts == ["s1"])
  return (store, transport)
}

/// The echo frame of `s1` with the `clientMessageId` of `id`.
private func echoFrame(_ id: UUID, seq: Int = 1) -> String {
  #"""
  {"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"user",
  "blocks":[{"type":"text","text":"Run the tests"}],"at":"\#(ISOTime.string(Date()))",
  "clientMessageId":"\#(id.uuidString.lowercased())"}}
  """#
}

/// A store after `hello` with `s1` in the state `state` on the list and no session open (its stream closed).
@MainActor
private func listedStore(state: String, outbox: URL = temporaryOutbox()) async -> (RarogStore, FakeTransport) {
  let (store, transport) = makeStore(outbox: outbox)
  await store.start()
  await until("online") { store.state.global == .online }
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
  transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: state))]}"#)
  await until("list") { store.state.sessionsLoaded && store.state.compat == .ok }
  return (store, transport)
}

extension RarogStore {
  /// The voice agent's prompt with the conversation token of `sender` above.
  fileprivate func prompt(_ text: String = "Run the tests", to sessionId: String = "s1", id: UUID) async
    -> CompanionSendOutcome
  {
    await sendCompanionPrompt(sessionId: sessionId, text: text, conversation: "Tjo8_3W", clientMessageId: id)
  }
}

@MainActor
@Suite("store: the voice agent's prompt through the outbox")
struct StoreCompanionSendTests {
  @Test("the request carries exactly the text, the caller's clientMessageId and the sender pair; 202 → sent")
  func sendsExactly() async throws {
    let (store, transport) = try await readyStore()
    let id = UUID()
    let text = "  Run the tests\nthen commit "
    #expect(await store.prompt(text, id: id) == .sent)
    let body = try #require(transport.read { $0.messages.last?.body })
    #expect(body.text == text && body.clientMessageId == id.uuidString.lowercased())
    #expect(body.source == "voice-agent" && body.expectedConversation == "Tjo8_3W" && body.queueAware == true)
    #expect(store.state.outbox.map(\.id) == [id] && store.state.outbox.first?.sender == sender)
  }

  @Test("202 with `queued: true` → queued, not sent")
  func queued() async throws {
    let (store, transport) = try await readyStore(state: "running")
    transport.set { $0.replyQueued = true }
    #expect(await store.prompt(id: UUID()) == .queued)
  }

  @Test("a lost answer, then the same call again: the same clientMessageId on the wire, one accepted entry")
  func repeatAfterLostAnswer() async throws {
    let (store, transport) = try await readyStore()
    let id = UUID()
    transport.set { $0.sendResult = .timedOut }
    #expect(await store.prompt(id: id) == .timedOut)
    transport.set { $0.sendResult = nil }
    #expect(await store.prompt(id: id) == .sent)
    let wire = id.uuidString.lowercased()
    #expect(transport.read { $0.messages.map(\.body.clientMessageId) } == [wire, wire])
    #expect(store.state.outbox.count == 1)
    #expect(transport.read { $0.messages.last?.body.expectedConversation } == "Tjo8_3W")
  }

  @Test("a repeat of an accepted id answers from the entry, also after its echo, and sends nothing")
  func repeatOfAccepted() async throws {
    let (store, transport) = try await readyStore()
    let id = UUID()
    #expect(await store.prompt(id: id) == .sent)
    #expect(await store.prompt(id: id) == .sent)
    #expect(transport.read { $0.messages.count } == 1)
    transport.push(.session(id: "s1"), json: #"""
      {"type":"message","sessionId":"s1","message":{"seq":1,"role":"user",
      "blocks":[{"type":"text","text":"Run the tests"}],"at":"\#(ISOTime.string(Date()))",
      "clientMessageId":"\#(id.uuidString.lowercased())"}}
      """#)
    await until("echo") { store.state.outbox.isEmpty }
    #expect(await store.prompt(id: id) == .sent)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("the echo confirms the prompt, then the request ends without an answer → sent", arguments: [
    TransportError.timedOut, .offline(.networkConnectionLost),
  ])
  func echoBeforeLostAnswer(error: TransportError) async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set {
      $0.sendResult = error
      $0.onSendAsync = { _, _ in await valve.wait() }
    }
    let id = UUID()
    let call = Task { await store.prompt(id: id) }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    transport.push(.session(id: "s1"), json: echoFrame(id))
    await until("echo") { store.state.echoed[id] != nil }
    await valve.release()
    #expect(await call.value == .sent)
  }

  @Test("the echo removes the entry while a repeat's manifest is written → sent, and nothing more goes out")
  func echoDuringRepeatWrite() async throws {
    let (store, transport) = try await readyStore()
    let id = UUID()
    transport.set { $0.sendResult = .timedOut }
    #expect(await store.prompt(id: id) == .timedOut)
    transport.set { $0.sendResult = nil }
    await store.flushPersistence()
    let valve = Valve()
    let held = Task { await valve.wait() }
    store.persistChain = held
    let call = Task { await store.prompt(id: id) }
    await until("the repeat waits for its manifest") { store.persistChain != held }
    transport.push(.session(id: "s1"), json: echoFrame(id))
    await until("echo") { store.state.echoed[id] != nil }
    await valve.release()
    #expect(await call.value == .sent)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("two calls at once with one id make one request and share its outcome")
  func concurrentCalls() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let id = UUID()
    // Two calls in the same instant (before the entry is staged), and a third while the request is in flight.
    let first = Task { await store.prompt(id: id) }
    let second = Task { await store.prompt(id: id) }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    let third = Task { await store.prompt(id: id) }
    try await Task.sleep(for: .milliseconds(20))
    await valve.release()
    for call in [first, second, third] { #expect(await call.value == .sent) }
    #expect(transport.read { $0.messages.count } == 1)
    #expect(store.state.outbox.count == 1)
  }

  @Test("another text, session or token under the id of a send in flight or of one its echo settled → id conflict")
  func sameIdOtherContent() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let id = UUID()
    let conflict = CompanionSendOutcome.refused(.refusal(code: OutboxEntry.RefusalCode.clientIdConflict, message: nil))
    func others() -> [Task<CompanionSendOutcome, Never>] {
      [
        Task { await store.prompt("Delete the branch", id: id) }, Task { await store.prompt(to: "s2", id: id) },
        Task {
          await store.sendCompanionPrompt(
            sessionId: "s1", text: "Run the tests", conversation: "Other_9", clientMessageId: id)
        },
      ]
    }
    func answers(_ calls: [Task<CompanionSendOutcome, Never>]) async -> [CompanionSendOutcome] {
      var answers: [CompanionSendOutcome] = []
      for call in calls { answers.append(await call.value) }
      return answers
    }
    let first = Task { await store.prompt(id: id) }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    let during = others()
    try await Task.sleep(for: .milliseconds(20))
    await valve.release()
    #expect(await first.value == .sent)
    #expect(await answers(during) == [conflict, conflict, conflict], "while the first send is in flight")
    transport.push(.session(id: "s1"), json: echoFrame(id))
    await until("echo") { store.state.outbox.isEmpty }
    #expect(await answers(others()) == [conflict, conflict, conflict], "after its echo")
    #expect(await store.prompt(id: id) == .sent)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("a person's stop during the request → cancelled; the entry stays Not confirmed, as it may have arrived")
  func stopDuringRequest() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    transport.set { $0.onSendAsync = { _, _ in await valve.wait() } }
    let id = UUID()
    let call = Task { await store.prompt(id: id) }
    await until("request in flight") { transport.read { $0.messages.count } == 1 }
    store.cancelSend(id)
    #expect(await call.value == .cancelled)
    #expect(store.state.outbox.first?.state == .unconfirmed)
    await valve.release()
  }

  @Test("a call while a person's Retry writes its manifest joins that attempt and gets its outcome; one request")
  func joinsRetryDuringItsWrite() async throws {
    let (store, transport) = try await readyStore()
    let id = UUID()
    transport.set { $0.sendResult = .timedOut }
    #expect(await store.prompt(id: id) == .timedOut)
    transport.set { $0.sendResult = nil }
    await store.flushPersistence()
    let valve = Valve()
    let held = Task { await valve.wait() }
    store.persistChain = held
    let retry = Task { await store.retry(id) }
    await until("the Retry waits for its manifest") { store.persistChain != held }
    let call = Task { await store.prompt(id: id) }
    try await Task.sleep(for: .milliseconds(20))
    await valve.release()
    #expect(await retry.value == .accepted(id))
    #expect(await call.value == .sent)
    #expect(transport.read { $0.messages.count } == 2)
  }

  @Test("409 of a changed conversation → that outcome; the entry is a final refusal and a repeat sends nothing")
  func conversationChanged() async throws {
    let (store, transport) = try await readyStore()
    let refusal = try badState("error.conversation-changed.json")
    transport.set { $0.sendResult = refusal }
    let id = UUID()
    guard case let .http(failure) = refusal else { return }
    #expect(await store.prompt(id: id) == .conversationChanged(message: failure.message))
    let entry = try #require(store.state.outbox.first)
    #expect(entry.state == .refused(code: OutboxEntry.RefusalCode.conversationChanged, message: failure.message))
    #expect(!entry.isRetryable)
    #expect(await store.retry(id) == .ignored)
    #expect(await store.prompt(id: id) == .conversationChanged(message: failure.message))
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("another 409 `bad-state` (a session that takes no message) is a refusal that keeps Retry")
  func otherBadState() async throws {
    let (store, transport) = try await readyStore()
    let refusal = TransportError.http(APIFailure(
      status: 409, code: "bad-state", message: "Busy.", sentenceCode: "session.not-accepting-messages"))
    transport.set { $0.sendResult = refusal }
    let id = UUID()
    #expect(await store.prompt(id: id) == .refused(.refusal(code: "bad-state", message: "Busy.")))
    #expect(store.state.outbox.first?.isRetryable == true)
  }

  @Test("the app's send gate refuses with the reason and nothing goes out")
  func sendGate() async throws {
    for (sessionState, block) in [("starting", SendBlock.starting), ("waiting-permission", .decisionPending)] {
      let (store, transport) = try await readyStore(state: sessionState)
      #expect(await store.prompt(id: UUID()) == .refused(.sendBlock(block)), "\(sessionState)")
      #expect(transport.read { $0.messages.isEmpty } && store.state.outbox.isEmpty, "\(sessionState)")
    }
  }

  @Test("a session not opened since a start from the cache takes the prompt while the list is fresh; a typed send not")
  func notOpenedAfterCacheStart() async throws {
    let (store, transport) = try await cachedStore(fresh: true)
    defer { store.setScenePhase(.background) }
    #expect(await store.prompt(id: UUID()) == .sent)
    #expect(transport.read { $0.messages.count } == 1)
    guard case .refused = await store.send(text: "typed", to: "s1") else {
      Issue.record("a typed send to a session without its transcript goes out")
      return
    }
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("a stale list refuses the prompt as it refuses the other mutations, and nothing goes out")
  func staleList() async throws {
    let (store, transport) = try await cachedStore(fresh: false)
    defer { store.setScenePhase(.background) }
    #expect(await store.prompt(id: UUID()) == .refused(.refusal(code: nil, message: CoreCopy.noConnection)))
    #expect(transport.read { $0.messages.isEmpty })
  }

  @Test("no echo within the deadline while the session's stream is closed: not Not confirmed; opening it clears it")
  func closedStreamWaitsForTheTranscript() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    let row = Frames.summary("s1", state: "waiting-input")
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(row)]}"#)
    await until("list") { store.state.sessionsLoaded && store.state.compat == .ok }
    let id = UUID()
    #expect(await store.prompt(id: id) == .sent)
    try await Task.sleep(for: fastTiming.unconfirmedAfter * 3)
    #expect(store.state.outbox.first?.isWaiting == true, "accepted, still waiting for its echo")
    store.openSession("s1")
    await until("session stream") { transport.streamCalls.contains { $0.scope == .session(id: "s1") } }
    let echo = #"""
      {"seq":1,"role":"user","blocks":[{"type":"text","text":"Run the tests"}],"at":"\#(ISOTime.string(Date()))",
      "clientMessageId":"\#(id.uuidString.lowercased())"}
      """#
    transport.push(.session(id: "s1"), json: #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(echo)],
      "pendingPermissions":[],"pendingQuestions":[]}
      """#)
    await until("reconciled") { store.state.outbox.isEmpty }
  }

  @Test("with the session's stream open, no echo within the deadline → Not confirmed, as for a typed message")
  func openStreamKeepsTheOrdinaryRule() async throws {
    let (store, _) = try await readyStore()
    #expect(await store.prompt(id: UUID()) == .sent)
    await until("Not confirmed") { store.state.outbox.first?.state == .unconfirmed }
  }

  @Test("after a restart an accepted entry past its deadline stays waiting for its session")
  func restartKeepsWaiting() async throws {
    let outbox = temporaryOutbox()
    let accepted = OutboxEntry.State.sent(acceptedAt: Date().addingTimeInterval(-3600))
    let voice = OutboxEntry(sessionId: "s1", text: "Run the tests", createdAt: Date(), state: accepted, sender: sender)
    try await OutboxPersistence(directory: outbox).save(voice)
    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    #expect(store.state.outbox.first?.state == accepted)
  }

  @Test("an entry in the CLI queue whose cap passed with the stream closed is Not confirmed once the stream opens")
  func queuedCapAtOpening() async throws {
    // In a turn, so no idle period makes it Not confirmed: only the cap can.
    let (store, transport) = await listedStore(state: "running")
    transport.set { $0.replyQueued = true }
    #expect(await store.prompt(id: UUID()) == .queued)
    try await Task.sleep(for: fastTiming.queuedUnconfirmedAfter + .milliseconds(200))
    #expect(store.state.outbox.first?.isQueued == true, "the cap's check came with the stream closed")
    store.openSession("s1")
    await until("Not confirmed at the opening", timeout: .seconds(3)) {
      store.state.outbox.first?.state == .unconfirmed
    }
  }

  @Test("after a restart an entry in the CLI queue past its cap is Not confirmed once its session's stream opens")
  func queuedCapAfterRestart() async throws {
    let outbox = temporaryOutbox()
    let hourAgo = Date().addingTimeInterval(-3600)
    var voice = OutboxEntry(
      sessionId: "s1", text: "Run the tests", createdAt: hourAgo, state: .sent(acceptedAt: hourAgo), sender: sender)
    voice.queuedAt = hourAgo
    voice.queueAware = true
    try await OutboxPersistence(directory: outbox).save(voice)
    let (store, _) = await listedStore(state: "running", outbox: outbox)
    #expect(store.state.outbox.first?.isQueued == true)
    store.openSession("s1")
    await until("Not confirmed at the opening", timeout: .seconds(3)) {
      store.state.outbox.first?.state == .unconfirmed
    }
  }

  @Test("a 401 during the send logs out")
  func unauthorized() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .unauthorized(APIFailure(status: 401)) }
    #expect(await store.prompt(id: UUID()) == .loggedOut)
    #expect(store.state.auth != .loggedIn)
  }

  @Test("a person's Retry of a voice agent's entry after a restart still carries the pair; the manifest is v3")
  func retryAfterRestartCarriesThePair() async throws {
    let outbox = temporaryOutbox()
    let entry = OutboxEntry(
      sessionId: "s1", text: "Run the tests", createdAt: Date(), state: .unconfirmed, sender: sender)
    try await OutboxPersistence(directory: outbox).save(entry)
    let manifest = outbox.appending(path: "\(entry.id.uuidString).json")
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
    #expect(object?["version"] as? Int == 3, "an app without the pair skips the entry")

    let (store, transport) = try await readyStore(outbox: outbox)
    #expect(store.state.outbox.first?.sender == sender)
    #expect(await store.retry(entry.id) == .accepted(entry.id))
    let body = try #require(transport.read { $0.messages.last?.body })
    #expect(body.clientMessageId == entry.clientMessageId && body.text == "Run the tests")
    #expect(body.source == "voice-agent" && body.expectedConversation == "Tjo8_3W")
  }
}

@Suite("reducer: an accepted entry and its session's stream")
struct ReducerCompanionSendTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
  private let timing = CoreTiming(unconfirmedAfter: .seconds(15), queuedIdleAfter: .seconds(15))

  /// Logged in, `s1` waiting for input on the list, no session open; a voice agent's entry and a typed one (an Inbox
  /// reply sends to a session that is not open), both accepted (`queued`: with `queued: true`).
  private func state(queued: Bool = false) throws -> (AppState, voice: UUID, typed: UUID) {
    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: t0)
    let list = try Frames.snapshot([Frames.summary("s1", state: "waiting-input")])
    state.apply(.frame(list, source: .global, cursor: nil), now: t0)
    let voice = OutboxEntry(sessionId: "s1", text: "Run the tests", createdAt: t0, sender: sender)
    let typed = OutboxEntry(sessionId: "s1", text: "typed", createdAt: t0)
    for entry in [voice, typed] {
      state.apply(.outboxEnqueued(entry), now: t0)
      state.apply(queued ? .outboxQueued(entry.id, at: t0) : .outboxAccepted(entry.id, at: t0), now: t0, timing: timing)
    }
    return (state, voice.id, typed.id)
  }

  private func open(_ state: inout AppState, at now: Date? = nil) -> [CoreEffect] {
    state.apply(.viewSession("s1"), now: now ?? t0)
    return state.apply(.streamOpened(.session(id: "s1"), resumedWithCursor: false), now: now ?? t0, timing: timing)
  }

  private func entryState(_ state: AppState, _ id: UUID) -> OutboxEntry.State? {
    state.outbox.first { $0.id == id }?.state
  }

  @Test("the deadline after the 202 needs the session's stream open, whoever sent; opening it starts the countdown")
  func deadlineAfterAccepted() throws {
    var (state, voice, typed) = try state()
    let late = t0.addingTimeInterval(20)
    state.apply(.outboxUnconfirmedIfStillSent(voice), now: late, timing: timing)
    state.apply(.outboxUnconfirmedIfStillSent(typed), now: late, timing: timing)
    #expect(entryState(state, voice) == .sent(acceptedAt: t0), "no stream, no echo to miss")
    #expect(entryState(state, typed) == .sent(acceptedAt: t0), "a typed entry waits for the stream the same way")
    #expect(open(&state) == [
      .scheduleUnconfirmedCheck(voice, after: .seconds(15), openedAt: t0),
      .scheduleUnconfirmedCheck(typed, after: .seconds(15), openedAt: t0),
    ])
    state.apply(.outboxUnconfirmedAfterOpening(voice, openedAt: t0), now: late, timing: timing)
    state.apply(.outboxUnconfirmedAfterOpening(typed, openedAt: t0), now: late, timing: timing)
    #expect(entryState(state, voice) == .unconfirmed)
    #expect(entryState(state, typed) == .unconfirmed)
  }

  @Test("the stream's opening replaces the countdown after the 202: a check scheduled before it changes nothing")
  func openingReplacesTheCountdown() throws {
    var (state, voice, typed) = try state()
    // Accepted at t0 with the stream closed: the check after the 202 is due at t0 + 15 s.
    let opened = t0.addingTimeInterval(14)
    #expect(open(&state, at: opened) == [
      .scheduleUnconfirmedCheck(voice, after: .seconds(15), openedAt: opened),
      .scheduleUnconfirmedCheck(typed, after: .seconds(15), openedAt: opened),
    ])
    state.apply(.outboxUnconfirmedIfStillSent(voice), now: t0.addingTimeInterval(15), timing: timing)
    #expect(entryState(state, voice) == .sent(acceptedAt: t0), "one second of watching is not the 15 s")
    // A second opening replaces the first one's countdown the same way.
    let reopened = t0.addingTimeInterval(20)
    _ = open(&state, at: reopened)
    state.apply(.outboxUnconfirmedAfterOpening(voice, openedAt: opened), now: t0.addingTimeInterval(29), timing: timing)
    #expect(entryState(state, voice) == .sent(acceptedAt: t0))
    let due = t0.addingTimeInterval(35)
    state.apply(.outboxUnconfirmedAfterOpening(voice, openedAt: reopened), now: due, timing: timing)
    #expect(entryState(state, voice) == .unconfirmed)
  }

  @Test("a queued entry: no idle period and no cap while the stream is closed; the period starts when it opens")
  func queuedRules() throws {
    var (state, voice, typed) = try state(queued: true)
    #expect(state.syncQueuedIdle(now: t0).isEmpty, "both entries wait for the stream")
    let later = t0.addingTimeInterval(16)
    state.apply(.outboxQueuedIdle(sessionId: "s1", since: t0), now: later, timing: timing)
    #expect(entryState(state, typed) == .sent(acceptedAt: t0))
    #expect(entryState(state, voice) == .sent(acceptedAt: t0))
    state.apply(.outboxUnconfirmedIfQueued(voice), now: t0.addingTimeInterval(7200), timing: timing)
    state.apply(.outboxUnconfirmedIfQueued(typed), now: t0.addingTimeInterval(7200), timing: timing)
    #expect(entryState(state, voice) == .sent(acceptedAt: t0), "the cap waits for the stream too")
    #expect(entryState(state, typed) == .sent(acceptedAt: t0))
    #expect(open(&state) == [
      .scheduleQueuedCeilingCheck(voice, queuedAt: t0), .scheduleQueuedCeilingCheck(typed, queuedAt: t0),
    ], "the cap's check from queuedAt")
    #expect(state.syncQueuedIdle(now: later) == [.scheduleQueuedIdleCheck(sessionId: "s1", since: later)])
  }

  private func frame(_ state: inout AppState, _ event: ServerEvent, at now: Date) -> [CoreEffect] {
    state.apply(.frame(event, source: .global, cursor: nil), now: now, timing: timing)
  }

  @Test("an entry that stops waiting (its session off a fresh list or in a Rarog terminal) gets a countdown from then")
  func stopsWaiting() throws {
    let hosted = Frames.summary("s1", state: "waiting-input", extra: #","termId":"0123456789abcdef""#)
    let changes = [
      ("off the list", try Frames.snapshot([Frames.summary("s2")])),
      ("in a terminal", try Frames.sessionChanged(hosted)),
    ]
    for queued in [false, true] {
      for (change, event) in changes {
        var (state, voice, typed) = try state(queued: queued)
        let label = "queued: \(queued), \(change)"
        // The countdown after the 202 and the cap already ran out while the stream was closed.
        state.apply(.outboxUnconfirmedIfStillSent(voice), now: t0.addingTimeInterval(20), timing: timing)
        state.apply(.outboxUnconfirmedIfQueued(typed), now: t0.addingTimeInterval(7200), timing: timing)
        let stopped = t0.addingTimeInterval(7300)
        let effects = frame(&state, event, at: stopped)
        for id in [voice, typed] {
          #expect(effects.contains(.scheduleUnconfirmedCheck(id, after: .seconds(15), openedAt: stopped)), "\(label)")
        }
        #expect(state.outbox.allSatisfy { $0.state.isSent }, "not Not confirmed at once, \(label)")
        for id in [voice, typed] {
          let due = stopped.addingTimeInterval(15)
          state.apply(.outboxUnconfirmedAfterOpening(id, openedAt: stopped), now: due, timing: timing)
        }
        #expect(state.outbox.allSatisfy { $0.state == .unconfirmed }, "\(label)")
      }
    }
  }

  @Test("a queued entry whose wait ends before its cap: the countdown from then changes nothing, the cap decides")
  func queuedWaitEndsBeforeTheCap() throws {
    var (state, voice, typed) = try state(queued: true)
    let gone = t0.addingTimeInterval(1)
    _ = frame(&state, try Frames.snapshot([Frames.summary("s2")]), at: gone)
    for id in [voice, typed] {
      state.apply(.outboxUnconfirmedAfterOpening(id, openedAt: gone), now: gone.addingTimeInterval(15), timing: timing)
    }
    #expect(state.outbox.allSatisfy { $0.isQueued }, "no 15 s threshold in the CLI queue")
    let cap = t0.addingTimeInterval(timing.queuedUnconfirmedAfter.timeInterval)
    for id in [voice, typed] { state.apply(.outboxUnconfirmedIfQueued(id), now: cap, timing: timing) }
    #expect(state.outbox.allSatisfy { $0.state == .unconfirmed })
  }

  @Test("a session off the list for a moment (a server restart) and back within the countdown: its entries still wait")
  func sessionBackWithinTheCountdown() throws {
    for queued in [false, true] {
      var (state, voice, typed) = try state(queued: queued)
      let gone = t0.addingTimeInterval(1)
      _ = frame(&state, try Frames.snapshot([]), at: gone)
      let back = try Frames.snapshot([Frames.summary("s1", state: "waiting-input")])
      _ = frame(&state, back, at: t0.addingTimeInterval(5))
      let late = t0.addingTimeInterval(7200)
      for id in [voice, typed] {
        state.apply(.outboxUnconfirmedIfStillSent(id), now: late, timing: timing)
        state.apply(.outboxUnconfirmedIfQueued(id), now: late, timing: timing)
        state.apply(.outboxUnconfirmedAfterOpening(id, openedAt: gone), now: late, timing: timing)
      }
      #expect(state.outbox.allSatisfy { $0.state.isSent }, "queued: \(queued)")
    }
  }

  @Test("restored accepted entries wait while no list is fresh; their session off a fresh one: a countdown, not now")
  func restoredEntriesOfAnUnlistedSession() throws {
    let typed = OutboxEntry(sessionId: "s1", text: "typed", createdAt: t0, state: .sent(acceptedAt: t0))
    var queued = OutboxEntry(sessionId: "s1", text: "queued", createdAt: t0, state: .sent(acceptedAt: t0))
    queued.queuedAt = t0
    let other = try JSONDecoder().decode(SessionSummary.self, from: Data(Frames.summary("s2").utf8))
    let list = try Frames.snapshot([Frames.summary("s2")])
    // The countdown and the cap the store schedules on restore (`restoreOutbox`).
    func restoreChecks(_ state: inout AppState, at now: Date) {
      state.apply(.outboxUnconfirmedIfStillSent(typed.id), now: now, timing: timing)
      state.apply(.outboxUnconfirmedIfQueued(queued.id), now: now, timing: timing)
    }

    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: t0)
    state.apply(.outboxRestored([typed, queued]), now: t0, timing: timing)
    restoreChecks(&state, at: t0.addingTimeInterval(7200))
    #expect(state.outbox.allSatisfy { $0.state.isSent }, "no list yet")
    state.apply(.listCache(.restored(CachedList(sessions: [other], savedAt: t0))), now: t0, timing: timing)
    restoreChecks(&state, at: t0.addingTimeInterval(7200))
    #expect(state.outbox.allSatisfy { $0.state.isSent }, "a list from the cache is stale")
    let fresh = t0.addingTimeInterval(7300)
    let effects = frame(&state, list, at: fresh)
    for id in [typed.id, queued.id] {
      #expect(effects.contains(.scheduleUnconfirmedCheck(id, after: .seconds(15), openedAt: fresh)))
    }
    #expect(state.outbox.allSatisfy { $0.state.isSent }, "a countdown, not Not confirmed at once")
    var lastEffects: [CoreEffect] = []
    for id in [typed.id, queued.id] {
      let due = fresh.addingTimeInterval(15)
      lastEffects += state.apply(.outboxUnconfirmedAfterOpening(id, openedAt: fresh), now: due, timing: timing)
    }
    #expect(state.outbox.count == 2 && state.outbox.allSatisfy { $0.state == .unconfirmed })
    #expect(state.outbox.allSatisfy { lastEffects.contains(.persistOutboxEntry($0)) })

    // The outbox read from disk can land after the fresh list: the restore's own countdowns decide.
    var late = AppState(clientBuild: 1)
    late.apply(.loggedIn, now: t0)
    _ = frame(&late, list, at: t0)
    late.apply(.outboxRestored([typed, queued]), now: t0, timing: timing)
    #expect(late.outbox.allSatisfy { $0.state.isSent }, "not at once")
    restoreChecks(&late, at: t0.addingTimeInterval(7200))
    #expect(late.outbox.count == 2 && late.outbox.allSatisfy { $0.state == .unconfirmed })
  }
}
