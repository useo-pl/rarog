import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Drzewo projektów od strony nawigacji: zaznaczenie z trasy (push, zakładka, terminal
// Codexa) widziane w zwiniętym projekcie, dane nieświeże. Widoku drzewa jeszcze nie ma — testy sklejają
// nawigację z rdzeniem tak, jak zrobi to korzeń apki. Preferencje drzewa: `ProjectTreePreferencesTests.swift`.

private let willow = "/Users/demo/Projects/willow"
private let codexTerm = "0123456789abcdef"

/// willow: odebrany wynik, Codex w terminalu Raroga (odebrany) i sesja `done` — sama cisza; Rarog pracuje.
@MainActor
private func quietProject() -> AppState {
  var state = AppState(clientBuild: 1)
  let sessions = [
    Sample.session(id: "v-old", title: "willow", label: "parser", state: "waiting-input", extra: #""seen":true"#,
                   createdAgo: 9000),
    Sample.session(id: "cx", title: "willow", label: nil, state: "waiting-input",
                   extra: #""seen":true,"engine":"codex","termId":"\#(codexTerm)""#, createdAgo: 6000),
    Sample.session(id: "v-new", title: "willow", label: "zapis", state: "done", createdAgo: 3000),
    Sample.session(id: "p1", title: "rarog", label: "resync", state: "running", createdAgo: 600),
  ]
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  return state
}

/// Zaznaczenie nawigacji w rdzeniu — tak wepnie je korzeń apki: po każdej zmianie trasy `.selected`.
@MainActor
private func mirror(_ navigation: RarogNavigation, into state: inout AppState) {
  state.apply(.list(.selected(navigation.listSelection(state))), now: Sample.now)
}

/// Agenci pod nagłówkami, w kolejności drzewa.
@MainActor
private func shown(_ state: AppState, _ navigation: RarogNavigation) -> [String] {
  state.projectTree(collapsed: navigation.collapsedProjects, calendar: Sample.calendar).compactMap {
    if case let .session(session) = $0.kind { return session.id }
    return nil
  }
}

@MainActor
@Suite("drzewo projektów: zaznaczenie z nawigacji w zwiniętym projekcie")
struct ProjectTreeNavigationTests {
  @Test("push i zakładka otwierają cichy wiersz zwiniętego projektu; zejście z niego go nie chowa")
  func pushAndTab() {
    var state = quietProject()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setProjectsCollapsed([willow], collapsed: true)
    #expect(shown(state, navigation) == ["p1"])

    navigation.openPushTarget(PushTarget(sessionId: "v-new"), state: state)
    mirror(navigation, into: &state)
    #expect(shown(state, navigation) == ["p1", "v-new"], "cel powiadomienia")

    #expect(navigation.openTab(.session("v-old"), state: state))
    mirror(navigation, into: &state)
    #expect(shown(state, navigation) == ["p1", "v-old", "v-new"], "zakładka; v-new trzymana jako ostatnio otwarta")

    navigation.selectSession("p1")
    mirror(navigation, into: &state)
    #expect(shown(state, navigation) == ["p1", "v-old", "v-new"], "tap w inny wiersz niczego nie chowa")
    state.apply(.list(.appBackgrounded), now: Sample.now)
    #expect(shown(state, navigation) == ["p1"], "spokojna chwila: zwinięty projekt wraca do samej pracy")
  }

  @Test("Codex w terminalu Raroga: wiersz zaznaczony z powiadomienia i na trasie terminala stoi w zwiniętym projekcie")
  func codexInTerminal() {
    var state = quietProject()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setProjectsCollapsed([willow], collapsed: true)
    #expect(state.projectTabs(willow).map(\.id) == ["v-old", "v-new"], "pasek zakładek Codexa pomija")

    navigation.openPushTarget(PushTarget(sessionId: "cx", termId: codexTerm), state: state)
    mirror(navigation, into: &state)
    #expect(shown(state, navigation) == ["p1", "cx"])

    navigation.detail = .terminal(codexTerm)
    #expect(navigation.listSelection(state) == "cx")
    mirror(navigation, into: &state)
    #expect(state.listSelection == "cx" && state.heldOpen.isEmpty, "ten sam wiersz — trasa terminala to nie zejście")
    #expect(shown(state, navigation) == ["p1", "cx"])
  }

  @Test("dane nieświeże zdejmują wyciszenie wiersza, ale nie rozwijają zwiniętego projektu")
  func staleRowsStayCollapsed() throws {
    var state = quietProject()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setProjectsCollapsed([willow], collapsed: true)
    let fresh = SessionRowModel(try #require(state.sessions["v-old"]), ordinal: nil)
    #expect(fresh.quiet)

    state.listCache.staleSince = Sample.now
    let cached = SessionRowModel(try #require(state.sessions["v-old"]), ordinal: nil, listStale: state.listStale)
    #expect(!cached.quiet && cached.frozen, "lista z pamięci podręcznej: wiersz bez wyciszenia")
    #expect(shown(state, navigation) == ["p1"], "reguła drzewa idzie za rangą")

    state.listCache.staleSince = nil
    state.sessions["v-old"] = Sample.session(
      id: "v-old", title: "willow", label: "parser", state: "waiting-input", extra: #""seen":true,"stale":true"#,
      createdAgo: 9000)
    let stale = SessionRowModel(try #require(state.sessions["v-old"]), ordinal: nil)
    #expect(!stale.quiet && stale.frozen, "sesja bez kontaktu z herdr")
    #expect(shown(state, navigation) == ["p1"])
  }
}
