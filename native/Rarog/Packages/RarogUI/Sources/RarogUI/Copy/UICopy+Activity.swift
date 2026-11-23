import Foundation
import RarogContract
import RarogCore

// Wiersz aktywności pod transkryptem i linia etapu karty.
// Właściciel: aktywność. Czasowniki narzędzi mieszkają osobno, w `ToolActivity`.
extension UICopy {
  // MARK: Wiersz aktywności

  /// Copy przy braku sygnału z narzędzia — pełne zdanie, nie techniczny skrót.
  public static var activityThinking: String { L("activity.thinking") }
  public static var activityWaiting: String { L("activity.waiting") }
  public static var activitySubagent: String { L("activity.subagent") }
  /// Na karcie listy z opisem: „subagent: Research: …" — „pracuje" mówi już kropka.
  public static var activitySubagentShort: String { L("activity.subagentShort") }
  public static var activityWorkflow: String { L("activity.workflow") }
  /// Tytuł fazy dłuższy niż to nie mieści się w linii karty — zostaje sama liczba.
  public static let phaseTitleMax = 24

  /// „3 agenty", „1 agent", „5 agentów".
  public static func agentsCount(_ n: Int) -> String { L("activity.agentsCount", n) }

  /// „2 skończyło", „1 skończył".
  public static func agentsDone(_ n: Int) -> String { L("activity.agentsDone", n) }

  /// „faza 2/5".
  public static func phaseHead(index: Int, total: Int) -> String {
    L("activity.phaseHead", index, total)
  }

  /// „faza 2/5 Review” — z tytułem fazy, gdy mieści się w linii karty.
  public static func phaseHead(index: Int, total: Int, title: String) -> String {
    L("activity.phaseHead.titled", index, total, title)
  }

  /// Czynność narzędzia z jego opisem: „czyta: …/Copy/UICopy.swift” (czasownik z `ToolActivity`).
  public static func toolLead(_ verb: String, summary: String) -> String { L("activity.toolLead", verb, summary) }

  /// „workflow: audyt-ux” — przebieg z nazwą.
  public static func workflowNamed(_ name: String) -> String { L("activity.workflowNamed", name) }

  /// „subagent: Research herdr API” — pojedynczy subagent z opisem (karta listy, linia z pamięci tury).
  public static func subagentLead(_ description: String) -> String { L("activity.subagentLead", description) }

  /// „w tle: komenda” — linia karty, która nie pracuje, a ma coś w tle.
  public static func backgroundLead(_ what: String) -> String { L("activity.backgroundLead", what) }

  /// „czeka: subagent” — linia karty przy samych subagentach w postoju. To nie jest „czeka” karty na decyzję
  /// człowieka (`waitingLine`): agent czeka na własne zadanie, od nikogo niczego nie chce.
  public static func waitingLead(_ what: String) -> String { L("activity.waitingLead", what) }

  /// Rodzaj zadania z opisem albo komendą: „komenda pnpm test”, „subagent Research herdr API”.
  public static func taskNamed(kind: String, name: String) -> String { L("activity.taskNamed", kind, name) }

  /// Czas trwania pełnym słowem po „od" (dopełniacz: „od 3 sekund", „od 1 minuty") — skrót
  /// „12 s" bywa czytany dosłownie.
  public static func spokenDuration(_ seconds: Int) -> String {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    return RelativeTime.spokenSince(since: start, now: start.addingTimeInterval(TimeInterval(max(0, seconds))))
  }

  /// „od 2 minut” dla czytnika: `value` to już odmieniony czas (`spokenDuration`, `RelativeTime.spokenSince`).
  public static func sinceSpoken(_ value: String) -> String { L("activity.sinceSpoken", value) }

  /// Zdanie wiersza dla czytnika ekranu, z podmiotem.
  public static func activitySpoken(_ sentence: String) -> String {
    L("activity.spoken", sentence)
  }

  // MARK: Activity line (`ActivityRowLine`)

  /// Label while the agent thinks and no tool runs.
  public static var activityLineThinking: String { L("activity.line.thinking") }
  /// Label while the engine waits and the server gave no sentence.
  public static var activityLineWaiting: String { L("activity.line.waiting") }
  public static var activityLineReading: String { L("activity.line.reading") }
  public static var activityLineEditing: String { L("activity.line.editing") }
  public static var activityLineWriting: String { L("activity.line.writing") }
  public static var activityLineRunning: String { L("activity.line.running") }
  public static var activityLineSearching: String { L("activity.line.searching") }
  public static var activityLineSearchingWeb: String { L("activity.line.searchingWeb") }
  public static var activityLineFetching: String { L("activity.line.fetching") }
  /// A tool the server did not name.
  public static var activityLineUnnamedTool: String { L("activity.line.unnamedTool") }

  /// "Quiet for 2m": `duration` is the short form on screen, the spoken form (``spokenDuration(_:)``) for VoiceOver.
  public static func activityLineQuiet(_ duration: String) -> String { L("activity.line.quietFor", duration) }

  /// "still running · 3m": the detail of a tool that runs long.
  public static func activityLineStillRunning(_ duration: String) -> String { L("activity.line.stillRunning", duration) }

  /// "still running for 3 minutes" for VoiceOver (`duration` from ``spokenDuration(_:)``).
  public static func activityLineStillRunningSpoken(_ duration: String) -> String {
    L("activity.line.stillRunningSpoken", duration)
  }

  /// "last update 42s ago": the detail while the stream is broken.
  public static func activityLineLastUpdate(_ duration: String) -> String { L("activity.line.lastUpdate", duration) }

  /// "last update 2 minutes ago" for VoiceOver (`ago` from `RelativeTime.spokenAgo`).
  public static func activityLineLastUpdateSpoken(_ ago: String) -> String { L("activity.line.lastUpdateSpoken", ago) }

  // MARK: Zadania w tle

  /// „3 w tle".
  public static func backgroundBadge(_ count: Int) -> String {
    L("activity.backgroundBadge", max(0, count))
  }

  /// „2 subagenty", „5 subagentów" (przy jednym linia mówi rodzaj i opis, nie liczbę).
  public static func subagentsCount(_ n: Int) -> String { L("activity.subagentsCount", n) }

  /// Rodzaj zadania w tle; rodzaj spoza tej wersji apki dostaje słowo ogólne, nie zgadywanie.
  public static func backgroundKind(_ kind: BackgroundTaskKind) -> String {
    switch kind {
    case .agent: L("activity.backgroundKind.agent")
    case .workflow: L("activity.backgroundKind.workflow")
    case .monitor: L("activity.backgroundKind.monitor")
    case .command: L("activity.backgroundKind.command")
    case .unsupported: L("activity.backgroundKind.unsupported")
    }
  }
}
