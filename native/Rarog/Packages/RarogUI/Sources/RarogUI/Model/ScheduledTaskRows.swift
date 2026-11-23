import Foundation
import RarogContract

// The Scheduled Tasks section of the session inspector: rows from `SessionSummary.scheduledTasks`
// (`docs/scheduled-tasks.md`). Pure functions, tested on macOS; the view (`InspectorScheduledSection`) only lays them
// out. Owner: inspector.

/// A task the session's Claude Code has armed (a cron). The first line is the prompt; under it one muted line in the
/// grammar of the Recently finished rows. A task that runs once says "once" and when; a repeating one says its
/// schedule in words and the next run, or the last one when no future run is known.
public struct ScheduledTaskRow: Sendable, Equatable, Identifiable {
  public let id: String
  public let prompt: String
  public let recurring: Bool
  /// First parts of the muted line, fixed for the row: "once" and the moment, or the schedule in words.
  let lead: [String]
  /// The same parts for VoiceOver: words instead of "min" and ":05".
  let leadSpoken: [String]
  /// The next run of a repeating task and its "next 22:14" part; shown only while that moment is ahead.
  let next: Date?
  let nextText: String?
  /// "last 22:12" of a repeating task, shown when no future run is known.
  let lastText: String?
  let language: CopyLanguage

  /// The muted line in parts; the view joins them with the row grammar's dot.
  public func status(now: Date) -> [String] {
    lead + [timeText(now: now)].compactMap { $0 }
  }

  /// One VoiceOver sentence: prompt, schedule and time.
  public func spoken(now: Date) -> String {
    let parts = leadSpoken + [timeText(now: now)].compactMap { $0 }
    return UICopy.scheduledTaskSpoken(prompt: prompt, schedule: parts, language: language)
  }

  private func timeText(now: Date) -> String? {
    if let next, next > now, let nextText { return nextText }
    return lastText
  }
}

public enum ScheduledTaskRows {
  /// Rows in server order, without tasks whose `expiresAt` has passed at `now`; a repeated id stays once (the first).
  /// Times of the task (`nextFireAt`, `lastFiredAt`) are absolute and shown in the device zone `timeZone`; the cron
  /// fields are the Mac's local time and are shown as written.
  public static func rows(
    _ tasks: [SessionScheduledTask], now: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current,
    language: CopyLanguage = .current
  ) -> [ScheduledTaskRow] {
    let format = Format(timeZone: timeZone, locale: locale, language: language)
    return visible(tasks, now: now).map { task in
      task.recurring ? recurring(task, format) : once(task, format)
    }
  }

  /// Ids of the rows `rows` gives at `now`, without formatting: the section clock compares them between ticks.
  public static func visibleIds(_ tasks: [SessionScheduledTask], now: Date) -> [String] {
    visible(tasks, now: now).map(\.id)
  }

  private static func visible(_ tasks: [SessionScheduledTask], now: Date) -> [SessionScheduledTask] {
    var seen: Set<String> = []
    return tasks.filter { task in
      guard seen.insert(task.id).inserted else { return false }
      // An unreadable time hides nothing.
      guard let expires = task.expiresAt.flatMap(ServerTime.parse) else { return true }
      return expires > now
    }
  }

  private struct Format {
    let timeZone: TimeZone
    let locale: Locale
    let language: CopyLanguage

    func clock(_ date: Date) -> String { ServerTime.clock(date, timeZone: timeZone, locale: locale) }
  }

  /// "once · 19 Nov 22:13": the moment from `nextFireAt`, without it from the cron fields; a pattern without a
  /// fixed day gives the time alone, one without a fixed time the pattern as written.
  private static func once(_ task: SessionScheduledTask, _ format: Format) -> ScheduledTaskRow {
    let when: String =
      if let next = task.nextFireAt.flatMap(ServerTime.parse) {
        ServerTime.dayClock(next, timeZone: format.timeZone, locale: format.locale, language: format.language)
      } else {
        CronFields(task.cron).map { fieldsMoment($0, format) } ?? task.cron
      }
    let lead = [UICopy.scheduledOnce(language: format.language), when]
    return ScheduledTaskRow(
      id: task.id, prompt: task.prompt, recurring: false, lead: lead, leadSpoken: lead, next: nil, nextText: nil,
      lastText: nil, language: format.language)
  }

