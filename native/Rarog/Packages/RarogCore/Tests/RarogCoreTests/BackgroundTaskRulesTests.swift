import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Reguły „co jest pracą w tle" (`BackgroundTaskRules.swift`) w jednej tabeli: każdy kształt listy zadań
// i odpowiedź każdej z trzech reguł pracy. Selektory, które o nie pytają, mają swoje testy (`SelectorTests`:
// ranga i ton, `LiveActivityInputTests`: liczniki i „zajęty"); tu widać RÓŻNICE między regułami, bo
// zmiana definicji pracy zaczyna się od tej tabeli. Subagent w postoju (`waitingSince`) i monitor
// nie są pracą ani dla wiersza listy, ani dla licznika kafla. Lustro po stronie serwera:
// `server/test/herdr-background-work.test.ts`.
//
// Pod tabelą stoją reguły, o które pytają modele `RarogUI`: `hasTasks` i `onlyWaitingAgents` nad listą
// oraz `waitingAgent` i `workingAgent` nad jednym zadaniem. Co modele z odpowiedzi składają (kropka,
// zdanie linii etapu, wiersz zadania), sprawdzają testy `RarogUILogicTests`.

@Suite("zadania w tle: trzy reguły pracy nad jedną listą (BackgroundTaskRules.swift)")
struct BackgroundTaskRulesTests {
  /// Kształt listy i odpowiedzi reguł: wiersz listy, licznik „pracuje" kafla, zegar ciszy kafla.
  struct Case: Sendable, CustomTestStringConvertible {
    let name: String
    /// Zadania w JSON-ie z drutu; `nil` = sesja bez pola `backgroundTasks`.
    let tasks: [String]?
    let keepsRowWorking: Bool
    let backgroundWork: Bool
    let openWorkflow: Bool
    var testDescription: String { name }
  }

  static func plain(_ kind: String) -> String { workflowTask("t-\(kind)", run: false, kind: kind) }
  static let closed = workflowTask("w-closed", agents: [true, true])
  /// Subagent w postoju: rodzaj `agent` z `waitingSince` i własną komendą, na którą czeka.
  static let waiting = agentTask("a-wait", waitingSince: "2026-10-10T06:00:00.000Z", ownTask: "sleep 300")
  static let waitingToo = agentTask("a-wait-2", waitingSince: "2026-10-10T06:05:00.000Z")

