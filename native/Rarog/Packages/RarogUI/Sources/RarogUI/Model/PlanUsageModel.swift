import Foundation
import RarogContract
import RarogCore

// Plan usage: the two fields of the list footer card (5 h and week; layout in
// `ListFooterCardModel`) and the rows of the "Usage" sheet with full names and resets. Owner: list.

/// Które okno limitu.
public enum UsageWindowKind: Sendable, Equatable {
  case fiveHour
  case weekly
  /// Okno per model; nazwa z API (pusta = nieznana).
  case model(String)
}

/// Próg koloru segmentu: do 60 % spokojnie, 60–85 % uwaga, powyżej gorąco.
public enum UsageTone: Sendable, Equatable {
  case calm, warn, hot

  public init(percent: Int) {
    self = percent > 85 ? .hot : percent >= 60 ? .warn : .calm
  }
}

/// Skąd notka „nie z tej chwili".
public enum UsageStaleSource: Sendable, Equatable {
  /// Serwer oddał stary zrzut paska statusu Claude Code (jego jedyne źródło).
  case serverCli
  /// Serwer oddał ostatni dobry odczyt API.
  case serverApi
  /// Nasze odświeżenie padło na sieci.
  case refreshFailed
}

/// Jedno okno w trzech formach naraz — wspólne źródło paska, panelu i czytnika.
public struct UsageSegment: Sendable, Equatable, Identifiable {
  public let id: String
  public let short: String
  public let full: String
  public let spoken: String
  /// Zaokrąglony i przycięty do 0–100 raz, u źródła.
  public let percent: Int
  public let tone: UsageTone
  public let resetsAt: Date?
}

/// Miejsce okna w pasku stopki: zawsze dwa, 5 h z lewej i tydzień z prawej — także gdy serwer okna nie dał
/// i przy szkielecie, więc okno nie staje w cudzej kolumnie. Etykiety znane bez liczby.
public struct UsageSlot: Sendable, Equatable, Identifiable {
  public let id: String
  /// Pasek: „5h", „7d" (wielkie litery robi styl etykiety).
  public let short: String
  /// Panel: „Okno 5-godzinne", „Tydzień".
  public let full: String
  /// Czytnik: „okno 5 godzin", „tydzień".
  public let spoken: String
  /// Liczby okna; `nil` = brak okna w odczycie albo szkielet (``PlanUsageModel/isSkeleton``).
  public let segment: UsageSegment?
}

public struct PlanUsageModel: Sendable, Equatable {
  public let phase: PlanUsageState.Phase
  /// Okna w kolejności 5 h → tydzień → model; puste przy szkielecie. Panel i arkusz; pasek bierze ``slots``.
  public let segments: [UsageSegment]
  /// E-mail konta do nagłówka panelu — CZYJE to limity; `nil`, gdy serwer go nie zna.
  public let account: String?
  /// „Odczyt z 22:10 — API limitów nie odpowiada."; `nil` dla świeżych liczb.
  public let staleNote: String?

  /// Identyfikatory okien — wspólne dla segmentów, miejsc paska i arkusza „Limity”.
  static let fiveHourID = "5h"
  static let weeklyID = "7d"
  static let modelID = "model"

