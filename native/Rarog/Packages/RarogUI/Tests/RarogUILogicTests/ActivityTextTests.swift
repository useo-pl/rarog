import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Co agent robi teraz: wiersz aktywności i linia etapu karty.
// Nazwy narzędzi w próbkach są neutralne — delegację rozpoznaje pole `delegation`, nie nazwa.

private func activity(_ json: String) -> ViewActivity {
  ViewActivity(Sample.decode(Activity.self, json))
}

private func tasks(_ json: String) -> [BackgroundTask] {
  Sample.decode([BackgroundTask].self, json)
}

private let phases = #"[{"title":"A1 Kontrakt","agents":2,"done":2},{"title":"A2 Serwer","agents":3,"done":1},{"title":"A3 PWA","agents":0,"done":0}]"#

@Suite("aktywność: zdanie linii karty listy i delegacji")
struct ActivityCopyTests {
  @Test("narzędzie: czasownik z mapy copy, skrócona ścieżka, zapas dla nieznanego i pustego")
  func tool() {
    let read = activity(#"{"kind":"tool","toolName":"Read","summary":"/Users/d/a/b/c/d.ts"}"#)
    #expect(ActivityText.copy(read) == ActivityLine(lead: "czyta plik: …/b/c/d.ts"))
    #expect(ActivityText.copy(activity(#"{"kind":"tool","toolName":"Frobnicate"}"#)).lead == "uruchamia: Frobnicate")
    #expect(ActivityText.copy(activity(#"{"kind":"tool"}"#)).lead == "używa narzędzia")
  }

  @Test("czeka na silnik: zdanie serwera albo domyślne")
  func waiting() {
    #expect(ActivityText.copy(activity(#"{"kind":"waiting"}"#)).lead == "czeka na silnik…")
    #expect(ActivityText.copy(activity(#"{"kind":"waiting","summary":"ponawiam (3/10)"}"#)).lead == "ponawiam (3/10)")
  }

  @Test("delegacja tylko po polu: pojedynczy subagent krótko, workflow z nazwą, fazą i licznikami")
  func delegation() {
    let single = activity(#"{"kind":"tool","toolName":"Spawn","delegation":"agents"}"#)
    #expect(ActivityText.copy(single) == ActivityLine(lead: "subagent pracuje"))
    let noField = activity(#"{"kind":"tool","toolName":"Spawn"}"#)
    #expect(ActivityText.copy(noField).lead == "uruchamia: Spawn", "bez pola to zwykłe narzędzie")
    let workflow = activity(#"""
      {"kind":"tool","toolName":"Spawn","delegation":"workflow","workflow":"refaktor","agents":3,"agentsDone":2,
       "phases":\#(phases)}
      """#)
    #expect(ActivityText.copy(workflow)
      == ActivityLine(lead: "workflow: refaktor", tail: "faza 2/3 A2 Serwer · 3 agenty · 2 skończyło"))
    let unknownDone = activity(#"{"kind":"tool","delegation":"agents","agents":4}"#)
    #expect(ActivityText.copy(unknownDone).tail == "4 agenty", "brak agentsDone = nie wiem, nie zero")
    let oneOfWorkflow = activity(#"{"kind":"tool","delegation":"workflow","agents":1}"#)
    #expect(ActivityText.copy(oneOfWorkflow) == ActivityLine(lead: "workflow", tail: "1 agent"))
  }

  @Test("faza: tytuł dłuższy niż 24 znaki znika; wszyscy skończyli → ostatnia ruszona")
  func phase() throws {
    let long = Sample.decode([ActivityPhase].self, #"[{"title":"Bardzo długi tytuł fazy planu workflow","agents":1,"done":0}]"#)
    #expect(ActivityText.phaseCopy(long) == "faza 1/1")
    let finished = Sample.decode([ActivityPhase].self, #"[{"title":"A","agents":1,"done":1},{"title":"B","agents":2,"done":2},{"title":"C","agents":0,"done":0}]"#)
    #expect(ActivityText.phaseCopy(finished) == "faza 2/3 B")
    #expect(ActivityText.phaseCopy([]) == "")
  }

  @Test("czas dla czytnika pełnym słowem w dopełniaczu (po „od”)")
  func spokenDuration() {
    #expect(UICopy.spokenDuration(1) == "1 sekundy" && UICopy.spokenDuration(3) == "3 sekund")
  }
}

@Suite("aktywność: pasek workflow i linia etapu karty")
struct ActivityCardTests {
  @Test("pasek: segment na fazę (pusta faza = pusty segment), bez planu jeden z liczników")
  func segments() throws {
    let planned = activity(#"{"kind":"tool","delegation":"workflow","agents":2,"phases":\#(phases)}"#)
    let segments = try #require(ActivityText.workflowSegments(planned))
    #expect(segments.map(\.fill) == [1, 1.0 / 3.0, 0])
    #expect(segments.map(\.active) == [false, true, false])
    let counted = activity(#"{"kind":"tool","delegation":"agents","agents":3,"agentsDone":1}"#)
    #expect(ActivityText.workflowSegments(counted) == [ProgressSegment(fill: 0.25, active: true)])
    #expect(ActivityText.workflowSegments(activity(#"{"kind":"tool","delegation":"agents","agents":1}"#)) == nil,
      "pojedynczy subagent bez licznika: paska nie ma")
    #expect(ActivityText.workflowSegments(activity(#"{"kind":"tool","agentsDone":1,"agents":1}"#)) == nil)
  }

  @Test("karta: zdanie bez licznika; pod paskiem bez słowa „workflow:”; subagent z opisem")
  func cardText() {
    let read = activity(#"{"kind":"tool","toolName":"Read","summary":"/Users/d/a/b/c/d.ts"}"#)
    #expect(ActivityText.cardText(read) == "czyta plik: …/b/c/d.ts")
    let workflow = activity(#"{"kind":"tool","delegation":"workflow","workflow":"refaktor","agents":3,"agentsDone":2}"#)
    #expect(ActivityText.cardText(workflow) == "refaktor · 3 agenty · 2 skończyło")
    let noProgress = activity(#"{"kind":"tool","delegation":"workflow","workflow":"refaktor","agents":3}"#)
    #expect(ActivityText.cardText(noProgress) == "workflow: refaktor · 3 agenty", "bez paska słowo zostaje")
    let described = activity(#"{"kind":"tool","delegation":"agents","summary":"Research: limity"}"#)
    #expect(ActivityText.cardText(described) == "subagent: Research: limity")
    let bare = activity(#"{"kind":"tool","delegation":"agents"}"#)
    let live = tasks(#"[{"id":"t1","kind":"command","command":"ls"},{"id":"t2","kind":"agent","description":"Przegląd"}]"#)
    #expect(ActivityText.cardText(bare, tasks: live) == "subagent: Przegląd", "opis z żywego zadania w tle")
    // Agent w postoju nie jest tym, o którym mówi aktywność „subagent pracuje".
    let standing = tasks(#"""
      [{"id":"t1","kind":"agent","description":"Stoi","waitingSince":"2026-10-10T06:00:00.000Z"},
       {"id":"t2","kind":"agent","description":"Pracuje"}]
      """#)
    #expect(ActivityText.cardText(bare, tasks: standing) == "subagent: Pracuje")
    #expect(ActivityText.cardText(bare, tasks: [standing[0]]) == "subagent pracuje", "sam stojący: bez pożyczonego opisu")
    #expect(ActivityText.cardText(activity(#"{"kind":"idle"}"#)) == "")
  }

  @Test("forma delegacji po polach, nie po zdaniu: zdanie serwera równe copy apki nie udaje subagenta")
  func delegationFormFromFields() {
    #expect(ActivityText.delegationForm(activity(#"{"kind":"tool","delegation":"agents"}"#)) == .subagent)
    #expect(ActivityText.delegationForm(activity(#"{"kind":"tool","delegation":"agents","agents":2}"#)) == .workflow)
    #expect(ActivityText.delegationForm(activity(#"{"kind":"tool","delegation":"workflow"}"#)) == .workflow)
    #expect(ActivityText.delegationForm(activity(#"{"kind":"tool","toolName":"Spawn"}"#)) == nil)
    // Czeka na silnik ze zdaniem serwera brzmiącym jak copy apki: porównanie tekstu brałoby je za subagenta.
    let lookalike = activity(#"{"kind":"waiting","summary":"subagent pracuje","delegation":"agents"}"#)
    #expect(ActivityText.delegationForm(lookalike) == nil)
    #expect(ActivityText.cardText(lookalike, tasks: tasks(#"[{"id":"t","kind":"agent","description":"Opis"}]"#))
      == "subagent pracuje")
  }

  @Test("zadania w tle po turze: rodzaj i opis jednego, liczba przy wielu, nieznany rodzaj ogólnie")
  func background() {
    #expect(ActivityText.backgroundText(tasks(#"[{"id":"t","kind":"command","command":"pnpm test"}]"#)) == "w tle: komenda · pnpm test")
    #expect(ActivityText.backgroundText(tasks(#"[{"id":"t","kind":"monitor"}]"#)) == "w tle: monitor")
    #expect(ActivityText.backgroundText(tasks(#"[{"id":"t","kind":"przyszly"}]"#)) == "w tle: zadanie")
    let three = tasks(#"[{"id":"a","kind":"agent"},{"id":"b","kind":"agent"},{"id":"c","kind":"command"}]"#)
    #expect(ActivityText.backgroundText(three) == "3 w tle")
    #expect(ActivityText.backgroundText([]) == "")
  }

  @Test("sami subagenci w postoju: „czeka: subagent · opis”, przy kilku liczba; obok pracy liczba wszystkich")
  func backgroundWaitingAgents() {
    let since = #""waitingSince":"2026-10-10T06:00:00.000Z""#
    let one = tasks(#"[{"id":"a","kind":"agent","description":"Research herdr API",\#(since)}]"#)
    #expect(ActivityText.backgroundText(one) == "czeka: subagent · Research herdr API")
    #expect(ActivityText.backgroundText(tasks(#"[{"id":"a","kind":"agent",\#(since)}]"#)) == "czeka: subagent")
    let two = tasks(#"[{"id":"a","kind":"agent",\#(since)},{"id":"b","kind":"agent","description":"x",\#(since)}]"#)
    #expect(ActivityText.backgroundText(two) == "czeka: 2 subagenty")
    let five = tasks("[" + (1...5).map { #"{"id":"a\#($0)","kind":"agent",\#(since)}"# }.joined(separator: ",") + "]")
    #expect(ActivityText.backgroundText(five) == "czeka: 5 subagentów")
    let mixed = tasks(#"[{"id":"a","kind":"agent",\#(since)},{"id":"c","kind":"command","command":"ls"}]"#)
    #expect(ActivityText.backgroundText(mixed) == "2 w tle", "obok pracy linia liczy wszystkie zadania")
    // Pole przy komendzie nic nie znaczy: komenda nie „czeka".
    let odd = tasks(#"[{"id":"c","kind":"command","command":"ls",\#(since)}]"#)
    #expect(ActivityText.backgroundText(odd) == "w tle: komenda · ls")
  }

  /// Faza PRZED nazwą — linia karty jest jednowierszowa z wielokropkiem od
  /// końca, więc to, co stoi ostatnie, ginie pierwsze. Ta sama reguła co karta pracująca (`phaseCopy`).
  @Test("workflow w tle z rozkładem: faza z planu przed nazwą; długi tytuł = sam numer; bez tagów bez fazy")
  func backgroundWorkflowPhase() {
    func workflow(_ run: String, description: String? = "przegląd M1") -> [BackgroundTask] {
      let field = description.map { #","description":"\#($0)""# } ?? ""
      return tasks(#"[{"id":"w","kind":"workflow"\#(field),"run":\#(run)}]"#)
    }
    let review = #"""
      {"phases":["Implementacja","Review","Poprawki"],"agents":[
        {"id":"1","phase":"Implementacja","done":true},{"id":"2","phase":"Review","done":false},
        {"id":"3","phase":"Spoza planu","done":false}]}
      """#
    #expect(ActivityText.backgroundText(workflow(review)) == "w tle: workflow · faza 2/3 Review · przegląd M1")
    #expect(ActivityText.backgroundText(workflow(review, description: nil)) == "w tle: workflow · faza 2/3 Review")
    let long = #"{"phases":["Bardzo długi tytuł fazy planu workflow"],"agents":[{"id":"1","phase":"Bardzo długi tytuł fazy planu workflow","done":false}]}"#
    #expect(ActivityText.backgroundText(workflow(long)) == "w tle: workflow · faza 1/1 · przegląd M1")
    let untagged = #"{"phases":["A","B"],"agents":[{"id":"1","done":false}]}"#
    #expect(ActivityText.backgroundText(workflow(untagged)) == "w tle: workflow · przegląd M1", "bez tagów fazy nie znamy")
    let noRun = tasks(#"[{"id":"w","kind":"workflow","description":"przegląd M1"}]"#)
    #expect(ActivityText.backgroundText(noRun) == "w tle: workflow · przegląd M1")
    let two = tasks(#"[{"id":"w","kind":"workflow","run":\#(review)},{"id":"c","kind":"command","command":"ls"}]"#)
    #expect(ActivityText.backgroundText(two) == "2 w tle", "wiele zadań: sama liczba, bez fazy pierwszego")
    let agentWithRun = tasks(#"[{"id":"a","kind":"agent","description":"Research","run":\#(review)}]"#)
    #expect(ActivityText.backgroundText(agentWithRun) == "w tle: subagent · Research", "fazę mówi tylko zadanie workflow")
  }

  /// Linia workflow w toku pod kartą listy — faza i nazwa, pasek z `phaseCounts`. Pasek mówi
  /// „workflow”, więc słowa „w tle: workflow” nad nim nie ma; bez rozkładu zostaje zdanie z `backgroundText`.
  @Test("linia workflow w toku: faza przed nazwą i pasek z rozkładu; bez rozkładu zdanie „w tle” bez paska")
  func liveWorkflowLine() throws {
    let run = #"""
      {"phases":["A1 Kontrakt","A2 Serwer","A3"],"agents":[
        {"id":"1","phase":"A1 Kontrakt","done":true},{"id":"2","phase":"A1 Kontrakt","done":true},
        {"id":"3","phase":"A2 Serwer","done":true},{"id":"4","phase":"A2 Serwer","done":false},
        {"id":"5","phase":"A2 Serwer","done":false}]}
      """#
    let planned = tasks(#"[{"id":"w","kind":"workflow","description":"refaktor","run":\#(run)}]"#)[0]
    let line = ActivityText.workflowStage(planned)
    #expect(line.text == "faza 2/3 A2 Serwer · refaktor")
    let segments = try #require(line.segments)
    #expect(segments.map(\.fill) == [1, 1.0 / 3.0, 0] && segments.map(\.active) == [false, true, false])
    let nameless = tasks(#"[{"id":"w","kind":"workflow","run":\#(run)}]"#)[0]
    #expect(ActivityText.workflowStage(nameless).text == "faza 2/3 A2 Serwer")
    let noRun = tasks(#"[{"id":"w","kind":"workflow","description":"refaktor"}]"#)[0]
    #expect(ActivityText.workflowStage(noRun).text == "w tle: workflow · refaktor")
    #expect(ActivityText.workflowStage(noRun).segments == nil)
  }

  @Test("który workflow: pierwszy z fazą w toku, inaczej pierwszy z listy; pusta lista — żaden")
  func liveWorkflowChoice() {
    let flying = #"{"phases":["A"],"agents":[{"id":"1","phase":"A","done":false}]}"#
    let list = tasks(#"""
      [{"id":"w0","kind":"workflow"},{"id":"w1","kind":"workflow","run":\#(flying)},
       {"id":"w2","kind":"workflow","run":\#(flying)}]
      """#)
    #expect(ActivityText.liveWorkflow(list)?.id == "w1")
    #expect(ActivityText.liveWorkflow([list[0]])?.id == "w0")
    #expect(ActivityText.liveWorkflow([]) == nil)
  }
}
