import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The discussed session of the conversation across sessions in the host (`VoiceAgentSessionsHost+Discussion.swift`):
// which reads and `discuss_session` calls point at a session, the refusals of `discuss_session`, the pick-up after an
// answer played whole with the read's `conversation` and `readMark`, the cases without one, the outcome that changes
// nothing, the `client.log` lines, and the list state of a result the voice agent picked up. The answer events come
// straight from the test (`host.answer`); the whole route over the conversation core:
// `VoiceAgentSessionsConversationTests`. Fakes and samples: `VoiceAgentSessionsHostTests`. All session data is
// synthetic. Owner: voice agent.

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// Lets a pick-up task that was started run to its request.
@MainActor
private func settle() async {
  for _ in 0..<50 { await Task.yield() }
}

/// A decomposed accent: equal to the composed one as a Swift string, different in bytes.
private let alphaMark = "r1:2026-11-20T10:00:00.000Z:e\u{301}"
private let alphaConversation = "Tjo8_3W~é"

/// Three finished sessions in the catalog: Alpha with messages, Birch whose turns answer has none, Cedar with messages.
@MainActor
private func threeFinished() -> FakeVoiceAgentBackend {
  let backend = FakeVoiceAgentBackend()
  backend.state = appState([
    session("id-a", project: "orbit", label: "Alpha", stateAgo: 60),
    session("id-b", project: "orbit", label: "Birch", stateAgo: 120),
    session("id-c", project: "willow", label: "Cedar", stateAgo: 180),
  ])
  backend.catalog = .sessions([
    catalogRow("id-a", conversation: alphaConversation), catalogRow("id-b"), catalogRow("id-c"),
  ])
  backend.turns["id-a"] = turnsAnswer(
    [("user", "Fix the login"), ("assistant", "Fixed the token check.")], conversation: alphaConversation,
    readMark: alphaMark)
  backend.turns["id-b"] = turnsAnswer([], readMark: "mark-b")
  backend.turns["id-c"] = turnsAnswer([("user", "Run the tests"), ("assistant", "All green.")], readMark: "mark-c")
  return backend
}

@MainActor
private func prepared(_ backend: FakeVoiceAgentBackend) async -> VoiceAgentSessionsHost {
  let host = VoiceAgentSessionsHost(backend: backend, sonioxAllowed: true, now: { Sample.now })
  #expect(await host.prepare() == nil)
  return host
}

/// The pick-ups as `session readMark`.
@MainActor
private func pickUps(_ backend: FakeVoiceAgentBackend) -> [String] {
  backend.pickUps.map { "\($0.sessionId) \($0.readMark)" }
}

