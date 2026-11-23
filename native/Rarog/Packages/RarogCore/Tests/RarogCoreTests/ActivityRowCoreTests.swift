import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Core of the activity row: the session event counter behind the data-driven
// glyph tick and the three time bases (turn clock, tool, silence). Owner: transcript (activity row).

private let now = Date(timeIntervalSince1970: 1_790_000_000)
private let sid = "s1"

private func iso(_ date: Date) -> String { ISOTime.string(date) }

private func activity(_ id: String, _ fields: String) throws -> ServerEvent {
  try Frames.decode(#"{"type":"activity","sessionId":"\#(id)",\#(fields)}"#)
}

/// A listed session in `state` with its transcript loaded from the session stream.
private func loaded(state: String = "running", extra: String = "", messages: [String] = [],
                    activity: String? = nil) throws -> AppState {
  var app = AppState(clientBuild: 7)
  play(&app, [try Frames.snapshot([Frames.summary(sid, state: state, extra: extra)])], at: now)
  play(&app, [try Frames.transcript(sid, messages: messages, activity: activity)], source: .session(sid), at: now)
  return app
}

@Suite("activity row core: event counter and time bases")
struct ActivityRowCoreTests {
  @Test("the counter grows once per session-channel activity; the global copy of the same activity does not count")
  func activityCountsOnceAcrossChannels() throws {
    var app = try loaded()
    #expect(app.turnEvents(sid) == 0)
    let tool = try activity(sid, #""kind":"tool","toolName":"Read","summary":"a.swift""#)
    play(&app, [tool], source: .session(sid), at: now)
    play(&app, [tool], source: .global, at: now)
    #expect(app.turnEvents(sid) == 1)
    play(&app, [try activity(sid, #""kind":"thinking""#)], source: .global, at: now)
    play(&app, [try activity(sid, #""kind":"thinking""#)], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 2)
  }

  @Test("snapshots do not move the counter, also when they carry an activity")
  func snapshotsDoNotCount() throws {
    var app = try loaded(activity: #"{"kind":"tool","toolName":"Shell","summary":"ls"}"#)
    play(&app, [try Frames.transcript(sid, activity: #"{"kind":"thinking"}"#)], source: .session(sid), at: now)
    play(&app, [try Frames.snapshot([Frames.summary(sid, state: "running")])], at: now)
    #expect(app.turnEvents(sid) == 0)
  }

  @Test("a new message in the turn counts once; its repeat does not")
  func messageCountsOnce() throws {
    var app = try loaded()
    let message = try Frames.message(sid, seq: 1, text: "Reading the file.")
    play(&app, [message], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 1)
    play(&app, [message], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 1)
    play(&app, [try Frames.message(sid, seq: 2, role: "system", text: "git pull: ok")], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 2)
  }

  @Test("outside a turn neither an activity nor a message counts")
  func outsideTurnDoesNotCount() throws {
    var app = try loaded(state: "idle")
    play(&app, [try activity(sid, #""kind":"thinking""#)], source: .session(sid), at: now)
    play(&app, [try Frames.message(sid, seq: 1, role: "user", text: "hi")], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 0)
  }

  @Test("turn clock: from `turnSince`, without it from `stateSince`")
  func turnClockBase() throws {
    let turnStart = now.addingTimeInterval(-300)
    let stateStart = now.addingTimeInterval(-20)
    var with = AppState(clientBuild: 7)
    play(&with, [try Frames.snapshot([
      Frames.summary(sid, stateSince: iso(stateStart), extra: #","turnSince":"\#(iso(turnStart))""#),
    ])], at: now)
    #expect(with.activityClocks(sid).turn == turnStart)
    var without = AppState(clientBuild: 7)
    play(&without, [try Frames.snapshot([Frames.summary(sid, stateSince: iso(stateStart))])], at: now)
    #expect(without.activityClocks(sid).turn == stateStart)
  }

  @Test("turn clock survives a permission inside the turn: `stateSince` moves, the base does not")
  func turnClockSurvivesPermission() throws {
    let turnStart = now.addingTimeInterval(-300)
    var app = AppState(clientBuild: 7)
    play(&app, [try Frames.snapshot([
      Frames.summary(sid, stateSince: iso(turnStart), extra: #","turnSince":"\#(iso(turnStart))""#),
    ])], at: now)
    let asked = iso(now.addingTimeInterval(-10))
    play(&app, [
      try Frames.state(sid, "waiting-permission", since: asked),
      try Frames.sessionChanged(Frames.summary(
        sid, state: "waiting-permission", stateSince: asked, extra: #","turnSince":"\#(iso(turnStart))""#)),
    ], at: now)
    #expect(app.sessions[sid]?.stateSince == asked)
    #expect(app.activityClocks(sid).turn == turnStart)
    // Back to work after the answer: still the same turn.
    play(&app, [try Frames.state(sid, "running", since: iso(now))], at: now)
    #expect(app.activityClocks(sid).turn == turnStart)
  }

  @Test("tool start: the snapshot's activity aged 70 s starts 70 s before its arrival; no tool, no tool start")
  func toolStartFromSnapshotAge() throws {
    let app = try loaded(activity: #"{"kind":"tool","toolName":"Shell","summary":"swift test","elapsedSeconds":70}"#)
    #expect(app.activityClocks(sid).tool == now.addingTimeInterval(-70))
    let thinking = try loaded(activity: #"{"kind":"thinking","elapsedSeconds":70}"#)
    #expect(thinking.activityClocks(sid).tool == nil)
  }

  @Test("silence starts at the later of the last message and the latest activity's start")
  func silencePicksTheLater() throws {
    let messageAt = now.addingTimeInterval(-120)
    let messages = [Frames.messageJSON(seq: 1, role: "assistant", text: "Running tests.", at: iso(messageAt))]
    let recentActivity = try loaded(messages: messages, activity: #"{"kind":"thinking","elapsedSeconds":30}"#)
    #expect(recentActivity.activityClocks(sid).silence == now.addingTimeInterval(-30))
    let oldActivity = try loaded(messages: messages, activity: #"{"kind":"thinking","elapsedSeconds":400}"#)
    #expect(oldActivity.activityClocks(sid).silence == messageAt)
    // A live activity without age starts when it arrives.
    var live = try loaded(messages: messages)
    #expect(live.activityClocks(sid).silence == messageAt)
    play(&live, [try activity(sid, #""kind":"thinking""#)], source: .session(sid), at: now)
    #expect(live.activityClocks(sid).silence == now)
  }

  @Test("silence starts at the latest message time, not at the highest seq: an imported prompt can be older")
  func silenceTakesTheLatestMessageTime() throws {
    let answerAt = now.addingTimeInterval(-60)
    let messages = [
      Frames.messageJSON(seq: 1, role: "assistant", text: "Done.", at: iso(answerAt)),
      Frames.messageJSON(seq: 2, role: "user", text: "Next.", at: iso(now.addingTimeInterval(-360))),
    ]
    #expect(try loaded(messages: messages).activityClocks(sid).silence == answerAt)
    let between = try loaded(messages: messages, activity: #"{"kind":"thinking","elapsedSeconds":200}"#)
    #expect(between.activityClocks(sid).silence == answerAt)
  }

  @Test("an `idle` activity is the end of movement, not an event: it does not tick the glyph")
  func idleDoesNotCount() throws {
    var app = try loaded()
    play(&app, [try activity(sid, #""kind":"idle""#)], source: .session(sid), at: now)
    #expect(app.turnEvents(sid) == 0)
  }
}
