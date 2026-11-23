import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The activity line under the transcript: which label and detail a state
// gets, the MCP tool name, the 60 s and 90 s thresholds, the turn clock and the VoiceOver content key. Texts come from
// the copy registry, never literals. Tool names that the source guard forbids as literals are looked up through
// `ToolActivity`, so this file holds no such literal.

private func activity(_ json: String) -> Activity {
  Sample.decode(Activity.self, json)
}

/// A transcript with one user message and, optionally, an activity that arrived `activityAgo` seconds before `now`.
private func view(
  _ json: String? = nil, activityAgo: TimeInterval = 0, messages: [TranscriptMessage]? = nil, open: String? = nil
) -> TranscriptState {
  var view = TranscriptState()
  view.messages = messages ?? [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))]
  view.snapshots = 1
  if let json {
    view.activity = activity(json)
    view.activityAt = Sample.now.addingTimeInterval(-activityAgo)
  }
  if let open { view.open = OpenAgentMessage(text: open) }
  return view
}

/// The line of a running session with explicit clocks (seconds before `now`).
private func line(
  _ view: TranscriptState, state: SessionState? = .running, turn: TimeInterval = 300, tool: TimeInterval? = nil,
  silence: TimeInterval? = nil, now: Date = Sample.now, downSince: Date? = nil
) -> ActivityRowLine? {
  let clocks = ActivityClocks(
    turn: Sample.now.addingTimeInterval(-turn), tool: tool.map { Sample.now.addingTimeInterval(-$0) },
    silence: silence.map { Sample.now.addingTimeInterval(-$0) })
  return ActivityRowLine.make(view: view, state: state, clocks: clocks, now: now, downSince: downSince)
}

/// A tool name of the copy table whose line label is `label` (the guard keeps some names out of test sources).
private func toolNamed(_ label: String) throws -> String {
  try #require(ToolActivity.lineLabels.first { $0.value == label }?.key)
}

@Suite("activity line: label and detail per state")
struct ActivityRowLineTests {
  @Test("a tool with its own description: the description is the label, the summary the detail")
  func describedTool() throws {
    let run = try toolNamed(UICopy.activityLineRunning)
    let row = try #require(line(view(#"{"kind":"tool","toolName":"\#(run)","summary":"pnpm test","description":"Run the tests"}"#)))
    #expect(row.label == "Run the tests" && row.detail == "pnpm test")
    #expect(row.detailIsMono && row.glyph == .tool(.run))
  }

  @Test("file tools: the verb and the file name; run, search: the verb and the summary, mono")
  func knownTools() throws {
    for (name, label) in [("Read", UICopy.activityLineReading), ("Edit", UICopy.activityLineEditing),
                          ("Write", UICopy.activityLineWriting)] {
      let row = try #require(line(view(#"{"kind":"tool","toolName":"\#(name)","summary":"/Users/d/a/b/c/d.ts"}"#)))
      #expect(row.label == label && row.detail == "d.ts" && row.detailIsMono, "\(name)")
    }
    let run = try toolNamed(UICopy.activityLineRunning)
    let command = try #require(line(view(#"{"kind":"tool","toolName":"\#(run)","summary":"git status"}"#)))
    #expect(command.label == UICopy.activityLineRunning && command.detail == "git status" && command.detailIsMono)
    for name in ["Grep", "Glob"] {
      let row = try #require(line(view(#"{"kind":"tool","toolName":"\#(name)","summary":"TODO\\("}"#)))
      #expect(row.label == UICopy.activityLineSearching && row.detail == "TODO\\(" && row.detailIsMono, "\(name)")
      #expect(row.glyph == .tool(.search))
    }
  }

  @Test("web tools: the verb and the query or address, not mono")
  func webTools() throws {
    let search = try #require(line(view(#"{"kind":"tool","toolName":"WebSearch","summary":"swift testing"}"#)))
    #expect(search.label == UICopy.activityLineSearchingWeb && search.detail == "swift testing" && !search.detailIsMono)
    let fetch = try #require(line(view(#"{"kind":"tool","toolName":"WebFetch","summary":"https://example.com/a"}"#)))
    #expect(fetch.label == UICopy.activityLineFetching && fetch.detail == "https://example.com/a")
    #expect(fetch.glyph == .tool(.web))
  }

