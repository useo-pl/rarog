import Foundation
import RarogContract
import RarogCore

// What the agent does now: the sentences of the list card's stage line and the live activity and
// delegation pieces the activity line under the transcript (`ActivityRowLine`) builds on. Owner: activity and list.
// Delegation (subagent, workflow) is recognized ONLY by the server's `delegation` field; tool names are only
// copy keys in `ToolActivity`.

/// Aktywność widoku: pola `Activity` z drutu plus to, co dokłada transkrypt (liczba subagentów
/// i nazwa przebiegu). Typy kontraktu nie mają publicznych inicjatorów, więc widok ma własną wartość.
public struct ViewActivity: Sendable, Equatable {
  public var kind: ActivityKind
  public var toolName: String?
  public var summary: String?
  /// The tool's own words about the call (`Activity.description`); the activity line shows it as the label.
  public var description: String?
  public var agents: Int?
  public var agentsDone: Int?
  public var workflow: String?
  public var phases: [ActivityPhase]?
  public var delegation: Delegation?

  public init(_ activity: Activity) {
    kind = activity.kind
    toolName = activity.toolName
    summary = activity.summary
    description = activity.description
    agents = activity.agents
    agentsDone = activity.agentsDone
    workflow = activity.workflow
    phases = activity.phases
    delegation = activity.delegation
  }

  init(kind: ActivityKind, delegation: Delegation? = nil) {
    self.kind = kind
    self.delegation = delegation
  }
}

/// An activity sentence in two pieces: the lead and the tail (phase and agent counts). The list card line
/// (``ActivityText/cardText(_:tasks:)``) joins them with a dot; the activity line takes a delegation's label and detail.
public struct ActivityLine: Sendable, Equatable {
  public var lead: String
  public var tail: String

  public init(lead: String, tail: String = "") {
    self.lead = lead
    self.tail = tail
  }
}

/// Segment paska workflow: jeden na fazę planu (bez planu jeden na całość).
public struct ProgressSegment: Sendable, Equatable {
  /// Ułamek 0–1 skończonych agentów fazy.
  public var fill: Double
  /// Faza w toku (ma agentów, którzy jeszcze nie skończyli) — 0/1 nie wygląda jak 0/0.
  public var active: Bool
}

/// Subagenci odpaleni przez OSTATNIĄ wiadomość agenta (wynik narzędzia nie trafia do transkryptu,
/// więc przez całą pracę subagentów ta wiadomość jest ostatnia).
struct SubagentRun: Sendable, Equatable {
  var count: Int
  var name: String?
  var since: Date?
}

public enum ActivityText {
  // MARK: Zdanie

  /// The activity sentence of the list card line and the line from turn memory; the row under the
  /// transcript draws the activity line (`ActivityRowLine`).
  public static func copy(_ activity: ViewActivity) -> ActivityLine {
    switch activity.kind {
    case .idle:
      return ActivityLine(lead: "")
    case .thinking:
      return ActivityLine(lead: UICopy.activityThinking)
    case .waiting:
      let summary = activity.summary ?? ""
      return ActivityLine(lead: summary.isEmpty ? UICopy.activityWaiting : summary)
    case .tool:
      if activity.delegation != nil { return delegationLine(activity) }
      let summary = activity.summary ?? ""
      let base = ToolActivity.verb(for: activity.toolName)
      return ActivityLine(lead: summary.isEmpty ? base : UICopy.toolLead(base, summary: PathText.shortenPaths(summary)))
    }
  }

  /// Forma linii delegacji: pojedynczy subagent (krótka forma) albo przebieg. `nil` = to nie delegacja.
  /// Linia karty listy i linia z pamięci tury pytają o formę tutaj, nie porównują zdania.
  enum DelegationForm: Equatable {
    case subagent
    case workflow
  }

  /// Pojedynczy subagent bez licznika skończonych, bez planu i bez dowodu przebiegu ma krótką formę.
  static func delegationForm(_ activity: ViewActivity) -> DelegationForm? {
    guard activity.kind == .tool, activity.delegation != nil else { return nil }
    let agents = activity.agents ?? 1
    let proven = activity.delegation == .workflow || activity.workflow != nil
    if agents < 2, activity.agentsDone == nil, phaseCopy(activity.phases).isEmpty, !proven { return .subagent }
    return .workflow
  }

