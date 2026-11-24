import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The "×" of the current session tab and the card under the tab bar while it is armed. Owner: projects and tabs.

private let project = "/Users/demo/Projects/willow"

/// One project with a running session `run`, a finished one `done` and a Codex entry `cx`.
private func standing() -> AppState {
  var state = AppState(clientBuild: 1)
  for session in [
    Sample.session(id: "run", title: "willow", label: "parser", state: "running", createdAgo: 900),
    Sample.session(id: "done", title: "willow", label: "notes", state: "done", createdAgo: 600),
    Sample.session(id: "cx", title: "willow", label: "codex", state: "running", extra: #""engine":"codex""#,
                   createdAgo: 300),
  ] {
    state.sessions[session.id] = session
  }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  return state
}

/// A shell in slot 1 of the project.
private let shell = "00000000000000a1"

/// The same project with the terminal on and its shell on the terminal list.
private func terminals() -> AppState {
  var state = standing()
  state.capabilities = Capabilities(Sample.decode(
    VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s","termEnabled":true}"#))
  let entry = Sample.decode(TerminalListEntry.self, #"""
    {"id":"\#(shell)","cwd":"\#(project)","live":true,"slot":1,"proc":"zsh","role":"shell"}
    """#)
  _ = state.apply(.terminals(.loaded([entry], at: Sample.now)), now: Sample.now)
  return state
}

@MainActor
@Suite("current tab “×” and the arming card")
struct TabCloseTests {
  @Test("only the current tab has the “×” place: a session or a terminal, also one being opened; siblings have none")
  func closePlaceIsTheCurrentTab() {
    let state = standing()
    let tabs = state.projectTabModels(cwd: project, current: .session("run"))
    #expect(tabs.filter { $0.closes }.map { $0.id } == ["run"], "\(tabs.map { ($0.id, $0.closes) })")
    // The terminal the human stands in is on the bar also before the terminal list knows it.
    let onTerminal = state.projectTabModels(cwd: project, current: .terminal("t1"))
    #expect(onTerminal.filter { $0.closes }.map { $0.id } == ["term.t1"], "\(onTerminal.map { ($0.id, $0.closes) })")
    // "New Terminal" before the server's answer: the tab without an id is the current one and carries the "×".
    let opening = state.projectTabModels(cwd: project, current: nil, opening: true)
    #expect(opening.filter { $0.closes }.map { $0.id } == ["terminal-opening"], "\(opening.map { ($0.id, $0.closes) })")
  }

  @Test("the “×” says its effect; armed, it asks first; a finished session removes the card")
  func labelSaysTheEffect() throws {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("run")
    let idle = try #require(navigation.tabClose(state))
    #expect(idle == TabCloseModel(tab: .session("run"), glyph: .idle, label: "Zamknij panel w herdr"))
    #expect(idle.accessibilityId == "header.close")
    #expect(idle.spoken == "Zamknij panel w herdr" && idle.acts)
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    let armed = try #require(navigation.tabClose(state))
    #expect(armed.glyph == .armed && armed.acts)
    #expect(armed.spoken.hasPrefix("Na pewno?") && armed.spoken.contains("Zamknij panel w herdr"), "\(armed.spoken)")
    navigation.detail = .session("done")
    #expect(navigation.tabClose(state)?.label == "Usuń z listy")
  }

  @Test("the list from the cache and a session the app cannot close: a dimmed “×” in the same place, no action")
  func dimmedWithoutAction() throws {
    var state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("cx")
    let codex = try #require(navigation.tabClose(state), "the place stays for a session the app cannot close")
    #expect(codex.glyph == .dimmed && !codex.acts)
    navigation.detail = .session("run")
    state.listCache.staleSince = Sample.now
    let cached = try #require(navigation.tabClose(state))
    #expect(cached.glyph == .dimmed && !cached.acts)
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .unavailable, "no arming from the cache")
    #expect(state.projectTabModels(cwd: project, current: .session("run")).first { $0.id == "run" }?.closes == true)
  }

  @Test("no “×” away from a session or terminal tab: a project without a session, the Inbox, the list")
  func noCloseAwayFromTabs() {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.tabClose(state) == nil)
    for detail: RarogNavigation.Detail in [.project(project), .inbox] {
      navigation.detail = detail
      #expect(navigation.tabClose(state) == nil, "\(detail)")
      #expect(navigation.closeArmCard(state, terminal: .armed(until: Sample.now)) == nil, "\(detail)")
    }
  }

  @Test("a terminal route's “×”: Close Terminal, the glyph from the screen; an agent inside it and an opening run it")
  func terminalRouteClose() throws {
    var state = terminals()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .terminal(shell)
    let idle = try #require(navigation.tabClose(state, terminal: .idle))
    #expect(idle == TabCloseModel(tab: .terminal(shell), glyph: .idle, label: "Zamknij terminal"))
    #expect(idle.sessionId == nil && idle.acts && idle.accessibilityId == "terminal.close")
    let armed = try #require(navigation.tabClose(state, terminal: .armed(until: Sample.now)))
    #expect(armed.glyph == .armed && armed.spoken.hasPrefix("Na pewno?") && armed.spoken.contains("Zamknij terminal"))
    #expect(navigation.tabClose(state, terminal: .closing)?.glyph == .closing)
    // The screen is not attached yet: the place stays, the "×" is dimmed.
    let detached = try #require(navigation.tabClose(state))
    #expect(detached.glyph == .dimmed && !detached.acts)
    let tabs = state.projectTabModels(cwd: project, current: navigation.currentTab(state))
    let tab = try #require(tabs.first { $0.current })
    #expect(idle.stands(in: tab), "the “×” stands in the current terminal tab")

    // An agent (Claude, Codex) in the Rarog terminal: its entry is on screen, the "×" is the terminal's.
    for engine in ["claude", "codex"] {
      state.sessions["hosted"] = Sample.session(
        id: "hosted", title: "willow", state: "running", extra: #""engine":"\#(engine)","termId":"\#(shell)""#)
      navigation.detail = .session("hosted")
      let hosted = try #require(navigation.tabClose(state, terminal: .idle), "\(engine)")
      #expect(hosted.tab == .terminal(shell) && hosted.label == "Zamknij terminal", "\(engine)")
    }

    // "New Terminal" before the server's answer: the tab without an id carries the "×", which abandons the opening.
    navigation.detail = .openingTerminal(TerminalOpening(cwd: project, slot: .next))
    let opening = try #require(navigation.tabClose(state, terminal: .idle))
    #expect(opening.tab == nil && opening.label == "Zamknij terminal")
    let openingTabs = state.projectTabModels(cwd: project, current: navigation.currentTab(state), opening: true)
    let openingTab = try #require(openingTabs.first { $0.current })
    #expect(opening.stands(in: openingTab))
  }

  @Test("the terminal's arming card: the shell's sentence, the arming as identity, gone when the screen disarms")
  func terminalArmingCard() throws {
    let state = terminals()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.announce = { _ in }
    navigation.detail = .terminal(shell)
    for quiet in [TerminalCloseState.detached, .idle, .closing] {
      #expect(navigation.closeArmCard(state, terminal: quiet) == nil, "\(quiet)")
    }
    let until = Sample.now.addingTimeInterval(5)
    let card = try #require(navigation.closeArmCard(state, terminal: .armed(until: until)))
    #expect(card.text == "Zamknij terminal — naciśnij jeszcze raz, powłoka na Macu się zakończy")
    #expect(card.arm == .terminal(shell, until: until))
    #expect(navigation.closeArmCard(state, terminal: .armed(until: until.addingTimeInterval(1))) != card,
            "a new arming is a new card")
    navigation.post("Terminal jest wyłączony na serwerze.")
    #expect(navigation.closeArmCard(state, terminal: .armed(until: until)) == nil, "the error notice wins")
  }

  @Test("the terminal's “×” stands in the corner only without a project directory: no tab bar there")
  func terminalCloseInCornerOnlyWithoutBar() {
    let state = terminals()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .terminal(shell)
    #expect(!navigation.terminalCloseInCorner(state), "a known project: the tab bar carries the “×”")
    // A terminal opened from a link before the list knows it: no directory, so no bar.
    navigation.detail = .terminal("0123456789abcdef")
    #expect(navigation.currentProjectCwd(state) == nil)
    #expect(navigation.terminalCloseInCorner(state))
    navigation.detail = .session("run")
    #expect(!navigation.terminalCloseInCorner(state), "a session screen has no terminal “×”")
  }

  @Test("the card follows the arming: the sentence by state, gone on disarm, confirm and screen change")
  func cardFollowsArming() throws {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("run")
    #expect(navigation.closeArmCard(state) == nil)
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    let card = try #require(navigation.closeArmCard(state))
    #expect(card.text == "Potwierdź zamknięcie panelu drugim naciśnięciem.")
    #expect(card.arm == .session(try #require(navigation.closeArm)))
    navigation.disarmClose()
    #expect(navigation.closeArmCard(state) == nil, "disarmed: 5 s, the message field, the scene in the background")

    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    #expect(navigation.requestClose("run", state: state, now: Sample.now.addingTimeInterval(1)) == .confirmed)
    #expect(navigation.closeArmCard(state) == nil, "confirmed")

    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    navigation.detail = .session("done")
    #expect(navigation.closeArmCard(state) == nil, "another tab")
    #expect(navigation.requestClose("done", state: state, now: Sample.now) == .armed)
    #expect(navigation.closeArmCard(state)?.text == "Potwierdź usunięcie karty drugim naciśnięciem.")
  }

  @Test("an error notice wins over the card and outlives the disarming; the card takes down only itself")
  func errorNoticeWins() throws {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.announce = { _ in }
    navigation.detail = .session("run")
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    navigation.post("Serwer odmówił zamknięcia.")
    let notice = try #require(navigation.notice)
    #expect(navigation.closeArmCard(state) == nil, "one card under the bar: the error")
    navigation.disarmClose()
    #expect(navigation.notice == notice, "disarming leaves the newer error card")
    navigation.clearNotice(notice.id)
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    #expect(navigation.closeArmCard(state) != nil)
  }

  @Test("“×”, Cmd+X and the state card arm one arming: one card, one announcement; any second press closes")
  func oneArmingOneAnnouncement() throws {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var spoken: [String] = []
    navigation.announce = { spoken.append($0) }
    navigation.detail = .session("run")
    let sentence = "Potwierdź zamknięcie panelu drugim naciśnięciem."
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    #expect(spoken == [sentence], "the arming speaks when it arms, not when a view draws the card")
    let card = try #require(navigation.closeArmCard(state))
    #expect(card.arm == .session(try #require(navigation.closeArm)))
    #expect(navigation.requestClose("run", state: state, now: Sample.now.addingTimeInterval(2)) == .confirmed,
            "a second press by another way closes")
    #expect(spoken == [sentence], "confirming says nothing more")
    #expect(navigation.requestClose("run", state: state, now: Sample.now.addingTimeInterval(3)) == .armed)
    #expect(spoken == [sentence, sentence], "a new arming is a new card and a new announcement")
    #expect(navigation.requestClose("cx", state: state, now: Sample.now.addingTimeInterval(4)) == .unavailable)
    #expect(spoken.count == 2, "a press that arms nothing says nothing")
  }

  @Test("an arming while a newer error notice stands speaks too, although the notice shows instead of the card")
  func armingSpeaksUnderErrorNotice() throws {
    let state = standing()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var spoken: [String] = []
    navigation.announce = { spoken.append($0) }
    navigation.detail = .session("run")
    navigation.post("Serwer odmówił zamknięcia.")
    #expect(navigation.requestClose("run", state: state, now: Sample.now) == .armed)
    #expect(navigation.closeArmCard(state) == nil, "the error notice shows instead of the card")
    #expect(spoken == ["Serwer odmówił zamknięcia.", "Potwierdź zamknięcie panelu drugim naciśnięciem."])
    // The error goes while the arming stands: its card shows and says nothing again.
    navigation.clearNotice(try #require(navigation.notice).id)
    #expect(navigation.closeArmCard(state) != nil)
    #expect(spoken.count == 2, "the arming card appearing later is not a second announcement")
  }

  /// Guard: the arming sentence has one source, the card. A caller that spoke it itself (the tab's "×", Cmd+X, the
  /// state card) would say it twice with the card, and the logic test above cannot see a view's own announcement.
  @Test("guard: only the arming card's model reads the arming sentence")
  func armingSentenceHasOneSource() throws {
    let root = SessionListSourceTests.sources
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    #expect(files.count > 50, "the scan sees too few source files")
    let readers = try files.map { String($0.path.dropFirst(root.path.count + 1)) }.filter { relative in
      try SessionListSourceTests.code(relative).contains("UICopy.closeArmed(")
    }
    #expect(readers == ["Model/TabClose.swift"], "\(readers)")
  }

  @Test("a change of the current tab in the same list slides; a list change or “Reduce Motion” jumps")
  func closeRoomMotionOnlyForTheCurrentTab() {
    let tabs = ["a", "b", "c", "term.t1"]
    guard case let .slide(duration) = TabCloseRoomMotion(reduceMotion: false, tabsBefore: tabs, tabsAfter: tabs) else {
      Issue.record("the current tab changes within the same list: the rooms slide")
      return
    }
    #expect(duration > 0)
    // "New Terminal" adds its tab and makes it current in one update; closing the current tab removes it.
    for (before, after) in [
      (tabs, tabs + ["terminal-opening"]), (tabs, ["a", "c", "term.t1"]), (tabs, ["b", "a", "c", "term.t1"]),
      ([String](), tabs),
    ] {
      #expect(TabCloseRoomMotion(reduceMotion: false, tabsBefore: before, tabsAfter: after) == .jump,
              "\(before) → \(after)")
    }
    #expect(TabCloseRoomMotion(reduceMotion: true, tabsBefore: tabs, tabsAfter: tabs) == .jump)
  }
}
