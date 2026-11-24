import Foundation
import RarogContract

// The scheduled-task mark at the end of a session row: a quiet clock while the session has armed crons, with a
// tooltip and a VoiceOver part naming the count and the next run. Owner: list.

/// What the row's clock stands for at a moment: visible tasks and the earliest run still ahead.
public struct ScheduledMark: Sendable, Equatable {
  public let count: Int
  /// The earliest `nextFireAt` after the moment; `nil` when no task has a known future run.
  public let next: Date?
}

extension SessionRowModel {
  /// The mark at `now`, without tasks whose `expiresAt` has passed (the inspector section hides the same ones);
  /// `nil` = no clock.
  public func scheduledMark(now: Date) -> ScheduledMark? {
    let tasks = ScheduledTaskRows.visible(scheduledTasks, now: now)
    guard !tasks.isEmpty else { return nil }
    let next = tasks.compactMap { $0.nextFireAt.flatMap(ServerTime.parse) }.filter { $0 > now }.min()
    return ScheduledMark(count: tasks.count, next: next)
  }

  /// "2 scheduled tasks · next 22:14": the tooltip with `.dot`, the VoiceOver part with `.comma`; the time in the
  /// device zone, as in the inspector section.
  public func scheduledText(
    now: Date, separator: UICopy.ListSeparator, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current,
    language: CopyLanguage = .current
  ) -> String? {
    guard let mark = scheduledMark(now: now) else { return nil }
    var parts = [UICopy.scheduledCount(mark.count, language: language)]
    if let next = mark.next {
      parts.append(UICopy.scheduledNext(
        ScheduledTaskRows.clock(next, timeZone: timeZone, locale: locale), language: language))
    }
    return UICopy.list(parts, separator)
  }
}
