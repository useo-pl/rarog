import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Nawigacja terminala: zakładki terminali i zaproszenie, numeracja Cmd+1–9, trasa terminala
// z tożsamością ekranu („Nowy terminal" → `.terminal(id)` bez nowej powłoki), wpis Codexa z `termId`,
// „×" terminala, okna Cmd+F/Cmd+G, Esc w oknie, historia.

private let willow = "/Users/demo/Projects/willow"
private let termA = "00000000000000a1"
private let termB = "00000000000000b2"
private let termCodex = "00000000000000c3"

private func entry(
  _ id: String, cwd: String = willow, slot: Int, proc: String = "zsh", live: Bool = true, role: String = "shell"
) -> TerminalListEntry {
  Sample.decode(TerminalListEntry.self, #"""
    {"id":"\#(id)","cwd":"\#(cwd)","live":\#(live),"slot":\#(slot),"proc":"\#(proc)","role":"\#(role)"}
    """#)
}

private func capabilities(term: Bool) -> Capabilities {
  Capabilities(Sample.decode(VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s","termEnabled":\#(term)}"#))
}

/// Dwie sesje willow, wpis Codexa w terminalu `termCodex`, terminale slotów 1 i 2 (lista w odwrotnej kolejności).
@MainActor
private func project(term: Bool? = true, terminals: [TerminalListEntry]? = nil) -> AppState {
  var state = AppState(clientBuild: 1)
  let sessions = [
    Sample.session(id: "v-old", title: "willow", label: "parser dat", state: "done", createdAgo: 9000, activityAgo: 4000),
    Sample.session(id: "v-new", title: "willow", label: "zapis notatek", createdAgo: 3000, activityAgo: 60),
    Sample.session(id: "cx", title: "willow", label: "codex", extra: #""engine":"codex","termId":"\#(termCodex)""#,
                   createdAgo: 8000, activityAgo: 30),
    Sample.session(id: "p1", title: "rarog", label: "resync", createdAgo: 600, activityAgo: 10),
  ]
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  state.capabilities = term.map(capabilities(term:))
  let list = terminals ?? [
    entry(termB, slot: 2, proc: "nvim"), entry(termA, slot: 1, proc: ""),
    entry(termCodex, slot: 3, proc: "codex"), entry("00000000000000f0", slot: 0, proc: "lazygit", role: "lazygit"),
  ]
  _ = state.apply(.terminals(.loaded(list, at: Sample.now)), now: Sample.now)
  return state
}

@MainActor
@Suite("terminal: nawigacja, zakładki, okna")
struct TerminalNavigationTests {
  // MARK: Zakładki

  @Test("pasek: sesje od najstarszej, potem terminale po slotach z etykietą procesu; Codex z termId bez zakładki")
  func strip() {
    let state = project()
    let tabs = state.projectTabModels(cwd: willow, current: .terminal(termB))
    #expect(tabs.map(\.id) == ["v-old", "v-new", "term.\(termA)", "term.\(termB)", "term.\(termCodex)"])
    #expect(tabs.map(\.label) == ["parser dat", "zapis notatek", "terminal", "nvim", "codex"])
    #expect(tabs.filter(\.current).map(\.id) == ["term.\(termB)"])
    #expect(tabs[3].spoken == "Terminal 2, nvim, działa")
    #expect(tabs[2].spoken == "Przejdź do terminala: 1, działa")
    #expect(tabs[3].tone == .quiet, "terminal bez tonu stanu: `live` to fakt techniczny, nie praca")
    #expect(tabs.allSatisfy { $0.kind != .invite(enabled: true) && $0.kind != .invite(enabled: false) })
  }

  @Test("zaproszenie: projekt bez terminala ma jedno; wygaszone przy termEnabled:false, brak bez sondy")
  func invite() {
    let on = project(terminals: [])
    let invite = on.projectTabModels(cwd: willow, current: .session("v-new")).last
    #expect(invite?.kind == .invite(enabled: true) && invite?.target == nil)
    #expect(invite?.spoken == UICopy.terminalInviteSpoken)
    let off = project(term: false)
    let dimmed = off.projectTabModels(cwd: willow, current: .session("v-new")).last
    #expect(dimmed?.kind == .invite(enabled: false), "RAROG_TERM=0: stara lista nie rysuje terminali, zaproszenie wygaszone")
    #expect(dimmed?.spoken == UICopy.terminalOff && dimmed?.dimmed == true)
    #expect(invite?.showsLabel == false && dimmed?.showsLabel == false, "zaproszenie to sam glif (jak `>_` w PWA)")
    let unknown = project(term: nil)
    #expect(unknown.projectTabModels(cwd: willow, current: nil).map(\.id) == ["v-old", "v-new"])
  }

  @Test("tap w zaproszenie zakłada slot 1; wygaszone mówi powód i nie zmienia ekranu")
  func inviteTap() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    navigation.openTerminal(.first, in: willow, state: project(term: false))
    #expect(navigation.detail == .session("v-new"))
    #expect(navigation.notice?.text == UICopy.terminalOff)
    let token = UUID()
    navigation.openTerminal(.first, in: willow + "/", state: project(terminals: []), token: token)
    #expect(navigation.detail == .openingTerminal(TerminalOpening(cwd: willow, slot: .first, token: token)))
    let route = navigation.terminalRoute(project(terminals: []))
    #expect(route?.target == TerminalTarget.shell(cwd: willow, slot: 1), "zaproszenie = slot 1, nie `next`")
    #expect(route?.key == token.uuidString)
    #expect(project(terminals: []).projectTabModels(cwd: willow, current: nil, opening: true).last?.current == true)
  }

  @Test("„Nowy terminal”: `next`; blokada zakładania i komplet slotów mówią zdaniem i nie zmieniają ekranu")
  func newTerminalGates() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    var blocked = project()
    blocked.herdr = Sample.decode(HerdrStatus.self, #"""
      {"available":true,"agentCount":1,"readOnly":false,"canLaunch":false,"detail":"Zakładanie wyłączone."}
      """#)
    navigation.openTerminal(.next, in: willow, state: blocked)
    #expect(navigation.detail == .session("v-new") && navigation.notice?.text == "Zakładanie wyłączone.")
    let full = project(terminals: (1...4).map { entry(String(format: "%016x", $0), slot: $0) })
    navigation.openTerminal(.next, in: willow, state: full)
    #expect(navigation.detail == .session("v-new") && navigation.notice?.text == UICopy.terminalSlotsFull)
    navigation.openTerminal(.next, in: willow, state: project())
    guard case let .openingTerminal(opening)? = navigation.detail else {
      Issue.record("„Nowy terminal” otwiera ekran")
      return
    }
    #expect(opening.slot == .next)
    #expect(navigation.terminalRoute(project())?.target == TerminalTarget.newShell(cwd: willow))
  }

  // MARK: Numeracja

  @Test("Cmd+1…8 numeruje sesje, potem terminale; Cmd+9 = ostatni terminal; okno terminala blokuje cyfry")
  func numbering() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs.map(\.target) == [
      .session("v-old"), .session("v-new"), .terminal(termA), .terminal(termB), .terminal(termCodex),
    ])
    #expect(menu.tabs.map(\.label) == ["parser dat", "zapis notatek", "terminal", "nvim", "codex"])
    #expect(menu.lastTab == .terminal(termCodex) && menu.canTerminal && menu.canPopup)
    #expect(navigation.canTogglePopup(state), "przycisk nagłówka stoi tam, gdzie Cmd+F")
    #expect(navigation.openTab(menu.tabs[3].target, state: state))
    #expect(navigation.detail == .terminal(termB))
    #expect(navigation.terminalRoute(state)?.target == .existing(entry(termB, slot: 2, proc: "nvim")))
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.shortcutMenu(state).tabs.isEmpty && navigation.shortcutMenu(state).lastTab == nil)
    #expect(navigation.popup != nil, "skrót cyfry przy otwartym oknie nic nie robi")
    // Klawisze na zakładkach zostają pod oknem: znikające przesuwałyby pasek przy każdym otwarciu i zamknięciu.
    #expect(ShortcutMenu.tabDigits(navigation.tabRefs(state), hardwareKeyboard: true)
      == Dictionary(uniqueKeysWithValues: menu.tabs.map { ($0.target, $0.number) }))
    #expect(project(term: nil).terminalFeature == .unknown)
    navigation.closePopup()
    navigation.detail = .session("v-new")
    #expect(!navigation.shortcutMenu(project(term: nil)).canTerminal, "bez sondy Cmd+Shift+N/F/G wygaszone")
    #expect(!navigation.shortcutMenu(project(term: nil)).canPopup)
    #expect(!navigation.canTogglePopup(project(term: nil)), "bez sondy przycisku okna nie ma")
    #expect(navigation.canTogglePopup(project(term: false)), "wyłączony terminal: przycisk stoi i mówi zdanie")
    navigation.detail = nil
    #expect(!navigation.canTogglePopup(state), "bez projektu na ekranie nie ma czego otworzyć")
  }

  // MARK: Trasa i tożsamość ekranu

  @Test("„Nowy terminal” po pierwszej odpowiedzi: trasa `.terminal(id)`, TA SAMA tożsamość ekranu, okno zostaje")
  func identification() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let token = UUID()
    navigation.openTerminal(.next, in: willow, state: state, token: token)
    let key = token.uuidString
    navigation.togglePopup(.popup, state: state)
    let screen = navigation.screenRevision
    navigation.terminalIdentified("00000000000000e5", screen: "obcy-ekran", state: state)
    #expect(navigation.detail == .openingTerminal(TerminalOpening(cwd: willow, slot: .next, token: token)))
    navigation.terminalIdentified("00000000000000e5", screen: key, state: state)
    #expect(navigation.detail == .terminal("00000000000000e5"))
    #expect(navigation.terminalRoute(state)?.key == key, "ten sam kontroler — bez drugiej powłoki")
    #expect(navigation.terminalRoute(state)?.target == TerminalTarget.id("00000000000000e5"))
    #expect(navigation.currentProjectCwd(state) == willow, "nagłówek wie, gdzie stoi, zanim dojedzie lista")
    #expect(navigation.popup?.role == .popup, "przepięcie trasy to nie zmiana ekranu")
    #expect(navigation.screenRevision == screen, "numer ekranu bez zmian (odłożone otwarcie z dymka nie przepada)")
    // Terminal przeniesiony przez serwer (inny realpath): nowa trasa, ta sama tożsamość.
    navigation.terminalIdentified("00000000000000e6", screen: key, state: state)
    #expect(navigation.detail == .terminal("00000000000000e6") && navigation.terminalRoute(state)?.key == key)
    // Inny terminal z paska to inny ekran.
    navigation.openTab(.terminal(termA), state: state)
    #expect(navigation.terminalRoute(state)?.key == termA)
    #expect(navigation.popup == nil, "zmiana ekranu zamyka okno")
    #expect(navigation.screenRevision > screen, "zmiana ekranu podbija numer ekranu")
  }

  @Test("Codex z termId → ekran jego terminala (zakładka terminala bieżąca), bez termId → ekran stanu")
  func codexRoute() {
    var state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("cx")
    #expect(navigation.terminalRoute(state)?.key == termCodex)
    #expect(navigation.terminalRoute(state)?.target == .existing(entry(termCodex, slot: 3, proc: "codex")))
    #expect(navigation.currentTab(state) == .terminal(termCodex))
    #expect(navigation.currentProjectCwd(state) == willow)
    navigation.detail = .terminal(termCodex)
    #expect(navigation.listSelection(state) == "cx", "wiersz Codexa zostaje zaznaczony na trasie jego terminala")
    #expect(navigation.terminalRoute(state)?.key == termCodex, "ta sama tożsamość z wiersza i z zakładki")
    state.sessions["cx"] = Sample.session(id: "cx", title: "willow", extra: #""engine":"codex""#)
    navigation.detail = .session("cx")
    #expect(navigation.terminalRoute(state) == nil, "bez terminala: ekran „Rarog widzi tylko stan”")
  }

  @Test("Claude uruchomiony w terminalu Raroga: wiersz i zakładka prowadzą do terminala")
  func claudeRoute() {
    var state = project()
    let update = #""cliUpdate":{"running":"2.1.290","installed":"2.1.292"}"#
    state.sessions["cl"] = Sample.session(
      id: "cl", title: "willow", label: "ręczny claude", extra: #""termId":"\#(termA)",\#(update)"#,
      createdAgo: 500, activityAgo: 5)
    let navigation = RarogNavigation(prefs: MemoryPreferences())

    // Pasek: sesja z terminala nie ma własnej zakładki, a jej zakładką jest zakładka terminala.
    let strip = state.projectTabModels(cwd: willow, current: nil).compactMap(\.target)
    #expect(!strip.contains(.session("cl")))
    #expect(strip.contains(.terminal(termA)))

    // Z wiersza listy (`.session`) i z zakładki (`.terminal`) — ten sam ekran i to samo zaznaczenie.
    navigation.detail = .session("cl")
    #expect(navigation.terminalRoute(state)?.key == termA)
    #expect(navigation.currentTab(state) == .terminal(termA))
    #expect(navigation.listSelection(state) == "cl")
    #expect(navigation.inspectorSession(state) == nil, "prawy panel należy do ekranu sesji")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay)
    navigation.detail = .terminal(termA)
    #expect(navigation.terminalRoute(state)?.key == termA, "ta sama tożsamość ekranu")
    #expect(navigation.listSelection(state) == "cl", "wiersz zostaje zaznaczony, linia statusu jego sesji też")
    navigation.detail = .terminal(termB)
    #expect(navigation.listSelection(state) == nil, "goła powłoka: żadnego wiersza")

    // Trasa z wiersza przechodzi na terminal i przeżywa zniknięcie karty (`/exit` zdejmuje ją z listy).
    navigation.detail = .session("cl")
    let revision = navigation.screenRevision
    navigation.settleHostedRoute(state)
    #expect(navigation.detail == .terminal(termA))
    #expect(navigation.screenRevision == revision, "to nie jest zmiana ekranu")
    #expect(navigation.listSelection(state) == "cl")
    var after = state
    after.sessions["cl"] = nil
    #expect(navigation.terminalRoute(after)?.key == termA, "powłoka zostaje na ekranie")
    #expect(navigation.listSelection(after) == nil, "wiersza już nie ma")
    navigation.detail = .session("v-new")
    navigation.settleHostedRoute(state)
    #expect(navigation.detail == .session("v-new"), "sesja z własnym ekranem zostaje na swojej trasie")

    // Restart na nowszym CLI z Raroga wyniósłby sesję z terminala do nowego panelu — pigułki nie ma.
    let hosted = state.sessions["cl"]
    #expect(hosted.map { StatusPills.cliUpdate($0) == nil } == true)
    #expect(StatusPills.cliUpdate(Sample.session(extra: update)) != nil, "sesja z własnym ekranem ją ma")

    // Token zniknął (albo terminal wyłączony): to znów zwykła sesja Claude z własnym ekranem i zakładką.
    state.sessions["cl"] = Sample.session(id: "cl", title: "willow", label: "ręczny claude", createdAgo: 500)
    navigation.detail = .session("cl")
    #expect(navigation.terminalRoute(state) == nil)
    #expect(navigation.currentTab(state) == .session("cl"))
    #expect(state.projectTabModels(cwd: willow, current: nil).contains { $0.target == .session("cl") })
  }

  @Test("stos na iPhonie: szczegół na wierzchu przy każdej trasie, też bez wiersza listy; „wstecz” zdejmuje trasę")
  func compactStack() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(!navigation.compactShowsDetail, "bez trasy: lista")
    let routes: [RarogNavigation.Detail] = [
      .session("v-new"), .terminal(termA), .openingTerminal(TerminalOpening(cwd: willow, slot: .next)),
      .project("/Users/demo/Projects/nowy"),
    ]
    for route in routes {
      navigation.detail = route
      #expect(navigation.compactShowsDetail, "szczegół na wierzchu: \(route)")
      navigation.compactReturnedToList()
      #expect(navigation.detail == nil, "„wstecz” zdejmuje trasę: \(route)")
    }
    // Regresja: terminal, „Nowy terminal” i projekt bez sesji nie mają wiersza na liście,
    // więc samo zaznaczenie listy cofało stos.
    navigation.detail = .terminal(termA)
    #expect(navigation.listSelection(state) == nil)
    #expect(navigation.compactShowsDetail)
  }

  @Test("„×” terminala: ostatnio aktywna sesja projektu bez Codexa z tego terminala; obcy ekran nic nie zmienia")
  func closeReturns() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("cx")
    navigation.terminalClosed(screen: termA, state: state)
    #expect(navigation.detail == .session("cx"), "spóźnione „×” innego ekranu")
    navigation.terminalClosed(screen: termCodex, state: state)
    #expect(navigation.detail == .session("v-new"))
    navigation.detail = .terminal("00000000000000d9")
    navigation.terminalClosed(screen: "00000000000000d9", state: project(terminals: []))
    #expect(navigation.detail == .session("p1"), "terminal bez katalogu: ostatnio aktywna sesja w ogóle")
  }

  @Test("pamięć: zakładka-terminal notowana i wraca z wiersza projektu; Cmd+L skacze do terminala")
  func memory() {
    let prefs = MemoryPreferences()
    let state = project()
    let navigation = RarogNavigation(prefs: prefs)
    navigation.openTab(.terminal(termB), state: state)
    #expect(navigation.detail == nil, "bez projektu na ekranie pasek nie istnieje")
    navigation.detail = .session("v-new")
    navigation.openTab(.terminal(termB), state: state)
    navigation.noteVisit(state)
    navigation.detail = .session("p1")
    navigation.noteVisit(state)
    let restarted = RarogNavigation(prefs: prefs)
    restarted.openProject(willow, state: state)
    #expect(restarted.detail == .terminal(termB))
    restarted.detail = .session("p1")
    restarted.noteVisit(state)
    #expect(restarted.openPreviousProject(state))
    #expect(restarted.detail == .terminal(termB))
  }

  @Test("odtworzony widok „Nowego terminala” przed odpowiedzią nie prosi drugi raz o `next`")
  func openingClaimedOnce() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let next = TerminalOpening(cwd: willow, slot: .next)
    let (first, rebuilt) = (UUID(), UUID())
    #expect(navigation.claimsOpening(next, view: first))
    #expect(navigation.claimsOpening(next, view: first), "ten sam widok rysuje się dalej")
    #expect(!navigation.claimsOpening(next, view: rebuilt), "odtworzony widok: zdanie zamiast drugiej powłoki")
    #expect(navigation.claimsOpening(TerminalOpening(cwd: willow, slot: .first), view: rebuilt), "slot 1 idempotentny")
    navigation.openTerminal(.next, in: willow, state: project())
    guard case let .openingTerminal(again)? = navigation.detail else { return }
    #expect(navigation.claimsOpening(again, view: rebuilt), "świadome „Spróbuj od nowa” to nowe otwarcie")
    navigation.detail = .session("v-new")
    #expect(navigation.claimsOpening(next, view: UUID()), "zejście z trasy czyści właścicieli")
  }

  @Test("„×” terminala z powiadomienia wraca do sesji TEGO projektu także po zdjęciu wpisu z listy")
  func closeAfterListForgets() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openPushTarget(PushTarget(sessionId: "nieznana", termId: termB), state: state)
    #expect(navigation.detail == .terminal(termB))
    let gone = project(terminals: [entry(termA, slot: 1)])
    navigation.terminalClosed(screen: termB, state: gone)
    #expect(navigation.detail == .session("cx"), "sesja willow (Codex z innego terminala), nie ostatnio aktywna w ogóle (p1)")
    // Ekran sam zgłasza id przy pierwszym rysowaniu — to też utrwala katalog.
    let other = RarogNavigation(prefs: MemoryPreferences())
    other.detail = .terminal(termA)
    other.terminalIdentified(termA, screen: termA, state: state)
    other.terminalClosed(screen: termA, state: project(terminals: []))
    #expect(other.detail == .session("cx"))
    // Powiadomienie PRZED pierwszą listą: katalog przychodzi później z listy (wizyta), a DELETE zdejmuje wpis.
    let late = RarogNavigation(prefs: MemoryPreferences())
    late.openPushTarget(PushTarget(sessionId: "nieznana", termId: termB), state: project(terminals: []))
    late.terminalIdentified(termB, screen: termB, state: project(terminals: []))
    late.noteVisit(state)
    late.terminalClosed(screen: termB, state: gone)
    #expect(late.detail == .session("cx"), "katalog z listy, która dojechała po otwarciu")
  }

  @Test("Cmd+1–9 i pasek z jednej listy: świeży terminal przed listą ma numer i jest Cmd+9")
  func numberingIncludesFreshTerminal() {
    let state = project(terminals: [])
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let token = UUID()
    navigation.openTerminal(.next, in: willow, state: state, token: token)
    navigation.terminalIdentified("00000000000000e5", screen: token.uuidString, state: state)
    let menu = navigation.shortcutMenu(state)
    #expect(menu.tabs.map(\.target) == [.session("v-old"), .session("v-new"), .terminal("00000000000000e5")])
    #expect(menu.lastTab == .terminal("00000000000000e5"))
    navigation.openTab(.session("v-old"), state: state)
    #expect(!navigation.openTab(.terminal("00000000000000e5"), state: state), "poza trasą świeżego terminala go nie ma")
  }

  // MARK: Okna

  @Test("Cmd+F/Cmd+G: przełącznik pary (rola, projekt); jedno okno; zmiana ekranu zamyka; bez terminala zdanie")
  func popups() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup == nil, "bez projektu na ekranie skrót milczy")
    navigation.detail = .session("v-new")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup == TerminalPopupRequest(cwd: willow, role: .popup))
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.popup == TerminalPopupRequest(cwd: willow, role: .lazygit), "drugi skrót przełącza")
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.popup == nil, "ten sam skrót zamyka")
    navigation.togglePopup(.shell, state: state)
    #expect(navigation.popup == nil, "rola powłoki projektu nie jest oknem")
    navigation.togglePopup(.popup, state: state)
    navigation.detail = .session("p1")
    #expect(navigation.popup == nil, "zmiana ekranu zamyka okno")
    navigation.togglePopup(.lazygit, state: project(term: false))
    #expect(navigation.popup == nil && navigation.notice?.text == UICopy.terminalOff)
    #expect(TerminalPopupRequest(cwd: "/a", role: .popup).id != TerminalPopupRequest(cwd: "/a", role: .lazygit).id)
  }

  @Test("Terminal glyph in a project header: the window of THAT project, with nothing or another project on screen")
  func popupInNamedProject() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.togglePopup(.popup, in: willow, state: state)
    #expect(navigation.popup == TerminalPopupRequest(cwd: willow, role: .popup), "no project on screen is no obstacle")
    #expect(navigation.detail == nil, "the window does not change the screen")
    #expect(navigation.shortcutMenu(state).canPopup, "the window's keys work with no project on screen")
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.popup == TerminalPopupRequest(cwd: willow, role: .lazygit), "Cmd+G switches the same project")
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.popup == nil && !navigation.shortcutMenu(state).canPopup, "Cmd+G closes; then nothing to open")
    navigation.togglePopup(.popup, in: willow, state: state)
    navigation.togglePopup(.popup, in: willow, state: state)
    #expect(navigation.popup == nil, "the second tap closes")
    navigation.detail = .session("p1")
    navigation.togglePopup(.popup, in: willow, state: state)
    #expect(navigation.popup?.cwd == willow, "the named project wins over the one on screen")
    #expect(navigation.currentProjectCwd(state) != willow, "another project stands on screen")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup == nil, "Cmd+F closes the window of the tree's project, not opens the screen's")
    navigation.togglePopup(.popup, in: willow, state: state)
    navigation.togglePopup(.popup, in: nil, state: state)
    #expect(navigation.popup?.cwd == willow, "no project: nothing happens")
    navigation.closePopup()
    navigation.togglePopup(.popup, in: willow, state: project(term: false))
    #expect(navigation.popup == nil && navigation.notice?.text == UICopy.terminalOff)
  }

  @Test("Esc: zamyka arkusze i okno powłoki, w oknie lazygita idzie do programu")
  func escape() {
    #expect(EscapePolicy.route(for: .sheet) == .dismiss)
    #expect(EscapePolicy.route(for: .terminalPopup(.popup, programAlive: true)) == .dismiss)
    #expect(EscapePolicy.route(for: .terminalPopup(.popup, programAlive: false)) == .dismiss)
    #expect(EscapePolicy.route(for: .terminalPopup(.lazygit, programAlive: true)) == .program)
    #expect(EscapePolicy.route(for: .terminalPopup(.lazygit, programAlive: false)) == .dismiss,
            "bez żywego programu Esc nie ma komu trafić: zamyka okno")
  }

  @Test("okno łaski Esc: 300 ms po zamknięciu prezentacji Esc-em kolejny Esc nie przerywa tury ani nie odrzuca karty")
  func escapeGrace() {
    EscapeGrace.reset()
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(!EscapeGrace.swallows(now: start), "bez zamknięcia nie ma łaski")
    EscapeGrace.closedByEscape(now: start)
    #expect(EscapeGrace.swallows(now: start) && EscapeGrace.swallows(now: start.addingTimeInterval(0.29)))
    #expect(!EscapeGrace.swallows(now: start.addingTimeInterval(0.31)), "po oknie Esc znów należy do ekranu")
    #expect(!EscapeGrace.swallows(now: start.addingTimeInterval(-1)), "zegar cofnięty: bez łaski")
    #expect(EscapeGrace.window == 0.3)
    EscapeGrace.reset()
    #expect(EscapeInterruptRule.allows(cardFocused: false, overlayPresented: false, composing: false, availability: .enabled))
    #expect(!EscapeInterruptRule.allows(
      cardFocused: false, overlayPresented: false, composing: false, afterEscapeClose: true, availability: .enabled))
  }

  @Test("historia: arkusz trasy, zmiana ekranu go zamyka")
  func historyRequest() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .terminal(termA)
    navigation.showTerminalHistory(termA)
    #expect(navigation.terminalHistory == TerminalHistoryRequest(terminalId: termA))
    navigation.closeTerminalHistory()
    #expect(navigation.terminalHistory == nil)
    navigation.showTerminalHistory(termA)
    navigation.detail = .session("v-new")
    #expect(navigation.terminalHistory == nil)
  }

  @Test("etykieta zakładki terminala ≤ 12 znaków")
  func titles() {
    #expect(UICopy.terminalTabLabel(entry(termA, slot: 1, proc: "bardzo-dluga-nazwa-procesu x")) == "bardzo-dluga")
  }
}

@Suite("terminal: historia")
struct TerminalHistoryModelTests {
  @Test("stany: tekst, pusto, brak terminala, zdanie serwera albo zapasowe")
  func phases() {
    let history = Sample.decode(TerminalHistory.self, #"{"text":"a\nb\n","truncated":true}"#)
    #expect(TerminalHistoryPhase(.loaded(history)) == .loaded(text: "a\nb\n", truncated: true))
    #expect(TerminalHistoryPhase(.loaded(history)).text == "a\nb\n")
    let empty = Sample.decode(TerminalHistory.self, #"{"text":"","truncated":false}"#)
    #expect(TerminalHistoryPhase(.loaded(empty)) == .empty && TerminalHistoryPhase(.loaded(empty)).text == nil)
    #expect(TerminalHistoryPhase(.gone) == .failed(UICopy.terminalHistoryGone))
    #expect(TerminalHistoryPhase(.failed("Gniazdo herdr nie odpowiada.")) == .failed("Gniazdo herdr nie odpowiada."))
    #expect(TerminalHistoryPhase(.failed(nil)) == .failed(UICopy.terminalHistoryFailed))
  }

  @Test("sufit: 1000 na start, „więcej” do 5000 tylko po ucięciu; stopka z odmianą i sufitem")
  func limits() {
    #expect(TerminalHistoryLimits.initial == 1000 && TerminalHistoryLimits.max == 5000)
    #expect(TerminalHistoryLimits.more(after: 1000, truncated: true) == 5000)
    #expect(TerminalHistoryLimits.more(after: 1000, truncated: false) == nil)
    #expect(TerminalHistoryLimits.more(after: 5000, truncated: true) == nil)
    #expect(UICopy.terminalHistoryFoot(text: "", truncated: false, limit: 1000) == "0 wierszy")
    #expect(UICopy.terminalHistoryFoot(text: "a\n", truncated: false, limit: 1000) == "1 wiersz")
    #expect(UICopy.terminalHistoryFoot(text: "a\nb\nc", truncated: false, limit: 1000) == "3 wiersze")
    #expect(UICopy.terminalHistoryFoot(text: "a\n\nb\n", truncated: false, limit: 1000) == "3 wiersze", "an empty line counts")
    let twelve = Array(repeating: "x", count: 12).joined(separator: "\n")
    #expect(UICopy.terminalHistoryFoot(text: twelve, truncated: true, limit: 1000) == "12 wierszy — ucięte do 1000\u{00A0}linii")
    let twentyTwo = Array(repeating: "x", count: 22).joined(separator: "\n")
    #expect(UICopy.terminalHistoryFoot(text: twentyTwo, truncated: false, limit: 1000) == "22 wiersze")
  }
}

@MainActor
@Suite("arkusze: jeden naraz — okna i formularze w jednym stanie")
struct AppSheetTests {
  private func standing() -> (RarogNavigation, AppState) {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("v-new")
    return (navigation, project())
  }

  @Test("okno zastępuje okno: skrót terminala nad diffem i historią, diff nad terminalem; każde otwarcie ma żeton")
  func windowReplacesWindow() throws {
    let (navigation, state) = standing()
    navigation.openDiff(sessionId: "v-new", path: "a.ts")
    guard case let .diff(first)? = navigation.sheet else { throw Missing.sheet }
    #expect(first.sessionId == "v-new" && first.path == "a.ts")
    navigation.openDiff(sessionId: "v-new", path: "a.ts")
    #expect(navigation.sheet?.id != first.id, "to samo otwarcie drugi raz to nowa prezentacja")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup == TerminalPopupRequest(cwd: willow, role: .popup), "Cmd+F nad diffem: okno terminala")
    let shell = try #require(navigation.sheet?.id)
    navigation.togglePopup(.lazygit, state: state)
    #expect(navigation.popup?.role == .lazygit && navigation.sheet?.id != shell, "drugi skrót: nowa prezentacja")
    navigation.showTerminalHistory(termA)
    #expect(navigation.popup == nil && navigation.terminalHistory == TerminalHistoryRequest(terminalId: termA))
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.terminalHistory == nil && navigation.popup?.role == .popup, "Cmd+F nad historią")
    navigation.openDiff(sessionId: "v-new", path: nil)
    #expect(navigation.popup == nil && navigation.sheet?.isWindow == true, "diff nad terminalem")
  }

  @Test("formularz trzyma: okno nie wchodzi w jego miejsce ani do kolejki; formularz zastępuje okno i formularz")
  func formHolds() throws {
    let (navigation, state) = standing()
    let presenter = NewSessionPresenter(navigation: navigation)
    navigation.togglePopup(.popup, state: state)
    presenter.openNewSession(cwd: willow)
    #expect(navigation.popup == nil && presenter.request?.cwd == willow, "formularz zastępuje okno")
    let form = try #require(navigation.sheet)
    #expect(form.isForm && !form.isWindow)
    navigation.togglePopup(.popup, state: state)
    navigation.togglePopup(.lazygit, state: project(term: false))
    navigation.openDiff(sessionId: "v-new", path: nil)
    navigation.showTerminalHistory(termA)
    #expect(navigation.sheet == form, "okno nie wchodzi w miejsce formularza")
    #expect(navigation.notice == nil, "skrót okna pod formularzem milczy, także zdaniem o wyłączonym terminalu")
    presenter.openRecent(cwd: willow)
    let recent = try #require(presenter.recent)
    #expect(presenter.request == nil && recent.cwd == willow, "formularz zastępuje formularz")
    presenter.close(recent)
    #expect(navigation.sheet == nil, "po zamknięciu formularza nic nie wyskakuje samo (pomiar 2026-10-12)")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup?.role == .popup, "skrót znów działa")
  }

  @Test("zmiana ekranu zamyka okno (terminal, historia, diff), formularza nie")
  func screenChange() {
    let (navigation, state) = standing()
    navigation.openDiff(sessionId: "v-new", path: nil)
    navigation.detail = .session("v-old")
    #expect(navigation.sheet == nil, "diff nie zostaje nad inną sesją")
    navigation.showTerminalHistory(termA)
    navigation.detail = .session("v-new")
    #expect(navigation.sheet == nil)
    navigation.togglePopup(.lazygit, state: state)
    navigation.detail = .session("p1")
    #expect(navigation.sheet == nil)
    let presenter = NewSessionPresenter(navigation: navigation)
    presenter.openNewSession()
    navigation.detail = .session("v-new")
    #expect(presenter.request != nil, "powiadomienie w trakcie wypełniania formularza go nie kasuje")
    presenter.openRecent(cwd: willow)
    navigation.detail = nil
    #expect(presenter.recent != nil)
  }

  @Test("zamknięcie adresowane żetonem: spóźnione zamknięcie starej prezentacji nie zamyka nowej")
  func addressedClose() throws {
    let (navigation, state) = standing()
    navigation.togglePopup(.popup, state: state)
    let old = try #require(navigation.sheet?.id)
    navigation.togglePopup(.lazygit, state: state)
    navigation.closeSheet(id: old)
    #expect(navigation.popup?.role == .lazygit, "`exit` zamkniętej powłoki nie zamyka lazygita")
    navigation.closeTerminalHistory()
    #expect(navigation.popup?.role == .lazygit, "zamknięcie historii nie dotyczy okna terminala")
    navigation.closeSheet(id: try #require(navigation.sheet?.id))
    #expect(navigation.sheet == nil)

    let presenter = NewSessionPresenter(navigation: navigation)
    presenter.openNewSession()
    let stale = try #require(presenter.request)
    presenter.openNewSession(cwd: willow)
    #expect(!presenter.isCurrent(stale), "wynik żądania należy do prezentacji, z której wyszedł")
    presenter.close(stale)
    navigation.closePopup()
    navigation.closeTerminalHistory()
    #expect(presenter.request?.cwd == willow, "nowy formularz stoi")
    let current = try #require(presenter.request)
    #expect(presenter.isCurrent(current))
    presenter.close(current)
    #expect(navigation.sheet == nil)
  }

  @Test("skróty pod arkuszem: menu wygaszone i naciśnięcie milczy; skrót okna działa nad oknem, nie nad formularzem")
  func shortcutsUnderSheet() {
    let state = project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("p1")
    navigation.noteVisit(state)
    navigation.detail = .session("v-new")
    navigation.noteVisit(state)
    let open = navigation.shortcutMenu(state)
    #expect(!open.tabs.isEmpty && open.lastTab != nil && open.canNewSession && open.canTerminal && open.canPopup)
    #expect(open.canToggleList && open.previousProject == "rarog")
    let silenced: [RarogShortcut] = [
      .tab(.session("v-old")), .previousProject, .newSession, .newTerminal, .toggleList, .toggleInspector,
      .toggleRead,
    ]
    #expect(silenced.allSatisfy(navigation.accepts) && navigation.accepts(.popup(.popup)), "bez arkusza wszystko działa")

    navigation.openDiff(sessionId: "v-new", path: nil)
    let window = navigation.shortcutMenu(state)
    #expect(window.tabs.isEmpty && window.lastTab == nil && !window.canNewSession && !window.canTerminal)
    #expect(!window.canToggleList && !window.canToggleInspector && window.previousProject == nil)
    #expect(window.canPopup, "Cmd+F i Cmd+G zastępują okno")
    #expect(!silenced.contains(where: navigation.accepts), "naciśnięcie milczy jak pozycja menu")
    #expect(navigation.accepts(.popup(.lazygit)))

    NewSessionPresenter(navigation: navigation).openNewSession()
    let form = navigation.shortcutMenu(state)
    #expect(form.tabs.isEmpty && !form.canNewSession && !form.canTerminal && !form.canToggleList)
    #expect(!form.canPopup, "nad formularzem skrót okna jest wygaszony")
    #expect(!silenced.contains(where: navigation.accepts))
  }

  @Test("zapis `nil` z wiązania zamyka arkusz, który stoi; zapis schodzącego arkusza nie rusza następnego")
  func bindingDismissal() throws {
    let (navigation, state) = standing()
    navigation.togglePopup(.popup, state: state)
    let shell = try #require(navigation.sheet?.id)
    navigation.sheetDismissed(shown: shell)
    #expect(navigation.sheet == nil, "gest zamyka stojące okno")
    navigation.togglePopup(.popup, state: state)
    let first = try #require(navigation.sheet?.id)
    navigation.togglePopup(.lazygit, state: state)
    navigation.sheetDismissed(shown: first)
    #expect(navigation.popup?.role == .lazygit, "na ekranie stoi jeszcze poprzednie okno: nowe zostaje")
    navigation.sheetDismissed(shown: nil)
    #expect(navigation.sheet == nil, "bez wiedzy, co stoi, zapis zamyka bieżący arkusz")
    navigation.sheetDismissed(shown: first)
    #expect(navigation.sheet == nil)
  }

  @Test("diff bez swojej sesji schodzi przy świeżej liście; lista z pamięci i niewczytana niczego nie zamyka")
  func orphanedDiff() throws {
    let (navigation, state) = standing()
    navigation.openDiff(sessionId: "v-new", path: nil)
    let diff = try #require(navigation.sheet?.id)
    #expect(navigation.orphanedSheet(state) == nil, "sesja jest na liście")
    var gone = state
    gone.sessions["v-new"] = nil
    #expect(navigation.orphanedSheet(gone) == diff, "sesję zamknięto gdzie indziej")
    var loading = gone
    loading.sessionsLoaded = false
    #expect(navigation.orphanedSheet(loading) == nil, "lista jeszcze niewczytana")
    var stale = gone
    stale.listCache.staleSince = Sample.now
    #expect(stale.listStale && navigation.orphanedSheet(stale) == nil, "lista z pamięci podręcznej")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.popup != nil && navigation.orphanedSheet(gone) == nil, "okno terminala należy do projektu")
    NewSessionPresenter(navigation: navigation).openNewSession()
    #expect(navigation.orphanedSheet(gone) == nil)
  }

  @Test("wylogowanie zdejmuje arkusz, trasa zostaje")
  func signedOut() {
    let (navigation, _) = standing()
    NewSessionPresenter(navigation: navigation).openNewSession(cwd: willow)
    navigation.dropSheet()
    #expect(navigation.sheet == nil && navigation.detail == .session("v-new"))
  }

  @Test("Settings on a page: closed opens the sheet on the page; open changes only the page, never a new sheet")
  func settingsPage() async throws {
    let (navigation, state) = standing()
    navigation.openSettings(page: .pairing)
    let sheet = try #require(navigation.settingsSheet)
    #expect(navigation.settingsPage == .pairing)
    navigation.openSettings(page: nil)
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == nil, "nil goes back to the list")
    navigation.openSettings(page: .server)
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == .server, "from the list: at once")
    navigation.openSettings(page: .server)
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == .server, "the same page: no change")
    navigation.togglePopup(.popup, state: state)
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == .server, "a window does not replace it")
  }

  @Test("another page stands: nil first, the new page after a main queue turn")
  func settingsPageSwap() async throws {
    let (navigation, _) = standing()
    navigation.openSettings(page: .server)
    let sheet = try #require(navigation.settingsSheet)
    navigation.openSettings(page: .pairing)
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == nil, "first step: back to the list")
    await mainQueueTurn()
    #expect(navigation.settingsSheet == sheet && navigation.settingsPage == .pairing, "second step: the new page")
  }

  @Test("the second step is dropped when Settings closed meanwhile; the last request wins")
  func settingsPageSwapSuperseded() async throws {
    let (navigation, _) = standing()
    navigation.openSettings(page: .server)
    let sheet = try #require(navigation.settingsSheet)
    navigation.openSettings(page: .pairing)
    navigation.closeSheet(id: sheet.id)
    await mainQueueTurn()
    #expect(navigation.sheet == nil && navigation.settingsPage == nil, "closed between the steps")

    navigation.openSettings(page: .server)
    navigation.openSettings(page: .pairing)
    navigation.openSettings(page: .about)
    #expect(navigation.settingsPage == nil, "a request before the turn keeps the first step, no swap in one update")
    await mainQueueTurn()
    #expect(navigation.settingsPage == .about, "the last request wins")

    navigation.openSettings(page: .pairing)
    navigation.openSettings(page: nil)
    await mainQueueTurn()
    #expect(navigation.settingsPage == nil, "the list asked after the swap stays")
  }

  @Test("closing Settings clears the page: by token, by the binding, on logout, and when a form replaces it")
  func settingsPageCleared() throws {
    let (navigation, _) = standing()
    navigation.openSettings(page: .about)
    navigation.closeSheet(id: try #require(navigation.settingsSheet).id)
    #expect(navigation.settingsPage == nil)
    navigation.openSettings(page: .about)
    navigation.sheetDismissed(shown: nil)
    #expect(navigation.settingsPage == nil)
    navigation.openSettings(page: .about)
    navigation.dropSheet()
    #expect(navigation.settingsPage == nil)
    navigation.openSettings(page: .about)
    NewSessionPresenter(navigation: navigation).openNewSession()
    #expect(navigation.settingsSheet == nil && navigation.settingsPage == nil)
    navigation.openSettings()
    #expect(navigation.settingsSheet != nil && navigation.settingsPage == nil, "a new sheet opens on the list")
  }

  /// Waits until the main queue has run every block queued before this call.
  private func mainQueueTurn() async {
    await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
  }

  private enum Missing: Error { case sheet }
}
