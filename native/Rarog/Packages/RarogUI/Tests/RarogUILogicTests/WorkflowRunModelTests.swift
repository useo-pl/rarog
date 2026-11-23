import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Przebieg workflow w panelu „w tle": `phaseCounts` (te same wejścia i wyniki co
// `server/test/herdr-phase-progress.test.ts:39-84`), `workflowRows`, `workflowTally`, `workflowSpoken`,
// `workflowUntagged`, `workflowPhaseState`, `workflowOpenPhase`, `workflowRailTally` (kropek `workflowStopDots`
// apka nie ma). Dalej przypadki
// brzegowe: plan bez agentów, przejście bez tagów → z fazami, jedyny żywy agent spoza
// planu, zły `startedAt`, 200 agentów, rozwinięcie faz i zamrożenie panelu.

private func run(_ json: String) -> WorkflowRun {
  Sample.decode(WorkflowRun.self, json)
}

/// Agenci przebiegu, na którym stoją testy serwera i szyny PWA.
private let agentsA = #"""
  [{"id":"a1","phase":"A1 Migracja","label":"impl","done":true},
   {"id":"a2","phase":"A1 Migracja","label":"verify","done":true},
   {"id":"a3","phase":"A2 Serwer","label":"impl","done":false,"startedAt":"2026-09-16T06:00:00.000Z"},
   {"id":"a4","phase":"A2 Serwer","label":"verify","done":true},
   {"id":"a5","phase":"Faza spoza skryptu","done":false},
   {"id":"a6","done":false}]
  """#
private let runA = run(#"{"phases":["A1 Migracja","A2 Serwer","A3 Shared"],"agents":\#(agentsA)}"#)
/// Ten sam rozkład bez planu (przebieg z `scriptPath`: skryptu nie ma, tagi są).
private let runAUnplanned = run(#"{"phases":[],"agents":\#(agentsA)}"#)

private let runB = run(#"""
  {"phases":["Faza A","Faza B","Faza C"],"agents":[
    {"id":"a1","phase":"Faza A","label":"impl:A1","done":true},
    {"id":"a2","phase":"Faza A","label":"verify:A1#1","done":true},
    {"id":"a3","phase":"Faza B","label":"impl:B1","done":false,"startedAt":"2026-08-28T06:25:00.000Z"}]}
  """#)

private func phaseRow(_ title: String, _ done: [Bool]) -> WorkflowPhaseRow {
  WorkflowPhaseRow(
    title: title,
    agents: done.enumerated().map { WorkflowAgentRow(id: "\(title)\($0.offset)", name: "#\($0.offset)", done: $0.element) })
}

/// Rozwinięcie z fazami otwartymi ręką (`toggle` na fazie, która nie jest bieżąca).
private func opened(_ keys: WorkflowExpansion.Key...) -> WorkflowExpansion {
  var expansion = WorkflowExpansion()
  for key in keys { expansion.toggle(key, current: false) }
  return expansion
}

/// Rozwinięcie z otwartymi ręką listami skończonych (`toggleDone`).
private func withDone(_ expansion: WorkflowExpansion, _ keys: WorkflowExpansion.Key...) -> WorkflowExpansion {
  var expansion = expansion
  for key in keys { expansion.toggleDone(key) }
  return expansion
}

private func counts(_ phases: [PhaseCount]?) -> [String]? {
  phases?.map { "\($0.title) \($0.agents)/\($0.done)" }
}

@Suite("workflow: fazy z rozkładu (phaseCounts, lustro serwera)")
struct WorkflowPhaseCountsTests {
  @Test("każda faza skryptu w kolejności, także bez agentów; agent bez fazy z listy pominięty")
  func planned() {
    #expect(counts(WorkflowRunModel.phaseCounts(runA)) == ["A1 Migracja 2/2", "A2 Serwer 2/1", "A3 Shared 0/0"])
  }

  @Test("bez ani jednego otagowanego agenta = nil (klient liczy po staremu)")
  func noTags() {
    #expect(WorkflowRunModel.phaseCounts(run(#"{"phases":["A"],"agents":[{"id":"x","done":false}]}"#)) == nil)
    #expect(WorkflowRunModel.phaseCounts(run(#"{"phases":["A"],"agents":[]}"#)) == nil)
    #expect(WorkflowRunModel.phaseCounts(run(#"{"phases":[],"agents":[{"id":"x","done":false}]}"#)) == nil)
    #expect(WorkflowRunModel.phaseCounts(run(#"{"phases":[],"agents":[]}"#)) == nil)
  }

  @Test("bez planu fazy idą z TAGÓW w kolejności pierwszego agenta; przy planie faza spoza listy pominięta")
  func fromTags() {
    #expect(counts(WorkflowRunModel.phaseCounts(runAUnplanned)) == ["A1 Migracja 2/2", "A2 Serwer 2/1", "Faza spoza skryptu 1/0"])
    #expect(WorkflowRunModel.phaseCounts(runA)?.map(\.title) == runA.phases)
  }

  @Test("znane ograniczenie: dwie fazy o tym samym tytule to jeden koszyk (tytuł JEST fazą)")
  func sameTitle() {
    let shared = run(#"{"phases":["A","B"],"agents":[{"id":"1","phase":"A","done":true},{"id":"2","phase":"A","done":false}]}"#)
    #expect(counts(WorkflowRunModel.phaseCounts(shared)) == ["A 2/1", "B 0/0"])
  }
}

@Suite("workflow: rozkład do narysowania (workflowRows, workflowTally, workflowSpoken)")
struct WorkflowRowsTests {
  @Test("fazy w kolejności skryptu, agenci przy swojej fazie, pusta faza z pustą listą")
  func scriptOrder() {
    let rows = WorkflowRunModel.rows(runB)
    #expect(rows.map(\.title) == ["Faza A", "Faza B", "Faza C"])
    #expect(rows[0].agents == [
      WorkflowAgentRow(id: "a1", name: "impl:A1", done: true),
      WorkflowAgentRow(id: "a2", name: "verify:A1#1", done: true),
    ])
    #expect(rows[1].agents == [WorkflowAgentRow(id: "a3", name: "impl:B1", done: false, startedAt: "2026-08-28T06:25:00.000Z")])
    #expect(rows[2].agents.isEmpty)
    #expect(rows.allSatisfy { !$0.loose })
  }

  @Test("faza spoza skryptu idzie na koniec; agenci bez fazy w ostatniej grupie z pustym tytułem")
  func offPlanAndLoose() {
    let rows = WorkflowRunModel.rows(run(#"""
      {"phases":["Faza A"],"agents":[
        {"id":"x","done":false},
        {"id":"y","phase":"Fix","label":"fix:A1","done":false},
        {"id":"z","phase":"Faza A","label":"impl:A1","done":true}]}
      """#))
    #expect(rows.map(\.title) == ["Faza A", "Fix", ""])
    // Numer zastępczy liczy się po starcie w CAŁYM przebiegu — `#1`, nie „pierwszy w grupie".
    #expect(rows[2].agents == [WorkflowAgentRow(id: "x", name: "#1", done: false)])
    #expect(rows.map(\.loose) == [false, false, true])
  }

  @Test("skrypt sprzed konwencji: same numery, bez faz — i bez wymyślonych etykiet")
  func preConvention() {
    let rows = WorkflowRunModel.rows(run(#"{"phases":[],"agents":[{"id":"a","done":true},{"id":"b","done":false}]}"#))
    #expect(rows.map(\.title) == [""])
    #expect(rows[0].agents == [WorkflowAgentRow(id: "a", name: "#1", done: true), WorkflowAgentRow(id: "b", name: "#2", done: false)])
    #expect(UICopy.workflowNoPhase == "bez fazy")
  }

  @Test("podsumowanie liczy skończonych i pracujących; „zostało” nie istnieje, bo tego nikt nie wie")
  func tally() {
    #expect(WorkflowRunModel.tally(runB) == "2 skończyło · 1 pracuje")
    #expect(WorkflowRunModel.tally(run(#"{"phases":[],"agents":[{"id":"a","done":false},{"id":"b","done":false}]}"#)) == "2 pracują")
    #expect(WorkflowRunModel.tally(run(#"{"phases":["Faza A"],"agents":[]}"#)) == "")
    #expect(!WorkflowRunModel.tally(runB).contains("zosta"))
  }

  @Test("zdanie dla czytnika: faza po fazie, tylko fazy z agentami")
  func spoken() {
    #expect(WorkflowRunModel.spoken(runB) == "Faza A: impl:A1 skończył, verify:A1#1 skończył; Faza B: impl:B1 pracuje")
  }

  @Test("przebieg bez tagów: fazy to plan bez stanu, agenci w jednej linii, bez „bez fazy”")
  func untagged() {
    let untagged = run(#"{"phases":["Faza A","Faza B"],"agents":[{"id":"a","done":true},{"id":"b","done":false}]}"#)
    #expect(WorkflowRunModel.untagged(untagged))
    #expect(!WorkflowRunModel.untagged(runB))
    #expect(!WorkflowRunModel.untagged(run(#"{"phases":["Faza A"],"agents":[]}"#)))
    #expect(WorkflowRunModel.spoken(untagged) == "fazy: Faza A, Faza B; agenci: #1 skończył, #2 pracuje")
    #expect(WorkflowRunModel.spoken(run(#"{"phases":[],"agents":[{"id":"a","done":false}]}"#)) == "agenci: #1 pracuje")
  }
}

@Suite("workflow: stan fazy, faza bieżąca, licznik n/m (szyna PWA)")
struct WorkflowRailTests {
  @Test("faza bez agentów jeszcze nie ruszyła — ○, a nie „wszyscy z zera skończyli”")
  func emptyIsPending() {
    #expect(WorkflowRunModel.phaseState(phaseRow("A", [])) == .pending)
  }

  @Test("ma agentów i wszyscy skończyli = done; jeden żywy = running")
  func doneAndRunning() {
    #expect(WorkflowRunModel.phaseState(phaseRow("A", [true, true])) == .done)
    #expect(WorkflowRunModel.phaseState(phaseRow("A", [true, false])) == .running)
  }

  @Test("faza po ✓, która dostaje nowego agenta, wraca do ● (stan bez pamięci)")
  func grownPhase() {
    let done = phaseRow("A", [true])
    #expect(WorkflowRunModel.phaseState(done) == .done)
    var grown = done
    grown.agents.append(WorkflowAgentRow(id: "x", name: "verify#2", done: false))
    #expect(WorkflowRunModel.phaseState(grown) == .running)
  }

  @Test("dwie żywe fazy: bieżąca jest pierwsza w kolejności skryptu")
  func firstLive() {
    #expect(WorkflowRunModel.openPhase([phaseRow("A", [false]), phaseRow("B", [false])]) == 0)
  }

  @Test("nikt nie pracuje: bieżąca jest OSTATNIA, w której ktokolwiek ruszył")
  func lastMoved() {
    #expect(WorkflowRunModel.openPhase([phaseRow("A", [true]), phaseRow("B", [true]), phaseRow("C", [])]) == 1)
  }

  @Test("plan bez ani jednego agenta = nie ma bieżącej fazy")
  func noneMoved() {
    #expect(WorkflowRunModel.openPhase([phaseRow("A", []), phaseRow("B", [])]) == nil)
    #expect(WorkflowRunModel.openPhase([]) == nil)
  }

  @Test("na żywym rozkładzie bieżąca jest faza z pracującym agentem")
  func liveRun() {
    let rows = WorkflowRunModel.rows(runA)
    #expect(WorkflowRunModel.openPhase(rows).map { rows[$0].title } == "A2 Serwer")
  }

  @Test("n/m: fazy skończone z faz planu; faza spoza planu nie wchodzi do m; bez planu m rośnie z tagami")
  func railTally() {
    #expect(WorkflowRunModel.railTally(runA) == "1/3")
    #expect(WorkflowRunModel.railTally(runAUnplanned) == "1/3")
    #expect(WorkflowRunModel.railTally(run(#"{"phases":["A","B"],"agents":[{"id":"x","done":true}]}"#)) == "",
      "zero otagowanych agentów = bez licznika, „0/0” nie jest informacją")
  }
}

@Suite("workflow: przypadki brzegowe")
struct WorkflowEdgeTests {
  @Test("plan bez agentów: fazy ○ bez bieżącej, bez licznika, bez podsumowania")
  func planWithoutAgents() {
    let plan = run(#"{"phases":["A","B"],"agents":[]}"#)
    #expect(WorkflowRunModel.phaseCounts(plan) == nil)
    let rows = WorkflowRunModel.rows(plan)
    #expect(rows.map(\.title) == ["A", "B"])
    #expect(rows.map(WorkflowRunModel.phaseState) == [.pending, .pending])
    #expect(WorkflowRunModel.openPhase(rows) == nil)
    #expect(WorkflowRunModel.railTally(plan) == "" && WorkflowRunModel.tally(plan) == "" && WorkflowRunModel.spoken(plan) == "")
    let section = WorkflowSection(taskId: "t", run: plan)
    #expect(section.summary == nil, "pusty przebieg nie dostaje pustej linii podsumowania")
    #expect(section.phases.map(\.count) == [nil, nil])
  }

  @Test("tagi bez planu: fazy z tagów, licznik rośnie z każdą nową fazą")
  func tagsWithoutPlan() {
    let tagged = run(#"{"phases":[],"agents":[{"id":"1","phase":"X","done":true},{"id":"2","phase":"Y","done":false}]}"#)
    #expect(WorkflowRunModel.railTally(tagged) == "1/2")
    let section = WorkflowSection(taskId: "t", run: tagged)
    #expect(section.phases.map(\.title) == ["X", "Y"])
    #expect(section.phases.allSatisfy { $0.note == nil }, "bez planu nic nie jest „poza planem”")
  }

  @Test("przejście bez tagów → z fazami (serwer doczytuje tagi później): wiersze agentów zachowują tożsamość")
  func untaggedThenTagged() throws {
    let before = run(#"{"phases":["A","B"],"agents":[{"id":"1","done":true},{"id":"2","done":false}]}"#)
    let after = run(#"{"phases":["A","B"],"agents":[{"id":"1","phase":"A","label":"impl","done":true},{"id":"2","phase":"B","label":"verify","done":false}]}"#)
    let untagged = WorkflowSection(taskId: "t", run: before)
    #expect(untagged.untagged && untagged.plan == "fazy: A · B" && untagged.current == nil)
    let tagged = WorkflowSection(taskId: "t", run: after)
    #expect(!tagged.untagged && tagged.plan == nil)
    #expect(tagged.current.map { tagged.phases[$0].title } == "B")
    let ids = { (lines: [WorkflowLine]) in lines.compactMap { line -> String? in
      if case .agent = line { return line.id }
      return nil
    } }
    let beforeIds = ids(untagged.lines(withDone(WorkflowExpansion(), WorkflowExpansion.Key(task: "t", phase: nil))))
    let afterIds = ids(tagged.lines(withDone(
      opened(WorkflowExpansion.Key(task: "t", phase: "A")), WorkflowExpansion.Key(task: "t", phase: "A"))))
    #expect(Set(beforeIds) == Set(afterIds), "agent przechodzi pod fazę bez zmiany tożsamości wiersza")
  }

  @Test("jedyny żywy agent spoza planu: panel ● przy nim, karta zostaje przy planie (świadoma rozbieżność)")
  func onlyLiveOffPlan() throws {
    let offPlan = run(#"""
      {"phases":["A","B"],"agents":[{"id":"1","phase":"A","done":true},{"id":"2","phase":"Fix","done":false}]}
      """#)
    let section = WorkflowSection(taskId: "t", run: offPlan)
    let current = try #require(section.current)
    #expect(section.phases[current].title == "Fix" && section.phases[current].note == UICopy.workflowOffPlan)
    // Karta liczy z planu (`phaseCounts` pomija fazę spoza listy): „gdzie w planie jesteśmy”.
    #expect(ActivityText.phaseCopy(WorkflowRunModel.phaseCounts(offPlan)) == "faza 1/2 A")
    #expect(WorkflowRunModel.railTally(offPlan) == "1/2")
  }

  @Test("powtórzony tytuł planu: phaseCounts liczy do ostatniego, rows trzyma pierwsze miejsce (lustro Map w PWA)")
  func duplicatedPlanTitle() {
    let duplicated = run(#"""
      {"phases":["A","A","B"],"agents":[{"id":"1","phase":"A","done":true},{"id":"2","phase":"","done":false}]}
      """#)
    #expect(counts(WorkflowRunModel.phaseCounts(duplicated)) == ["A 0/0", "A 1/1", "B 0/0"])
    let rows = WorkflowRunModel.rows(duplicated)
    #expect(rows.map(\.title) == ["A", "B", ""])
    #expect(rows.map { $0.agents.map(\.id) } == [["1"], [], ["2"]])
    #expect(rows.map(\.loose) == [false, false, true], "faza pusta (\"\") to agent bez fazy")
  }

  @Test("faza pusta bez planu: phaseCounts ma ją jako fazę z tagu, rozkład — jako grupę bez fazy")
  func emptyPhaseTag() {
    let empty = run(#"{"phases":[],"agents":[{"id":"1","phase":"","done":false}]}"#)
    #expect(counts(WorkflowRunModel.phaseCounts(empty)) == [" 1/0"])
    #expect(!WorkflowRunModel.untagged(empty), "pusty tag to wciąż tag (jak `phase !== undefined` w PWA)")
    #expect(WorkflowRunModel.rows(empty).map(\.loose) == [true])
    #expect(WorkflowRunModel.railTally(empty) == "0/1")
  }

  /// Klucz grupy bez fazy był napisem, który mógł zgadzać się z tytułem fazy.
  @Test("grupa bez fazy i faza o tytule „bez fazy” mają osobne rozwinięcie i osobne tożsamości wierszy")
  func looseIsNotATitle() throws {
    let clash = run(#"""
      {"phases":[],"agents":[{"id":"1","phase":"bez fazy","done":false},{"id":"2","done":false}]}
      """#)
    let section = WorkflowSection(taskId: "t", run: clash)
    #expect(section.phases.map(\.title) == ["bez fazy", "bez fazy"])
    #expect(section.phases[0].key != section.phases[1].key)
    #expect(section.phases[1].key == WorkflowExpansion.Key(task: "t", phase: nil))
    var expansion = WorkflowExpansion()
    expansion.toggle(section.phases[1].key, current: false)
    let lines = section.lines(expansion)
    #expect(Set(lines.map(\.id)).count == lines.count)
    #expect(lines.map(\.id) == ["wf:t:summary", "wf:t:phase:bez fazy", "wf:t:agent:1", "wf:t:loose", "wf:t:agent:2"])
  }

  @Test("czas żywego agenta tylko z poprawnego startedAt; skończony czasu nie ma")
  func startedAt() throws {
    let times = run(#"""
      {"phases":["A"],"agents":[
        {"id":"ok","phase":"A","done":false,"startedAt":"2026-09-16T06:00:00.000Z"},
        {"id":"bad","phase":"A","done":false,"startedAt":"wczoraj"},
        {"id":"none","phase":"A","done":false},
        {"id":"done","phase":"A","done":true,"startedAt":"2026-09-16T06:00:00.000Z"}]}
      """#)
    let section = WorkflowSection(taskId: "t", run: times)
    let expansion = withDone(WorkflowExpansion(), WorkflowExpansion.Key(task: "t", phase: "A"))
    let agents = section.lines(expansion).compactMap { line -> WorkflowAgentItem? in
      if case let .agent(_, item) = line { return item }
      return nil
    }
    #expect(agents.map(\.id) == ["ok", "bad", "none", "done"])
    #expect(agents.map { $0.since != nil } == [true, false, false, false])
    let now = try #require(ServerTime.parse("2026-09-16T06:04:00.000Z"))
    #expect(UICopy.workflowAgentSpoken(agents[0], now: now) == "#1 pracuje, od 4 minut")
    #expect(UICopy.workflowAgentSpoken(agents[1], now: now) == "#2 pracuje")
    #expect(UICopy.workflowAgentSpoken(agents[3], now: now) == "#4 skończył")
  }

  @Test("200 agentów (sufit serwera): numery w całym przebiegu, liczniki, jeden wiersz na agenta")
  func twoHundred() {
    let agents = (1...200).map { #"{"id":"a\#($0)","phase":"\#($0 <= 150 ? "A" : "B")","done":\#($0 < 200)}"# }
    let big = run(#"{"phases":["A","B"],"agents":[\#(agents.joined(separator: ","))]}"#)
    #expect(WorkflowRunModel.tally(big) == "199 skończyło · 1 pracuje")
    #expect(WorkflowRunModel.railTally(big) == "1/2")
    let section = WorkflowSection(taskId: "t", run: big)
    #expect(section.phases.map(\.count) == ["150/150", "49/50"])
    let keyA = WorkflowExpansion.Key(task: "t", phase: "A")
    let keyB = WorkflowExpansion.Key(task: "t", phase: "B")
    #expect(section.lines(opened(keyA)).map(\.id) == [
      "wf:t:summary", "wf:t:phase:A", "wf:t:done:A", "wf:t:phase:B", "wf:t:agent:a200", "wf:t:done:B",
    ], "żywy agent na wierzchu, 199 skończonych w dwóch zwiniętych wierszach")
    let lines = section.lines(withDone(opened(keyA), keyA, keyB))
    #expect(lines.count == 1 + 2 + 2 + 200, "podsumowanie, dwie fazy, dwa wiersze skończonych i każdy agent")
    #expect(Set(lines.map(\.id)).count == lines.count, "tożsamości wierszy są unikalne")
    #expect(lines.last?.id == "wf:t:agent:a199")
  }
}

@Suite("workflow: sekcja panelu „w tle”")
struct WorkflowSectionTests {
  @Test("podsumowanie: n/m faz, skończeni i pracujący; czytnik dostaje jedno zdanie o przebiegu")
  func summary() throws {
    let section = WorkflowSection(taskId: "t", run: runA)
    let summary = try #require(section.summary)
    #expect(summary.text == "1/3 faz · 3 skończyło · 3 pracują")
    #expect(summary.spoken == "Przebieg workflow: skończone fazy 1 z 3, 3 skończyło, 3 pracują. "
      + "A1 Migracja: impl skończył, verify skończył; A2 Serwer: impl pracuje, verify skończył; "
      + "Faza spoza skryptu: #5 pracuje; bez fazy: #6 pracuje")
  }

  @Test("fazy: glif stanu, licznik skończeni/ruszyli, spoza planu i „bez fazy” na końcu z dopiskiem")
  func phases() {
    let section = WorkflowSection(taskId: "t", run: runA)
    #expect(section.phases.map(\.title) == ["A1 Migracja", "A2 Serwer", "A3 Shared", "Faza spoza skryptu", "bez fazy"])
    #expect(section.phases.map(\.state) == [.done, .running, .pending, .running, .running])
    #expect(section.phases.map(\.symbol) == ["checkmark", "circle.fill", "circle", "circle.fill", "circle.fill"],
      "znak stanu niesie znaczenie, kolor go tylko powtarza")
    #expect(section.phases.map(\.count) == ["2/2", "1/2", nil, "0/1", "0/1"])
    #expect(section.phases.map(\.note) == [nil, nil, nil, UICopy.workflowOffPlan, nil])
    #expect(section.phases.map(\.secondary) == [false, false, false, true, true])
    #expect(section.phases.map(\.expandable) == [true, true, false, true, true], "pusta faza nie ma czego rozwinąć")
    #expect(section.current == 1)
    #expect(section.phases[1].spoken == "A2 Serwer: w toku, skończonych 1 z 2")
    #expect(section.phases[0].spoken == "A1 Migracja: skończona, skończonych 2 z 2")
    #expect(section.phases[2].spoken == "A3 Shared: jeszcze nie ruszyła")
    #expect(section.phases[3].spoken == "Faza spoza skryptu, poza planem: w toku, skończonych 0 z 1")
  }

  @Test("domyślnie rozwinięta jest bieżąca faza: jej żywi agenci, pod nimi zwinięty wiersz skończonych")
  func defaultLines() {
    let section = WorkflowSection(taskId: "t", run: runA)
    #expect(section.lines(WorkflowExpansion()).map(\.id) == [
      "wf:t:summary", "wf:t:phase:A1 Migracja", "wf:t:phase:A2 Serwer", "wf:t:agent:a3", "wf:t:done:A2 Serwer",
      "wf:t:phase:A3 Shared", "wf:t:phase:Faza spoza skryptu", "wf:t:loose",
    ])
  }

  @Test("bez tagów: linia planu bez glifów i licznika, pod nią agenci zawsze widoczni")
  func untaggedLines() {
    let section = WorkflowSection(taskId: "t", run: run(#"{"phases":["A","B"],"agents":[{"id":"1","done":true},{"id":"2","done":false}]}"#))
    #expect(section.summary?.text == "1 skończył · 1 pracuje", "bez tagów licznika faz nie ma")
    #expect(section.lines(WorkflowExpansion()).map(\.id) == [
      "wf:t:summary", "wf:t:plan", "wf:t:agents", "wf:t:agent:2", "wf:t:done-loose",
    ], "ten sam układ co pod fazą: żywi, potem zwinięci skończeni")
  }
}

@Suite("workflow: żywi na wierzchu, skończeni pod jednym wierszem")
struct WorkflowDoneGroupTests {
  private let mixed = run(#"""
    {"phases":["A"],"agents":[
      {"id":"d1","phase":"A","label":"d1","done":true},{"id":"l1","phase":"A","label":"l1","done":false},
      {"id":"d2","phase":"A","label":"d2","done":true},{"id":"l2","phase":"A","label":"l2","done":false}]}
    """#)
  private let keyA = WorkflowExpansion.Key(task: "t", phase: "A")

  private func doneGroups(_ lines: [WorkflowLine]) -> [(group: WorkflowDoneGroup, expanded: Bool)] {
    lines.compactMap { line in
      if case let .doneGroup(group, expanded) = line { return (group, expanded) }
      return nil
    }
  }

  @Test("układ stały: żywi w kolejności startu, potem „✓ N skończyło”; skończeni dopiero po ręcznym rozwinięciu")
  func order() throws {
    let section = WorkflowSection(taskId: "t", run: mixed)
    #expect(section.lines(WorkflowExpansion()).map(\.id) == [
      "wf:t:summary", "wf:t:phase:A", "wf:t:agent:l1", "wf:t:agent:l2", "wf:t:done:A",
    ])
    let group = try #require(doneGroups(section.lines(WorkflowExpansion())).first)
    #expect(group.group.count == 2 && !group.expanded, "domyślnie zwinięty")
    #expect(UICopy.agentsDone(group.group.count) == "2 skończyło")
    #expect(group.group.spoken == "A: 2 skończyło")
    #expect(section.lines(withDone(WorkflowExpansion(), keyA)).map(\.id) == [
      "wf:t:summary", "wf:t:phase:A", "wf:t:agent:l1", "wf:t:agent:l2", "wf:t:done:A", "wf:t:agent:d1", "wf:t:agent:d2",
    ], "skończeni pod swoim wierszem, w kolejności startu")
  }

  @Test("faza bez żywych: sam wiersz skończonych; faza bez skończonych: sami żywi")
  func edges() {
    let allDone = WorkflowSection(taskId: "t", run: run(#"{"phases":["A"],"agents":[{"id":"1","phase":"A","done":true}]}"#))
    #expect(allDone.lines(WorkflowExpansion()).map(\.id) == ["wf:t:summary", "wf:t:phase:A", "wf:t:done:A"])
    let allLive = WorkflowSection(taskId: "t", run: run(#"{"phases":["A"],"agents":[{"id":"1","phase":"A","done":false}]}"#))
    #expect(allLive.lines(WorkflowExpansion()).map(\.id) == ["wf:t:summary", "wf:t:phase:A", "wf:t:agent:1"])
  }

  @Test("agent, który kończy, schodzi z żywych, a licznik rośnie o 1; rozwinięcie skończonych przeżywa ramkę")
  func agentFinishes() throws {
    let after = run(#"""
      {"phases":["A"],"agents":[
        {"id":"d1","phase":"A","label":"d1","done":true},{"id":"l1","phase":"A","label":"l1","done":true},
        {"id":"d2","phase":"A","label":"d2","done":true},{"id":"l2","phase":"A","label":"l2","done":false}]}
      """#)
    let lines = WorkflowSection(taskId: "t", run: after).lines(withDone(WorkflowExpansion(), keyA))
    #expect(lines.map(\.id) == [
      "wf:t:summary", "wf:t:phase:A", "wf:t:agent:l2", "wf:t:done:A", "wf:t:agent:d1", "wf:t:agent:l1", "wf:t:agent:d2",
    ])
    let group = try #require(doneGroups(lines).first)
    #expect(group.group.count == 3 && group.expanded)
  }

  @Test("stan listy skończonych: klucz zadanie + faza, niezależny od rozwinięcia samej fazy")
  func keyed() {
    var expansion = WorkflowExpansion()
    expansion.toggleDone(keyA)
    #expect(expansion.isDoneExpanded(keyA))
    #expect(!expansion.isDoneExpanded(WorkflowExpansion.Key(task: "t2", phase: "A")))
    #expect(!expansion.isDoneExpanded(WorkflowExpansion.Key(task: "t", phase: nil)))
    expansion.toggle(keyA, current: false)
    expansion.toggle(keyA, current: false)
    #expect(expansion.isDoneExpanded(keyA), "zwinięcie i rozwinięcie fazy nie gubi listy skończonych")
    expansion.toggleDone(keyA)
    #expect(!expansion.isDoneExpanded(keyA))
  }
}

@Suite("workflow: rozwinięcie faz przeżywa odświeżenie")
struct WorkflowExpansionTests {
  private let key = { (task: String, phase: String) in WorkflowExpansion.Key(task: task, phase: phase) }

  @Test("bieżąca rozwinięta sama; ręcznie otwarta inna zostaje przy zmianie bieżącej")
  func manualSurvivesCurrentChange() {
    var expansion = WorkflowExpansion()
    #expect(expansion.isExpanded(key("t", "B"), current: true))
    #expect(!expansion.isExpanded(key("t", "A"), current: false))
    expansion.toggle(key("t", "A"), current: false)
    expansion.noteCurrent([key("t", "B")])
    // Bieżąca przechodzi z B do C: C rozwija się sama, A (ręka) i B (widziana jako bieżąca) zostają.
    #expect(expansion.isExpanded(key("t", "A"), current: false))
    #expect(expansion.isExpanded(key("t", "B"), current: false), "odświeżenie nie zwija rozwiniętej fazy")
    #expect(expansion.isExpanded(key("t", "C"), current: true))
  }

  @Test("ręcznie zwinięta bieżąca zostaje zwinięta przy kolejnych ramkach")
  func manualClose() {
    var expansion = WorkflowExpansion()
    expansion.noteCurrent([key("t", "B")])
    expansion.toggle(key("t", "B"), current: true)
    #expect(!expansion.isExpanded(key("t", "B"), current: true))
    expansion.noteCurrent([key("t", "B")])
    #expect(!expansion.isExpanded(key("t", "B"), current: true))
    expansion.toggle(key("t", "B"), current: true)
    #expect(expansion.isExpanded(key("t", "B"), current: true))
  }

  @Test("zwinięcie fazy innej niż bieżąca wraca do stanu domyślnego")
  func closeOther() {
    var expansion = WorkflowExpansion()
    expansion.toggle(key("t", "A"), current: false)
    expansion.toggle(key("t", "A"), current: false)
    #expect(!expansion.isExpanded(key("t", "A"), current: false))
    #expect(expansion.isExpanded(key("t", "A"), current: true), "gdy stanie się bieżąca, rozwinie się sama")
  }

  @Test("klucz to zadanie + tytuł: dwa przebiegi z tymi samymi fazami są od siebie niezależne")
  func perTask() {
    var expansion = WorkflowExpansion()
    expansion.toggle(key("t1", "Review"), current: false)
    #expect(expansion.isExpanded(key("t1", "Review"), current: false))
    #expect(!expansion.isExpanded(key("t2", "Review"), current: false))
  }
}

@Suite("workflow: panel nieświeży")
struct WorkflowFreshnessTests {
  private let t0 = Sample.now

  private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

  @Test("sesja bez kontaktu ze źródłem albo lista z pamięci zamraża panel")
  func staleSources() {
    var link = ConnectionMemory()
    link.observe(.online, now: t0)
    #expect(!WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: t0))
    #expect(WorkflowRunModel.frozen(sessionStale: true, listStale: false, link: link, now: t0))
    #expect(WorkflowRunModel.frozen(sessionStale: false, listStale: true, link: link, now: t0))
  }

  /// Pętla strumienia przeplata `offline` i `connecting` przy każdej próbie, a reguła
  /// po samym bieżącym stanie odmrażała panel co próbę (znikał komunikat, zegary ruszały od nowa).
  @Test("ponawianie offline → connecting → offline: panel stoi zamrożony od początku CAŁEJ przerwy")
  func retriesKeepFrozen() {
    var link = ConnectionMemory()
    link.observe(.online, now: t0)
    link.observe(.offline(since: at(10)), now: at(10))
    #expect(WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: at(10)))
    link.observe(.connecting(since: at(12)), now: at(12))
    #expect(WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: at(12)))
    #expect(WorkflowRunModel.streamDownSince(link, now: at(12)) == at(10))
    link.observe(.offline(since: at(14)), now: at(14))
    #expect(WorkflowRunModel.streamDownSince(link, now: at(14)) == at(10), "zegar stoi od pierwszej porażki")
    link.observe(.online, now: at(20))
    #expect(!WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: at(20)), "świeże dane wznawiają")
  }

  @Test("pierwsza próba łączenia nie mruga: zamrożenie dopiero po sekundzie")
  func firstAttempt() {
    var link = ConnectionMemory()
    link.observe(.connecting(since: t0), now: t0)
    #expect(!WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: at(0.5)))
    #expect(WorkflowRunModel.frozen(sessionStale: false, listStale: false, link: link, now: at(1.5)))
  }
}
