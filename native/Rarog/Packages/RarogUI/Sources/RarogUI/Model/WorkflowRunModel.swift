import Foundation
import RarogContract
import RarogCore

// Przebieg workflow w panelu „w tle" i faza w linii karty. Reguły zachowania
// — `phaseCounts` (`shared/src/workflow-phases.ts`), `workflowUntagged`, `workflowRows`, `workflowTally`,
// `workflowSpoken`, `workflowPhaseState`, `workflowOpenPhase`, `workflowRailTally` — jako czyste funkcje,
// testowane na macOS. Kropek agentów pod fazą (`workflowStopDots`) apka nie ma: natywnie fazy stoją
// pionową listą, a agenci bieżącej fazy są wymienieni pod nią. Dane są
// wyłącznie z `BackgroundTask.run`:
// modelu agenta, „padł czy skończył", czasu końca ani „ile zostało" serwer nie daje, więc apka ich nie
// obiecuje. Właściciel: nagłówek (panel „w tle").

/// Faza z licznikami — wspólny kształt `ActivityPhase` z drutu i faz policzonych z rozkładu
/// (``WorkflowRunModel/phaseCounts(_:)``): linia karty pracującej i karty z workflow w tle liczy ta sama
/// reguła (`ActivityText.phaseCopy`).
public protocol PhaseTally {
  var title: String { get }
  var agents: Int { get }
  var done: Int { get }
}

extension ActivityPhase: PhaseTally {}

/// Faza planu z licznikami policzona po stronie apki. Typy kontraktu nie mają publicznych inicjatorów
/// (dekoder jest jedyną drogą), więc model prezentacji ma własną wartość.
public struct PhaseCount: PhaseTally, Sendable, Equatable {
  public let title: String
  public internal(set) var agents: Int
  public internal(set) var done: Int
}

/// Jeden agent rozkładu z nazwą, którą da się pokazać.
public struct WorkflowAgentRow: Sendable, Equatable, Identifiable {
  public let id: String
  /// Etykieta z tagu `[faza · etykieta]` albo `#n` (numer startu w CAŁYM przebiegu), gdy skrypt tagu nie daje.
  public let name: String
  public let done: Bool
  public let startedAt: String?

  public init(id: String, name: String, done: Bool, startedAt: String? = nil) {
    self.id = id
    self.name = name
    self.done = done
    self.startedAt = startedAt
  }
}

/// Faza rozkładu: tytuł ze skryptu albo z tagu i jej agenci w kolejności startu.
public struct WorkflowPhaseRow: Sendable, Equatable {
  /// Pusty tytuł = agenci bez fazy (skrypt bez tagów albo `[· label]`).
  public let title: String
  public var agents: [WorkflowAgentRow]
  /// Grupa agentów bez fazy — zawsze ostatnia i tylko niepusta.
  public let loose: Bool

  public init(title: String, agents: [WorkflowAgentRow], loose: Bool = false) {
    self.title = title
    self.agents = agents
    self.loose = loose
  }
}

/// Stan fazy liczony z agentów przy KAŻDYM odświeżeniu, bez pamięci.
public enum WorkflowPhaseState: Sendable, Equatable {
  /// Ma agentów i wszyscy skończyli — `✓`.
  case done
  /// Ktoś w niej pracuje — `●`.
  case running
  /// Nikt nie ruszył — `○`. Pusta faza nigdy nie jest `done` („wszyscy z zera skończyli" to kłamstwo).
  case pending
}

