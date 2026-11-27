import Foundation
import RarogActivity
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Testing

// Zbiorcza Live Activity w rdzeniu: stan STARTOWY kafla (liczniki i cel tapnięcia) składany
// z listy tą samą regułą co serwer (złote ramki `shared/fixtures/apns/`), warunek „zajęty" jak serwerowe
// `isBusy` (także przebieg workflow w tle), prywatność i adres tapnięcia. Cykl życia z atrapą systemu
// (`FakeActivities`) i pomocnicze ramki zadań w tle: `LiveActivityTests.swift`.

// MARK: - Stan startowy z listy (lustro `aggregateState`)

@Suite("Live Activity: stan startowy kafla i „zajęty” z listy jak na serwerze (v2)")
struct LiveActivityInputTests {
  /// `NOW` producenta złotych ramek (`server/test/apns-fixtures-producenci.test.ts`): 2026-10-07T10:00Z.
  static let now = Date(timeIntervalSince1970: 1_791_367_200)

  static func golden(_ name: String) throws -> LiveActivityContentState {
    let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/apns/\(name)")
    struct Frame: Decodable { let payload: LiveActivityPayload }
    return try JSONDecoder().decode(Frame.self, from: Data(contentsOf: url)).payload.aps.contentState
  }

  static func sessions(_ summaries: [String]) throws -> [SessionSummary] {
    guard case let .sessionsSnapshot(snapshot) = try Frames.snapshot(summaries) else {
      Issue.record("to nie lista sesji")
      return []
    }
    return snapshot.sessions
  }

  static func iso(_ offset: TimeInterval) -> String {
    ISOTime.string(now.addingTimeInterval(offset))
  }

  /// Parytet stanu startowego: liczniki i cel tapnięcia jak w ramce serwera; resztę (przebiegi, limity, Mac)
  /// dosyła serwer, więc apka jej nie składa.
  static func expectStartParity(
    _ local: LiveActivityContentState, _ golden: LiveActivityContentState,
    sourceLocation: SourceLocation = #_sourceLocation
  ) {
    #expect(local.waiting == golden.waiting, sourceLocation: sourceLocation)
    #expect(local.working == golden.working, sourceLocation: sourceLocation)
    #expect(local.finished == golden.finished, sourceLocation: sourceLocation)
    #expect(local.top == golden.top, sourceLocation: sourceLocation)
    #expect(local.workflows == nil && local.moreWorkflows == nil, sourceLocation: sourceLocation)
    #expect(local.limits == nil && local.mac == nil, sourceLocation: sourceLocation)
  }

