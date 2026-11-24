import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The voice conversation at a session in the app: the short-lived key from the server route with refusals by code,
// the tools (`ask_session` → the `ask` route, `show_prompt` → the message field, `send_prompt` → the send of the
// field, the same operation as ↑), the end of the conversation at session and login events, the entry button and
// the `client.log` lines. Fakes: socket, audio and clock from `RealtimeConversationTests`, the route to Rarog
// `FakeVoiceAgentBackend`, the message field of the screen in `Harness` (`VoiceAgentDraft` as the screen uses it).
// Owner: voice agent.

// MARK: - The route to Rarog

@MainActor
final class FakeVoiceAgentBackend: VoiceAgentBackend {
  var token: CompanionTokenOutcome = .token(
    Sample.decode(CompanionToken.self, #"{"value":"ek_test_session","expiresAt":"2026-11-10T12:01:00.000Z","model":"gpt-realtime-2.1"}"#))
  var answer: CompanionAskOutcome = .answer(
    Sample.decode(CompanionAnswer.self, #"{"answer":"It was fixed in turn 2.","found":true}"#))
  var speechToken: CompanionSpeechTokenOutcome = .token(
    Sample.decode(
      CompanionSpeechToken.self,
      #"{"apiKey":"snx_temp_session_speech","expiresAt":"2099-01-01T00:00:00.000Z","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#
    ))
  var loginEpoch = 1
  var messages: [TranscriptMessage] = []
  private(set) var tokenCalls = 0
  private(set) var speechTokenCalls = 0
  private(set) var questions: [String] = []
  private(set) var traces: [String] = []
  /// Budget of each line in `traces`, in the same order.
  private(set) var traceBudgets: [TraceBudget] = []
  /// The key waits for `releaseToken()` (the conversation ends while the key is fetched).
  var holdToken = false
  private var tokenWaiters: [CheckedContinuation<Void, Never>] = []

  func releaseToken() {
    let waiting = tokenWaiters
    tokenWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  var tokenPending: Bool { !tokenWaiters.isEmpty }

  func companionToken() async -> CompanionTokenOutcome {
    tokenCalls += 1
    if holdToken { await withCheckedContinuation { tokenWaiters.append($0) } }
    return token
  }

  func companionSpeechToken() async -> CompanionSpeechTokenOutcome {
    speechTokenCalls += 1
    return speechToken
  }

  /// Outcomes of the next questions in order; with none left, ``answer``.
  var answers: [CompanionAskOutcome] = []
  /// Held questions whose task was cancelled while they waited (the store's request is cancelled with its task).
  private(set) var cancelledAsks = 0

  func ask(sessionId: String, question: String) async -> CompanionAskOutcome {
    questions.append(question)
    reads.append("ask \(sessionId)")
    if holdAsk {
      await withTaskCancellationHandler {
        await withCheckedContinuation { waiter in
          // Cancelled before the wait: the handler below already ran and found no waiter.
          if Task.isCancelled { waiter.resume() } else { askWaiters.append(waiter) }
        }
      } onCancel: {
        Task { @MainActor in self.cancelHeldAsks() }
      }
      if Task.isCancelled {
        cancelledAsks += 1
        return .cancelled
      }
    }
    return answers.isEmpty ? answer : answers.removeFirst()
  }

  private func cancelHeldAsks() {
    let waiting = askWaiters
    askWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  // The mode across sessions (`VoiceAgentSessionsHostTests`): the app state, the catalog and the turns of each
  // session; `reads` logs the catalog, turns and ask requests in order.
  var state = AppState(clientBuild: 1)
  func sessionSummary(_ sessionId: String) -> SessionSummary? { state.sessions[sessionId] }
  var catalog: CompanionSessionsOutcome = .sessions([])
  /// Turns answers by session id; one without an entry answers 404 (outside the catalog).
  var turns: [String: CompanionTurnsOutcome] = [:]
  private(set) var reads: [String] = []
  /// Runs while a catalog read is in flight (the app state changes before its answer).
  var onCatalog: (@MainActor () -> Void)?

  func loadCompanionSessions() async -> CompanionSessionsOutcome {
    reads.append("catalog")
    onCatalog?()
    if holdCatalog { await withCheckedContinuation { catalogWaiters.append($0) } }
    return catalog
  }

  /// The catalog read waits for `releaseCatalog()` (a tool's catalog read held open).
  var holdCatalog = false
  private var catalogWaiters: [CheckedContinuation<Void, Never>] = []
  var catalogPending: Bool { !catalogWaiters.isEmpty }

  func releaseCatalog() {
    let waiting = catalogWaiters
    catalogWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  /// Outcomes of the next prompt sends in order; with none left, `sent`. `sends` logs every call, `requests` the calls
  /// that reach the server: as in the store, a call with an id already sent or queued answers `sent` with none.
  var sendOutcomes: [CompanionSendOutcome] = []
  private(set) var sends: [(sessionId: String, text: String, conversation: String, id: UUID)] = []
  private(set) var requests = 0
  private var acceptedIds: Set<UUID> = []
  /// The send waits for `releaseSend()`; a send whose task was cancelled while it waited counts in `cancelledSends`.
  var holdSend = false
  private var sendWaiters: [CheckedContinuation<Void, Never>] = []
  private(set) var cancelledSends = 0
  var sendPending: Bool { !sendWaiters.isEmpty }
  /// Runs while a prompt send that reaches the server is in flight.
  var onSend: (@MainActor () -> Void)?

  func releaseSend() {
    let waiting = sendWaiters
    sendWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  func sendCompanionPrompt(sessionId: String, text: String, conversation: String, clientMessageId: UUID) async
    -> CompanionSendOutcome
  {
    sends.append((sessionId, text, conversation, clientMessageId))
    if acceptedIds.contains(clientMessageId) { return .sent }
    requests += 1
    onSend?()
    if holdSend {
      await withTaskCancellationHandler {
        await withCheckedContinuation { waiter in
          if Task.isCancelled { waiter.resume() } else { sendWaiters.append(waiter) }
        }
      } onCancel: {
        Task { @MainActor in self.releaseSend() }
      }
      if Task.isCancelled {
        cancelledSends += 1
        return .cancelled
      }
    }
    let outcome = sendOutcomes.isEmpty ? .sent : sendOutcomes.removeFirst()
    if outcome == .sent || outcome == .queued { acceptedIds.insert(clientMessageId) }
    return outcome
  }

  /// Runs while a turns read is in flight.
  var onTurns: (@MainActor () -> Void)?

  func loadCompanionTurns(sessionId: String, count: Int) async -> CompanionTurnsOutcome {
    reads.append("turns \(sessionId) \(count)")
    onTurns?()
    return turns[sessionId] ?? .outsideCatalog(message: nil)
  }

  /// What a pick-up answers; `pickUps` logs each pick-up's session id, `conversation` and `readMark` in order.
  var pickUpOutcome: CompanionPickUpOutcome = .pickedUp
  private(set) var pickUps: [(sessionId: String, conversation: String, readMark: String)] = []

  func pickUpCompanionResult(sessionId: String, conversation: String, readMark: String) async
    -> CompanionPickUpOutcome
  {
    pickUps.append((sessionId, conversation, readMark))
    return pickUpOutcome
  }

  /// The question waits for `releaseAsk()` (the seconds counter of "Checking the session").
  var holdAsk = false
  private var askWaiters: [CheckedContinuation<Void, Never>] = []
  var askPending: Bool { !askWaiters.isEmpty }

  func releaseAsk() {
    let waiting = askWaiters
    askWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  func transcript(sessionId: String) -> [TranscriptMessage] { messages }

  // The conversation of an Inbox card (`VoiceAgentInboxTests`): the fresh transcript asked of each session, and each
  // reply from a card with its outcome.
  private(set) var refreshes: [String] = []
  private(set) var inboxReplies: [(text: String, sessionId: String, turnId: String)] = []
  var inboxReplyOutcome = InboxReplyOutcome.sent(.accepted(UUID()))
  /// A reply waits for `releaseReply()` (its outcome comes late).
  var holdReply = false
  private var replyWaiters: [CheckedContinuation<Void, Never>] = []
  var replyPending: Bool { !replyWaiters.isEmpty }

  func releaseReply() {
    let waiting = replyWaiters
    replyWaiters = []
    for waiter in waiting { waiter.resume() }
  }

  func refreshTranscript(_ sessionId: String) {
    refreshes.append(sessionId)
  }

  func replyFromInbox(_ text: String, to sessionId: String, turnId: String) async -> InboxReplyOutcome {
    inboxReplies.append((text, sessionId, turnId))
    if holdReply { await withCheckedContinuation { replyWaiters.append($0) } }
    return inboxReplyOutcome
  }

  /// Outbox entries a card's send deleted, and the unexpected failures it reported.
  private(set) var discarded: [UUID] = []
  private(set) var unhandled: [String] = []

  func discard(_ entryId: UUID) { discarded.append(entryId) }
  func reportUnhandled(_ summary: String) { unhandled.append(summary) }

  func trace(_ line: String, budget: TraceBudget) {
    traces.append(line)
    traceBudgets.append(budget)
  }
}

// MARK: - Zdarzenia serwera

private let speechStarted = #"{"type":"input_audio_buffer.speech_started","item_id":"in1","audio_start_ms":100}"#
private let speechStopped = #"{"type":"input_audio_buffer.speech_stopped","item_id":"in1","audio_end_ms":900}"#

private func committed(_ item: String) -> String { #"{"type":"input_audio_buffer.committed","item_id":"\#(item)"}"# }
private func created(_ id: String) -> String { #"{"type":"response.created","response":{"id":"\#(id)"}}"# }
private func done(_ id: String) -> String {
  #"{"type":"response.done","response":{"id":"\#(id)","status":"completed","output":[]}}"#
}

private func call(_ response: String, id: String, name: String, arguments: String = "{}") -> String {
  let args = arguments.replacing("\"", with: "\\\"")
  return
    #"{"type":"response.function_call_arguments.done","response_id":"\#(response)","item_id":"fc_\#(id)","call_id":"\#(id)","name":"\#(name)","arguments":"\#(args)"}"#
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

private func message(_ seq: Int, _ role: String, _ text: String, ref: String? = nil) -> TranscriptMessage {
  let refField = ref.map { #","ref":{"code":"\#($0)"}"# } ?? ""
  return Sample.decode(
    TranscriptMessage.self,
    #"{"seq":\#(seq),"role":"\#(role)","blocks":[{"type":"text","text":"\#(text)"\#(refField)}],"at":"2026-11-10T10:00:00.000Z"}"#)
}

/// Stan z jedną sesją Claude Code, zalogowany, z serwerem, który daje agenta.
/// `speech`: the server announces Soniox speech too (`companionSpeech`), which the voice agent needs.
private func appState(messages: [TranscriptMessage] = [], companion: Bool = true, speech: Bool = true) -> AppState {
  var state = Sample.state(session: Sample.session(), messages: messages)
  state.auth = .loggedIn
  let field = (companion ? #","companionEnabled":true"# : "") + (speech ? #","companionSpeech":true"# : "")
  state.capabilities = Capabilities(
    Sample.decode(VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(field)}"#))
  return state
}

private func input(
  _ state: AppState, login: Int = 1, enabled: Bool = true, sonioxAllowed: Bool = true, selected: String? = "s1",
  background: Bool = false, keepsInBackground: Bool = false, fieldShown: Bool = true
) -> VoiceAgentWatch.Input {
  VoiceAgentWatch.Input(
    state: state, sessionId: "s1", login: login, enabled: enabled, sonioxAllowed: sonioxAllowed, selected: selected,
    background: background, keepsInBackground: keepsInBackground, fieldShown: fieldShown)
}

/// Rozmowa przy sesji `s1` z atrapami; `ready()` doprowadza ją do słuchania.
@MainActor
private final class Harness {
  let backend = FakeVoiceAgentBackend()
  let audio = RealtimeFakeAudio()
  let scheduler = ManualScheduler()
  var sockets: [RealtimeFakeSocket] = []
  /// The message field of the screen: its text, the reason when it is read-only, attachments in the bar, and the
  /// prompt of the agent in it (`VoiceAgentDraft`, as `SessionViewController+VoiceAgent.swift` keeps it).
  var field = ""
  var readOnly: String?
  var attachments = false
  var draft = VoiceAgentDraft()
  /// The send operation of the field: a refusal before anything is taken (read-only, app command, attachments),
  /// otherwise the field is taken and `storeResult` comes back.
  var refusal: ComposerSendResult?
  var storeResult = ComposerSendResult.accepted(queued: false)
  /// Fields the send operation took, in order.
  private(set) var sentFields: [String] = []
  /// Every indicator the session reported, in order.
  var indicators: [VoiceAgentIndicator?] = []
  var levels: [RealtimeLevels] = []
  /// Soniox speech sockets: Soniox speaks the answers with the key from the server route.
  var speechSockets: [MockSocket] = []
  private(set) var session: VoiceAgentSession!
  /// The session screen's host of the conversation, wired like the screen does.
  private(set) var host: VoiceAgentSessionHost!
  /// The app state the screen reports to the host (`VoiceAgentSessionHost.watchInput`).
  var appInput = input(appState())

  init() {
    host = VoiceAgentSessionHost(sessionId: "s1", backend: backend)
    session = VoiceAgentSession(
      host: host, backend: backend,
      dependencies: { [unowned self] keys in
        RealtimeConversation.Dependencies(
          keys: keys,
          socket: { request, events in
            let socket = RealtimeFakeSocket(request: request, events: events)
            self.sockets.append(socket)
            return socket
          },
          audio: self.audio, scheduler: self.scheduler,
          speech: RealtimeConversation.Speech(
            keys: keys,
            socket: { url, protocols, events in
              let socket = MockSocket(url: url, protocols: protocols, events: events)
              self.speechSockets.append(socket)
              return socket
            }))
      })
    session.onIndicator = { [unowned self] in self.indicators.append($0) }
    session.onLevels = { [unowned self] in self.levels.append($0) }
    host.watchInput = { [unowned self] in self.appInput }
    host.placePrompt = { [unowned self] text, version in
      if let readOnly = self.readOnly { return RealtimePromptShown(placement: .refused(reason: readOnly)) }
      let insertion = self.draft.place(text, version: version, in: self.field)
      self.field = insertion.text
      return RealtimePromptShown(placement: insertion.placement, attachments: self.attachments)
    }
    host.sendField = { [unowned self] version in
      self.edited(self.field)
      guard self.draft.holds(version: version) else { return nil }
      return await self.sendField()
    }
  }

  /// A change of the field the screen sees (typing, text from code): the prompt follows it, and the conversation
  /// hears when it left the field.
  func edited(_ text: String) {
    field = text
    if draft.observe(text) { session.promptLeftField() }
  }

  /// The send operation of the field (↑ and `send_prompt`): the field and the prompt are taken before the result,
  /// a refused send gives the text back as the user's.
  func sendField() async -> ComposerSendResult {
    if let refusal { return refusal }
    let mark = session.sendMark
    let taken = field
    draft.take()
    session.promptLeftField()
    sentFields.append(taken)
    field = ""
    await Task.yield()
    switch storeResult {
    case .accepted: session.fieldSent(mark)
    case .refused, .blocked: field = taken
    default: break
    }
    return storeResult
  }

  var socket: RealtimeFakeSocket { sockets[sockets.count - 1] }

  func start(_ state: AppState = appState()) {
    start(input(state))
  }

  /// The screen starts the conversation with this app state.
  func start(_ next: VoiceAgentWatch.Input) {
    appInput = next
    session.start()
  }

  /// The app state changed to `next`; the screen tells the conversation.
  func observe(_ next: VoiceAgentWatch.Input) {
    appInput = next
    session.observe()
  }

  func ready() async {
    start()
    #expect(await eventually { !sockets.isEmpty })
    speechSockets.last?.open()
    socket.open()
    socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { session.phase == .listening })
  }

  func utterance(_ item: String) {
    socket.reply(speechStarted)
    socket.reply(speechStopped)
    socket.reply(committed(item))
  }

  /// Answer `response` says its item `item` whole: its text, then `samples` of Soniox PCM and the end of the
  /// synthesis. The item is over once the queue drains.
  func answerSpoken(_ response: String, item: String, samples: Int) {
    let socket = speechSockets[speechSockets.count - 1]
    let before = SpeechSample.streams(socket)
    self.socket.reply(RealtimeSample.textDelta(response, item: item))
    self.socket.reply(
      SpeechSample.encoded(["type": "response.output_text.done", "response_id": response, "item_id": item]))
    guard let stream = SpeechSample.streams(socket).first(where: { !before.contains($0) }) else {
      Issue.record("no Soniox stream for \(item)")
      return
    }
    socket.reply(SpeechSample.audio(stream, Data(count: samples * 2)))
    socket.reply(SpeechSample.terminated(stream))
  }

  /// Wyniki narzędzi wysłane do modelu, w kolejności.
  var outputs: [String] {
    socket.sent("conversation.item.create").compactMap { ($0["item"] as? [String: Any])?["output"] as? String }
  }

  /// The prompt `text` written into the field in response `r1`, then the user's utterance ("yes, send it").
  func cardConfirmed(_ text: String = "Run the tests") async {
    utterance("in1")
    socket.reply(created("r1"))
    socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"\#(text)"}"#))
    socket.reply(done("r1"))
    #expect(await eventually { outputs.count == 1 })
    socket.reply(created("r1f"))
    socket.reply(done("r1f"))
    utterance("in2")
  }
}

// MARK: - Testy

@MainActor
@Suite("rozmowa głosowa przy sesji: klucz, narzędzia, wysyłka, koniec, wejście")
struct VoiceAgentSessionTests {
  // MARK: Sending the field

  @Test("send_prompt without a prompt from show_prompt → tool error, nothing sent")
  func sendWithoutCard() async {
    let h = Harness()
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "send_prompt", arguments: #"{"text":"rm -rf"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 1 })
    #expect(h.outputs[0].contains("error") && h.outputs[0].contains("show_prompt"))
    #expect(h.sentFields.isEmpty)
  }

  @Test("before a new utterance after show_prompt (the same response) → refusal as today, nothing sent")
  func sendInSameResponse() async {
    let h = Harness()
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(call("r1", id: "c2", name: "send_prompt"))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 2 })
    #expect(h.outputs[1].contains("error") && h.outputs[1].contains("not confirmed yet"))
    #expect(h.sentFields.isEmpty)
    #expect(h.field == "Run the tests")
  }

  @Test("confirmed → the whole field goes the way ↑ sends it (the user's text too): “sent”, “Sent to the session”")
  func sendByVoice() async {
    let h = Harness()
    h.field = "Context from me"
    await h.ready()
    await h.cardConfirmed()
    #expect(await h.sendPrompt().contains("sent"))
    #expect(h.sentFields == ["Context from me\nRun the tests"])
    #expect(h.field.isEmpty)
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    #expect(h.session.indicator == .sent)
  }

  @Test("accepted and waiting in the CLI queue → “queued”, “Sent to the session”")
  func sendQueued() async {
    let h = Harness()
    h.storeResult = .accepted(queued: true)
    await h.ready()
    await h.cardConfirmed()
    let output = await h.sendPrompt()
    #expect(output.contains("queued") && !output.contains("error"))
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    #expect(h.session.indicator == .sent)
  }

  @Test(
    "a send that did not go through: the result for the model, the status row unchanged",
    arguments: [
      (ComposerSendResult.unconfirmed, "not confirmed"),
      (.refused(code: "bad-request", message: "This slash command is not allowed."), "bad-request"),
      (.blocked(.herdrReadOnly), "does not take messages"),
      (.notSent, "not sent"),
    ])
  func sendNotThrough(result: ComposerSendResult, phrase: String) async {
    let h = Harness()
    h.storeResult = result
    await h.ready()
    await h.cardConfirmed()
    let output = await h.sendPrompt()
    #expect(output.contains("error") && output.contains(phrase), "\(output)")
    #expect(h.sentFields.count == 1)
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    #expect(h.session.indicator == .listening)
  }

  @Test(
    "refusals before anything is taken: read-only or waiting field, app command, attachments → reason, nothing taken",
    arguments: [
      (ComposerSendResult.readOnly(reason: "Answer the permission card first."), "Answer the permission card first."),
      (.appCommand, "app command"),
      (.attachmentsLoading, "still loading"),
      (.attachmentsOverLimit, "too many attachments"),
    ])
  func sendRefusedBeforeTaking(refusal: ComposerSendResult, phrase: String) async {
    let h = Harness()
    h.refusal = refusal
    await h.ready()
    await h.cardConfirmed()
    let output = await h.sendPrompt()
    #expect(output.contains("error") && output.contains(phrase), "\(output)")
    #expect(h.sentFields.isEmpty)
    #expect(h.field == "Run the tests")
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    #expect(h.session.indicator == .listening)
  }

  @Test(
    "a refused send: the model hears the code and a fixed sentence, never the server's message",
    arguments: [
      ("unknown-command", "unknown-command"),
      ("Unknown command /deploy-xyz", "unknown code"),
    ])
  func sendRefusedWithoutServerText(code: String, phrase: String) async {
    let h = Harness()
    h.storeResult = .refused(code: code, message: "Unknown command: /deploy-xyz.")
    await h.ready()
    await h.cardConfirmed()
    let output = await h.sendPrompt()
    #expect(output.contains("error") && output.contains(phrase), "\(output)")
    #expect(!output.contains("deploy-xyz"), "\(output)")
  }

  @Test("the read-only reason for the model is a fixed name, never the sentence under the field")
  func closedFieldNames() {
    let detail = #""stateDetail":"crash in /Users/demo/deploy-xyz""#
    let error = Sample.state(session: Sample.session(state: "error", extra: detail))
    #expect(VoiceAgentToolText.closedField(state: error, sessionId: "s1") == "session error")
    var old = Sample.state(session: Sample.session(state: "waiting-input"))
    old.compat = .tooOld(minClientBuild: 99)
    #expect(VoiceAgentToolText.closedField(state: old, sessionId: "s1") == "the app and the server versions do not match")
    let open = Sample.state(session: Sample.session(state: "waiting-input"))
    #expect(VoiceAgentToolText.closedField(state: open, sessionId: "s1") == "the session does not take messages now")
  }

  @Test("the user cleared the field: the prompt is gone → “the field no longer holds your prompt”, nothing sent")
  func sendAfterFieldCleared() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.edited("")
    let output = await h.sendPrompt()
    #expect(output.contains("error") && output.contains("no longer holds your prompt"), "\(output)")
    #expect(h.sentFields.isEmpty)
  }

  @Test("the user replaced the prompt by hand (no ↑ in between) → the same refusal")
  func sendAfterPromptReplaced() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.edited("Something else entirely")
    #expect(await h.sendPrompt().contains("no longer holds your prompt"))
    #expect(h.sentFields.isEmpty)
  }

  @Test("the prompt went with ↑: a voice send after it → “the field no longer holds your prompt”")
  func sendAfterButton() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    _ = await h.sendField()
    #expect(h.sentFields == ["Run the tests"])
    #expect(await h.sendPrompt().contains("no longer holds your prompt"))
    #expect(h.sentFields.count == 1)
  }

  @Test("the user edited the prompt (P'): the voice send takes the field with the edit")
  func sendEditedPrompt() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.edited("Run the tests twice")
    #expect(await h.sendPrompt().contains("sent"))
    #expect(h.sentFields == ["Run the tests twice"])
  }

  @Test("once per prompt: a second send_prompt after the same confirmation is refused, nothing sent twice")
  func secondSendRefused() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    #expect(await h.sendPrompt().contains("sent"))
    h.socket.reply(created("r2f"))
    h.socket.reply(call("r2f", id: "c3", name: "send_prompt"))
    h.socket.reply(done("r2f"))
    #expect(await eventually { h.outputs.count == 3 })
    #expect(h.outputs[2].contains("no longer holds your prompt"))
    #expect(h.sentFields.count == 1)
  }

  @Test("two send_prompt calls in one response → one send; the other hears the prompt is gone")
  func parallelSends() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "send_prompt"))
    h.socket.reply(call("r2", id: "c3", name: "send_prompt"))
    h.socket.reply(done("r2"))
    #expect(await eventually { h.outputs.count == 3 })
    #expect(h.sentFields.count == 1)
    #expect(h.outputs.dropFirst().contains { $0.contains("no longer holds your prompt") })
  }

  @Test("a refused send gives the text back as the user's: the prompt is not live again")
  func refusedPromptNotLive() async {
    let h = Harness()
    h.storeResult = .refused(code: "bad-request", message: "No.")
    await h.ready()
    await h.cardConfirmed()
    _ = await h.sendPrompt()
    #expect(h.field == "Run the tests")
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    h.utterance("in3")
    h.socket.reply(created("r3"))
    h.socket.reply(call("r3", id: "c3", name: "send_prompt"))
    h.socket.reply(done("r3"))
    #expect(await eventually { h.outputs.count == 3 })
    #expect(h.outputs[2].contains("no longer holds your prompt"))
    #expect(h.sentFields.count == 1)
  }

  @Test("another login since the start → nothing sent, the model hears the app cannot reach the session")
  func sendAfterLoginChange() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.backend.loginEpoch = 2
    let output = await h.sendPrompt()
    #expect(output.contains("error") && output.contains("cannot reach"))
    #expect(h.sentFields.isEmpty)
  }

  // MARK: Prompt in the field

  @Test(
    "show_prompt writes into the field: empty → the prompt alone; text → the prompt on a new line under it",
    arguments: [
      ("", "Run the tests", "prompt alone in the field"),
      ("   \n", "Run the tests", "prompt alone in the field"),
      ("abc", "abc\nRun the tests", "under the user's text"),
      ("abc \n\n", "abc\nRun the tests", "under the user's text"),
    ])
  func showPromptPlacement(before: String, after: String, result: String) async {
    let h = Harness()
    h.field = before
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 1 })
    #expect(h.field == after)
    #expect(h.outputs[0].contains(result) && !h.outputs[0].contains("error"))
    #expect(!h.outputs[0].contains("Run the tests"))
  }

  @Test("a second prompt over the untouched first one replaces it; over an edited one it goes under it")
  func showPromptAgain() async {
    let h = Harness()
    h.field = "abc"
    await h.ready()
    await h.cardConfirmedWithoutUtterance()
    h.utterance("in2")
    h.socket.reply(created("r2"))
    h.socket.reply(call("r2", id: "c2", name: "show_prompt", arguments: #"{"text":"B"}"#))
    h.socket.reply(done("r2"))
    #expect(await eventually { h.outputs.count == 2 })
    #expect(h.field == "abc\nB")
    #expect(h.outputs[1].contains("replaced your previous prompt, under the user's text"))
    h.socket.reply(created("r2f"))
    h.socket.reply(done("r2f"))
    h.edited("abc\nB, please")
    h.utterance("in3")
    h.socket.reply(created("r3"))
    h.socket.reply(call("r3", id: "c3", name: "show_prompt", arguments: #"{"text":"C"}"#))
    h.socket.reply(done("r3"))
    #expect(await eventually { h.outputs.count == 3 })
    #expect(h.field == "abc\nB, please\nC")
    #expect(h.outputs[2].contains("under the user's text and your earlier edited prompt"))
  }

  @Test("attachments in the bar: the result says they go too, and what a send takes")
  func showPromptWithAttachments() async {
    let h = Harness()
    h.attachments = true
    h.field = "abc"
    await h.ready()
    await h.cardConfirmedWithoutUtterance()
    #expect(h.outputs[0].contains("attachments will go too"))
    #expect(h.outputs[0].contains("A send takes the whole field"))
    let alone = Harness()
    await alone.ready()
    await alone.cardConfirmedWithoutUtterance()
    #expect(alone.outputs[0].contains("A send takes only this prompt"))
  }

  @Test("read-only field → show_prompt refused with the reason, the field untouched, the conversation goes on")
  func showPromptReadOnly() async {
    let h = Harness()
    h.field = "abc"
    h.readOnly = "Answer the permission card first."
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 1 })
    #expect(h.field == "abc")
    #expect(h.outputs[0].contains("error") && h.outputs[0].contains("read-only now: Answer the permission card first."))
    #expect(h.session.isActive)
    #expect(h.session.indicator == .thinking)
  }

  // MARK: Pytanie o sesję

  @Test("ask_session → trasa ask z pytaniem; odpowiedź i propozycja promptu idą do modelu")
  func askRoute() async {
    let h = Harness()
    h.backend.answer = .answer(
      Sample.decode(CompanionAnswer.self, #"{"answer":"Not in the session.","found":false,"prompt":"Check it."}"#))
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"Which key?"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 1 })
    #expect(h.backend.questions == ["Which key?"])
    #expect(h.outputs[0].contains("Not in the session.") && h.outputs[0].contains("Check it."))
  }

  @Test("ask 429 companion-limit → model dostaje zdanie o limicie subskrypcji")
  func askLimit() async {
    let h = Harness()
    h.backend.answer = .limit(message: "The Claude limit is reached.")
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"What failed?"}"#))
    h.socket.reply(done("r1"))
    #expect(await eventually { h.outputs.count == 1 })
    #expect(h.outputs[0].contains("error") && h.outputs[0].lowercased().contains("limit"))
  }

  // MARK: Klucz krótki

  @Test("odmowy klucza → koniec bez gniazda, każda z własnym zdaniem; zły klucz wskazuje rarog voice-agent")
  func tokenRefusals() async {
    let cases: [(CompanionTokenOutcome, RealtimeConversation.End)] = [
      (.keyRejected(message: nil), .keyRejected),
      (.disabled(message: nil), .keyMissing),
      (.throttled(message: nil), .throttled),
      (.openAILimit(message: nil), .openAILimit),
      (.unavailable(message: nil), .unavailable),
    ]
    var sentences: [String] = []
    for (outcome, end) in cases {
      let h = Harness()
      h.backend.token = outcome
      h.start()
      #expect(await eventually { h.session.phase == .ended(end) }, "\(outcome)")
      #expect(h.sockets.isEmpty)
      let sentence = UICopy.voiceAgentEnd(end)
      #expect(!sentence.isEmpty)
      sentences.append(sentence)
    }
    #expect(Set(sentences).count == sentences.count, "każdy powód ma własne zdanie")
    #expect(UICopy.voiceAgentEnd(.keyRejected).contains("rarog voice-agent"))
    #expect(UICopy.voiceAgentEnd(.keyMissing).contains("rarog voice-agent"))
  }

  // MARK: Soniox speech

  @Test("Soniox speech: the key from the speech route opens the Soniox socket; the stream speaks Maya in the app language")
  func speechKeyFromRoute() async throws {
    let h = Harness()
    h.start()
    #expect(await eventually { !h.sockets.isEmpty })
    #expect(h.backend.speechTokenCalls == 1 && h.backend.tokenCalls == 1)
    let socket = try #require(h.speechSockets.first)
    #expect(socket.url.absoluteString == "wss://tts-rt.eu.soniox.com/tts-websocket")
    #expect(socket.protocols == ["soniox-api-key", "snx_temp_session_speech"])
    socket.open()
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.phase == .listening })
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(#"{"type":"response.output_text.delta","response_id":"r1","item_id":"m1","delta":"Hi."}"#)
    let start = try #require(
      socket.texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
        .first { $0["model"] != nil })
    #expect(start["voice"] as? String == "Maya" && start["model"] as? String == "tts-rt-v2")
    #expect(start["language"] as? String == "pl")
    #expect(!h.backend.traces.contains { $0.contains("snx_temp") || $0.contains("Hi.") })
    // Soniox may give the expiry without fractional seconds.
    let whole = Sample.decode(
      CompanionSpeechToken.self,
      #"{"apiKey":"snx_temp_x","expiresAt":"2026-11-11T20:01:00Z","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#
    )
    #expect(SonioxSpeechConfig(whole, language: "en")?.expiresAt == Date(timeIntervalSince1970: 1_794_427_260))
  }

