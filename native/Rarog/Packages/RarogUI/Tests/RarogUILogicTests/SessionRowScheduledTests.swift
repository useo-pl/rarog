import Foundation
import RarogContract
@testable import RarogUI
import Testing

// The scheduled-task mark at the end of a session row: a quiet clock when the session has armed crons
// (`SessionSummary.scheduledTasks`), with a tooltip and the VoiceOver part naming the count and the next run.

@Suite("session row: scheduled-task mark")
struct SessionRowScheduledTests {
  private let warsaw = TimeZone(identifier: "Europe/Warsaw")!
  private let pl = Locale(identifier: "pl_PL")
  /// 19 Nov 2026, 21:00 in Warsaw.
  private let now = ServerTime.parse("2026-11-19T20:00:00Z")!

  private func task(_ id: String, next: String? = nil, expires: String? = nil) -> String {
    let nextField = next.map { #","nextFireAt":"\#($0)""# } ?? ""
    let expiresField = expires.map { #","expiresAt":"\#($0)""# } ?? ""
    return #"{"id":"\#(id)","cron":"*/5 * * * *","recurring":true,"prompt":"Check CI"\#(nextField)\#(expiresField)}"#
  }

  private func row(_ tasks: [String]?) -> SessionRowModel {
    let extra = tasks.map { #""scheduledTasks":[\#($0.joined(separator: ","))]"# } ?? ""
    return SessionRowModel(Sample.session(state: "idle", extra: extra), ordinal: nil, showsProject: false)
  }

  @Test("no armed task, an empty list or only expired tasks: no mark")
  func noMark() {
    #expect(row(nil).scheduledMark(now: now) == nil)
    #expect(row([]).scheduledMark(now: now) == nil)
    #expect(row([task("a", expires: "2026-11-19T19:00:00Z")]).scheduledMark(now: now) == nil)
  }

  @Test("the mark counts visible tasks and takes the earliest future run")
  func countAndNext() {
    let mark = row([
      task("a", next: "2026-11-19T21:14:00Z"),
      task("b", next: "2026-11-19T20:30:00Z"),
      task("c", next: "2026-11-19T19:30:00Z"),
      task("d", expires: "2026-11-19T19:00:00Z"),
    ]).scheduledMark(now: now)
    #expect(mark?.count == 3, "the expired task is not counted")
    #expect(mark?.next == ServerTime.parse("2026-11-19T20:30:00Z"), "a past run is not the next one")
  }

  @Test("tooltip: count with Polish plural and the next run in the device zone")
  func tooltipPolish() {
    let two = row([task("a", next: "2026-11-19T21:14:00Z"), task("b")])
    #expect(two.scheduledText(now: now, separator: .dot, timeZone: warsaw, locale: pl, language: .pl)
      == "2 zaplanowane zadania · następne 22:14")
    let five = row(["a", "b", "c", "d", "e"].map { task($0) })
    #expect(five.scheduledText(now: now, separator: .dot, timeZone: warsaw, locale: pl, language: .pl)
      == "5 zaplanowanych zadań", "without a known future run the text is the count alone")
    let one = row([task("a")])
    #expect(one.scheduledText(now: now, separator: .dot, timeZone: warsaw, locale: pl, language: .en)
      == "1 scheduled task")
  }

  @Test("a frozen row's status clock stops, but the cron part follows the wall clock and drops an expired task")
  func frozenRowFollowsWallClock() {
    let extra = #""stale":true,"scheduledTasks":[\#(task("a", next: "2026-11-19T20:04:00Z", expires: "2026-11-19T20:10:00Z"))]"#
    let frozen = SessionRowModel(Sample.session(state: "idle", extra: extra), ordinal: nil, showsProject: false)
    let marked = frozen.scheduledText(now: now, separator: .comma) ?? ""
    #expect(frozen.spoken(now: now).hasSuffix(marked))
    let later = now.addingTimeInterval(11 * 60)
    #expect(frozen.scheduledText(now: later, separator: .comma) == nil)
    #expect(!frozen.spoken(now: now, scheduleNow: later).contains(marked), "expired at the wall clock")
  }

  @Test("VoiceOver reads the mark in the row sentence; a row without tasks does not mention it")
  func spoken() {
    let marked = row([task("a")])
    let text = marked.scheduledText(now: now, separator: .comma) ?? ""
    #expect(!text.isEmpty)
    #expect(marked.spoken(now: now).hasSuffix(text))
    #expect(!row(nil).spoken(now: now).contains(L("row.scheduledCount", 1)))
  }
}