  @Test("wpis Codexa, dwa przebiegi z „+1” i koniec: liczniki i cel tapnięcia jak złote ramki serwera")
  func goldenSynthetic() throws {
    // `makeSummary` serwera: cwd i daty domyślne, nadpisania z producenta ramek.
    let codex = try Self.sessions([Frames.summary(
      "demo-codex", state: "waiting-permission", title: "codex-proba", stateSince: Self.iso(-90),
      extra: #","engine":"codex","termId":"0123456789abcdef""#)])
    // Ramka Codexa nie ma ani przebiegów, ani limitów, ani Maca — stan startowy jest jej równy w całości.
    #expect(LiveActivityInput.aggregate(codex, now: Self.now) == (try Self.golden("live-activity.update.codex.json")))

    // Te same sesje co producent ramki workflow: sesja po turze z nieodebranym wynikiem i przebiegiem
    // z planem faz, druga pracująca z dwoma przebiegami bez planu.
    let workflow = try Self.sessions([
      Frames.summary(
        "demo-rarog", state: "waiting-input", title: "rarog", stateSince: Self.iso(-600),
        extra: backgroundTasks(workflowTask(
          "w1", name: "audyt-docs", runId: "wf_audyt", startedAt: Self.iso(-900),
          phases: ["A1 Zbieranie", "A2 Weryfikacja", "A3 Synteza"], agents: [true, true, true, false]))),
      Frames.summary(
        "demo-atlas", state: "running", title: "atlas-web", stateSince: Self.iso(-300),
        extra: backgroundTasks(
          workflowTask(
            "w2", name: "review-changes", runId: "wf_review", startedAt: Self.iso(-600), agents: [true, false, false]),
          workflowTask("w3", name: "migracja", runId: "wf_migracja", startedAt: Self.iso(-60)))),
    ])
    Self.expectStartParity(
      LiveActivityInput.aggregate(workflow, now: Self.now), try Self.golden("live-activity.update.workflow.json"))
    #expect(LiveActivityInput.isBusy(workflow))
    #expect(LiveActivityInput.aggregate([], now: Self.now) == (try Self.golden("live-activity.end.json")))
    #expect(!LiveActivityInput.isBusy([]))
  }

  /// Te same sześć sesji po turze co producent ramki `live-activity.update.waiting-agent.json`.
  static func waitingAgentSessions() throws -> [SessionSummary] {
    let command = "until grep -q TEST log.txt; do sleep 5; done"
    let waiting = agentTask("agent_w", waitingSince: iso(-1080), ownTask: command, wait: "short")
    return try sessions([
      Frames.summary("demo-rarog", state: "waiting-input", title: "rarog", stateSince: iso(-1080),
                     extra: backgroundTasks(waiting)),
      Frames.summary("demo-map-view", state: "waiting-input", title: "map-view", stateSince: iso(-900),
                     extra: #","seen":true"# + backgroundTasks(waiting)),
      Frames.summary("demo-atlas", state: "waiting-input", title: "atlas-web", stateSince: iso(-600),
                     extra: backgroundTasks(waiting, workflowTask("c1", run: false, kind: "command"))),
      Frames.summary("demo-willow", state: "waiting-input", title: "willow", stateSince: iso(-300),
                     extra: backgroundTasks(agentTask("agent_r1"))),
      Frames.summary("demo-stuck", state: "waiting-input", title: "demo", stateSince: iso(-5400),
                     extra: backgroundTasks(
                       agentTask("agent_s1", waitingSince: iso(-5400), ownTask: command, wait: "stuck"))),
      Frames.summary("demo-atlas-api", state: "waiting-input", title: "atlas-api", stateSince: iso(-4200),
                     extra: #","seen":true"# + backgroundTasks(
                       agentTask("agent_s2", waitingSince: iso(-4200), ownTask: command, wait: "stuck"),
                       workflowTask("c2", run: false, kind: "command"))),
    ])
  }

  @Test("subagent w postoju: liczniki jak złota ramka serwera — czekający to nie „pracuje”, tylko „skończyły”; `stuck` czeka")
  func goldenWaitingAgent() throws {
    let list = try Self.waitingAgentSessions()
    let golden = try Self.golden("live-activity.update.waiting-agent.json")
    #expect(golden.waiting == 2 && golden.working == 2 && golden.finished == 1 && golden.top == nil)
    // Ramka nie ma przebiegów, limitów ani Maca, więc stan startowy jest jej równy w całości.
    #expect(LiveActivityInput.aggregate(list, now: Self.now) == golden)
    // Subagent w postoju kafla nie trzyma (jak każde zadanie spoza workflow), also at `stuck` — tak samo serwer.
    #expect(!LiveActivityInput.isBusy(list))
    // Liczba na kaflu prowadzi do sesji z TEGO licznika.
    var app = AppState(clientBuild: 1)
    for session in list { app.sessions[session.id] = session }
    #expect(app.firstSession(.finished)?.id == "demo-rarog")
    #expect(try ["demo-atlas", "demo-willow"].contains(#require(app.firstSession(.working)).id))
    #expect(try ["demo-stuck", "demo-atlas-api"].contains(#require(app.firstSession(.waiting)).id))
    let byKind = Dictionary(uniqueKeysWithValues: SessionJump.allCases.map { kind in
      (kind, list.filter { LiveActivityInput.matches($0, kind) }.map(\.id).sorted())
    })
    #expect(byKind[.working] == ["demo-atlas", "demo-willow"] && byKind[.finished] == ["demo-rarog"])
    // A stuck session counts once, as waiting, also next to a live command.
    #expect(byKind[.waiting] == ["demo-atlas-api", "demo-stuck"])
    // Odebrany wynik przy samym czekającym: ani praca, ani „skończyły”.
    #expect(SessionJump.allCases.allSatisfy { !LiveActivityInput.matches(list[1], $0) })
  }

  @Test("stuck wait: a decision counts once, a turn works, a phantom agent counts as before; the jump follows the counter")
  func stuckSession() throws {
    let stuck = agentTask("agent_s", waitingSince: Self.iso(-5400), ownTask: "until false; do sleep 30; done", wait: "stuck")
    let list = try Self.sessions([
      Frames.summary("ask", state: "waiting-permission", stateSince: Self.iso(-60), extra: backgroundTasks(stuck)),
      Frames.summary("turn", state: "running", stateSince: Self.iso(-120), extra: backgroundTasks(stuck)),
      Frames.summary("gone", state: "done", extra: backgroundTasks(stuck)),
      Frames.summary("later", state: "resumable", extra: backgroundTasks(stuck)),
    ])
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    #expect(state.waiting == 1 && state.working == 1 && state.finished == 0 && state.top == .init(sessionId: "ask"))
    let alone = try Self.sessions([
      Frames.summary("stuck", state: "waiting-input", stateSince: Self.iso(-5400), extra: backgroundTasks(stuck)),
    ])
    #expect(LiveActivityInput.aggregate(alone, now: Self.now).top == nil, "a session after a turn is no tap target")
    var app = AppState(clientBuild: 1)
    for session in alone { app.sessions[session.id] = session }
    #expect(app.firstSession(.waiting)?.id == "stuck")
    #expect(app.firstSession(.finished) == nil)
  }

  @Test("seedy demo (złota lista `sessions-snapshot.demo`): liczniki i sesja wiodąca jak ramka z seedów")
  func goldenSeeds() throws {
    guard case let .sessionsSnapshot(snapshot) = try Frames.golden("sessions-snapshot.demo.json") else {
      Issue.record("to nie lista sesji")
      return
    }
    // Obie ramki powstały z tych samych seedów, ale w innych chwilach — czasy się różnią, treść nie.
    Self.expectStartParity(
      LiveActivityInput.aggregate(snapshot.sessions, now: Self.now), try Self.golden("live-activity.update.json"))
  }

  @Test("wiodąca: najdłużej czekająca bije pracującą; remis rozstrzyga id; czas nieczytelny na końcu")
  func lead() throws {
    let list = try Self.sessions([
      Frames.summary("b-run", state: "running", stateSince: Self.iso(-3600)),
      Frames.summary("z-wait", state: "waiting-question", stateSince: Self.iso(-60)),
      Frames.summary("a-wait", state: "waiting-question", stateSince: Self.iso(-60)),
      Frames.summary("c-wait", state: "waiting-permission", stateSince: "wczoraj"),
      Frames.summary("d-done", state: "waiting-input", stateSince: Self.iso(-9999)),
    ])
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    #expect(state.waiting == 3 && state.working == 1 && state.finished == 1)
    #expect(state.top == .init(sessionId: "a-wait") && state.updatedEpoch == 1_791_367_200)
    #expect(LiveActivityInput.aggregate([list[3]], now: Self.now).top?.sessionId == "c-wait")
    #expect(LiveActivityInput.aggregate([list[0]], now: Self.now).top?.sessionId == "b-run", "bez czekających — praca")
    #expect(LiveActivityInput.aggregate([list[4]], now: Self.now).top == nil, "sesja po turze nie jest celem")
  }

  @Test("„skończyły”: po turze z wynikiem nieodebranym — `seen` brak i `false` liczą się, `true` nie")
  func finished() throws {
    let list = try Self.sessions([
      Frames.summary("s-nil", state: "waiting-input"),
      Frames.summary("s-false", state: "waiting-input", extra: #","seen":false"#),
      Frames.summary("s-true", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("s-done", state: "done"),
    ])
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    #expect(state == LiveActivityContentState(waiting: 0, working: 0, finished: 2, updatedEpoch: 1_791_367_200))
    // Sam wynik do odebrania nie trzyma kafla przy życiu — tak samo serwer.
    #expect(!LiveActivityInput.isBusy(list))
  }

  @Test("„pracuje w tle”: po turze z żywym zadaniem w tle — praca, nie „skończyły”; cel tapnięcia bez zmian")
  func backgroundWork() throws {
    let shell = backgroundTasks(workflowTask("c", run: false, kind: "command"))
    let list = try Self.sessions([
      Frames.summary("a", state: "waiting-input", extra: shell),
      Frames.summary("b", state: "waiting-input", extra: #","seen":true"# + shell),
      Frames.summary("c", state: "done", extra: shell),
      // Przebieg, w którym wszyscy agenci skończyli, już nie mieli — wynik do odebrania zostaje wynikiem.
      Frames.summary("d", state: "waiting-input", extra: backgroundTasks(workflowTask("w", agents: [true]))),
      // Błąd i decyzja zostają sobą, jak na liście.
      Frames.summary("e", state: "error", extra: shell),
      Frames.summary("f", state: "waiting-permission", extra: shell),
    ])
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    #expect(state.waiting == 1 && state.working == 3 && state.finished == 1)
    #expect(state.top == .init(sessionId: "f"))
    let alone = LiveActivityInput.aggregate([list[0]], now: Self.now)
    #expect(alone.working == 1 && alone.finished == 0 && alone.top == nil, "sesja „w tle” nie jest celem")
    // Kafla komenda w tle nie trzyma (serwer deweloperski mieli bez końca) — tak samo serwer.
    #expect(!LiveActivityInput.isBusy([list[0]]))
    // Liczba na kaflu prowadzi do sesji z TEGO licznika: zakończony workflow (d) to „skończyło”, nie praca.
    var app = AppState(clientBuild: 1)
    for session in list { app.sessions[session.id] = session }
    #expect(app.firstSession(.finished)?.id == "d")
    #expect(app.firstSession(.waiting)?.id == "f")
    #expect(try ["a", "b", "c"].contains(#require(app.firstSession(.working)).id))
    for kind in SessionJump.allCases {
      let counted = list.filter { LiveActivityInput.matches($0, kind) }.count
      let tile = LiveActivityInput.aggregate(list, now: Self.now)
      #expect(counted == (kind == .waiting ? tile.waiting : kind == .working ? tile.working : tile.finished), "\(kind)")
    }
  }

  @Test("ton „czeka na zadanie w tle”: sesja z samym monitorem albo czekającym subagentem kafla nie rusza")
  func backgroundWaitTone() throws {
    let monitor = backgroundTasks(workflowTask("m", run: false, kind: "monitor"))
    let list = try Self.sessions([
      Frames.summary("a", state: "waiting-input", extra: #","seen":true"# + monitor),
      Frames.summary("b", state: "done", extra: monitor),
      Frames.summary("c", state: "waiting-input", extra: monitor),
    ])
    #expect(list[0].statusTone == .backgroundWait && list[1].statusTone == .backgroundWait)
    #expect(list[2].statusTone == .unread)
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    #expect(state.waiting == 0 && state.working == 0 && state.finished == 1, "ton czekania liczy się jak cisza")
    #expect(!LiveActivityInput.isBusy(list))
    #expect(SessionJump.allCases.allSatisfy { !LiveActivityInput.matches(list[0], $0) })
  }

  @Test("cel tapnięcia: `termId` tylko w kształcie TERM_ID_RE (zły znika, sesja zostaje)")
  func termId() throws {
    let list = try Self.sessions([
      Frames.summary("s1", state: "waiting-permission", extra: #","termId":"ZZZ""#),
      Frames.summary("s2", state: "running", extra: #","engine":"codex","termId":"0123456789abcdef""#),
    ])
    #expect(LiveActivityInput.aggregate([list[0]], now: Self.now).top == .init(sessionId: "s1"))
    #expect(LiveActivityInput.aggregate([list[1]], now: Self.now).top
      == .init(sessionId: "s2", termId: "0123456789abcdef"))
  }

  @Test("„zajęty” jak serwer: decyzja, praca, przebieg w tle bez rozkładu, bez agentów albo z agentem w locie")
  func busy() throws {
    func busy(_ state: String, _ extra: String = "") throws -> Bool {
      LiveActivityInput.isBusy(try Self.sessions([Frames.summary("s", state: state, extra: extra)]))
    }
    #expect(try busy("waiting-permission") && busy("waiting-question") && busy("starting") && busy("running"))
    #expect(try !busy("waiting-input") && !busy("done") && !busy("error") && !busy("limit-reached"))
    // „Nie wiem" (rozkład nieodczytany) nie może zakończyć aktywności.
    #expect(try busy("waiting-input", backgroundTasks(workflowTask("w", run: false))))
    // Przebieg dopiero rusza — jeszcze żaden agent.
    #expect(try busy("waiting-input", backgroundTasks(workflowTask("w", agents: []))))
    #expect(try busy("waiting-input", backgroundTasks(workflowTask("w", agents: [true, false]))))
    // Wszyscy agenci skończyli (synteza, zabite CLI bez wpisu zamknięcia) — kafla nie trzyma.
    #expect(try !busy("waiting-input", backgroundTasks(workflowTask("w", agents: [true, true]))))
    // Inne zadania w tle (agent pracujący i czekający, komenda) nie liczą się — tak samo serwer.
    #expect(try !busy("waiting-input", backgroundTasks(workflowTask("a", run: false, kind: "agent"))))
    #expect(try !busy("waiting-input", backgroundTasks(agentTask("a", waitingSince: Self.iso(-60)))))
    #expect(try !busy("waiting-input", backgroundTasks(workflowTask("c", run: false, kind: "command"))))
  }

  @Test("prywatność: treść, komenda, etap, wynik, narzędzie, etykieta i opis zadania nie wchodzą do stanu")
  func privacy() throws {
    let secrets = [
      "rm -rf /tmp/sekret", "uruchamia komendę: rm", "Gotowe: hasło 123", "Czy usunąć bazę?", "zapis notatek",
      "Edit", "audyt-docs",
    ]
    let list = try Self.sessions([
      Frames.summary("s1", state: "waiting-permission", label: "zapis notatek", extra: #"""
        ,"waitingFor":{"kind":"permission","tool":"Edit","text":"rm -rf /tmp/sekret","subject":"tool"},
        "lastSummary":"Gotowe: hasło 123","activity":{"kind":"tool","toolName":"Edit","summary":"uruchamia komendę: rm"}
        """# + backgroundTasks(workflowTask("w", name: "audyt-docs", agents: [false]))),
      Frames.summary("s2", state: "waiting-question", extra: #","waitingFor":{"kind":"question","text":"Czy usunąć bazę?"}"#),
    ])
    let state = LiveActivityInput.aggregate(list, now: Self.now)
    let json = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
    for secret in secrets { #expect(!json.contains(secret), "\(secret)") }
    var labels: Set<String> = []
    func collect(_ value: Any) {
      for child in Mirror(reflecting: value).children {
        if let label = child.label { labels.insert(label) }
        collect(child.value)
      }
    }
    collect(state)
    #expect(labels.isDisjoint(with: ["text", "summary", "lastSummary", "displayText", "command", "tool", "label", "kind"]))
  }

  @Test("nakładka zapisu z apki: z listy tylko liczniki; `top`, przebiegi, limity, Mac, `updatedEpoch` i `staleDate` (także `nil`) z treści systemu")
  func overlay() throws {
    let served = LiveActivityContentState(
      waiting: 2, working: 0, finished: 3, top: .init(sessionId: "serwer", termId: "0123456789abcdef"),
      workflows: [.init(
        sessionId: "s1", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0])],
      moreWorkflows: 1, limits: .init(fiveHour: 42, weekly: 81), mac: .init(cpu: 35, ram: 60, disk: 80),
      updatedEpoch: 1_791_367_000)
    let local = LiveActivityContentState(
      waiting: 0, working: 1, finished: 1, top: .init(sessionId: "apka"), updatedEpoch: 1_791_367_200)
    for staleDate in [Self.now.addingTimeInterval(600), nil] {
      var expected = served
      expected.waiting = 0
      expected.working = 1
      expected.finished = 1
      #expect(LiveActivityInput.overlay(displayed: LiveActivityContent(state: served, staleDate: staleDate), local: local)
        == LiveActivityContent(state: expected, staleDate: staleDate))
    }
  }

  @Test("znacznik zapisu: najnowszy `stateSince` obrazu strumienia globalnego do pełnej sekundy minus 1 s; `sessions` nie wchodzi; `nil` przy liście nieświeżej i bez czasu")
  func asOf() throws {
    var app = AppState(clientBuild: 1)
    for session in try Self.sessions([
      Frames.summary("a", state: "running", stateSince: "2026-10-03T08:00:00.000Z"),
      Frames.summary("b", state: "waiting-input", stateSince: "2026-10-03T08:05:30.250Z"),
      Frames.summary("c", state: "waiting-permission", stateSince: "wczoraj"),
    ]) { app.globalList[session.id] = session }
    // Nowszy `stateSince` z innego źródła niż strumień globalny (strumień sesji, HTTP) znacznika nie podnosi.
    for session in try Self.sessions([Frames.summary("b", state: "running", stateSince: "2026-10-03T08:09:00.000Z")]) {
      app.sessions[session.id] = session
    }
    #expect(app.liveActivityAsOf == nil, "lista nie jest świeża")
    app.push.listConfirmed = true
    #expect(app.liveActivityAsOf == ISOTime.parse("2026-10-03T08:05:29.000Z"))
    let write = try #require(app.liveActivityWrite(now: Self.now))
    #expect(write.asOf == app.liveActivityAsOf && write.counts == LiveActivityCounts(
      LiveActivityContentState(waiting: 1, working: 1, finished: 1, updatedEpoch: 0)), "liczniki z tego samego obrazu")
    app.globalList["b"] = nil
    app.globalList["a"] = nil
    #expect(app.liveActivityAsOf == nil, "bez czytelnego `stateSince` zapisu nie ma")
  }

  @Test("obraz listy strumienia globalnego: pełny stan, `session-changed` i `state` tylko z tego strumienia; strumień sesji, odpowiedź HTTP i pamięć podręczna go nie zmieniają")
  func globalListFrames() throws {
    func at(_ hhmmss: String) -> String { "2026-10-03T\(hhmmss)Z" }
    var app = AppState(clientBuild: 1)
    app.apply(.loggedIn, now: Self.now)
    play(&app, [try Frames.snapshot([
      Frames.summary("a", stateSince: at("08:00:00.000")), Frames.summary("b", stateSince: at("08:00:00.000")),
    ])])
    #expect(Set(app.globalList.keys) == ["a", "b"] && app.globalList == app.sessions)
    // Strumień oglądanej sesji: `sessions` tak, obraz nie.
    play(&app, [
      try Frames.sessionChanged(Frames.summary("b", state: "waiting-input", stateSince: at("08:02:00.000"))),
      try Frames.decode(#"{"type":"state","sessionId":"a","state":"waiting-permission","since":"\#(at("08:03:00.000"))"}"#),
    ], source: .session("b"))
    #expect(app.sessions["b"]?.state == .waitingInput && app.sessions["a"]?.state == .waitingPermission)
    #expect(app.globalList["b"]?.state == .running && app.globalList["a"]?.state == .running)
    // Odpowiedź HTTP (przerwanie) też nie.
    let replied = try #require(try Self.sessions([Frames.summary("b", state: "done", stateSince: at("08:04:00.000"))]).first)
    app.apply(.turnControl(.interruptReplied(replied)), now: Self.now)
    #expect(app.sessions["b"]?.state == .done && app.globalList["b"]?.state == .running)
    // Strumień globalny: `state` zmienia stan i czas (powtórzony stan czasu nie zmienia), `session-changed` dodaje.
    play(&app, [
      try Frames.decode(#"{"type":"state","sessionId":"a","state":"waiting-permission","since":"\#(at("08:01:00.000"))"}"#),
      try Frames.decode(#"{"type":"state","sessionId":"a","state":"waiting-permission","since":"\#(at("08:05:00.000"))"}"#),
      try Frames.decode(#"{"type":"state","sessionId":"x","state":"running","since":"\#(at("08:05:00.000"))"}"#),
      try Frames.sessionChanged(Frames.summary("c", state: "waiting-input", stateSince: at("08:01:30.000"))),
    ])
    #expect(app.globalList["a"]?.state == .waitingPermission && app.globalList["a"]?.stateSince == at("08:01:00.000"))
    #expect(app.globalList["c"]?.state == .waitingInput && app.globalList["x"] == nil, "`state` nie zakłada sesji")
    // Pełny stan zastępuje obraz — jedyna droga usunięcia sesji.
    play(&app, [try Frames.snapshot([Frames.summary("a", state: "waiting-permission", stateSince: at("08:01:00.000"))])])
    #expect(Array(app.globalList.keys) == ["a"])
    // Nowe zalogowanie zeruje obraz; pamięć podręczna z dysku go nie wypełnia.
    app.apply(.loggedIn, now: Self.now)
    #expect(app.globalList.isEmpty)
    let cached = try Self.sessions([Frames.summary("a")])
    app.apply(.listCache(.restored(CachedList(sessions: cached, savedAt: Self.now))), now: Self.now)
    #expect(app.sessions.count == 1 && app.globalList.isEmpty)
  }

  @Test("adresy kafla wracają w apce do tego samego celu: liczba → rodzaj, tło → lista; sesja i terminal po staremu")
  func linkRoundTrip() throws {
    for tally in LiveActivityPresentation.Tally.allCases {
      #expect(PushRouting.link(url: LiveActivityPresentation.jumpLink(tally)) == .jump(try #require(SessionJump(rawValue: tally.rawValue))))
    }
    #expect(Set(LiveActivityPresentation.Tally.allCases.map(\.rawValue)) == Set(SessionJump.allCases.map(\.rawValue)))
    #expect(PushRouting.link(url: LiveActivityPresentation.listLink) == .list)
    let session = try #require(URL(string: "rarog://session/herdr-w1%20p2"))
    #expect(PushRouting.link(url: session) == .session(PushTarget(sessionId: "herdr-w1 p2")))
    let codex = try #require(URL(string: "rarog://terminal/0123456789abcdef?session=demo-codex"))
    #expect(PushRouting.link(url: codex) == .session(PushTarget(sessionId: "demo-codex", termId: "0123456789abcdef")))
    let old = PairingFixtures.legacyScheme
    for raw in ["rarog://", "rarog://jump/nieznany", "rarog://jump", "rarog://list/coś", "inny://list", "\(old)://list",
                "\(old)://session/x"] {
      #expect(PushRouting.link(url: try #require(URL(string: raw))) == nil, "\(raw)")
    }
    for raw in ["rarog://terminal/0123456789abcdef", "rarog://terminal/0123456789ABCDEF?session=s",
                "rarog://terminal/0123456789abcdef?session="] {
      #expect(PushRouting.target(url: try #require(URL(string: raw))) == nil, "\(raw)")
    }
  }
}