  @Test("speech key refusals → no conversation, no OpenAI socket, a sentence of its own for each reason")
  func speechKeyRefusals() async {
    let wrongRate = Sample.decode(
      CompanionSpeechToken.self,
      #"{"apiKey":"snx_temp_x","expiresAt":"2099-01-01T00:00:00.000Z","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":16000}"#
    )
    let badDate = Sample.decode(
      CompanionSpeechToken.self,
      #"{"apiKey":"snx_temp_x","expiresAt":"soon","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#
    )
    let cases: [(CompanionSpeechTokenOutcome, RealtimeConversation.End)] = [
      (.disabled(message: nil), .speechOff),
      (.throttled(message: nil), .throttled),
      (.unavailable(message: nil), .speechUnavailable),
      (.loggedOut, .speechUnavailable),
      (.refused(message: "x"), .speechUnavailable),
      (.token(wrongRate), .speechUnavailable),
      (.token(badDate), .speechUnavailable),
    ]
    for (outcome, end) in cases {
      let h = Harness()
      h.backend.speechToken = outcome
      h.start()
      #expect(await eventually { h.session.phase == .ended(end) }, "\(outcome)")
      #expect(h.sockets.isEmpty && h.speechSockets.isEmpty)
    }
    let sentences = [RealtimeConversation.End.speechOff, .speechUnavailable, .speechFailed, .throttled, .unavailable]
      .map { UICopy.voiceAgentEnd($0) }
    #expect(Set(sentences).count == sentences.count, "each reason has its own sentence")
    #expect(sentences.allSatisfy { !$0.isEmpty })
  }