  /// Subagent albo workflow: krótka forma pojedynczego subagenta (``delegationForm(_:)``); resztę
  /// opisuje nazwa, faza i liczniki agentów.
  static func delegationLine(_ activity: ViewActivity) -> ActivityLine {
    let agents = activity.agents ?? 1
    let done = activity.agentsDone
    let phase = phaseCopy(activity.phases)
    if delegationForm(activity) == .subagent {
      return ActivityLine(lead: UICopy.activitySubagent)
    }
    let name = activity.workflow ?? ""
    let lead = name.isEmpty ? UICopy.activityWorkflow : UICopy.workflowNamed(name)
    // Brak `agentsDone` znaczy „nie wiem", nie zero — wtedy bez „skończyło".
    let counts = [UICopy.agentsCount(agents)] + (done.map { [UICopy.agentsDone($0)] } ?? [])
    // Faza PRZED licznikami: to, co stoi ostatnie, ginie pierwsze przy wąskiej kolumnie.
    return ActivityLine(lead: lead, tail: UICopy.list((phase.isEmpty ? [] : [phase]) + counts, .dot))
  }

  /// Bieżąca faza planu: pierwsza w kolejności skryptu z agentem w locie; gdy wszyscy skończyli —
  /// ostatnia, w której ktoś ruszył. `nil` = żadna faza nie ma agentów. Wspólny kształt (`PhaseTally`):
  /// fazy z ulotnej aktywności (karta pracująca) i fazy policzone z rozkładu (karta z workflow w tle).
  static func currentPhase<Phase: PhaseTally>(_ phases: [Phase]) -> (index: Int, title: String)? {
    if let running = phases.firstIndex(where: { $0.agents > $0.done }) { return (running, phases[running].title) }
    if let last = phases.lastIndex(where: { $0.agents > 0 }) { return (last, phases[last].title) }
    return nil
  }

  /// Fazy z drutu (aktywność pracującej sesji). Przeciążenie bez parametru typu wygrywa przy `[]`.
  static func phaseCopy(_ phases: [ActivityPhase]?) -> String {
    phaseLine(phases)
  }

  /// Fazy policzone z rozkładu (`WorkflowRunModel.phaseCounts`) — ta sama reguła co karta pracująca.
  static func phaseCopy<Phase: PhaseTally>(_ phases: [Phase]?) -> String {
    phaseLine(phases)
  }

  /// „faza 2/5 Tytuł" albo „faza 2/5", gdy tytuł nie mieści się w linii karty (> 24 znaki).
  private static func phaseLine<Phase: PhaseTally>(_ phases: [Phase]?) -> String {
    guard let phases, !phases.isEmpty, let current = currentPhase(phases) else { return "" }
    let title = current.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return title.isEmpty || title.count > UICopy.phaseTitleMax
      ? UICopy.phaseHead(index: current.index + 1, total: phases.count)
      : UICopy.phaseHead(index: current.index + 1, total: phases.count, title: title)
  }

  // MARK: Pasek workflow

  /// Postęp przebiegu: z planu faz (średnia ułamków faz) albo z liczników agentów (dolne
  /// oszacowanie). `nil` = to nie workflow albo licznik nieznany — wtedy paska nie ma.
  static func workflowProgress(_ activity: ViewActivity) -> (done: Double, total: Double)? {
    guard activity.delegation != nil else { return nil }
    if let phases = activity.phases, !phases.isEmpty, phases.contains(where: { $0.agents > 0 }) {
      let done = phases.reduce(0.0) { sum, phase in
        sum + (phase.agents > 0 ? min(1, Double(phase.done) / Double(phase.agents)) : 0)
      }
      return (done, Double(phases.count))
    }
    guard let done = activity.agentsDone else { return nil }
    let total = done + (activity.agents ?? 0)
    guard total > 0 else { return nil }
    return (Double(done), Double(total))
  }