  static let cases: [Case] = [
    Case(name: "brak pola", tasks: nil, keepsRowWorking: false, backgroundWork: false, openWorkflow: false),
    Case(name: "komenda", tasks: [plain("command")], keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(name: "subagent", tasks: [plain("agent")], keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    // Monitor patrzy, nie pracuje. Na liście stoi (`hasTasks`), ale znaku pracy nie daje.
    Case(name: "monitor", tasks: [plain("monitor")], keepsRowWorking: false, backgroundWork: false, openWorkflow: false),
    Case(
      name: "monitor i komenda", tasks: [plain("monitor"), plain("command")],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(
      name: "monitor i otwarty workflow", tasks: [plain("monitor"), workflowTask("w", agents: [false])],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    // Rodzaj spoza tej wersji apki (wartownik `unsupported`) liczy się jak każde zadanie spoza workflow.
    Case(
      name: "rodzaj nieznany", tasks: [plain("cron")],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(
      name: "workflow bez rozkładu", tasks: [workflowTask("w", run: false)],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    Case(
      name: "workflow bez agentów", tasks: [workflowTask("w", agents: [])],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    Case(
      name: "workflow z agentem w locie", tasks: [workflowTask("w", agents: [true, false])],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    // Tu reguły się rozchodzą: wiersz listy dalej „pracuje w tle", kafel już nie.
    Case(
      name: "workflow, wszyscy agenci skończyli", tasks: [closed],
      keepsRowWorking: true, backgroundWork: false, openWorkflow: false),
    Case(
      name: "zamknięty workflow i komenda", tasks: [closed, plain("command")],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(
      name: "zamknięty i otwarty workflow", tasks: [closed, workflowTask("w", agents: [false])],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    // Subagent w postoju nie jest pracą ani dla wiersza listy, ani dla kafla.
    Case(
      name: "sam subagent w postoju", tasks: [waiting],
      keepsRowWorking: false, backgroundWork: false, openWorkflow: false),
    Case(
      name: "dwóch subagentów w postoju", tasks: [waiting, waitingToo],
      keepsRowWorking: false, backgroundWork: false, openWorkflow: false),
    Case(
      name: "subagent w postoju i subagent pracujący", tasks: [waiting, plain("agent")],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(
      name: "subagent w postoju i komenda", tasks: [waiting, plain("command")],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: false),
    Case(
      name: "subagent w postoju i monitor", tasks: [waiting, plain("monitor")],
      keepsRowWorking: false, backgroundWork: false, openWorkflow: false),
    Case(
      name: "subagent w postoju i otwarty workflow", tasks: [waiting, workflowTask("w", agents: [false])],
      keepsRowWorking: true, backgroundWork: true, openWorkflow: true),
    // Wiersz i kafel dalej rozchodzą się na zamkniętym przebiegu, także obok czekającego.
    Case(
      name: "subagent w postoju i zamknięty workflow", tasks: [waiting, closed],
      keepsRowWorking: true, backgroundWork: false, openWorkflow: false),
  ]

  /// Lista zadań tak, jak dochodzi z drutu: przez dekoder kontraktu, w podsumowaniu sesji.
  static func decode(_ tasks: [String]?) throws -> [BackgroundTask]? {
    let extra = tasks.map { #","backgroundTasks":[\#($0.joined(separator: ","))]"# } ?? ""
    return try #require(LiveActivityInputTests.sessions([Frames.summary("s", state: "done", extra: extra)]).first)
      .backgroundTasks
  }

  @Test("każdy kształt listy: wiersz listy, licznik „pracuje” kafla, zegar ciszy kafla", arguments: cases)
  func table(_ sample: Case) throws {
    let tasks = try Self.decode(sample.tasks)
    #expect((tasks == nil) == (sample.tasks == nil), "brak pola zostaje brakiem pola")
    #expect(BackgroundTaskRules.tasksKeepRowWorking(tasks) == sample.keepsRowWorking, "wiersz listy")
    #expect(BackgroundTaskRules.hasBackgroundWork(tasks) == sample.backgroundWork, "licznik „pracuje” kafla")
    #expect(BackgroundTaskRules.hasOpenWorkflow(tasks) == sample.openWorkflow, "zegar ciszy kafla")
    // Linia workflow wiersza listy: ta sama otwartość, przebiegi wypisane w kolejności listy.
    #expect(!BackgroundTaskRules.openWorkflows(tasks).isEmpty == sample.openWorkflow, "linia workflow wiersza")
  }

  @Test("otwarte przebiegi wypisane w kolejności listy, bez zamkniętych i bez innych rodzajów")
  func openWorkflowsList() throws {
    let tasks = try Self.decode([
      Self.closed, Self.plain("command"), workflowTask("w-flying", agents: [true, false]),
      workflowTask("w-start", run: false), Self.waiting,
    ])
    #expect(BackgroundTaskRules.openWorkflows(tasks).map(\.id) == ["w-flying", "w-start"])
    #expect(BackgroundTaskRules.openWorkflows(nil).isEmpty && BackgroundTaskRules.openWorkflows([]).isEmpty)
  }

  /// Jedyne kształty z tabeli, przy których lista to sami czekający. Wypisane, nie wyliczone z innej
  /// reguły: inaczej test powtarzałby definicję zamiast ją sprawdzać.
  static let onlyWaiting: Set<String> = ["sam subagent w postoju", "dwóch subagentów w postoju"]
  /// Kształty z tabeli, przy których lista jest niepusta, a nic na niej nie pracuje, choć nie są to sami
  /// czekający subagenci: stoi na niej monitor. Też wypisane, nie wyliczone.
  static let watchingOnly: Set<String> = ["monitor", "subagent w postoju i monitor"]

  @Test("pigułka liczy każde zadanie (`hasTasks`), a „sami czekający” to lista bez niczego, co pracuje", arguments: cases)
  func listed(_ sample: Case) throws {
    let tasks = try Self.decode(sample.tasks)
    let any = !(sample.tasks ?? []).isEmpty
    #expect(BackgroundTaskRules.hasTasks(tasks) == any, "pigułka i sekcja „w tle”")
    #expect(BackgroundTaskRules.onlyWaitingAgents(tasks) == Self.onlyWaiting.contains(sample.name), "zdanie linii etapu")
    // Lista niepusta bez znaku pracy to sami czekający subagenci albo lista z monitorem, przy którym nic
    // nie pracuje. Sami czekający zawsze są listą bez znaku pracy.
    #expect(
      (Self.onlyWaiting.contains(sample.name) || Self.watchingOnly.contains(sample.name))
        == (BackgroundTaskRules.hasTasks(tasks) && !BackgroundTaskRules.tasksKeepRowWorking(tasks)))
    #expect(!BackgroundTaskRules.onlyWaitingAgents(tasks) || !BackgroundTaskRules.tasksKeepRowWorking(tasks))
  }

  @Test("jedno zadanie: czeka tylko subagent z `waitingSince`, pracuje tylko subagent bez niego")
  func singleTask() throws {
    let odd = #"{"id":"c","kind":"command","waitingSince":"2026-10-10T06:00:00.000Z"}"#
    let list = try #require(
      try Self.decode([Self.waiting, Self.plain("agent"), Self.plain("command"), odd, Self.plain("cron")]))
    #expect(list.map(BackgroundTaskRules.waitingAgent) == [true, false, false, false, false])
    #expect(list.map(BackgroundTaskRules.workingAgent) == [false, true, false, false, false])
  }

  @Test("`waitingSince` przy zadaniu innego rodzaju niczego nie zmienia: czeka tylko subagent")
  func waitingSinceOnlyForAgents() throws {
    // Kontrakt nadaje pole wyłącznie agentom. Przy komendzie nic nie znaczy, więc komenda zostaje pracą:
    // pomyłka w tę stronę zostawia ton pracy, a w drugą zgasiłaby wiersz przy pracującej komendzie.
    let odd = #"{"id":"c","kind":"command","waitingSince":"2026-10-10T06:00:00.000Z"}"#
    let tasks = try Self.decode([odd])
    #expect(tasks?.first?.waitingSince != nil, "pole przeszło przez dekoder")
    #expect(BackgroundTaskRules.tasksKeepRowWorking(tasks))
    #expect(BackgroundTaskRules.hasBackgroundWork(tasks))
  }

  @Test("pusta lista znaczy to samo co brak pola")
  func emptyList() {
    #expect(!BackgroundTaskRules.tasksKeepRowWorking([]))
    #expect(!BackgroundTaskRules.hasBackgroundWork([]))
    #expect(!BackgroundTaskRules.hasOpenWorkflow([]))
    #expect(!BackgroundTaskRules.hasTasks([]))
    // Pusta lista to nie „sami czekający": nie ma kto czekać.
    #expect(!BackgroundTaskRules.onlyWaitingAgents([]) && !BackgroundTaskRules.onlyWaitingAgents(nil))
  }

  @Test("reguły są uporządkowane: otwarty workflow ⇒ praca kafla ⇒ wiersz listy przy pracy; odwrotnie nie")
  func ordering() throws {
    var differs = (rowOnly: false, workOnly: false)
    for sample in Self.cases {
      let tasks = try Self.decode(sample.tasks)
      let row = BackgroundTaskRules.tasksKeepRowWorking(tasks)
      let work = BackgroundTaskRules.hasBackgroundWork(tasks)
      let open = BackgroundTaskRules.hasOpenWorkflow(tasks)
      #expect(!open || work, "\(sample.name): otwarty workflow bez pracy kafla")
      #expect(!work || row, "\(sample.name): praca kafla bez wiersza przy pracy")
      if row && !work { differs.rowOnly = true }
      if work && !open { differs.workOnly = true }
    }
    #expect(differs.rowOnly && differs.workOnly, "tabela ma pokazywać obie różnice między regułami")
  }
}
