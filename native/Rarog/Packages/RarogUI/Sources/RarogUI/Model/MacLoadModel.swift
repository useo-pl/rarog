import Foundation
import RarogContract
import RarogCore

// Server machine load: the three columns of the list footer card (`ListFooterCardModel`) and the machine
// section of the "Usage" sheet with the tailnet name, what each number means and the stale note.
// Thresholds come from `RarogContract` (`MacMetric`), shared with the Live Activity tile. Owner: list.

/// Jedna metryka Maca w trzech formach naraz — pasek, panel, czytnik.
public struct MacMetricRow: Sendable, Equatable, Identifiable {
  public let metric: MacMetric
  /// Pasek: „CPU", „RAM", „DSK" — pole na trzy znaki.
  public let short: String
  /// Panel: „Procesor", „Pamięć", „Dysk".
  public let full: String
  /// Panel, przy nazwie: co znaczy liczba („średnia z minuty", „presja", „zajęte").
  public let detail: String
  /// Czytnik: „procesor", „pamięć", „dysk".
  public let spoken: String
  /// Procent z serwera (krok 5, przycięty do 0–100); `nil` = tej metryki serwer nie odczytał.
  public let percent: Int?
  public let level: MacLoadLevel

  public var id: String { metric.rawValue }

  /// Ten sam podział co limity: zwykły atrament / bursztyn / czerwień (`UsageInk`).
  public var tone: UsageTone {
    switch level {
    case .normal: .calm
    case .warning: .warn
    case .critical: .hot
    }
  }
}

public struct MacLoadModel: Sendable, Equatable {
  public let phase: MacLoadState.Phase
  /// Zawsze trzy metryki w stałej kolejności (CPU, RAM, dysk) — kolumny stoją w miejscu, także w szkielecie.
  public let metrics: [MacMetricRow]
  /// Nazwa tailnetu Maca (sonda `GET /api/version`); `nil` = nie wiadomo albo poza tailnetem.
  public let tailnet: String?
  /// „Odczyt z 16:05 — nie udało się odświeżyć."; `nil` dla świeżych liczb.
  public let staleNote: String?
  /// Słowo maszyny serwera w zdaniach sekcji (``AppState/serverMachine``): „Mac” albo „VPS”.
  public let machine: ServerMachine

  public static func make(
    _ state: MacLoadState, tailnet: String?, machine: ServerMachine, timeZone: TimeZone = .current
  ) -> MacLoadModel {
    let phase = state.phase
    let load = phase == .ready || phase == .stale ? state.load : nil
    let metrics = MacMetric.allCases.map { metric in
      let names = UICopy.macMetricNames(metric)
      let percent = load?.value(metric).map { min(100, max(0, $0)) }
      return MacMetricRow(
        metric: metric, short: names.short, full: names.full, detail: names.detail, spoken: names.spoken,
        percent: percent, level: percent.map(metric.level) ?? .normal)
    }
    let note = phase == .stale
      ? state.receivedAt.map {
        UICopy.usageStaleNote(at: PlanUsageModel.clockOnly($0, timeZone: timeZone), source: .refreshFailed)
      }
      : nil
    return MacLoadModel(phase: phase, metrics: metrics, tailnet: tailnet, staleNote: note, machine: machine)
  }

  /// Machine columns on the card and the machine section in the sheet: everywhere except a server without the
  /// feature (404 — nothing, quietly).
  public var showsLine: Bool { phase != .unsupported }
  /// Jakakolwiek liczba na ekranie.
  public var hasNumbers: Bool { metrics.contains { $0.percent != nil } }
  /// Szkielet pulsuje tylko przy pierwszym odczycie w drodze.
  public var pulses: Bool { phase == .loading }
  /// Najwyższy poziom spośród metryk (np. dla miejsc, które kolorują całość).
  public var level: MacLoadLevel { metrics.map(\.level).max() ?? .normal }

  /// The sheet's sentence when there are no numbers (the machine section stays: it carries the tailnet name); `nil`
  /// with numbers.
  public var panelNote: String? {
    switch phase {
    case .loading: UICopy.macLoadingNote(machine)
    case .unavailable: UICopy.macUnavailableNote(machine)
    case .unsupported: UICopy.macUnsupportedNote
    case .ready, .stale: nil
    }
  }

  /// The machine part of the card's VoiceOver sentence: "Mac — procesor 35 procent; pamięć 80 procent, wysokie; …".
  /// `nil` without the feature (404).
  public var lineSpoken: String? {
    switch phase {
    case .unsupported: return nil
    case .loading: return UICopy.macLoadingSpoken(machine)
    case .unavailable: return UICopy.macUnavailableSpoken(machine)
    case .ready, .stale: break
    }
    let parts = metrics.compactMap { row in
      row.percent.map { UICopy.macMetricSpoken(row.spoken, percent: $0, level: row.level) }
    }
    return UICopy.list([UICopy.sentence(UICopy.macLineSpoken(parts, machine))] + (staleNote.map { [$0] } ?? []), .sentence)
  }

  /// VoiceOver sentence of a sheet row: "Procesor, średnia z minuty: 35 procent".
  public func rowSpoken(_ row: MacMetricRow) -> String {
    Self.rowSpoken(row)
  }

  public static func rowSpoken(_ row: MacMetricRow) -> String {
    let value = row.percent.map { UICopy.macMetricSpoken(nil, percent: $0, level: row.level) } ?? UICopy.macNoReading
    return UICopy.macRowSpoken(full: row.full, detail: row.detail, value: value)
  }
}
