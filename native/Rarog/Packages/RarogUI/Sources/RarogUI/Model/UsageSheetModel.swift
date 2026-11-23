import Foundation
import RarogContract
import RarogCore

// Arkusz „Limity” komendy apki `/usage`, `/cost`, `/stats`: okno 5 h,
// tydzień i tydzień per model (np. Fable) z godziną, z której są liczby. Dwa źródła serwera, każde z WŁASNĄ chwilą:
// `GET /api/usage` (pasek statusu Claude Code, ten sam odczyt co stopka listy, zwykle sprzed minut) i
// `GET /api/usage/details` (odczyt limitów, który Claude Code zapisuje sam w `~/.claude.json` i odświeża rzadko —
// jedyne źródło okna per model). Chwile obu odczytów nie zależą od Raroga, więc ich liczby mogą się różnić.
// Dlatego 5 h i tydzień idą parą z odczytu ŚWIEŻSZEGO, okno per model ze szczegółów, a notka podaje obie
// godziny, gdy się różnią.
// Stopka listy zostaje bez okna per model. The sheet also carries the machine load
// section and the limits' stale note: the footer card has no expanded panel. Model bez UIKit,
// testowany na macOS (`UsageSheetModelTests`). Widok: `Views/Usage/UsageSheet`. Właściciel: lista.

/// Odczyt `GET /api/usage/details` w arkuszu: jeden przy każdym otwarciu.
public enum UsageDetailsPhase: Sendable, Equatable {
  case loading
  /// Odpowiedź i chwila, w której doszła (godzina, gdy serwer nie podał `fetchedAt`).
  case loaded(PlanUsage, receivedAt: Date)
  /// Serwer sprzed trasy (404, 405).
  case unsupported
  case failed

  public init(_ outcome: UsageDetailsOutcome, receivedAt: Date) {
    switch outcome {
    case let .loaded(usage): self = .loaded(usage, receivedAt: receivedAt)
    case .unsupported: self = .unsupported
    case .failed: self = .failed
    }
  }
}

public struct UsageSheetModel: Sendable, Equatable {
  /// Szczegóły w drodze: arkusz pokazuje sam wskaźnik, bez wierszy, które za chwilę zmieniłyby źródło.
  public let loading: Bool
  /// Okna w kolejności 5 h → tydzień → model.
  public let segments: [UsageSegment]
  /// E-mail konta — CZYJE to limity.
  public let account: String?
  /// Zdania pod wierszami: godzina odczytu, nieświeże limity, powód braku okna per model, brak liczb.
  public let notes: [String]
  /// Server machine section: the load with what each number means and, for a
  /// server older than the app's release, the update command. `nil` = nothing to show (a server without the
  /// load feature and up to date, or no load given).
  public let machine: MachineSection?

  /// Heading "Mac" or "VPS" with the tailnet name, the metric rows, the load notes and the update sentence.
  public struct MachineSection: Sendable, Equatable {
    public let title: String
    /// "TS · example.ts.net"; `nil` when the tailnet is unknown.
    public let tailnet: String?
    /// VoiceOver sentence of the heading.
    public let spoken: String
    /// CPU, RAM, disk with their details; empty without any number (the notes say why).
    public let metrics: [MacMetricRow]
    /// Why there are no numbers (loading, unavailable) and the stale note with the machine's own reading time —
    /// independent of the limits' stamp.
    public let notes: [String]
    /// The update sentence with the command; `nil` for a current server.
    public let update: String?
  }

  /// Źródło liczb z chwilą, z której są.
  private struct Source {
    let usage: PlanUsage
    let at: Date
    /// The status bar reading (`GET /api/usage`), whose stale note the sheet carries when its numbers are shown.
    var bar = false
  }