  @Test("MCP and unknown tools: the readable or raw name; a summary equal to the name is not a detail")
  func otherTools() throws {
    let mcp = try #require(line(view(#"{"kind":"tool","toolName":"mcp__firecrawl__firecrawl_search","summary":"herdr api"}"#)))
    #expect(mcp.label == "Firecrawl search" && mcp.detail == "herdr api" && !mcp.detailIsMono)
    #expect(mcp.glyph == .tool(.mcp))
    let unknown = try #require(line(view(#"{"kind":"tool","toolName":"Frobnicate","summary":"x=1"}"#)))
    #expect(unknown.label == "Frobnicate" && unknown.detail == "x=1" && unknown.glyph == .tool(.other))
    let bare = try #require(line(view(#"{"kind":"tool","toolName":"Frobnicate","summary":"Frobnicate"}"#)))
    #expect(bare.detail.isEmpty)
    let unnamed = try #require(line(view(#"{"kind":"tool"}"#)))
    #expect(unnamed.label == UICopy.activityLineUnnamedTool)
  }

  @Test("thinking, and a working session without an activity: Thinking without a detail")
  func thinking() throws {
    let thinking = try #require(line(view(#"{"kind":"thinking"}"#), silence: 5))
    #expect(thinking.label == UICopy.activityLineThinking && thinking.detail.isEmpty && thinking.glyph == .thinking)
    let fallback = try #require(line(view(), silence: 5))
    #expect(fallback.label == UICopy.activityLineThinking && fallback.kind == .thinking)
  }

  @Test("waiting: the server's sentence or Waiting")
  func waiting() throws {
    #expect(try #require(line(view(#"{"kind":"waiting"}"#))).label == UICopy.activityLineWaiting)
    let retry = try #require(line(view(#"{"kind":"waiting","summary":"retry 3/10"}"#)))
    #expect(retry.label == "retry 3/10" && retry.glyph == .waiting)
  }

  @Test("delegation: the sentence and segments of today's line; no quiet and no still running")
  func delegation() throws {
    let json = #"{"kind":"tool","toolName":"Spawn","delegation":"workflow","workflow":"refactor","agents":3,"agentsDone":2}"#
    let today = ActivityText.delegationLine(ViewActivity(activity(json)))
    let row = try #require(line(view(json, activityAgo: 200), tool: 200, silence: 200))
    #expect(row.label == today.lead && row.detail == today.tail && row.glyph == .delegation)
    #expect(row.segments == ActivityText.workflowSegments(ViewActivity(activity(json))))
  }

  @Test("no line: a streaming answer, a session that is not working, an empty transcript")
  func noLine() {
    #expect(line(view(open: "writing…")) == nil)
    #expect(line(view(), state: .waitingInput) == nil)
    var empty = Sample.state(session: Sample.session(), messages: [])
    empty.transcripts["s1"]?.activity = activity(#"{"kind":"thinking"}"#)
    empty.transcripts["s1"]?.activityAt = Sample.now
    empty.sessionStream = .online
    #expect(ActivityRowLine.make(state: empty, sessionId: "s1", now: Sample.now) == nil)
  }

  @Test("agent start and interrupt keep today's sentences, with their own glyphs")
  func startAndInterrupt() throws {
    var starting = Sample.state(session: Sample.session(state: "starting"), messages: [])
    starting.sessionStream = .online
    let start = try #require(ActivityRowLine.make(state: starting, sessionId: "s1", now: Sample.now))
    #expect(start.label == UICopy.sendBlock(.starting, session: nil) && start.glyph == .starting)

    var running = Sample.state(
      session: Sample.session(state: "running"), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))])
    running.sessionStream = .online
    running.apply(.turnControl(.interruptStarted(sessionId: "s1", at: Sample.now.addingTimeInterval(-3))), now: Sample.now)
    let stop = try #require(ActivityRowLine.make(state: running, sessionId: "s1", now: Sample.now))
    #expect(stop.label == UICopy.activityInterrupting && stop.glyph == .interrupting && !stop.isLive)
  }
}

