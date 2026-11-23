import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The session switcher under Cmd+S: the snapshot of recently visited
// sessions, the rows with their digit keys and the heading of the window. Owner: shortcuts.

@MainActor
@Suite("session switcher: snapshot, order and rows")
struct SessionSwitcherRowsTests {
  /// A state with sessions `ids`, any state each.
  private func state(_ ids: [String]) -> AppState {
    var state = Sample.state(session: Sample.session(id: ids[0]))
    for id in ids.dropFirst() { state.sessions[id] = Sample.session(id: id, state: "done") }
    return state
  }

  /// The snapshot as the host builds it: navigation with these visits (oldest first), then the window's function.
  private func snapshot(visits: [String], current: String?, state: AppState) -> [String] {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    for id in visits { navigation.selectSession(id); navigation.noteSessionVisit(state) }
    return SwitcherRows.snapshot(
      current: current, recent: navigation.recentSessions(state, limit: SwitcherRows.limit + 1), state: state)
  }

  @Test("snapshot: the current session on top, then the visited ones newest first, any state")
  func currentOnTop() {
    let all = state(["a", "b", "cur"])
    let order = snapshot(visits: ["a", "b", "cur"], current: "cur", state: all)
    #expect(order == ["cur", "b", "a"])
  }

  @Test("snapshot: the current session lower in the history goes on top without a duplicate")
  func currentLower() {
    let all = state(["a", "b", "cur"])
    #expect(SwitcherRows.snapshot(current: "cur", recent: ["b", "cur", "a"], state: all) == ["cur", "b", "a"])
  }

  @Test("snapshot: a current session the app does not know is not a row; ten other rows instead")
  func unknownCurrent() {
    let ids = (0..<12).map { "s\($0)" }
    let all = state(ids)
    let order = snapshot(visits: ids, current: "ghost", state: all)
    #expect(order.count == 10 && !order.contains("ghost"))
    #expect(order.first == "s11" && order.last == "s2")
  }

  @Test("snapshot: eleven visited sessions give ten rows, the current one counted among them")
  func limit() {
    let ids = (0..<11).map { "s\($0)" }
    let all = state(ids)
    let order = snapshot(visits: ids, current: "s10", state: all)
    #expect(order == ["s10", "s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1"])
    let older = snapshot(visits: ids, current: "s0", state: all)
    #expect(older.count == 10 && older.first == "s0" && !older.contains("s1"), "the oldest visit falls out, not cur")
  }

  @Test("snapshot: a deleted session leaves room for the next older one")
  func deletedSession() {
    var all = state((0..<12).map { "s\($0)" })
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    for id in all.sessions.keys.sorted(by: { Int($0.dropFirst())! < Int($1.dropFirst())! }) {
      navigation.selectSession(id)
      navigation.noteSessionVisit(all)
    }
    all.sessions["s10"] = nil
    let order = SwitcherRows.snapshot(
      current: nil, recent: navigation.recentSessions(all, limit: SwitcherRows.limit + 1), state: all)
    #expect(order == ["s11", "s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1"])
  }

  @Test("snapshot: nothing visited and nothing on screen — an empty window")
  func empty() {
    #expect(SwitcherRows.snapshot(current: nil, recent: [], state: AppState(clientBuild: 1)).isEmpty)
  }

  @Test("digit keys: row N shows N for rows 0–9, a blank of the same width after them, nothing without the keyboard")
  func digitKeys() {
    #expect((0..<10).map { SwitcherRows.digitKey(at: $0, keyboard: true) } == (0..<10).map { .digit($0) })
    #expect(SwitcherRows.digitKey(at: 10, keyboard: true) == .blank, "past nine: the room stays, the dots in a column")
    #expect(SwitcherRows.digitKey(at: 0, keyboard: false) == .none, "a window without the keyboard: rows as before")
    #expect(SwitcherRows.digitKey(at: 12, keyboard: false) == .none)
    #expect(SwitcherRows.limit <= 10, "every row of the window has its digit")
  }

  @Test("rows: the order from the snapshot, the content live; a removed session is gone")
  func rows() {
    var state = Sample.state(session: Sample.session(id: "tu", title: "rarog", label: "przełącznik", state: "running"))
    state.sessions["zgoda"] = Sample.session(id: "zgoda", title: "willow", label: "zapis", state: "waiting-permission")
    state.sessions["cicha"] = Sample.session(id: "cicha", title: "willow", label: "zapis", state: "done")
    let order = ["tu", "zgoda", "cicha", "usunieta"]
    let before = SwitcherRows.rows(order: order, state: state, current: "tu")
    #expect(before.map(\.id) == ["tu", "zgoda", "cicha"])
    #expect(before.map(\.isCurrent) == [true, false, false])
    #expect(before[1].row.status.tone == .waiting && before[1].row.status.text == UICopy.stateLabel(.waitingPermission))
    // Two sessions with the same title get a number, like on the list.
    #expect(before[1].row.ordinal != nil && before[2].row.ordinal != nil && before[0].row.ordinal == nil)

    state.sessions["zgoda"] = Sample.session(id: "zgoda", title: "willow", label: "zapis", state: "running")
    let after = SwitcherRows.rows(order: order, state: state, current: "tu")
    #expect(after.map(\.id) == ["tu", "zgoda", "cicha"])
    #expect(after[1].row.status.tone == .working, "the word and the dot are live")
  }

  @Test("heading: Ostatnie · N")
  func heading() {
    #expect(UICopy.switcherHeading(6) == "Ostatnie · 6")
    #expect(UICopy.switcherHints.map(\.key) == ["↑↓", "↩", "0–9", "esc"])
    #expect(UICopy.switcherHints.map(\.action) == ["wybierz", "przejdź", "skocz", "zamknij"])
  }
}
