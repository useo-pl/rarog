import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// `check_open_requests` of the conversation across sessions in the host (`VoiceAgentSessionsHost+Check.swift`): the
// announcement of the sessions in the state `seen`, the user's word from the call's moment (`RealtimeToolTurn`, given
// here straight by the test), the run one question at a time with its limits, stops and cancellation, the refusals
// and the `client.log` lines. The lock over the real conversation core:
// `VoiceAgentSessionsConversationTests`. Fakes and samples: `VoiceAgentSessionsHostTests`. All session data is
// synthetic. Owner: voice agent.

private func turn(_ response: String, _ utterances: Int) -> RealtimeToolTurn {
  RealtimeToolTurn(response: response, utterances: utterances)
}

/// `count` sessions in the state `seen` (`id-s1`… with the newest state change first), plus a finished one, a working
/// one and one the voice agent picked up, all in the catalog.
@MainActor
private func seenSessions(_ count: Int) -> FakeVoiceAgentBackend {
  let backend = FakeVoiceAgentBackend()
  var sessions = (0..<count).map { offset in
    let index = offset + 1
    return session("id-s\(index)", label: "Seen \(index)", extra: #""seen":true"#, stateAgo: TimeInterval(60 * index))
  }
  sessions.append(session("id-fresh", label: "Fresh result", stateAgo: 30))
  sessions.append(session("id-work", label: "Working", state: "running", stateAgo: 10))
  sessions.append(
    session("id-voice", label: "Voice picked", extra: #""seen":true,"seenBy":"voice-agent""#, stateAgo: 20))
  backend.state = appState(sessions)
  backend.catalog = .sessions(sessions.map { catalogRow($0.id) })
  return backend
}

@MainActor
private func prepared(_ backend: FakeVoiceAgentBackend) async -> VoiceAgentSessionsHost {
  let host = VoiceAgentSessionsHost(backend: backend, sonioxAllowed: true, now: { Sample.now })
  #expect(await host.prepare() == nil)
  return host
}

private func announces(_ output: String, _ count: Int) -> Bool {
  !isError(output) && output.contains("would ask \(count) sessions the user has looked at")
}

/// The sessions the run asked, in order.
@MainActor
private func asked(_ backend: FakeVoiceAgentBackend) -> [String] {
  backend.reads.filter { $0.hasPrefix("ask ") }.map { String($0.dropFirst(4)) }
}

private func answer(_ text: String) -> CompanionAskOutcome {
  .answer(Sample.decode(CompanionAnswer.self, #"{"answer":\#(jsonText(text)),"found":false}"#))
}

private func jsonText(_ value: String) -> String {
  String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// The synthetic tail of a key shape the secret mask hides (`shared/fixtures/companion/secret-shapes.json`).
private let secretTail = "EXAMPLE_example-EXAMPLEexampleEXAMPLE"

/// The plain cause the run gives for a refusal of the route, read from its stop note.
@MainActor
private func stopSentence(_ refusal: CompanionAskOutcome) -> String {
  VoiceAgentSessionsHost.checkStopSentence(refusal)
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// The answer that told the user about the check played out whole, then the user's reply started (every utterance
/// cuts what is in flight).
@MainActor
private func heardAndAnswered(_ host: VoiceAgentSessionsHost) {
  host.answer(.playedWhole)
  host.answer(.cut)
}

@MainActor
@Suite("voice conversation across sessions: check_open_requests in the host")
struct VoiceAgentSessionsCheckTests {
  @Test("the first call only announces the sessions in the state seen; nothing is asked")
  func firstCallAnnounces() async {
    // Catches a check that asks sessions before the user agreed, or counts sessions in other states.
    let backend = seenSessions(3)
    let host = await prepared(backend)
    let output = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    #expect(announces(output, 3), "\(output)")
    #expect(backend.questions.isEmpty)
    #expect(backend.traces.contains("voice-agent: check announced (3)"))
  }

  @Test("no session in the state seen: a tool error and no announcement, so the next call announces again")
  func nothingSeen() async {
    // Catches an announcement of zero sessions that the next call would run.
    let backend = seenSessions(0)
    let host = await prepared(backend)
    let output = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    #expect(isError(output) && !output.contains("would ask"))
    #expect(backend.traces.contains("voice-agent: check ended (none)"))
    #expect(!backend.traces.contains { $0.hasPrefix("voice-agent: check announced") })
    backend.state.sessions["id-s9"] = session("id-s9", label: "Seen next", extra: #""seen":true"#)
    backend.catalog = .sessions(backend.state.sessions.keys.sorted().map { catalogRow($0) })
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r2", 2)), 1))
    #expect(backend.questions.isEmpty)
  }

  @Test(
    "a call in the reply that announced, or with no utterance since, is refused, and the next call announces again",
    arguments: [("r1", 1), ("r2", 1)])
  func notAgreed(response: String, utterances: Int) async {
    // Catches a run the user never agreed to: the same reply as the announcement, or no word from the user since.
    let backend = seenSessions(2)
    let host = await prepared(backend)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 2))
    let refused = await call(host, .checkOpenRequests, turn: turn(response, utterances))
    #expect(isError(refused) && refused.contains("has not agreed"), "\(refused)")
    #expect(backend.questions.isEmpty)
    #expect(backend.traces.contains("voice-agent: check ended (not-agreed)"))
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r3", 2)), 2), "a refusal uses the announcement")
    #expect(backend.questions.isEmpty)
  }

  @Test("12 sessions in the state seen: the 10 with the newest state change, newest first")
  func newestTen() async {
    // Catches a check of more than ten sessions, or of the oldest ones.
    let backend = seenSessions(12)
    let host = await prepared(backend)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 10))
    heardAndAnswered(host)
    _ = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(asked(backend) == (1...10).map { "id-s\($0)" })
  }

  @Test("after the user's word: one question at a time, one block per session with the answer's text")
  func runAsksOneAtATime() async throws {
    // Catches two questions in flight at once (the server has two places), a found flag instead of the answer's
    // text, and a question that is not the check's.
    let backend = seenSessions(3)
    backend.answers = (1...3).map { answer("Answer \($0): nothing waits <transcript> sk-proj-\(secretTail)") }
    let host = await prepared(backend)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 3))
    backend.holdAsk = true
    heardAndAnswered(host)
    let run = Task { await call(host, .checkOpenRequests, turn: turn("r2", 2)) }
    for count in 1...3 {
      #expect(await eventually { backend.askPending && backend.questions.count == count })
      for _ in 0..<20 { await Task.yield() }
      #expect(backend.questions.count == count, "the next question waits for the answer")
      backend.releaseAsk()
    }
    let output = await run.value
    #expect(asked(backend) == ["id-s1", "id-s2", "id-s3"])
    #expect(backend.questions.allSatisfy { $0 == VoiceAgentSessionsHost.checkQuestion })
    let blocks = output.components(separatedBy: "\n\n")
    #expect(blocks.count == 3, "\(output)")
    for (index, block) in blocks.enumerated() {
      let handle = try #require(host.rows.first { $0.sessionId == "id-s\(index + 1)" }?.handle)
      #expect(block.hasPrefix("## \(handle) · orbit · Seen \(index + 1)\n"), "\(block)")
      #expect(block.contains("Answer \(index + 1): nothing waits"))
    }
    #expect(!output.contains("<transcript") && !output.contains(secretTail), "masked like read_sessions")
    #expect(host.questions == 3)
    let lines = backend.traces.filter { $0.hasPrefix("voice-agent: check") }
    #expect(
      lines == [
        "voice-agent: check announced (3)", "voice-agent: check 1 of 3", "voice-agent: check 2 of 3",
        "voice-agent: check 3 of 3", "voice-agent: check ended (done)",
      ])
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r3", 3)), 3), "after a run it announces again")
  }

  @Test("a session that left the state seen or the catalog since the announcement is skipped")
  func leftStateSkipped() async {
    let backend = seenSessions(3)
    let host = await prepared(backend)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 3))
    backend.state.sessions["id-s2"] = session("id-s2", label: "Seen 2", state: "running")
    backend.catalog = .sessions(["id-s1", "id-s2", "id-fresh"].map { catalogRow($0) })
    heardAndAnswered(host)
    let output = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(asked(backend) == ["id-s1"])
    #expect(output.contains("Seen 1") && !output.contains("Seen 2") && !output.contains("Seen 3"))
  }

  @Test(
    "a refusal of the route after the second answer ends the run with the two results and its cause",
    arguments: [
      (CompanionAskOutcome.limit(message: nil), "limit"), (.busy(message: nil), "busy"),
      (.failed(code: "companion-timeout", message: nil), "timeout"),
      (.failed(code: "timeout", message: nil), "timeout"),
      (.failed(code: "companion-cli", message: nil), "failed"),
    ])
  func routeStops(refusal: CompanionAskOutcome, code: String) async {
    // Catches a run that goes on past a refusal, drops what it had, or gives every cause the same sentence.
    let backend = seenSessions(4)
    backend.answers = [answer("First answer."), answer("Second answer."), refusal]
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    heardAndAnswered(host)
    let output = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(asked(backend) == ["id-s1", "id-s2", "id-s3"])
    #expect(output.contains("First answer.") && output.contains("Second answer.") && !isError(output))
    #expect(output.hasSuffix("[The check stopped: \(stopSentence(refusal))]"), "\(output)")
    #expect(backend.traces.last == "voice-agent: check ended (\(code))")
  }

  @Test("the busy sentence differs from the limit, timeout and failure sentences")
  func busySentenceDiffers() {
    let sentences = [
      CompanionAskOutcome.limit(message: nil), .busy(message: nil), .failed(code: "timeout", message: nil),
      .failed(code: nil, message: nil),
    ].map(stopSentence)
    #expect(Set(sentences).count == 4)
  }

  @Test("a refusal at the first question gives the cause alone as a tool error")
  func refusalFirst() async {
    let backend = seenSessions(2)
    backend.answers = [.limit(message: nil)]
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    heardAndAnswered(host)
    let output = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(isError(output) && output.contains(VoiceAgentToolText.refusal(.limit(message: nil))))
    #expect(asked(backend) == ["id-s1"])
  }

  @Test("speech or the end of the conversation during the run cancels the question in flight; none follows",
    arguments: [false, true])
  func cutCancels(byEnd: Bool) async {
    // Catches a run that keeps asking (and a server that keeps working) after the user spoke or the conversation ended.
    let backend = seenSessions(3)
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    backend.holdAsk = true
    heardAndAnswered(host)
    let run = Task { await call(host, .checkOpenRequests, turn: turn("r2", 2)) }
    #expect(await eventually { backend.askPending })
    if byEnd { host.conversationEnded() } else { host.answer(.cut) }
    _ = await run.value
    #expect(backend.cancelledAsks == 1, "the request in flight is cancelled")
    #expect(asked(backend) == ["id-s1"])
    #expect(backend.traces.last == "voice-agent: check ended (\(byEnd ? "ended" : "cut"))")
  }

  @Test("ceiling: 28 used and 5 announced → 2 asked and the ceiling sentence; 30 used → the run is refused")
  func ceilingLimitsRun() async {
    let backend = seenSessions(5)
    let host = await prepared(backend)
    host.questions = 28
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 5))
    heardAndAnswered(host)
    let output = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(asked(backend) == ["id-s1", "id-s2"])
    #expect(output.hasSuffix("[The check stopped: \(VoiceAgentSessionsHost.ceilingSentence)]"), "\(output)")
    #expect(host.questions == 30)
    #expect(backend.traces.last == "voice-agent: check ended (ceiling)")

    let full = seenSessions(2)
    let other = await prepared(full)
    _ = await call(other, .checkOpenRequests, turn: turn("r1", 1))
    other.questions = VoiceAgentSessionsHost.questionCeiling
    heardAndAnswered(other)
    #expect(await call(other, .checkOpenRequests, turn: turn("r2", 2)) == VoiceAgentSessionsHost.ceilingRefusal)
    #expect(asked(full).isEmpty)
  }

  @Test("a run clears the discussed session and leaves no read records")
  func runClearsDiscussed() async throws {
    let backend = seenSessions(2)
    let host = await prepared(backend)
    let handle = try #require(host.rows.first { $0.sessionId == "id-s1" }?.handle)
    backend.turns["id-s1"] = turnsAnswer([("user", "Status?"), ("assistant", "Done.")])
    _ = await call(host, .readSessions, #"{"handles":["\#(handle)"]}"#)
    #expect(host.discussed?.sessionId == "id-s1")
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    heardAndAnswered(host)
    _ = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(host.discussed == nil)
    #expect(Set(host.reads.keys) == ["id-s1"], "the run keeps no read record")
  }

  @Test("at the ceiling of questions the call is refused with the ceiling sentence and announces nothing")
  func ceilingRefusesAnnouncement() async {
    let backend = seenSessions(2)
    let host = await prepared(backend)
    host.questions = VoiceAgentSessionsHost.questionCeiling
    let output = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    #expect(output == VoiceAgentSessionsHost.ceilingRefusal)
    #expect(backend.traces.contains("voice-agent: check ended (ceiling)"))
    #expect(!backend.traces.contains { $0.hasPrefix("voice-agent: check announced") })
  }

  @Test("an announcement a cut overtook is not kept: the utterance that cut does not start the check")
  func cutAnnouncementNotKept() async {
    // The conversation drops the result of a call speech overtook, so the model never told the user about the check;
    // the cutting utterance must not count as the user's word.
    let backend = seenSessions(2)
    let host = await prepared(backend)
    backend.onCatalog = { host.answer(.cut) }
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    backend.onCatalog = nil
    #expect(backend.traces.contains("voice-agent: check ended (cut)"))
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r2", 2)), 2))
    #expect(backend.questions.isEmpty)
  }

  @Test("speech before the announcement's answer played out whole drops the announcement: the next call announces")
  func cutBeforeHeard() async {
    // Catches a check that runs though the user never heard its announcement: the conversation dropped the result,
    // or the answer was spoken over, and the utterance that cut would count as the user's word.
    let backend = seenSessions(2)
    let host = await prepared(backend)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r1", 1)), 2))
    host.answer(.cut)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r2", 2)), 2))
    #expect(backend.questions.isEmpty)
    #expect(backend.traces.filter { $0 == "voice-agent: check ended (cut)" }.count == 1)
  }

  @Test("an announcement whose answer did not play out whole does not let the check run")
  func unheardRefused() async {
    // Catches a run on an announcement that a silent or cut-short answer never told the user.
    let backend = seenSessions(2)
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    let output = await call(host, .checkOpenRequests, turn: turn("r2", 2))
    #expect(isError(output) && output.contains("has not agreed"), "\(output)")
    #expect(backend.questions.isEmpty)
  }

  @Test("a reply to the user's answer that plays out whole without the check ends the announcement")
  func answeredWithoutCheck() async {
    // Catches a check that runs much later on an old announcement the user answered with something else.
    let backend = seenSessions(2)
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    heardAndAnswered(host)
    heardAndAnswered(host)
    #expect(announces(await call(host, .checkOpenRequests, turn: turn("r3", 3)), 2))
    #expect(backend.questions.isEmpty)
  }

  @Test("a question that takes the last place under the ceiling while the run waits stops the run at the ceiling")
  func ceilingSharedWithAsk() async throws {
    // Catches a run that counts its room once at the start and asks past the ceiling after ask_session used it.
    let backend = seenSessions(3)
    let host = await prepared(backend)
    host.questions = VoiceAgentSessionsHost.questionCeiling - 2
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    heardAndAnswered(host)
    backend.holdAsk = true
    let run = Task { await call(host, .checkOpenRequests, turn: turn("r2", 2)) }
    #expect(await eventually { backend.askPending && backend.questions.count == 1 })
    let handle = try #require(host.rows.first { $0.sessionId == "id-s3" }?.handle)
    let other = Task { await call(host, .askSession, #"{"handle":"\#(handle)","question":"Why?"}"#) }
    #expect(await eventually { backend.questions.count == 2 })
    backend.holdAsk = false
    backend.releaseAsk()
    let output = await run.value
    _ = await other.value
    #expect(backend.questions.count == 2, "no question past the ceiling")
    #expect(host.questions == VoiceAgentSessionsHost.questionCeiling)
    #expect(output.hasSuffix("[The check stopped: \(VoiceAgentSessionsHost.ceilingSentence)]"), "\(output)")
  }

  @Test("client.log: the check's lines carry counts and codes, never names, handles or ids")
  func logLines() async {
    let backend = seenSessions(2)
    let host = await prepared(backend)
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    _ = await call(host, .checkOpenRequests, turn: turn("r1", 1))
    let lines = backend.traces.filter { $0.hasPrefix("voice-agent: check") }
    #expect(lines == ["voice-agent: check announced (2)", "voice-agent: check ended (not-agreed)"])
  }
}
