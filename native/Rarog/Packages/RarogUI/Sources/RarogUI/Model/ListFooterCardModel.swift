import Foundation
import RarogContract
import RarogCore

// List footer card: what the always-visible card shows, from the plan usage and the
// machine load. The view (`Views/List/Footer`) only draws it; details live in the "Usage" sheet. Pure model, tested on
// macOS (`ListFooterCardModelTests`). Owner: list.

/// One limit field of the card: label, horizontal bar and percent in one row, the reset line under it.
public struct FooterLimitField: Sendable, Equatable, Identifiable {
  public let id: String
  /// "5H", "7D".
  public let label: String
  /// "45%"; "—" without the window; `nil` in the skeleton (a ghost stands in its place).
  public let percent: String?
  /// Bar fill, 0–1.
  public let fraction: Double
  /// Threshold of the window; `nil` without the window and in the skeleton. Above the calm threshold the label,
  /// the percent and the bar take the threshold color.
  public let tone: UsageTone?
  /// "za 2 h 44", "za 2 d · 14.11", "brak odczytu"; `nil` in the skeleton and when the window has no reset moment.
  public let reset: String?
}

/// One machine column: number above, vertical bar, label below.
public struct FooterMachineColumn: Sendable, Equatable, Identifiable {
  public let id: String
  /// "CPU", "RAM", "DSK".
  public let label: String
  /// "25"; `nil` without a reading (a ghost in the skeleton, "—" otherwise).
  public let value: String?
  public let fraction: Double
  public let tone: UsageTone
}

public struct ListFooterCardModel: Sendable, Equatable {
  /// Account e-mail, left on the first line; `nil` when the server doesn't know it.
  public let account: String?
  /// "Mac · example.ts.net" — the machine word (``AppState/serverMachine``) and the tailnet, right on the first line.
  public let machineLine: String
  /// Always two, 5 h on the left and the week on the right, also in the skeleton.
  public let limits: [FooterLimitField]
  /// Ghosts of the limit fields pulse (first reading on its way) and how strong they are (dimmed when unavailable).
  public let limitsPulse: Bool
  public let limitsGhostOpacity: Double
  /// The three machine columns; `nil` for a server without the feature (404): no columns and no divider.
  public let machine: [FooterMachineColumn]?
  /// The machine reading is on its way: the ghosts of the numbers pulse; without numbers in any other phase they
  /// stand still.
  public let machinePulses: Bool
  /// The card's VoiceOver sentence: limits, then the machine. The card is one control.
  public let spoken: String

  public static func make(
    usage: PlanUsageModel, mac: MacLoadModel, now: Date, timeZone: TimeZone = .current
  ) -> ListFooterCardModel {
    let limits = usage.slots.map { slot -> FooterLimitField in
      let label = slot.short.uppercased(with: CopyLocale.current)
      guard !usage.isSkeleton else {
        return FooterLimitField(id: slot.id, label: label, percent: nil, fraction: 0, tone: nil, reset: nil)
      }
      guard let segment = slot.segment else {
        return FooterLimitField(
          id: slot.id, label: label, percent: UICopy.usageSlotMissingMark, fraction: 0, tone: nil,
          reset: UICopy.usageNoReading)
      }
      return FooterLimitField(
        id: slot.id, label: label, percent: "\(segment.percent)%", fraction: Double(segment.percent) / 100,
        tone: segment.tone, reset: segment.resetsAt.map { resetLine($0, now: now, timeZone: timeZone) })
    }
    let machine = mac.showsLine
      ? mac.metrics.map { metric in
        FooterMachineColumn(
          id: metric.id, label: metric.short, value: metric.percent.map(String.init),
          fraction: Double(metric.percent ?? 0) / 100, tone: metric.tone)
      }
      : nil
    let title = UICopy.macSectionTitle(mac.machine)
    let spoken = UICopy.list(
      [usage.usageSpoken(timeZone: timeZone)] + (mac.lineSpoken.map { [$0] } ?? []), .sentence)
    return ListFooterCardModel(
      account: usage.account, machineLine: mac.tailnet.map { UICopy.footerMachine(title, tailnet: $0) } ?? title,
      limits: limits, limitsPulse: usage.phase == .loading, limitsGhostOpacity: usage.ghostOpacity,
      machine: machine, machinePulses: mac.pulses, spoken: spoken)
  }

  /// "za 2 h 44" within a day; from a day on with the date of the reset: "za 2 d · 14.11".
  static func resetLine(_ at: Date, now: Date, timeZone: TimeZone) -> String {
    let seconds = Int(at.timeIntervalSince(now).rounded())
    let countdown = UICopy.usageCountdown(seconds: seconds)
    guard seconds >= 86_400 else { return countdown }
    return UICopy.footerResetDays(countdown, day: ServerTime.dayNumeric(at, timeZone: timeZone))
  }
}
