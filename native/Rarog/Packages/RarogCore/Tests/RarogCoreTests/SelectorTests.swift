import Foundation
import RarogContract
@testable import RarogCore
import Testing

@Suite("selektory: ranga, kropka, zegar, pole wiadomości, banery, faza transkryptu")
struct SelectorTests {
  private func state(_ summaries: [String], extra: String = "") throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot(summaries, extra: extra)])
    return state
  }

  @Test("ranga: decyzja > nieodebrany wynik i awarie > praca > odebrany > done; remis po wieku")
  func ranking() throws {
    let state = try state([
      Frames.summary("done", state: "done", createdAt: "2026-10-03T07:00:00.000Z"),
      Frames.summary("seen", state: "waiting-input", createdAt: "2026-10-03T07:00:00.000Z", extra: #","seen":true"#),
      Frames.summary("run-young", state: "running", createdAt: "2026-10-03T07:30:00.000Z"),
      Frames.summary("run-old", state: "running", createdAt: "2026-10-03T07:10:00.000Z"),
      Frames.summary("unread", state: "waiting-input", createdAt: "2026-10-03T07:00:00.000Z"),
      Frames.summary("err", state: "error", createdAt: "2026-10-03T07:05:00.000Z"),
      Frames.summary("ask", state: "waiting-question", createdAt: "2026-10-03T07:50:00.000Z"),
      Frames.summary("bg", state: "waiting-input", createdAt: "2026-10-03T07:40:00.000Z",
                     extra: #","seen":true,"backgroundTasks":[{"id":"t1","kind":"command"}]"#),
    ])
    #expect(state.sortedSessions.map(\.id) == ["ask", "unread", "err", "run-old", "run-young", "bg", "seen", "done"])
  }

  @Test("wśród odebranych bezczynnych świeższa aktywność wyżej (czas stanu po restarcie był wspólny)")
  func idleByActivity() throws {
    let state = try state([
      Frames.summary("old", state: "waiting-input", lastActivityAt: "2026-10-03T07:00:00.000Z", extra: #","seen":true"#),
      Frames.summary("fresh", state: "waiting-input", lastActivityAt: "2026-10-03T09:00:00.000Z", extra: #","seen":true"#),
    ])
    #expect(state.sortedSessions.map(\.id) == ["fresh", "old"])
  }

  @Test("kropka: bursztyn tylko gdy ktoś czeka; zadanie w tle zielone; zegar karty")
  func toneAndClock() throws {
    let state = try state([
      Frames.summary("a", state: "waiting-permission"), Frames.summary("b", state: "interrupted"),
      Frames.summary("c", state: "waiting-input"), Frames.summary("d", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("e", state: "limit-reached"),
      Frames.summary("f", state: "done", extra: #","backgroundTasks":[{"id":"t","kind":"agent"}]"#),
      Frames.summary("g", state: "running", stateSince: "2026-10-03T08:30:00.000Z"),
    ])
    let tones = state.sessions.mapValues(\.statusTone)
    #expect(tones == ["a": .waiting, "b": .waiting, "c": .unread, "d": .quiet, "e": .failed, "f": .working, "g": .working])
    #expect(state.sessions["g"]?.listClock == ListClock(kind: .turn, since: "2026-10-03T08:30:00.000Z"))
    #expect(state.sessions["a"]?.listClock.kind == .waiting)
    #expect(state.sessions["c"]?.listClock.kind == .silence)
  }

  @Test("subagent w postoju: ranga jak bez tła, ton „czeka na zadanie w tle” zamiast ciszy")
  func waitingAgentKeepsRowQuiet() throws {
    let waiting = agentTask("a", waitingSince: "2026-10-03T08:00:00.000Z", ownTask: "sleep 300")
    let alone = backgroundTasks(waiting)
    let withCommand = backgroundTasks(waiting, workflowTask("c", run: false, kind: "command"))
    let withAgent = backgroundTasks(waiting, agentTask("b"))
    let state = try state([
      Frames.summary("unread", state: "waiting-input", extra: alone),
      Frames.summary("seen", state: "waiting-input", extra: #","seen":true"# + alone),
      Frames.summary("done", state: "done", extra: alone),
      Frames.summary("resumable", state: "resumable", extra: alone),
      Frames.summary("seen-cmd", state: "waiting-input", extra: #","seen":true"# + withCommand),
      Frames.summary("done-agent", state: "done", extra: withAgent),
      // Tony, które wygrywają z tłem, zostają sobą.
      Frames.summary("ask", state: "waiting-question", extra: alone),
      Frames.summary("perm", state: "waiting-permission", extra: alone),
      Frames.summary("stop", state: "interrupted", extra: alone),
      Frames.summary("err", state: "error", extra: alone),
      Frames.summary("limit", state: "limit-reached", extra: alone),
      Frames.summary("run", state: "running", extra: alone),
      Frames.summary("start", state: "starting", extra: alone),
    ])
    let tones = state.sessions.mapValues(\.statusTone)
    #expect(tones == [
      "unread": .unread, "seen": .backgroundWait, "done": .backgroundWait, "resumable": .backgroundWait,
      "seen-cmd": .working, "done-agent": .working,
      "ask": .waiting, "perm": .waiting, "stop": .waiting, "err": .failed, "limit": .failed,
      "run": .working, "start": .working,
    ])
    let ranks = state.sessions.mapValues(\.listRank)
    #expect(ranks["unread"] == 1 && ranks["seen"] == 3 && ranks["done"] == 4 && ranks["seen-cmd"] == 2)
    #expect(ranks["done-agent"] == 2 && ranks["ask"] == 0 && ranks["err"] == 1 && ranks["run"] == 2)
    // Ta sama sesja bez żadnego tła ma tę samą rangę: czekający subagent niczego w niej nie dokłada. Ton różni się
    // tylko tam, gdzie bez tła stałaby cisza.
    let bare = try self.state([
      Frames.summary("unread", state: "waiting-input"),
      Frames.summary("seen", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("done", state: "done"),
      Frames.summary("resumable", state: "resumable"),
    ])
    for id in ["unread", "seen", "done", "resumable"] {
      #expect(bare.sessions[id]?.listRank == ranks[id], "\(id)")
    }
    #expect(bare.sessions["unread"]?.statusTone == .unread)
    #expect(["seen", "done", "resumable"].allSatisfy { bare.sessions[$0]?.statusTone == .quiet })
  }

  /// Monitor ze złotej ramki (`sessions-snapshot.max.json`, zadanie `monitor_1d`): zdekodowany tak jak ze strumienia
  /// tak jak ze strumienia, a potem sam na liście sesji w każdym stanie tonu.
  @Test("monitor ze złotej ramki: odebrany wynik, done i do wznowienia — ton czekania; reszta jak dziś")
  func monitorFromGoldenFrame() throws {
    var golden = AppState(clientBuild: 7)
    play(&golden, [try Frames.golden("sessions-snapshot.max.json")])
    let source = try #require(golden.sessions["herdr-w1-p1"])
    let monitors = (source.backgroundTasks ?? []).filter { $0.id == "monitor_1d" }
    try #require(monitors.count == 1)
    let others = (source.backgroundTasks ?? []).filter { $0.id != "monitor_1d" }
    let command = try #require(others.first { $0.id == "bash_3f1a" })
    let waitingAgent = try #require(others.first { $0.id == "agent_9b2c" })
    try #require(BackgroundTaskRules.waitingAgent(waitingAgent), "ramka niesie subagenta w postoju")
    func tone(_ state: SessionState, seen: Bool? = nil, _ tasks: [BackgroundTask]) -> StatusTone {
      var session = source
      session.state = state
      session.seen = seen
      session.backgroundTasks = tasks
      return session.statusTone
    }
    #expect(tone(.waitingInput, seen: true, monitors) == .backgroundWait)
    #expect(tone(.waitingInput, monitors) == .unread, "nieodebrany wynik wygrywa")
    #expect(tone(.done, monitors) == .backgroundWait)
    #expect(tone(.resumable, monitors) == .backgroundWait)
    #expect(tone(.running, monitors) == .working && tone(.starting, monitors) == .working)
    #expect(tone(.waitingPermission, monitors) == .waiting && tone(.waitingQuestion, monitors) == .waiting)
    #expect(tone(.interrupted, monitors) == .waiting)
    #expect(tone(.error, monitors) == .failed && tone(.limitReached, monitors) == .failed)
    // Monitor obok subagenta w postoju: dalej nic nie pracuje. Obok komendy: praca.
    #expect(tone(.waitingInput, seen: true, monitors + [waitingAgent]) == .backgroundWait)
    #expect(tone(.waitingInput, seen: true, monitors + [command]) == .working)
    // Bez listy zadań cisza zostaje ciszą, a sesja nieobsługiwana nie dostaje tonu czekania.
    #expect(tone(.waitingInput, seen: true, []) == .quiet && tone(.done, []) == .quiet)
    #expect(tone(.unsupported, monitors) == .quiet)
    // Ranga jak bez tła (`backgroundWait` liczy się jak cisza).
    var seen = source
    seen.state = .waitingInput
    seen.seen = true
    seen.backgroundTasks = monitors
    var done = seen
    done.state = .done
    #expect(seen.listRank == 3 && done.listRank == 4)
  }

  @Test("sufiks #n tylko przy identycznej parze projekt · nazwa, numer od najstarszej")
  func ordinals() throws {
    let state = try state([
      Frames.summary("x2", title: "atlas", createdAt: "2026-10-03T08:00:00.000Z"),
      Frames.summary("x1", title: "atlas", createdAt: "2026-10-03T07:00:00.000Z"),
      Frames.summary("y", title: "atlas", label: "przegląd"),
      Frames.summary("z", title: "birch"),
    ])
    #expect(state.duplicateOrdinals == ["x1": 1, "x2": 2])
  }

  @Test("pole wiadomości: codex, nieobsługiwana, poza zasięgiem, herdr, decyzja; praca nie blokuje")
  func sendBlocks() throws {
    let state = try state([
      Frames.summary("codex", extra: #","engine":"codex""#),
      Frames.summary("unsup", state: "paused"),
      Frames.summary("out", extra: #","outOfScope":true"#),
      Frames.summary("stale", extra: #","stale":true"#),
      Frames.summary("perm", state: "waiting-permission"),
      Frames.summary("q", state: "waiting-question"),
      Frames.summary("run", state: "running"),
    ])
    #expect(state.sendBlock(for: "codex") == .codex)
    #expect(state.sendBlock(for: "unsup") == .unsupported)
    #expect(state.sendBlock(for: "out") == .outOfScope)
    #expect(state.sendBlock(for: "stale") == .herdrUnavailable)
    #expect(state.sendBlock(for: "perm") == .decisionPending)
    #expect(state.sendBlock(for: "q") == .decisionPending)
    #expect(state.sendBlock(for: "run") == nil)
    let cards = try self.state([Frames.summary("lim", state: "limit-reached"), Frames.summary("idle", state: "waiting-input")])
    #expect(cards.sendBlock(for: "lim") == .stateCard(.limitReached))
    #expect(cards.sendBlock(for: "idle") == nil)
    let readOnly = try self.state([Frames.summary("run")],
      extra: #","herdrStatus":{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(readOnly.sendBlock(for: "run") == .herdrReadOnly)
  }

  @Test("start agenta: pole wygaszone do gotowości; zgoda zaufania wygrywa, porażka startu daje kartę stanu")
  func sendBlockStarting() throws {
    let state = try state([
      Frames.summary("start", state: "starting"),
      Frames.summary("trust", state: "waiting-permission", extra: #","herdrDialog":"trust""#),
      Frames.summary("failed", state: "error"),
    ])
    #expect(state.sendBlock(for: "start") == .starting)
    // Dialog zaufania w starcie to stojąca decyzja: zdanie o karcie, nie o starcie.
    #expect(state.sendBlock(for: "trust") == .decisionPending)
    #expect(state.sendBlock(for: "failed") == .stateCard(.error))
    // Przeszkoda kanału jest twardsza niż start.
    let readOnly = try self.state([Frames.summary("start", state: "starting")],
      extra: #","herdrStatus":{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(readOnly.sendBlock(for: "start") == .herdrReadOnly)
    // Koniec startu zdejmuje blokadę: prompt startowy (`running`) albo pusty start (`waiting-input`).
    #expect(try self.state([Frames.summary("start", state: "running")]).sendBlock(for: "start") == nil)
    #expect(try self.state([Frames.summary("start", state: "waiting-input")]).sendBlock(for: "start") == nil)
  }

  @Test("start agenta: Stop działa jak dotąd, model zamrożony jak dotąd")
  func startingKeepsStopAndModelFreeze() throws {
    let state = try state([Frames.summary("start", state: "starting")])
    #expect(state.interruptAvailability(for: "start") == .enabled)
    #expect(state.modelChangeBlock(for: "start") == .busy)
  }

  @Test("banery: niezgodność pierwsza; brak serwera wycisza resztę; transkrypt tylko przy żywym globalnym")
  func banners() throws {
    var state = try state([Frames.summary("s1")],
      extra: #","herdrStatus":{"available":false,"agentCount":0,"readOnly":false,"canLaunch":false}"#)
    play(&state, [try Frames.hello(minClientBuild: 99)])
    state.global = .offline(since: Date())
    #expect(state.banners == [.incompatible(.tooOld(minClientBuild: 99)), .serverUnreachable])
    state.global = .online
    state.viewedSessionId = "s1"
    state.sessionStream = .offline(since: Date())
    #expect(state.banners == [
      .incompatible(.tooOld(minClientBuild: 99)), .transcriptStalled, .herdrUnavailable(detail: nil, staleSince: nil),
    ])
  }

  @Test("łączenie: rdzeń nie stawia karty łączenia (bez zegara), herdr przy łączeniu dalej mówi")
  func connectingWithoutCard() throws {
    var state = try state([Frames.summary("s1")],
      extra: #","herdrStatus":{"available":false,"agentCount":0,"readOnly":false,"canLaunch":false}"#)
    state.global = .connecting(since: Date())
    #expect(state.banners == [.herdrUnavailable(detail: nil, staleSince: nil)])
    #expect(!state.banners.contains { (banner: Banner) in if case .connecting = banner { true } else { false } },
      "kartę „Łączę z serwerem…” i jej próg stawia pamięć połączenia apki (`ConnectionMemory.connectionCard`)")
  }

  @Test("faza transkryptu: szkielet przed stanem, pusty ze stanem, nieznana sesja tylko po połączeniu")
  func transcriptPhase() throws {
    var state = AppState(clientBuild: 7)
    #expect(state.transcriptPhase(for: "s1") == .loading)
    play(&state, [try Frames.snapshot([Frames.summary("s1", state: "waiting-input")])])
    #expect(state.transcriptPhase(for: "s1") == .loading)
    #expect(state.transcriptPhase(for: "nieznana") == .loading, "w trakcie łączenia nie mówimy „nie znam”")
    state.global = .online
    #expect(state.transcriptPhase(for: "nieznana") == .unknownSession)
    play(&state, [try Frames.transcript("s1")], source: .session("s1"))
    #expect(state.transcriptPhase(for: "s1") == .empty(.waitingInput))
    play(&state, [try Frames.message("s1", seq: 1, text: "x")], source: .session("s1"))
    #expect(state.transcriptPhase(for: "s1") == .content)
  }

  @Test("możliwości: brak `voiceEnabled` = włączone, brak reszty flag = wyłączone")
  func capabilities() throws {
    let version = try JSONDecoder().decode(VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s"}"#.utf8))
    let caps = Capabilities(version)
    #expect(caps.voice && !caps.terminal && !caps.notes && !caps.apns)
  }

  @Test("możliwości: kanał APNs apki tylko przy jawnym `apnsEnabled: true`")
  func apnsCapability() throws {
    let decode = { (tail: String) in
      try JSONDecoder().decode(VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(tail)}"#.utf8))
    }
    #expect(Capabilities(try decode(#","apnsEnabled":true"#)).apns)
    #expect(!Capabilities(try decode(#","apnsEnabled":false"#)).apns)
  }

  @Test("nieobsługiwana sesja = nieznany stan albo silnik (nagrane degradacje)")
  func unsupported() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.golden("sessions-snapshot.unknown-many.json")])
    #expect(state.sessions["herdr-w4-p8"]?.isUnsupported == true)
    #expect(state.sessions["herdr-w3-p6"]?.isUnsupported == true)
    #expect(state.sessions["herdr-w1-p1"]?.isUnsupported == false)
  }
}

// A subagent waiting on its own command (`ownCommandWait`): the row's tone, rank and filter segments in each session
// state. Catches a stuck session outside Needs You, a session in a turn leaving Working, a phantom agent (`done`,
// `resumable`) raising its row, an error covered by the stuck wait, `short` changing the row, a received result with
// a `long` wait missing its warning tone, and the warning tone taking an unread result, a rank or a segment.
extension SelectorTests {
  struct WaitCase: Sendable, CustomTestStringConvertible {
    let name: String
    let state: String
    var seen = false
    /// The stage the server sent on the waiting subagent; `nil` = no field.
    let wait: String?
    /// A live command next to the waiting subagent.
    var command = false
    /// A monitor next to the waiting subagent.
    var monitor = false
    /// The stage of a second waiting subagent on the same list; `nil` = none.
    var second: String? = nil
    let tone: StatusTone
    let rank: Int
    /// Segments the session belongs to, besides All.
    let segments: Set<ListFilter>
    var testDescription: String { name }
  }

  static let waitCases: [WaitCase] = [
    WaitCase(name: "short, unread result", state: "waiting-input", wait: "short", tone: .unread, rank: 1,
             segments: [.unread]),
    WaitCase(name: "short, received result", state: "waiting-input", seen: true, wait: "short", tone: .backgroundWait,
             rank: 3, segments: []),
    WaitCase(name: "long, unread result", state: "waiting-input", wait: "long", tone: .unread, rank: 1,
             segments: [.unread]),
    WaitCase(name: "long, received result", state: "waiting-input", seen: true, wait: "long",
             tone: .backgroundWaitLong, rank: 3, segments: []),
    WaitCase(name: "long next to a monitor, received", state: "waiting-input", seen: true, wait: "long", monitor: true,
             tone: .backgroundWaitLong, rank: 3, segments: []),
    WaitCase(name: "long next to a short wait, received", state: "waiting-input", seen: true, wait: "long",
             second: "short", tone: .backgroundWaitLong, rank: 3, segments: []),
    WaitCase(name: "short next to a stuck wait, received", state: "waiting-input", seen: true, wait: "short",
             second: "stuck", tone: .waiting, rank: 0, segments: [.needsYou]),
    WaitCase(name: "long in a turn", state: "running", wait: "long", tone: .working, rank: 2, segments: [.working]),
    WaitCase(name: "long, phantom agent of a done session", state: "done", wait: "long", tone: .backgroundWait,
             rank: 4, segments: []),
    WaitCase(name: "long, phantom agent of a resumable session", state: "resumable", wait: "long",
             tone: .backgroundWait, rank: 1, segments: []),
    WaitCase(name: "stuck, unread result", state: "waiting-input", wait: "stuck", tone: .waiting, rank: 0,
             segments: [.needsYou]),
    WaitCase(name: "stuck, received result", state: "waiting-input", seen: true, wait: "stuck", tone: .waiting,
             rank: 0, segments: [.needsYou]),
    WaitCase(name: "stuck next to a live command, received", state: "waiting-input", seen: true, wait: "stuck",
             command: true, tone: .waiting, rank: 0, segments: [.needsYou]),
    WaitCase(name: "stuck next to a live command, unread", state: "waiting-input", wait: "stuck", command: true,
             tone: .waiting, rank: 0, segments: [.needsYou]),
    WaitCase(name: "long next to a live command, received", state: "waiting-input", seen: true, wait: "long",
             command: true, tone: .working, rank: 2, segments: [.working]),
    WaitCase(name: "stuck in a turn", state: "running", wait: "stuck", tone: .working, rank: 2, segments: [.working]),
    WaitCase(name: "stuck while starting", state: "starting", wait: "stuck", tone: .working, rank: 2,
             segments: [.working]),
    WaitCase(name: "stuck at a permission", state: "waiting-permission", wait: "stuck", tone: .waiting, rank: 0,
             segments: [.needsYou]),
    WaitCase(name: "stuck at a question", state: "waiting-question", wait: "stuck", tone: .waiting, rank: 0,
             segments: [.needsYou]),
    WaitCase(name: "stuck with an error", state: "error", wait: "stuck", tone: .failed, rank: 1, segments: [.needsYou]),
    WaitCase(name: "stuck at the plan limit", state: "limit-reached", wait: "stuck", tone: .failed, rank: 1,
             segments: [.needsYou]),
    WaitCase(name: "stuck after an interrupted turn", state: "interrupted", wait: "stuck", tone: .waiting, rank: 1,
             segments: [.needsYou]),
    WaitCase(name: "long at a permission", state: "waiting-permission", wait: "long", tone: .waiting, rank: 0,
             segments: [.needsYou]),
    WaitCase(name: "long with an error", state: "error", wait: "long", tone: .failed, rank: 1, segments: [.needsYou]),
    WaitCase(name: "stuck, phantom agent of a done session", state: "done", wait: "stuck", tone: .backgroundWait,
             rank: 4, segments: []),
    WaitCase(name: "stuck, phantom agent of a resumable session", state: "resumable", wait: "stuck",
             tone: .backgroundWait, rank: 1, segments: []),
    WaitCase(name: "standby without a field", state: "waiting-input", seen: true, wait: nil, tone: .backgroundWait,
             rank: 3, segments: []),
  ]

  @Test("a subagent's wait on its own command: tone, rank and filter segments of the row", arguments: waitCases)
  func ownCommandWaitRow(_ sample: WaitCase) throws {
    let agent = agentTask(
      "agent_w", waitingSince: "2026-10-03T07:00:00.000Z", ownTask: "until false; do sleep 30; done", wait: sample.wait)
    var list = [agent]
    if sample.command { list.append(workflowTask("bash_1", run: false, kind: "command")) }
    if sample.monitor { list.append(#"{"id":"monitor_1","kind":"monitor","description":"server log"}"#) }
    if let second = sample.second {
      list.append(agentTask(
        "agent_v", waitingSince: "2026-10-03T06:00:00.000Z", ownTask: "until false; do sleep 60; done", wait: second))
    }
    let tasks = #","backgroundTasks":[\#(list.joined(separator: ","))]"#
    let state = try state([
      Frames.summary("s", state: sample.state, extra: (sample.seen ? #","seen":true"# : "") + tasks),
    ])
    let session = try #require(state.sessions["s"])
    #expect(session.statusTone == sample.tone, "tone")
    #expect(session.listRank == sample.rank, "rank")
    #expect(state.listOrderRank(session) == sample.rank, "rank in the list order")
    let segments = Set(ListFilter.allCases.filter { $0 != .all && state.listFilterContains($0, session) })
    #expect(segments == sample.segments, "filter segments")
    #expect(state.freshResult(session) == sample.segments.contains(.unread), "the dot pulses only in Unread")
    if sample.tone == .backgroundWaitLong { #expect(sample.tone.isCalm, "a long wait counts as calm, like silence") }
  }
}