  @Test(
    "the voice agent is offered only with companionEnabled, companionSpeech and a build with Soniox",
    arguments: [
      (true, true, true, true), (true, false, true, false), (true, true, false, false), (false, true, true, false),
      (false, false, false, false),
    ])
  func availability(companion: Bool, speech: Bool, buildAllows: Bool, offered: Bool) {
    let state = appState(companion: companion, speech: speech)
    #expect(VoiceAgentAvailability.offered(state: state, sonioxAllowed: buildAllows) == offered)
    var noCaps = appState()
    noCaps.capabilities = nil
    #expect(!VoiceAgentAvailability.offered(state: noCaps, sonioxAllowed: true), "no answer from the server yet")
  }

  @Test("spóźniony klucz po wylogowaniu (droga do Raroga mówi loggedOut) → rozmowa nie startuje")
  func lateTokenLoggedOut() async {
    let h = Harness()
    h.backend.token = .loggedOut
    h.start()
    #expect(await eventually { if case .ended = h.session.phase { true } else { false } })
    #expect(h.sockets.isEmpty)
  }

  @Test("zmiana serwera w trakcie pobierania klucza → koniec; spóźniony klucz nie otwiera gniazda")
  func serverChangeDuringMint() async {
    let h = Harness()
    h.backend.holdToken = true
    h.start()
    #expect(await eventually { h.backend.tokenPending })
    h.observe(input(appState(), login: 2))
    #expect(h.session.phase == .ended(.closed))
    #expect(h.session.closedBy == .serverChanged)
    h.backend.releaseToken()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(h.sockets.isEmpty)
  }

