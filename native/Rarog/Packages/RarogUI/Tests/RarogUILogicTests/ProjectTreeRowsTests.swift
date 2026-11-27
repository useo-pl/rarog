import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Drzewo projektów na liście: wiersze (nagłówek i agent bez członu projektu) i tokeny nagłówka na tle kolumny.
// Właściciel: lista.

private let willow = "/Users/demo/Projects/willow"

/// willow: czekająca na zgodę i dwie ciche (jedna bez etykiety); Rarog pracuje.
@MainActor
private func state() -> AppState {
  var state = AppState(clientBuild: 1)
  let sessions = [
    Sample.session(id: "v-ask", title: "willow", label: "zapis", state: "waiting-permission", createdAgo: 9000),
    Sample.session(id: "v-done", title: "willow", label: "parser dat", state: "done", createdAgo: 6000),
    Sample.session(id: "abcdef12", title: "willow", label: nil, state: "waiting-input", extra: #""seen":true"#,
                   createdAgo: 3000),
    Sample.session(id: "p1", title: "rarog", label: "resync", state: "running", extra: #""branch":"main","ahead":2"#,
                   createdAgo: 600),
  ]
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  return state
}

@MainActor
@Suite("drzewo projektów: wiersze listy")
struct ProjectTreeRowsTests {
  @Test("nagłówki jak karta PROJEKTY, agenci bez członu projektu; bez etykiety — `#abcd` jak zakładka")
  func rows() throws {
    let rows = state().projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: willow, jumpCwd: nil)
    #expect(rows.map(\.id) == [
      .project("/Users/demo/Projects/rarog"), .session("p1"),
      .project(willow), .session("v-ask"), .session("v-done"), .session("abcdef12"),
    ])
    guard case let .header(rarog) = rows[0], case let .header(notes) = rows[2] else {
      Issue.record("oczekiwane nagłówki")
      return
    }
    #expect(rarog.row.branch == "main" && rarog.row.ahead == 2 && rarog.row.tone == .working)
    #expect(notes.row.open && notes.row.agents == 3 && notes.row.tone == .waiting, "licznik w kolorze najpilniejszego")
    let titles = rows.compactMap { row -> String? in
      if case let .session(session) = row { return session.showsProject ? nil : session.treeTitle }
      return nil
    }
    #expect(titles == ["resync", "zapis", "parser dat", "#abcd"])
  }

  @Test("zwinięty projekt: cisza schowana, wartość czytnika „zwinięty, widać N z M”, strzałka mówi skutek")
  func collapsedHeader() throws {
    var memory = CollapsedProjects()
    memory.set([willow], collapsed: true)
    let rows = state().projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil)
    #expect(rows.map(\.id).contains(.session("v-ask")))
    #expect(!rows.map(\.id).contains(.session("v-done")) && !rows.map(\.id).contains(.session("abcdef12")))
    guard case let .header(notes)? = rows.first(where: { $0.id == .project(willow) }) else {
      Issue.record("nagłówek willow")
      return
    }
    #expect(notes.spokenValue == "zwinięty, widać 1 z 3")
    #expect(notes.toggleLabel == "Rozwiń projekt willow")
    let open = state().projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil)
    guard case let .header(expanded)? = open.first(where: { $0.id == .project(willow) }) else { return }
    #expect(expanded.spokenValue == "rozwinięty" && expanded.toggleLabel == "Zwiń projekt willow")
  }

  @Test("a pinned project's header: on top, pinned, and the reader hears it along with the collapse state")
  func pinnedHeader() throws {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setProjectPinned(willow, pinned: true)
    navigation.setProjectsCollapsed([willow], collapsed: true)
    let rows = navigation.treeRows(state(), openCwd: nil, jumpCwd: nil)
    #expect(rows.first?.id == .project(willow), "the pinned project stands first")
    let pinned = try #require(rows.header(willow))
    #expect(pinned.pinned)
    #expect(pinned.spokenValue.contains(UICopy.treePinnedValue))
    #expect(pinned.spokenValue.contains(UICopy.treeCollapsedValue(shown: 1, total: 3)), "still says the collapse")
    let other = try #require(rows.header("/Users/demo/Projects/rarog"))
    #expect(!other.pinned && !other.spokenValue.contains(UICopy.treePinnedValue))
  }

  @Test("projekt z samej historii CLI bez nagłówka na liście, a w pigułkach okna nowej sesji jest")
  func recentProjectOnlyInNewSession() throws {
    var state = state()
    let recent = Sample.decode(RecentProjectList.self, #"{"projects":[{"cwd":"/Users/demo/Projects/nowy","mtime":"\#(Sample.iso(30))"}]}"#)
    state.apply(.catalog(.recentProjectsLoaded(recent.projects, at: Sample.now)), now: Sample.now)
    var memory = CollapsedProjects()
    memory.set(["/Users/demo/Projects/nowy"], collapsed: true)
    let rows = state.projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil)
    #expect(rows.header("/Users/demo/Projects/nowy") == nil)
    #expect(rows.allSatisfy { row in
      if case let .header(header) = row { return header.row.agents > 0 }
      return true
    }, "każdy nagłówek ma agentów")
    let chips = RecentChips.update(shown: [], server: state.catalog.recent.map(\.cwd), excluding: nil)
    #expect(chips == ["/Users/demo/Projects/nowy"])
  }

  /// Stuknięcie w nagłówek nie przechodzi do sesji projektu, tylko go zwija albo rozwija.
  @Test("stuknięcie w nagłówek: projekt z agentami zwija i rozwija; projekt z samej historii CLI nagłówka nie ma")
  func headerTap() throws {
    var memory = CollapsedProjects()
    memory.set([willow], collapsed: true)
    var state = state()
    let recent = Sample.decode(RecentProjectList.self, #"{"projects":[{"cwd":"/Users/demo/Projects/nowy","mtime":"\#(Sample.iso(30))"}]}"#)
    state.apply(.catalog(.recentProjectsLoaded(recent.projects, at: Sample.now)), now: Sample.now)
    let rows = state.projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil)
    #expect(try #require(rows.header(willow)).tap == .toggle(collapse: false), "zwinięty — rozwija")
    #expect(try #require(rows.header("/Users/demo/Projects/rarog")).tap == .toggle(collapse: true), "rozwinięty — zwija")
    #expect(rows.header("/Users/demo/Projects/nowy") == nil, "K10: bez sesji nie ma nagłówka")
    #expect(rows.header("/Users/demo/Projects/brak") == nil)
  }

  @Test("pulsing dot: a fresh unread result only; not marked unread by hand, not received, not frozen")
  func freshResultRows() throws {
    var state = AppState(clientBuild: 1)
    let sessions = [
      Sample.session(id: "fresh", title: "willow", label: "a", state: "waiting-input", createdAgo: 9000),
      Sample.session(id: "marked", title: "willow", label: "b", state: "waiting-input",
                     extra: #""markedUnseen":true"#, createdAgo: 8000),
      Sample.session(id: "held", title: "willow", label: "c", state: "waiting-input", createdAgo: 7000),
      Sample.session(id: "read", title: "willow", label: "d", state: "waiting-input", extra: #""seen":true"#,
                     createdAgo: 6000),
      Sample.session(id: "stale", title: "willow", label: "e", state: "waiting-input", extra: #""stale":true"#,
                     createdAgo: 5000),
    ]
    for session in sessions { state.sessions[session.id] = session }
    state.sessionsLoaded = true
    _ = state.apply(.turnControl(.unreadMarked(sessionId: "held")), now: Sample.now)
    let rows = state.projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil)
    let fresh = Dictionary(uniqueKeysWithValues: rows.compactMap { row -> (String, Bool)? in
      guard case let .session(model) = row else { return nil }
      return (model.id, model.freshResult)
    })
    #expect(fresh == ["fresh": true, "marked": false, "held": false, "read": false, "stale": false])
    #expect(state.sessionRows.first { $0.id == "fresh" }?.freshResult == true)
    // The session switcher keeps a still dot: the request is about the list.
    let tabs = state.projectTabModels(cwd: "/Users/demo/Projects/willow", current: .session("fresh"))
    let switcher = SwitcherRows.rows(tabs: tabs, state: state)
    #expect(switcher.first { $0.tab == .session("fresh") }?.session?.freshResult == false)
  }

  /// The note glyph under the pointer stands on the wash plate over the lit header (both on the column): amber and the
  /// lit grey (text) stay ≥ 3:1 as graphics, and the plate is a visible step on the header's own pointer plate.
  @Test("note glyph plate: amber and text glyphs ≥ 3:1 on it, the plate differs from the lit header")
  func notePlateContrast() {
    func ratio(_ ink: UInt32, _ background: UInt32) -> Double {
      TranscriptDim.contrast(TranscriptDim.RGB(hex: ink), TranscriptDim.RGB(hex: background))
    }
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      for ground in [PaletteTokens.background, PaletteTokens.sidebar] {
        let header = PaletteTokens.over(ink(PaletteTokens.surface2), alpha: HoverTokens.agentRowAlpha, on: ink(ground))
        let plate = PaletteTokens.over(ink(PaletteTokens.text), alpha: HoverTokens.wash, on: header)
        #expect(ratio(plate, header) >= 1.08, "dark \(dark): the plate shows on the lit header")
        #expect(ratio(ink(PaletteTokens.noteInk), plate) >= 3, "dark \(dark): amber glyph")
        #expect(ratio(ink(PaletteTokens.text), plate) >= 3, "dark \(dark): lit grey glyph")
      }
    }
  }

  /// "(10)" after the name is text: ≥ 4.5:1 on the column, on the sidebar, on the pointer plate, on `surface2` and in
  /// the filter glass's shadow, and quieter than the name.
  @Test("agent count bracket: ≥ 4.5:1 on every header background, dimmer than the name; only with agents")
  func agentsBadge() {
    func ratio(_ ink: UInt32, _ background: UInt32) -> Double {
      TranscriptDim.contrast(TranscriptDim.RGB(hex: ink), TranscriptDim.RGB(hex: background))
    }
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      for ground in [PaletteTokens.background, PaletteTokens.sidebar] {
        let column = ink(ground)
        let lit = PaletteTokens.over(ink(PaletteTokens.surface2), alpha: HoverTokens.agentRowAlpha, on: column)
        for background in [column, lit, ink(PaletteTokens.surface2)] {
          let count = ratio(ink(PaletteTokens.treeHeaderCount), background)
          #expect(count >= 4.5, "dark \(dark): bracket on #\(String(background, radix: 16)) \(count)")
          #expect(count < ratio(ink(PaletteTokens.treeHeaderName), background), "dark \(dark): dimmer than the name")
        }
      }
    }
    // The first header stands in the fringe of the floating filter glass's shadow: on the iPad the light sidebar
    // (#EDEDF2) dims to #E7E7EC at the top of the first header's count. Over the dark column the shadow only deepens
    // the ground, so the dark count gains contrast there.
    let shaded = ratio(PaletteTokens.treeHeaderCount.light, 0xE7E7EC)
    #expect(shaded >= 4.5, "light: bracket in the filter glass's shadow \(shaded)")
    func row(agents: Int) -> ProjectRowModel {
      ProjectRowModel(
        cwd: willow, name: "willow", agents: agents, tone: agents > 0 ? .quiet : nil, branch: nil, ahead: nil,
        behind: nil, path: nil, open: false, jumpTarget: false)
    }
    #expect(row(agents: 10).agentsBadge == "(10)")
    #expect(row(agents: 1).agentsBadge == "(1)")
    #expect(row(agents: 0).agentsBadge == nil, "no agents, no bracket")
  }

  /// Project header source: no robot, digits or terminal count; the agent count in brackets
  /// after the name, the Recent Sessions clock and the note button the only controls; the note button lights up both
  /// with and without a note.
  @Test("header: no robot, terminal glyph or counters; the note button has a plate under the pointer in both tones")
  func headerSource() throws {
    let list = try SessionListSourceTests.code("Views/List/ProjectTreeList.swift")
    let code = try SessionListSourceTests.code("Views/List/ProjectTreeHeaderRow.swift")
    for gone in ["robot", "apple.terminal", "TreeHeaderCount", "row.terminals", "StateGlyph", "row.tone"] {
      #expect(!code.contains(gone) && !list.contains(gone), "\(gone)")
    }
    // The bracket: the model's badge, dimmed, never squeezed out, silent for the screen reader.
    let label = try #require(code.range(of: "private struct ProjectTreeHeaderLabel").map { String(code[$0.lowerBound...]) })
    #expect(label.contains("if let badge = row.agentsBadge {") && label.contains("PaletteTokens.treeHeaderCount"))
    #expect(label.contains(".layoutPriority(1)\n            .accessibilityHidden(true)"))
    #expect(!label.contains("row.agents "), "the view draws the badge only, not its own count")
    let start = try #require(code.range(of: "private struct TreeNoteButton"))
    let rest = code[start.lowerBound...]
    let end = try #require(rest.range(of: "\n}\n"))
    let button = String(rest[..<end.lowerBound])
    #expect(button.contains("if hovered { TreeNotePlate() }"), "the plate follows the pointer alone")
    #expect(!button.contains("tone"), "the plate does not depend on the note's tone")
    #expect(button.contains(".buttonStyle(.borderless)") && button.contains("NoteGlyph(model: model, lit: hovered)"))
    let plate = try #require(code.range(of: "struct TreeNotePlate").map { String(code[$0.lowerBound...]) })
    #expect(plate.contains("HoverTokens.wash") && plate.contains("RoundedRectangle.inner"))
  }

  /// The Recent Sessions clock stands in the project header, before the note glyph.
  @Test("header: Recent Sessions clock before the note, a button like the note's that opens Recent Sessions")
  func recentButtonSource() throws {
    let list = try SessionListSourceTests.code("Views/List/ProjectTreeList.swift")
    let code = try SessionListSourceTests.code("Views/List/ProjectTreeHeaderRow.swift")
    let file = try SessionListSourceTests.code("Views/List/TreeRecentButton.swift")
    let start = try #require(file.range(of: "struct TreeRecentButton"))
    let button = String(file[start.lowerBound...])
    #expect(button.contains("if hovered { TreeNotePlate() }") && button.contains("hovered ? Palette.text : Palette.muted2"))
    #expect(button.contains(".buttonStyle(.borderless)") && button.contains(".hoverEffectDisabled()"))
    #expect(button.contains(".pointerTip(UICopy.recentSessionsTitle)") && button.contains("UICopy.recentSessionsLabel(name)"))
    #expect(button.contains(#".accessibilityIdentifier("tree.recent.\(name)")"#))
    // Stands whenever the presenter is there, independent of notes; the tap opens the header's project.
    #expect(list.contains("presenter.openRecent(cwd: header.row.cwd)"))
    // Order on the first line: clock placeholder, then the note's.
    let label = try #require(code.range(of: "private struct ProjectTreeHeaderLabel").map { String(code[$0.lowerBound...]) })
    let clock = try #require(label.range(of: "[.recent: $0]"))
    let note = try #require(label.range(of: "[.note: $0]"))
    #expect(clock.lowerBound < note.lowerBound)
    // The session header no longer has the clock.
    let slot = try SessionListSourceTests.code("Views/SessionControl/HeaderSessionSlot.swift")
    #expect(!slot.contains("header.recent") && !slot.contains("openRecent"))
  }

  /// The header buttons (terminal, clock, note; any subset) stand at equal gaps, and their targets keep the touch
  /// height and the minimum width without overlapping: a wrong gap formula would let a target slide under its
  /// neighbour or cut its own glyph at some text size.
  @Test("header buttons: equal gaps, touching targets that cover their glyphs, last target inside the cell")
  func headerButtonGeometry() {
    #expect(SessionListMetrics.treeButtonHeight >= 44)
    #expect(SessionListMetrics.treeButtonReach <= SessionListMetrics.rowSideInset)
    let widths = Array(stride(from: CGFloat(8), through: 40, by: 4))
    var cases: [[CGFloat]] = widths.map { [$0] }
    for first in widths { for second in widths { cases.append([first, second]) } }
    for first in widths { for second in widths { for third in widths { cases.append([first, second, third]) } } }
    for glyphs in cases {
      let geometry = TreeHeaderButtonGeometry(glyphWidths: glyphs)
      let label = "glyphs \(glyphs)"
      #expect(geometry.gap >= SessionListMetrics.treeButtonGap, "\(label)")
      #expect(geometry.glyphTrailing.last == 0, "\(label)")
      #expect(geometry.targets.last?.maxX == SessionListMetrics.treeButtonReach, "\(label)")
      #expect(geometry.width == -(geometry.targets.first?.minX ?? 0), "\(label)")
      for index in glyphs.indices {
        let target = geometry.targets[index]
        let glyph = (min: geometry.glyphTrailing[index] - glyphs[index], max: geometry.glyphTrailing[index])
        #expect(target.width >= SessionListMetrics.treeButtonWidth - 0.001, "\(label)")
        #expect(target.minX <= glyph.min + 0.001 && glyph.max <= target.maxX + 0.001, "glyph inside, \(label)")
        if index > 0 {
          let air = glyph.min - geometry.glyphTrailing[index - 1]
          #expect(abs(air - geometry.gap) < 0.001, "equal gaps, \(label)")
          #expect(abs(geometry.targets[index - 1].maxX - target.minX) < 0.001, "targets touch, \(label)")
        }
      }
    }
    // A gap above the minimum only where the minimum width needs it: one less point would overlap two targets.
    for glyphs in cases where glyphs.count > 1 {
      let geometry = TreeHeaderButtonGeometry(glyphWidths: glyphs)
      guard geometry.gap > SessionListMetrics.treeButtonGap + 0.001 else { continue }
      let tighter = TreeHeaderButtonGeometry(
        glyphWidths: glyphs, minWidth: SessionListMetrics.treeButtonWidth, minGap: geometry.gap - 1)
      #expect(tighter.gap > geometry.gap - 1 + 0.001, "glyphs \(glyphs)")
    }
  }
}