  /// Segmenty paska: faza bez agentów to pusty segment na swoim miejscu, nie niższa średnia.
  public static func workflowSegments(_ activity: ViewActivity) -> [ProgressSegment]? {
    guard let progress = workflowProgress(activity) else { return nil }
    if let phases = activity.phases, !phases.isEmpty, phases.contains(where: { $0.agents > 0 }) {
      return phases.map { phase in
        ProgressSegment(
          fill: phase.agents > 0 ? min(1, Double(phase.done) / Double(phase.agents)) : 0,
          active: phase.agents > phase.done)
      }
    }
    return [ProgressSegment(fill: min(1, progress.done / progress.total), active: true)]
  }

  // MARK: Linia etapu na karcie listy

  /// Linia etapu karty pracującej: zdanie wiersza aktywności BEZ licznika (tyka w sesji). Pod
  /// linią z paskiem słowo „workflow:" znika — pasek mówi to samo.
  public static func cardText(_ activity: ViewActivity, tasks: [BackgroundTask] = []) -> String {
    let line = copy(activity)
    guard !line.lead.isEmpty else { return "" }
    let form = delegationForm(activity)
    if form == .subagent {
      // Opis pojedynczego subagenta: z aktywności, a gdy puls go zgubił — z żywego zadania w tle.
      let description = activity.summary.flatMap { $0.isEmpty ? nil : $0 } ?? liveAgentDescription(tasks)
      if !description.isEmpty {
        return UICopy.list([UICopy.subagentLead(description), line.tail].filter { !$0.isEmpty }, .dot)
      }
    }
    // Pod linią z paskiem słowo „workflow" znika: zostaje sama nazwa przebiegu (bez nazwy — nic).
    let lead = workflowProgress(activity) != nil && form == .workflow ? (activity.workflow ?? "") : line.lead
    return UICopy.list([lead, line.tail].filter { !$0.isEmpty }, .dot)
  }

  /// Linia karty, która NIE pracuje, ale ma coś w tle: rodzaj i opis jednego zadania albo
  /// sama liczba („3 w tle") — opis pierwszego z brzegu kłamałby przez przemilczenie. Workflow
  /// z rozkładem mówi też fazę planu („w tle: workflow · faza 2/3 Review · nazwa"), liczoną tą samą
  /// regułą co karta pracująca; faza stoi PRZED nazwą, bo to, co stoi ostatnie, ginie pierwsze.
  /// Paska postępu tu nie ma: workflow W TOKU wiersz bierze z ``workflowStage(_:)`` (z paskiem), a tu
  /// zostaje przebieg zamknięty i workflow bez rozkładu.
  ///
  /// Gdy na liście stoją SAMI subagenci w postoju, nic tam nie pracuje i linia tego nie udaje:
  /// „czeka: subagent · opis", a przy kilku „czeka: 2 subagenty". Obok czegokolwiek, co pracuje, linia
  /// liczy wszystkie zadania („2 w tle"). Czy lista to sami czekający, mówi reguła rdzenia.
  public static func backgroundText(_ tasks: [BackgroundTask]) -> String {
    guard let first = tasks.first else { return "" }
    if BackgroundTaskRules.onlyWaitingAgents(tasks) {
      if tasks.count > 1 { return UICopy.waitingLead(UICopy.subagentsCount(tasks.count)) }
      let lead = UICopy.waitingLead(UICopy.backgroundKind(first.kind))
      return UICopy.list([lead, taskText(first)].filter { !$0.isEmpty }, .dot)
    }
    if tasks.count > 1 { return UICopy.backgroundBadge(tasks.count) }
    let lead = UICopy.backgroundLead(UICopy.backgroundKind(first.kind))
    let phase = first.kind == .workflow ? phaseCopy(first.run.flatMap(WorkflowRunModel.phaseCounts)) : ""
    return UICopy.list([lead, phase, taskText(first)].filter { !$0.isEmpty }, .dot)
  }

  /// Który z OTWARTYCH przebiegów workflow (``BackgroundTaskRules/openWorkflows(_:)``) stoi w linii wiersza:
  /// pierwszy z fazą w toku (agent w locie), inaczej pierwszy z listy. `nil` = lista pusta.
  static func liveWorkflow(_ open: [BackgroundTask]) -> BackgroundTask? {
    open.first { task in
      task.run.flatMap(WorkflowRunModel.phaseCounts)?.contains { $0.agents > $0.done } ?? false
    } ?? open.first
  }

