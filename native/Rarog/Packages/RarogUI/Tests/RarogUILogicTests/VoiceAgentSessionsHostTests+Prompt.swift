import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The prompt pair of the conversation across sessions in the host (`VoiceAgentSessionsHost+Prompt.swift`,
// `+PromptSend.swift`): what `show_prompt` refuses, captures and reads, the lock of `send_prompt` on the call's moment
// (`RealtimeToolTurn`, given here straight by the test), the captured target against the catalog at the send, the
// outcomes, one request per prompt, the kept outcome, one consent with the check, and the `client.log` lines. The
// lock over the real conversation core: `VoiceAgentSessionsConversationTests`. Fakes and samples:
// `VoiceAgentSessionsHostTests`. All session data is synthetic. Owner: voice agent.

private let promptA = "Run the login tests and fix what fails."
private let promptB = "Update the changelog for the release."

/// Alpha (`s1`) and Birch (`s2`) in the project orbit, both waiting for input, in the catalog with their tokens.
@MainActor
private func twoSessions() -> FakeVoiceAgentBackend {
  let backend = FakeVoiceAgentBackend()
  backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
  backend.catalog = .sessions([
    catalogRow("id-a", conversation: "conv-a1"), catalogRow("id-b", conversation: "conv-b1"),
  ])
  return backend
}

@MainActor
private func prepared(_ backend: FakeVoiceAgentBackend) async -> VoiceAgentSessionsHost {
  let host = VoiceAgentSessionsHost(backend: backend, sonioxAllowed: true, now: { Sample.now })
  #expect(await host.prepare() == nil)
  return host
}

private func json(_ value: String) -> String {
  String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// `show_prompt` as the conversation calls it in `response`: the result before any reading.
@MainActor
private func show(
  _ host: VoiceAgentSessionsHost, _ handle: String = "s1", _ text: String = promptA, response: String = "r1"
) async -> RealtimeToolResult {
  let arguments = #"{"handle":\#(json(handle)),"text":\#(json(text))}"#
  guard let spec = host.content().tools.first(where: { $0.name == VoiceAgentSessionsTool.showPrompt.rawValue }),
    case let .workAndRead(_, work) = spec.action(arguments)
  else {
    Issue.record("show_prompt is no work with a reading")
    return .output("")
  }
  return await work(RealtimeToolTurn(response: response, utterances: 1))
}

private func reading(_ result: RealtimeToolResult) -> String? {
  if case let .read(text, _, _) = result { text } else { nil }
}

/// The result for the model after the reading ended with `outcome` (an output stays as it is).
@MainActor
private func ended(_ result: RealtimeToolResult, _ outcome: RealtimeReadingOutcome) -> String {
  switch result {
  case let .output(output): output
  case let .read(_, then, _): then(outcome)
  }
}

/// `show_prompt` in `response` whose reading plays out whole; the result for the model.
@MainActor
@discardableResult
private func shownAndRead(
  _ host: VoiceAgentSessionsHost, _ handle: String = "s1", _ text: String = promptA, response: String = "r1"
) async -> String {
  ended(await show(host, handle, text, response: response), .whole)
}

/// `send_prompt` in `response` at `utterances` kept utterances; `after`: one of them began after the reading.
@MainActor
private func send(
  _ host: VoiceAgentSessionsHost, response: String = "r2", utterances: Int = 2, after: Bool = true
) async -> String {
  await call(
    host, .sendPrompt, turn: RealtimeToolTurn(response: response, utterances: utterances, utteranceAfterReading: after))
}

private func field(_ output: String, _ key: String) -> String? {
  ((try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any])?[key] as? String
}

private func error(_ output: String) -> String { field(output, "error") ?? "" }

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

@MainActor
@Suite("voice conversation across sessions: show_prompt, send_prompt, one request per prompt")
struct VoiceAgentSessionsHostPromptTests {
  @Test("show_prompt publishes project, session and text, points at the session and reads exactly the sentence")
  func showPublishesAndReads() async throws {
    let backend = twoSessions()
    let host = await prepared(backend)
    var published: [VoiceAgentShownPrompt?] = []
    host.onPrompt = { published.append($0) }
    let result = await show(host)
    let shown = VoiceAgentShownPrompt(project: "orbit", name: "Alpha", text: promptA)
    #expect(published == [shown])
    #expect(reading(result) == UICopy.voiceAgentSessionsPromptReading(project: "orbit", name: "Alpha", text: promptA))
    #expect(host.discussed?.sessionId == "id-a")
    #expect(field(ended(result, .whole), "result") == VoiceAgentPromptText.shown)
    #expect(backend.sends.isEmpty)
  }

  @Test(
    "show_prompt: 1000 characters are shown; 1001, an empty text and an unknown handle are refused and replace too",
    arguments: ["1000", "1001", "empty", "spaces", "unknown handle"])
  func showArguments(_ input: String) async {
    let backend = twoSessions()
    let host = await prepared(backend)
    // A prompt waits: the instructions tell the model a new show_prompt replaces it, refused or not.
    await shownAndRead(host, "s2", promptB, response: "r0")
    let result: RealtimeToolResult
    switch input {
    case "1000": result = await show(host, "s1", String(repeating: "x", count: 1000))
    case "1001": result = await show(host, "s1", String(repeating: "x", count: 1001))
    case "empty": result = await show(host, "s1", "")
    case "spaces": result = await show(host, "s1", "  \n ")
    default: result = await show(host, "s9")
    }
    let expected: String? =
      switch input {
      case "1000": nil
      case "1001": VoiceAgentPromptText.tooLong
      case "empty", "spaces": VoiceAgentPromptText.empty
      default: VoiceAgentPromptText.unknownHandle
      }
    if let expected {
      #expect(reading(result) == nil && error(ended(result, .whole)) == expected)
      #expect(host.prompts.prompt == nil && host.prompts.pending == nil)
      #expect(error(await send(host)) == VoiceAgentPromptText.noPrompt)
      #expect(backend.sends.isEmpty)
    } else {
      #expect(reading(result) != nil && host.prompts.prompt?.text.count == 1000)
    }
  }

  @Test(
    "show_prompt refuses a session the reading could not tell apart and one that waits on a dialog",
    arguments: ["numbered twins", "names equal after trimming", "dialog"])
  func showRefusesUnclearTarget(_ target: String) async {
    let backend = FakeVoiceAgentBackend()
    switch target {
    case "numbered twins":
      backend.state = appState([session("id-a", label: "Fix login"), session("id-b", label: "Fix login")])
    case "names equal after trimming":
      backend.state = appState([session("id-a", label: "Fix login"), session("id-b", label: " Fix login ")])
    default:
      backend.state = appState([
        session(
          "id-a", label: "Fix login", state: "waiting-permission",
          extra: #""waitingFor":{"kind":"permission","text":"Run deploy?"}"#),
        session("id-b", label: "Other"),
      ])
    }
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    let host = await prepared(backend)
    if target == "names equal after trimming" {
      #expect(Set(host.rows.map(\.name)) == ["Fix login"], "both rows come out with one name")
    }
    let result = await show(host)
    let expected = target == "dialog" ? VoiceAgentPromptText.dialog : VoiceAgentPromptText.ambiguous
    #expect(reading(result) == nil && error(ended(result, .whole)) == expected)
    #expect(host.prompts.prompt == nil && host.discussed == nil)
    #expect(error(await send(host)) == VoiceAgentPromptText.noPrompt, "the refused binding leaves nothing waiting")
    #expect(backend.sends.isEmpty)
  }

  @Test(
    "send_prompt in its show's response says not confirmed; a reading not read or never ended says show again",
    arguments: ["same response", "not read", "no end"])
  func sendBeforeTheWord(_ case_: String) async {
    let backend = twoSessions()
    let host = await prepared(backend)
    let result = await show(host, response: "r1")
    let output: String
    switch case_ {
    case "same response":
      // The real conversation: the send of the same response runs while the reading still plays.
      output = await send(host, response: "r1", utterances: 1, after: false)
    case "not read":
      #expect(error(ended(result, .notRead)) == VoiceAgentPromptText.notReadAloud)
      output = await send(host)
    default:
      // A cut drops the call: its `then` never comes.
      output = await send(host)
    }
    let expected = case_ == "same response" ? VoiceAgentPromptText.notConfirmed : VoiceAgentPromptText.notRead
    #expect(error(output) == expected)
    #expect(backend.sends.isEmpty)
  }

  @Test("send_prompt needs an utterance after the reading; then it sends exactly what was captured at the show")
  func sendCapturedPrompt() async throws {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    let id = try #require(host.prompts.prompt?.clientMessageId)
    #expect(error(await send(host, after: false)) == VoiceAgentPromptText.notConfirmed)
    #expect(backend.sends.isEmpty)
    #expect(field(await send(host), "result") == VoiceAgentPromptText.sent)
    let sent = try #require(backend.sends.first)
    #expect(backend.sends.count == 1)
    #expect(sent.sessionId == "id-a" && sent.text == promptA && sent.conversation == "conv-a1" && sent.id == id)
    #expect(host.prompts.prompt == nil)
  }

  @Test("a new conversation token of the target in the catalog before the send: nothing is sent, the prompt goes")
  func tokenChanged() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    backend.catalog = .sessions([
      catalogRow("id-a", conversation: "conv-a2"), catalogRow("id-b", conversation: "conv-b1"),
    ])
    #expect(error(await send(host)) == VoiceAgentPromptText.tokenChanged)
    #expect(backend.sends.isEmpty && host.prompts.prompt == nil)
    #expect(error(await send(host, response: "r3", utterances: 3)) == VoiceAgentPromptText.noPrompt)
  }

  @Test(
    "the target started a turn or stands on a dialog after the show: nothing is sent, the prompt goes",
    arguments: ["working", "dialog", "working after a timeout"])
  func targetChanged(_ change: String) async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    var turn = (response: "r2", utterances: 2)
    if change == "working after a timeout" {
      backend.sendOutcomes = [.timedOut]
      _ = await send(host)
      turn = (response: "r3", utterances: 3)
    }
    let sent = backend.sends.count
    let changed =
      change == "dialog"
      ? session(
        "id-a", label: "Alpha", state: "waiting-question", extra: #""waitingFor":{"kind":"question","text":"Which?"}"#)
      : session("id-a", label: "Alpha", state: "running")
    backend.state = appState([changed, session("id-b", label: "Birch")])
    let expected =
      switch change {
      case "working": VoiceAgentPromptText.startedWorking
      case "dialog": VoiceAgentPromptText.dialogNow
      default: VoiceAgentPromptText.workingAgain
      }
    #expect(error(await send(host, response: turn.response, utterances: turn.utterances)) == expected)
    #expect(backend.sends.count == sent && host.prompts.prompt == nil)
  }

  @Test("a second show_prompt before the send replaces the first: the send sends the second")
  func secondShowReplaces() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    let first = await show(host, "s1", promptA, response: "r1")
    await shownAndRead(host, "s2", promptB, response: "r2")
    #expect(error(ended(first, .whole)) == VoiceAgentPromptText.replaced, "the first reading's end changes nothing")
    _ = await send(host, response: "r3", utterances: 3)
    #expect(backend.sends.map(\.text) == [promptB] && backend.sends.first?.sessionId == "id-b")
  }

  @Test("show_prompt(B) and send_prompt in one response, B's catalog read held: A, read and confirmed, is not sent")
  func showBindsBeforeItsRead() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host, "s1", promptA, response: "r1")
    backend.holdCatalog = true
    let showing = Task { await show(host, "s2", promptB, response: "r3") }
    #expect(await eventually { backend.catalogPending })
    #expect(error(await send(host, response: "r3", utterances: 2)) == VoiceAgentPromptText.notConfirmed)
    backend.releaseCatalog()
    _ = await showing.value
    #expect(backend.sends.isEmpty)
  }

  @Test("a second send_prompt after Sent. sends nothing: it reports the kept outcome")
  func secondSendAfterSent() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    #expect(field(await send(host), "result") == VoiceAgentPromptText.sent)
    #expect(field(await send(host, response: "r3", utterances: 3), "result") == VoiceAgentPromptText.sent)
    host.answer(.playedWhole)
    #expect(error(await send(host, response: "r4", utterances: 4)) == VoiceAgentPromptText.noPrompt)
    #expect(backend.sends.count == 1)
  }

  @Test("two send_prompt calls at once, the first still reading the catalog: one request, one result for both")
  func twoSendsAtOnce() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    backend.holdCatalog = true
    let first = Task { await send(host) }
    #expect(await eventually { backend.catalogPending })
    let second = Task { await send(host, response: "r3", utterances: 3) }
    for _ in 0..<20 { await Task.yield() }
    backend.releaseCatalog()
    let outputs = [await first.value, await second.value]
    #expect(outputs.allSatisfy { field($0, "result") == VoiceAgentPromptText.sent }, "\(outputs)")
    #expect(backend.sends.count == 1 && backend.requests == 1)
  }

  @Test(
    "an outcome that does not say whether it arrived keeps the prompt: a repeat needs a new utterance, same id",
    arguments: [CompanionSendOutcome.timedOut, .failed, .cancelled])
  func uncertainRepeat(_ outcome: CompanionSendOutcome) async throws {
    let backend = twoSessions()
    backend.sendOutcomes = [outcome]
    let host = await prepared(backend)
    await shownAndRead(host)
    let cause =
      switch outcome {
      case .timedOut: VoiceAgentPromptText.noAnswer
      case .failed: VoiceAgentPromptText.failed
      default: VoiceAgentPromptText.stopped
      }
    #expect(error(await send(host, response: "r2", utterances: 2)) == VoiceAgentPromptText.uncertain(cause))
    #expect(host.prompts.prompt != nil)
    #expect(error(await send(host, response: "r3", utterances: 2)) == VoiceAgentPromptText.notConfirmed)
    #expect(backend.sends.count == 1)
    #expect(field(await send(host, response: "r4", utterances: 3), "result") == VoiceAgentPromptText.sent)
    #expect(backend.sends.count == 2 && backend.sends[0].id == backend.sends[1].id)
  }

  @Test(
    "outcomes: queued is in the queue, a changed conversation and a logout end it, a refusal passes its sentence",
    arguments: ["queued", "conversation changed", "refused", "logged out"])
  func outcomes(_ outcome: String) async {
    let backend = twoSessions()
    switch outcome {
    case "queued": backend.sendOutcomes = [.queued]
    case "conversation changed": backend.sendOutcomes = [.conversationChanged(message: "Another conversation.")]
    case "refused": backend.sendOutcomes = [.refused(.refusal(code: "bad-state", message: "The session is starting."))]
    default:
      backend.sendOutcomes = [.loggedOut]
      // The store answers logged out after the app lost its login during the send.
      backend.onSend = { [unowned backend] in backend.state.auth = .loggedOut(.notLoggedIn) }
    }
    let host = await prepared(backend)
    var checks = 0
    host.requestEndCheck = { checks += 1 }
    await shownAndRead(host)
    let output = await send(host)
    switch outcome {
    case "queued":
      #expect(field(output, "result")?.contains("in the queue") == true)
      #expect(host.endReason() == nil && checks == 0)
    case "conversation changed":
      #expect(error(output) == VoiceAgentPromptText.conversationChanged)
      #expect(host.endReason() == .sessionCleared && checks == 1)
    case "refused":
      #expect(error(output) == VoiceAgentPromptText.refused(message: "The session is starting."))
      #expect(host.endReason() == nil && checks == 0)
    default:
      #expect(error(output) == VoiceAgentPromptText.loggedOut)
      #expect(host.endReason() == .loggedOut && checks == 1)
    }
    #expect(host.prompts.prompt == nil && backend.sends.count == 1)
  }

  @Test("the end with a prompt waiting sends nothing; a cut during a send in flight does not cancel its request")
  func endAndCut() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    var published: [VoiceAgentShownPrompt?] = []
    host.onPrompt = { published.append($0) }
    await shownAndRead(host)
    host.conversationEnded()
    #expect(isError(await send(host)) && backend.sends.isEmpty)
    #expect(published.last == .some(nil), "the bar loses the prompt")

    let route = twoSessions()
    let running = await prepared(route)
    await shownAndRead(running)
    route.holdSend = true
    let sending = Task { await send(running) }
    #expect(await eventually { route.sendPending })
    running.answer(.cut)
    // Even the caller's task cancelled leaves the host's send alone.
    sending.cancel()
    route.releaseSend()
    #expect(field(await sending.value, "result") == VoiceAgentPromptText.sent)
    #expect(route.cancelledSends == 0 && route.requests == 1)
  }

  @Test("one consent waits: show_prompt drops a heard check announcement, an announcement drops a waiting prompt")
  func oneConsent() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([
      session("id-a", label: "Alpha", extra: #""seen":true"#), session("id-b", label: "Birch", extra: #""seen":true"#),
    ])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    let host = await prepared(backend)
    let announce = RealtimeToolTurn(response: "r1", utterances: 1)
    #expect(await call(host, .checkOpenRequests, turn: announce).contains("would ask 2 sessions"))
    host.answer(.playedWhole)
    await shownAndRead(host, response: "r2")
    let word = RealtimeToolTurn(response: "r3", utterances: 2)
    #expect(await call(host, .checkOpenRequests, turn: word).contains("would ask 2 sessions"), "announced again")
    #expect(backend.questions.isEmpty)
    #expect(host.prompts.prompt == nil, "the new announcement dropped the prompt")
    #expect(error(await send(host, response: "r4", utterances: 3)) == VoiceAgentPromptText.noPrompt)
    #expect(backend.sends.isEmpty)
  }

  @Test("one consent waits: a check asked for while a send is in flight announces nothing")
  func checkDuringSend() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([
      session("id-a", label: "Alpha", extra: #""seen":true"#), session("id-b", label: "Birch", extra: #""seen":true"#),
    ])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.sendOutcomes = [.timedOut]
    let host = await prepared(backend)
    await shownAndRead(host)
    backend.holdSend = true
    let sending = Task { await send(host) }
    #expect(await eventually { backend.sendPending })
    let during = await call(host, .checkOpenRequests, turn: RealtimeToolTurn(response: "r2", utterances: 2))
    #expect(error(during) == VoiceAgentPromptText.checkWhileSending)
    backend.holdSend = false
    backend.releaseSend()
    _ = await sending.value
    #expect(host.prompts.prompt != nil, "an outcome that does not say whether it arrived keeps the prompt")
    host.answer(.playedWhole)
    // The user's next word: the check only announces, so that word starts no run; the announcement drops the prompt.
    let word = RealtimeToolTurn(response: "r3", utterances: 3)
    #expect(await call(host, .checkOpenRequests, turn: word).contains("would ask 2 sessions"))
    #expect(backend.questions.isEmpty)
    #expect(error(await send(host, response: "r3", utterances: 3)) == VoiceAgentPromptText.noPrompt)
    #expect(backend.requests == 1)
  }

  @Test("the kept outcome: a send joined after a cut returns it, so the whole answer after it lets it go")
  func joinedSendReturnsTheOutcome() async throws {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    backend.holdSend = true
    let first = Task { await send(host) }
    #expect(await eventually { backend.sendPending })
    host.answer(.cut)
    let joined = Task { await send(host, response: "r3", utterances: 3) }
    for _ in 0..<20 { await Task.yield() }
    backend.holdSend = false
    backend.releaseSend()
    _ = await first.value
    #expect(field(await joined.value, "result") == VoiceAgentPromptText.sent)
    let id = try #require(backend.sends.first?.id)
    host.answer(.playedWhole)
    #expect(host.prompts.sent == nil, "the joined call gave the model the outcome")
    await shownAndRead(host, response: "r4")
    #expect(host.prompts.prompt?.clientMessageId != id, "the model heard the outcome: a new prompt is a new message")
    #expect(backend.requests == 1)
  }

  @Test("speech before the request leaves stops the send: nothing goes, the prompt waits for a clear word")
  func cutBeforeTheRequest() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    backend.holdCatalog = true
    let sending = Task { await send(host) }
    #expect(await eventually { backend.catalogPending })
    host.answer(.cut)
    backend.holdCatalog = false
    backend.releaseCatalog()
    #expect(error(await sending.value) == VoiceAgentPromptText.spokenOverSend)
    #expect(backend.sends.isEmpty && backend.requests == 0)
    #expect(host.prompts.prompt?.read == true && host.prompts.prompt?.attempt == nil && host.prompts.sent == nil)
    #expect(field(await send(host, response: "r3", utterances: 3), "result") == VoiceAgentPromptText.sent)
    #expect(backend.requests == 1)
  }

  @Test("the kept outcome: a joined send that was refused before its request does not return an older outcome")
  func joinedRefusalKeepsTheOlderOutcome() async {
    let backend = twoSessions()
    backend.sendOutcomes = [.timedOut]
    let host = await prepared(backend)
    await shownAndRead(host)
    _ = await send(host)
    host.answer(.cut)
    backend.holdCatalog = true
    let first = Task { await send(host, response: "r3", utterances: 3) }
    #expect(await eventually { backend.catalogPending })
    host.answer(.cut)
    let joined = Task { await send(host, response: "r4", utterances: 4) }
    for _ in 0..<20 { await Task.yield() }
    backend.holdCatalog = false
    backend.releaseCatalog()
    _ = await first.value
    #expect(error(await joined.value) == VoiceAgentPromptText.spokenOverSend)
    host.answer(.playedWhole)
    #expect(host.prompts.sent?.end == .timedOut, "the model never got the first outcome")
    #expect(backend.requests == 1)
  }

  @Test("a sound over the answer after the confirming word stops the send; a repeat needs a new word")
  func soundAfterTheConfirmingWord() async {
    // Catches a short no the app took for noise: the model never hears it, so the lock must hold the send.
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    host.soundOverAnswer(utterances: 2)
    #expect(error(await send(host)) == VoiceAgentPromptText.soundAfterWord)
    #expect(error(await send(host, response: "r3")) == VoiceAgentPromptText.soundAfterWord, "the same word again")
    #expect(backend.requests == 0)
    #expect(host.prompts.prompt?.read == true && host.prompts.prompt?.attempt == nil)
    #expect(field(await send(host, response: "r4", utterances: 3), "result") == VoiceAgentPromptText.sent)
    #expect(backend.requests == 1)
  }

  @Test("a sound over the answer while the send reads the catalog stops the send before the hand-off")
  func soundDuringTheCatalogRead() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    // A sound before the confirming word changes nothing.
    host.soundOverAnswer(utterances: 1)
    backend.holdCatalog = true
    let sending = Task { await send(host) }
    #expect(await eventually { backend.catalogPending })
    host.soundOverAnswer(utterances: 2)
    backend.holdCatalog = false
    backend.releaseCatalog()
    #expect(error(await sending.value) == VoiceAgentPromptText.soundAfterWord)
    #expect(backend.requests == 0)
    #expect(host.prompts.prompt?.read == true && host.prompts.prompt?.attempt == nil)
  }

  @Test("the kept outcome: of two calls that returned it, the later one counts, whichever comes back first")
  func keptOutcomeCountsTheLatestCall() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    _ = await send(host)
    // Two calls joined the send after the first and the second cut; the later one came back first.
    host.prompts.reported(since: 2)
    host.prompts.reported(since: 1)
    host.prompts.playedWhole(cuts: 2)
    #expect(host.prompts.sent == nil, "the answer of the later call played out whole")
  }

  @Test("the kept outcome: after a cut a show of the same prompt keeps its id; after a heard answer a new id")
  func keptOutcome() async throws {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    _ = await send(host)
    let id = try #require(backend.sends.first?.id)
    host.answer(.cut)
    host.answer(.playedWhole)
    let again = await shownAndRead(host, response: "r3")
    #expect(field(again, "result")?.hasSuffix(VoiceAgentPromptText.sameAsLastSend(.sent)) == true)
    #expect(host.prompts.prompt?.clientMessageId == id)
    host.answer(.playedWhole)
    #expect(host.prompts.sent == nil, "the note told the model the outcome, and the answer after it played whole")
    _ = await send(host, response: "r4", utterances: 3)
    #expect(backend.sends.count == 2 && backend.sends[1].id == id && backend.requests == 1)
    host.answer(.playedWhole)
    await shownAndRead(host, response: "r5")
    #expect(host.prompts.prompt?.clientMessageId != id, "the model heard the outcome: a new prompt is a new message")
  }

  @Test("the kept outcome: a show of other content notes how the last send ended and gets an id of its own")
  func keptOutcomeOtherContent() async throws {
    let backend = twoSessions()
    let host = await prepared(backend)
    await shownAndRead(host)
    _ = await send(host)
    let id = try #require(backend.sends.first?.id)
    host.answer(.cut)
    let other = await shownAndRead(host, "s2", promptB, response: "r3")
    #expect(field(other, "result") == VoiceAgentPromptText.shown + " " + VoiceAgentPromptText.lastSend("Sent."))
    #expect(host.prompts.prompt?.clientMessageId != id)
    _ = await send(host, response: "r4", utterances: 3)
    #expect(backend.requests == 2 && backend.sends.map(\.text) == [promptA, promptB])
  }

  @Test("client.log: prompt and send lines with codes, without the text, names or ids")
  func logLines() async {
    let backend = twoSessions()
    let host = await prepared(backend)
    _ = await show(host, "s9")
    await shownAndRead(host)
    _ = await send(host, after: false)
    _ = await send(host)
    let lines = backend.traces
    for line in [
      "voice-agent: prompt refused (unknown-handle)", "voice-agent: prompt shown", "voice-agent: prompt read whole",
      "voice-agent: send refused (not-confirmed)", "voice-agent: send ended (sent)",
    ] {
      #expect(lines.contains(line), "\(lines)")
    }
    for line in lines {
      for hidden in ["login tests", "Alpha", "orbit", "id-a", "conv-a1", "s1"] { #expect(!line.contains(hidden)) }
    }
  }
}