  private static func fieldsMoment(_ fields: CronFields, _ format: Format) -> String {
    guard let time = fields.time else { return fields.raw }
    guard let day = fields.day else { return fieldClock(time, format) }
    // The cron fields are a wall-clock moment: build it and format it in one fixed zone, so nothing shifts it.
    let fixed = TimeZone(identifier: "UTC")!
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = fixed
    // A leap year, so 29 February is a real day; the line shows no year.
    let parts = DateComponents(year: 2028, month: day.month, day: day.day, hour: time.hour, minute: time.minute)
    guard let date = calendar.date(from: parts),
      calendar.component(.month, from: date) == day.month, calendar.component(.day, from: date) == day.day
    else { return fields.raw }
    return ServerTime.dayClock(date, timeZone: fixed, locale: format.locale, language: format.language)
  }

  /// The time of the cron fields by the device region ("09:05", "9:05 AM"), with no zone shift.
  private static func fieldClock(_ time: CronFields.Time, _ format: Format) -> String {
    let fixed = TimeZone(identifier: "UTC")!
    let date = Date(timeIntervalSince1970: TimeInterval(time.hour * 3600 + time.minute * 60))
    return ServerTime.clock(date, timeZone: fixed, locale: format.locale)
  }

  /// The schedule in words for the known patterns, otherwise the pattern as written; then the next or last run.
  private static func recurring(_ task: SessionScheduledTask, _ format: Format) -> ScheduledTaskRow {
    let language = format.language
    var lead = task.cron
    var spoken = task.cron
    if let fields = CronFields(task.cron) {
      switch fields.repeating {
      case .everyMinutes(let minutes)?:
        lead = UICopy.scheduledEveryMinutes(minutes, language: language)
        spoken = UICopy.scheduledEveryMinutesSpoken(minutes, language: language)
      case .hourly(let minute)?:
        lead = UICopy.scheduledHourly(minute, language: language)
        spoken = UICopy.scheduledHourlySpoken(minute, language: language)
      case .daily(let time)?:
        lead = UICopy.scheduledDaily(fieldClock(time, format), language: language)
        spoken = lead
      case .weekdays(let time)?:
        lead = UICopy.scheduledWeekdays(fieldClock(time, format), language: language)
        spoken = lead
      case nil:
        break
      }
    }
    let next = task.nextFireAt.flatMap(ServerTime.parse)
    let last = task.lastFiredAt.flatMap(ServerTime.parse)
    return ScheduledTaskRow(
      id: task.id, prompt: task.prompt, recurring: true, lead: [lead], leadSpoken: [spoken], next: next,
      nextText: next.map { UICopy.scheduledNext(format.clock($0), language: language) },
      lastText: last.map { UICopy.scheduledLast(format.clock($0), language: language) }, language: language)
  }
}

/// The five fields of a cron pattern, read only as far as the row needs: a fixed time, a fixed day and the
/// repeating patterns the row says in words. `nil` = not five fields.
struct CronFields: Sendable, Equatable {
  struct Time: Sendable, Equatable {
    let hour: Int
    let minute: Int
  }

  struct Day: Sendable, Equatable {
    let month: Int
    let day: Int
  }

  enum Repeating: Sendable, Equatable {
    case everyMinutes(Int)
    case hourly(minute: Int)
    case daily(Time)
    case weekdays(Time)
  }

  let raw: String
  private let fields: [Substring]

  init?(_ raw: String) {
    let fields = raw.split(whereSeparator: { $0 == " " || $0 == "\t" })
    guard fields.count == 5 else { return nil }
    self.raw = raw
    self.fields = fields
  }

  /// Minute and hour, both plain numbers in range.
  var time: Time? {
    guard let minute = Self.number(fields[0], in: 0...59), let hour = Self.number(fields[1], in: 0...23) else {
      return nil
    }
    return Time(hour: hour, minute: minute)
  }

  /// Day of month and month, both plain numbers in range (whether the day exists is the caller's check).
  var day: Day? {
    guard let day = Self.number(fields[2], in: 1...31), let month = Self.number(fields[3], in: 1...12) else {
      return nil
    }
    return Day(month: month, day: day)
  }

  var repeating: Repeating? {
    let rest = fields[2...].map(String.init)
    if fields[0].hasPrefix("*/"), fields[1...].allSatisfy({ $0 == "*" }),
      let step = Self.number(fields[0].dropFirst(2), in: 1...59)
    {
      return .everyMinutes(step)
    }
    if let minute = Self.number(fields[0], in: 0...59), fields[1...].allSatisfy({ $0 == "*" }) {
      return .hourly(minute: minute)
    }
    guard let time else { return nil }
    if rest == ["*", "*", "*"] { return .daily(time) }
    if rest == ["*", "*", "1-5"] { return .weekdays(time) }
    return nil
  }

  private static func number(_ field: Substring, in range: ClosedRange<Int>) -> Int? {
    guard !field.isEmpty, field.count <= 2, field.allSatisfy(\.isASCII), field.allSatisfy(\.isNumber),
      let value = Int(field), range.contains(value)
    else { return nil }
    return value
  }
}