/// Lista nie skacze, tylko rośnie w dół: ręczne zwinięcie albo rozwinięcie jednego projektu nie uruchamia kotwicy
/// przewinięcia, „Zwiń wszystkie” i „Rozwiń wszystkie” dalej ją uruchamiają.
@MainActor
@Suite("drzewo projektów: kotwica a ręczne zwinięcie projektu")
struct TreeAnchorSkipTests {
  private let rarog = "/Users/demo/Projects/rarog"

  @Test("jeden projekt — kotwica milczy; „wszystkie” — zaznaczony wiersz stoi")
  func gestures() {
    #expect(!TreeToggleGesture.project.holdsSelection)
    #expect(TreeToggleGesture.allProjects.holdsSelection)
  }

  @Test("zapowiedź pomija tylko zmianę na zapowiedziane wiersze i znika przy każdej zmianie")
  func skipIsOneShot() {
    let expanded: [ProjectTreeID] = [.project(rarog), .session("p1"), .project(willow), .session("v-ask")]
    let collapsed: [ProjectTreeID] = [.project(rarog), .project(willow), .session("v-ask")]
    var skip = TreeAnchorSkip()
    // `holds(after:)` zużywa zapowiedź, więc każdy wynik idzie najpierw do stałej (`#expect` nie woła mutacji).
    let unannounced = skip.holds(after: collapsed)
    #expect(unannounced, "bez zapowiedzi kotwica trzyma (zmiana bez gestu)")

    skip.expect(collapsed)
    let announced = skip.holds(after: collapsed)
    #expect(!announced, "zapowiedziana zmiana — kotwica milczy")
    #expect(skip.expected == nil, "zapowiedź zużyta")
    let next = skip.holds(after: expanded)
    #expect(next, "następna, niezwiązana zmiana — kotwica trzyma")

    skip.expect(collapsed)
    let other = skip.holds(after: [.project(willow), .session("v-ask")])
    #expect(other, "w tej samej chwili inna zmiana — trzyma")
    let afterMiss = skip.holds(after: collapsed)
    #expect(afterMiss, "nietrafiona zapowiedź też znika")

    skip.expect(collapsed)
    skip.expect(nil)
    let cleared = skip.holds(after: collapsed)
    #expect(cleared, "gest „wszystkie” kasuje zapowiedź")
  }

