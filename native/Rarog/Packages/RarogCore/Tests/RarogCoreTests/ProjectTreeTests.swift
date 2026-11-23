import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Drzewo projektów listy: kolejność, widoczność w zwiniętym projekcie, zaznaczenie
// i ostatnio otwarte wiersze. Pamięć zwiniętych projektów i układu listy: `ProjectTreeMemoryTests.swift`.
// Właściciel: lista i projekty.

private let at = Date(timeIntervalSince1970: 1_790_000_000)
private let seen = #","seen":true"#
private let background = #","backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test"}]"#

private let utc: Calendar = {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  return calendar
}()

/// Agent w projekcie `/Users/demo/<project>` (``Frames/summary`` składa katalog z tytułu).
private func agent(
  _ id: String, _ project: String, state: String = "waiting-input", created: String = "2026-10-03T08:00:00.000Z",
  since: String = "2026-10-03T08:00:00.000Z", activity: String = "2026-10-03T08:00:00.000Z", extra: String = ""
) -> String {
  Frames.summary(
    id, state: state, title: project, createdAt: created, lastActivityAt: activity, stateSince: since, extra: extra)
}

private func listed(_ summaries: [String]) throws -> AppState {
  var state = AppState(clientBuild: 7)
  play(&state, [try Frames.snapshot(summaries)], at: at)
  return state
}

/// Pamięć z projektami `/Users/demo/<nazwa>` zwiniętymi.
private func collapsed(_ projects: String...) -> CollapsedProjects {
  var memory = CollapsedProjects()
  memory.set(projects.map { "/Users/demo/\($0)" }, collapsed: true)
  return memory
}

/// Agenci pod nagłówkami, w kolejności drzewa.
private func shown(_ state: AppState, _ memory: CollapsedProjects) -> [String] {
  state.projectTree(collapsed: memory, calendar: utc).compactMap {
    if case let .session(session) = $0.kind { return session.id }
    return nil
  }
}

private func headers(_ state: AppState, _ memory: CollapsedProjects) -> [ProjectTreeHeader] {
  state.projectTree(collapsed: memory, calendar: utc).compactMap {
    if case let .project(header) = $0.kind { return header }
    return nil
  }
}