public enum WorkflowRunModel {
  /// Fazy planu z licznikami (ilu ruszyło, ilu skończyło), w kolejności skryptu, także bez agentów.
  /// Bez planu (przebieg z `scriptPath`) fazy idą z tagów w kolejności pierwszego agenta. Przy znanym
  /// planie agent z fazą spoza listy jest pomijany (do ułamka nie wchodzi, nie wiadomo, gdzie stoi).
  /// `nil` = żaden agent nie ma fazy z planu ani z tagów — wtedy faz nie znamy. Fazą jest TYTUŁ: dwie
  /// fazy o tym samym tytule to jeden koszyk (jak `phaseCounts` serwera, którym liczy się karta).
  public static func phaseCounts(_ run: WorkflowRun) -> [PhaseCount]? {
    let planned = !run.phases.isEmpty
    var counts = run.phases.map { PhaseCount(title: $0, agents: 0, done: 0) }
    // Jak `new Map(…)` w PWA: przy powtórzonym tytule wygrywa ostatni indeks.
    var at: [String: Int] = [:]
    for (index, title) in run.phases.enumerated() { at[title] = index }
    var tagged = 0
    for agent in run.agents {
      if let phase = agent.phase, !planned, at[phase] == nil {
        at[phase] = counts.count
        counts.append(PhaseCount(title: phase, agents: 0, done: 0))
      }
      guard let phase = agent.phase, let index = at[phase] else { continue }
      tagged += 1
      counts[index].agents += 1
      if agent.done { counts[index].done += 1 }
    }
    return tagged == 0 ? nil : counts
  }

  /// Przebieg BEZ TAGÓW: są agenci, a żaden nie ma fazy (skrypt bez tagów `[faza · etykieta]`). Rozkład po fazach
  /// byłby wtedy kłamstwem — `○` przy fazie dawno minionej — więc plan idzie
  /// jedną linią bez stanu, a agenci pod nią.
  public static func untagged(_ run: WorkflowRun) -> Bool {
    !run.agents.isEmpty && run.agents.allSatisfy { $0.phase == nil }
  }

  /// Rozkład do narysowania: fazy w kolejności SKRYPTU (człowiek czyta plan od góry), fazy z tagów spoza
  /// planu na końcu, agenci bez fazy w ostatniej grupie z pustym tytułem (tylko gdy niepusta). Fazy bez
  /// agentów zostają. Numer `#n` liczy start w całym przebiegu, nie w fazie.
  public static func rows(_ run: WorkflowRun) -> [WorkflowPhaseRow] {
    var order: [String] = []
    var byTitle: [String: WorkflowPhaseRow] = [:]
    // Jak `Map.set` w PWA: powtórzony tytuł zostaje na pierwszym miejscu.
    for title in run.phases {
      if byTitle[title] == nil { order.append(title) }
      byTitle[title] = WorkflowPhaseRow(title: title, agents: [])
    }
    var loose: [WorkflowAgentRow] = []
    for (index, agent) in run.agents.enumerated() {
      let row = WorkflowAgentRow(id: agent.id, name: agent.label ?? "#\(index + 1)", done: agent.done, startedAt: agent.startedAt)
      let phase = agent.phase ?? ""
      if phase.isEmpty {
        loose.append(row)
      } else if byTitle[phase] != nil {
        byTitle[phase]?.agents.append(row)
      } else {
        order.append(phase)
        byTitle[phase] = WorkflowPhaseRow(title: phase, agents: [row])
      }
    }
    var out = order.compactMap { byTitle[$0] }
    if !loose.isEmpty { out.append(WorkflowPhaseRow(title: "", agents: loose, loose: true)) }
    return out
  }

  public static func phaseState(_ row: WorkflowPhaseRow) -> WorkflowPhaseState {
    if row.agents.isEmpty { return .pending }
    return row.agents.contains { !$0.done } ? .running : .done
  }

  /// Faza bieżąca (indeks w ``rows(_:)``): pierwsza w kolejności skryptu z żywym agentem, a gdy nikt nie
  /// pracuje — OSTATNIA, w której ktoś ruszył. `nil` = nikt jeszcze nie ruszył. Ta sama reguła co
  /// `ActivityText.currentPhase` na karcie, ale na wierszach rozkładu: panel odpowiada „co teraz pracuje"
  /// (także faza spoza planu), karta — „gdzie w planie jesteśmy". Rozbieżność jest świadoma.
  public static func openPhase(_ rows: [WorkflowPhaseRow]) -> Int? {
    if let running = rows.firstIndex(where: { phaseState($0) == .running }) { return running }
    return rows.lastIndex { !$0.agents.isEmpty }
  }

  /// Fazy skończone i wszystkie fazy planu (mianownik z ``phaseCounts(_:)``, ten sam co pasek karty).
  static func railCounts(_ run: WorkflowRun) -> (done: Int, total: Int)? {
    guard let phases = phaseCounts(run) else { return nil }
    let done = phases.filter { $0.agents > 0 && $0.done >= $0.agents }.count
    return (done, phases.count)
  }