  /// Zwinięcie, po którym wszyscy agenci projektu zostają (trzymani), nie zmienia tożsamości wierszy — lista nie
  /// zgłosi zmiany, a zapowiedź równa obecnym wierszom zostaje do następnej zmiany. Ta jest zawsze inna, więc kotwica
  /// trzyma (zwykła flaga „pomiń następną” zjadłaby kotwicę przy niezwiązanej zmianie).
  @Test("zwinięcie bez zmiany wierszy nie zjada kotwicy przy następnej, niezwiązanej zmianie")
  func noOpToggleKeepsAnchor() {
    let rows: [ProjectTreeID] = [.project(rarog), .session("p1"), .project(willow), .session("v-ask")]
    var skip = TreeAnchorSkip()
    skip.expect(rows)
    let holds = skip.holds(after: [.project(rarog), .session("p1"), .project(willow)])
    #expect(holds, "niezwiązana zmiana — trzyma")
  }

  /// `ProjectTreeRows.toggle` liczy zapowiedź bez `openCwd` i `jumpCwd`, a lista — z nimi
  /// (`SessionListView.layoutList`): te dwa pola zmieniają tylko etykietę czytnika, nie tożsamości wierszy.
  @Test("tożsamości wierszy nie zależą od projektu otwartego obok ani od celu Cmd+L")
  func idsIgnoreOpenAndJump() {
    var memory = CollapsedProjects()
    memory.set([willow], collapsed: true)
    for collapsed in [CollapsedProjects(), memory] {
      let bare = state().projectTreeRows(collapsed: collapsed, openCwd: nil, jumpCwd: nil)
      let marked = state().projectTreeRows(
        collapsed: collapsed, openCwd: willow, jumpCwd: rarog)
      #expect(bare.map(\.id) == marked.map(\.id))
    }
  }
}

