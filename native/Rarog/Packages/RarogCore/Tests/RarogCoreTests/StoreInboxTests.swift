import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// The Inbox in the store: text reads of the open Inbox, removal with Undo, and the decision of a card whose session
// transcript was not loaded. Owner: Inbox.

/// A clock the test moves by hand.
private final class HandClock: @unchecked Sendable {
  private let value = Mutex(Date(timeIntervalSince1970: 1_790_000_000))
  var now: Date { value.withLock { $0 } }
  func advance(_ seconds: TimeInterval) { value.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

@MainActor
@Suite("store: Inbox reads, removal with Undo, decisions from a card")
struct StoreInboxTests {
  /// Logged in and online, sessions A (unread result) and B (on a permission), with their heads on the global stream.
  private func inboxStore(
    clock: HandClock = HandClock(), timing: CoreTiming = fastTiming
  ) async throws -> (RarogStore, FakeTransport) {
    let transport = FakeTransport()
    let rules = MutationRules(timing: timing)
    transport.gate = MutationGate(policy: rules)
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: timing,
      clock: { clock.now })
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"""
      {"type":"sessions-snapshot","sessions":[\#(Frames.summary("A", state: "waiting-input")),
      \#(Frames.summary("B", state: "waiting-permission"))]}
      """#)
    transport.push(.global, json: #"""
      {"type":"inbox-heads","heads":[\#(InboxWire.head("A", at: "2026-10-03T09:05:00.000Z")),
      \#(InboxWire.head("B", kind: "decision", state: "waiting-permission", at: "2026-10-03T09:04:00.000Z",
                        dialog: "permission"))]}
      """#)
    await until("heads") { store.state.inboxItems.count == 2 }
    transport.inbox.card(InboxWire.card("A", text: "Result A."), for: "A")
    transport.inbox.card(
      InboxWire.card("B", kind: "decision", state: "waiting-permission", text: "Running tests.",
                     dialog: InboxWire.permissionDialog("p1")),
      for: "B")
    return (store, transport)
  }

  @Test("a closed Inbox reads no text; opening it reads all texts once")
  func textsOnlyWhileOpen() async throws {
    let (store, transport) = try await inboxStore()
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.inbox.read { $0.listCalls + $0.cardCalls.count } == 0)
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    #expect(transport.inbox.read { $0.listCalls } == 1)
    #expect(transport.inbox.read { $0.cardCalls }.isEmpty)
  }

  @Test("inbox-heads while the Inbox is open (a reconnect) reads all texts again, once")
  func headsReadTextsAgain() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    transport.push(.global, json: #"{"type":"inbox-heads","heads":[\#(InboxWire.head("A", at: "2026-10-03T09:05:00.000Z"))]}"#)
    await until("second list read") { transport.inbox.read { $0.listCalls } == 2 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.inbox.read { $0.listCalls } == 2)
    #expect(transport.inbox.read { $0.cardCalls }.isEmpty)
    #expect(store.state.inboxItems.map(\.id) == ["A"])
  }

  @Test("a head with a new version → exactly one read of that card's text, also when the head repeats")
  func newVersionReadsOnce() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    transport.inbox.card(InboxWire.card("A", version: "v2", text: "Result A, later text."), for: "A")
    let head = #"{"type":"inbox-head","head":\#(InboxWire.head("A", version: "v2", at: "2026-10-03T09:05:00.000Z"))}"#
    transport.push(.global, json: head)
    transport.push(.global, json: head)
    await until("new text") { store.state.inboxItems.first?.card?.text == "Result A, later text." }
    transport.push(.global, json: head)
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.inbox.read { $0.cardCalls } == ["A"])
    #expect(transport.inbox.read { $0.listCalls } == 1)
  }

  @Test("the read answers with a newer version than its head: no second read; the newer head shows that text")
  func headBehindItsText() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    transport.inbox.card(InboxWire.card("A", version: "v3", text: "Result A, third text."), for: "A")
    let v2 = #"{"type":"inbox-head","head":\#(InboxWire.head("A", version: "v2", at: "2026-10-03T09:05:00.000Z"))}"#
    transport.push(.global, json: v2)
    await until("read") { store.state.inbox.cards["A"]?.version == "v3" }
    transport.push(.global, json: v2)
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.inbox.read { $0.cardCalls } == ["A"])
    #expect(store.state.inboxItems.first?.card == nil)
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(InboxWire.head("A", version: "v3", at: "2026-10-03T09:05:00.000Z"))}"#)
    await until("newer head") { store.state.inboxItems.first?.card?.text == "Result A, third text." }
    #expect(transport.inbox.read { $0.cardCalls } == ["A"])
  }

  @Test("a list read whose newer text the state drops (its head lags) reads that text again when the head catches up")
  func droppedListTextIsReadAgain() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    transport.inbox.card(InboxWire.card("A", version: "v2", text: "Result A, later text."), for: "A")
    transport.push(.global, json: #"""
      {"type":"inbox-heads","heads":[\#(InboxWire.head("A", at: "2026-10-03T09:05:00.000Z")),
      \#(InboxWire.head("B", kind: "decision", state: "waiting-permission", at: "2026-10-03T09:04:00.000Z",
                        dialog: "permission"))]}
      """#)
    await until("second list read") { transport.inbox.read { $0.listCalls } == 2 }
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.inboxItems.first?.card?.text == "Result A.")
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(InboxWire.head("A", version: "v2", at: "2026-10-03T09:05:00.000Z"))}"#)
    await until("newer text") { store.state.inboxItems.first?.card?.text == "Result A, later text." }
    #expect(transport.inbox.read { $0.cardCalls } == ["A"])
  }

  @Test("the list answers a newer text than its head: one single read of the head's version, not two")
  func listAheadOfItsHeadReadsOnce() async throws {
    let (store, transport) = try await inboxStore()
    transport.inbox.card(InboxWire.card("A", version: "v2", text: "Result A, later text."), for: "A")
    store.inboxOpened()
    await until("list and single read") {
      transport.inbox.read { $0.listCalls } == 1 && !transport.inbox.read { $0.cardCalls }.isEmpty
    }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.inbox.read { $0.cardCalls } == ["A"])
  }

  @Test("a single read that answers after a newer list read: the head that catches up with the list still gets text")
  func lateSingleReadAfterTheList() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    let gate = AsyncStream<Void>.makeStream()
    transport.inbox.set { state in
      state.onCard = { for await _ in gate.stream { return } }
    }
    transport.inbox.card(InboxWire.card("A", version: "v2", text: "Second."), for: "A")
    let v2 = InboxWire.head("A", version: "v2", at: "2026-10-03T09:05:00.000Z")
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(v2)}"#)
    await until("single read in flight") { transport.inbox.read { $0.cardCalls } == ["A"] }
    transport.inbox.set { $0.onCard = nil }
    transport.inbox.card(InboxWire.card("A", version: "v3", text: "Third."), for: "A")
    transport.push(.global, json: #"{"type":"inbox-heads","heads":[\#(v2)]}"#)
    await until("list read") { store.state.inbox.cards["A"]?.version == "v3" }
    gate.continuation.yield()
    await until("late single answer") { store.state.inbox.cards["A"]?.version == "v2" }
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(InboxWire.head("A", version: "v3", at: "2026-10-03T09:05:00.000Z"))}"#)
    await until("third text") { store.state.inboxItems.first?.card?.text == "Third." }
  }

  @Test("removal: the request goes out at once with the head's turn and version; Undo in time restores the same")
  func removeAndUndo() async throws {
    let clock = HandClock()
    let (store, transport) = try await inboxStore(clock: clock)
    let removal = Task { await store.removeInboxCard("A") }
    await until("hidden") { !store.state.inboxItems.contains { $0.id == "A" } }
    #expect(await removal.value == .removed(receiptSkipped: false))
    let sent = InboxActionBody(turnId: "t-A", version: "v1")
    #expect(transport.inbox.read { $0.removes } == [FakeInboxBackend.Call(sessionId: "A", body: sent)])
    transport.push(.global, json: #"{"type":"inbox-removed","sessionId":"A","turnId":"t-A"}"#)
    await until("head gone") { store.state.inbox.heads["A"] == nil }

    clock.advance(4.9)
    #expect(await store.undoInboxRemoval("A") == .restored)
    #expect(transport.inbox.read { $0.restores } == [FakeInboxBackend.Call(sessionId: "A", body: sent)])
    #expect(store.state.inboxItems.first?.id == "A")
  }

  @Test("Undo after the window → nothing goes out; the receipt-skipped answer is still a removal")
  func undoWindowEnds() async throws {
    let clock = HandClock()
    let (store, transport) = try await inboxStore(clock: clock)
    transport.inbox.set { $0.receiptSkipped = true }
    #expect(await store.removeInboxCard("A") == .removed(receiptSkipped: true))
    clock.advance(5)
    #expect(!store.state.inboxUndoable("A", now: clock.now))
    #expect(await store.undoInboxRemoval("A") == .expired)
    #expect(transport.inbox.read { $0.restores }.isEmpty)
  }

  @Test("409 on removal → the card comes back and its text is read again")
  func staleRemovalComesBack() async throws {
    let (store, transport) = try await inboxStore()
    transport.inbox.set { $0.removeResult = .http(APIFailure(status: 409, code: "inbox-card-changed")) }
    #expect(await store.removeInboxCard("A") == .changed)
    #expect(store.state.inboxItems.map(\.id) == ["A", "B"])
    await until("text read again") { transport.inbox.read { $0.cardCalls } == ["A"] }
  }

  @Test("Undo during the removal request waits for its answer, then restores")
  func undoWaitsForRemoval() async throws {
    let (store, transport) = try await inboxStore()
    let gate = AsyncStream<Void>.makeStream()
    transport.inbox.set { state in
      state.onRemove = { for await _ in gate.stream { return } }
    }
    let removal = Task { await store.removeInboxCard("A") }
    await until("removal in flight") { transport.inbox.read { $0.removes.count } == 1 }
    let undo = Task { await store.undoInboxRemoval("A") }
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.inbox.read { $0.restores }.isEmpty)
    gate.continuation.yield()
    #expect(await removal.value == .removed(receiptSkipped: false))
    #expect(await undo.value == .restored)
    #expect(transport.inbox.read { $0.restores.count } == 1)
  }

  @Test("a decision from an Inbox card without that session's transcript → the transcript loads, the action is the same")
  func decisionWithoutTranscript() async throws {
    let (store, transport) = try await inboxStore()
    #expect(store.state.transcripts["B"] == nil)
    store.inboxOpened()
    await until("transcript stream of B") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    #expect(transport.streamCalls.last { $0.scope == .session(id: "B") }?.lastEventId == nil)
    #expect(store.state.inboxDecision("B") == nil)
    let card = Frames.permission("B", permId: "p1")
    transport.push(.session(id: "B"), json: #"""
      {"type":"transcript-snapshot","sessionId":"B","messages":[],"pendingPermissions":[\#(card)],"pendingQuestions":[]}
      """#)
    await until("decision") { store.state.inboxDecision("B") != nil }
    guard case let .permission(request, attempt) = store.state.inboxDecision("B") else {
      Issue.record("a permission decision")
      return
    }
    #expect(request.permId == "p1" && attempt == nil)
    // One read: the stream closes after its snapshot and is not opened again for the same version.
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.streamCalls.count { $0.scope == .session(id: "B") } == 1)
    #expect(store.state.sessionStream == .idle)

    store.holdInboxCard("B")
    #expect(await store.decidePermission(sessionId: "B", permId: "p1", decision: .allow) == .accepted)
    #expect(transport.read { $0.decisions.map(\.permId) } == ["p1"])
    guard case let .permission(_, attempt?) = store.state.inboxDecision("B") else {
      Issue.record("the decision in flight shows on the card")
      return
    }
    #expect(attempt.accepted)
    #expect(store.state.inboxItems.first { $0.id == "B" }?.held == true)
  }

  @Test("a fresh transcript asked while the Inbox reads that decision card's transcript: the read's late snapshot does not count")
  func freshTranscriptDropsTheReadInFlight() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    await until("transcript read of B") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    let snapshot = #"""
      {"type":"transcript-snapshot","sessionId":"B","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
      """#
    // The voice agent of B's card asks a fresh transcript; the read asked before answers before the root view opens
    // B's stream.
    store.refreshTranscript("B")
    transport.push(.session(id: "B"), json: snapshot)
    try await Task.sleep(for: .milliseconds(50))
    #expect((store.state.transcripts["B"]?.snapshots ?? 0) == 0, "an answer to a read asked before is not fresh")

    store.openSession("B")
    await until("B's stream") { transport.streamCalls.count { $0.scope == .session(id: "B") } == 2 }
    #expect(transport.streamCalls.last { $0.scope == .session(id: "B") }?.lastEventId == nil)
    transport.push(.session(id: "B"), json: snapshot, id: "c1")
    await until("the fresh snapshot") { store.state.transcripts["B"]?.snapshots == 1 }
  }

  @Test("the session on screen keeps its own stream: the Inbox does not open a second one")
  func noSecondStreamForTheViewedSession() async throws {
    let (store, transport) = try await inboxStore()
    store.openSession("B")
    await until("session stream") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.streamCalls.count { $0.scope == .session(id: "B") } == 1)
  }

  @Test("a card without a requestId has no decision and loads no transcript")
  func noRequestIdNoDecision() async throws {
    let (store, transport) = try await inboxStore()
    transport.inbox.card(
      InboxWire.card("B", kind: "decision", state: "waiting-permission", dialog: InboxWire.permissionDialog(nil)),
      for: "B")
    store.inboxOpened()
    await until("texts") { store.state.inboxItems.allSatisfy { $0.card != nil } }
    try await Task.sleep(for: .milliseconds(50))
    #expect(!transport.streamCalls.contains { $0.scope == .session(id: "B") })
    #expect(store.state.inboxDecision("B") == nil)
  }

  @Test("a decision card whose session stream answers 404 is not asked again for that version; the next card loads")
  func goneStreamMovesOn() async throws {
    let (store, transport) = try await inboxStore()
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("C", state: "waiting-permission"))}"#)
    transport.push(.global, json: #"""
      {"type":"inbox-head","head":\#(InboxWire.head("C", kind: "decision", state: "waiting-permission",
                                                    at: "2026-10-03T09:03:00.000Z", dialog: "permission"))}
      """#)
    await until("C stands") { store.state.inboxItems.count == 3 }
    transport.inbox.card(
      InboxWire.card("C", kind: "decision", state: "waiting-permission", text: "Deploying.",
                     dialog: InboxWire.permissionDialog("p9")),
      for: "C")
    transport.set { $0.openFailures = [.http(APIFailure(status: 404, code: "session-not-found"))] }
    store.inboxOpened()
    await until("transcript stream of C") { transport.streamCalls.contains { $0.scope == .session(id: "C") } }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.streamCalls.count { $0.scope == .session(id: "B") } == 1)
  }

  /// The open Inbox whose transcript stream of B (head v1) answered 404.
  private func inboxStoreWithGoneStream() async throws -> (RarogStore, FakeTransport) {
    let (store, transport) = try await inboxStore()
    transport.set { $0.openFailures = [.http(APIFailure(status: 404, code: "session-not-found"))] }
    store.inboxOpened()
    await until("transcript stream of B") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    try await Task.sleep(for: .milliseconds(50))
    #expect(store.state.inboxDecision("B") == nil)
    return (store, transport)
  }

  private func decisionHead(_ sessionId: String, version: String) -> String {
    let head = InboxWire.head(
      sessionId, version: version, kind: "decision", state: "waiting-permission", at: "2026-10-03T09:04:00.000Z",
      dialog: "permission")
    return #"{"type":"inbox-head","head":\#(head)}"#
  }

  private func decisionCard(_ sessionId: String, version: String, requestId: String) -> String {
    InboxWire.card(
      sessionId, version: version, kind: "decision", state: "waiting-permission", text: "Running tests.",
      dialog: InboxWire.permissionDialog(requestId))
  }

  private func pushSnapshot(_ transport: FakeTransport, _ sessionId: String, permId: String) {
    let card = Frames.permission(sessionId, permId: permId)
    transport.push(.session(id: sessionId), json: #"""
      {"type":"transcript-snapshot","sessionId":"\#(sessionId)","messages":[],"pendingPermissions":[\#(card)],"pendingQuestions":[]}
      """#)
  }

  private func decidedPermId(_ store: RarogStore, _ sessionId: String) -> String? {
    guard case let .permission(request, _) = store.state.inboxDecision(sessionId) else { return nil }
    return request.permId
  }

  @Test("a 404 does not outlive its head: the card that left and came back with the same version loads its transcript")
  func goneStreamForgottenWhenTheHeadLeaves() async throws {
    let (store, transport) = try await inboxStoreWithGoneStream()
    transport.push(.global, json: #"{"type":"inbox-removed","sessionId":"B","turnId":"t-B"}"#)
    await until("B left") { store.state.inboxItems.map(\.id) == ["A"] }
    transport.push(.global, json: decisionHead("B", version: "v1"))
    await until("second transcript stream of B") {
      transport.streamCalls.count { $0.scope == .session(id: "B") } == 2
    }
    pushSnapshot(transport, "B", permId: "p1")
    await until("decision") { decidedPermId(store, "B") == "p1" }
  }

  @Test("a 404 of one version does not block that version when the head comes back to it after another")
  func goneStreamForgottenWhenTheVersionChanges() async throws {
    let (store, transport) = try await inboxStoreWithGoneStream()
    transport.inbox.card(decisionCard("B", version: "v2", requestId: "p2"), for: "B")
    transport.push(.global, json: decisionHead("B", version: "v2"))
    await until("transcript stream of B for v2") {
      transport.streamCalls.count { $0.scope == .session(id: "B") } == 2
    }
    pushSnapshot(transport, "B", permId: "p2")
    await until("decision of v2") { decidedPermId(store, "B") == "p2" }

    transport.inbox.card(decisionCard("B", version: "v1", requestId: "p1"), for: "B")
    transport.push(.global, json: decisionHead("B", version: "v1"))
    await until("transcript stream of B for v1 again") {
      transport.streamCalls.count { $0.scope == .session(id: "B") } == 3
    }
    pushSnapshot(transport, "B", permId: "p1")
    await until("decision of v1") { decidedPermId(store, "B") == "p1" }
  }

  /// The open-to-be Inbox whose card B (head v2) is a dialog in the pane without a card.
  private func paneDialogStore() async throws -> (RarogStore, FakeTransport) {
    let (store, transport) = try await inboxStore()
    transport.push(.global, json: #"""
      {"type":"inbox-head","head":\#(InboxWire.head("B", version: "v2", kind: "decision", state: "waiting-permission",
                                                    at: "2026-10-03T09:04:00.000Z", dialog: "panel"))}
      """#)
    await until("B on a pane dialog") { store.state.inboxItems.first { $0.id == "B" }?.head.dialog == .panel }
    transport.inbox.card(
      InboxWire.card("B", version: "v2", kind: "decision", state: "waiting-permission", text: "Running tests.",
                     dialog: #"{"kind":"panel"}"#),
      for: "B")
    return (store, transport)
  }

  @Test("a pane dialog card without the session's transcript → the transcript loads, then Esc goes out")
  func paneDialogWithoutTranscript() async throws {
    let (store, transport) = try await paneDialogStore()
    #expect(store.state.transcripts["B"] == nil)
    let early = HerdrDialogSignature(try #require(store.state.sessions["B"]))
    #expect(await store.decideDialog(sessionId: "B", decision: .deny, seen: early) == .notShown)
    store.inboxOpened()
    await until("transcript stream of B") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    transport.push(.session(id: "B"), json: #"""
      {"type":"transcript-snapshot","sessionId":"B","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
      """#)
    await until("the pane dialog's signature") { store.state.herdrDialogSignature(for: "B") != nil }
    let seen = try #require(store.state.herdrDialogSignature(for: "B"))
    #expect(await store.decideDialog(sessionId: "B", decision: .deny, seen: seen) == .accepted)
    #expect(transport.read { $0.dialogDecisions.map(\.sessionId) } == ["B"])
    #expect(transport.read { $0.dialogDecisions.map(\.body.decision) } == [.deny])
    // One read: the stream closes after its snapshot and is not opened again for the same version.
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.streamCalls.count { $0.scope == .session(id: "B") } == 1)
  }

  @Test("a pane dialog card whose session stream answers 404 is not asked again for that version")
  func paneDialogGoneStream() async throws {
    let (store, transport) = try await paneDialogStore()
    transport.set { $0.openFailures = [.http(APIFailure(status: 404, code: "session-not-found"))] }
    store.inboxOpened()
    await until("transcript stream of B") { transport.streamCalls.contains { $0.scope == .session(id: "B") } }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.streamCalls.count { $0.scope == .session(id: "B") } == 1)
    #expect(store.state.herdrDialogSignature(for: "B") == nil)
  }

  @Test("a reconnect (inbox-heads) asks a stream that answered 404 once more, also for the same version")
  func goneStreamForgottenOnReconnect() async throws {
    let (store, transport) = try await inboxStoreWithGoneStream()
    transport.push(.global, json: #"""
      {"type":"inbox-heads","heads":[\#(InboxWire.head("A", at: "2026-10-03T09:05:00.000Z")),
      \#(InboxWire.head("B", kind: "decision", state: "waiting-permission", at: "2026-10-03T09:04:00.000Z",
                        dialog: "permission"))]}
      """#)
    await until("second transcript stream of B") {
      transport.streamCalls.count { $0.scope == .session(id: "B") } == 2
    }
    pushSnapshot(transport, "B", permId: "p1")
    await until("decision") { decidedPermId(store, "B") == "p1" }
  }

  // MARK: - Reply from a card

  @Test("a reply to card A is the person's ordinary send to A: no sender pair, the card held")
  func replyIsAnOrdinarySend() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    let outcome = await store.replyFromInbox("Ship it", to: "A", turnId: "t-A")
    guard case .sent(.accepted) = outcome else {
      Issue.record("accepted: \(outcome)")
      return
    }
    let sent = transport.read { $0.messages }
    #expect(sent.map(\.sessionId) == ["A"])
    #expect(sent.first?.body.text == "Ship it")
    #expect(sent.first?.body.source == nil && sent.first?.body.expectedConversation == nil)
    #expect(store.state.inbox.held["A"] != nil, "the card stays in place")
    // The session starts working on the reply: the held card stays.
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("A", state: "running"))}"#)
    await until("running") { store.state.sessions["A"]?.state == .running }
    #expect(store.state.inboxItems.contains { $0.id == "A" })
  }

  @Test("a reply to a session never opened: accepted, no Not confirmed after the deadline; opening it reconciles")
  func replyToNeverOpenedSession() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    guard case let .sent(.accepted(id)) = await store.replyFromInbox("Ship it", to: "A", turnId: "t-A") else {
      Issue.record("not accepted")
      return
    }
    try await Task.sleep(for: fastTiming.unconfirmedAfter * 3)
    #expect(store.state.outbox.first?.state.isSent == true, "accepted, still waiting for its echo")
    store.openSession("A")
    await until("session stream") { transport.streamCalls.contains { $0.scope == .session(id: "A") } }
    let echo = #"""
      {"seq":1,"role":"user","blocks":[{"type":"text","text":"Ship it"}],"at":"\#(ISOTime.string(Date()))",
      "clientMessageId":"\#(id.uuidString.lowercased())"}
      """#
    transport.push(.session(id: "A"), json: #"""
      {"type":"transcript-snapshot","sessionId":"A","messages":[\#(echo)],"pendingPermissions":[],"pendingQuestions":[]}
      """#)
    await until("reconciled") { store.state.outbox.isEmpty }
  }

  @Test("the card gone (the session works) or another turn before ↑ → nothing goes out")
  func replyToAChangedCard() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(InboxWire.head("A", turn: "t-A2", version: "v2", at: "2026-10-03T09:06:00.000Z"))}"#)
    await until("new turn") { store.state.inboxItems.first { $0.id == "A" }?.head.turnId == "t-A2" }
    #expect(await store.replyFromInbox("Ship it", to: "A", turnId: "t-A") == .cardChanged, "another turn")
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("A", state: "running"))}"#)
    await until("hidden") { !store.state.inboxItems.contains { $0.id == "A" } }
    #expect(await store.replyFromInbox("Ship it", to: "A", turnId: "t-A2") == .cardChanged, "the card hid")
    #expect(await store.replyFromInbox("Allow it", to: "B", turnId: "t-B") == .cardChanged, "a decision card")
    #expect(transport.read { $0.messages.isEmpty })
    #expect(store.state.outbox.isEmpty)
    #expect(store.state.inbox.held.isEmpty, "a refused reply holds nothing")
  }

  @Test("a result card of a session in a Rarog terminal takes no reply: no target, a reply refused, nothing goes out")
  func replyToATerminalSession() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    let hosted = Frames.summary("A", state: "waiting-input", extra: #","termId":"0123456789abcdef""#)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(hosted)}"#)
    await until("terminal") { store.state.sessions["A"]?.termId != nil }
    #expect(store.state.inboxItems.contains { $0.id == "A" }, "the card stands")
    #expect(store.state.inboxReplyTarget("A") == nil)
    #expect(await store.replyFromInbox("Ship it", to: "A", turnId: "t-A") == .cardChanged)
    #expect(transport.read { $0.messages.isEmpty })
    #expect(store.state.outbox.isEmpty)
    #expect(store.state.inbox.held["A"] == nil)
  }

  @Test("A stopped on a dialog while its result card still stands → the send's refusal, nothing goes out, no hold")
  func replyToASessionOnADialog() async throws {
    let (store, transport) = try await inboxStore()
    store.inboxOpened()
    // The head follows a state change about half a second later: the result card still stands on its old head.
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("A", state: "waiting-permission"))}"#)
    await until("dialog") { store.state.sessions["A"]?.state == .waitingPermission }
    #expect(store.state.inboxReplyTarget("A")?.turnId == "t-A")
    #expect(await store.replyFromInbox("Ship it", to: "A", turnId: "t-A") == .sent(.blocked(.decisionPending)))
    #expect(transport.read { $0.messages.isEmpty })
    #expect(store.state.inbox.held["A"] == nil)
  }

  @Test("quick replies to two cards → each goes to its own session")
  func repliesToTwoCards() async throws {
    let (store, transport) = try await inboxStore()
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("C", state: "waiting-input"))}"#)
    transport.push(.global, json: #"{"type":"inbox-head","head":\#(InboxWire.head("C", at: "2026-10-03T09:06:00.000Z"))}"#)
    await until("C") { store.state.inboxReplyTarget("C") != nil }
    store.inboxOpened()
    async let first = store.replyFromInbox("For A", to: "A", turnId: "t-A")
    async let second = store.replyFromInbox("For C", to: "C", turnId: "t-C")
    let outcomes = await [first, second]
    #expect(outcomes.allSatisfy { if case .sent(.accepted) = $0 { true } else { false } })
    let sent = transport.read { $0.messages.map { "\($0.sessionId):\($0.body.text)" } }
    #expect(Set(sent) == ["A:For A", "C:For C"])
  }

  @Test("a fresh transcript of a session kept in memory: its next stream opens without a cursor, the one after resumes")
  func freshTranscriptOpensWithoutCursor() async throws {
    let (store, transport) = try await inboxStore()
    store.openSession("A")
    await until("stream of A") { transport.streamCalls.contains { $0.scope == .session(id: "A") } }
    transport.push(.session(id: "A"), json: #"""
      {"type":"transcript-snapshot","sessionId":"A","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
      """#, id: "c1")
    await until("snapshot") { store.state.transcripts["A"]?.snapshots == 1 }
    store.openSession(nil)
    store.refreshTranscript("A")
    store.openSession("A")
    await until("second stream") { transport.streamCalls.count { $0.scope == .session(id: "A") } == 2 }
    #expect(transport.streamCalls.last { $0.scope == .session(id: "A") }?.lastEventId == nil, "the memory is not enough")

    // Already on screen: the request opens the stream again, without a cursor.
    store.refreshTranscript("A")
    await until("third stream") { transport.streamCalls.count { $0.scope == .session(id: "A") } == 3 }
    #expect(transport.streamCalls.last { $0.scope == .session(id: "A") }?.lastEventId == nil)
    transport.push(.session(id: "A"), json: #"""
      {"type":"transcript-snapshot","sessionId":"A","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
      """#, id: "c2")
    await until("snapshot") { store.state.transcripts["A"]?.snapshots == 2 }
    store.openSession(nil)
    store.openSession("A")
    await until("fourth stream") { transport.streamCalls.count { $0.scope == .session(id: "A") } == 4 }
    #expect(transport.streamCalls.last { $0.scope == .session(id: "A") }?.lastEventId == "c2", "one request, one fresh open")
  }
}
