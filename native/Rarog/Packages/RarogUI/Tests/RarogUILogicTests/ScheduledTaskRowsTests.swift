import Foundation
import RarogContract
@testable import RarogUI
import Testing

// Session inspector: the Scheduled Tasks section (`docs/scheduled-tasks.md`). Rows from
// `SessionSummary.scheduledTasks` in server order; the muted line branches on `recurring` first, then on the cron
// pattern; a row whose `expiresAt` has passed is hidden without a new frame.

@Suite("session inspector: Scheduled Tasks rows")
struct ScheduledTaskRowsTests {
  /// The device zone differs from UTC, so a cron-field time (the Mac's local time, shown as written) and an
  /// absolute time (`nextFireAt`, shown in the device zone) take different paths.
  private let warsaw = TimeZone(identifier: "Europe/Warsaw")!
  private let pl = Locale(identifier: "pl_PL")
  private let us = Locale(identifier: "en_US")
  /// 19 Nov 2026, 21:00 in Warsaw.
  private let now = ServerTime.parse("2026-11-19T20:00:00Z")!
  private let nbsp = "\u{00A0}"
  private let narrow = "\u{202F}"

  private func task(
    _ cron: String, recurring: Bool, id: String = "a1b2c3d4", prompt: String = "Check the CI run",
    nextFireAt: String? = nil, lastFiredAt: String? = nil, expiresAt: String? = nil
  ) -> SessionScheduledTask {
    SessionScheduledTask(
      id: id, cron: cron, recurring: recurring, prompt: prompt, createdAt: "2026-11-19T19:00:00Z",
      nextFireAt: nextFireAt, lastFiredAt: lastFiredAt, expiresAt: expiresAt)
  }

  private func rows(_ tasks: [SessionScheduledTask], language: CopyLanguage = .pl, at: Date? = nil) -> [ScheduledTaskRow] {
    ScheduledTaskRows.rows(
      tasks, now: at ?? now, timeZone: warsaw, locale: language == .en ? us : pl, language: language)
  }

  /// The muted line as the row shows it: parts joined by the row grammar's separator.
  private func line(_ task: SessionScheduledTask, language: CopyLanguage = .pl, at: Date? = nil) -> String {
    let row = rows([task], language: language, at: at)[0]
    return row.status(now: at ?? now).joined(separator: " · ")
  }

  @Test(
    "one-shot with any cron pattern: once and the date and time of nextFireAt in the device zone",
    arguments: ["13 22 19 11 *", "0 9 * * *", "*/5 * * * *", "30 * * * *", "0 9 * * 1-5", "0 9 1 * *"])
  func oneShotFromNextFire(cron: String) {
    let once = task(cron, recurring: false, nextFireAt: "2026-11-19T21:13:00.000Z")
    #expect(line(once) == "jednorazowo · 19 lis 22:13")
    #expect(line(once, language: .en) == "once · Nov 19, 10:13\(narrow)PM")
  }

  @Test("one-shot without nextFireAt: date and time from the cron fields as written, not shifted to the device zone")
  func oneShotFromCronFields() {
    let once = task("13 22 19 11 *", recurring: false)
    #expect(line(once) == "jednorazowo · 19 lis 22:13")
    #expect(line(once, language: .en) == "once · Nov 19, 10:13\(narrow)PM")
    // No fixed day: the time alone; no fixed time either: the pattern as written.
    #expect(line(task("0 9 * * *", recurring: false)) == "jednorazowo · 09:00")
    #expect(line(task("0 9 * * *", recurring: false), language: .en) == "once · 9:00\(narrow)AM")
    #expect(line(task("*/5 * * * *", recurring: false)) == "jednorazowo · */5 * * * *")
    #expect(line(task("13 22 31 2 *", recurring: false)) == "jednorazowo · 13 22 31 2 *", "no such day")
  }

  @Test("recurring: each known pattern in words, PL and EN")
  func recurringPatterns() {
    let cases: [(String, String, String)] = [
      ("*/5 * * * *", "co 5\(nbsp)min", "every 5\(nbsp)min"),
      ("*/30 * * * *", "co 30\(nbsp)min", "every 30\(nbsp)min"),
      ("5 * * * *", "co godzinę, :05", "hourly at :05"),
      ("45 * * * *", "co godzinę, :45", "hourly at :45"),
      ("5 9 * * *", "codziennie 09:05", "daily 9:05\(narrow)AM"),
      ("30 21 * * *", "codziennie 21:30", "daily 9:30\(narrow)PM"),
      ("5 9 * * 1-5", "w dni robocze 09:05", "weekdays 9:05\(narrow)AM"),
    ]
    for (cron, polish, english) in cases {
      let recurring = task(cron, recurring: true)
      #expect(line(recurring) == polish, "\(cron)")
      #expect(line(recurring, language: .en) == english, "\(cron)")
    }
  }