/// Role wierszy drzewa: odcinek prowadnicy i oddech nad nagłówkiem. Funkcja patrzy na
/// kolejność nagłówków i agentów oraz na linię gałęzi nagłówka, więc wiersze można składać z tych samych wartości.
@MainActor
@Suite("drzewo projektów: prowadnica i równe odstępy między blokami")
struct ProjectTreeLayoutTests {
  private typealias Layout = ProjectTreeRowLayout
  /// Po agencie albo nagłówku z gałęzią: sam oddech.
  private let full: CGFloat = 10
  /// Po nagłówku bez gałęzi: o 6 pt mniej — tyle luzu ma pod nazwą (cel strzałki 44 pt).
  private let plainGap: CGFloat = 4

  /// Wiersze z prawdziwego drzewa: Rarog (gałąź `main`, 1 agent) nad willow (bez gałęzi, 3 agentów).
  private func parts() throws -> (meta: ProjectTreeRow, plain: ProjectTreeRow, agent: ProjectTreeRow) {
    let rows = state().projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil)
    let headers = rows.compactMap { row -> ProjectTreeHeaderModel? in
      if case let .header(header) = row { return header }
      return nil
    }
    let agents = rows.filter { !$0.isHeader }
    let withMeta = headers.filter(\.row.hasMeta)
    let withoutMeta = headers.filter { !$0.row.hasMeta }
    let meta = try #require(withMeta.first)
    let plain = try #require(withoutMeta.first)
    let agent = try #require(agents.first)
    return (.header(meta), .header(plain), agent)
  }

  @Test("stałe: oddech 10 pt po agencie i po nagłówku z gałęzią, 4 po nagłówku bez gałęzi")
  func constants() {
    #expect(SessionListMetrics.projectGap == full)
    #expect(SessionListMetrics.projectGap - SessionListMetrics.emptyHeaderBottomExtra == plainGap)
  }

  @Test("prawdziwe drzewo: projekt z 1 agentem nad projektem z 3 — kreska od strzałki do ostatniego agenta")
  func realTree() {
    let rows = state().projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil)
    #expect(rows.map(\.id) == [
      .project("/Users/demo/Projects/rarog"), .session("p1"),
      .project(willow), .session("v-ask"), .session("v-done"), .session("abcdef12"),
    ])
    #expect(Layout.layout(rows) == [
      Layout(guide: .start),
      Layout(guide: .end),
      Layout(guide: .start, gapAbove: full),
      Layout(guide: .middle),
      Layout(guide: .middle),
      Layout(guide: .end),
    ])
  }

  /// "for the active project (the one whose agent I'm in) make the line on the left brighter".
  @Test("active project: its header and agents are marked, the other project not; no project on screen — none")
  func activeProject() {
    let rows = state().projectTreeRows(
      collapsed: CollapsedProjects(), openCwd: nil, jumpCwd: nil)
    #expect(Layout.layout(rows, activeCwd: willow).map(\.active) == [false, false, true, true, true, true])
    #expect(Layout.layout(rows, activeCwd: "/Users/demo/Projects/rarog").map(\.active)
      == [true, true, false, false, false, false])
    #expect(Layout.layout(rows).allSatisfy { !$0.active })
  }

  /// „Dla zwiniętych projektów możesz ukrywać tę pionową linię”: zwinięty projekt nie ma kreski w żadnym
  /// wierszu, także gdy pod nagłówkiem stoi agent, który czeka. Oddech bez zmian.
  @Test("zwinięty projekt z widocznym agentem: bez kreski w nagłówku i u agenta; rozwinięty obok — z kreską")
  func collapsedWithVisibleAgent() {
    var memory = CollapsedProjects()
    memory.set([willow], collapsed: true)
    let rows = state().projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil)
    #expect(rows.map(\.id) == [
      .project("/Users/demo/Projects/rarog"), .session("p1"), .project(willow), .session("v-ask"),
    ])
    #expect(Layout.layout(rows) == [
      Layout(guide: .start),
      Layout(guide: .end),
      Layout(guide: .none, gapAbove: full),
      Layout(guide: .none),
    ])
  }

  @Test("zwinięty z kilkoma widocznymi agentami: wszystkie wiersze bez kreski, następny projekt z kreską")
  func collapsedWithSeveralAgents() throws {
    let (meta, _, agent) = try parts()
    guard case let .header(open) = meta else { return }
    let closed = ProjectTreeRow.header(ProjectTreeHeaderModel(row: open.row, collapsed: true, shown: 2))
    #expect(Layout.layout([closed, agent, agent, meta, agent]) == [
      Layout(guide: .none),
      Layout(guide: .none),
      Layout(guide: .none),
      Layout(guide: .start, gapAbove: full),
      Layout(guide: .end),
    ])
  }

  @Test("zwinięty → rozwinięty ten sam projekt: kreska wraca, oddech nad nagłówkiem ten sam")
  func collapseThenExpand() {
    var memory = CollapsedProjects()
    memory.set([willow], collapsed: true)
    let collapsed = Layout.layout(
      state().projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil))
    memory.set([willow], collapsed: false)
    let expanded = Layout.layout(
      state().projectTreeRows(collapsed: memory, openCwd: nil, jumpCwd: nil))
    #expect(collapsed.map(\.guide) == [.start, .end, .none, .none])
    #expect(expanded.map(\.guide) == [.start, .end, .start, .middle, .middle, .end])
    #expect(collapsed[2].gapAbove == expanded[2].gapAbove)
  }

  @Test("nagłówki bez agentów: bez kreski; oddech zależy od wiersza wyżej — dwa nagłówki pod rząd i koniec listy")
  func headersWithoutAgents() throws {
    let (meta, plain, agent) = try parts()
    #expect(Layout.layout([plain, plain, agent]) == [
      Layout(guide: .none),
      Layout(guide: .start, gapAbove: plainGap),
      Layout(guide: .end),
    ])
    #expect(Layout.layout([meta, agent, agent, agent, plain, plain]) == [
      Layout(guide: .start),
      Layout(guide: .middle),
      Layout(guide: .middle),
      Layout(guide: .end),
      Layout(guide: .none, gapAbove: full),
      Layout(guide: .none, gapAbove: plainGap),
    ])
    #expect(Layout.layout([meta, meta, plain]) == [
      Layout(guide: .none),
      Layout(guide: .none, gapAbove: full),
      Layout(guide: .none, gapAbove: full),
    ], "nagłówek z gałęzią bez widocznych agentów (projekt zwinięty) kończy się jak agent")
    #expect(Layout.layout([plain]) == [Layout(guide: .none)], "jedyny wiersz: bez oddechu nad sobą")
    #expect(Layout.layout([]).isEmpty)
  }

  /// Kotwica przewinięcia trzyma zaznaczony wiersz tylko wtedy, gdy wiersze, które nad nim zostają, nie zmieniają
  /// wysokości: zwinięcie zamienia agenta nad nagłówkiem na nagłówek z gałęzią, a oddech ma zostać ten sam.
  @Test("zwinięcie nie zmienia oddechu nagłówków, które zostają (projekty z gałęzią)")
  func collapseKeepsGaps() throws {
    let (meta, _, agent) = try parts()
    let expanded = Layout.layout([meta, agent, agent, meta, agent, meta])
    let collapsed = Layout.layout([meta, meta, agent, meta])
    #expect(expanded[3].gapAbove == collapsed[1].gapAbove && expanded[5].gapAbove == collapsed[3].gapAbove)
  }
}

