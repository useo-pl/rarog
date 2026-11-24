import Foundation
import RarogContract
@testable import RarogCore
import Testing

// The Inbox model in the reducer and selectors: which cards stand, their order, the counter, holding, and how the
// stream's heads replace, update and remove cards. Owner: Inbox.

/// Inbox wire JSON for tests, decoded by the same decoder as the stream.
enum InboxWire {
  static func head(
    _ sessionId: String, turn: String? = nil, version: String = "v1", kind: String = "result",
    state: String = "waiting-input", at: String, dialog: String? = nil
  ) -> String {
    let dialogField = dialog.map { #","dialog":"\#($0)""# } ?? ""
    return #"""
      {"sessionId":"\#(sessionId)","turnId":"\#(turn ?? "t-\(sessionId)")","version":"\#(version)",
      "kind":"\#(kind)","state":"\#(state)","at":"\#(at)"\#(dialogField)}
      """#
  }

  static func card(
    _ sessionId: String, turn: String? = nil, version: String = "v1", kind: String = "result",
    state: String = "waiting-input", at: String = "2026-10-03T09:00:00.000Z", text: String = "Done.",
    dialog: String? = nil
  ) -> String {
    let dialogField = dialog.map { #","dialog":\#($0)"# } ?? ""
    return #"""
      {"sessionId":"\#(sessionId)","turnId":"\#(turn ?? "t-\(sessionId)")","version":"\#(version)",
      "kind":"\#(kind)","state":"\#(state)","at":"\#(at)","text":\#(Frames.quoted(text)),"truncated":false\#(dialogField)}
      """#
  }

  static func permissionDialog(_ requestId: String?) -> String {
    let id = requestId.map { #","requestId":"\#($0)""# } ?? ""
    return #"{"kind":"permission","waitingFor":{"kind":"permission","tool":"Read","text":"cat plik"}\#(id)}"#
  }

  static func heads(_ heads: [String]) throws -> ServerEvent {
    try Frames.decode(#"{"type":"inbox-heads","heads":[\#(heads.joined(separator: ","))]}"#)
  }

  static func headFrame(_ head: String) throws -> ServerEvent {
    try Frames.decode(#"{"type":"inbox-head","head":\#(head)}"#)
  }

  static func removed(_ sessionId: String, turn: String? = nil) throws -> ServerEvent {
    try Frames.decode(#"{"type":"inbox-removed","sessionId":"\#(sessionId)","turnId":"\#(turn ?? "t-\(sessionId)")"}"#)
  }

  static func version(capabilities: [String]) throws -> VersionInfo {
    let list = capabilities.map { #""\#($0)""# }.joined(separator: ",")
    let json = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":[\#(list)]}"#
    return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  static func cards(_ cards: [String]) throws -> [InboxCard] {
    try JSONDecoder().decode(InboxList.self, from: Data(#"{"cards":[\#(cards.joined(separator: ","))]}"#.utf8)).cards
  }
}

@Suite("Inbox model: visible cards, order, counter, holding and heads")
struct InboxModelTests {
  private let now = Date(timeIntervalSince1970: 1_790_000_000)

  /// The sessions of the plan's example: A unread result, B on a permission, C received result with a background
  /// command, D working with a card from its last result, E stopped on an error.
  private func example() throws -> AppState {
    var state = AppState(clientBuild: 7)
    let command = workflowTask("t-cmd", run: false, kind: "command")
    state.apply(.frame(try Frames.snapshot([
      Frames.summary("A", state: "waiting-input"),
      Frames.summary("B", state: "waiting-permission"),
      Frames.summary("C", state: "waiting-input", extra: #","seen":true,"backgroundTasks":[\#(command)]"#),
      Frames.summary("D", state: "running"),
      Frames.summary("E", state: "error"),
    ]), source: .global, cursor: nil), now: now)
    state.apply(.frame(try InboxWire.heads([
      InboxWire.head("A", at: "2026-10-03T09:05:00.000Z"),
      InboxWire.head("B", kind: "decision", state: "waiting-permission", at: "2026-10-03T09:04:00.000Z",
                     dialog: "permission"),
      InboxWire.head("C", at: "2026-10-03T09:03:00.000Z"),
      InboxWire.head("D", state: "running", at: "2026-10-03T09:06:00.000Z"),
      InboxWire.head("E", kind: "failed", state: "error", at: "2026-10-03T09:01:00.000Z"),
    ]), source: .global, cursor: nil), now: now)
    return state
  }

  @Test("A unread, B permission, C received with a background command, D running, E error → A B C E by at; the button counts all 4")
  func visibleOrderAndCount() throws {
    let state = try example()
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
    #expect(state.inboxCount == 4)
  }

  @Test("a held working card stands; its new result changes the text in place; leaving the Inbox ends the hold")
  func holding() throws {
    var state = try example()
    state.apply(.inbox(.opened(true)), now: now)
    state.apply(.inbox(.held(sessionId: "D")), now: now)
    #expect(state.inboxItems.map(\.id) == ["D", "A", "B", "C", "E"])
    #expect(state.inboxItems.first?.held == true)
    #expect(state.inboxCount == 5)

    // The turn ends with a new result, newer than every other card: the held card does not jump.
    state.apply(.frame(try Frames.state("D", "waiting-input", since: "2026-10-03T09:10:00.000Z"), source: .global,
                       cursor: nil), now: now)
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("D", turn: "t-D-next", version: "v2",
                                                              at: "2026-10-03T09:10:00.000Z")),
                       source: .global, cursor: nil), now: now)
    state.apply(.inbox(.cardRead(sessionId: "D", card: try InboxWire.cards([
      InboxWire.card("D", turn: "t-D-next", version: "v2", at: "2026-10-03T09:10:00.000Z", text: "New result."),
    ]).first)), now: now)
    #expect(state.inboxItems.map(\.id) == ["D", "A", "B", "C", "E"])
    #expect(state.inboxItems.first?.card?.text == "New result.")

    state.apply(.inbox(.opened(false)), now: now)
    #expect(state.inboxItems.first?.id == "D")
    #expect(state.inboxItems.allSatisfy { !$0.held })
    state.apply(.frame(try Frames.state("D", "running", since: "2026-10-03T09:12:00.000Z"), source: .global,
                       cursor: nil), now: now)
    #expect(!state.inboxItems.contains { $0.id == "D" })
  }

  @Test("a turn just ended: the live state shows the result before the head does, so the old card stays hidden")
  func headLagsBehindTheSession() throws {
    var state = try example()
    state.apply(.frame(try Frames.state("D", "waiting-input", since: "2026-10-03T09:10:00.000Z"), source: .global,
                       cursor: nil), now: now)
    #expect(!state.inboxItems.contains { $0.id == "D" })
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("D", turn: "t-D-next", version: "v2",
                                                              at: "2026-10-03T09:10:00.000Z")),
                       source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.first?.id == "D")
  }

  @Test("the text of an older version is not shown under a newer head")
  func textMatchesTheHeadVersion() throws {
    var state = try example()
    state.apply(.inbox(.cardsRead(try InboxWire.cards([InboxWire.card("A", text: "Old.")]))), now: now)
    #expect(state.inboxItems.first?.card?.text == "Old.")
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("A", version: "v2", at: "2026-10-03T09:05:00.000Z")),
                       source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.first?.card == nil)
  }

  @Test("inbox-removed for A → A is gone; a removal of another turn does not remove the current card")
  func removedFrame() throws {
    var state = try example()
    state.apply(.frame(try InboxWire.removed("A", turn: "t-old"), source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
    state.apply(.frame(try InboxWire.removed("A"), source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.map(\.id) == ["B", "C", "E"])
  }

  @Test("inbox-heads after a reconnect replaces the cards; a server switch and the loss of `inbox` clear them")
  func headsReplaceAndClear() throws {
    var state = try example()
    state.apply(.inbox(.opened(true)), now: now)
    state.apply(.frame(try InboxWire.heads([InboxWire.head("E", kind: "failed", state: "error",
                                                           at: "2026-10-03T09:01:00.000Z")]),
                       source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.map(\.id) == ["E"])

    state.apply(.versionProbed(try InboxWire.version(capabilities: ["inbox"])), now: now)
    #expect(state.inboxAvailable && state.inboxItems.map(\.id) == ["E"])
    state.apply(.versionProbed(try InboxWire.version(capabilities: [])), now: now)
    #expect(!state.inboxAvailable && state.inbox.heads.isEmpty)
    #expect(state.inbox.open)

    var switched = try example()
    switched.apply(.switchingServer, now: now)
    #expect(switched.inbox.heads.isEmpty && switched.inboxItems.isEmpty)
  }

  @Test("Inbox frames count only from the global stream")
  func onlyGlobalFrames() throws {
    var state = try example()
    state.apply(.frame(try InboxWire.removed("A"), source: .session("A"), cursor: nil), now: now)
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
  }

  @Test("a removed card hides at once by its turn; the next turn's card of that session shows")
  func removalHidesByTurn() throws {
    var state = try example()
    state.apply(.inbox(.removeStarted(sessionId: "A", at: now)), now: now)
    #expect(state.inboxItems.map(\.id) == ["B", "C", "E"])
    #expect(state.inboxCount == 3)
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("A", turn: "t-A2", at: "2026-10-03T09:20:00.000Z")),
                       source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.first?.id == "A")
  }

  /// B held after its decision; its text read before.
  private func heldDecision() throws -> AppState {
    var state = try example()
    state.apply(.inbox(.opened(true)), now: now)
    state.apply(.inbox(.cardsRead(try InboxWire.cards([
      InboxWire.card("B", kind: "decision", state: "waiting-permission", text: "Running the tests.",
                     dialog: InboxWire.permissionDialog("p1")),
    ]))), now: now)
    state.apply(.inbox(.held(sessionId: "B")), now: now)
    state.apply(.frame(try Frames.state("B", "running", since: "2026-10-03T09:08:00.000Z"), source: .global,
                       cursor: nil), now: now)
    return state
  }

  @Test("a held decision card in the first turn: the server drops its card while the session works; it stays in place")
  func heldDecisionSurvivesItsRemovalWhileWorking() throws {
    var state = try heldDecision()
    state.apply(.frame(try InboxWire.removed("B"), source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
    let held = try #require(state.inboxItems.first { $0.id == "B" })
    #expect(held.held && held.head.kind == .decision && held.card?.text == "Running the tests.")
    #expect(state.inboxCount == 4)

    state.apply(.frame(try Frames.state("B", "waiting-input", since: "2026-10-03T09:12:00.000Z"), source: .global,
                       cursor: nil), now: now)
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("B", turn: "t-B-next", version: "v2",
                                                              at: "2026-10-03T09:12:00.000Z")),
                       source: .global, cursor: nil), now: now)
    state.apply(.inbox(.cardRead(sessionId: "B", card: try InboxWire.cards([
      InboxWire.card("B", turn: "t-B-next", version: "v2", text: "Tests pass."),
    ]).first)), now: now)
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
    #expect(state.inboxItems.first { $0.id == "B" }?.card?.text == "Tests pass.")
  }

  @Test("a held decision card after an earlier result: the working session's head is that older turn; the card keeps its text")
  func heldDecisionIgnoresTheOlderResultWhileWorking() throws {
    var state = try heldDecision()
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("B", turn: "t-B-earlier", version: "v0",
                                                              state: "running", at: "2026-10-03T08:30:00.000Z")),
                       source: .global, cursor: nil), now: now)
    let held = try #require(state.inboxItems.first { $0.id == "B" })
    #expect(held.head.turnId == "t-B" && held.card?.text == "Running the tests.")
    #expect(state.inboxItems.map(\.id) == ["A", "B", "C", "E"])
  }

  @Test("a decision card takes the question of its session's transcript by requestId; no transcript, no decision")
  func questionDecisionFromTheTranscript() throws {
    var state = AppState(clientBuild: 7)
    state.apply(.frame(try Frames.snapshot([Frames.summary("Q", state: "waiting-question")]), source: .global,
                       cursor: nil), now: now)
    state.apply(.frame(try InboxWire.heads([
      InboxWire.head("Q", kind: "decision", state: "waiting-question", at: "2026-10-03T09:00:00.000Z",
                     dialog: "question"),
    ]), source: .global, cursor: nil), now: now)
    let dialog = #"{"kind":"question","waitingFor":{"kind":"question","text":"Który?","count":1},"requestId":"q1"}"#
    state.apply(.inbox(.cardsRead(try InboxWire.cards([
      InboxWire.card("Q", kind: "decision", state: "waiting-question", dialog: dialog),
    ]))), now: now)
    #expect(state.inboxDecision("Q") == nil)
    state.apply(.frame(try Frames.transcript("Q", questions: [Frames.question("Q", qId: "q0"),
                                                              Frames.question("Q", qId: "q1")]),
                       source: .session("Q"), cursor: nil), now: now)
    guard case let .question(request, attempt) = state.inboxDecision("Q") else {
      Issue.record("a question decision")
      return
    }
    #expect(request.qId == "q1" && attempt == nil)
  }

  @Test("a removal hides only the removed card: the next decision of the same turn shows and its Undo end keeps it")
  func removalHidesOnlyThatCard() throws {
    var state = try example()
    state.apply(.inbox(.removeStarted(sessionId: "B", at: now)), now: now)
    state.apply(.inbox(.removeFinished(sessionId: "B", turnId: "t-B", version: "v1", result: .done)), now: now)
    #expect(!state.inboxItems.contains { $0.id == "B" })
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("B", version: "v2", kind: "decision",
                                                              state: "waiting-permission",
                                                              at: "2026-10-03T09:04:30.000Z", dialog: "permission")),
                       source: .global, cursor: nil), now: now)
    #expect(state.inboxItems.first { $0.id == "B" }?.head.version == "v2")
    state.apply(.inbox(.undoExpired(sessionId: "B", at: now)), now: now)
    #expect(state.inboxItems.first { $0.id == "B" }?.head.version == "v2")
    #expect(state.inbox.removals["B"] == nil)
  }

  @Test("the late answer of an earlier removal does not settle the removal of the next card of the same turn")
  func lateRemovalAnswerBelongsToItsCard() throws {
    var state = try example()
    state.apply(.inbox(.removeStarted(sessionId: "B", at: now)), now: now)
    state.apply(.inbox(.removeFinished(sessionId: "B", turnId: "t-B", version: "v1", result: .done)), now: now)
    state.apply(.inbox(.restoreStarted(sessionId: "B")), now: now)
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("B", version: "v2", kind: "decision",
                                                              state: "waiting-permission",
                                                              at: "2026-10-03T09:04:30.000Z", dialog: "permission")),
                       source: .global, cursor: nil), now: now)
    let later = now.addingTimeInterval(1)
    state.apply(.inbox(.removeStarted(sessionId: "B", at: later)), now: later)
    state.apply(.inbox(.restoreFinished(sessionId: "B", turnId: "t-B", version: "v1", restored: true)), now: later)
    #expect(state.inbox.removals["B"]?.head.version == "v2")
    #expect(!state.inboxItems.contains { $0.id == "B" })
  }

  @Test("a late read of an older version, or a late empty answer, does not replace the text of the current head")
  func lateReadKeepsTheCurrentText() throws {
    var state = try example()
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("A", version: "v3", at: "2026-10-03T09:05:00.000Z")),
                       source: .global, cursor: nil), now: now)
    state.apply(.inbox(.cardsRead(try InboxWire.cards([InboxWire.card("A", version: "v3", text: "Third.")]))), now: now)
    #expect(state.inboxItems.first?.card?.text == "Third.")
    state.apply(.inbox(.cardRead(sessionId: "A", card: try InboxWire.cards([
      InboxWire.card("A", version: "v2", text: "Second."),
    ]).first)), now: now)
    #expect(state.inboxItems.first?.card?.text == "Third.")
    state.apply(.inbox(.cardRead(sessionId: "A", card: nil)), now: now)
    #expect(state.inboxItems.first?.card?.text == "Third.")
  }

  /// D held while it worked; its turn ended with a new result `v2` whose text arrived, in place.
  private func heldWithNewResult() throws -> AppState {
    var state = try example()
    state.apply(.inbox(.opened(true)), now: now)
    state.apply(.inbox(.held(sessionId: "D")), now: now)
    state.apply(.frame(try Frames.state("D", "waiting-input", since: "2026-10-03T09:10:00.000Z"), source: .global,
                       cursor: nil), now: now)
    state.apply(.frame(try InboxWire.headFrame(InboxWire.head("D", turn: "t-D-next", version: "v2",
                                                              at: "2026-10-03T09:10:00.000Z")),
                       source: .global, cursor: nil), now: now)
    state.apply(.inbox(.cardRead(sessionId: "D", card: try InboxWire.cards([
      InboxWire.card("D", turn: "t-D-next", version: "v2", at: "2026-10-03T09:10:00.000Z", text: "New result."),
    ]).first)), now: now)
    return state
  }

  @Test("a held card takes over its new result: when the session works again it shows that result, in place",
        arguments: [true, false])
  func heldCardTakesOverItsNewResult(holdBeforeWork: Bool) throws {
    var state = try heldWithNewResult()
    let running = try Frames.state("D", "running", since: "2026-10-03T09:11:00.000Z")
    if holdBeforeWork {
      state.apply(.inbox(.held(sessionId: "D")), now: now)
      state.apply(.frame(running, source: .global, cursor: nil), now: now)
    } else {
      state.apply(.frame(running, source: .global, cursor: nil), now: now)
      state.apply(.inbox(.held(sessionId: "D")), now: now)
    }
    let held = try #require(state.inboxItems.first { $0.id == "D" })
    #expect(held.held && held.head.version == "v2" && held.card?.text == "New result.")
    #expect(state.inbox.held["D"]?.at == "2026-10-03T09:06:00.000Z")
  }

  @Test("a session that left the waiting states (resumable) hides its card, though its head still waits for input")
  func staleCardOfAnEndedSessionHides() throws {
    var state = try example()
    state.apply(.frame(try Frames.state("A", "resumable", since: "2026-10-03T09:20:00.000Z"), source: .global,
                       cursor: nil), now: now)
    #expect(state.sessions["A"]?.state == .resumable)
    #expect(state.inbox.heads["A"] != nil)
    #expect(state.inboxItems.map(\.id) == ["B", "C", "E"])
  }
}