@Suite("activity line: thresholds, the turn clock and the stream")
struct ActivityRowLineTimeTests {
  @Test("a tool running 60 s gets still running as its detail; 59 s keeps the summary")
  func stillRunning() throws {
    let json = #"{"kind":"tool","toolName":"Grep","summary":"needle"}"#
    let early = try #require(line(view(json, activityAgo: 59), tool: 59, silence: 59))
    #expect(early.detail == "needle" && early.detailIsMono)
    let late = try #require(line(view(json, activityAgo: 60), tool: 60, silence: 60))
    let since = Sample.now.addingTimeInterval(-60)
    #expect(late.label == UICopy.activityLineSearching)
    #expect(late.detail == UICopy.activityLineStillRunning(RelativeTime.short(since: since, now: Sample.now)))
    #expect(!late.detailIsMono)
  }

  @Test("thinking quiet for 90 s says so in the label; 89 s is still Thinking")
  func quiet() throws {
    let early = try #require(line(view(#"{"kind":"thinking"}"#, activityAgo: 89), silence: 89))
    #expect(early.label == UICopy.activityLineThinking && early.glyph == .thinking && early.isLive)
    let late = try #require(line(view(#"{"kind":"thinking"}"#, activityAgo: 90), silence: 90))
    let since = Sample.now.addingTimeInterval(-90)
    #expect(late.label == UICopy.activityLineQuiet(RelativeTime.short(since: since, now: Sample.now)))
    #expect(late.glyph == .quiet && !late.isLive && late.detail.isEmpty)
  }

  @Test("the clock counts the turn, not the tool or the silence")
  func turnClock() throws {
    let row = try #require(line(view(#"{"kind":"tool","toolName":"Grep"}"#, activityAgo: 4), turn: 125, tool: 4, silence: 4))
    #expect(row.clockSeconds == 125)
    #expect(row.clock == RelativeTime.short(since: Sample.now.addingTimeInterval(-125), now: Sample.now))
  }

