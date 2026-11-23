import Foundation
import RarogContract
@testable import RarogCore
import Testing

// The list filter as a parameter of the project tree: segment membership and counts, the rows a segment shows, the
// held rows and the selected row, empty segments. Owner: list.

private let at = Date(timeIntervalSince1970: 1_790_000_000)
private let seen = #","seen":true"#
private let background = #","backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test"}]"#

private let utc: Calendar = {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  return calendar
}()

/// An agent in `/Users/demo/<project>`; `minute` orders agents by age inside a project.
private func agent(_ id: String, _ project: String, state: String, minute: Int, extra: String = "") -> String {
  let created = String(format: "2026-10-03T07:%02d:00.000Z", minute)
  return Frames.summary(
    id, state: state, title: project, createdAt: created, lastActivityAt: "2026-10-03T08:00:00.000Z",
    stateSince: "2026-10-03T08:00:00.000Z", extra: extra)
}

private func listed(_ summaries: [String]) throws -> AppState {
  var state = AppState(clientBuild: 7)
  play(&state, [try Frames.snapshot(summaries)], at: at)
  return state
}

private func collapsed(_ projects: String...) -> CollapsedProjects {
  var memory = CollapsedProjects()
  memory.set(projects.map { "/Users/demo/\($0)" }, collapsed: true)
  return memory
}

/// A waiting, B running, C unread result, D read result, E error, F done, G unread result with a working background
/// task — all in one project, oldest first.
private func sevenStates(project: String = "p") -> [String] {
  [
    agent("A", project, state: "waiting-permission", minute: 1),
    agent("B", project, state: "running", minute: 2),
    agent("C", project, state: "waiting-input", minute: 3),
    agent("D", project, state: "waiting-input", minute: 4, extra: seen),
    agent("E", project, state: "error", minute: 5),
    agent("F", project, state: "done", minute: 6),
    agent("G", project, state: "waiting-input", minute: 7, extra: background),
  ]
}

private func tree(
  _ state: AppState, _ filter: ListFilter, held: Set<String> = [], collapsed: CollapsedProjects = CollapsedProjects()
) -> [ProjectTreeNode] {
  state.projectTree(collapsed: collapsed, filter: filter, held: held, calendar: utc)
}

private func sessionIds(_ nodes: [ProjectTreeNode]) -> [String] {
  nodes.compactMap {
    if case let .session(session) = $0.kind { return session.id }
    return nil
  }
}

@Suite("project tree filter: membership and counts")
struct ProjectTreeFilterCountTests {
  @Test("counts come from the dot's tone over every session")
  func counts() throws {
    let state = try listed(sevenStates())
    #expect(state.listFilterCount(.all) == 7)
    #expect(state.listFilterCount(.needsYou) == 2)
    #expect(state.listFilterCount(.working) == 2)
    #expect(state.listFilterCount(.unread) == 1)
    #expect(state.listFilterMembers(.needsYou) == ["A", "E"], "an unread result belongs to Unread only")
    #expect(state.listFilterMembers(.working) == ["B", "G"], "an unread result with a working task counts as work")
    #expect(state.listFilterMembers(.unread) == ["C"])
  }

