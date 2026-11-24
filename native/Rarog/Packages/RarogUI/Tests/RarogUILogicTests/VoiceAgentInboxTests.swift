import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The voice agent on an Inbox card (`VoiceAgentInboxConversation`, `VoiceAgentInboxHost`): the start waits for a fresh
// transcript snapshot of the card's session, `show_prompt` puts the prompt in the card's block and the app reads it
// aloud, `send_prompt` sends a prompt heard whole as the card's plain reply after the person's word, the block's Send
// button and the send's recovery, the hand-back of the text at the end, a decision card talks without a prompt, one
// card at a time, and the ends with their reasons. Fakes: the route to Rarog `FakeVoiceAgentBackend`,
// `VoiceAgentFakeDevice`, the reply fields as `InboxReplies` keeps them, drafts in memory. All session data is
// synthetic. Owner: voice agent.

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

extension FakeVoiceAgentBackend: VoiceAgentInboxBackend {}

private func frame(_ json: String) -> ServerEvent {
  // swiftlint:disable:next force_try
  try! EventDecoder.decode(Data(json.utf8)).get().event
}

private func head(_ id: String, turn: String? = nil, kind: String = "result", state: String = "waiting-input") -> String {
  #"""
  {"sessionId":"\#(id)","turnId":"\#(turn ?? "t-\(id)")","version":"v-\#(turn ?? id)","kind":"\#(kind)",
   "state":"\#(state)","at":"\#(Sample.iso(60))"}
  """#
}

private func json(_ value: String) -> String {
  String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// The tool result is a result, not an error.
private func isResult(_ output: String) -> Bool {
  ((try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any])?["result"] != nil
}

private func error(_ output: String) -> String {
  ((try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any])?["error"] as? String ?? ""
}

/// The reply fields of the Inbox screen as the screen's host keeps them (`InboxReplies`): a field stands for a result
/// card on screen.
@MainActor
private final class Fields: VoiceAgentInboxField {
  var replies = InboxReplies()
  /// Cards whose reply field is on screen.
  var shown: Set<String> = ["A", "B"]
  private(set) var handedBack: [String] = []
  private(set) var finished: [(outcome: InboxReplyOutcome, text: String)] = []

  func handBack(_ text: String, note: String?, noteIsError: Bool, into sessionId: String) -> Bool {
    guard shown.contains(sessionId) else { return false }
    replies.giveBack(sessionId, text: text, note: note, isError: noteIsError, shownTurn: "t-\(sessionId)")
    handedBack.append("\(sessionId) \(text)")
    return true
  }

  func voiceReplyFinished(_ outcome: InboxReplyOutcome, text: String, sessionId: String) {
    finished.append((outcome, text))
  }
}

/// The Inbox with three cards over the fakes: result cards A and B, a decision card D, on a server that offers the
/// voice agent without the mode across sessions. A has a transcript in memory from an earlier visit.
@MainActor
private final class Rig {
  let backend = FakeVoiceAgentBackend()
  let settings = VoiceAgentSettings.memory()
  let center = DictationCenter()
  let device = VoiceAgentFakeDevice()
  let clock = ManualScheduler()
  let fields = Fields()
  let drafts = ComposerDrafts()
  var place = VoiceAgentInboxPlace(inboxOnScreen: true, openedSession: nil, background: false)
  /// The navigation's voice target, as the owner sets it.
  private(set) var target: String?
  private(set) var owner: VoiceAgentInboxConversation!

  init() {
    var state = appState(
      [session("A", label: "Alpha"), session("B", label: "Birch"),
       session("D", label: "Dunes", state: "waiting-permission")],
      sessionsMode: false)
    state.capabilities = Capabilities(
      Sample.decode(
        VersionInfo.self,
        #"{"version":"1","protocolVersion":3,"serverStartId":"s","companionEnabled":true,"companionSpeech":true,"inbox":true}"#))
    _ = state.apply(
      .frame(
        frame(#"{"type":"inbox-heads","heads":[\#(head("A")),\#(head("B")),\#(head("D", kind: "decision", state: "waiting-permission"))]}"#),
        source: .global, cursor: nil),
      now: Sample.now)
    backend.state = state
    snapshot("A")
    settings.acceptConsent()
    owner = VoiceAgentInboxConversation(
      backend: backend, settings: settings, sonioxAllowed: true, drafts: drafts, microphone: center, scheduler: clock,
      dependencies: { [unowned self] in self.device.dependencies($0) })
    owner.field = fields
    owner.place = { [unowned self] in self.place }
    owner.onTarget = { [unowned self] in self.target = $0 }
  }

  func card(_ id: String) throws -> InboxCardModel {
    try #require(backend.state.inboxCardModels.first { $0.id == id })
  }

  /// A `transcript-snapshot` of `id` arrives (its stream opened), and the app state change reaches the owner.
  func snapshot(_ id: String, messages: String = "[]") {
    apply(
      #"{"type":"transcript-snapshot","sessionId":"\#(id)","messages":\#(messages),"pendingPermissions":[],"pendingQuestions":[]}"#,
      source: .session(id))
  }

  func apply(_ json: String, source: FrameSource = .global) {
    _ = backend.state.apply(.frame(frame(json), source: source, cursor: nil), now: Sample.now)
    owner?.observe()
  }

  /// Starts the conversation on card `id` and brings it to listening after the fresh snapshot.
  func ready(_ id: String) async throws {
    let before = device.sockets.count
    owner.toggle(try card(id))
    snapshot(id)
    await device.ready(try #require(owner.session), socketsBefore: before)
  }

  /// The person asks, and `response` calls `show_prompt` with `text`; returns the Soniox stream of its reading.
  func show(_ text: String, response: String = "r1") async throws -> String {
    device.utterance("in-\(response)")
    return try await device.readingCall(response, name: "show_prompt", arguments: #"{"text":\#(json(text))}"#)
  }

  /// The reading on `stream` plays out whole with the microphone audio around it, so its mark lies at 1000 ms on the
  /// input axis; the model's question after the result is silent. Returns the result of `show_prompt`.
  func readWhole(_ stream: String, response: String = "r1") async throws -> String {
    let before = device.outputs.count
    try device.input(milliseconds: 990)
    try device.playReading(stream)
    try device.input(milliseconds: 10)
    #expect(await eventually { device.outputs.count == before + 1 })
    answered("\(response)f")
    return device.outputs.last ?? ""
  }

  /// A tool call in its own response that answers at once (no reading), and the model's silent answer to its result;
  /// returns its output.
  func call(_ response: String, name: String, arguments: String = "{}") async -> String {
    let before = device.outputs.count
    device.socket.reply(RealtimeSample.created(response))
    device.socket.reply(RealtimeSample.call(response, id: "c-\(response)", name: name, arguments: arguments))
    device.socket.reply(RealtimeSample.done(response))
    #expect(await eventually { device.outputs.count > before })
    answered("\(response)f")
    return device.outputs.last ?? ""
  }

  /// The model's silent answer `response` (after a tool result or a cut reading).
  func answered(_ response: String) {
    device.socket.reply(RealtimeSample.created(response))
    device.socket.reply(RealtimeSample.done(response))
  }

  /// The person's word after the reading (by the VAD's time), then `send_prompt` in `response`; its output.
  func confirmAndSend(_ response: String = "r2", startMs: Int = 50_000) async -> String {
    device.utterance("in-\(response)", startMs: startMs)
    return await call(response, name: "send_prompt")
  }
}

/// Ways the conversation of a card ends from outside.
enum InboxVoiceEnd: String, CaseIterable, Sendable {
  case cardRemoved = "the card removed"
  case inboxLeft = "the Inbox left"
  case otherSession = "another session opened"
  case cleared = "/clear in the card's session"

  var reason: VoiceAgentWatch.Reason {
    switch self {
    case .cardRemoved: .cardGone
    case .inboxLeft: .inboxLeft
    case .otherSession: .sessionChanged
    case .cleared: .sessionCleared
    }
  }
}

@MainActor
@Suite("voice agent on an Inbox card: fresh transcript, the prompt block, the plain reply, one card, the ends")
struct VoiceAgentInboxTests {
  @Test("a start sets the voice target and asks a fresh snapshot; the transcript kept in memory is not enough")
  func startWaitsForFreshSnapshot() async throws {
    let rig = Rig()
    #expect(rig.backend.state.transcripts["A"]?.snapshots == 1, "A's transcript is in memory from an earlier visit")
    rig.owner.toggle(try rig.card("A"))
    #expect(rig.target == "A" && rig.backend.refreshes == ["A"])
    #expect(rig.owner.isActive && rig.owner.indicator == .connecting && rig.owner.indicatorCard == "A")
    rig.owner.observe()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(rig.owner.session == nil && rig.device.sockets.isEmpty && rig.backend.tokenCalls == 0)
    rig.snapshot("A")
    await rig.device.ready(try #require(rig.owner.session))
    #expect(rig.owner.indicator == .listening)
  }

  @Test("no snapshot within the limit → the start is refused with a sentence, no key, the target goes")
  func noSnapshotRefusesStart() throws {
    let rig = Rig()
    rig.owner.toggle(try rig.card("A"))
    rig.clock.advance(VoiceAgentInboxConversation.snapshotLimit)
    #expect(!rig.owner.isActive && rig.owner.indicator == .ended(.unavailable))
    #expect(rig.owner.session == nil && rig.backend.tokenCalls == 0 && rig.target == nil)
    // A late snapshot starts nothing.
    rig.snapshot("A")
    #expect(rig.owner.session == nil)
  }

  @Test("the card changes while the snapshot is awaited (another turn) → the start is refused")
  func cardChangeWhileConnecting() throws {
    let rig = Rig()
    rig.owner.toggle(try rig.card("A"))
    rig.apply(#"{"type":"inbox-head","head":\#(head("A", turn: "t-A2"))}"#)
    #expect(!rig.owner.isActive && rig.owner.indicator == .closed(.cardChanged) && rig.target == nil)
    rig.snapshot("A")
    #expect(rig.owner.session == nil && rig.backend.tokenCalls == 0)
  }

  // MARK: - show_prompt

  /// Catches a prompt that lands in the person's field, a reading of another text than the block's, and a block that
  /// never counts as heard whole.
  @Test("show_prompt puts the prompt in its block and the app reads exactly its text; read whole, the block is ready")
  func showReadsTheBlockVerbatim() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let text = "Run the tests  🐛, then fix what fails."
    let stream = try await rig.show(text)
    #expect(rig.device.speechText(stream) == text)
    let block = try #require(rig.owner.block)
    #expect(block.text == text && block.turnId == "t-A" && block.phase == .reading && block.version == 1)
    #expect(rig.owner.readProgress?.end == nil)
    #expect(rig.fields.replies.field("A") == nil, "the reply field is untouched")
    let result = try await rig.readWhole(stream)
    #expect(isResult(result) && result.contains("whole"), "\(result)")
    #expect(rig.owner.block?.phase == .ready && rig.owner.block?.heardWhole == true)
    #expect(rig.owner.readProgress == ReadingProgress(spokenPrefix: text.count, end: .whole))
    #expect(rig.backend.inboxReplies.isEmpty)
  }

  // Catches a card's conversation that names another session or passes the block's text to the app's microphone, a
  // waiting block the Live Activity never shows, and a Send button whose block change no observer learns (the
  // activity would keep asking for a yes or no).
  @Test("the microphone names the card's session; a block read aloud waits for the word, without its text")
  func microphoneSubject() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let target = try #require(rig.backend.state.sessions["A"])
    let subject = MicrophoneSubject.session(project: target.title, name: target.label)
    expectNamesOnly(rig.center.use, subject, phase: .listening, hiding: [])
    let text = "Run the tests, then fix what fails."
    _ = try await rig.readWhole(try await rig.show(text))
    expectNamesOnly(rig.center.use, subject, phase: .prompt, hiding: [text])
    let calls = Calls()
    rig.center.observe { [calls] in calls.count += 1 }
    rig.owner.sendBlock()
    #expect(calls.count > 0 && rig.center.use?.phase == .listening, "the sending block waits for no word")
  }

  @Test(
    "show_prompt: 1000 characters are read; 1001 and a blank text are refused with a reason and no reading",
    arguments: ["1000", "1001", "blank"])
  func showArguments(_ input: String) async throws {
    let rig = Rig()
    try await rig.ready("A")
    let streams = rig.device.speechSocket.texts.count
    switch input {
    case "1000":
      let stream = try await rig.show(String(repeating: "x", count: 1000))
      #expect(rig.device.speechText(stream).count == 1000)
      #expect(rig.owner.block?.phase == .reading)
    default:
      let text = input == "1001" ? String(repeating: "x", count: 1001) : "  \n "
      let output = await rig.call("r1", name: "show_prompt", arguments: #"{"text":\#(json(text))}"#)
      #expect(error(output).contains(input == "1001" ? "longer than 1000" : "empty"), "\(output)")
      #expect(rig.owner.block == nil)
      #expect(rig.device.speechSocket.texts.count == streams, "nothing went to Soniox")
    }
  }

  // MARK: - send_prompt

  /// Catches a send of a prompt not heard whole or not confirmed, a second request, and a send that takes the card's
  /// turn of the send instead of the turn the person heard the prompt against.
  @Test("send_prompt after the whole reading and the person's word sends once, with the turn of the show")
  func sendAfterWordOnceWithShowTurn() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    let early = await rig.call("r2", name: "send_prompt")
    #expect(error(early).contains("Not confirmed"), "\(early)")
    // The card moves on to another turn of the session; the block keeps the turn of the show.
    rig.apply(#"{"type":"inbox-head","head":\#(head("A", turn: "t-A2"))}"#)
    #expect(rig.owner.isActive)
    let sent = await rig.confirmAndSend("r3")
    #expect(isResult(sent), "\(sent)")
    #expect(rig.backend.inboxReplies.map { "\($0.sessionId) \($0.turnId) \($0.text)" } == ["A t-A Run the tests"])
    #expect(rig.owner.block == nil)
    #expect(await eventually { rig.owner.indicator == .sent }, "the card says the prompt went")
    let again = await rig.confirmAndSend("r4", startMs: 60_000)
    #expect(!isResult(again) && rig.backend.inboxReplies.count == 1, "\(again)")
    #expect(rig.backend.sends.isEmpty, "no voice agent prompt with source and expectedConversation")
  }

  @Test("a reading cut by the person's speech leaves the prompt unheard: send_prompt refuses and nothing goes")
  func cutReadingRefusesTheVoiceSend() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    rig.device.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    rig.device.speechOver("in-cut")
    rig.answered("r1c")
    #expect(await eventually { rig.owner.block?.phase == .ready })
    #expect(rig.owner.block?.heardWhole == false && rig.owner.readProgress?.end == .cut)
    let output = await rig.confirmAndSend("r2")
    #expect(error(output).contains("did not hear the prompt to its end"), "\(output)")
    #expect(rig.backend.inboxReplies.isEmpty)
  }

  // MARK: - The block's Send button and the recovery

  /// Catches a reading that plays on after the person took the prompt into their own hands, a version counted heard
  /// whole, a result of the cut reading for the model, and a second send.
  @Test("the Send button during the reading stops its audio and sends the agent's text once; the version stays unheard")
  func sendButtonDuringReading() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    rig.device.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    let clears = rig.device.audio.clears
    let outputs = rig.device.outputs.count
    rig.backend.holdReply = true
    rig.owner.sendBlock()
    #expect(rig.device.cancelledReading(stream) && rig.device.audio.clears == clears + 1, "the reading's audio stops")
    #expect(await eventually { rig.backend.replyPending })
    #expect(rig.owner.block?.phase == .sending && rig.owner.block?.heardWhole == false)
    #expect(rig.owner.readProgress == nil)
    rig.owner.sendBlock()
    rig.backend.releaseReply()
    #expect(await eventually { rig.owner.block == nil })
    #expect(rig.backend.inboxReplies.map(\.text) == ["Run the tests"])
    #expect(rig.device.outputs.count == outputs, "the cut reading gives the model no result")
  }

  /// Catches a reading that plays on under the person's edit, and a voice send of a version cut by the edit.
  @Test("Edit during the reading stops its audio and edits the agent's text; after Cancel the voice send refuses")
  func editDuringReadingStopsTheAudio() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    rig.device.speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    let clears = rig.device.audio.clears
    rig.owner.edit()
    #expect(rig.device.cancelledReading(stream) && rig.device.audio.clears == clears + 1, "the reading's audio stops")
    #expect(rig.owner.block?.phase == .editing && rig.owner.block?.edited == "Run the tests")
    #expect(rig.owner.block?.heardWhole == false && rig.owner.readProgress == nil)
    rig.owner.cancelEdit()
    #expect(rig.owner.block?.phase == .ready && rig.owner.block?.heardWhole == false)
    let output = await rig.confirmAndSend("r2")
    #expect(error(output).contains("did not hear the prompt to its end"), "\(output)")
    #expect(rig.backend.inboxReplies.isEmpty)
  }

  /// Catches a block that stands again against a card that changed (every Send would meet the same refusal), a text
  /// lost, and one that lands both in the field and in the draft.
  @Test(
    "a changed card ends the block and hands its text to the card's field with the reason, otherwise to the draft once",
    arguments: [("agent", true), ("agent", false), ("edited", true)])
  func changedCardHandsTheTextBack(_ text: String, _ fieldShown: Bool) async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    if text == "edited" {
      rig.owner.edit()
      rig.owner.editText("Run the tests twice")
    }
    let sent = text == "edited" ? "Run the tests twice" : "Run the tests"
    if !fieldShown { rig.fields.shown = [] }
    rig.backend.inboxReplyOutcome = .cardChanged
    rig.owner.sendBlock()
    #expect(await eventually { rig.owner.block == nil })
    #expect(rig.backend.inboxReplies.map(\.text) == [sent])
    if fieldShown {
      #expect(rig.fields.handedBack == ["A \(sent)"])
      #expect(rig.fields.replies.field("A")?.note == UICopy.inboxReplyCardChanged)
      #expect(rig.drafts.peek(for: "A").draft == nil)
    } else {
      #expect(rig.fields.handedBack.isEmpty)
      #expect(rig.drafts.take(for: "A") == ComposerDrafts.Draft(text: sent, note: UICopy.inboxReplyCardChanged))
      #expect(rig.drafts.take(for: "A") == nil, "once")
    }
    #expect(rig.owner.isActive, "the conversation goes on")
  }

  @Test("a refused send stands again in the block, edited text included, and its outbox entry is deleted")
  func refusedSendRestoresTheBlock() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    rig.owner.edit()
    rig.owner.editText("Run the tests twice")
    let entry = UUID()
    rig.backend.inboxReplyOutcome = .sent(.refused(entry, code: "conflict", message: "Test: refused."))
    rig.owner.sendBlock()
    #expect(await eventually { rig.owner.block?.phase == .editing })
    #expect(rig.owner.block?.edited == "Run the tests twice" && rig.owner.block?.reason != nil)
    #expect(rig.backend.discarded == [entry])
    #expect(rig.backend.inboxReplies.map(\.text) == ["Run the tests twice"])
  }

  @Test("the Inbox out of sight when a send could not be stored → the block goes and its text lands in the draft once")
  func unstoredSendOutOfSightGoesToTheDraft() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    rig.backend.holdReply = true
    rig.backend.inboxReplyOutcome = .sent(.notPersisted("disk full"))
    rig.owner.sendBlock()
    #expect(await eventually { rig.backend.replyPending })
    rig.place.inboxOnScreen = false
    rig.backend.releaseReply()
    #expect(await eventually { rig.owner.block == nil })
    #expect(rig.drafts.take(for: "A") == ComposerDrafts.Draft(text: "Run the tests", note: UICopy.notPersisted))
    #expect(rig.fields.handedBack.isEmpty && rig.backend.unhandled.count == 1)
  }

  @Test("a blank edited text: the block's Send sends nothing")
  func blankEditSendsNothing() async throws {
    let rig = Rig()
    try await rig.ready("A")
    _ = try await rig.show("Run the tests")
    rig.owner.edit()
    rig.owner.editText("  \n")
    #expect(!rig.owner.blockSendable)
    rig.owner.sendBlock()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(rig.backend.inboxReplies.isEmpty && rig.owner.block?.phase == .editing)
  }

  // MARK: - The end hands the text back

  /// Catches a text lost at the end, and one that lands both in the field and in the draft.
  @Test(
    "the end hands the block's text back: the field on screen takes it, otherwise the session's draft",
    arguments: [("button", true), ("button", false), ("inbox left", true)])
  func endHandsTheTextBack(_ end: String, _ fieldShown: Bool) async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    rig.owner.edit()
    rig.owner.editText("Run the tests twice")
    if !fieldShown { rig.fields.shown = [] }
    if end == "button" {
      rig.owner.toggle(try rig.card("A"))
    } else {
      rig.place.inboxOnScreen = false
      rig.owner.observe()
    }
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.block == nil)
    if fieldShown && end == "button" {
      #expect(rig.fields.handedBack == ["A Run the tests twice"])
      #expect(rig.drafts.peek(for: "A").draft == nil)
    } else {
      #expect(rig.fields.handedBack.isEmpty)
      #expect(rig.drafts.take(for: "A")?.text == "Run the tests twice")
    }
    #expect(rig.backend.inboxReplies.isEmpty)
  }

  /// Catches an outcome of an earlier send that changes the newer block, or that marks the newer conversation sent.
  @Test("the outcome of A's send after its conversation ended leaves B's block alone and goes the field's way")
  func olderSendOutcomeLeavesTheNewerBlock() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let stream = try await rig.show("Run the tests")
    _ = try await rig.readWhole(stream)
    rig.backend.holdReply = true
    rig.owner.sendBlock()
    #expect(await eventually { rig.backend.replyPending }, "A's reply is on its way")
    try await rig.ready("B")
    #expect(rig.fields.handedBack.isEmpty, "the text in flight keeps its own recovery")
    let second = try await rig.show("Tag the release", response: "b1")
    _ = try await rig.readWhole(second, response: "b1")
    let shown = try #require(rig.owner.block)
    rig.backend.inboxReplyOutcome = .cardChanged
    rig.backend.releaseReply()
    #expect(await eventually { rig.fields.finished.count == 1 }, "A's outcome came")
    #expect(rig.fields.finished.first?.text == "Run the tests")
    #expect(rig.owner.block == shown, "B's block is as it was")
    #expect(rig.owner.indicator != .sent && rig.owner.target == "B" && rig.owner.isActive)
  }

  // MARK: - The model's texts, the decision card, mute

  /// The card's conversation gets its own edit rule: on the session screen the person may edit the prompt and a send
  /// takes the field as it is, on the card an edit in the block cancels the voice send. Both reach the model through
  /// the instructions and the tool descriptions of each host's content.
  @Test("the card's instructions and tool descriptions state the card's edit rule; the session screen keeps its own")
  func cardEditRuleReachesTheModel() throws {
    let backend = FakeVoiceAgentBackend()
    let card = VoiceAgentInboxHost(
      sessionId: "A", backend: backend, showPrompt: { _, _ in .output("") }, sendPrompt: { _ in "" }
    ).content()
    let screen = VoiceAgentSessionHost(sessionId: "A", backend: backend).content()
    func texts(_ content: RealtimeConversation.Content) -> (instructions: String, show: String, send: String) {
      let descriptions = Dictionary(
        uniqueKeysWithValues: content.tools.map { ($0.name, $0.schema["description"] as? String ?? "") })
      return (
        content.instructions(RealtimeProjector.budget), descriptions[RealtimeTool.showPrompt.rawValue] ?? "",
        descriptions[RealtimeTool.sendPrompt.rawValue] ?? ""
      )
    }
    let cardTexts = texts(card)
    let screenTexts = texts(screen)
    let cardRule = RealtimePromptField.inboxReply.editRule
    let screenRule = RealtimePromptField.messageField.editRule
    #expect(cardRule != screenRule)
    #expect(cardTexts.instructions.contains(cardRule) && !cardTexts.instructions.contains(screenRule))
    #expect(cardTexts.send.contains(cardRule))
    #expect(screenTexts.instructions.contains(screenRule) && !screenTexts.instructions.contains(cardRule))
    // The card's texts never let the model count on an edited prompt going out by voice, nor read it itself.
    for text in [cardTexts.instructions, cardTexts.show, cardTexts.send] {
      #expect(!text.contains("may edit") && !text.contains("may have edited"), "\(text)")
    }
    #expect(cardTexts.instructions.contains("Do not read the prompt yourself"))
    #expect(screenTexts.instructions.contains("may edit") && screenTexts.send.contains("may have edited"))
    #expect(cardTexts.show != screenTexts.show && cardTexts.send != screenTexts.send)
  }

  @Test("a decision card: the conversation answers by voice, show_prompt and send_prompt refuse")
  func decisionCardTalksWithoutPrompt() async throws {
    let rig = Rig()
    try await rig.ready("D")
    rig.device.utterance("in1")
    rig.device.socket.reply(RealtimeSample.created("r1"))
    rig.device.socket.reply(
      RealtimeSample.call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"What does it want?"}"#))
    rig.device.socket.reply(
      RealtimeSample.call("r1", id: "c2", name: "show_prompt", arguments: #"{"text":"Allow it"}"#))
    rig.device.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { rig.device.outputs.count == 2 })
    #expect(rig.backend.questions == ["What does it want?"])
    #expect(rig.device.outputs.contains { $0.contains("answer") })
    #expect(rig.device.outputs.contains { error($0).contains("decision") })
    #expect(rig.owner.block == nil)
    rig.device.socket.reply(RealtimeSample.created("r1f"))
    rig.device.socket.reply(RealtimeSample.done("r1f"))
    let result = await rig.confirmAndSend("r2")
    #expect(!isResult(result))
    #expect(rig.backend.inboxReplies.isEmpty && rig.owner.isActive)
  }

  @Test("the row's microphone mutes the card's conversation and unmutes it; the end resets it")
  func muteFollowsTheConversation() async throws {
    let rig = Rig()
    try await rig.ready("A")
    rig.owner.toggleMute()
    #expect(rig.owner.muted && rig.owner.session?.muted == true)
    rig.owner.toggleMute()
    #expect(!rig.owner.muted)
    rig.owner.toggleMute()
    rig.owner.toggle(try rig.card("A"))
    #expect(!rig.owner.isActive && !rig.owner.muted)
    rig.owner.toggleMute()
    #expect(!rig.owner.muted, "no conversation: nothing")
  }

  @Test("a mute while the conversation connects shows at once and holds once the conversation runs")
  func muteWhileConnecting() async throws {
    let rig = Rig()
    let before = rig.device.sockets.count
    rig.owner.toggle(try rig.card("A"))
    #expect(rig.owner.isActive && rig.owner.session == nil)
    rig.owner.toggleMute()
    #expect(rig.owner.muted, "the button shows the mute before the conversation runs")
    rig.snapshot("A")
    await rig.device.ready(try #require(rig.owner.session), socketsBefore: before)
    #expect(rig.owner.session?.muted == true && rig.owner.muted)
    rig.owner.toggleMute()
    #expect(!rig.owner.muted && rig.owner.session?.muted == false)
  }

  // MARK: - One card, the ends

  @Test("a start on card B during the conversation on A ends A and starts B; the other buttons are dimmed")
  func startOnAnotherCard() async throws {
    let rig = Rig()
    try await rig.ready("A")
    let first = try #require(rig.owner.session)
    #expect(rig.owner.dims("B") && rig.owner.dims("D") && !rig.owner.dims("A"))
    try await rig.ready("B")
    #expect(!first.isActive, "the conversation on A ended")
    #expect(rig.owner.session !== first && rig.owner.session?.isActive == true)
    #expect(rig.target == "B" && rig.backend.refreshes == ["A", "B"])
    #expect(rig.owner.dims("A") && !rig.owner.dims("B"))
    rig.owner.toggle(try rig.card("B"))
    #expect(!rig.owner.isActive && rig.target == nil && !rig.owner.dims("A"), "a second tap on B ends it")
  }

  @Test("the conversation of a card ends from outside with its reason, and the voice target goes", arguments: InboxVoiceEnd.allCases)
  func ends(_ end: InboxVoiceEnd) async throws {
    let rig = Rig()
    try await rig.ready("A")
    switch end {
    case .cardRemoved:
      rig.apply(#"{"type":"inbox-removed","sessionId":"A","turnId":"t-A"}"#)
    case .inboxLeft:
      rig.place.inboxOnScreen = false
      rig.owner.observe()
    case .otherSession:
      rig.place = VoiceAgentInboxPlace(inboxOnScreen: false, openedSession: "B", background: false)
      rig.owner.observe()
    case .cleared:
      rig.snapshot(
        "A",
        messages: #"[{"seq":7,"role":"system","blocks":[{"type":"text","text":"New conversation.","ref":{"code":"transcript.repoint-clear"}}],"at":"\#(Sample.iso(1))"}]"#)
    }
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.indicator == .closed(end.reason))
    #expect(rig.target == nil)
  }

  // Catches a card conversation that the background still ends with the locked-phone trial on (the trial would do
  // nothing at the Inbox), or one the background keeps with the trial off.
  @Test(
    "the background ends a ready card conversation with the trial off and keeps it with the trial on",
    arguments: [false, true])
  func backgroundWithTrial(on: Bool) async throws {
    let rig = Rig()
    rig.settings.lockedPhoneTrial.set(on)
    try await rig.ready("A")
    rig.place.background = true
    rig.owner.observe()
    try? await Task.sleep(for: .milliseconds(20))
    if on {
      #expect(rig.owner.isActive && rig.owner.session?.isActive == true && rig.target == "A")
      #expect(!rig.device.socket.closed && rig.device.audio.stops == 0)
    } else {
      #expect(!rig.owner.isActive && rig.owner.indicator == .closed(.background))
      #expect(rig.device.socket.closed && rig.device.audio.stops > 0)
    }
  }

  // Catches a start that the trial lets through in the background, or a start waiting for its snapshot that it keeps:
  // the microphone would open with the app in the background.
  @Test("with the trial on the background ends a start that waits for its snapshot and refuses a new one; no audio")
  func backgroundStartWithTrial() async throws {
    let rig = Rig()
    rig.settings.lockedPhoneTrial.set(true)
    rig.owner.toggle(try rig.card("A"))
    rig.place.background = true
    rig.owner.observe()
    #expect(!rig.owner.isActive && rig.owner.indicator == .closed(.background))
    rig.owner.toggle(try rig.card("A"))
    rig.snapshot("A")
    try? await Task.sleep(for: .milliseconds(20))
    #expect(!rig.owner.isActive && rig.owner.indicator == .closed(.background))
    #expect(rig.device.audio.starts == 0 && rig.device.sockets.isEmpty && rig.backend.tokenCalls == 0)
  }

  @Test("the voice agent switched off in Settings ends the card's conversation by itself: the microphone and the stream close")
  func settingsSwitchOffEnds() async throws {
    let rig = Rig()
    try await rig.ready("A")
    // No call from outside and no change of the app state: the owner follows the switch itself.
    rig.settings.disable()
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.indicator == .closed(.disabled))
    #expect(rig.device.socket.closed && rig.device.audio.stops > 0)
    #expect(rig.target == nil)
  }
}