  /// „1/3" — fazy skończone / wszystkie fazy planu; pusty = nie ma czego liczyć („0/0" nie jest informacją).
  public static func railTally(_ run: WorkflowRun) -> String {
    railCounts(run).map { "\($0.done)/\($0.total)" } ?? ""
  }

  /// „16 skończyło · 1 pracuje" — bez „zostało", bo tego nikt nie wie.
  public static func tally(_ run: WorkflowRun) -> String {
    UICopy.list(tallyParts(run), .dot)
  }

  /// Człony ``tally(_:)`` osobno (ekran łączy je kropką, czytnik przecinkiem — `UICopy.workflowSummarySpoken`).
  public static func tallyParts(_ run: WorkflowRun) -> [String] {
    let done = run.agents.filter(\.done).count
    let running = run.agents.count - done
    var parts: [String] = []
    if done > 0 { parts.append(UICopy.agentsDone(done)) }
    if running > 0 { parts.append(UICopy.workflowRunning(running)) }
    return parts
  }

  /// To samo zdaniem dla czytnika, faza po fazie: „Faza B: impl:auth skończył, verify:auth pracuje".
  public static func spoken(_ run: WorkflowRun) -> String {
    func agents(_ list: [WorkflowAgentRow]) -> [String] {
      list.map { UICopy.workflowAgentHead(name: $0.name, done: $0.done) }
    }
    let phaseRows = Self.rows(run)
    if untagged(run) {
      return UICopy.workflowUntaggedSpoken(phases: run.phases, agents: agents(phaseRows.flatMap(\.agents)))
    }
    let phases = phaseRows
      .filter { !$0.agents.isEmpty }
      .map { UICopy.workflowPhaseAgentsSpoken(title: $0.title.isEmpty ? UICopy.workflowNoPhase : $0.title, agents: agents($0.agents)) }
    return UICopy.list(phases, .semicolon)
  }

  /// Panel bez kontaktu ze źródłem: ta sama reguła co zamrożony wiersz listy (sesja `stale`,
  /// lista z pamięci podręcznej), plus zerwany strumień listy — rozkład przestał wtedy przychodzić.
  /// `link` to pamięć strumienia listy prowadzona przez widok: pętla przeplata `offline` i `connecting`
  /// przy każdej próbie, więc reguła po samym bieżącym stanie odmrażałaby panel co próbę.
  /// Ta sama reguła co wiersz aktywności: przerwa liczy się od pierwszej porażki, a pierwsza próba —
  /// po sekundzie.
  public static func frozen(sessionStale: Bool, listStale: Bool, link: ConnectionMemory, now: Date) -> Bool {
    sessionStale || listStale || streamDownSince(link, now: now) != nil
  }

  /// Od kiedy strumień listy nie żyje — początek CAŁEJ przerwy; `nil` = żyje. Zegary panelu stają tu.
  public static func streamDownSince(_ link: ConnectionMemory, now: Date) -> Date? {
    ActivityRowLine.downSince(link, now: now)
  }
}

/// Zamrożenie zegarów sekcji „w tle" jako wartość: pamięć strumienia listy, reguła „bez kontaktu ze
/// źródłem" w danej chwili i chwila, od której zegary stoją. Trzyma ją właściciel sekcji POZA leniwym stosem
/// (popover: `BackgroundClock`, prawy panel: `InspectorPanel`), a nagłówek i wiersze tylko czytają: stan w nagłówku
/// leniwego stosu przestawał się aktualizować, gdy nagłówek wypadał z ekranu, i wiersze tykały dalej mimo utraty
/// strumienia.
public struct BackgroundFreeze: Sendable, Equatable {
  /// Pamięć strumienia listy: początek CAŁEJ przerwy, nie bieżącej próby (pętla przeplata offline i connecting) —
  /// inaczej sekcja odmrażałaby się przy każdej próbie.
  public private(set) var link = ConnectionMemory()
  /// Od kiedy zegary stoją; `nil` = tykają.
  public private(set) var frozenAt: Date?

  public init() {}

  public mutating func observe(_ status: ConnectionStatus, now: Date) {
    link.observe(status, now: now)
  }

