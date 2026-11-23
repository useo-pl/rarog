import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Tree rows of the list under a filter segment: the header's spoken value, the empty segment's row, and the held rows
// kept by the navigation. Owner: list.

private let willow = "/Users/demo/Projects/willow"

/// willow: waiting for a permission, done, a read result; rarog works.
@MainActor
private func state() -> AppState {
  var state = AppState(clientBuild: 1)
  let sessions = [
    Sample.session(id: "v-ask", title: "willow", label: "zapis", state: "waiting-permission", createdAgo: 9000),
    Sample.session(id: "v-done", title: "willow", label: "parser dat", state: "done", createdAgo: 6000),
    Sample.session(id: "v-read", title: "willow", label: "testy", state: "waiting-input", extra: #""seen":true"#,
                   createdAgo: 3000),
    Sample.session(id: "p1", title: "rarog", label: "resync", state: "running", createdAgo: 600),
  ]
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  return state
}

@MainActor
private func rows(_ state: AppState, _ navigation: RarogNavigation) -> [ProjectTreeRow] {
  navigation.treeRows(state, openCwd: nil, jumpCwd: nil)
}

@MainActor
@Suite("project tree rows: filter segments")
struct ProjectTreeRowsFilterTests {
  @Test("a collapsed project with mixed states under a filter speaks the filtered rows")
  func spokenValueUnderFilter() throws {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setProjectsCollapsed([willow], collapsed: true)
    let state = state()
    navigation.selectListFilter(.needsYou, state: state)
    let tree = rows(state, navigation)
    #expect(tree.map(\.id) == [.project(willow), .session("v-ask")])
    let header = try #require(tree.header(willow))
    #expect(header.spokenValue == UICopy.treeCollapsedValue(shown: 1, total: 3))
    navigation.setProjectsCollapsed([willow], collapsed: false)
    #expect(try #require(rows(state, navigation).header(willow)).spokenValue == UICopy.treeExpandedValue)
  }

  @Test("an empty segment starts with its sentence row; the row has no guide and the header under it its breath")
  func emptySegmentRow() throws {
    var state = state()
    state.sessions["p1"] = nil
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.selectListFilter(.working, state: state)
    #expect(rows(state, navigation).map(\.id) == [.emptyFilter])
    state.apply(.list(.selected("v-read")), now: Sample.now)
    let tree = rows(state, navigation)
    #expect(tree.map(\.id) == [.emptyFilter, .project(willow), .session("v-read")])
    let layout = ProjectTreeRowLayout.layout(tree)
    #expect(layout[0] == ProjectTreeRowLayout())
    #expect(layout[1].gapAbove == SessionListMetrics.projectGap)
    #expect(UICopy.listFilterEmpty(.working) != nil && UICopy.listFilterEmpty(.all) == nil)
  }

  @Test("All gives the same rows as before the filter existed")
  func allUnchanged() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let state = state()
    #expect(navigation.listFilter == .all)
    #expect(rows(state, navigation) == state.projectTreeRows(collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil))
  }

  @Test("a row that leaves the segment stands until another segment, a tap on the active one or the background")
  func heldRows() {
    var state = state()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.selectListFilter(.working, state: state)
    #expect(navigation.listFilterHeld == ["p1"])
    func finish() {
      state.sessions["p1"] = Sample.session(
        id: "p1", title: "rarog", label: "resync", state: "waiting-input", createdAgo: 600)
    }
    func work() {
      state.sessions["p1"] = Sample.session(id: "p1", title: "rarog", label: "resync", state: "running", createdAgo: 600)
    }
    finish()
    #expect(rows(state, navigation).contains { $0.id == .session("p1") }, "the finished agent stays under the finger")

    navigation.selectListFilter(.needsYou, state: state)
    navigation.selectListFilter(.working, state: state)
    #expect(rows(state, navigation).map(\.id) == [.emptyFilter], "a new segment choice lets it go")

    work()
    navigation.noteListFilterShown(state.listFilterMembers(.working))
    finish()
    navigation.selectListFilter(.working, state: state)
    #expect(!rows(state, navigation).contains { $0.id == .session("p1") }, "a tap on the active segment refreshes")

    work()
    navigation.noteListFilterShown(state.listFilterMembers(.working))
    finish()
    navigation.releaseListFilterHeld(state)
    #expect(!rows(state, navigation).contains { $0.id == .session("p1") }, "the background lets it go")
  }

  @Test("All holds nothing")
  func allHoldsNothing() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let state = state()
    navigation.noteListFilterShown(["p1"])
    navigation.selectListFilter(.all, state: state)
    #expect(navigation.listFilterHeld.isEmpty)
  }
}
