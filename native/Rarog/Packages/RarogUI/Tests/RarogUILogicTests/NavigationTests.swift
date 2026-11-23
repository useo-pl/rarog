import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Nawigacja, wiersze projektów, zakładki i menu skrótów.

/// Stan z kilkoma sesjami w dwóch projektach (`/Users/demo/Projects/<projekt>`).
@MainActor
private func twoProjects() -> AppState {
  var state = AppState(clientBuild: 1)
  let sessions = [
    Sample.session(id: "v-old", title: "willow", label: "parser dat", state: "done", createdAgo: 9000, activityAgo: 4000),
    Sample.session(id: "v-new", title: "willow", label: "zapis notatek", state: "waiting-permission",
                   createdAgo: 3000, activityAgo: 60),
    Sample.session(id: "p1", title: "rarog", label: "resync", state: "running", createdAgo: 600, activityAgo: 10),
  ]
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  return state
}

@MainActor
@Suite("nawigacja: projekty, zakładki, Cmd+L, lista, „×”")
struct NavigationTests {
  @Test("tap w projekt: zapamiętana zakładka tego urządzenia, inaczej ostatnio aktywna; pamięć przeżywa restart")
  func openProjectRemembers() {
    let prefs = MemoryPreferences()
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: prefs)
    navigation.openProject("/Users/demo/Projects/willow", state: state)
    #expect(navigation.detail == .session("v-new"), "ostatnio aktywna")
    navigation.detail = .session("v-old")
    navigation.noteVisit(state)
    navigation.detail = .session("p1")
    navigation.noteVisit(state)