  @Test("Unread holds only a fresh result (a pulsing dot): one marked unread by hand is in no segment but All")
  func unreadOnlyFresh() throws {
    let state = try listed([
      agent("C", "p", state: "waiting-input", minute: 1),
      agent("M", "p", state: "waiting-input", minute: 2, extra: #","markedUnseen":true"#),
    ])
    #expect(state.listFilterMembers(.unread) == ["C"])
    #expect(state.listFilterMembers(.needsYou).isEmpty)
    #expect(state.listFilterCount(.all) == 2)
  }

  @Test("a frozen result (the session's source is stale) has a still dot, so it is not in Unread")
  func unreadNotFrozen() throws {
    let state = try listed([
      agent("C", "p", state: "waiting-input", minute: 1),
      agent("S", "p", state: "waiting-input", minute: 2, extra: #","stale":true"#),
    ])
    #expect(state.listFilterMembers(.unread) == ["C"])
    #expect(!state.freshResult(try #require(state.sessions["S"])))
  }

  @Test("counts include sessions in collapsed projects")
  func countsIgnoreCollapse() throws {
    let state = try listed(sevenStates())
    #expect(sessionIds(tree(state, .needsYou, collapsed: collapsed("p"))) == ["A", "E"])
    #expect(state.listFilterCount(.needsYou) == 2)
  }
}

@Suite("project tree filter: rows")
struct ProjectTreeFilterRowsTests {
  @Test("All gives the same rows as the tree without a filter")
  func allIsUnchanged() throws {
    var state = try listed(sevenStates() + [agent("Q", "q", state: "done", minute: 8, extra: seen)])
    state.apply(.list(.selected("D")), now: at)
    for memory in [CollapsedProjects(), collapsed("p"), collapsed("q"), collapsed("p", "q")] {
      let plain = state.projectTree(collapsed: memory, calendar: utc)
      #expect(tree(state, .all, held: ["F", "Q"], collapsed: memory) == plain)
    }
  }

  @Test("a header stands only over a project with a visible row; the order stays")
  func headersOnlyOverShownRows() throws {
    let state = try listed(
      sevenStates()
        + [
          agent("quiet-read", "quiet", state: "waiting-input", minute: 8, extra: seen),
          agent("quiet-done", "quiet", state: "done", minute: 9),
        ])
    let all = state.projectTree(collapsed: CollapsedProjects(), calendar: utc).map(\.id)
    let filtered = tree(state, .needsYou).map(\.id)
    #expect(filtered == [.project("/Users/demo/p"), .session("A"), .session("E")])
    #expect(all.filter(filtered.contains) == filtered, "the filter keeps the tree's order")
    let header = try #require(tree(state, .needsYou).first.flatMap {
      if case let .project(header) = $0.kind { return header }
      return nil
    })
    #expect(header.shown == 2 && header.total == 7 && !header.collapsed)
  }

  @Test("the selected row stands under the filter; recently opened rows do not")
  func selectionNotHeldOpen() throws {
    var state = try listed(
      sevenStates()
        + [
          agent("X", "q", state: "waiting-input", minute: 10, extra: seen),
          agent("Y", "q", state: "waiting-input", minute: 11, extra: seen),
          agent("Z", "q", state: "done", minute: 12),
        ])
    state.apply(.list(.selected("D")), now: at)
    #expect(sessionIds(tree(state, .working)) == ["B", "D", "G"])
    for id in ["X", "Y", "Z", "D"] { state.apply(.list(.selected(id)), now: at) }
    #expect(Set(state.heldOpen.keys).isSuperset(of: ["X", "Y", "Z"]))
    #expect(sessionIds(tree(state, .working)) == ["B", "D", "G"])
  }

  @Test("a row that left the segment stands while it is held")
  func heldRowStands() throws {
    var state = try listed(sevenStates())
    #expect(sessionIds(tree(state, .working)) == ["B", "G"])
    play(&state, [try Frames.sessionChanged(agent("B", "p", state: "waiting-input", minute: 2))], at: at)
    #expect(sessionIds(tree(state, .working, held: ["B", "G"])) == ["B", "G"])
    #expect(sessionIds(tree(state, .working)) == ["G"], "a new segment choice starts with an empty held set")
  }

  @Test("an empty segment gives its notice first, then the selected row")
  func emptySegment() throws {
    var state = try listed([
      agent("D", "p", state: "waiting-input", minute: 1, extra: seen),
      agent("F", "p", state: "done", minute: 2),
    ])
    state.apply(.list(.selected("D")), now: at)
    let nodes = tree(state, .unread)
    #expect(nodes.map(\.id) == [.emptyFilter, .project("/Users/demo/p"), .session("D")])
    #expect(nodes.first?.kind == .emptyFilter(.unread))
    state.apply(.list(.selected(nil)), now: at)
    #expect(tree(state, .unread).map(\.id) == [.emptyFilter])
    #expect(tree(state, .all).first?.id == .project("/Users/demo/p"), "All never shows the notice")
  }

  @Test("a held row alone does not fill the segment: the notice stands over it")
  func heldRowUnderNotice() throws {
    let state = try listed([agent("B", "p", state: "waiting-input", minute: 1)])
    #expect(tree(state, .working, held: ["B"]).map(\.id) == [.emptyFilter, .project("/Users/demo/p"), .session("B")])
  }

  @Test("a collapsed project shows only segment rows; shown counts the filtered rows")
  func collapsedProject() throws {
    let state = try listed([
      agent("A", "p", state: "waiting-permission", minute: 1),
      agent("D", "p", state: "waiting-input", minute: 2, extra: seen),
    ])
    let nodes = tree(state, .needsYou, collapsed: collapsed("p"))
    #expect(sessionIds(nodes) == ["A"])
    guard case let .project(header) = nodes.first?.kind else {
      Issue.record("no header")
      return
    }
    #expect(header.collapsed && header.shown == 1 && header.total == 2)
  }
}
