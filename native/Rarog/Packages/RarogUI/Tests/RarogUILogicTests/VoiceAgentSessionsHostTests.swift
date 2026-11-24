import Foundation
import RarogContract
import RarogContractFixtures
import RarogCore
@testable import RarogUI
import Testing

// The host of the voice conversation across sessions (`VoiceAgentSessionsHost`): the session list from the voice
// agent's catalog joined with the app's sessions, `read_sessions` over the turns route, `ask_session`, the handles,
// the read records, the end when a read session's conversation changes, and the `client.log` lines. Fakes: the route
// to Rarog `FakeVoiceAgentBackend` (catalog, turns and app state), socket, audio and clock from
// `RealtimeConversationTests`. All session data is synthetic. The samples, `call` and `VoiceAgentFakeDevice` serve
// `VoiceAgentSessionsConversationTests` too. Owner: voice agent.

// MARK: - Samples

/// The voice agent's route to Rarog fake (`VoiceAgentSessionTests.swift`) carries the catalog, the turns and the app
/// state of the mode across sessions.
extension FakeVoiceAgentBackend: VoiceAgentSessionsBackend {}

private let anHour: TimeInterval = 3600

/// A Claude Code session of the app's list; `extra` adds wire fields.
func session(
  _ id: String, project: String = "orbit", label: String?, state: String = "waiting-input", extra: String = "",
  stateAgo: TimeInterval = 120
) -> SessionSummary {
  let labelField = label.map { #""label":\#(jsonString($0)),"# } ?? ""
  return Sample.decode(
    SessionSummary.self,
    #"""
    {"id":"\#(id)","cwd":"/Users/demo/Projects/\#(project)","title":"\#(project)",\#(labelField)
     "state":"\#(state)","stateSince":"\#(Sample.iso(stateAgo))","createdAt":"\#(Sample.iso(3 * anHour))",
     "lastActivityAt":"\#(Sample.iso(60))"\#(extra.isEmpty ? "" : "," + extra)}
    """#)
}

/// The app state with these sessions, logged in, online, with a server that offers the mode across sessions
/// (`sessions: false`: a server without the capability `companion-sessions`).
func appState(_ sessions: [SessionSummary], sessionsMode: Bool = true) -> AppState {
  var state = AppState(clientBuild: 1)
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  state.auth = .loggedIn
  let mode = sessionsMode ? #","companionSessions":true,"capabilities":["companion-sessions"]"# : ""
  state.capabilities = Capabilities(
    Sample.decode(
      VersionInfo.self,
      #"{"version":"1","protocolVersion":3,"serverStartId":"s","companionEnabled":true,"companionSpeech":true\#(mode)}"#))
  return state
}

func catalogRow(_ id: String, conversation: String = "conv-1", asksOwner: Bool = false) -> CompanionSessions.Row {
  let flag = asksOwner ? #","asksOwner":true"# : ""
  return Sample.decode(
    CompanionSessions.Row.self,
    #"{"id":"\#(id)","conversation":"\#(conversation)","stateSince":"2026-11-20T10:00:00.000Z"\#(flag)}"#)
}

private func jsonString(_ value: String) -> String {
  String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// A turns answer: `(role, text)` messages, numbered from 1.
func turnsAnswer(
  _ messages: [(String, String)], conversation: String = "conv-1", readMark: String = "mark-1", complete: Bool = true
) -> CompanionTurnsOutcome {
  let items = messages.enumerated().map { index, message in
    #"{"seq":\#(index + 1),"role":"\#(message.0)","blocks":[{"type":"text","text":\#(jsonString(message.1))}],"at":"2026-11-20T10:0\#(index % 10):00.000Z"}"#
  }
  return .turns(
    Sample.decode(
      CompanionTurns.self,
      #"{"messages":[\#(items.joined(separator: ","))],"conversation":\#(jsonString(conversation)),"stateSince":"2026-11-20T10:00:00.000Z","readMark":\#(jsonString(readMark)),"complete":\#(complete)}"#
    ))
}

/// A synthetic secret of the shared mask table, with its masked form.
private struct SecretCase: Decodable {
  let example: String
  let expected: String
}

/// The rows of the shared mask table that mask something (the table also holds look-alikes that stay).
private func secretCases() throws -> [SecretCase] {
  struct Table: Decodable { let cases: [SecretCase] }
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/companion/secret-shapes.json")
  return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url)).cases.filter { $0.example != $0.expected }
}

@MainActor
private func host(_ backend: FakeVoiceAgentBackend) -> VoiceAgentSessionsHost {
  VoiceAgentSessionsHost(backend: backend, sonioxAllowed: true, now: { Sample.now })
}

/// A tool call as the conversation makes it: the action at once, then its work. `turn`: the moment the conversation
/// gives a tool that waits for the user's word (the calling response and the kept utterances so far).
@MainActor
func call(
  _ host: VoiceAgentSessionsHost, _ tool: VoiceAgentSessionsTool, _ arguments: String = "{}",
  turn: RealtimeToolTurn = RealtimeToolTurn(response: "r-test", utterances: 0)
) async -> String {
  guard let spec = host.content().tools.first(where: { $0.name == tool.rawValue }) else {
    Issue.record("no tool \(tool.rawValue)")
    return ""
  }
  switch spec.action(arguments) {
  case let .answer(output): return output
  case let .work(_, work): return await work()
  case let .workAtTurn(_, work): return await work(turn)
  case let .workAndRead(_, work):
    // A text to read plays out whole here; `VoiceAgentSessionsHostTests+Prompt.swift` drives the other endings.
    switch await work(turn) {
    case let .output(output): return output
    case let .read(_, then, _): return then(.whole)
    }
  case .showPrompt, .sendPrompt:
    Issue.record("a prompt action of the session screen in the mode across sessions")
    return ""
  }
}

private func object(_ output: String) -> [String: Any] {
  (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any] ?? [:]
}

func rows(_ output: String) -> [[String: Any]] { object(output)["sessions"] as? [[String: Any]] ?? [] }

func isError(_ output: String) -> Bool { object(output)["error"] is String }

/// What changes between the start and a tool call; `notPrepared`: the host gave no opening list; `ownerReason`: the
/// owner gives an end reason (the app in the background); `ended`: the owner told the host its conversation ended.
enum AppChange: String, CaseIterable, Sendable {
  case logout
  case newLogin = "new login"
  case modeGone = "mode not offered"
  case notPrepared = "not prepared"
  case ownerReason = "owner's end reason"
  case ended = "conversation ended"
}

// MARK: - Tests

@MainActor
@Suite("voice conversation across sessions: list, read, ask, handles, end, log")
struct VoiceAgentSessionsHostTests {
  /// Five sessions in five states, all in the catalog.
  private func fiveStates() -> FakeVoiceAgentBackend {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([
      session("id-work", label: "Build pipeline", state: "running", stateAgo: 60),
      session(
        "id-dialog", label: "Release notes", state: "waiting-question",
        extra: #""waitingFor":{"kind":"question","text":"Which branch should I use?\nmain or next"}"#, stateAgo: 300),
      session("id-fresh", label: "Login fix", stateAgo: 600),
      session("id-marked", label: "Docs pass", extra: #""markedUnseen":true"#, stateAgo: 900),
      session(
        "id-bg", label: "Test suite", extra: #""backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test"}]"#,
        stateAgo: 1200),
    ])
    backend.catalog = .sessions(["id-work", "id-dialog", "id-fresh", "id-marked", "id-bg"].map { catalogRow($0) })
    return backend
  }

  @Test("list_sessions: working, dialog with its first line, finished, marked unread, background work; no turns")
  func listStates() async throws {
    let backend = fiveStates()
    backend.turns["id-fresh"] = turnsAnswer([("user", "Fix the login"), ("assistant", "Fixed the token check.")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let list = rows(await call(host, .listSessions))
    let byName = Dictionary(uniqueKeysWithValues: list.map { ($0["name"] as? String ?? "", $0) })
    #expect(byName["Build pipeline"]?["state"] as? String == "working")
    #expect(byName["Release notes"]?["state"] as? String == "dialog")
    let dialog = try #require(byName["Release notes"]?["dialog"] as? [String: Any])
    #expect(dialog["kind"] as? String == "question" && dialog["line"] as? String == "Which branch should I use?")
    #expect(byName["Login fix"]?["state"] as? String == "finished")
    #expect(byName["Docs pass"]?["state"] as? String == "marked-unread")
    #expect(byName["Test suite"]?["state"] as? String == "working-background")
    #expect(byName["Login fix"]?["minutes"] as? Int == 10 && byName["Login fix"]?["project"] as? String == "orbit")
    #expect(list.allSatisfy { $0["dialog"] == nil || $0["name"] as? String == "Release notes" })
    #expect(!backend.reads.contains { $0.hasPrefix("turns") }, "the list reads no turns")
    let instructions = host.content().instructions(RealtimeProjector.budget)
    #expect(instructions.contains("<sessions>\n[{\"handle\":\"s"), "the opening list stands in the instructions")
    #expect(!instructions.contains("token check"))
  }

  @Test("a session outside the catalog gives no row, name, count or #n; neither does a catalog row the app lacks")
  func outsideCatalog() async {
    let backend = FakeVoiceAgentBackend()
    // Identical project and name are numbered oldest first, then by id: counted over all the app's sessions,
    // "id-twin" would make "Visible work" #1 and "id-b" would make "id-c" the third "Twin task".
    backend.state = appState([
      session("id-in", label: "Visible work"), session("id-twin", label: "Visible work"),
      session("id-out", project: "hiddenproj", label: "Hidden work"),
      session("id-a", label: "Twin task"), session("id-b", label: "Twin task"), session("id-c", label: "Twin task"),
    ])
    backend.catalog = .sessions(["id-in", "id-a", "id-c", "id-unknown"].map { catalogRow($0) })
    for id in ["id-in", "id-a", "id-c"] { backend.turns[id] = turnsAnswer([("user", "Status?")]) }
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let output = await call(host, .listSessions)
    #expect(Set(rows(output).compactMap { $0["name"] as? String }) == ["Visible work", "Twin task #1", "Twin task #2"])
    let read = await call(host, .readSessions, #"{"handles":["s1","s2","s3"]}"#)
    let headers = read.split(separator: "\n").filter { $0.hasPrefix("## ") }.joined(separator: "\n")
    #expect(headers.contains(" · Visible work · ") && headers.contains(" · Twin task #2 · "))
    let instructions = host.content().instructions(RealtimeProjector.budget)
    #expect(instructions.contains(#""name":"Visible work""#) && instructions.contains(#""name":"Twin task #2""#))
    for text in [output, instructions, read] {
      #expect(!text.contains("Visible work #") && !text.contains("Twin task #3"))
      #expect(!text.contains("Hidden work") && !text.contains("hiddenproj") && !text.contains("s4"))
      for id in ["id-in", "id-twin", "id-out", "id-a", "id-b", "id-c", "id-unknown"] { #expect(!text.contains(id)) }
    }
  }

  @Test("a secret shape in a session name, a project or a dialog line is masked in the list and the instructions")
  func listMask() async throws {
    let cases = try secretCases()
    let backend = FakeVoiceAgentBackend()
    var sessions: [SessionSummary] = []
    for (index, secret) in cases.enumerated() {
      let waiting = #""waitingFor":{"kind":"permission","text":\#(jsonString("Run deploy \(secret.example)"))}"#
      sessions.append(
        session("id-\(index)", label: "Key \(secret.example)", state: "waiting-permission", extra: waiting))
    }
    backend.state = appState(sessions)
    backend.catalog = .sessions(sessions.map { catalogRow($0.id) })
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let output = await call(host, .listSessions)
    let instructions = host.content().instructions(RealtimeProjector.budget)
    for secret in cases {
      for text in [output, instructions] {
        #expect(!text.contains(secret.example))
      }
      #expect(rows(output).contains { $0["name"] as? String == "Key \(secret.expected)" })
      #expect(
        rows(output).contains { ($0["dialog"] as? [String: Any])?["line"] as? String == "Run deploy \(secret.expected)" })
    }
  }

  @Test("handles: s1… in list order, stable in the conversation; a new session gets the next one")
  func stableHandles() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let first = rows(await call(host, .listSessions)).map { "\($0["handle"] ?? "") \($0["name"] ?? "")" }
    var state = backend.state
    state.sessions["id-c"] = session("id-c", label: "Cedar")
    backend.state = state
    backend.catalog = .sessions([catalogRow("id-c"), catalogRow("id-b")])
    let second = rows(await call(host, .listSessions)).map { "\($0["handle"] ?? "") \($0["name"] ?? "")" }
    #expect(Set(first) == ["s1 Alpha", "s2 Birch"] || Set(first) == ["s1 Birch", "s2 Alpha"])
    let birch = first.first { $0.hasSuffix("Birch") }
    #expect(second.contains(birch ?? "-") && second.contains("s3 Cedar") && second.count == 2)
  }

  @Test("read_sessions with the filter finished and five finished sessions reads the three newest, newest first")
  func filterFinished() async throws {
    let backend = FakeVoiceAgentBackend()
    let ages: [TimeInterval] = [5, 1, 4, 2, 3].map { $0 * anHour }
    let sessions = ages.enumerated().map { index, age in session("id-\(index)", label: "Task \(index)", stateAgo: age) }
    backend.state = appState(sessions)
    backend.catalog = .sessions(sessions.map { catalogRow($0.id) })
    for session in sessions { backend.turns[session.id] = turnsAnswer([("user", "Do \(session.label ?? "")")]) }
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let output = await call(host, .readSessions, #"{"filter":"finished"}"#)
    #expect(backend.reads.filter { $0.hasPrefix("turns") } == ["turns id-1 3", "turns id-3 3", "turns id-4 3"])
    let headers = output.split(separator: "\n").filter { $0.hasPrefix("## ") }
    #expect(headers.count == 3)
    #expect(headers.map { $0.contains("Task 1") } == [true, false, false])
    #expect(headers.last?.contains("Task 4") == true && !output.contains("Task 0") && !output.contains("Task 2"))
  }

  @Test("a handle that is not on the list is a refusal; nothing is read")
  func unknownHandle() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hello")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let output = await call(host, .readSessions, #"{"handles":["s9"]}"#)
    #expect(isError(output) && output.contains("Unknown handle"))
    #expect(!backend.reads.contains { $0.hasPrefix("turns") })
    #expect(isError(await call(host, .askSession, #"{"handle":"s9","question":"What changed?"}"#)))
    #expect(backend.questions.isEmpty)
  }

  @Test("a read over 15,000 characters drops the oldest turn with a note; a secret in a turn is masked first")
  func budgetAndMask() async throws {
    let secret = try #require(try secretCases().first)
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    let long = String(repeating: "x", count: 8000)
    backend.turns["id-a"] = turnsAnswer([
      ("user", "first prompt"), ("assistant", "OLDEST \(long)"), ("user", "second prompt"),
      ("assistant", "MIDDLE \(long)"), ("user", "third prompt \(secret.example)"), ("assistant", "NEWEST answer"),
    ])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let output = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    #expect(output.count <= VoiceAgentSessionReads.budget)
    #expect(output.contains("[Omitted: turns 1–1 (over the size budget of this read). Ask ask_session about them.]"))
    #expect(!output.contains("OLDEST") && output.contains("MIDDLE") && output.contains("NEWEST answer"))
    #expect(!output.contains(secret.example) && output.contains("third prompt \(secret.expected)"))
  }

  @Test("a session not opened since a start from the cache: read and question work while the list is fresh")
  func notOpenedAfterCacheStart() async {
    let backend = FakeVoiceAgentBackend()
    var state = appState([session("id-a", label: "Alpha")])
    state.transcripts = [:]
    state.listCache.awaitingTranscripts = ["id-a"]
    backend.state = state
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Ship it"), ("assistant", "Shipped.")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let read = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    #expect(read.contains("AGENT: Shipped."))
    let answer = await call(host, .askSession, #"{"handle":"s1","question":"Was it shipped?"}"#)
    #expect(object(answer)["result"] as? String == "It was fixed in turn 2.")
    #expect(backend.reads.contains("ask id-a"))
  }

  @Test("the record of a read keeps conversation and readMark byte for byte, and whether the answer had messages")
  func readRecords() async throws {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a", conversation: "Tjo8_3W~é"), catalogRow("id-b")])
    // A decomposed accent: equal to the composed one as a Swift string, different in bytes.
    let mark = "r1:2026-11-20T10:00:00.000Z:e\u{301}"
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")], conversation: "Tjo8_3W~é", readMark: mark)
    backend.turns["id-b"] = turnsAnswer([], readMark: "empty-mark")
    let host = host(backend)
    #expect(await host.prepare() == nil)
    _ = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    let alpha = try #require(host.read(handle: "s1"))
    #expect(Array(alpha.readMark.utf8) == Array(mark.utf8))
    #expect(Array(alpha.conversation.utf8) == Array("Tjo8_3W~é".utf8))
    #expect(alpha.hadMessages && alpha.sessionId == "id-a")
    let birch = try #require(host.read(handle: "s2"))
    #expect(!birch.hadMessages && birch.readMark == "empty-mark")
    #expect(host.read(handle: "s3") == nil)
  }

  @Test("the catalog is fetched before every tool call")
  func catalogBeforeEachTool() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    _ = await call(host, .listSessions)
    _ = await call(host, .readSessions, #"{"handles":["s1"],"turns":2}"#)
    _ = await call(host, .askSession, #"{"handle":"s1","question":"Why?"}"#)
    #expect(backend.reads == ["catalog", "catalog", "catalog", "turns id-a 2", "catalog", "ask id-a"])
  }

  @Test("a failed catalog or turns fetch gives the model a refusal sentence and reveals nothing")
  func failedFetches() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt")])
    backend.turns["id-b"] = .failed(code: "timeout", message: "Birch detail")
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let turnsFailed = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    backend.catalog = .failed(code: "internal", message: "Catalog detail")
    let outputs = [
      turnsFailed, await call(host, .listSessions), await call(host, .readSessions, #"{"handles":["s1"]}"#),
      await call(host, .askSession, #"{"handle":"s1","question":"Why?"}"#),
    ]
    for output in outputs {
      #expect(isError(output), "\(output)")
      for hidden in ["Alpha", "Birch", "detail", "id-a", "id-b", "orbit"] { #expect(!output.contains(hidden)) }
    }
    #expect(host.read(handle: "s1") == nil, "a refused read keeps no record")
    #expect(backend.questions.isEmpty)
  }

  @Test("the 31st question of the conversation is refused; 30 reach the route")
  func questionCeiling() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    for _ in 0..<VoiceAgentSessionsHost.questionCeiling {
      #expect(!isError(await call(host, .askSession, #"{"handle":"s1","question":"Why?"}"#)))
    }
    let refused = await call(host, .askSession, #"{"handle":"s1","question":"Why?"}"#)
    #expect(isError(refused) && refused.contains("30"))
    #expect(backend.questions.count == VoiceAgentSessionsHost.questionCeiling)
  }

  @Test("a server without the capability companion-sessions: the mode is not offered, nothing is read")
  func modeNotOffered() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")], sessionsMode: false)
    backend.catalog = .sessions([catalogRow("id-a")])
    let host = host(backend)
    #expect(await host.prepare() == .off)
    #expect(host.startRefusal() == .disabled)
    #expect(backend.reads.isEmpty)
  }

  @Test(
    "a tool asks nothing after a logout, a new login, the mode gone, the owner's reason or the end, or unprepared",
    arguments: AppChange.allCases, VoiceAgentSessionsTool.allCases)
  func toolsAskOnlyWhileOffered(change: AppChange, tool: VoiceAgentSessionsTool) async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    let host = host(backend)
    if change != .notPrepared { #expect(await host.prepare() == nil) }
    let asked = backend.reads
    switch change {
    case .logout: backend.state.auth = .loggedOut(.notLoggedIn)
    case .newLogin: backend.loginEpoch += 1
    case .modeGone: backend.state = appState([session("id-a", label: "Alpha")], sessionsMode: false)
    case .notPrepared: break
    case .ownerReason: host.ownerReason = { .background }
    case .ended: host.conversationEnded()
    }
    let arguments =
      tool == .listSessions ? "{}" : #"{"handles":["s1"],"handle":"s1","question":"Why?","text":"Run the tests."}"#
    let output = await call(host, tool, arguments)
    #expect(isError(output) && !output.contains("Alpha"), "\(output)")
    #expect(backend.reads == asked && backend.questions.isEmpty && host.reads.isEmpty && backend.sends.isEmpty)
  }

  @Test("the end of the conversation drops its reads, its handles and its opening list")
  func endDropsSessionData() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt")])
    backend.turns["id-b"] = turnsAnswer([("user", "Birch prompt")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    _ = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    #expect(host.reads.count == 2)
    host.conversationEnded()
    #expect(host.reads.isEmpty && host.read(handle: "s1") == nil)
    #expect(host.handles == VoiceAgentHandles())
    #expect(!host.content().instructions(RealtimeProjector.budget).contains("Alpha"))
  }

  @Test("the end while read_sessions waits on its first session: the second is not asked and no read is kept")
  func endDuringTurns() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt")])
    backend.turns["id-b"] = turnsAnswer([("user", "Birch prompt")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    backend.onTurns = { [unowned host] in host.conversationEnded() }
    let output = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    #expect(isError(output) && !output.contains("Alpha"), "\(output)")
    #expect(backend.reads == ["catalog", "catalog", "turns id-a 3"])
    #expect(host.reads.isEmpty && host.handles == VoiceAgentHandles())
  }

  @Test("the end while a tool reads the catalog: no handle comes back and no list goes to the model")
  func endDuringCatalog() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    backend.onCatalog = { [unowned host] in host.conversationEnded() }
    let output = await call(host, .listSessions)
    #expect(isError(output) && !output.contains("Alpha"), "\(output)")
    #expect(host.handles == VoiceAgentHandles())
  }

  @Test("a logout while the catalog is read: no turns request or question follows, and no list goes to the model")
  func logoutDuringCatalog() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    backend.onCatalog = { [unowned backend] in backend.state.auth = .loggedOut(.notLoggedIn) }
    var outputs: [String] = []
    for (tool, arguments) in [
      (VoiceAgentSessionsTool.readSessions, #"{"handles":["s1"]}"#),
      (.askSession, #"{"handle":"s1","question":"Why?"}"#), (.listSessions, "{}"),
    ] {
      backend.state.auth = .loggedIn
      outputs.append(await call(host, tool, arguments))
    }
    #expect(outputs.allSatisfy { isError($0) && !$0.contains("Alpha") }, "\(outputs)")
    #expect(backend.reads == ["catalog", "catalog", "catalog", "catalog"])
    #expect(backend.questions.isEmpty && host.reads.isEmpty)
  }

  @Test("a logout while turns or a question are in flight: no read is kept and the answer does not reach the model")
  func logoutDuringTurnsOrQuestion() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    backend.onTurns = { [unowned backend] in backend.state.auth = .loggedOut(.notLoggedIn) }
    let read = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    #expect(isError(read) && !read.contains("Alpha") && host.reads.isEmpty, "\(read)")
    backend.state.auth = .loggedIn
    backend.holdAsk = true
    let asking = Task { await call(host, .askSession, #"{"handle":"s1","question":"Why?"}"#) }
    #expect(await eventually { backend.askPending })
    backend.state.auth = .loggedOut(.notLoggedIn)
    backend.releaseAsk()
    let answer = await asking.value
    #expect(isError(answer) && !answer.contains("turn 2"), "\(answer)")
    #expect(backend.reads == ["catalog", "catalog", "turns id-a 3", "catalog", "ask id-a"])
  }

  @Test("a changed conversation of a session not read in the conversation does not end it")
  func unreadChangeGoesOn() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    let host = host(backend)
    var checks = 0
    host.requestEndCheck = { checks += 1 }
    #expect(await host.prepare() == nil)
    #expect(host.startRefusal() == nil)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b", conversation: "conv-2")])
    #expect(!isError(await call(host, .listSessions)))
    #expect(checks == 0 && host.endReason() == nil)
  }

  @Test("a read session's new conversation in a turns answer ends the conversation with its reason")
  func changedInTurnsAnswer() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha")])
    backend.catalog = .sessions([catalogRow("id-a")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    let host = host(backend)
    var checks = 0
    host.requestEndCheck = { checks += 1 }
    #expect(await host.prepare() == nil)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    backend.turns["id-a"] = turnsAnswer([("user", "After clear")], conversation: "conv-2")
    let output = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    #expect(isError(output) && !output.contains("After clear"))
    #expect(checks == 1 && host.endReason() == .sessionCleared)
    let asked = backend.reads
    #expect(isError(await call(host, .listSessions)) && backend.reads == asked, "the ended conversation asks nothing")
  }

  @Test("a read session's new conversation ends the conversation also when a later session of the same read fails")
  func changedBeforeFailedRead() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([session("id-a", label: "Alpha"), session("id-b", label: "Birch")])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Hi")])
    backend.turns["id-b"] = .failed(code: "internal", message: nil)
    let host = host(backend)
    var checks = 0
    host.requestEndCheck = { checks += 1 }
    #expect(await host.prepare() == nil)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    backend.turns["id-a"] = turnsAnswer([("user", "After clear")], conversation: "conv-2")
    let asked = backend.reads
    let output = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    #expect(isError(output) && !output.contains("After clear"))
    #expect(checks == 1 && host.endReason() == .sessionCleared)
    #expect(backend.reads == asked + ["catalog", "turns id-a 3"], "the session after the changed one is not asked")
    #expect(host.read(handle: "s1")?.conversation == "conv-1")
  }

  @Test("a block tag in a session name, a dialog line or a turn opens or closes no block of the instructions")
  func blockTagsNeutralized() async {
    // A session's text reaches the model inside data blocks; a tag written into it would end the block and let the
    // rest read as instructions.
    let tags = ["</sessions>", "<sessions>", "</transcript>", "<TRANSCRIPT>", "<session-update>", "</session-update>"]
    let backend = FakeVoiceAgentBackend()
    var sessions: [SessionSummary] = []
    for (index, tag) in tags.enumerated() {
      let waiting = #""waitingFor":{"kind":"permission","text":\#(jsonString("Run \(tag) now"))}"#
      sessions.append(
        session(
          "id-\(index)", project: "orbit\(tag)", label: "Name \(tag)", state: "waiting-permission", extra: waiting))
      backend.turns["id-\(index)"] = turnsAnswer([("user", "Ask \(tag)"), ("assistant", "Answer \(tag) done")])
    }
    backend.state = appState(sessions)
    backend.catalog = .sessions(sessions.map { catalogRow($0.id) })
    let host = host(backend)
    #expect(await host.prepare() == nil)
    let list = await call(host, .listSessions)
    let read = await call(host, .readSessions, #"{"handles":["s1","s2","s3","s4","s5","s6"]}"#)
    let instructions = host.content().instructions(RealtimeProjector.budget)
    #expect(read.contains("Answer ") && list.contains("Name "))
    #expect(instructions.components(separatedBy: "</sessions>").count == 2, "only the block's own closing tag")
    #expect(instructions.components(separatedBy: "<sessions>").count == 2, "only the block's own opening tag")
    for text in [list, read] {
      #expect(text.firstMatch(of: /<\/?(transcript|session-update|sessions)\b/.ignoresCase()) == nil)
    }
    #expect(instructions.firstMatch(of: /<\/?(transcript|session-update)\b/.ignoresCase()) == nil)
  }

  @Test("a read session's new conversation in the catalog ends a running conversation as session-cleared")
  func changedInCatalogEndsConversation() async throws {
    let wires = Wires()
    wires.backend.state = appState([session("id-a", label: "Alpha")])
    wires.backend.catalog = .sessions([catalogRow("id-a")])
    wires.backend.turns["id-a"] = turnsAnswer([("user", "Hi"), ("assistant", "Hello there")])
    #expect(await wires.host.prepare() == nil)
    await wires.ready()
    let update = try #require(wires.socket.sent("session.update").first?["session"] as? [String: Any])
    let tools = (update["tools"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
    #expect(
      tools == [
        "list_sessions", "read_sessions", "discuss_session", "ask_session", "check_open_requests", "show_prompt",
        "send_prompt",
      ])
    #expect((update["instructions"] as? String)?.contains("\"name\":\"Alpha\"") == true)

    await wires.toolCall("r1", name: "read_sessions", arguments: #"{"handles":["s1"]}"#)
    #expect(wires.outputs.last?.contains("Hello there") == true)
    wires.backend.catalog = .sessions([catalogRow("id-a", conversation: "conv-2")])
    wires.utterance("in2")
    wires.socket.reply(RealtimeSample.created("r2"))
    wires.socket.reply(RealtimeSample.call("r2", id: "c2", name: "list_sessions"))
    wires.socket.reply(RealtimeSample.done("r2"))
    #expect(await eventually { wires.session.closedBy == .sessionCleared })
    #expect(await eventually { if case .ended = wires.session.phase { true } else { false } })
    #expect(wires.backend.traces.contains { $0.contains("ended") && $0.contains("session-cleared") })
  }

  @Test("client.log: voice-agent lines with counts of sessions, reads and questions, without names, ids or text")
  func logLines() async {
    let backend = FakeVoiceAgentBackend()
    backend.state = appState([
      session("id-a", project: "orbit", label: "Alpha"), session("id-b", project: "willow", label: "Birch"),
    ])
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt"), ("assistant", "Alpha answer")])
    backend.turns["id-b"] = turnsAnswer([("user", "Birch prompt")])
    let host = host(backend)
    #expect(await host.prepare() == nil)
    _ = await call(host, .listSessions)
    _ = await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)
    _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    _ = await call(host, .askSession, #"{"handle":"s2","question":"Birch question?"}"#)
    _ = await call(host, .readSessions, #"{"handles":["s7"]}"#)
    let lines = backend.traces
    #expect(lines.allSatisfy { $0.hasPrefix("voice-agent: ") })
    #expect(lines.contains("voice-agent: list 2 sessions"))
    #expect(lines.contains("voice-agent: read 2 sessions, 2 reads in this conversation"))
    #expect(lines.contains("voice-agent: read 1 session, 3 reads in this conversation"))
    #expect(lines.contains("voice-agent: question 1 of 30"))
    #expect(lines.contains("voice-agent: read refused (unknown-handle)"))
    for line in lines {
      for hidden in ["Alpha", "Birch", "orbit", "willow", "id-a", "id-b", "prompt", "question?", "/Users", "s1", "s2"] {
        #expect(!line.contains(hidden), "\(line)")
      }
    }
    #expect(backend.traceBudgets.allSatisfy { $0 == .voiceAgent })
  }
}

// MARK: - The conversation with the host

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// The device behind one voice conversation: socket, audio, Soniox speech socket and clock fakes as the core's
/// dependencies, the sockets and clocks in the order the conversations opened them. `Wires` and
/// `VoiceAgentSessionsConversationTests` use it.
@MainActor
final class VoiceAgentFakeDevice {
  let audio = RealtimeFakeAudio()
  private(set) var sockets: [RealtimeFakeSocket] = []
  private(set) var speechSockets: [MockSocket] = []
  private(set) var schedulers: [ManualScheduler] = []
  /// The Soniox stream of each answer item that ``say(_:item:pcm:)`` started.
  private(set) var streamOf: [String: String] = [:]

  func dependencies(_ keys: VoiceAgentKeys) -> RealtimeConversation.Dependencies {
    let scheduler = newScheduler()
    return RealtimeConversation.Dependencies(
      keys: keys,
      socket: { [unowned self] request, events in
        let socket = RealtimeFakeSocket(request: request, events: events)
        self.sockets.append(socket)
        return socket
      },
      // The capture times of `input(milliseconds:)` and the end of a reading lie on the same manual clock.
      audio: audio, scheduler: scheduler, hostClock: { [scheduler] in scheduler.now },
      speech: RealtimeConversation.Speech(
        keys: keys,
        socket: { [unowned self] url, protocols, events in
          let socket = MockSocket(url: url, protocols: protocols, events: events)
          self.speechSockets.append(socket)
          return socket
        }))
  }

  var socket: RealtimeFakeSocket { sockets[sockets.count - 1] }
  var speechSocket: MockSocket { speechSockets[speechSockets.count - 1] }
  /// The clock of the last conversation: speech over an answer outlasts the noise window when it advances.
  var scheduler: ManualScheduler { schedulers[schedulers.count - 1] }

  private func newScheduler() -> ManualScheduler {
    let scheduler = ManualScheduler()
    schedulers.append(scheduler)
    return scheduler
  }

  var outputs: [String] {
    socket.sent("conversation.item.create").compactMap { ($0["item"] as? [String: Any])?["output"] as? String }
  }

  /// The started conversation of `session` opens its sockets, gets its session settings and listens; `socketsBefore`:
  /// the sockets earlier conversations of this device opened.
  func ready(_ session: VoiceAgentSession, socketsBefore: Int = 0) async {
    #expect(await eventually { sockets.count > socketsBefore })
    speechSockets.last?.open()
    socket.open()
    socket.reply(#"{"type":"session.updated","session":{}}"#)
    #expect(await eventually { session.phase == .listening })
  }

  func utterance(_ item: String) {
    socket.reply(RealtimeSample.speechStarted)
    socket.reply(RealtimeSample.speechStopped)
    socket.reply(RealtimeSample.committed(item))
  }

  /// Answer `response` speaks `pcm` in its item `item`, as `RealtimeHarness.say` does: the first call sends the item's
  /// text (Soniox starts a stream for it), then Soniox returns `pcm` on the item's stream.
  func say(_ response: String, item: String, pcm: Data) {
    if streamOf[item] == nil {
      let before = SpeechSample.streams(speechSocket)
      socket.reply(RealtimeSample.textDelta(response, item: item, "Spoken answer."))
      if let stream = SpeechSample.streams(speechSocket).first(where: { !before.contains($0) }) {
        streamOf[item] = stream
      }
    }
    guard let stream = streamOf[item] else { return }
    speechSocket.reply(SpeechSample.audio(stream, pcm))
  }

  /// The stream of `item` ends at Soniox, and the playback queue drains with all of it played.
  func playOut(_ item: String) throws {
    let stream = try #require(streamOf[item])
    speechSocket.reply(SpeechSample.terminated(stream))
    audio.playedSamples = audio.queuedSamples
    try #require(audio.handlers).drained()
  }

  /// The user's utterance `item`, whose `speech_started` names it and carries `startMs` (`nil`: no time).
  func utterance(_ item: String, startMs: Int?) {
    var started: [String: Any] = ["type": "input_audio_buffer.speech_started", "item_id": item]
    if let startMs { started["audio_start_ms"] = startMs }
    socket.reply(SpeechSample.encoded(started))
    socket.reply(SpeechSample.encoded(["type": "input_audio_buffer.speech_stopped", "item_id": item]))
    socket.reply(RealtimeSample.committed(item))
  }

  /// `milliseconds` of microphone audio (24 kHz s16le), captured at `capturedAt` on the clock of the last
  /// conversation (default: now).
  func input(milliseconds: Int, capturedAt: TimeInterval? = nil) throws {
    try #require(audio.handlers).input(Data(count: milliseconds * 24 * 2), capturedAt ?? scheduler.now)
  }

  /// Response `response` calls `name` with `arguments` and is over; returns the Soniox stream of the reading its work
  /// asked for.
  func readingCall(_ response: String, name: String, arguments: String) async throws -> String {
    let before = SpeechSample.streams(speechSocket)
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.call(response, id: "c-\(response)", name: name, arguments: arguments))
    socket.reply(RealtimeSample.done(response))
    #expect(await eventually { SpeechSample.streams(speechSocket).count > before.count })
    return try #require(SpeechSample.streams(speechSocket).first { !before.contains($0) })
  }

  /// Soniox says the reading on `stream` and ends it, and the playback queue drains with all of it played.
  func playReading(_ stream: String) throws {
    speechSocket.reply(SpeechSample.audio(stream, Data(count: 9600)))
    speechSocket.reply(SpeechSample.terminated(stream))
    audio.playedSamples = audio.queuedSamples
    try #require(audio.handlers).drained()
  }

  /// The text the app sent Soniox on `stream`, joined.
  func speechText(_ stream: String) -> String {
    speechFrames(stream).compactMap { $0["text"] as? String }.joined()
  }

  /// The app told Soniox to cancel `stream`.
  func cancelledReading(_ stream: String) -> Bool {
    speechFrames(stream).contains { $0["cancel"] as? Bool == true }
  }

  private func speechFrames(_ stream: String) -> [[String: Any]] {
    speechSocket.texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
      .filter { $0["stream_id"] as? String == stream }
  }

  /// The user speaks over the playing answer and goes on past the noise window, then the utterance closes as `item`.
  func speechOver(_ item: String) {
    socket.reply(RealtimeSample.speechStarted)
    scheduler.advance(RealtimeBargeIn.window)
    socket.reply(RealtimeSample.speechStopped)
    socket.reply(RealtimeSample.committed(item))
  }

  /// The user speaks, and response `response` calls `name`; returns once its output went to the model. The answer
  /// after the tool result is silent, or with `spoken` speaks it in item `m-<response>` (``playOut(_:)`` ends it).
  func toolCall(_ response: String, name: String, arguments: String, spoken: Data? = nil) async {
    let before = outputs.count
    utterance("in-\(response)")
    socket.reply(RealtimeSample.created(response))
    socket.reply(RealtimeSample.call(response, id: "c-\(response)", name: name, arguments: arguments))
    socket.reply(RealtimeSample.done(response))
    #expect(await eventually { outputs.count == before + 1 })
    // The answer after the tool result.
    socket.reply(RealtimeSample.created("\(response)f"))
    if let spoken { say("\(response)f", item: "m-\(response)", pcm: spoken) }
    socket.reply(RealtimeSample.done("\(response)f"))
  }
}

/// A conversation across sessions on the device fakes, wired like its owner wires it: the host's end check calls
/// `VoiceAgentSession.observe()`.
@MainActor
private final class Wires {
  let backend = FakeVoiceAgentBackend()
  let device = VoiceAgentFakeDevice()
  private(set) var host: VoiceAgentSessionsHost!
  private(set) var session: VoiceAgentSession!

  init() {
    host = VoiceAgentSessionsHost(backend: backend, sonioxAllowed: true, now: { Sample.now })
    session = VoiceAgentSession(
      host: host, backend: backend, dependencies: { [unowned self] in self.device.dependencies($0) })
    host.requestEndCheck = { [unowned self] in self.session.observe() }
  }

  var socket: RealtimeFakeSocket { device.socket }
  var outputs: [String] { device.outputs }

  func ready() async {
    session.start()
    await device.ready(session)
  }

  func utterance(_ item: String) { device.utterance(item) }

  func toolCall(_ response: String, name: String, arguments: String) async {
    await device.toolCall(response, name: name, arguments: arguments)
  }
}