    let restarted = RarogNavigation(prefs: prefs)
    restarted.openProject("/Users/demo/Projects/willow", state: state)
    #expect(restarted.detail == .session("v-old"), "zapamiętana zakładka po ponownym uruchomieniu")
    restarted.openProject("/Users/demo/Projects/nowy", state: state)
    #expect(restarted.detail == .project("/Users/demo/Projects/nowy"), "projekt bez sesji = ekran projektu")
  }

  @Test("Cmd+L: poprzedni projekt, drugie naciśnięcie z powrotem; martwy pominięty; z listy ostatni")
  func previousProject() {
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.previousProjectCwd(state) == nil, "pusta historia: skrót milczy")
    navigation.detail = .session("v-new")
    navigation.noteVisit(state)
    navigation.detail = .session("p1")
    navigation.noteVisit(state)
    #expect(navigation.previousProjectCwd(state) == "/Users/demo/Projects/willow")
    #expect(navigation.openPreviousProject(state))
    #expect(navigation.detail == .session("v-new"))
    navigation.noteVisit(state)
    #expect(navigation.openPreviousProject(state))
    #expect(navigation.detail == .session("p1"), "drugie Cmd+L wraca")
    navigation.noteVisit(state)

    navigation.detail = nil
    #expect(navigation.previousProjectCwd(state) == "/Users/demo/Projects/rarog", "z listy: ostatnio odwiedzony")
    var gone = state
    gone.sessions["p1"] = nil
    #expect(navigation.previousProjectCwd(gone) == "/Users/demo/Projects/willow", "projekt bez sesji pominięty")
  }

  @Test("Cmd+1…8 pozycja, Cmd+9 ostatnia, numeracja od najstarszej; bez paska skrót milczy")
  func digits() {
    var state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.shortcutMenu(state).tabs.isEmpty && navigation.shortcutMenu(state).lastTab == nil)
    #expect(!navigation.openTab(.session("v-old"), state: state), "bez paska skrót milczy")
    navigation.detail = .session("v-new")
    #expect(navigation.tabRefs(state) == [.session("v-old"), .session("v-new")])
    #expect(navigation.openTab(.session("v-old"), state: state))
    #expect(navigation.detail == .session("v-old"))

    for index in 0..<8 {
      state.sessions["v\(index)"] = Sample.session(id: "v\(index)", title: "willow", createdAgo: 2000 - Double(index))
    }
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs.map(\.number) == Array(1...8), "dziewiąta i dalsze bez numeru")
    #expect(menu.tabs.first?.target == .session("v-old") && menu.tabs.last?.target == .session("v5"))
    #expect(menu.lastTab == .session("v7"), "Cmd+9 = ostatnia zakładka")
  }

  @Test("klawisze na zakładkach: cyfry z menu skrótów, 9 na ostatniej za ósmą; bez klawiatury sprzętowej pusto")
  func tabDigits() throws {
    var state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    let short = ShortcutMenu.tabDigits(navigation.tabRefs(state), hardwareKeyboard: true)
    #expect(short == [.session("v-old"): 1, .session("v-new"): 2], "krótki pasek: ostatnia nosi swoją pozycję, nie 9")

    for index in 0..<8 {
      state.sessions["v\(index)"] = Sample.session(id: "v\(index)", title: "willow", createdAgo: 2000 - Double(index))
    }
    let strip = navigation.tabRefs(state)
    let digits = ShortcutMenu.tabDigits(strip, hardwareKeyboard: true)
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs.count == 8)
    for tab in menu.tabs { #expect(digits[tab.target] == tab.number, "ta sama cyfra co w menu: \(tab.label)") }
    #expect(digits[try #require(menu.lastTab)] == 9, "ostatnia za ósmą dostaje 9")
    #expect(digits[.session("v6")] == nil && digits.count == 9, "dziewiąta z dziesięciu bez klawisza")
    #expect(ShortcutMenu.tabDigits(strip, hardwareKeyboard: false).isEmpty, "bez klawiatury sprzętowej bez klawiszy")

    // Granica ósmej i dziewiątej: ósma z ośmiu nosi 8, dziewiąta z dziewięciu — 9 (ostatnia).
    let nine = (1...9).map { ProjectTabRef.session("s\($0)") }
    #expect(ShortcutMenu.tabDigits(Array(nine.prefix(8)), hardwareKeyboard: true)[.session("s8")] == 8)
    let full = ShortcutMenu.tabDigits(nine, hardwareKeyboard: true)
    #expect(full[.session("s8")] == 8 && full[.session("s9")] == 9 && full.count == 9)
  }

  /// For the active project a small square shows which tab belongs to the agent: the row's digit is the strip's
  /// key, keyed by session.
  @Test("tree tab digits: the strip's digits by session id; empty without a hardware keyboard or a project on screen")
  func treeTabDigits() {
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.treeTabDigits(state, hardwareKeyboard: true).isEmpty, "no project on screen")
    navigation.detail = .session("v-new")
    #expect(navigation.treeTabDigits(state, hardwareKeyboard: true) == ["v-old": 1, "v-new": 2])
    #expect(navigation.treeTabDigits(state, hardwareKeyboard: false).isEmpty)
  }

  @Test("Cmd+1…9 celuje w identyfikator z chwili rysowania: zamknięta zakładka i obcy projekt = brak działania")
  func digitsTargetDrawnId() {
    var state = twoProjects()
    state.sessions["v-mid"] = Sample.session(
      id: "v-mid", title: "willow", label: "eksport", createdAgo: 5000, activityAgo: 500)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs.map(\.label) == ["parser dat", "eksport", "zapis notatek"])
    #expect(menu.tabs.map(\.target) == [.session("v-old"), .session("v-mid"), .session("v-new")])

    // Między rysowaniem menu a naciśnięciem pierwsza zakładka znika: cyfry nie przesuwają celu.
    var later = state
    later.sessions["v-old"] = nil
    #expect(navigation.openTab(menu.tabs[1].target, state: later))
    #expect(navigation.detail == .session("v-mid"), "„Zakładka 2: eksport” prowadzi do eksportu")
    #expect(!navigation.openTab(menu.tabs[0].target, state: later), "zamknięty cel = brak działania")
    #expect(navigation.detail == .session("v-mid"), "nie sąsiadka zamkniętej")
    #expect(!navigation.openTab(.session("p1"), state: later), "zakładka spoza bieżącego projektu = brak działania")
    #expect(navigation.detail == .session("v-mid"))
  }

  @Test("Cmd+B: tylko przy otwartym szczególe; stan przeżywa ponowne uruchomienie")
  func listToggle() {
    let prefs = MemoryPreferences()
    let navigation = RarogNavigation(prefs: prefs)
    navigation.toggleList()
    #expect(!navigation.listCollapsed, "na ekranie listy skrót nic nie robi")
    navigation.detail = .session("p1")
    navigation.toggleList()
    #expect(navigation.listHidden)
    navigation.detail = nil
    #expect(!navigation.listHidden, "bez szczegółu lista zawsze widoczna (nie pułapka)")
    #expect(RarogNavigation(prefs: prefs).listCollapsed)
  }

  @Test("„×”: pierwsze naciśnięcie uzbraja, drugie w 5 s potwierdza; po czasie i po zmianie ekranu od nowa")
  func closeArming() {
    var state = twoProjects()
    state.sessions["cx"] = Sample.session(id: "cx", title: "rarog", extra: #""engine":"codex""#)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let now = Sample.now
    navigation.detail = .session("p1")
    #expect(navigation.requestClose("p1", state: state, now: now) == .armed)
    #expect(navigation.isCloseArmed("p1", now: now.addingTimeInterval(4)))
    #expect(navigation.requestClose("p1", state: state, now: now.addingTimeInterval(4)) == .confirmed)
    #expect(navigation.requestClose("p1", state: state, now: now) == .armed)
    #expect(navigation.requestClose("p1", state: state, now: now.addingTimeInterval(6)) == .armed, "uzbrojenie wygasło")
    navigation.detail = .session("v-new")
    #expect(navigation.closeArm == nil, "zmiana ekranu rozbraja")
    #expect(navigation.requestClose("cx", state: state, now: now) == .unavailable, "Codex nie ma „×”")
  }

  @Test("„×”: utrata fokusu i dezaktywacja sceny w oknie 5 s gaszą uzbrojenie; następne naciśnięcie uzbraja od nowa")
  func closeDisarmedByFocusAndScene() {
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let now = Sample.now
    navigation.detail = .session("p1")
    #expect(navigation.requestClose("p1", state: state, now: now) == .armed)
    navigation.disarmClose()
    #expect(!navigation.isCloseArmed("p1", now: now.addingTimeInterval(1)), "rozbrojone przed upływem 5 s")
    #expect(navigation.requestClose("p1", state: state, now: now.addingTimeInterval(1)) == .armed, "nie zamyka")
    #expect(navigation.requestClose("p1", state: state, now: now.addingTimeInterval(2)) == .confirmed)
  }

  @Test("Cmd+X: zaznaczenie w polu z fokusem wycina i nie uzbraja; bez zaznaczenia zamyka zakładkę z „×”")
  func cmdXCutsSelection() {
    #expect(CloseTabKey(composerFocused: true, selectionLength: 4, canClose: true) == .cut, "wycina, nie uzbraja")
    #expect(CloseTabKey(composerFocused: true, selectionLength: 4, canClose: false) == .cut, "wycinanie bez „×”")
    #expect(CloseTabKey(composerFocused: true, selectionLength: 0, canClose: true) == .close)
    #expect(CloseTabKey(composerFocused: false, selectionLength: 4, canClose: true) == .close,
            "zaznaczenie w polu bez fokusu nie wycina")
    #expect(CloseTabKey(composerFocused: true, selectionLength: 0, canClose: false) == .unavailable)
  }

  @Test("zdanie pod paskiem: czytnik słyszy je raz, przy powstaniu; gaszenie innego zdania nic nie zmienia")
  func noticeAnnouncedOnce() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var spoken: [String] = []
    navigation.announce = { spoken.append($0) }
    navigation.post("Limit paneli Raroga.")
    let first = navigation.notice
    #expect(spoken == ["Limit paneli Raroga."])
    navigation.clearNotice(UUID())
    #expect(navigation.notice == first, "obce id nie gasi")
    navigation.post("Zakładanie wyłączone.")
    #expect(spoken == ["Limit paneli Raroga.", "Zakładanie wyłączone."])
    navigation.clearNotice(navigation.notice!.id)
    #expect(navigation.notice == nil && spoken.count == 2)
  }

  @Test("menu skrótów: zakładki z numerem i nazwą, ostatnia, cel Cmd+L z nazwy projektu")
  func shortcutMenu() {
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.shortcutMenu(state) == ShortcutMenu())
    navigation.detail = .session("p1")
    navigation.noteVisit(state)
    navigation.detail = .session("v-new")
    navigation.noteVisit(state)
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs == [
      .init(number: 1, label: "parser dat", target: .session("v-old")),
      .init(number: 2, label: "zapis notatek", target: .session("v-new")),
    ])
    #expect(menu.lastTab == .session("v-new") && menu.canNewSession && menu.canToggleList)
    #expect(menu.previousProject == "rarog")
    #expect(UICopy.shortcutPreviousProject(menu.previousProject) == "Poprzedni projekt: rarog")
  }
}