  @Test(
    "recurring with any other pattern: the cron text as written",
    arguments: ["0 9 1 * *", "0 9 * * 1-4", "0 9 * * 1,3", "*/0 * * * *", "60 * * * *", "5 24 * * *", "0 9 * *", "a b c d e"])
  func recurringOther(cron: String) {
    #expect(line(task(cron, recurring: true)) == cron)
    #expect(line(task(cron, recurring: true), language: .en) == cron)
  }

  @Test("recurring: next when nextFireAt is in the future, otherwise last when lastFiredAt is known")
  func nextAndLast() {
    let future = task("*/5 * * * *", recurring: true, nextFireAt: "2026-11-19T20:04:00Z", lastFiredAt: "2026-11-19T19:59:00Z")
    #expect(line(future) == "co 5\(nbsp)min · następne 21:04")
    #expect(line(future, language: .en) == "every 5\(nbsp)min · next 9:04\(narrow)PM")
    let fired = task("5 9 * * *", recurring: true, lastFiredAt: "2026-11-19T08:05:00Z")
    #expect(line(fired) == "codziennie 09:05 · ostatnio 09:05")
    #expect(line(fired, language: .en) == "daily 9:05\(narrow)AM · last 9:05\(narrow)AM")
    let stale = task("*/5 * * * *", recurring: true, nextFireAt: "2026-11-19T19:55:00Z", lastFiredAt: "2026-11-19T19:50:00Z")
    #expect(line(stale) == "co 5\(nbsp)min · ostatnio 20:50", "a passed nextFireAt is not a next run")
    #expect(line(task("*/5 * * * *", recurring: true, nextFireAt: "2026-11-19T19:55:00Z")) == "co 5\(nbsp)min")
    // The same row a few minutes later, under the row's own clock: the next run has passed.
    let later = ServerTime.parse("2026-11-19T20:06:00Z")!
    let row = rows([future])[0]
    #expect(row.status(now: later).joined(separator: " · ") == "co 5\(nbsp)min · ostatnio 20:59")
  }

  @Test("a row whose expiresAt has passed under the given clock is hidden; no visible rows means no section")
  func expiry() {
    let expiring = task("*/5 * * * *", recurring: true, id: "r1", expiresAt: "2026-11-19T20:10:00Z")
    let once = task("13 22 19 11 *", recurring: false, id: "o1")
    #expect(rows([expiring, once]).map(\.id) == ["r1", "o1"])
    let after = ServerTime.parse("2026-11-19T20:10:00Z")!
    #expect(rows([expiring, once], at: after).map(\.id) == ["o1"], "expired at that moment")
    #expect(rows([expiring], at: after).isEmpty, "no visible rows, no section")
    #expect(ScheduledTaskRows.rows([], now: now).isEmpty)
    #expect(rows([task("*/5 * * * *", recurring: true, expiresAt: "not a time")]).count == 1, "unreadable time hides nothing")
  }

  @Test("server order kept, a repeated id stays once (the first)")
  func orderAndDuplicates() {
    let list = rows([
      task("0 9 * * *", recurring: true, id: "b", prompt: "second"),
      task("0 9 * * *", recurring: true, id: "a", prompt: "first"),
      task("0 9 * * *", recurring: true, id: "b", prompt: "again"),
    ])
    #expect(list.map(\.id) == ["b", "a"])
    #expect(list.map(\.prompt) == ["second", "first"])
    #expect(list.map(\.recurring) == [true, true])
  }

  @Test("VoiceOver: prompt, schedule and time in one sentence, in words")
  func spoken() {
    let future = task("*/5 * * * *", recurring: true, nextFireAt: "2026-11-19T20:04:00Z")
    #expect(rows([future])[0].spoken(now: now) == "Zaplanowane zadanie Check the CI run, co 5 minut, następne 21:04")
    let minute = task("*/1 * * * *", recurring: true)
    #expect(rows([minute])[0].spoken(now: now) == "Zaplanowane zadanie Check the CI run, co minutę")
    #expect(rows([task("*/2 * * * *", recurring: true)])[0].spoken(now: now).hasSuffix(", co 2 minuty"))
    #expect(rows([minute], language: .en)[0].spoken(now: now) == "Scheduled task Check the CI run, every minute")
    #expect(rows([task("*/5 * * * *", recurring: true)], language: .en)[0].spoken(now: now).hasSuffix(", every 5 minutes"))
    #expect(rows([task("5 * * * *", recurring: true)])[0].spoken(now: now).hasSuffix(", co godzinę, w minucie 5"))
    let once = task("0 9 * * *", recurring: false, nextFireAt: "2026-11-19T21:13:00Z")
    #expect(rows([once])[0].spoken(now: now) == "Zaplanowane zadanie Check the CI run, jednorazowo, 19 lis 22:13")
  }
}
