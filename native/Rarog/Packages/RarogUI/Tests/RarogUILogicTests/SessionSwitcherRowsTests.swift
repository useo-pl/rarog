import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The session switcher window: its rows are the tabs of the current project in the order of the bar (sessions from
// the oldest, then terminals), read from the same list the bar draws. Owner: shortcuts.

private let willow = "/Users/demo/Projects/willow"
private let zsh = "00000000000000a1"
private let lazygit = "00000000000000b2"

private func entry(_ id: String, slot: Int, proc: String) -> TerminalListEntry {
  Sample.decode(TerminalListEntry.self, #"""
    {"id":"\#(id)","cwd":"\#(willow)","live":true,"slot":\#(slot),"proc":"\#(proc)","role":"shell"}
    """#)
}

/// Project willow: sessions a (the oldest), b, c, terminals zsh (slot 1) and lazygit (slot 2); `extra` sessions on
/// top, `terminals` instead of the two.
@MainActor
func switcherProject(
  extra: [SessionSummary] = [], terminals: [TerminalListEntry]? = nil, sessionIds: [String] = ["a", "b", "c"]
) -> AppState {
  var state = AppState(clientBuild: 1)
  for (index, id) in sessionIds.enumerated() {
    let session = Sample.session(
      id: id, title: "willow", label: "tab \(id)", createdAgo: TimeInterval(9000 - index * 100))
    state.sessions[id] = session
  }
  for session in extra { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  state.capabilities = Capabilities(
    Sample.decode(VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s","termEnabled":true}"#))
  let list = terminals ?? [entry(lazygit, slot: 2, proc: "lazygit"), entry(zsh, slot: 1, proc: "zsh")]
  _ = state.apply(.terminals(.loaded(list, at: Sample.now)), now: Sample.now)
  return state
}

@MainActor
@Suite("session switcher: rows are the tabs of the project")
struct SessionSwitcherRowsTests {
  private func navigation(_ state: AppState, on tab: ProjectTabRef) -> RarogNavigation {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.open(tab, state: state)
    return navigation
  }

  private func rows(_ state: AppState, _ navigation: RarogNavigation) -> [SwitcherRow] {
    SwitcherRows.rows(tabs: navigation.stripTabs(state), state: state)
  }

  /// The machine opened as a tap on the current tab opens it.
  private func opened(_ state: AppState, _ navigation: RarogNavigation, keyboard: Bool = true) -> SwitcherMachine {
    var machine = SwitcherMachine()
    _ = machine.openByTap(
      keyboard: keyboard, tabs: navigation.tabRefs(state), current: navigation.currentTab(state), at: 0)
    return machine
  }

  @Test("sessions a, b, c and terminals zsh, lazygit, current b: rows in the bar's order, b selected")
  func barOrder() {
    let state = switcherProject()
    let nav = navigation(state, on: .session("b"))
    let rows = rows(state, nav)
    #expect(rows.map(\.tab) == [.session("a"), .session("b"), .session("c"), .terminal(zsh), .terminal(lazygit)])
    #expect(rows.map(\.key) == ["a", "b", "c", "term.\(zsh)", "term.\(lazygit)"], "the bar's identities")
    #expect(rows.map(\.isCurrent) == [false, true, false, false, false])
    let machine = opened(state, nav)
    #expect(machine.isOpen && machine.selected == .session("b") && machine.order == rows.map(\.tab))
  }

  @Test("a terminal row: the tab label, a quiet line, the terminal's sentence; a session row keeps its state")
  func terminalRow() throws {
    let state = switcherProject()
    let rows = rows(state, navigation(state, on: .terminal(zsh)))
    let terminal = try #require(rows.first { $0.tab == .terminal(zsh) })
    #expect(terminal.content == .terminal(
      label: "zsh", detail: "\(UICopy.terminalSlotName(1)), \(UICopy.terminalRunning)",
      spoken: UICopy.terminalTabSpoken(entry(zsh, slot: 1, proc: "zsh"), current: true)))
    #expect(terminal.spoken(now: Sample.now).hasSuffix(", \(UICopy.switcherHere)"), "the current tab")
    #expect(rows.first?.session?.status.tone == .working, "a session row keeps its state")
  }

  @Test("current terminal zsh, also with an agent inside: zsh selected; the agent has no row of its own")
  func currentTerminal() {
    let state = switcherProject()
    #expect(opened(state, navigation(state, on: .terminal(zsh))).selected == .terminal(zsh))

    let agent = Sample.session(
      id: "agent", title: "willow", label: "claude", extra: #""termId":"\#(zsh)""#, createdAgo: 50)
    let hosted = switcherProject(extra: [agent])
    let nav = RarogNavigation(prefs: MemoryPreferences())
    nav.selectSession("agent")
    #expect(nav.currentTab(hosted) == .terminal(zsh), "the agent's entry stands on its terminal's tab")
    let machine = opened(hosted, nav)
    #expect(machine.selected == .terminal(zsh))
    #expect(!machine.order.contains(.session("agent")))
  }

  @Test("a project with one tab: one row, the current one")
  func oneTab() {
    let state = switcherProject(terminals: [], sessionIds: ["solo"])
    let nav = navigation(state, on: .session("solo"))
    let rows = rows(state, nav)
    #expect(rows.map(\.tab) == [.session("solo")] && rows[0].isCurrent, "the invite is no row")
    #expect(opened(state, nav).selected == .session("solo"))
  }

  @Test("12 tabs, the eleventh current: 12 rows, the eleventh selected")
  func twelveTabs() {
    let ids = (1...10).map { "s\($0)" }
    let state = switcherProject(sessionIds: ids)
    let nav = navigation(state, on: .terminal(zsh))
    let rows = rows(state, nav)
    #expect(rows.count == 12 && rows[10].tab == .terminal(zsh))
    #expect(opened(state, nav).selected == .terminal(zsh))
    #expect(nav.tabRefs(state) == rows.map(\.tab), "the window and the bar have one list")
  }

  @Test("the invite and a terminal being opened are no rows; a tap on the opening tab opens no window")
  func noTargetNoRow() {
    let bare = switcherProject(terminals: [])
    let onSession = navigation(bare, on: .session("a"))
    #expect(onSession.stripTabs(bare).contains { $0.kind == .invite(enabled: true) })
    #expect(rows(bare, onSession).map(\.tab) == [.session("a"), .session("b"), .session("c")])
    #expect(onSession.stripTabs(bare).first { $0.current }?.tap == .switcher)

    let state = switcherProject()
    let opening = RarogNavigation(prefs: MemoryPreferences())
    opening.openTerminal(.next, in: willow, state: state)
    let current = opening.stripTabs(state).first { $0.current }
    #expect(current?.target == nil && current?.tap == ProjectTabModel.Tap.none, "the opening tab: no window")
    #expect(!rows(state, opening).contains { $0.isCurrent }, "the opening terminal is no row")
    var machine = SwitcherMachine()
    #expect(machine.openByTap(keyboard: true, tabs: opening.tabRefs(state), current: opening.currentTab(state), at: 0)
      == [])
    #expect(!machine.isOpen, "no current tab: the window stays shut")
  }

  @Test("rows carry the session title without the project, terminals their label; VoiceOver hears the same")
  func titlesWithoutProject() throws {
    let state = switcherProject()
    let rows = rows(state, navigation(state, on: .session("b")))
    #expect(rows.map(\.title) == ["tab a", "tab b", "tab c", "zsh", "lazygit"])
    let spoken = rows[0].spoken(now: Sample.now)
    #expect(spoken.hasPrefix("tab a, "), "\(spoken)")
    #expect(!rows.contains { $0.spoken(now: Sample.now).contains("willow") }, "no project in a row's sentence")

    let unnamed = Sample.session(id: "d00d", title: "willow", label: nil, createdAgo: 10)
    let bare = switcherProject(extra: [unnamed])
    let row = try #require(self.rows(bare, navigation(bare, on: .session("d00d"))).first { $0.tab == .session("d00d") })
    #expect(row.title == "#d00d", "a session without a name: the tab's short id, never an empty row")
  }

  @Test("heading: the project once, then Zakładki projektu · N; the footer without digits")
  func heading() {
    let state = switcherProject()
    let nav = navigation(state, on: .session("b"))
    let heading = SwitcherRows.heading(cwd: nav.currentProjectCwd(state), count: 5)
    #expect(heading.project == "willow" && heading.tabs == "Zakładki projektu · 5")
    #expect(heading.text == "willow · Zakładki projektu · 5")
    #expect(SwitcherRows.heading(cwd: nil, count: 5).text == "Zakładki projektu · 5", "no project: the count alone")
    #expect(heading.label == "willow, Zakładki projektu", "VoiceOver hears the project once, in the window's name")
    #expect(SwitcherRows.heading(cwd: nil, count: 5).label == "Zakładki projektu")
    #expect(UICopy.switcherHints.map(\.key) == ["↑↓", "↩", "esc"])
    #expect(UICopy.switcherHints.map(\.action) == ["wybierz", "przejdź", "zamknij"])
  }
}
