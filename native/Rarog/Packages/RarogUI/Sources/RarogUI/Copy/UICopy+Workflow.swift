import Foundation

// Przebieg workflow w panelu „w tle".
// Właściciel: nagłówek (panel „w tle").
extension UICopy {
  /// Grupa agentów bez fazy — tylko, gdy INNI agenci fazy mają.
  public static var workflowNoPhase: String { L("workflow.noPhase") }
  /// Etykieta listy agentów w przebiegu bez tagów; linia planu: ``workflowPlanLine(_:)``.
  public static var workflowAgentsLabel: String { L("workflow.agentsLabel") }
  /// Dopisek fazy z tagu, której skrypt nie wymienia (do licznika `n/m` nie wchodzi).
  public static var workflowOffPlan: String { L("workflow.offPlan") }
  /// Panel bez kontaktu ze źródłem: zegary stoją, rozkład jest ostatnim znanym.
  public static var workflowStale: String { L("workflow.stale") }
  public static var workflowStaleSpoken: String { L("workflow.staleSpoken") }

  /// „1 pracuje", „2 pracują", „5 pracuje".
  public static func workflowRunning(_ n: Int) -> String { L("workflow.running", n) }

  /// „1/3 faz · 16 skończyło · 1 pracuje"; bez faz (przebieg bez tagów) sam licznik agentów. `tally` — człony
  /// licznika agentów (`WorkflowRunModel.tallyParts`), każdy osobno: ekran łączy je kropką, czytnik przecinkiem.
  static func workflowSummary(rail: (done: Int, total: Int)?, tally: [String]) -> String {
    list((rail.map { [L("workflow.summary", $0.done, $0.total)] } ?? []) + tally.filter { !$0.isEmpty }, .dot)
  }

  /// Jedno zdanie o przebiegu: liczniki, potem faza po fazie (`WorkflowRunModel.spoken`).
  static func workflowSummarySpoken(rail: (done: Int, total: Int)?, tally: [String], sentence: String) -> String {
    var head: [String] = []
    if let rail { head.append(L("workflow.summarySpoken.phases", rail.done, rail.total)) }
    head += tally.filter { !$0.isEmpty }
    let lead = L("workflow.summarySpoken", list(head, .comma))
    return sentence.isEmpty ? lead : L("workflow.summarySpoken.withPhases", lead, sentence)
  }

  /// „fazy: A · B · C" — plan przebiegu bez tagów, bez stanu (stanu faz nie znamy).
  static func workflowPlanLine(_ phases: [String]) -> String {
    L("workflow.planLine", list(phases, .dot))
  }

  /// Etykieta przycisku fazy: tytuł, stan słowem, liczniki.
  static func workflowPhaseSpoken(title: String, offPlan: Bool, state: WorkflowPhaseState, done: Int, agents: Int) -> String {
    let name = offPlan ? L("workflow.phaseSpoken.offPlanName", title) : title
    switch state {
    case .running: return L("workflow.phaseSpoken.running", name, done, agents)
    case .done: return L("workflow.phaseSpoken.done", name, done, agents)
    case .pending: return L("workflow.phaseSpoken.pending", name)
    }
  }

  /// Wiersz skończonych pod fazą dla czytnika: „Review: 44 skończyło".
  static func workflowDoneGroupSpoken(title: String, count: Int) -> String {
    L("workflow.doneGroupSpoken", title, count)
  }

  /// „verify:B pracuje” / „verify:A skończył” — agent i jego stan (czytnik: wiersz agenta i zdanie przebiegu).
  static func workflowAgentHead(name: String, done: Bool) -> String {
    done ? L("workflow.agentHead.done", name) : L("workflow.agentHead.working", name)
  }

  /// Zdanie przebiegu bez tagów: plan faz (gdy jest) i agenci po przecinku.
  static func workflowUntaggedSpoken(phases: [String], agents: [String]) -> String {
    phases.isEmpty
      ? L("workflow.untaggedSpoken", list(agents, .comma))
      : L("workflow.untaggedSpoken.withPlan", list(phases, .comma), list(agents, .comma))
  }

  /// Faza w zdaniu przebiegu: „Faza B: impl:auth skończył, verify:auth pracuje”.
  static func workflowPhaseAgentsSpoken(title: String, agents: [String]) -> String {
    L("workflow.phaseAgentsSpoken", title, list(agents, .comma))
  }

  /// „verify:B pracuje, od 4 minut" / „verify:A skończył".
  public static func workflowAgentSpoken(_ agent: WorkflowAgentItem, now: Date) -> String {
    let head = workflowAgentHead(name: agent.name, done: agent.done)
    guard let since = agent.since else { return head }
    return L("workflow.agentSpoken", head, RelativeTime.spokenSince(since: since, now: now))
  }
}