extension VoiceAgentSessionsHostTests {
  // Catches: no pick-up, or a mark or conversation normalised on its way back to the server.
  @Test("a read of one handle and an answer played whole: one pick-up with the read's conversation and readMark")
  func singleReadPicksUp() async throws {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    #expect(host.discussed == VoiceAgentDiscussed(sessionId: "id-a", handle: "s1", project: "orbit", name: "Alpha"))
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 1 })
    let pickUp = try #require(backend.pickUps.first)
    #expect(pickUp.sessionId == "id-a")
    #expect(Array(pickUp.readMark.utf8) == Array(alphaMark.utf8))
    #expect(Array(pickUp.conversation.utf8) == Array(alphaConversation.utf8))
    host.answer(.playedWhole)
    await settle()
    #expect(backend.pickUps.count == 1, "a second whole answer after the same read picks up nothing")
  }

  // Catches: a pick-up whose mark names no read, which the server refuses.
  @Test("a read without messages and an answer played whole: no pick-up")
  func readWithoutMessages() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s2"]}"#)
    host.answer(.playedWhole)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a review of several sessions that picks up results the agent did not talk about.
  @Test("a read of three sessions by filter and an answer played whole: no pick-up, no discussed session")
  func filterOfThree() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    _ = await call(host, .readSessions, #"{"filter":"finished"}"#)
    #expect(backend.reads.filter { $0.hasPrefix("turns") }.count == 4)
    #expect(host.discussed == nil, "the filter clears the session pointed at before")
    host.answer(.playedWhole)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a filter that happened to pick one session counted as a pointing.
  @Test("a filter that matched one session points at nothing: no pick-up")
  func filterMatchedOne() async {
    let backend = threeFinished()
    backend.state = appState([
      session("id-a", project: "orbit", label: "Alpha", stateAgo: 60),
      session("id-b", project: "orbit", label: "Birch", extra: #""seen":true"#, stateAgo: 120),
      session("id-c", project: "willow", label: "Cedar", extra: #""seen":true"#, stateAgo: 180),
    ])
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"filter":"finished"}"#)
    #expect(backend.reads.filter { $0.hasPrefix("turns") } == ["turns id-a 3"])
    #expect(host.discussed == nil)
    host.answer(.playedWhole)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a cut answer that still picks up, and a pointing that survives the cut for the next answer.
  @Test("an answer cut by speech: no pick-up, and the next answer played whole without a new pointing: none")
  func cutAnswer() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.answer(.cut)
    host.answer(.playedWhole)
    host.answer(.playedWhole)
    #expect(host.discussed?.sessionId == "id-a", "the cut keeps the discussed session")
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a read that speech overtook naming its session on the bar, replacing the discussed session, or leaving a
  // read record of turns the model never got, which a later discuss_session would pick up.
  @Test("a cut while the read of one handle is in flight: the read points at nothing and leaves no read")
  func cutDuringTheRead() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    backend.onTurns = { host.answer(.cut) }
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    backend.onTurns = nil
    #expect(host.discussed?.sessionId == "id-c")
    host.answer(.playedWhole)
    await settle()
    #expect(backend.pickUps.isEmpty, "the cut used the pointing at the third session up")
    #expect(await call(host, .discussSession, #"{"handle":"s1"}"#).contains("Read this session first"))
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-a \(alphaMark)"])
  }

  // Catches: a pick-up after the end, from a pointing the end should have dropped.
  @Test("the conversation ended before the answer ended: no pick-up")
  func endedBeforeTheAnswerEnded() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.conversationEnded()
    host.answer(.playedWhole)
    await settle()
    #expect(backend.pickUps.isEmpty)
    #expect(host.discussed == nil)
  }

  // Catches: a pick-up while an end rule holds (a logout), which would go out under the wrong login.
  @Test("an end rule that holds when the answer played whole: no pick-up")
  func blockedWhenTheAnswerEnded() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    backend.state.auth = .loggedOut(.notLoggedIn)
    host.answer(.playedWhole)
    await settle()
    #expect(backend.pickUps.isEmpty)
  }

  // Catches: a newer read that never gets its pick-up, or one that reuses the older mark.
  @Test("a new read of the session after a pick-up: the next answer played whole picks up with the new mark")
  func newReadNewMark() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 1 })
    backend.turns["id-c"] = turnsAnswer([("user", "Run the tests"), ("assistant", "Still green.")], readMark: "mark-c2")
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 2 })
    #expect(pickUps(backend) == ["id-c mark-c", "id-c mark-c2"])
  }

  // Catches: a refused pick-up that ends the conversation, tells the model, or blocks the next pick-up.
  @Test("a pick-up refused as a changed result: the conversation goes on, the log has the code, a new read picks up")
  func resultChangedGoesOn() async {
    let backend = threeFinished()
    backend.pickUpOutcome = .resultChanged
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.traces.contains("voice-agent: pick-up refused (result-changed)") })
    #expect(host.endReason() == nil)
    #expect(!isError(await call(host, .listSessions)))
    backend.pickUpOutcome = .pickedUp
    backend.turns["id-c"] = turnsAnswer([("user", "Run the tests"), ("assistant", "Still green.")], readMark: "mark-c2")
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.traces.contains("voice-agent: pick-up accepted") })
    #expect(pickUps(backend) == ["id-c mark-c", "id-c mark-c2"])
  }

  // Catches: a wrong or missing code, and a session id, name or mark in the line.
  @Test(
    "client.log: one line per pick-up outcome with its code, without the session",
    arguments: [
      (CompanionPickUpOutcome.pickedUp, "voice-agent: pick-up accepted"),
      (.resultChanged, "voice-agent: pick-up refused (result-changed)"),
      (.disabled, "voice-agent: pick-up refused (off)"),
      (.outsideCatalog, "voice-agent: pick-up refused (unknown-session)"),
      (.loggedOut, "voice-agent: pick-up refused (logged-out)"),
      (.cancelled, "voice-agent: pick-up refused (cancelled)"),
      (.timedOut, "voice-agent: pick-up refused (timeout)"),
      (.refused, "voice-agent: pick-up refused (failed)"),
      (.failed, "voice-agent: pick-up refused (failed)"),
    ])
  func logLine(outcome: CompanionPickUpOutcome, line: String) async {
    let backend = threeFinished()
    backend.pickUpOutcome = outcome
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.traces.contains(line) })
    let pickUpLines = backend.traces.filter { $0.contains("pick-up") }
    #expect(pickUpLines == [line])
    #expect(backend.traceBudgets.allSatisfy { $0 == .voiceAgent })
  }

  // Catches: a review that cannot pick up the one session the agent goes on to talk about, or picks up the others.
  @Test("a read of three sessions by filter, then discuss_session of one and an answer played whole: that one only")
  func filterThenDiscuss() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"filter":"finished"}"#)
    host.answer(.playedWhole)
    let output = await call(host, .discussSession, #"{"handle":"s3"}"#)
    #expect(!isError(output), "\(output)")
    #expect(host.discussed == VoiceAgentDiscussed(sessionId: "id-c", handle: "s3", project: "willow", name: "Cedar"))
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a pointing at a session the model knows nothing of, which would pick up a result nobody talked about.
  @Test("discuss_session of a session not read in this conversation, an unknown handle or none: refused, no change")
  func discussRefusals() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 1 })
    for arguments in [#"{"handle":"s1"}"#, #"{"handle":"s9"}"#, "{}"] {
      #expect(isError(await call(host, .discussSession, arguments)), "\(arguments)")
      #expect(host.discussed?.sessionId == "id-c", "\(arguments)")
      host.answer(.playedWhole)
    }
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 2 })
    #expect(pickUps(backend) == ["id-c mark-c", "id-a \(alphaMark)"])
    #expect(backend.traces.contains("voice-agent: discuss refused (not-read)"))
    #expect(backend.traces.contains("voice-agent: discuss refused (unknown-handle)"))
  }

  // Catches: a second pick-up of a read when the session is pointed at again without a new read.
  @Test("pointed at again by discuss_session after its pick-up, without a new read: no second pick-up")
  func repointedSameRead() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 1 })
    _ = await call(host, .discussSession, #"{"handle":"s3"}"#)
    host.answer(.playedWhole)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    host.answer(.playedWhole)
    #expect(await eventually { backend.pickUps.count == 2 })
    await settle()
    #expect(pickUps(backend) == ["id-c mark-c", "id-a \(alphaMark)"])
  }

  // Catches: a cut that blocks the session for the rest of the conversation.
  @Test("after a cut, discuss_session of the same session arms the pick-up again")
  func discussAfterCut() async {
    let backend = threeFinished()
    let host = await prepared(backend)
    _ = await call(host, .readSessions, #"{"handles":["s3"]}"#)
    host.answer(.cut)
    host.answer(.playedWhole)
    _ = await call(host, .discussSession, #"{"handle":"s3"}"#)
    host.answer(.playedWhole)
    #expect(await eventually { !backend.pickUps.isEmpty })
    #expect(pickUps(backend) == ["id-c mark-c"])
  }

  // Catches: a result the voice agent picked up listed as one a person saw, or as still finished.
  @Test("the list state of a result the voice agent picked up is seen-by-voice; a person's is seen")
  func seenByVoiceState() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([
      session("id-v", label: "Voice picked", extra: #""seen":true,"seenBy":"voice-agent""#),
      session("id-p", label: "Person saw", extra: #""seen":true"#),
    ])
    backend.catalog = .sessions([catalogRow("id-v"), catalogRow("id-p")])
    let host = await prepared(backend)
    let list = rows(await call(host, .listSessions))
    let states = Dictionary(uniqueKeysWithValues: list.map { ($0["name"] as? String ?? "", $0["state"] as? String) })
    #expect(states["Voice picked"] == "seen-by-voice")
    #expect(states["Person saw"] == "seen")
  }
}