  /// Sekcja bez kontaktu ze źródłem w chwili `now`: sesja `stale`, lista z pamięci albo strumień listy w przerwie.
  public func isFrozen(sessionStale: Bool, listStale: Bool, now: Date) -> Bool {
    WorkflowRunModel.frozen(sessionStale: sessionStale, listStale: listStale, link: link, now: now)
  }

  /// Zmiana zamrożenia: przerwa strumienia liczy się od jej początku; sesja albo lista bez kontaktu — od chwili,
  /// w której to widać. Odmrożenie wznawia tykanie.
  public mutating func settle(frozen: Bool, now: Date) {
    let down = WorkflowRunModel.streamDownSince(link, now: now)
    frozenAt = frozen ? min(now, down ?? now) : nil
  }

  /// Chwila zegarów: zamrożona sekcja liczy od chwili utraty kontaktu — tykanie obiecywałoby żywą liczbę.
  public func clock(frozen: Bool, now: Date) -> Date {
    frozen ? (frozenAt ?? now) : now
  }
}

// MARK: - Sekcja panelu

/// Rozwinięte fazy panelu: ręcznie otwarte ∪ bieżąca ∪ fazy widziane jako bieżące − ręcznie zwinięte.
/// Odświeżenie (nowy rozkład co 5 s) niczego nie zwija: faza, która była bieżąca na oczach człowieka,
/// zostaje rozwinięta, gdy bieżąca przejdzie dalej — układ nie zmienia się pod palcem.
/// Klucz to zadanie + tytuł fazy, więc dwa przebiegi o tych samych fazach są niezależne.
public struct WorkflowExpansion: Sendable, Equatable {
  public struct Key: Sendable, Hashable {
    public let task: String
    /// Tytuł fazy; `nil` = grupa agentów bez fazy (żaden tytuł z dziennika jej nie podrobi).
    public let phase: String?

    public init(task: String, phase: String?) {
      self.task = task
      self.phase = phase
    }
  }

  private var opened: Set<Key> = []
  private var seen: Set<Key> = []
  private var closed: Set<Key> = []
  /// Fazy z rozwiniętą listą skończonych — wyłącznie ręką, nic jej nie rozwija ani nie zwija samo.
  private var doneOpened: Set<Key> = []

  public init() {}

  public func isExpanded(_ key: Key, current: Bool) -> Bool {
    !closed.contains(key) && (current || opened.contains(key) || seen.contains(key))
  }

  /// Gest na wierszu fazy. Zwinięcie bieżącej zostaje zapamiętane (kolejne ramki jej nie rozwiną);
  /// zwinięcie innej wraca do stanu domyślnego (rozwinie się sama, gdy stanie się bieżąca).
  public mutating func toggle(_ key: Key, current: Bool) {
    if isExpanded(key, current: current) {
      opened.remove(key)
      seen.remove(key)
      if current { closed.insert(key) }
    } else {
      closed.remove(key)
      opened.insert(key)
    }
  }

  /// Fazy bieżące pokazane człowiekowi — zostają rozwinięte, gdy przestaną być bieżące.
  public mutating func noteCurrent(_ keys: Set<Key>) {
    seen.formUnion(keys)
  }

  /// Lista skończonych pod fazą: domyślnie zwinięta, niezależna od rozwinięcia samej fazy.
  public func isDoneExpanded(_ key: Key) -> Bool {
    doneOpened.contains(key)
  }

  public mutating func toggleDone(_ key: Key) {
    if doneOpened.remove(key) == nil { doneOpened.insert(key) }
  }
}

/// Podsumowanie przebiegu: linia na ekranie i jedno zdanie dla czytnika (osobny element).
public struct WorkflowSummary: Sendable, Equatable {
  /// „1/3 faz · 16 skończyło · 1 pracuje".
  public let text: String
  public let spoken: String
}

/// Agent pod rozwiniętą fazą.
public struct WorkflowAgentItem: Sendable, Equatable {
  public let id: String
  public let name: String
  public let done: Bool
  /// Start żywego agenta; skończony i agent bez czytelnego startu czasu nie mają.
  public let since: Date?