private func recent(_ entries: [(String, String)]) throws -> [RecentProject] {
  let items = entries.map { #"{"cwd":"\#($0.0)","mtime":"\#($0.1)"}"# }.joined(separator: ",")
  return try JSONDecoder().decode(RecentProjectList.self, from: Data(#"{"projects":[\#(items)]}"#.utf8)).projects
}

@Suite("drzewo projektów: kolejność i skład")
struct ProjectTreeOrderTests {
  @Test("projekty jak karta PROJEKTY, agenci od najstarszego; stan agenta nie przestawia ani projektu, ani agenta")
  func ordering() throws {
    var state = try listed([
      agent("p-young", "rarog", state: "running", created: "2026-10-03T07:30:00.000Z",
            activity: "2026-10-03T09:00:00.000Z"),
      agent("p-old", "rarog", created: "2026-10-03T06:00:00.000Z", activity: "2026-10-03T08:00:00.000Z", extra: seen),
      agent("a-1", "atlas", created: "2026-10-03T07:00:00.000Z", activity: "2026-10-03T08:30:00.000Z", extra: seen),
      agent("d-1", "dawny", created: "2026-10-01T07:00:00.000Z", activity: "2026-10-01T10:00:00.000Z", extra: seen),
    ])
    state.apply(.catalog(.recentProjectsLoaded(try recent([("/Users/demo/nowy/", "2026-10-02T10:00:00.000Z")]), at: at)),
                now: at)
    // Projekt z samej historii CLI (`nowy`) nie ma nagłówka.
    let expected: [ProjectTreeID] = [
      .project("/Users/demo/atlas"), .session("a-1"),
      .project("/Users/demo/rarog"), .session("p-old"), .session("p-young"),
      .project("/Users/demo/dawny"), .session("d-1"),
    ]
    #expect(state.projectTree(collapsed: CollapsedProjects(), calendar: utc).map(\.id) == expected)
    let groups = headers(state, CollapsedProjects())
    #expect(groups.map(\.group) == state.projectGroups(calendar: utc), "nagłówki = grupy karty PROJEKTY")
    #expect(groups.map(\.total) == [1, 2, 1])
    #expect(groups.map(\.shown) == [1, 2, 1])

    // Decyzja w atlasie i nowy wynik w Rarogu tego samego dnia: płaska lista przestawia się po randze, drzewo stoi.
    play(&state, [
      try Frames.state("a-1", "waiting-permission", since: "2026-10-03T09:20:00.000Z"),
      try Frames.sessionChanged(agent("p-young", "rarog", created: "2026-10-03T07:30:00.000Z",
                                      since: "2026-10-03T09:30:00.000Z", activity: "2026-10-03T09:30:00.000Z")),
    ], at: at)
    #expect(state.listOrder.map(\.id).prefix(2) == ["a-1", "p-young"])
    #expect(state.projectTree(collapsed: CollapsedProjects(), calendar: utc).map(\.id) == expected)
  }

  @Test("dzieci = `projectSessions`: Codex w terminalu Raroga stoi w drzewie (pasek zakładek go pomija)")
  func codexInTerminal() throws {
    let state = try listed([
      agent("claude", "p", created: "2026-10-03T07:00:00.000Z"),
      agent("codex", "p", created: "2026-10-03T06:00:00.000Z", extra: #","engine":"codex","termId":"00000000000000b2""#),
    ])
    #expect(shown(state, CollapsedProjects()) == ["codex", "claude"])
    #expect(shown(state, CollapsedProjects()) == state.projectSessions("/Users/demo/p").map(\.id))
    #expect(state.projectTabs("/Users/demo/p").map(\.id) == ["claude"])
  }

  @Test("projekt spoza pamięci rozwinięty; zwinięty katalog z samej historii CLI nie ma nagłówka")
  func collapsedFlag() throws {
    var state = try listed([agent("a", "p", extra: seen), agent("b", "q", extra: seen)])
    state.apply(.catalog(.recentProjectsLoaded(try recent([("/Users/demo/pusty", "2026-10-02T10:00:00.000Z")]), at: at)),
                now: at)
    let memory = collapsed("p", "pusty")
    let byCwd = Dictionary(uniqueKeysWithValues: headers(state, memory).map { ($0.group.cwd, $0) })
    #expect(byCwd["/Users/demo/p"]?.collapsed == true && byCwd["/Users/demo/p"]?.shown == 0)
    #expect(byCwd["/Users/demo/q"]?.collapsed == false && byCwd["/Users/demo/q"]?.shown == 1, "nowy projekt rozwinięty")
    #expect(byCwd["/Users/demo/pusty"] == nil)
  }

  @Test("zamknięcie ostatniej sesji zdejmuje nagłówek z drzewa razem z jej wierszem; nowa sesja go przywraca")
  func lastSessionClosed() throws {
    var state = try listed([agent("a", "p", extra: seen), agent("b", "q", extra: seen)])
    state.apply(.catalog(.recentProjectsLoaded(try recent([("/Users/demo/p", "2026-10-03T10:00:00.000Z")]), at: at)),
                now: at)
    play(&state, [try Frames.snapshot([agent("b", "q", extra: seen)])], at: at)
    #expect(state.projectTree(collapsed: CollapsedProjects(), calendar: utc).map(\.id) == [
      .project("/Users/demo/q"), .session("b"),
    ])
    play(&state, [try Frames.sessionChanged(agent("c", "p"))], at: at)
    #expect(state.projectTree(collapsed: CollapsedProjects(), calendar: utc).map(\.id) == [
      .project("/Users/demo/p"), .session("c"), .project("/Users/demo/q"), .session("b"),
    ])
  }
}

@Suite("drzewo projektów: widoczność w zwiniętym projekcie")
struct ProjectTreeVisibilityTests {
  struct Case: Sendable, CustomTestStringConvertible {
    let state: String
    var seen = false
    var background = false
    let shown: Bool

    var testDescription: String {
      "\(state)\(seen ? " obejrzany" : "")\(background ? " + w tle" : "") → \(shown ? "widać" : "schowany")"
    }
  }

  static let cases: [Case] = [
    Case(state: "waiting-permission", shown: true),
    Case(state: "waiting-question", shown: true),
    Case(state: "waiting-input", shown: true),
    Case(state: "waiting-input", seen: true, shown: false),
    Case(state: "waiting-input", seen: true, background: true, shown: true),
    Case(state: "error", seen: true, shown: true),
    Case(state: "limit-reached", seen: true, shown: true),
    Case(state: "interrupted", seen: true, shown: true),
    Case(state: "resumable", seen: true, shown: true),
    Case(state: "running", shown: true),
    Case(state: "starting", shown: true),
    Case(state: "done", shown: false),
    Case(state: "done", background: true, shown: true),
    Case(state: "przyszly-stan", shown: false),
    Case(state: "przyszly-stan", background: true, shown: false),
  ]

