import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Linia etapu, pasek workflow, kropka „w tle" i piętro rangi na karcie listy
// oraz regresja wyciszenia bezczynnych. Właściciel: lista.

@Suite("wiersz listy: linia etapu i pasek")
struct SessionRowStageTests {
  @Test("pracująca karta: zwykłe narzędzie linii etapu nie daje; bez aktywności też nie (jak `:empty` w PWA)")
  func working() {
    let reading = SessionRowModel(
      Sample.session(extra: #""activity":{"kind":"tool","toolName":"Read","summary":"/Users/d/a/b/c/d.ts","elapsedSeconds":40}"#),
      ordinal: nil)
    // Linia przy każdym kroku agenta skakałaby wysokością wiersza.
    #expect(reading.stage == nil && reading.progress == nil && !reading.backgroundDot)
    #expect(!reading.spoken(now: Sample.now).contains("czyta plik"))
    for fields in [#""kind":"thinking""#, #""kind":"waiting","summary":"czeka na silnik""#] {
      let row = SessionRowModel(Sample.session(extra: #""activity":{\#(fields)}"#), ordinal: nil)
      #expect(row.stage == nil, "myślenie i czekanie: bez linii (\(fields))")
    }
    // Pusta linia pod pracującą kartą była przerwą pod agentem; rezerwę ma
    // tylko karta czekająca, jak `.session-card--waiting` w PWA.
    let silent = SessionRowModel(Sample.session(), ordinal: nil)
    #expect(silent.stage == nil, "bez aktywności: bez linii etapu")
    let idleActivity = SessionRowModel(Sample.session(extra: #""activity":{"kind":"idle"}"#), ordinal: nil)
    #expect(idleActivity.stage == nil && idleActivity.progress == nil && !idleActivity.backgroundDot,
            "aktywność bez zdania: bez linii etapu")
  }

  @Test("workflow z planem: pasek z segmentem na fazę, linia bez słowa „workflow:”, bez kropki")
  func workflowBar() throws {
    let session = Sample.session(extra: #"""
      "activity":{"kind":"tool","delegation":"workflow","workflow":"refaktor","agents":1,"agentsDone":2,
      "phases":[{"title":"A1","agents":2,"done":2},{"title":"A2","agents":1,"done":0}]}
      """#)
    let row = SessionRowModel(session, ordinal: nil)
    #expect(row.stage == "refaktor · faza 2/2 A2 · 1 agent · 2 skończyło")
    let progress = try #require(row.progress)
    #expect(progress.map(\.fill) == [1, 0] && progress.map(\.active) == [false, true])
    #expect(!row.backgroundDot)
  }

  @Test("subagent bez paska: kropka „w tle” przy linii; pasek tylko pod pracującą kartą")
  func subagentDot() {
    let row = SessionRowModel(
      Sample.session(extra: #""activity":{"kind":"tool","delegation":"agents","summary":"Przegląd"}"#), ordinal: nil)
    #expect(row.stage == "subagent: Przegląd" && row.backgroundDot && row.progress == nil)
    let done = SessionRowModel(Sample.session(
      state: "waiting-input",
      extra: #""seen":true,"activity":{"kind":"tool","delegation":"workflow","agents":1,"agentsDone":2}"#), ordinal: nil)
    #expect(done.progress == nil && done.stage == nil, "skończona tura bez zadań w tle: bez linii i paska")
  }

  @Test("po turze z żywym zadaniem w tle: karta pracująca, „w tle: komenda · …” albo „3 w tle”, kropka")
  func backgroundWork() {
    let one = SessionRowModel(Sample.session(
      state: "waiting-input", extra: #""seen":true,"backgroundTasks":[{"id":"t","kind":"command","command":"pnpm test"}]"#),
      ordinal: nil)
    #expect(one.status.text == "pracuje w tle" && one.status.tone == .working)
    #expect(one.stage == "w tle: komenda · pnpm test" && one.backgroundDot && !one.quiet)
    let many = SessionRowModel(Sample.session(
      state: "done", extra: #""backgroundTasks":[{"id":"a","kind":"agent"},{"id":"b","kind":"agent"},{"id":"c","kind":"monitor"}]"#),
      ordinal: nil)
    #expect(many.stage == "3 w tle" && many.section == .working)
  }

  /// Subagent w postoju stoi na liście, ale pracą nie jest. Wiersz ma wtedy ton „czeka na zadanie w tle” (rdzeń),
  /// a linia etapu nie może przeczyć temu zieloną kropką pracy ani słowami „w tle".
  @Test("sami subagenci w postoju: „czeka: subagent · opis” bez kropki, ton czekania na zadanie w tle; przy kilku liczba")
  func waitingAgentsOnly() {
    let waiting = #"{"id":"a","kind":"agent","description":"Przegląd pokrycia","waitingSince":"\#(Sample.iso(600))"}"#
    let one = SessionRowModel(Sample.session(
      state: "waiting-input", extra: #""seen":true,"backgroundTasks":[\#(waiting)]"#), ordinal: nil)
    #expect(one.stage == "czeka: subagent · Przegląd pokrycia" && !one.backgroundDot)
    #expect(one.status.text == "bezczynna" && one.status.tone == .backgroundWait, "słowo „pracuje w tle” nie pada")
    #expect(one.section == .idle && one.quiet, "wiersz jak bez tła")
    #expect(one.spoken(now: Sample.now).contains("czeka: subagent · Przegląd pokrycia"))
    let bare = SessionRowModel(Sample.session(
      state: "done", extra: #""backgroundTasks":[{"id":"a","kind":"agent","waitingSince":"\#(Sample.iso(60))"}]"#),
      ordinal: nil)
    #expect(bare.stage == "czeka: subagent" && !bare.backgroundDot, "bez opisu: sam rodzaj")
    let two = SessionRowModel(Sample.session(state: "done", extra: #"""
      "backgroundTasks":[\#(waiting),{"id":"b","kind":"agent","waitingSince":"\#(Sample.iso(30))"}]
      """#), ordinal: nil)
    #expect(two.stage == "czeka: 2 subagenty" && !two.backgroundDot)
    // Nieodebrany wynik zostaje nieodebranym: postój subagenta go nie przykrywa tonem pracy.
    let unread = SessionRowModel(Sample.session(
      state: "waiting-input", extra: #""backgroundTasks":[\#(waiting)]"#), ordinal: nil)
    #expect(unread.status.tone == .unread && unread.stage == "czeka: subagent · Przegląd pokrycia" && !unread.backgroundDot)
  }

  @Test("czekający obok czegoś, co pracuje: linia liczy wszystkie zadania i ma kropkę; sam pracujący jak dotąd")
  func waitingBesideWork() {
    let waiting = #"{"id":"a","kind":"agent","description":"Przegląd","waitingSince":"\#(Sample.iso(600))"}"#
    let mixed = SessionRowModel(Sample.session(state: "waiting-input", extra: #"""
      "seen":true,"backgroundTasks":[\#(waiting),{"id":"c","kind":"command","command":"pnpm test"}]
      """#), ordinal: nil)
    #expect(mixed.stage == "2 w tle" && mixed.backgroundDot)
    #expect(mixed.status.text == "pracuje w tle" && mixed.status.tone == .working)
    let working = SessionRowModel(Sample.session(
      state: "waiting-input", extra: #""seen":true,"backgroundTasks":[{"id":"a","kind":"agent","description":"Przegląd"}]"#),
      ordinal: nil)
    #expect(working.stage == "w tle: subagent · Przegląd" && working.backgroundDot)
    #expect(working.status.text == "pracuje w tle")
    // `waitingSince` przy komendzie nic nie znaczy (kontrakt nadaje je agentom): komenda zostaje pracą.
    let odd = SessionRowModel(Sample.session(state: "done", extra: #"""
      "backgroundTasks":[{"id":"c","kind":"command","command":"pnpm test","waitingSince":"\#(Sample.iso(60))"}]
      """#), ordinal: nil)
    #expect(odd.stage == "w tle: komenda · pnpm test" && odd.backgroundDot)
  }

  @Test("pracująca karta z samym subagentem w postoju: „czeka: …” bez kropki; żywa delegacja bierze opis pracującego")
  func waitingAgentsUnderRunningCard() {
    let waiting = #"{"id":"a","kind":"agent","description":"Stoi","waitingSince":"\#(Sample.iso(600))"}"#
    let quiet = SessionRowModel(Sample.session(extra: #""backgroundTasks":[\#(waiting)]"#), ordinal: nil)
    #expect(quiet.stage == "czeka: subagent · Stoi" && !quiet.backgroundDot)
    // Aktywność mówi „subagent pracuje" bez opisu: opis jest z agenta, który pracuje, nie z tego w postoju.
    let delegating = SessionRowModel(Sample.session(extra: #"""
      "activity":{"kind":"tool","delegation":"agents"},
      "backgroundTasks":[\#(waiting),{"id":"b","kind":"agent","description":"Pracuje"}]
      """#), ordinal: nil)
    #expect(delegating.stage == "subagent: Pracuje" && delegating.backgroundDot)
    let standingSession = Sample.session(extra: #"""
      "activity":{"kind":"tool","delegation":"agents"},"backgroundTasks":[\#(waiting)]
      """#)
    let onlyStanding = SessionRowModel(standingSession, ordinal: nil)
    #expect(onlyStanding.stage == "subagent pracuje", "opisu stojącego agenta linia nie pożycza")
    // Żywa delegacja ma własną regułę kropki (bez paska kropka jest) i listy nie pyta: w tej turze ktoś
    // pracuje. Plakietka opisuje LISTĘ, a na niej nic nie pracuje.
    #expect(onlyStanding.backgroundDot && onlyStanding.progress == nil)
    #expect(BackgroundBadge(standingSession)?.working == false)
  }

  /// Rozkład przebiegu z fazą w toku: Implementacja skończona, Review z agentem w locie, Poprawki bez agentów.
  static let review = #"""
    {"phases":["Implementacja","Review","Poprawki"],"agents":[
      {"id":"1","phase":"Implementacja","done":true},{"id":"2","phase":"Review","done":false}]}
    """#
  static let workflow = #"{"id":"w","kind":"workflow","description":"przegląd M1","run":\#(review)}"#

  /// Workflow w toku zawsze widać w wierszu. Regresja: linia przeskakiwała na
  /// „subagent pracuje”, gdy główny agent puszczał subagenta, i na „2 w tle” po turze.
  @Test("workflow w toku wygrywa z aktywnością tury: faza i nazwa, pasek z rozkładu, bez kropki")
  func workflowBeatsActivity() throws {
    let activities = [
      #"{"kind":"tool","delegation":"agents","summary":"Przegląd"}"#,
      #"{"kind":"tool","delegation":"agents","agents":3,"agentsDone":1}"#,
      #"{"kind":"tool","toolName":"Grep","summary":"pnpm test"}"#,
      #"{"kind":"thinking"}"#,
    ]
    for activity in activities {
      let row = SessionRowModel(Sample.session(extra: #"""
        "activity":\#(activity),"backgroundTasks":[\#(Self.workflow)]
        """#), ordinal: nil)
      #expect(row.stage == "faza 2/3 Review · przegląd M1", "\(activity)")
      let progress = try #require(row.progress, "\(activity)")
      #expect(progress.map(\.fill) == [1, 0, 0] && progress.map(\.active) == [false, true, false])
      #expect(!row.backgroundDot, "pasek jest znakiem pracy, kropki nie ma")
    }
  }

  @Test("po turze: workflow w toku zamiast „2 w tle”, z paskiem; słowo stanu „pracuje w tle”")
  func workflowAfterTurn() throws {
    for state in ["waiting-input", "done"] {
      let row = SessionRowModel(Sample.session(state: state, extra: #"""
        "seen":true,"backgroundTasks":[{"id":"c","kind":"command","command":"pnpm test"},\#(Self.workflow)]
        """#), ordinal: nil)
      #expect(row.stage == "faza 2/3 Review · przegląd M1", "\(state)")
      #expect(try #require(row.progress).count == 3 && !row.backgroundDot)
      #expect(row.status.text == "pracuje w tle" && row.section == .working)
      #expect(row.spoken(now: Sample.now).contains("faza 2/3 Review · przegląd M1"))
    }
  }

  @Test("dwa workflow: ten z fazą w toku; zamknięty przebieg nie wygrywa z aktywnością")
  func twoWorkflows() throws {
    let starting = #"{"id":"w0","kind":"workflow","description":"start"}"#
    let closed = #"""
      {"id":"w1","kind":"workflow","description":"skończony","run":{"phases":["A"],"agents":[{"id":"9","phase":"A","done":true}]}}
      """#
    for list in ["\(starting),\(Self.workflow)", "\(closed),\(Self.workflow)"] {
      let row = SessionRowModel(Sample.session(extra: #"""
        "activity":{"kind":"tool","delegation":"agents","summary":"Przegląd"},"backgroundTasks":[\#(list)]
        """#), ordinal: nil)
      #expect(row.stage == "faza 2/3 Review · przegląd M1" && row.progress != nil, "\(list)")
    }
    // Sam zamknięty przebieg (wszyscy agenci skończyli) nie jest w toku: linia jak dotąd.
    let onlyClosed = SessionRowModel(Sample.session(extra: #"""
      "activity":{"kind":"tool","delegation":"agents","summary":"Przegląd"},"backgroundTasks":[\#(closed)]
      """#), ordinal: nil)
    #expect(onlyClosed.stage == "subagent: Przegląd" && onlyClosed.progress == nil && onlyClosed.backgroundDot)
  }

  @Test("workflow w toku bez rozkładu albo bez tagów: „w tle: workflow · nazwa” z kropką, bez paska")
  func workflowWithoutLayout() {
    let untagged = #"{"phases":["A","B"],"agents":[{"id":"1","done":false}]}"#
    for task in [
      #"{"id":"w","kind":"workflow","description":"przegląd M1"}"#,
      #"{"id":"w","kind":"workflow","description":"przegląd M1","run":\#(untagged)}"#,
    ] {
      let row = SessionRowModel(Sample.session(extra: #"""
        "activity":{"kind":"tool","delegation":"agents","summary":"Przegląd"},"backgroundTasks":[\#(task)]
        """#), ordinal: nil)
      #expect(row.stage == "w tle: workflow · przegląd M1" && row.progress == nil && row.backgroundDot, "\(task)")
    }
  }

  @Test("workflow w toku: decyzja i dane nieświeże wygrywają")
  func workflowGates() {
    let tasks = #""backgroundTasks":[\#(Self.workflow)]"#
    let deciding = SessionRowModel(Sample.session(state: "waiting-permission", extra: tasks), ordinal: nil)
    #expect(deciding.stage == nil && deciding.progress == nil && deciding.waiting != nil)
    let stale = SessionRowModel(Sample.session(extra: #""stale":true,\#(tasks)"#), ordinal: nil)
    #expect(stale.stage == nil && stale.progress == nil)
    let cached = SessionRowModel(Sample.session(extra: tasks), ordinal: nil, listStale: true)
    #expect(cached.stage == nil && cached.progress == nil)
  }

  @Test("decyzja i dane nieświeże: bez linii etapu (czeka mówi linia „na co czeka”)")
  func waitingAndStale() {
    let waiting = SessionRowModel(Sample.session(
      state: "waiting-permission", extra: #""activity":{"kind":"tool","toolName":"Read"}"#), ordinal: nil)
    #expect(waiting.stage == nil && waiting.waiting != nil)
    let stale = SessionRowModel(Sample.session(extra: #""stale":true,"activity":{"kind":"tool","toolName":"Read"}"#), ordinal: nil)
    #expect(stale.stage == nil && stale.progress == nil && stale.stale)
    #expect(stale.spoken(now: Sample.now).hasSuffix("dane mogą być nieaktualne"))
  }

  @Test("piętro rangi: czeka / pracuje / bezczynna — z niego liczy się wyciszenie")
  func section() {
    #expect(SessionRowModel(Sample.session(state: "waiting-question"), ordinal: nil).section == .attention)
    #expect(SessionRowModel(Sample.session(state: "waiting-input"), ordinal: nil).section == .attention, "nieodebrany wynik")
    #expect(SessionRowModel(Sample.session(state: "running"), ordinal: nil).section == .working)
    #expect(SessionRowModel(Sample.session(state: "waiting-input", extra: #""seen":true"#), ordinal: nil).section == .idle)
    #expect(SessionRowModel(Sample.session(state: "done"), ordinal: nil).section == .idle)
  }
}

@Suite("wiersz listy: wyciszenie bezczynnych (regresja)")
struct SessionRowQuietRegressionTests {
  @Test("wyciszone tylko odebrane i done; pełne kolory przy wyniku do odebrania, pracy i zadaniu w tle")
  func quiet() {
    #expect(SessionRowModel(Sample.session(state: "waiting-input", extra: #""seen":true"#), ordinal: nil).quiet)
    #expect(SessionRowModel(Sample.session(state: "done"), ordinal: nil).quiet)
    #expect(!SessionRowModel(Sample.session(state: "waiting-input"), ordinal: nil).quiet)
    #expect(!SessionRowModel(Sample.session(state: "running"), ordinal: nil).quiet)
    let background = Sample.session(state: "done", extra: #""backgroundTasks":[{"id":"t","kind":"command"}]"#)
    #expect(!SessionRowModel(background, ordinal: nil).quiet)
  }

  @Test("wycisza piętro bezczynnych, nie szary ton: „do wznowienia” ma szarą kropkę i pełny atrament (isIdleCard)")
  func quietFollowsSectionNotTone() {
    let resumable = SessionRowModel(Sample.session(state: "resumable"), ordinal: nil)
    #expect(resumable.status.tone == .quiet, "kropka zostaje szara")
    #expect(resumable.section == .attention && !resumable.quiet, "awaria stoi wysoko i w pełnym kolorze")
    let unsupported = SessionRowModel(Sample.session(state: "unsupported"), ordinal: nil)
    #expect(unsupported.section == .idle && unsupported.quiet, "nieobsługiwana: cisza na dole, wyciszona")
    for raw in ["waiting-input", "done", "running", "resumable", "error", "limit-reached", "interrupted", "unsupported"] {
      for extra in ["", #""seen":true"#, #""backgroundTasks":[{"id":"t","kind":"command"}]"#] {
        let row = SessionRowModel(Sample.session(state: raw, extra: extra), ordinal: nil)
        #expect(row.quiet == (row.section == .idle), "\(raw) \(extra)")
      }
    }
  }

  @Test("nieświeże wygrywa z wyciszeniem; bezczynne zawsze na liście (bez rozwijaka)")
  func staleAndAlwaysListed() {
    let staleIdle = SessionRowModel(Sample.session(state: "done", extra: #""stale":true"#), ordinal: nil)
    #expect(staleIdle.stale && !staleIdle.quiet)
    var state = AppState(clientBuild: 1)
    for (index, raw) in ["done", "waiting-input", "running"].enumerated() {
      let session = Sample.session(id: "s\(index)", state: raw, extra: #""seen":true"#)
      state.sessions[session.id] = session
    }
    #expect(state.sessionRows.map(\.id) == ["s2", "s1", "s0"], "bezczynne stoją na liście, pod pracą")
  }
}

@MainActor
@Suite("list row: the open session beside the detail, the last opened one in the stack")
struct SessionRowHighlightTests {
  /// Two known sessions, `a` and `b`; history visits are recorded the way the root view records them.
  private func visited(_ ids: [String], known: [String] = ["a", "b"]) -> (RarogNavigation, AppState) {
    var state = AppState(clientBuild: 1)
    for id in known { state.sessions[id] = Sample.session(id: id) }
    state.sessionsLoaded = true
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    for id in ids {
      navigation.detail = .session(id)
      navigation.noteSessionVisit(state)
    }
    navigation.detail = nil
    return (navigation, state)
  }

  private func lit(_ navigation: RarogNavigation, _ state: AppState, selected: String?, besideDetail: Bool) -> [String] {
    let last = navigation.lastVisitedSession(state)
    return ["a", "b"].filter {
      ListRowHighlight.isHighlighted(rowId: $0, selectedId: selected, lastVisitedId: last, besideDetail: besideDetail)
    }
  }

  @Test("iPad: only the session open beside is highlighted; the last opened one is not")
  func besideDetail() {
    let (navigation, state) = visited(["a", "b"])
    #expect(lit(navigation, state, selected: "a", besideDetail: true) == ["a"])
    #expect(lit(navigation, state, selected: nil, besideDetail: true).isEmpty)
  }

  @Test("stack: back on the list, the last opened session keeps the plate")
  func stackLastOpened() {
    let (navigation, state) = visited(["a", "b"])
    #expect(lit(navigation, state, selected: nil, besideDetail: false) == ["b"])
  }

  @Test("stack: the tapped session takes the plate at once, before the visit reaches the history")
  func stackTapped() {
    let (navigation, state) = visited(["b"])
    #expect(lit(navigation, state, selected: "a", besideDetail: false) == ["a"])
  }

  @Test("stack: a last opened session that is gone hands the plate to the newest one still known")
  func stackDeadLast() {
    let (navigation, state) = visited(["a", "b"], known: ["a"])
    #expect(navigation.lastVisitedSession(state) == "a")
    #expect(lit(navigation, state, selected: nil, besideDetail: false) == ["a"])
  }

  @Test("stack: no history, no plate")
  func stackNoHistory() {
    let (navigation, state) = visited([])
    #expect(navigation.lastVisitedSession(state) == nil)
    #expect(lit(navigation, state, selected: nil, besideDetail: false).isEmpty)
  }

  @Test("fokus klawiatury: pierścień tylko na wierszu bez zaznaczenia; zaznaczony z fokusem niesie samo tło")
  func focusRing() {
    #expect(ListRowHighlight.showsFocusRing(focused: true, highlighted: false), "fokus obok zaznaczenia widać")
    #expect(!ListRowHighlight.showsFocusRing(focused: true, highlighted: true), "bez obwódki na zaznaczonym (runda 4)")
    #expect(!ListRowHighlight.showsFocusRing(focused: false, highlighted: true))
    #expect(!ListRowHighlight.showsFocusRing(focused: false, highlighted: false))
  }
}