@MainActor
@Suite("wiersze projektów i zakładki: liczniki, git, znaczniki, zdania czytnika")
struct ProjectRowsTests {
  @Test("wiersz: licznik w tonie najpilniejszej sesji, znacznik otwartego i celu Cmd+L, zdanie czytnika")
  func rows() {
    var state = twoProjects()
    state.sessions["p1"] = Sample.session(
      id: "p1", title: "rarog", label: "resync", state: "running",
      extra: #""branch":"feat/m1","ahead":3,"behind":0"#, activityAgo: 10)
    let rows = state.projectRows(
      openCwd: "/Users/demo/Projects/rarog", jumpCwd: "/Users/demo/Projects/willow", calendar: Calendar.current)
    let byName = Dictionary(uniqueKeysWithValues: rows.map { ($0.name, $0) })
    let willow = byName["willow"]!
    #expect(willow.agents == 2 && willow.tone == .waiting && willow.jumpTarget && !willow.open)
    let rarog = byName["rarog"]!
    #expect(rarog.open && !rarog.jumpTarget)
    #expect(rarog.branch == "feat/m1" && rarog.ahead == 3 && rarog.behind == nil, "zero chowa strzałkę")
    #expect(rarog.path == nil, "jednoznaczna nazwa bez ścieżki")
    #expect(rarog.spoken == "rarog, 1 agent, pracuje, gałąź feat/m1, 3 do wysłania, otwarty")
    #expect(willow.spoken.hasSuffix("cel skrótu Command L"))
  }

  @Test("wiersz projektu, w którym agent czeka na zadanie w tle: ton licznika i zdanie czytnika")
  func backgroundWaitRow() {
    var state = AppState(clientBuild: 1)
    state.sessions["m"] = Sample.session(
      id: "m", title: "rarog", state: "done",
      extra: #""backgroundTasks":[{"id":"t","kind":"monitor","description":"log"}]"#)
    let row = state.projectRows(openCwd: nil, jumpCwd: nil).first { $0.name == "rarog" }
    #expect(row?.tone == .backgroundWait)
    #expect(row?.spoken == "rarog, 1 agent, czeka na zadanie w tle")
    #expect(UICopy.toneSpoken(.backgroundWait) == "czeka na zadanie w tle")
  }

  @Test("project header without counters: terminals in the directory do not reach the row model")
  func noTerminalCount() throws {
    var state = twoProjects()
    state.capabilities = Capabilities(Sample.decode(
      VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s","termEnabled":true}"#))
    let terminals = [("00000000000000a1", 1), ("00000000000000b2", 2)].map { id, slot in
      Sample.decode(TerminalListEntry.self, #"""
        {"id":"\#(id)","cwd":"/Users/demo/Projects/rarog","live":true,"slot":\#(slot),"proc":"zsh","role":"shell"}
        """#)
    }
    _ = state.apply(.terminals(.loaded(terminals, at: Sample.now)), now: Sample.now)
    #expect(state.projectTerminals("/Users/demo/Projects/rarog").count == 2, "the terminal tabs are there")
    let rarog = try #require(state.projectRows(openCwd: nil, jumpCwd: nil).first { $0.name == "rarog" })
    #expect(rarog.spoken == "rarog, 1 agent, pracuje", "agent count and state, no terminals")
    #expect(!Mirror(reflecting: rarog).children.contains { $0.label == "terminals" }, "no terminal count field")
  }

  @Test("ta sama nazwa w dwóch katalogach: ścieżka w drugiej linii")
  func ambiguous() {
    var state = AppState(clientBuild: 1)
    state.sessions["a"] = Sample.session(id: "a", title: "rarog")
    state.sessions["b"] = Sample.decode(SessionSummary.self, #"""
      {"id":"b","cwd":"/Users/demo/Archiwum/rarog","title":"rarog","state":"done",
       "stateSince":"\#(Sample.iso(10))","createdAt":"\#(Sample.iso(10))","lastActivityAt":"\#(Sample.iso(10))"}
      """#)
    let rows = state.projectRows(openCwd: nil, jumpCwd: nil)
    #expect(Set(rows.compactMap(\.path)) == ["~/Projects/rarog", "~/Archiwum/rarog"])
  }

  @Test("zakładki: etykieta albo #id, zdanie bieżącej i siostry, ton kreski")
  func tabs() {
    var state = twoProjects()
    state.sessions["bez"] = Sample.session(id: "abcdef12", title: "willow", label: nil, createdAgo: 100)
    let tabs = state.projectTabModels(cwd: "/Users/demo/Projects/willow", current: .session("v-new"))
    #expect(tabs.map(\.label) == ["parser dat", "zapis notatek", "#abcd"])
    #expect(tabs[1].current && tabs[1].spoken == "zapis notatek, czeka na zgodę")
    #expect(tabs[0].spoken == "Przejdź do sesji: parser dat, gotowe")
    #expect(tabs[1].tone == .waiting)
  }

  @Test("zakładka sesji, która czeka na zadanie w tle: zdanie czytnika ma słowo tonu, bez zadań — nie")
  func backgroundWaitTabSpoken() {
    let monitor = #""seen":true,"backgroundTasks":[{"id":"m","kind":"monitor","description":"log serwera"}]"#
    let waiting = Sample.session(label: "parser", state: "waiting-input", extra: monitor)
    let idle = Sample.session(label: "parser", state: "waiting-input", extra: #""seen":true"#)
    #expect(waiting.statusTone == .backgroundWait && idle.statusTone == .quiet)
    #expect(UICopy.tabSpoken(waiting, current: true) == "parser, bezczynna, czeka na zadanie w tle")
    #expect(UICopy.tabSpoken(waiting, current: false) == "Przejdź do sesji: parser, bezczynna, czeka na zadanie w tle")
    #expect(UICopy.tabSpoken(idle, current: true) == "parser, bezczynna")
    #expect(UICopy.tabSpoken(idle, current: false) == "Przejdź do sesji: parser, bezczynna")
  }

  @Test("copy: blokada zakładania zdaniem serwera, odmowy, zamknięcie mówi skutek")
  func copy() {
    #expect(UICopy.launchBlocked(nil) == UICopy.launchBlockedFallback)
    #expect(UICopy.launchBlocked("Limit paneli Raroga.") == "Limit paneli Raroga.")
    #expect(UICopy.createMessage(.refused("Za szybko.")) == "Za szybko.")
    #expect(UICopy.createMessage(.created(sessionId: "x", trustPrompt: false)) == nil)
    #expect(UICopy.createMessage(.created(sessionId: "x", trustPrompt: true)) == UICopy.trustPrompt)
    #expect(UICopy.closeMessage(.refused(nil)) == UICopy.closeFailed)
    let done = Sample.session(state: "done")
    #expect(UICopy.closeLabel(done) == "Usuń z listy")
    #expect(UICopy.closeLabel(Sample.session()) == "Zamknij panel w herdr")
    #expect(UICopy.agentsSpoken(1) == "1 agent" && UICopy.agentsSpoken(3) == "agentów: 3")
  }

  @Test("session history: a visit is the list selection; the project screen records nothing; survives a restart")
  func sessionVisits() {
    let prefs = MemoryPreferences()
    let state = twoProjects()
    let navigation = RarogNavigation(prefs: prefs)
    navigation.detail = .session("v-old")
    navigation.noteSessionVisit(state)
    navigation.detail = .session("p1")
    navigation.noteSessionVisit(state)
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids == ["v-old", "p1"], "repeating the current session records nothing")

    navigation.detail = .project("/Users/demo/Projects/willow")
    navigation.noteSessionVisit(state)
    navigation.detail = nil
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids == ["v-old", "p1"], "a project screen and the list are not visits")

    navigation.detail = .session("launching")
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids == ["v-old", "p1", "launching"], "a visit needs no known project directory")
    #expect(navigation.recentSessions(state) == ["p1", "v-old"], "newest first, sessions the app does not know skipped")
    #expect(navigation.recentSessions(state, limit: 1) == ["p1"])

    let restarted = RarogNavigation(prefs: prefs)
    #expect(restarted.sessionHistory.ids == ["v-old", "p1", "launching"], "history read back from the preferences")
  }

  @Test("session history: an agent in the watched Rarog terminal is a visit, also when it appears later")
  func terminalAgentVisits() {
    let term = "0123456789abcdef"
    var state = twoProjects()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .terminal(term)
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids.isEmpty, "a bare shell is not a session visit")

    state.sessions["cx"] = Sample.session(id: "cx", title: "willow", label: nil, state: "waiting-input",
                                          extra: #""engine":"codex","termId":"\#(term)""#, createdAgo: 100)
    #expect(navigation.listSelection(state) == "cx")
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids == ["cx"], "the agent that appeared in the watched terminal")

    navigation.detail = .session("v-new")
    navigation.noteSessionVisit(state)
    navigation.detail = .terminal(term)
    navigation.noteSessionVisit(state)
    #expect(navigation.sessionHistory.ids == ["v-new", "cx"], "the terminal route with an agent records the agent")
  }
}