  @Test("ranga uwagi i pracy (≤ 2) zostaje, cisza znika; rozwinięty pokazuje wszystkich", arguments: cases)
  func matrix(_ c: Case) throws {
    let state = try listed([agent("s", "p", state: c.state, extra: (c.seen ? seen : "") + (c.background ? background : ""))])
    let session = try #require(state.sessions["s"])
    #expect(state.treeShows(session, collapsed: true) == c.shown)
    #expect(state.treeShows(session, collapsed: false))
    #expect(shown(state, collapsed("p")) == (c.shown ? ["s"] : []))
    #expect(shown(state, CollapsedProjects()) == ["s"])
    let header = try #require(headers(state, collapsed("p")).first)
    #expect(header.collapsed && header.shown == (c.shown ? 1 : 0) && header.total == 1)
  }

  @Test("nieodebrany wynik trzymany po odczycie stoi do pełnego stanu albo zejścia apki w tło")
  func heldUnread() throws {
    let unread = agent("A", "p")
    let read = agent("A", "p", extra: seen)
    let quiet = agent("B", "p", extra: seen)
    var state = try listed([unread, quiet])
    #expect(shown(state, collapsed("p")) == ["A"])
    play(&state, [try Frames.sessionChanged(read)], at: at)
    #expect(state.sessions["A"]?.listRank == 3)
    #expect(shown(state, collapsed("p")) == ["A"], "odczyt nie chowa wiersza pod okiem")
    play(&state, [try Frames.snapshot([read, quiet])], at: at)
    #expect(shown(state, collapsed("p")) == [], "pełny stan: obejrzany wraca do ciszy")

    state = try listed([unread, quiet])
    play(&state, [try Frames.sessionChanged(read)], at: at)
    state.apply(.list(.appBackgrounded), now: at)
    #expect(shown(state, collapsed("p")) == [], "tło apki")
  }