  /// ✓ skończony, ● żywy — symbol SF jak znak fazy.
  public var symbol: String { done ? "checkmark" : "circle.fill" }
}

/// Wiersz „✓ N skończyło" pod żywymi agentami fazy; rozwija listę skończonych (tylko ręką).
public struct WorkflowDoneGroup: Sendable, Equatable {
  public let key: WorkflowExpansion.Key
  /// Tytuł fazy do identyfikatora i zdania („bez fazy", „agenci" w przebiegu bez tagów).
  public let title: String
  public let count: Int
  /// „Review: 44 skończyło" — czytnik słyszy, czyja to lista.
  public let spoken: String
}

/// Wiersz fazy w pionowej liście: glif, tytuł, skończeni/ruszyli.
public struct WorkflowPhaseItem: Sendable, Equatable {
  public let key: WorkflowExpansion.Key
  /// Tytuł do pokazania („bez fazy" dla grupy agentów bez fazy).
  public let title: String
  public let state: WorkflowPhaseState
  /// „1/3" (skończeni / ruszyli); `nil` przy fazie, która nie ruszyła.
  public let count: String?
  /// „poza planem" przy fazie z tagu, której skrypt nie wymienia.
  public let note: String?
  /// Faza spoza planu i grupa bez fazy: przygaszone, na końcu listy.
  public let secondary: Bool
  public let isCurrent: Bool
  public let agents: [WorkflowAgentItem]
  public let spoken: String

  /// Pusta faza nie ma czego rozwinąć — nie jest przyciskiem.
  public var expandable: Bool { !agents.isEmpty }

  /// Znak stanu (✓ / ● / ○) jako symbol SF, nie znak pisma: cienki pierścień „○" w piśmie audyt dostępności
  /// mierzy jak tekst, a jego antyaliasing nad szkłem popovera daje 1,75:1.
  public var symbol: String {
    switch state {
    case .done: "checkmark"
    case .running: "circle.fill"
    case .pending: "circle"
    }
  }
}

/// Jedna linia sekcji. Płaska lista ze stałymi tożsamościami: kotwica przewinięcia trzyma się wiersza,
/// a dopisany agent nie zmienia tożsamości sąsiadów.
public enum WorkflowLine: Sendable, Equatable, Identifiable {
  case summary(task: String, WorkflowSummary)
  /// Przebieg bez tagów: plan jedną linią, bez glifów i licznika.
  case plan(task: String, String)
  /// Przebieg bez tagów: etykieta „agenci" nad listą agentów.
  case agentsLabel(task: String)
  case phase(WorkflowPhaseItem, expanded: Bool)
  case agent(task: String, WorkflowAgentItem)
  /// „✓ N skończyło" pod żywymi agentami fazy.
  case doneGroup(WorkflowDoneGroup, expanded: Bool)

  public var id: String {
    switch self {
    case let .summary(task, _): "wf:\(task):summary"
    case let .plan(task, _): "wf:\(task):plan"
    case let .agentsLabel(task): "wf:\(task):agents"
    case let .phase(item, _): item.key.phase.map { "wf:\(item.key.task):phase:\($0)" } ?? "wf:\(item.key.task):loose"
    case let .agent(task, item): "wf:\(task):agent:\(item.id)"
    case let .doneGroup(group, _):
      group.key.phase.map { "wf:\(group.key.task):done:\($0)" } ?? "wf:\(group.key.task):done-loose"
    }
  }
}

/// Sekcja przebiegu pod wierszem zadania `workflow`.
public struct WorkflowSection: Sendable, Equatable {
  public let taskId: String
  public let untagged: Bool
  public let summary: WorkflowSummary?
  /// „fazy: A · B · C" — tylko przebieg bez tagów z planem.
  public let plan: String?
  /// Fazy przebiegu z tagami; bez tagów jedna grupa agentów.
  public let phases: [WorkflowPhaseItem]
  /// Indeks fazy bieżącej w ``phases``; bez tagów `nil` (stanu faz nie znamy).
  public let current: Int?