  @Test("broken stream with content: the line stays, offline glyph, last update as the detail, clock frozen")
  func streamDown() throws {
    let down = Sample.now.addingTimeInterval(-20)
    let row = try #require(line(
      view(#"{"kind":"tool","toolName":"Grep","summary":"needle"}"#, activityAgo: 42), turn: 100, tool: 42, silence: 42,
      downSince: down))
    #expect(row.label == UICopy.activityLineSearching && row.glyph == .offline && row.streamDown && !row.isLive)
    #expect(row.detail == UICopy.activityLineLastUpdate(RelativeTime.short(since: Sample.now.addingTimeInterval(-42), now: Sample.now)))
    #expect(row.clockSeconds == 80, "the clock stops at the break")
    let later = try #require(line(
      view(#"{"kind":"tool","toolName":"Grep","summary":"needle"}"#, activityAgo: 42), turn: 100, tool: 42, silence: 42,
      now: Sample.now.addingTimeInterval(30), downSince: down))
    #expect(later.clockSeconds == 80)
  }

  @Test("the glyph is live green only in a live turn: a running tool yes, offline and quiet no")
  func liveGlyph() throws {
    #expect(try #require(line(view(#"{"kind":"tool","toolName":"Grep"}"#), tool: 1, silence: 1)).isLive)
    #expect(try #require(line(view(#"{"kind":"thinking"}"#), silence: 1)).isLive)
  }

  @Test("the glyph breathes and the label shimmers only while the agent works on a live stream")
  func working() throws {
    let tool = #"{"kind":"tool","toolName":"Grep","summary":"needle"}"#
    let delegation = #"{"kind":"tool","toolName":"Spawn","delegation":"workflow","workflow":"w","agents":2,"agentsDone":1}"#
    let cases: [(String, ActivityRowLine?, Bool)] = [
      ("thinking", line(view(#"{"kind":"thinking"}"#, activityAgo: 5), silence: 5), true),
      ("thinking quiet for 90 s", line(view(#"{"kind":"thinking"}"#, activityAgo: 90), silence: 90), false),
      ("a tool past still running", line(view(tool, activityAgo: 200), tool: 200, silence: 200), true),
      ("a delegation", line(view(delegation, activityAgo: 200), tool: 200, silence: 200), true),
      ("waiting", line(view(#"{"kind":"waiting"}"#)), false),
      ("broken stream", line(view(tool, activityAgo: 5), tool: 5, silence: 5, downSince: Sample.now), false),
    ]
    for (name, row, working) in cases {
      #expect(try #require(row, "\(name)").isWorking == working, "\(name)")
    }
    var starting = Sample.state(session: Sample.session(state: "starting"), messages: [])
    starting.sessionStream = .online
    #expect(try #require(ActivityRowLine.make(state: starting, sessionId: "s1", now: Sample.now)).isWorking == false)
  }

  @Test("VoiceOver content key: the same across ticks of time, different for another line")
  func contentKey() throws {
    func key(_ json: String, age: TimeInterval, tick: TimeInterval, down: Bool = false) throws -> String {
      let now = Sample.now.addingTimeInterval(tick)
      return try #require(line(
        view(json, activityAgo: age), turn: age + 10, tool: age, silence: age, now: now,
        downSince: down ? Sample.now.addingTimeInterval(-1) : nil)).contentKey
    }
    let thinking = #"{"kind":"thinking"}"#
    let tool = #"{"kind":"tool","toolName":"Grep","summary":"needle"}"#
    #expect(try key(thinking, age: 5, tick: 0) == key(thinking, age: 5, tick: 20))
    #expect(try key(thinking, age: 95, tick: 0) == key(thinking, age: 95, tick: 200), "Quiet for counts without its number")
    #expect(try key(tool, age: 61, tick: 0) == key(tool, age: 61, tick: 300), "still running without its number")
    #expect(try key(tool, age: 5, tick: 0, down: true) == key(tool, age: 5, tick: 40, down: true), "last update too")
    #expect(try key(tool, age: 5, tick: 0) != key(thinking, age: 5, tick: 0))
    #expect(try key(tool, age: 5, tick: 0) != key(tool, age: 61, tick: 0), "still running is new content")
  }

  @Test("VoiceOver sentence: label, detail, the turn time in words, connecting… on a broken stream")
  func spoken() throws {
    let row = try #require(line(
      view(#"{"kind":"tool","toolName":"Grep","summary":"needle"}"#, activityAgo: 5), turn: 125, tool: 5, silence: 5,
      downSince: Sample.now))
    let turn = UICopy.sinceSpoken(UICopy.spokenDuration(125))
    #expect(row.spoken.hasPrefix(UICopy.activityLineSearching))
    #expect(row.spoken.contains(turn) && row.spoken.hasSuffix(UICopy.connecting))
  }
}

@Suite("activity line: MCP tool names")
struct MCPToolNameTests {
  @Test("server with a capital, underscores to spaces, the repeated server prefix dropped")
  func names() {
    #expect(ToolActivity.lineLabel(for: "mcp__firecrawl__firecrawl_search") == "Firecrawl search")
    #expect(ToolActivity.lineLabel(for: "mcp__catalog__catalog_create_task") == "Catalog create task")
    #expect(ToolActivity.lineLabel(for: "mcp__claude_ai_Claude_Docs__batch") == "Claude ai Claude Docs batch")
    #expect(ToolActivity.lineLabel(for: "mcp__asana__get_my_tasks") == "Asana get my tasks")
  }

  @Test("a name that only looks like MCP stays raw")
  func malformed() {
    #expect(ToolActivity.lineLabel(for: "mcp__solo") == "mcp__solo")
    #expect(ToolActivity.lineLabel(for: "mcp____tool") == "mcp____tool")
    #expect(ToolActivity.category(for: "mcp__catalog__catalog_create_task") == .mcp)
  }
}

/// The line of a session in the store (`make(state:sessionId:now:link:)`): the stream memory, the agent start and the
/// subagents read from the transcript. Carried over from the old row model's tests when that model left.
@Suite("activity line: a session in the store, the stream outage, the agent start")
struct ActivityRowLineSessionTests {
  private func state(
    _ session: SessionSummary, messages: [TranscriptMessage] = [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))],
    activity json: String? = nil, activityAgo: TimeInterval = 0
  ) -> AppState {
    var state = Sample.state(session: session, messages: messages)
    if let json {
      state.transcripts[session.id]?.activity = activity(json)
      state.transcripts[session.id]?.activityAt = Sample.now.addingTimeInterval(-activityAgo)
    }
    state.sessionStream = .online
    return state
  }

  @Test("agent start on a broken stream: the start line stands, offline; a trust dialog has no start line")
  func startingStreamDown() throws {
    var down = state(Sample.session(state: "starting"), messages: [])
    down.sessionStream = .offline(since: Sample.now.addingTimeInterval(-20))
    let row = try #require(ActivityRowLine.make(state: down, sessionId: "s1", now: Sample.now))
    #expect(row.glyph == .starting && row.streamDown && row.clock == nil)
    let trust = state(Sample.session(state: "waiting-permission"), messages: [])
    #expect(ActivityRowLine.make(state: trust, sessionId: "s1", now: Sample.now) == nil)
  }

  @Test("subagents of the agent's last message: count and run name when the server gave none; the server wins")
  func subagentsFromTranscript() throws {
    let blocks = #"""
      [{"type":"tool-call","toolName":"Spawn","summary":"code review","delegation":"agents"},
       {"type":"tool-call","toolName":"Spawn","summary":"Spawn","delegation":"agents"}]
      """#
    let delegating = Sample.message(seq: 2, role: "assistant", blocks: blocks)
    let row = try #require(ActivityRowLine.make(state: state(Sample.session(), messages: [delegating]), sessionId: "s1", now: Sample.now))
    #expect(row.glyph == .delegation && row.label == UICopy.workflowNamed("code review"))
    #expect(row.detail == UICopy.agentsCount(2))
    let withEvent = try #require(ActivityRowLine.make(
      state: state(Sample.session(), messages: [delegating], activity: #"{"kind":"tool","delegation":"agents","agents":5}"#),
      sessionId: "s1", now: Sample.now))
    #expect(withEvent.detail == UICopy.agentsCount(5), "the server wins")
  }

  @Test("a connecting attempt under a second is not an outage: the line stays live")
  func shortConnect() throws {
    var connecting = state(Sample.session(), activity: #"{"kind":"thinking"}"#, activityAgo: 30)
    connecting.sessionStream = .connecting(since: Sample.now.addingTimeInterval(-0.5))
    let row = try #require(ActivityRowLine.make(state: connecting, sessionId: "s1", now: Sample.now))
    #expect(!row.streamDown && row.glyph == .thinking)
  }

  @Test("the whole outage: reconnect attempts neither move the clock nor drop the offline line until online")
  func wholeOutage() throws {
    // The stream loop alternates `offline` and `connecting` with a growing gap; each attempt has a new `since`. The
    // view observes every stream state in its connection memory and hands it to the model.
    var current = state(Sample.session(), activity: #"{"kind":"thinking"}"#, activityAgo: 30)
    var link = ConnectionMemory()
    func row(_ status: ConnectionStatus, at offset: TimeInterval) throws -> ActivityRowLine {
      current.sessionStream = status
      let now = Sample.now.addingTimeInterval(offset)
      link.observe(status, now: now)
      return try #require(ActivityRowLine.make(state: current, sessionId: "s1", now: now, link: link))
    }
    let t0 = Sample.now.addingTimeInterval(-20)
    var frozen: Int?
    for (status, offset) in [
      (ConnectionStatus.offline(since: t0), -20.0), (.offline(since: t0), -19.6),
      (.connecting(since: Sample.now.addingTimeInterval(-19.5)), -19.2),
      (.offline(since: Sample.now.addingTimeInterval(-19.1)), -19.0),
      (.connecting(since: Sample.now.addingTimeInterval(-18)), -17.5),
      (.offline(since: Sample.now.addingTimeInterval(-17.4)), -12.0),
      (.connecting(since: Sample.now.addingTimeInterval(-0.3)), 0),
    ] {
      let model = try row(status, at: offset)
      #expect(model.streamDown && model.glyph == .offline, "offline at every attempt (\(offset) s)")
      frozen = frozen ?? model.clockSeconds
      #expect(model.clockSeconds == frozen, "the clock stands at the start of the outage (\(offset) s)")
    }
    let back = try row(.online, at: 5)
    #expect(!back.streamDown && (back.clockSeconds ?? 0) > (frozen ?? 0), "back online the clock runs again")
  }
}