  public static func make(_ state: PlanUsageState, now: Date, timeZone: TimeZone = .current) -> PlanUsageModel {
    guard let usage = state.usage else {
      return PlanUsageModel(phase: state.phase, segments: [], account: nil, staleNote: nil)
    }
    let segments = [fiveHourSegment(usage), weeklySegment(usage), modelSegment(usage)].compactMap { $0 }
    let account = (usage.account ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return PlanUsageModel(
      phase: state.phase, segments: segments, account: account.isEmpty ? nil : account,
      staleNote: staleNote(state, now: now, timeZone: timeZone))
  }

  /// Okno 5 h, tygodnia i per model w trzech formach — wspólne dla stopki i arkusza „Limity”.
  static func fiveHourSegment(_ usage: PlanUsage) -> UsageSegment? {
    usage.fiveHour.map { segment($0, .fiveHour, id: fiveHourID) }
  }

  static func weeklySegment(_ usage: PlanUsage) -> UsageSegment? {
    usage.weekly.map { segment($0, .weekly, id: weeklyID) }
  }

  static func modelSegment(_ usage: PlanUsage) -> UsageSegment? {
    usage.weeklyModel.map {
      segment($0, .model(($0.model ?? "").trimmingCharacters(in: .whitespaces)), id: modelID)
    }
  }

  private static func segment(_ window: UsageWindow, _ kind: UsageWindowKind, id: String) -> UsageSegment {
    let names = UICopy.usageWindowNames(kind)
    // Przycięcie PRZED konwersją: `Int(Double)` zatrzymuje apkę poza zakresem `Int`, a `z.number()`
    // serwera przepuści np. 1e20.
    let percent = Int(min(100, max(0, window.percent)).rounded())
    return UsageSegment(
      id: id, short: names.short, full: names.full, spoken: names.spoken, percent: percent,
      tone: UsageTone(percent: percent), resetsAt: window.resetsAt.flatMap(ServerTime.parse))
  }

  /// Godzina jest jedyną uczciwą formą: zegar na pasku mówi „to nie jest teraz", ale nie mówi,
  /// z kiedy. Serwer podaje własną (`fetchedAt`); nasza porażka — godzinę, kiedy liczby przyszły.
  static func staleNote(_ state: PlanUsageState, now: Date, timeZone: TimeZone) -> String? {
    guard let usage = state.usage else { return nil }
    if usage.stale == true, let fetched = usage.fetchedAt.flatMap(ServerTime.parse) {
      let clock = resetClock(fetched, now: now, timeZone: timeZone)
      return UICopy.usageStaleNote(at: clock, source: usage.source == "cli" ? .serverCli : .serverApi)
    }
    guard state.refreshFailed, let received = state.receivedAt else { return nil }
    return UICopy.usageStaleNote(at: resetClock(received, now: now, timeZone: timeZone), source: .refreshFailed)
  }

  /// „17:20" dziś, „09.10 17:20" innego dnia.
  static func resetClock(_ date: Date, now: Date, timeZone: TimeZone, locale: Locale = CopyLocale.current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    guard !calendar.isDate(date, inSameDayAs: now) else { return clockOnly(date, timeZone: timeZone, locale: locale) }
    return ServerTime.dayNumericClock(date, timeZone: timeZone, locale: locale)
  }

  /// „17:20" w strefie urządzenia.
  static func clockOnly(_ date: Date, timeZone: TimeZone, locale: Locale = CopyLocale.current) -> String {
    ServerTime.clock(date, timeZone: timeZone, locale: locale)
  }

  /// Najostrzejszy próg — dla miejsc, które kolorują linię jako całość.
  public var tone: UsageTone {
    UsageTone(percent: segments.map(\.percent).max() ?? 0)
  }

  /// The card's two fields in a fixed order: 5 h, week. The card has no per-model window (the server
  /// doesn't give it; the `/usage` sheet does) — without the 5 h window the week stays on the right.
  public var slots: [UsageSlot] {
    [(UsageWindowKind.fiveHour, Self.fiveHourID), (.weekly, Self.weeklyID)].map { kind, id in
      let names = UICopy.usageWindowNames(kind)
      return UsageSlot(
        id: id, short: names.short, full: names.full, spoken: names.spoken, segment: segments.first { $0.id == id })
    }
  }

  /// No reading at all (loading or unavailable): the card stands as a skeleton — labels and ghosts, no numbers.
  public var isSkeleton: Bool { phase == .loading || phase == .unavailable }

  /// Opacity of the skeleton's ghosts: dimmed when unavailable. Labels and numbers always at full opacity (AA).
  public var ghostOpacity: Double { phase == .unavailable ? 0.55 : 1 }

  /// The next moment after `date` at which the reset countdown of some window changes (`UICopy.usageCountdown`, the
  /// card's reset line). The countdown counts whole units from rounded seconds, so it steps down at
  /// `reset − k · unit + 0.5 s`; the unit is a day from one day on, a minute from one minute on, a second below. The
  /// card redraws at these moments rather than on the wall-clock minute, so it never shows a minute more than the
  /// "Usage" sheet next to it. Without an upcoming change: in a minute.
  public static func nextResetTick(after date: Date, resets: [Date]) -> Date {
    let ticks = resets.compactMap { reset -> Date? in
      let remaining = reset.timeIntervalSince(date)
      let unit: TimeInterval = remaining >= 86_400 ? 86_400 : remaining >= 60 ? 60 : 1
      var steps = ((remaining + 0.5 + tickSlack) / unit).rounded(.up) - 1
      // Called at the tick itself: floating-point rounding can return the same tick, so take the next one (otherwise
      // the `TimelineView` sequence would stand still).
      if remaining + 0.5 + tickSlack - unit * steps <= tickSlack / 2 { steps -= 1 }
      return steps >= 1 ? reset.addingTimeInterval(0.5 + tickSlack - unit * steps) : nil
    }
    return ticks.min() ?? date.addingTimeInterval(60)
  }

  /// The tick stands just AFTER the change, so drawing at it already sees the new value.
  static let tickSlack: TimeInterval = 0.01

  /// „reset 17:20 · za 2 h 44"; `nil`, gdy API nie podało momentu resetu.
  public func resetLine(_ segment: UsageSegment, now: Date, timeZone: TimeZone = .current) -> String? {
    Self.resetLine(segment, now: now, timeZone: timeZone)
  }

  /// Pełne zdanie wiersza panelu dla czytnika.
  public func rowSpoken(_ segment: UsageSegment, now: Date, timeZone: TimeZone = .current) -> String {
    Self.rowSpoken(segment, now: now, timeZone: timeZone)
  }

  /// Wiersz okna wspólny dla panelu stopki i arkusza „Limity”.
  static func resetLine(_ segment: UsageSegment, now: Date, timeZone: TimeZone) -> String? {
    guard let at = segment.resetsAt else { return nil }
    let seconds = Int(at.timeIntervalSince(now).rounded())
    return UICopy.usageReset(
      at: resetClock(at, now: now, timeZone: timeZone), countdown: UICopy.usageCountdown(seconds: seconds))
  }

  static func rowSpoken(_ segment: UsageSegment, now: Date, timeZone: TimeZone) -> String {
    let reset = resetLine(segment, now: now, timeZone: timeZone)
    return UICopy.usageRowSpoken(segment.full, percent: segment.percent, reset: reset)
  }

  /// The usage part of the card's sentence: the two fields (5 h and week; the card has no per-model window, so
  /// VoiceOver doesn't either), a missing window in words, the stale note. Loading and unavailable in one sentence.
  /// "Limity planu — okno 5 godzin: brak odczytu; tydzień: 64 procent, reset o 15:00."
  func usageSpoken(timeZone: TimeZone) -> String {
    switch phase {
    case .loading: return UICopy.usageLoadingSpoken
    case .unavailable: return UICopy.usagePanelUnavailable
    case .ready, .stale: break
    }
    let parts = slots.map { slot in
      guard let segment = slot.segment else { return UICopy.usageSlotMissingSpoken(slot.spoken) }
      return UICopy.usageSegmentSpoken(
        slot.spoken, percent: segment.percent,
        resetClock: segment.resetsAt.map { Self.clockOnly($0, timeZone: timeZone) })
    }
    return UICopy.list([UICopy.sentence(UICopy.usageLineSpoken(parts))] + (staleNote.map { [$0] } ?? []), .sentence)
  }
}