  /// Linia workflow w toku pod kartą listy: faza PRZED nazwą (linia ucina się od końca)
  /// i pasek z rozkładu, ta sama reguła co karta pracująca. Pasek mówi „workflow”, więc słowa
  /// „w tle: workflow” nad nim nie ma, jak w ``cardText(_:tasks:)``. Bez faz (rozkład nieodczytany albo
  /// przebieg bez tagów) paska nie ma i zostaje zdanie o jednym zadaniu z ``backgroundText(_:)``.
  static func workflowStage(_ task: BackgroundTask) -> (text: String, segments: [ProgressSegment]?) {
    guard let phases = task.run.flatMap(WorkflowRunModel.phaseCounts) else { return (backgroundText([task]), nil) }
    let segments = phases.map { phase in
      ProgressSegment(
        fill: phase.agents > 0 ? min(1, Double(phase.done) / Double(phase.agents)) : 0,
        active: phase.agents > phase.done)
    }
    return (UICopy.list([phaseCopy(phases), taskText(task)].filter { !$0.isEmpty }, .dot), segments)
  }

  static func taskText(_ task: BackgroundTask) -> String {
    if let description = task.description, !description.isEmpty { return description }
    return task.command ?? ""
  }

  /// Opis subagenta, który PRACUJE (reguła rdzenia): aktywność mówi „subagent pracuje", więc opis
  /// agenta w postoju byłby opisem kogoś innego.
  private static func liveAgentDescription(_ tasks: [BackgroundTask]) -> String {
    for task in tasks where BackgroundTaskRules.workingAgent(task) {
      let text = taskText(task)
      if !text.isEmpty { return text }
    }
    return ""
  }

  // MARK: Źródła wiersza w sesji

  static func subagentRun(_ view: TranscriptState) -> SubagentRun? {
    guard let last = view.messages.last, last.role == .assistant else { return nil }
    var count = 0
    var name: String?
    for case let .toolCall(call) in last.blocks where call.delegation != nil {
      count += 1
      // Samo `summary` równe nazwie narzędzia to nie nazwa przebiegu („workflow: <narzędzie>").
      if name == nil, !call.summary.isEmpty, call.summary != call.toolName { name = call.summary }
    }
    guard count > 0 else { return nil }
    return SubagentRun(count: count, name: name, since: ServerTime.parse(last.at))
  }

  /// Co wiersz pokazuje TERAZ i od kiedy liczy licznik. Trzy źródła: ulotna aktywność od serwera
  /// (jej `elapsedSeconds` cofa bazę), subagenci z transkryptu i sam transkrypt pracującej sesji
  /// („pracuje" od ostatniej wiadomości — bez tego wiersz gasł w najdłuższej ciszy tury).
  static func live(view: TranscriptState, state: SessionState?, now: Date) -> (activity: ViewActivity, since: Date)? {
    if let activity = view.activity {
      let base = view.activityAt ?? now
      let since = base.addingTimeInterval(-Double(activity.elapsedSeconds ?? 0))
      var viewActivity = ViewActivity(activity)
      if activity.kind == .tool, activity.delegation != nil, let run = subagentRun(view) {
        // Serwer ma pierwszeństwo: transkrypt tylko uzupełnia brakujące pola.
        if viewActivity.agents == nil { viewActivity.agents = run.count }
        if viewActivity.workflow == nil, let name = run.name { viewActivity.workflow = name }
      }
      return (viewActivity, since)
    }
    guard state == .running || state == .starting else { return nil }
    // Płynąca odpowiedź ma własny kursor — dwa sygnały „coś się dzieje" naraz to szum.
    guard view.open == nil else { return nil }
    if let run = subagentRun(view) {
      var activity = ViewActivity(kind: .tool, delegation: .agents)
      activity.agents = run.count
      activity.workflow = run.name
      return (activity, run.since ?? now)
    }
    // `starting` zostaje przy zdaniu na środku („Uruchamiam agenta…").
    guard state == .running else { return nil }
    let since = view.messages.last.flatMap { ServerTime.parse($0.at) } ?? now
    return (ViewActivity(kind: .thinking), since)
  }
}