@Suite("drzewo projektów: tokeny nagłówka na tle kolumny")
struct ProjectTreeTokensTests {
  private typealias RGB = TranscriptDim.RGB

  private func ratio(_ ink: UInt32, _ background: UInt32) -> Double {
    TranscriptDim.contrast(RGB(hex: ink), RGB(hex: background))
  }

  /// Tło kolumny, pod wskaźnikiem (połowa zaznaczenia) i pod fokusem albo palcem (`surface2`) — w obu motywach.
  private func backgrounds(dark: Bool) -> [UInt32] {
    [false, true].map { hovered in HoverTokens.agentRow(selected: false, hovered: hovered, dark: dark) }
      + [dark ? PaletteTokens.surface2.dark : PaletteTokens.surface2.light]
  }

  @Test("nazwa ≥ 7:1, metadane ≥ 4,5:1, strzałki gita AA, strzałka zwijania ≥ 3:1")
  func contrast() {
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      for background in backgrounds(dark: dark) {
        #expect(ratio(ink(PaletteTokens.treeHeaderName), background) >= 7, "dark \(dark): nazwa")
        #expect(ratio(ink(PaletteTokens.treeHeaderMeta), background) >= 4.5, "dark \(dark): metadane")
        for arrow in [PaletteTokens.ahead, PaletteTokens.behind] {
          #expect(ratio(ink(arrow), background) >= 4.5, "dark \(dark): \(arrow)")
        }
        #expect(ratio(ink(PaletteTokens.treeChevron), background) >= 3, "dark \(dark): strzałka")
      }
    }
  }

  /// Prowadnica jest dekoracją jak `border` (grupę niosą wcięcie i oddech), więc bez progu 3:1 grafiki. Pasmo pilnuje
  /// obu stron: podbita tnie listę jak kreska tabeli, zgaszona znika na plamie wskaźnika nagłówka, nad którą leży.
  @Test("prowadnica: na tle kolumny 1,15–1,40:1 w obu motywach, na plamie `surface2` ≥ 1,10:1")
  func guideContrast() {
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      // Lista w stosie stoi na `background`, obok sesji na `sidebar` (iPad).
      for ground in [PaletteTokens.background, PaletteTokens.sidebar] {
        let column = ratio(ink(PaletteTokens.treeGuide), ink(ground))
        #expect(column >= 1.15 && column <= 1.40, "dark \(dark): tło kolumny \(ground) \(column)")
      }
      let plate = ratio(ink(PaletteTokens.treeGuide), ink(PaletteTokens.surface2))
      #expect(plate >= 1.10, "dark \(dark): plama \(plate)")
    }
  }

  /// The active project's guide stands out from the others and stays decoration.
  @Test("active guide brighter than the guide, below 3:1")
  func activeGuideContrast() {
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      for ground in [PaletteTokens.background, PaletteTokens.sidebar] {
        let active = ratio(ink(PaletteTokens.treeGuideActive), ink(ground))
        #expect(active > ratio(ink(PaletteTokens.treeGuide), ink(ground)) + 0.5, "dark \(dark): \(active)")
        #expect(active < 3, "dark \(dark): a line, not a rule: \(active)")
      }
    }
  }
}
