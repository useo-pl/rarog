import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Projekty, zakładki i pamięć nawigacji.

private let base = Date(timeIntervalSince1970: 1_790_000_000)

/// Sesja z katalogiem `cwd` (Frames.summary składa `/Users/demo/<title>`).
private func summary(
  _ id: String, project: String, state: String = "waiting-input", created: String = "2026-10-03T08:00:00.000Z",
  activity: String = "2026-10-03T08:00:00.000Z", extra: String = ""
) -> String {
  Frames.summary(id, state: state, title: project, createdAt: created, lastActivityAt: activity, extra: extra)
}

private func state(_ summaries: [String], herdr: String? = nil) throws -> AppState {
  var state = AppState(clientBuild: 7)
  let extra = herdr.map { #","herdrStatus":\#($0)"# } ?? ""
  play(&state, [try Frames.snapshot(summaries, extra: extra)], at: base)
  return state
}

private func recent(_ entries: [(String, String)]) throws -> [RecentProject] {
  let items = entries.map { #"{"cwd":"\#($0.0)","mtime":"\#($0.1)"}"# }.joined(separator: ",")
  return try JSONDecoder().decode(RecentProjectList.self, from: Data(#"{"projects":[\#(items)]}"#.utf8)).projects
}

private func terminal(
  _ id: String, cwd: String, slot: Int, proc: String = "zsh", role: String = "shell"
) -> TerminalListEntry {
  let json = #"{"id":"\#(id)","cwd":"\#(cwd)","live":true,"slot":\#(slot),"proc":"\#(proc)","role":"\#(role)"}"#
  return try! JSONDecoder().decode(TerminalListEntry.self, from: Data(json.utf8))
}

private func capabilities(term: Bool) throws -> Capabilities {
  let json = #"{"version":"1","protocolVersion":3,"serverStartId":"s","termEnabled":\#(term)}"#
  return Capabilities(try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8)))
}

private let utc: Calendar = {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  return calendar
}()

@Suite("projekty: sekcja PROJEKTY, cel wejścia, zakładki, zamknięcie")
struct ProjectSelectorTests {
  @Test("kolejność: doba aktywności malejąco, w dobie alfabet polski z liczbami, remis po ścieżce")
  func ordering() throws {
    let state = try state([
      summary("a", project: "rarog10", activity: "2026-10-03T09:00:00.000Z"),
      summary("b", project: "rarog2", activity: "2026-10-03T07:00:00.000Z"),
      summary("c", project: "ćma", activity: "2026-10-03T08:30:00.000Z"),
      summary("d", project: "dawny", activity: "2026-10-01T23:59:00.000Z"),
      summary("e", project: "cebula", activity: "2026-10-03T00:01:00.000Z"),
    ])
    #expect(state.projectGroups(calendar: utc).map(\.name) == ["cebula", "ćma", "rarog2", "rarog10", "dawny"])
  }

  @Test("projekt z historii CLI bez sesji nie stoi w liście, zostaje w katalogu dla okna nowej sesji")
  func recentWithoutSessionStaysOut() throws {
    var state = try state([summary("a", project: "willow", activity: "2026-10-03T09:00:00.000Z")])
    state.apply(.catalog(.recentProjectsLoaded(try recent([
      ("/Users/demo/willow/", "2026-10-03T10:00:00.000Z"),
      ("/Users/demo/stary", "2026-10-02T10:00:00.000Z"),
      ("/Users/demo/nowy", "2026-10-03T11:00:00.000Z"),
    ]), at: base)), now: base)
    let groups = state.projectGroups(calendar: utc)
    #expect(groups.map(\.cwd) == ["/Users/demo/willow"])
    #expect(groups.allSatisfy { !$0.sessions.isEmpty }, "każdy projekt listy ma sesję")
    #expect(groups.first?.activityAt == ISOTime.parse("2026-10-03T09:00:00.000Z"), "aktywność z sesji, nie z mtime")
    #expect(state.catalog.recent.map(\.cwd) == ["/Users/demo/willow/", "/Users/demo/stary", "/Users/demo/nowy"])
  }

  @Test("zamknięcie ostatniej sesji zdejmuje projekt w tej samej ramce listy; nowa sesja go przywraca")
  func lastSessionClosedThenReopened() throws {
    var state = try state([
      summary("a", project: "willow", activity: "2026-10-03T09:00:00.000Z"),
      summary("b", project: "atlas", activity: "2026-10-03T08:00:00.000Z"),
    ])
    state.apply(.catalog(.recentProjectsLoaded(try recent([
      ("/Users/demo/willow", "2026-10-03T10:00:00.000Z"),
      ("/Users/demo/atlas", "2026-10-03T08:00:00.000Z"),
    ]), at: base)), now: base)
    #expect(state.projectGroups(calendar: utc).map(\.cwd) == ["/Users/demo/atlas", "/Users/demo/willow"])

    // Serwer po zamknięciu sesji wysyła pełny stan listy bez niej (`sessions-snapshot` managera).
    play(&state, [try Frames.snapshot([summary("b", project: "atlas", activity: "2026-10-03T08:00:00.000Z")])], at: base)
    #expect(state.projectGroups(calendar: utc).map(\.cwd) == ["/Users/demo/atlas"], "katalog z historii nie wraca")
    #expect(state.catalog.recent.map(\.cwd).contains("/Users/demo/willow"), "okno nowej sesji dalej go ma")

    play(&state, [try Frames.sessionChanged(summary("c", project: "willow", activity: "2026-10-03T11:00:00.000Z"))],
         at: base)
    let groups = state.projectGroups(calendar: utc)
    #expect(groups.map(\.cwd) == ["/Users/demo/atlas", "/Users/demo/willow"])
    #expect(groups.last?.sessions.map(\.id) == ["c"])
  }

  @Test("ton licznika = najpilniejszy stan grupy; git z tej samej sesji co gałąź")
  func toneAndGit() throws {
    let state = try state([
      summary("idle", project: "p", extra: #","seen":true,"branch":"main","ahead":3"#),
      summary("run", project: "p", state: "running", extra: #","branch":"","behind":9"#),
      summary("ask", project: "q", state: "waiting-permission"),
      summary("err", project: "q", state: "error"),
    ])
    let groups = Dictionary(uniqueKeysWithValues: state.projectGroups(calendar: utc).map { ($0.name, $0) })
    #expect(groups["p"]?.tone == .working)
    #expect(groups["q"]?.tone == .failed)
    #expect(groups["p"]?.git == ProjectGit(branch: "main", ahead: 3, behind: nil))
  }

  @Test("ton licznika: czekanie na zadanie w tle bije ciszę, praca bije czekanie na zadanie w tle")
  func backgroundWaitGroupTone() throws {
    let monitor = #","backgroundTasks":[{"id":"m","kind":"monitor","description":"log"}]"#
    let state = try state([
      summary("idle", project: "p", extra: #","seen":true"#),
      summary("bg", project: "p", state: "done", extra: monitor),
      summary("bg2", project: "q", state: "done", extra: monitor),
      summary("run", project: "q", state: "running"),
      summary("bg3", project: "r", extra: #","seen":true"# + monitor),
      summary("new", project: "r"),
    ])
    let groups = Dictionary(uniqueKeysWithValues: state.projectGroups(calendar: utc).map { ($0.name, $0) })
    #expect(groups["p"]?.tone == .backgroundWait)
    #expect(groups["q"]?.tone == .working)
    #expect(groups["r"]?.tone == .unread)
  }

  @Test("zakładki od najstarszej; cel: zapamiętana żywa → ostatnio aktywna → ekran projektu")
  func tabsAndTarget() throws {
    let state = try state([
      summary("young", project: "p", created: "2026-10-03T09:00:00.000Z", activity: "2026-10-03T09:30:00.000Z"),
      summary("old", project: "p", created: "2026-10-03T07:00:00.000Z", activity: "2026-10-03T10:00:00.000Z"),
    ])
    #expect(state.projectTabs("/Users/demo/p").map(\.id) == ["old", "young"])
    #expect(state.projectTarget("/Users/demo/p", remembered: .session("young")) == .session("young"))
    #expect(state.projectTarget("/Users/demo/p", remembered: .session("zamknieta")) == .session("old"))
    #expect(state.projectTarget("/Users/demo/p/", remembered: nil) == .session("old"))
    #expect(state.projectTarget("/Users/demo/pusty", remembered: .session("x")) == .empty(cwd: "/Users/demo/pusty"))
    #expect(state.projectJumpTarget("/Users/demo/pusty", remembered: nil) == nil)
    #expect(state.projectJumpTarget("/Users/demo/p", remembered: nil) == .session("old"))
  }

  @Test("terminale: pasek = sesje, potem terminale po slotach; Codex w terminalu bez własnej zakładki")
  func terminalStrip() throws {
    var state = try state([
      summary("claude", project: "p", created: "2026-10-03T07:00:00.000Z"),
      summary("codex", project: "p", created: "2026-10-03T06:00:00.000Z",
              extra: #","engine":"codex","termId":"00000000000000b2""#),
      summary("codex-luzem", project: "p", created: "2026-10-03T08:00:00.000Z", extra: #","engine":"codex""#),
    ])
    let entries = [
      terminal("00000000000000b2", cwd: "/Users/demo/p", slot: 2, proc: "codex"),
      terminal("00000000000000a1", cwd: "/Users/demo/p/", slot: 1, proc: "nvim"),
      terminal("00000000000000c0", cwd: "/Users/demo/p", slot: 0, proc: "lazygit", role: "lazygit"),
      terminal("00000000000000d1", cwd: "/Users/demo/q", slot: 1, proc: "zsh"),
    ]
    state.apply(.terminals(.loaded(entries, at: base)), now: base)
    // Kolejność całego paska (sesje, potem terminale) sprawdza `projectTabModels` w RarogUI (TerminalNavigationTests).
    #expect(state.projectTabs("/Users/demo/p").isEmpty == false)
    #expect(state.projectTerminals("/Users/demo/p").isEmpty, "bez sondy wersji terminal jest nieznany: zero zakładek")
    #expect(state.terminalFeature == .unknown)
    state.capabilities = try capabilities(term: true)
    #expect(state.terminalFeature == .on)
    #expect(state.projectTabs("/Users/demo/p").map(\.id) == ["claude", "codex-luzem"],
            "sesje od najstarszej, Codex z termId bez zakładki")
    #expect(state.projectTerminals("/Users/demo/p").map(\.id) == ["00000000000000a1", "00000000000000b2"],
            "terminale po slotach, bez okna lazygita i obcego projektu")
    #expect(state.hostTerminal(ofSession: "codex") == "00000000000000b2")
    #expect(state.hostTerminal(ofSession: "codex-luzem") == nil)
    #expect(state.hostTerminal(ofSession: "claude") == nil)
    #expect(state.hostedSession(inTerminal: "00000000000000b2") == "codex")
    #expect(state.hostedSession(inTerminal: "00000000000000a1") == nil, "goła powłoka")
    #expect(state.projectCwd(ofTerminal: "00000000000000a1") == "/Users/demo/p")
    state.capabilities = try capabilities(term: false)
    #expect(state.terminalFeature == .off)
    #expect(state.projectTerminals("/Users/demo/p").isEmpty, "wyłączony terminal: ostatnia lista nie rysuje zakładek")
  }

  @Test("okno Cmd+F/Cmd+G: panel z listy po katalogu znormalizowanym i roli, tylko przy `termEnabled`")
  func projectPopupTerminal() throws {
    var state = try state([summary("s", project: "p")])
    let entries = [
      terminal("00000000000000a1", cwd: "/Users/demo/p", slot: 1),
      terminal("00000000000000f0", cwd: "/Users/demo/p/", slot: 0, role: "popup"),
      terminal("00000000000000c0", cwd: "/Users/demo/p", slot: 0, proc: "lazygit", role: "lazygit"),
      terminal("00000000000000f1", cwd: "/Users/demo/q", slot: 0, role: "popup"),
    ]
    state.apply(.terminals(.loaded(entries, at: base)), now: base)
    #expect(state.projectPopupTerminal("/Users/demo/p", role: .popup) == nil, "bez sondy wersji terminal jest nieznany")
    state.capabilities = try capabilities(term: true)
    #expect(state.projectPopupTerminal("/Users/demo/p", role: .popup)?.id == "00000000000000f0", "ukośnik na końcu")
    #expect(state.projectPopupTerminal("/Users/demo/p//", role: .popup)?.id == "00000000000000f0")
    #expect(state.projectPopupTerminal("/Users/demo/p", role: .lazygit)?.id == "00000000000000c0")
    #expect(state.projectPopupTerminal("/Users/demo/q", role: .popup)?.id == "00000000000000f1")
    #expect(state.projectPopupTerminal("/Users/demo/q", role: .lazygit) == nil)
    #expect(state.projectPopupTerminal("/Users/demo/p", role: .shell) == nil, "powłoka taba to nie okno")
    #expect(state.projectPopupTerminal("/Users/demo", role: .popup) == nil, "katalog nadrzędny to inny projekt")
    state.capabilities = try capabilities(term: false)
    #expect(state.projectPopupTerminal("/Users/demo/p", role: .popup) == nil, "wyłączony terminal: ostatnia lista nie liczy się")
  }

  @Test("terminale: cel wejścia z zapamiętanym terminalem tylko, gdy lista go zna; Cmd+L też do terminala")
  func terminalTarget() throws {
    var state = try state([summary("s", project: "p")])
    state.capabilities = try capabilities(term: true)
    let known = "00000000000000a1"
    #expect(state.projectTarget("/Users/demo/p", remembered: .terminal(known)) == .session("s"), "lista w drodze")
    state.apply(.terminals(.loaded([terminal(known, cwd: "/Users/demo/p", slot: 1)], at: base)), now: base)
    #expect(state.projectTarget("/Users/demo/p", remembered: .terminal(known)) == .terminal(known))
    #expect(state.projectJumpTarget("/Users/demo/p", remembered: .terminal(known)) == .terminal(known))
    #expect(state.projectTarget("/Users/demo/q", remembered: .terminal(known)) == .empty(cwd: "/Users/demo/q"),
            "terminal innego projektu nie jest celem")
  }

  @Test("terminale: wejście w projekt widzi Codexa w terminalu (jedyny, najświeższy, zapamiętany)")
  func codexProjectTarget() throws {
    let codex = #","engine":"codex","termId":"00000000000000a1""#
    let only = try state([summary("cx", project: "c", extra: codex)])
    #expect(only.projectTabs("/Users/demo/c").isEmpty, "własnej zakładki nie ma")
    #expect(only.projectTarget("/Users/demo/c", remembered: nil) == .session("cx"), "projekt z Codexem nie jest pusty")
    let mixed = try state([
      summary("old", project: "p", activity: "2026-10-03T08:00:00.000Z"),
      summary("cx", project: "p", activity: "2026-10-03T11:00:00.000Z", extra: codex),
    ])
    #expect(mixed.projectTarget("/Users/demo/p", remembered: nil) == .session("cx"), "ostatnio aktywny to Codex")
    #expect(mixed.projectTarget("/Users/demo/p", remembered: .session("cx")) == .session("cx"), "zapamiętany wpis")
  }

  @Test("Claude uruchomiony w terminalu Raroga: bez własnej zakładki, terminal jego ekranem")
  func claudeInTerminal() throws {
    let hosted = #","termId":"00000000000000a1""#
    var state = try state([
      summary("rarog", project: "p", created: "2026-10-03T07:00:00.000Z", activity: "2026-10-03T08:00:00.000Z"),
      summary("reczny", project: "p", created: "2026-10-03T06:00:00.000Z", activity: "2026-10-03T11:00:00.000Z",
              extra: hosted),
    ])
    state.capabilities = try capabilities(term: true)
    state.apply(.terminals(.loaded([
      terminal("00000000000000a1", cwd: "/Users/demo/p", slot: 1, proc: "claude"),
    ], at: base)), now: base)
    #expect(state.projectTabs("/Users/demo/p").map(\.id) == ["rarog"], "sesja z terminala nie ma zakładki")
    #expect(state.projectTerminals("/Users/demo/p").map(\.id) == ["00000000000000a1"], "jego zakładką jest terminal")
    #expect(state.projectSessions("/Users/demo/p").map(\.id) == ["reczny", "rarog"], "na liście agentów zostaje")
    #expect(state.hostTerminal(ofSession: "reczny") == "00000000000000a1")
    #expect(state.hostTerminal(ofSession: "rarog") == nil, "sesja założona z Raroga ma swój ekran")
    #expect(state.hostedSession(inTerminal: "00000000000000a1") == "reczny")
    #expect(state.projectTarget("/Users/demo/p", remembered: nil) == .session("reczny"), "ostatnio aktywna")
    #expect(state.terminalExitSession(cwd: "/Users/demo/p", closedTerminal: "00000000000000a1") == "rarog",
            "po „×” terminala jego agent odpada z celu powrotu")
    #expect(state.sessions["reczny"]?.canClose == true)
    // Strumień transkryptu: sesja z własnym ekranem i sesja jeszcze nieznana liście — tak; agent w terminalu — nie.
    #expect(state.transcriptTarget("rarog") == "rarog")
    #expect(state.transcriptTarget("reczny") == nil)
    #expect(state.transcriptTarget("zakladana") == "zakladana")
    #expect(state.transcriptTarget(nil) == nil)
    #expect(state.sessions["reczny"]?.showsTranscript == false)
  }

  @Test("terminale: po „×” terminala — ostatnio aktywna sesja projektu, inaczej inna sesja, inaczej lista")
  func terminalExit() throws {
    let empty = try state([])
    let state = try state([
      summary("p-old", project: "p", activity: "2026-10-03T08:00:00.000Z"),
      summary("p-codex", project: "p", activity: "2026-10-03T11:00:00.000Z",
              extra: #","engine":"codex","termId":"00000000000000a1""#),
      summary("q-new", project: "q", activity: "2026-10-03T12:00:00.000Z"),
    ])
    #expect(state.terminalExitSession(cwd: "/Users/demo/p", closedTerminal: "00000000000000a1") == "p-old",
            "Codex stojący w zamkniętym terminalu odpada")
    #expect(state.terminalExitSession(cwd: "/Users/demo/p", closedTerminal: "00000000000000ff") == "p-codex")
    #expect(state.terminalExitSession(cwd: "/Users/demo/pusty", closedTerminal: "x") == "q-new", "inna sesja")
    #expect(state.terminalExitSession(cwd: nil, closedTerminal: "x") == "q-new")
    #expect(empty.terminalExitSession(cwd: "/Users/demo/p", closedTerminal: "x") == nil, "lista")
  }

  @Test("po zamknięciu: ostatnio aktywna siostra Claude, bez Codexa i bez zamykanej; brak = lista")
  func closeReturn() throws {
    let state = try state([
      summary("closing", project: "p", activity: "2026-10-03T11:00:00.000Z"),
      summary("codex", project: "p", activity: "2026-10-03T10:00:00.000Z", extra: #","engine":"codex""#),
      summary("sister", project: "p", activity: "2026-10-03T09:00:00.000Z"),
      summary("alone", project: "q"),
    ])
    #expect(state.closeReturnSession("closing") == "sister")
    #expect(state.closeReturnSession("alone") == nil)
    #expect(state.closeReturnSession("nieznana") == nil)
  }

  @Test("„×” nie istnieje dla Codexa, nieznanego silnika i sesji nieobsługiwanej; done usuwa kartę")
  func closeRules() throws {
    let state = try state([
      summary("claude", project: "p"),
      summary("done", project: "p", state: "done"),
      summary("codex", project: "p", extra: #","engine":"codex""#),
      summary("obcy", project: "p", extra: #","engine":"gemini""#),
      summary("dziwny", project: "p", state: "przyszly-stan"),
    ])
    #expect(state.sessions["claude"]?.canClose == true)
    #expect(state.sessions["done"]?.closeForgetsCard == true)
    #expect(state.sessions["claude"]?.closeForgetsCard == false)
    for id in ["codex", "obcy", "dziwny"] { #expect(state.sessions[id]?.canClose == false, "\(id)") }
  }

  @Test("bramka zakładania: brak herdr = wolno; canLaunch false = blokada ze zdaniem serwera")
  func launchGate() throws {
    #expect(try state([]).launchBlocked == false)
    let open = try state([], herdr: #"{"available":true,"agentCount":1,"readOnly":false,"canLaunch":true}"#)
    #expect(!open.launchBlocked && open.launchBlockedDetail == nil)
    let closed = try state([], herdr: #"""
      {"available":true,"agentCount":1,"readOnly":false,"canLaunch":false,"detail":"Limit paneli Raroga."}
      """#)
    #expect(closed.launchBlocked && closed.launchBlockedDetail == "Limit paneli Raroga.")
  }

  @Test("wylogowanie kasuje ostatnie projekty razem z obrazem listy")
  func logoutClears() throws {
    var state = try state([summary("a", project: "p")])
    state.apply(.catalog(.recentProjectsLoaded(try recent([("/x", "2026-10-03T10:00:00.000Z")]), at: base)), now: base)
    #expect(state.catalog.recent.count == 1)
    state.apply(.loggedOut(.deviceUnknown), now: base)
    #expect(state.catalog == CatalogState())
  }
}

@Suite("pamięć nawigacji: zakładka projektu i historia Cmd+L")
struct ProjectMemoryTests {
  @Test("zakładka projektu: ostatni wpis wygrywa, sufit 32 wyrzuca najdawniej UŻYTY")
  func tabMemory() {
    var memory = ProjectTabMemory()
    let first = memory.note(cwd: "/a", sessionId: "s1")
    let repeated = memory.note(cwd: "/a", sessionId: "s1")
    #expect(first)
    #expect(!repeated, "powtórzenie nic nie zapisuje")
    memory.note(cwd: "/a", sessionId: "s2")
    #expect(memory.remembered(cwd: "/a") == .session("s2"))
    for index in 0..<31 { memory.note(cwd: "/p\(index)", sessionId: "x") }
    memory.note(cwd: "/a", sessionId: "s3")  // użyty — przesuwa się na koniec
    memory.note(cwd: "/nowy", sessionId: "y")
    #expect(memory.entries.count == ProjectTabMemory.capacity)
    #expect(memory.remembered(cwd: "/a") == .session("s3"))
    #expect(memory.remembered(cwd: "/p0") == nil, "najdawniej użyty wypadł")
  }

  @Test("historia: bez duplikatów, sufit 16, cel pomija bieżący i martwe; dwa naciśnięcia wracają")
  func history() {
    var history = ProjectHistory()
    for cwd in ["/a", "/b", "/c", "/b"] { history.note(cwd) }
    #expect(history.cwds == ["/a", "/c", "/b"])
    #expect(history.previous(current: "/b") { _ in true } == "/c")
    #expect(history.previous(current: "/b") { $0 != "/c" } == "/a", "martwy pominięty")
    #expect(history.previous(current: nil) { _ in true } == "/b", "z listy: ostatnio odwiedzony")
    history.note("/c")
    #expect(history.previous(current: "/c") { _ in true } == "/b", "drugie Cmd+L wraca")
    for index in 0..<20 { history.note("/p\(index)") }
    #expect(history.cwds.count == ProjectHistory.capacity)
    #expect(history.previous(current: "/p19") { _ in false } == nil)
  }

  @Test("odczyt z magazynu: uszkodzony wpis = brak pamięci; nieznany effort przepada")
  func decoding() throws {
    let store = MemoryPreferences()
    store.set(Data("nie json".utf8), forKey: NavigationPreferences.projectHistory)
    #expect(NavigationPreferences.load(ProjectHistory.self, key: NavigationPreferences.projectHistory, from: store) == nil)
    var history = ProjectHistory()
    history.note("/a")
    NavigationPreferences.save(history, key: NavigationPreferences.projectHistory, to: store)
    #expect(NavigationPreferences.load(ProjectHistory.self, key: NavigationPreferences.projectHistory, from: store) == history)
    let defaults = try JSONDecoder().decode(NewSessionDefaults.self, from: Data(#"{"model":"fable","effort":"ultra"}"#.utf8))
    #expect(defaults == NewSessionDefaults(model: "fable", effort: nil))
    let tabs = try JSONDecoder().decode(ProjectTabMemory.self, from: Data(#"{"entries":[{"cwd":"","sessionId":"x"}]}"#.utf8))
    #expect(tabs.entries.isEmpty)
  }

  @Test("zakładka-terminal: zapis z `terminalId`, wpis bez `terminalId` czyta się bez zmian, zły wpis nie kasuje reszty")
  func terminalTabMemory() throws {
    var memory = ProjectTabMemory()
    memory.note(cwd: "/a", tab: .terminal("00000000000000a1"))
    memory.note(cwd: "/b", sessionId: "s1")
    let data = try JSONEncoder().encode(memory)
    let json = try #require(String(data: data, encoding: .utf8))
    #expect(json.contains(#""terminalId":"00000000000000a1""#) && json.contains(#""sessionId":"s1""#))
    #expect(try JSONDecoder().decode(ProjectTabMemory.self, from: data) == memory)
    let legacy = try JSONDecoder().decode(ProjectTabMemory.self, from: Data(#"""
      {"entries":[{"cwd":"/x","sessionId":"stara"},{"cwd":"/y"},7,{"cwd":"/z","terminalId":"00000000000000b2"}]}
      """#.utf8))
    #expect(legacy.remembered(cwd: "/x") == .session("stara"), "wpis z samym `sessionId`")
    #expect(legacy.remembered(cwd: "/z") == .terminal("00000000000000b2"), "wpisy po uszkodzonych zostają")
    #expect(legacy.entries.count == 2)
  }
}

@MainActor
@Suite("magazyn: katalog projektów, nowa sesja, zamknięcie")
struct StoreCatalogTests {
  private func loggedIn(
    herdr: String = #"{"available":true,"agentCount":1,"readOnly":false,"canLaunch":true}"#,
    sessions: [String] = []
  ) async -> (RarogStore, FakeTransport) {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"""
      {"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))],"herdrStatus":\#(herdr)}
      """#)
    await until("lista") { store.state.sessionsLoaded && store.state.compat == .ok }
    return (store, transport)
  }

  @Test("ostatnie projekty: odczyt raz na minutę, wymuszenie omija dławik, 401 wylogowuje")
  func recent() async throws {
    let (store, transport) = await loggedIn()
    transport.set { $0.recentProjects = try? JSONDecoder().decode(
      RecentProjectList.self, from: Data(#"{"projects":[{"cwd":"/x","mtime":"t"}]}"#.utf8)) }
    await store.refreshRecentProjects()
    #expect(store.state.catalog.recent.map(\.cwd) == ["/x"])
    await store.refreshRecentProjects()
    #expect(transport.read(\.recentCalls) == 1)
    await store.refreshRecentProjects(force: true)
    #expect(transport.read(\.recentCalls) == 2)
    transport.set { $0.recentResult = .unauthorized(APIFailure(status: 401)) }
    await store.refreshRecentProjects(force: true)
    #expect(store.state.auth == .loggedOut(.deviceUnknown))
  }

  @Test("nowa sesja: model i effort z pamięci; nieznany model → drugi raz na domyślnym koncie")
  func create() async throws {
    let (store, transport) = await loggedIn()
    let defaults = NewSessionDefaults(model: "opus[1m]", effort: .xhigh)
    #expect(await store.createSession(in: "/x", defaults: defaults) == .created(sessionId: "new-1", trustPrompt: false))
    #expect(transport.read(\.created).last == CreateSessionBody(cwd: "/x", model: "opus[1m]", effort: .xhigh))
    #expect(transport.read(\.created).last?.ultracode == nil, "„+” i Cmd+N nigdy z ultracode")

    transport.set { $0.createResults = [
      .failure(.http(APIFailure(status: 400, code: "model-unknown", message: "Ten model nie jest dostępny."))),
      .success("w0:d4"),
    ] }
    #expect(await store.createSession(in: "/x", defaults: defaults) == .created(sessionId: "w0:d4", trustPrompt: false))
    #expect(transport.read(\.created).suffix(2) == [
      CreateSessionBody(cwd: "/x", model: "opus[1m]", effort: .xhigh), CreateSessionBody(cwd: "/x"),
    ])
  }

  @Test("nowa sesja: blokada zakładania nic nie wysyła; odmowa serwera wraca jego zdaniem")
  func createRefused() async throws {
    let (blocked, blockedTransport) = await loggedIn(
      herdr: #"{"available":true,"agentCount":6,"readOnly":false,"canLaunch":false,"detail":"Limit paneli."}"#)
    #expect(await blocked.createSession(in: "/x", defaults: NewSessionDefaults()) == .blocked("Limit paneli."))
    #expect(blockedTransport.read(\.created).isEmpty)

    let (store, transport) = await loggedIn()
    transport.set { $0.createResults = [.failure(.rateLimited(APIFailure(status: 429, message: "Za szybko.")))] }
    #expect(await store.createSession(in: "/x", defaults: NewSessionDefaults()) == .refused("Za szybko."))
    transport.set { $0.createResults = [.failure(.offline(.notConnectedToInternet))] }
    #expect(await store.createSession(in: "/x", defaults: NewSessionDefaults()) == .offline)
  }

  @Test("zamknięcie: closePanel true; Codex nic nie wysyła; 409 ze zdaniem serwera")
  func close() async throws {
    let (store, transport) = await loggedIn(sessions: [
      Frames.summary("s1", title: "p"), Frames.summary("cx", title: "p", extra: #","engine":"codex""#),
    ])
    #expect(await store.closeSession("s1") == .closed)
    #expect(transport.read { $0.closed.map(\.body) } == [CloseSessionBody(closePanel: true)])
    #expect(await store.closeSession("cx") == .notAllowed)
    #expect(transport.read { $0.closed.count } == 1)
    transport.set { $0.closeResult = .http(APIFailure(status: 409, code: "bad-state", message: "herdr nie odpowiada.")) }
    #expect(await store.closeSession("s1") == .refused("herdr nie odpowiada."))
  }
}