  public static func make(
    usage state: PlanUsageState, details: UsageDetailsPhase, now: Date, machine: ServerMachine,
    update: ServerUpdate? = nil, load: MacLoadModel? = nil, timeZone: TimeZone = .current
  ) -> UsageSheetModel {
    // Neither the server version nor the load depends on the details reading: the section stands while loading too.
    let section = machineSection(machine: machine, update: update, load: load)
    if details == .loading {
      return UsageSheetModel(loading: true, segments: [], account: nil, notes: [], machine: section)
    }
    // Chwila liczb: `fetchedAt` serwera, a bez niego (demo) — kiedy liczby doszły do apki.
    let bar = state.usage.map { usage in
      Source(usage: usage, at: usage.fetchedAt.flatMap(ServerTime.parse) ?? state.receivedAt ?? now, bar: true)
    }
    var cli: Source?
    if case let .loaded(usage, receivedAt) = details, usage.hasAnyWindow {
      cli = Source(usage: usage, at: usage.fetchedAt.flatMap(ServerTime.parse) ?? receivedAt)
    }
    // 5 h i tydzień parą z odczytu świeższego; remis zostaje przy pasku statusu (to jego liczby widzi stopka).
    let pair = [bar, cli].compactMap { $0 }.filter { $0.usage.fiveHour != nil || $0.usage.weekly != nil }
      .reduce(nil as Source?) { best, next in best.map { next.at > $0.at ? next : $0 } ?? next }
    // Okno per model ze szczegółów; z paska tylko wtedy, gdy szczegółów nie ma (stary serwer, demo).
    let model = [cli, bar].compactMap { $0 }.first { $0.usage.weeklyModel != nil }
    let modelSegment = model.flatMap { PlanUsageModel.modelSegment($0.usage) }
    var segments: [UsageSegment] = []
    if let pair {
      segments += [PlanUsageModel.fiveHourSegment(pair.usage), PlanUsageModel.weeklySegment(pair.usage)].compactMap { $0 }
    }
    if let modelSegment { segments.append(modelSegment) }

    var notes: [String] = []
    if segments.isEmpty { notes.append(UICopy.usagePanelUnavailable) }
    let clock = { (at: Date) in PlanUsageModel.resetClock(at, now: now, timeZone: timeZone) }
    switch (pair, model, modelSegment) {
    case let (pair?, model?, segment?) where clock(pair.at) != clock(model.at):
      notes.append(UICopy.usageSheetStamp(at: clock(pair.at), model: segment.spoken, modelAt: clock(model.at)))
    case let (pair?, _, _):
      notes.append(UICopy.usageSheetStamp(at: clock(pair.at)))
    case let (nil, model?, _):
      notes.append(UICopy.usageSheetStamp(at: clock(model.at)))
    case (nil, nil, _):
      break
    }
    // The limits' stale note (the server's last good reading, our failed refresh): only while the status bar's
    // numbers are on screen — a fresher Claude Code reading makes it moot.
    if pair?.bar == true || (modelSegment != nil && model?.bar == true),
      let stale = PlanUsageModel.staleNote(state, now: now, timeZone: timeZone) {
      notes.append(stale)
    }
    if modelSegment == nil {
      switch details {
      case .unsupported: notes.append(UICopy.usageDetailsUnsupported)
      case .failed: notes.append(UICopy.usageDetailsFailed)
      case .loaded: notes.append(UICopy.usageNoModelWindow(machine))
      case .loading: break
      }
    }
    let account = [cli?.usage.account, bar?.usage.account].lazy.compactMap { $0 }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
    return UsageSheetModel(loading: false, segments: segments, account: account, notes: notes, machine: section)
  }

  static func machineSection(machine: ServerMachine, update: ServerUpdate?, load: MacLoadModel?) -> MachineSection? {
    let load = load.flatMap { $0.showsLine ? $0 : nil }
    guard load != nil || update != nil else { return nil }
    let title = UICopy.macSectionTitle(machine)
    let tailnet = load?.tailnet
    return MachineSection(
      title: title, tailnet: tailnet.map(UICopy.tailnetLabel),
      spoken: tailnet.map { UICopy.macTailnetSpoken($0, machine) } ?? title,
      metrics: load.map { $0.hasNumbers ? $0.metrics : [] } ?? [],
      notes: [load?.panelNote, load?.staleNote].compactMap { $0 },
      update: update.map { UICopy.serverUpdateDetail($0, machine) })
  }

  /// „reset 17:20 · za 2 h 44"; `nil`, gdy źródło nie podało momentu resetu.
  public func resetLine(_ segment: UsageSegment, now: Date, timeZone: TimeZone = .current) -> String? {
    PlanUsageModel.resetLine(segment, now: now, timeZone: timeZone)
  }

  /// Pełne zdanie wiersza dla czytnika.
  public func rowSpoken(_ segment: UsageSegment, now: Date, timeZone: TimeZone = .current) -> String {
    PlanUsageModel.rowSpoken(segment, now: now, timeZone: timeZone)
  }
}

extension PlanUsage {
  /// Odpowiedź bez żadnego okna (`{}` szczegółów) nie ma czego pokazać.
  var hasAnyWindow: Bool { fiveHour != nil || weekly != nil || weeklyModel != nil }
}