  public init(taskId: String, run: WorkflowRun) {
    self.taskId = taskId
    let rows = WorkflowRunModel.rows(run)
    let untagged = WorkflowRunModel.untagged(run)
    self.untagged = untagged
    let current = untagged ? nil : WorkflowRunModel.openPhase(rows)
    self.current = current
    let tally = WorkflowRunModel.tallyParts(run)
    let rail = WorkflowRunModel.railCounts(run)
    let sentence = WorkflowRunModel.spoken(run)
    summary = tally.isEmpty && rail == nil
      ? nil
      : WorkflowSummary(
        text: UICopy.workflowSummary(rail: rail, tally: tally),
        spoken: UICopy.workflowSummarySpoken(rail: rail, tally: tally, sentence: sentence))
    plan = untagged && !run.phases.isEmpty ? UICopy.workflowPlanLine(run.phases) : nil
    let planned = Set(run.phases)
    phases = rows.enumerated().map { index, row in
      let state = WorkflowRunModel.phaseState(row)
      let offPlan = !row.loose && !run.phases.isEmpty && !planned.contains(row.title)
      let title = row.loose ? UICopy.workflowNoPhase : row.title
      let done = row.agents.filter(\.done).count
      return WorkflowPhaseItem(
        key: WorkflowExpansion.Key(task: taskId, phase: row.loose ? nil : row.title),
        title: title,
        state: state,
        count: row.agents.isEmpty ? nil : "\(done)/\(row.agents.count)",
        note: offPlan ? UICopy.workflowOffPlan : nil,
        secondary: offPlan || row.loose,
        isCurrent: index == current,
        agents: row.agents.map { agent in
          WorkflowAgentItem(
            id: agent.id, name: agent.name, done: agent.done,
            since: agent.done ? nil : agent.startedAt.flatMap(ServerTime.parse))
        },
        spoken: UICopy.workflowPhaseSpoken(
          title: title, offPlan: offPlan, state: state, done: done, agents: row.agents.count))
    }
  }

  /// Klucze faz bieżących (do ``WorkflowExpansion/noteCurrent(_:)``).
  public var currentKey: WorkflowExpansion.Key? {
    current.map { phases[$0].key }
  }

  /// Linie sekcji przy danym rozwinięciu. Bez tagów agenci stoją zawsze (fazy nie ma czego zwijać).
  public func lines(_ expansion: WorkflowExpansion) -> [WorkflowLine] {
    var out: [WorkflowLine] = []
    if let summary { out.append(.summary(task: taskId, summary)) }
    if untagged {
      if let plan { out.append(.plan(task: taskId, plan)) }
      out.append(.agentsLabel(task: taskId))
      let loose = WorkflowExpansion.Key(task: taskId, phase: nil)
      out += agentLines(phases.flatMap(\.agents), key: loose, title: UICopy.workflowAgentsLabel, expansion: expansion)
      return out
    }
    for phase in phases {
      let expanded = phase.expandable && expansion.isExpanded(phase.key, current: phase.isCurrent)
      out.append(.phase(phase, expanded: expanded))
      guard expanded else { continue }
      out += agentLines(phase.agents, key: phase.key, title: phase.title, expansion: expansion)
    }
    return out
  }

  /// Układ rozwiniętej fazy, ZAWSZE ten sam, bez progu liczby agentów: najpierw żywi
  /// w kolejności startu — panel odpowiada na „co teraz pracuje", a żywy nie tonie pod skończonymi — pod
  /// nimi jeden wiersz „✓ N skończyło", który ręcznie rozwija skończonych. Układ nie przełącza się sam,
  /// więc nic nie skacze: agent, który kończy, schodzi z żywych, a licznik rośnie o 1.
  private func agentLines(
    _ agents: [WorkflowAgentItem], key: WorkflowExpansion.Key, title: String, expansion: WorkflowExpansion
  ) -> [WorkflowLine] {
    var out = agents.filter { !$0.done }.map { WorkflowLine.agent(task: taskId, $0) }
    let done = agents.filter(\.done)
    guard !done.isEmpty else { return out }
    let open = expansion.isDoneExpanded(key)
    let group = WorkflowDoneGroup(
      key: key, title: title, count: done.count, spoken: UICopy.workflowDoneGroupSpoken(title: title, count: done.count))
    out.append(.doneGroup(group, expanded: open))
    if open { out += done.map { WorkflowLine.agent(task: taskId, $0) } }
    return out
  }
}