  @Test("session.created z innym modelem niż w kluczu → wpis w client.log z nazwami modeli, bez treści")
  func modelMismatch() async {
    let h = Harness()
    await h.ready()
    h.socket.reply(#"{"type":"session.created","session":{"model":"gpt-realtime-mini","instructions":"tajne"}}"#)
    #expect(await eventually { h.backend.traces.contains { $0.contains("gpt-realtime-mini") } })
    let line = h.backend.traces.first { $0.contains("gpt-realtime-mini") } ?? ""
    #expect(line.contains("gpt-realtime-2.1") && !line.contains("tajne"))
    let quiet = Harness()
    await quiet.ready()
    quiet.socket.reply(#"{"type":"session.created","session":{"model":"gpt-realtime-2.1"}}"#)
    try? await Task.sleep(for: .milliseconds(20))
    #expect(!quiet.backend.traces.contains { $0.contains("model") })
  }

  @Test("diagnostyka rozmowy idzie do client.log: czas do pierwszego dźwięku")
  func firstAudioTrace() async {
    let h = Harness()
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.answerSpoken("r1", item: "a1", samples: 240)
    h.audio.handlers?.playbackStarted(0.05)
    #expect(await eventually { h.backend.traces.contains { $0.hasPrefix("voice-agent: first audio") } })
  }

  @Test("response usage and the end line go to client.log with the price, never the conversation text")
  func usageTrace() async {
    let h = Harness()
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    h.session.end()
    #expect(h.backend.traces.contains { $0.hasPrefix("voice-agent: response 1 completed: ") && $0.hasSuffix(", $0.0243") })
    #expect(h.backend.traces.last?.hasPrefix("voice-agent: ended closed after ") == true)
    #expect(h.backend.traces.last?.hasSuffix(", $0.0243, tts chars 0 audio 0 ms $0.0000") == true)
    // Conversation lines ride the voice agent budget, the end line passes outside it.
    #expect(h.backend.traceBudgets.last == .voiceAgentEnd)
    #expect(h.backend.traceBudgets.dropLast().allSatisfy { $0 == .voiceAgent })
    #expect(h.backend.traceBudgets.count == h.backend.traces.count)
  }

  // MARK: Koniec rozmowy

  @Test("transcript.repoint-clear i repoint-resume → rozmowa zamknięta")
  func repointEnds() async {
    for code in ["transcript.repoint-clear", "transcript.repoint-resume"] {
      let h = Harness()
      await h.ready()
      let next = appState(messages: [message(1, "user", "hi"), message(2, "system", "Cleared.", ref: code)])
      h.observe(input(next))
      #expect(h.session.phase == .ended(.closed), "\(code)")
      #expect(h.session.closedBy == .sessionCleared)
      #expect(h.socket.closed && h.audio.stops > 0)
    }
  }

  @Test("granica /clear sprzed startu rozmowy jej nie kończy; nowa wiadomość bez granicy też nie")
  func oldRepointKeeps() async {
    let h = Harness()
    let before = appState(messages: [message(1, "system", "Cleared.", ref: "transcript.repoint-clear")])
    h.start(input(before))
    #expect(await eventually { !h.sockets.isEmpty })
    h.observe(
      input(appState(messages: [message(1, "system", "Cleared.", ref: "transcript.repoint-clear"), message(2, "user", "x")])))
    #expect(h.session.phase != .ended(.closed))
  }

  @Test("zmiana sesji, wyłączenie funkcji, wylogowanie, odpięcie, zmiana serwera, tło → rozmowa zamknięta")
  func endConditions() async {
    var revoked = appState()
    revoked.auth = .loggedOut(.deviceRevoked)
    var loggedOut = appState()
    loggedOut.auth = .loggedOut(.notLoggedIn)
    let cases: [(VoiceAgentWatch.Input, VoiceAgentWatch.Reason)] = [
      (input(appState(), selected: "s2"), .sessionChanged),
      (input(appState(), selected: nil), .sessionChanged),
      (input(appState(), enabled: false), .disabled),
      (input(appState(companion: false)), .disabled),
      (input(loggedOut), .loggedOut),
      (input(revoked), .loggedOut),
      (input(appState(), login: 2), .serverChanged),
      (input(appState(), background: true), .background),
      (input(appState(), fieldShown: false), .fieldHidden),
    ]
    for (next, reason) in cases {
      let h = Harness()
      await h.ready()
      h.observe(next)
      #expect(h.session.phase == .ended(.closed), "\(reason)")
      #expect(h.session.closedBy == reason)
      #expect(h.socket.closed)
      #expect(!UICopy.voiceAgentClosed(reason).isEmpty)
    }
  }

  @Test("companionSpeech turns false during a conversation (an older server) → it ends as turned off")
  func speechWithdrawnEnds() async {
    let h = Harness()
    await h.ready()
    h.observe(input(appState(speech: false)))
    #expect(h.session.phase == .ended(.closed))
    #expect(h.session.closedBy == .disabled)
    #expect(h.socket.closed)
  }

  @Test("the hidden message field (state card, decision dock) ends the conversation with its reason")
  func fieldHiddenEnds() async {
    let h = Harness()
    await h.ready()
    h.observe(input(appState(), fieldShown: false))
    #expect(h.session.phase == .ended(.closed))
    #expect(h.session.closedBy == .fieldHidden)
    #expect(h.socket.closed && h.audio.stops > 0)
    #expect(h.session.indicator == .closed(.fieldHidden))
    #expect(h.backend.traces.last?.hasPrefix("voice-agent: ended closed (field-hidden) after") == true)
    // The end sentence waits for the field: the screen shows it when the field is back.
    #expect(UICopy.voiceAgentStatus(.closed(.fieldHidden)) == UICopy.voiceAgentClosed(.fieldHidden))
  }

  // Catches a start in the background that the locked-phone trial lets through: the engine would open the
  // microphone with the app in the background and no tap on screen.
  @Test("a start in the background is refused also when the host keeps a ready conversation: no audio, no key")
  func backgroundStartWithTrial() async {
    let h = Harness()
    h.start(input(appState(), background: true, keepsInBackground: true))
    try? await Task.sleep(for: .milliseconds(20))
    #expect(h.session.indicator == .closed(.background))
    #expect(h.audio.starts == 0)
    #expect(h.backend.tokenCalls == 0 && h.backend.speechTokenCalls == 0 && h.sockets.isEmpty)
  }

  // Catches a readiness that counts a conversation still connecting as running: the trial would keep it in the
  // background, and its engine would open the microphone there.
  @Test("the conversation is ready only past its readiness gate, not while the engine and the keys start")
  func readyOnlyPastGate() async {
    let h = Harness()
    h.audio.holdFirstStart = true
    h.start()
    #expect(await eventually { h.audio.startPending && !h.sockets.isEmpty })
    h.speechSockets.last?.open()
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    try? await Task.sleep(for: .milliseconds(20))
    #expect(h.session.isActive && !h.session.isReady, "OpenAI took the session, the engine has not started")
    h.audio.releaseStart()
    #expect(await eventually { h.session.phase == .listening })
    #expect(h.session.isReady)
    h.session.end()
    #expect(!h.session.isReady)
  }

  @Test("a hidden field at the start → no conversation, the reason stands")
  func fieldHiddenAtStart() {
    let h = Harness()
    h.start(input(appState(), fieldShown: false))
    #expect(h.sockets.isEmpty)
    #expect(h.session.indicator == .closed(.fieldHidden))
  }

  @Test("a host with no field state to watch at the start → refused as a hidden field, no audio and no key")
  func noWatchInputAtStart() async {
    let detached = Harness()
    detached.host.watchInput = nil
    let empty = Harness()
    empty.host.watchInput = { nil }
    for h in [detached, empty] {
      h.session.start()
      try? await Task.sleep(for: .milliseconds(20))
      #expect(h.session.indicator == .closed(.fieldHidden))
      #expect(h.audio.starts == 0)
      #expect(h.backend.tokenCalls == 0 && h.backend.speechTokenCalls == 0)
      #expect(h.sockets.isEmpty)
    }
  }

  @Test("the second tap ends audio and socket; the row goes without a sentence")
  func endButton() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmed()
    h.session.end()
    #expect(h.session.phase == .ended(.closed))
    #expect(h.socket.closed && h.audio.stops > 0)
    #expect(h.session.indicator == nil)
    #expect(h.sentFields.isEmpty)
  }

  @Test("another login since the start (other server) → the login check of the send says no")
  func loginChange() async {
    let h = Harness()
    await h.ready()
    #expect(h.session.loginUnchanged)
    h.backend.loginEpoch = 2
    #expect(!h.session.loginUnchanged)
  }

  // MARK: Microphone mute

  @Test("the composer mic mutes and unmutes: “Muted” in the row, no audio to OpenAI, the lines in client.log")
  func mute() async throws {
    let h = Harness()
    await h.ready()
    h.session.toggleMute()
    #expect(h.session.muted)
    #expect(h.session.indicator == .muted)
    #expect(h.socket.sent("input_audio_buffer.clear").count == 1)
    try #require(h.audio.handlers).input(Data([0x00, 0x40]))
    #expect(h.socket.sent("input_audio_buffer.append").isEmpty)
    h.session.toggleMute()
    #expect(!h.session.muted)
    #expect(h.session.indicator == .listening)
    try #require(h.audio.handlers).input(Data([0x00, 0x40]))
    #expect(h.socket.sent("input_audio_buffer.append").count == 1)
    #expect(h.backend.traces.contains("voice-agent: muted"))
    #expect(h.backend.traces.contains("voice-agent: unmuted"))
  }

  @Test("muted during an answer: “Answering” stands until the answer is over, then “Muted”")
  func muteDuringAnswer() async {
    let h = Harness()
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.answerSpoken("r1", item: "m1", samples: 2400)
    #expect(h.session.indicator == .answering)
    h.session.toggleMute()
    #expect(h.session.indicator == .answering)
    h.socket.reply(done("r1"))
    h.audio.handlers?.drained()
    #expect(h.session.indicator == .muted)
  }

  // Catches a mute over a prompt in the field that the app's microphone never learns: the status row keeps the
  // prompt, so nothing would tell the voice Live Activity that the microphone stopped taking the spoken answer.
  @Test("a mute over a prompt in the field reaches the microphone's observers as muted")
  func muteOverPromptReported() async {
    let h = Harness()
    let center = DictationCenter()
    center.claim(h.session)
    await h.ready()
    await h.cardConfirmedWithoutUtterance()
    #expect(h.session.indicator == .promptInField)
    #expect(center.use?.phase == .prompt)
    var told = 0
    center.observe { told += 1 }
    h.session.toggleMute()
    #expect(h.session.indicator == .promptInField)
    #expect(told == 1)
    #expect(center.use?.phase == .muted)
  }

  @Test("mute with no conversation is a no-op; the next conversation starts unmuted")
  func muteNotRunning() async {
    let h = Harness()
    h.session.toggleMute()
    #expect(!h.session.muted)
    #expect(h.session.indicator == nil)
    await h.ready()
    h.session.toggleMute()
    #expect(h.session.muted)
    h.session.end()
    #expect(!h.session.muted)
    h.start()
    #expect(await eventually { h.sockets.count == 2 })
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.phase == .listening })
    #expect(!h.session.muted)
    #expect(h.session.indicator == .listening)
  }

  // MARK: Wejście

  @Test("an older server with companionEnabled but without companionSpeech → no button, no ⌥⌘V, row not set up")
  func gateWithoutServerSpeech() {
    let state = appState(speech: false)
    let entry = VoiceAgentEntry.make(state: state, sessionId: "s1", enabled: true, sonioxAllowed: true, dictating: false)
    #expect(entry == .hidden)
    #expect(VoiceAgentKey.make(entry: entry, active: false, fieldShown: true) == nil)
    #expect(VoiceAgentSettingsModel.availability(state: state, sonioxAllowed: true) == .notSetUp)
  }

  @Test("przycisk: brak bez companionEnabled albo bez włączenia w apce; nieaktywny w trakcie dyktowania")
  func entry() {
    func make(_ state: AppState, enabled: Bool = true, sonioxAllowed: Bool = true, dictating: Bool = false)
      -> VoiceAgentEntry
    {
      VoiceAgentEntry.make(
        state: state, sessionId: "s1", enabled: enabled, sonioxAllowed: sonioxAllowed, dictating: dictating)
    }
    let on = appState()
    #expect(make(on) == .enabled)
    #expect(make(on, dictating: true) == .disabled)
    #expect(make(on, enabled: false) == .hidden)
    #expect(make(appState(companion: false)) == .hidden)
    var noCaps = appState()
    noCaps.capabilities = nil
    #expect(make(noCaps) == .hidden)
    var codex = appState()
    codex.sessions["s1"] = Sample.session(extra: #""engine":"codex""#)
    #expect(make(codex) == .hidden)
  }

  @Test("a build without Soniox: no button, no ⌥⌘V and no Settings row, even where the server offers the agent")
  func gateWithoutSonioxBuild() {
    let state = appState()
    let entry = VoiceAgentEntry.make(state: state, sessionId: "s1", enabled: true, sonioxAllowed: false, dictating: false)
    #expect(entry == .hidden)
    #expect(VoiceAgentKey.make(entry: entry, active: false, fieldShown: true) == nil)
    #expect(VoiceAgentSettingsModel.availability(state: state, sonioxAllowed: false) == .hidden)
    #expect(VoiceAgentSettingsModel.availability(state: state, sonioxAllowed: true) == .offered)
  }
}