  @Test("dane nieświeże (sesja `stale`, lista z pamięci podręcznej) nie rozwijają zwiniętego projektu")
  func staleFollowsRank() throws {
    var state = try listed([
      agent("odebrany", "p", extra: seen + #","stale":true"#),
      agent("czeka", "p", state: "waiting-permission", extra: #","stale":true"#),
    ])
    #expect(shown(state, collapsed("p")) == ["czeka"])
    state.listCache.staleSince = at
    #expect(state.listStale)
    #expect(shown(state, collapsed("p")) == ["czeka"], "reguła idzie za rangą, nie za wyciszeniem wiersza")
  }
}

@Suite("drzewo projektów: zaznaczony i ostatnio otwarty wiersz")
struct ProjectTreeHeldOpenTests {
  @Test("zaznaczony zawsze widać; zejście trzyma go w tym samym kroku — także powrót do samej listy")
  func selectionHolds() throws {
    var state = try listed([
      agent("A", "p", created: "2026-10-03T07:00:00.000Z", extra: seen),
      agent("B", "p", created: "2026-10-03T07:10:00.000Z", extra: seen),
      agent("Q", "q", state: "running"),
    ])
    let memory = collapsed("p")
    #expect(shown(state, memory) == ["Q"])
    state.apply(.list(.selected("A")), now: at)
    #expect(state.listSelection == "A" && state.heldOpen.isEmpty)
    #expect(shown(state, memory) == ["A", "Q"])
    state.apply(.list(.selected("B")), now: at)
    #expect(state.heldOpen == ["A": "2026-10-03T08:00:00.000Z"])
    #expect(shown(state, memory) == ["A", "B", "Q"])
    state.apply(.list(.selected(nil)), now: at)
    #expect(shown(state, memory) == ["A", "B", "Q"], "powrót do listy (iPhone) niczego nie chowa")
    #expect(headers(state, memory).first?.shown == 2)
  }

  @Test("tap w inny wiersz nie zmienia zbioru widocznych węzłów")
  func tapKeepsVisibleSet() throws {
    var state = try listed([
      agent("A", "p", created: "2026-10-03T07:00:00.000Z", extra: seen),
      agent("B", "p", state: "running", created: "2026-10-03T07:10:00.000Z"),
      agent("C", "q", created: "2026-10-03T07:20:00.000Z", extra: seen),
      agent("D", "q", state: "waiting-permission", created: "2026-10-03T07:30:00.000Z"),
    ])
    let memory = collapsed("p", "q")
    state.apply(.list(.selected("A")), now: at)
    let before = state.projectTree(collapsed: memory, calendar: utc).map(\.id)
    #expect(before == [.project("/Users/demo/p"), .session("A"), .session("B"), .project("/Users/demo/q"), .session("D")])
    for tap in ["B", "D", "A", "D"] {
      state.apply(.list(.selected(tap)), now: at)
      #expect(state.projectTree(collapsed: memory, calendar: utc).map(\.id) == before, "tap w \(tap)")
    }
  }

  @Test("ostatnio otwarty zwalnia: nowy stan sesji, pełny stan, tło apki i wylogowanie — nie sama aktywność")
  func releases() throws {
    let summaries = [
      agent("A", "p", created: "2026-10-03T07:00:00.000Z", extra: seen),
      agent("B", "p", created: "2026-10-03T07:10:00.000Z", extra: seen),
    ]
    let memory = collapsed("p")
    var state = try listed(summaries)
    for id in ["X", "A", "B", "Q"] { state.apply(.list(.selected(id)), now: at) }
    #expect(Set(state.heldOpen.keys) == ["A", "B"], "sesji nieznanej liście (X) nie ma czego trzymać")
    play(&state, [try Frames.activity("B", kind: "idle")], at: at)
    #expect(shown(state, memory) == ["A", "B"], "aktywność bez zmiany stanu")
    play(&state, [try Frames.state("A", "done", since: "2026-10-03T09:00:00.000Z")], at: at)
    #expect(shown(state, memory) == ["B"], "nowy stan A — cisza za ciszą")
    play(&state, [try Frames.snapshot(summaries)], at: at)
    #expect(state.heldOpen.isEmpty && shown(state, memory) == [], "pełny stan")

    for id in ["A", "B"] { state.apply(.list(.selected(id)), now: at) }
    state.apply(.list(.appBackgrounded), now: at)
    #expect(shown(state, memory) == ["B"], "tło: zostaje tylko zaznaczony")

    state.apply(.list(.selected("A")), now: at)
    state.apply(.loggedOut(.deviceUnknown), now: at)
    #expect(state.heldOpen.isEmpty)
    #expect(state.listSelection == "A", "zaznaczenie nawigacji przeżywa wylogowanie, więc lustro też")
  }

  @Test("ręczne zwinięcie albo rozwinięcie projektu zwalnia jego ostatnio otwarte; innych projektów nie rusza")
  func toggleReleases() throws {
    var state = try listed([
      agent("A", "p", extra: seen), agent("R", "r", extra: seen), agent("Q", "q", state: "running"),
    ])
    for id in ["A", "R", "Q"] { state.apply(.list(.selected(id)), now: at) }
    let memory = collapsed("p", "r")
    #expect(shown(state, memory) == ["A", "Q", "R"])
    state.apply(.list(.projectsToggled(["/Users/demo/p/"])), now: at)
    #expect(shown(state, memory) == ["Q", "R"], "p zwolniony (ukośnik na końcu to ten sam projekt), r trzymany")
    state.apply(.list(.projectsToggled(["/Users/demo/q", "/Users/demo/r"])), now: at)
    #expect(state.heldOpen.isEmpty && shown(state, memory) == ["Q"])
  }
}

@MainActor
@Suite("magazyn: zaznaczenie listy i zwinięcie projektów")
struct ProjectTreeStoreTests {
  @Test("`selectListRow` trzyma poprzedni wiersz; `projectsToggled` i zejście w tło go zwalniają")
  func storeEvents() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"""
      {"type":"sessions-snapshot","sessions":[\#(agent("A", "p", extra: seen)),\#(agent("B", "p", extra: seen))]}
      """#)
    await until("lista") { store.state.sessionsLoaded }
    store.selectListRow("A")
    store.selectListRow("B")
    #expect(store.state.listSelection == "B" && Array(store.state.heldOpen.keys) == ["A"])
    store.projectsToggled(["/Users/demo/p"])
    #expect(store.state.heldOpen.isEmpty)
    store.selectListRow("A")
    #expect(Array(store.state.heldOpen.keys) == ["B"])
    store.setScenePhase(.background)
    #expect(store.state.heldOpen.isEmpty && store.state.listSelection == "A")
  }
}