// MARK: - Status row

/// Every state of the session, plus the transient states and their
/// timers. The sentence and color of each state: `VoiceAgentIndicatorTests`.
@MainActor
@Suite("voice conversation: the status row of the message field")
struct VoiceAgentStatusRowTests {
  @Test("connecting → listening → speech detected → listening → thinking → answering → listening")
  func phases() async {
    let h = Harness()
    h.start()
    #expect(h.session.indicator == .connecting)
    #expect(await eventually { !h.sockets.isEmpty })
    h.speechSockets.last?.open()
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.indicator == .listening })
    h.socket.reply(speechStarted)
    #expect(h.session.indicator == .hearing)
    h.socket.reply(speechStopped)
    #expect(h.session.indicator == .listening)
    h.socket.reply(committed("in1"))
    #expect(h.session.indicator == .thinking)
    h.socket.reply(created("r1"))
    h.answerSpoken("r1", item: "m1", samples: 2400)
    #expect(h.session.indicator == .answering)
    h.socket.reply(done("r1"))
    h.audio.handlers?.drained()
    #expect(h.session.indicator == .listening)
  }

  @Test("ask_session → “Checking the session… N s” counts seconds; the answer ends it")
  func checkingCountsSeconds() async {
    let h = Harness()
    h.backend.holdAsk = true
    await h.ready()
    h.utterance("in1")
    h.socket.reply(created("r1"))
    h.socket.reply(call("r1", id: "c1", name: "ask_session", arguments: #"{"question":"Why?"}"#))
    #expect(h.session.indicator == .checkingSession(seconds: 0))
    h.scheduler.advance(1)
    #expect(h.session.indicator == .checkingSession(seconds: 1))
    h.scheduler.advance(6)
    #expect(h.session.indicator == .checkingSession(seconds: 7))
    #expect(await eventually { h.backend.askPending })
    h.backend.releaseAsk()
    #expect(await eventually { h.session.indicator == .thinking })
  }

  @Test("prompt in the field after the answer; the next detected speech ends it")
  func promptUntilSpeech() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmedWithoutUtterance()
    #expect(h.session.indicator == .promptInField)
    h.socket.reply(speechStarted)
    #expect(h.session.indicator == .hearing)
    h.socket.reply(speechStopped)
    #expect(h.session.indicator == .listening)
  }

  @Test("prompt in the field ends with the next phase other than listening, and with the send")
  func promptUntilPhaseOrSend() async {
    let h = Harness()
    await h.ready()
    await h.cardConfirmedWithoutUtterance()
    h.socket.reply(committed("in2"))
    #expect(h.session.indicator == .thinking)
    h.socket.reply(created("r2"))
    h.socket.reply(done("r2"))
    #expect(h.session.indicator == .listening)

    let other = Harness()
    await other.ready()
    await other.cardConfirmedWithoutUtterance()
    other.session.fieldSent(other.session.sendMark)
    #expect(other.session.indicator == .sent)
  }

  @Test("sent → “Sent to the session” for 3 s, then listening")
  func sentForThreeSeconds() async {
    let h = Harness()
    await h.ready()
    h.session.fieldSent(h.session.sendMark)
    #expect(h.session.indicator == .sent)
    h.scheduler.advance(2.9)
    #expect(h.session.indicator == .sent)
    h.scheduler.advance(0.2)
    #expect(h.session.indicator == .listening)
  }

  @Test("an old timer does not clear a newer state: a second send, or a prompt after a send")
  func oldTimerKeepsNewerState() async {
    let h = Harness()
    await h.ready()
    h.session.fieldSent(h.session.sendMark)
    h.scheduler.advance(2)
    h.session.fieldSent(h.session.sendMark)
    h.scheduler.advance(1.5)
    #expect(h.session.indicator == .sent)
    h.scheduler.advance(2)
    #expect(h.session.indicator == .listening)

    let other = Harness()
    await other.ready()
    other.session.fieldSent(other.session.sendMark)
    other.scheduler.advance(1)
    await other.cardConfirmedWithoutUtterance()
    #expect(other.session.indicator == .promptInField)
    other.scheduler.advance(3)
    #expect(other.session.indicator == .promptInField)
  }

  @Test("a late send result of the field taken before a newer prompt does not touch the newer prompt's state")
  func lateSendKeepsNewerPrompt() async {
    let h = Harness()
    await h.ready()
    // The send takes the field now (prompt A or the user's text); its result comes after the agent wrote B.
    let taken = h.session.sendMark
    #expect(taken != nil)
    await h.cardConfirmedWithoutUtterance()
    #expect(h.session.indicator == .promptInField)
    h.session.fieldSent(taken)
    #expect(h.session.indicator == .promptInField)
    h.session.fieldSent(h.session.sendMark)
    #expect(h.session.indicator == .sent)
  }

  @Test("a send result of the previous conversation does not touch the next one; no conversation, no mark")
  func lateSendKeepsNextConversation() async {
    let h = Harness()
    await h.ready()
    let taken = h.session.sendMark
    h.session.end()
    #expect(h.session.sendMark == nil)
    h.start()
    #expect(await eventually { h.sockets.count == 2 })
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.indicator == .listening })
    h.session.fieldSent(taken)
    #expect(h.session.indicator == .listening)
    h.session.fieldSent(nil)
    #expect(h.session.indicator == .listening)
  }

  @Test("an old timer does not touch the state of the next conversation of the session")
  func oldTimerAndNewConversation() async {
    let h = Harness()
    await h.ready()
    h.session.fieldSent(h.session.sendMark)
    h.session.end()
    h.start()
    #expect(await eventually { h.sockets.count == 2 })
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.indicator == .listening })
    h.scheduler.advance(3.5)
    #expect(h.session.indicator == .listening)
  }

  @Test("an end with a reason keeps its sentence until dismissed; the plain end leaves no row")
  func endSentence() async {
    let h = Harness()
    await h.ready()
    h.socket.drop()
    #expect(h.session.indicator == .ended(.dropped))
    h.session.dismissNotice()
    #expect(h.session.indicator == nil)

    let plain = Harness()
    await plain.ready()
    plain.session.end()
    #expect(plain.session.indicator == nil)
  }

  @Test("an edit of the field during the conversation does not hide its row")
  func editKeepsRunningRow() async {
    let h = Harness()
    await h.ready()
    h.session.dismissNotice()
    #expect(h.session.indicator == .listening)
    #expect(VoiceStatusOwner.afterEdit(h.session.indicator) == .listening)
  }

  @Test("microphone denied → the end sentence with the Settings button")
  func microphoneDenied() async {
    let h = Harness()
    h.audio.startError = .denied
    h.start()
    #expect(await eventually { !h.sockets.isEmpty })
    h.socket.open()
    h.socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { h.session.indicator == .ended(.microphone(.denied)) })
    #expect(h.session.indicator?.opensSettings == true)
  }

  @Test("levels of the conversation reach the screen")
  func levelsReachScreen() async throws {
    let h = Harness()
    await h.ready()
    let loud = Data([0x00, 0x40])
    try #require(h.audio.handlers).input(loud)
    h.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(h.levels.last?.input == 0.5)
  }
}

extension Harness {
  /// The prompt written into the field in `r1`, the follow-up answer done: the conversation listens again.
  func cardConfirmedWithoutUtterance() async {
    let before = outputs.count
    utterance("in1")
    socket.reply(created("r1"))
    socket.reply(call("r1", id: "c1", name: "show_prompt", arguments: #"{"text":"Run the tests"}"#))
    socket.reply(done("r1"))
    #expect(await eventually { outputs.count == before + 1 })
    socket.reply(created("r1f"))
    socket.reply(done("r1f"))
  }

  /// The model calls `send_prompt` in response `r2` after the confirmation; the result it hears.
  func sendPrompt() async -> String {
    let before = outputs.count
    socket.reply(created("r2"))
    socket.reply(call("r2", id: "c2", name: "send_prompt"))
    socket.reply(done("r2"))
    _ = await eventually { outputs.count == before + 1 }
    return outputs.count > before ? outputs[before] : ""
  }
}
