import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The hold rule of the activity line: a shown line stays at least
// `minimumShow`, tool → thinking waits for `thinkingAfterTool` of continuous thinking, the hold returns the moment of
// its next wake-up, and an empty, offline, interrupt or start candidate passes at once. Times are relative to the
// rule's own constants, so the test pins the rule, not the numbers.

private let t0 = Sample.now

private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

/// A line of a running session at `now`: `json` is the activity (a missing one = a session working without it).
private func candidate(_ json: String?, now: Date = t0, downSince: Date? = nil, turn: TimeInterval = 300) -> ActivityRowLine {
  var view = TranscriptState()
  view.messages = [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))]
  view.snapshots = 1
  if let json {
    view.activity = Sample.decode(Activity.self, json)
    view.activityAt = now
  }
  let clocks = ActivityClocks(turn: t0.addingTimeInterval(-turn), tool: json == nil ? nil : now, silence: now)
  // swiftlint:disable:next force_unwrapping
  return ActivityRowLine.make(view: view, state: .running, clocks: clocks, now: now, downSince: downSince)!
}

private let toolA = #"{"kind":"tool","toolName":"Grep","summary":"alpha"}"#
private let toolB = #"{"kind":"tool","toolName":"Grep","summary":"beta"}"#
private let thinking = #"{"kind":"thinking"}"#

@Suite("activity line: hold rule")
struct ActivityLineHoldTests {
  private let show = ActivityLineHold.minimumShow
  private let settle = ActivityLineHold.thinkingAfterTool

  @Test("a shown line stays the minimum time; the hold names the moment it lets the next one in")
  func minimumShow() {
    var hold = ActivityLineHold()
    let first = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    #expect(first.line?.contentKey == candidate(toolA).contentKey && first.wakeAt == nil)
    let early = hold.resolve(candidate(toolB, now: at(show / 2)), sessionId: "s1", now: at(show / 2))
    #expect(early.line?.contentKey == candidate(toolA).contentKey, "A still stands")
    #expect(early.wakeAt == at(show))
    let due = hold.resolve(candidate(toolB, now: at(show)), sessionId: "s1", now: at(show))
    #expect(due.line?.contentKey == candidate(toolB).contentKey && due.wakeAt == nil)
  }

  @Test("a held line keeps ticking the turn clock of the newest candidate")
  func heldClock() {
    var hold = ActivityLineHold()
    _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    let later = candidate(toolB, now: at(show / 2), turn: 400)
    let held = hold.resolve(later, sessionId: "s1", now: at(show / 2))
    #expect(held.line?.label == candidate(toolA).label && held.line?.clockSeconds == later.clockSeconds)
  }

  @Test("tool → thinking only after continuous thinking; a tool in between starts the wait over")
  func toolToThinking() {
    var hold = ActivityLineHold()
    _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    let start = show + 1
    let first = hold.resolve(candidate(thinking, now: at(start)), sessionId: "s1", now: at(start))
    #expect(first.line?.kind == .tool && first.wakeAt == at(start + settle))
    let middle = hold.resolve(candidate(thinking, now: at(start + settle / 2)), sessionId: "s1", now: at(start + settle / 2))
    #expect(middle.line?.kind == .tool && middle.wakeAt == at(start + settle), "the wait counts from the first thinking")
    let back = hold.resolve(candidate(toolA, now: at(start + settle * 0.75)), sessionId: "s1", now: at(start + settle * 0.75))
    #expect(back.line?.kind == .tool && back.wakeAt == nil)
    let again = start + settle
    let second = hold.resolve(candidate(thinking, now: at(again)), sessionId: "s1", now: at(again))
    #expect(second.line?.kind == .tool && second.wakeAt == at(again + settle), "thinking was not continuous")
    let done = hold.resolve(candidate(thinking, now: at(again + settle)), sessionId: "s1", now: at(again + settle))
    #expect(done.line?.kind == .thinking && done.wakeAt == nil)
  }

  @Test("a new tool replaces a tool after the minimum time, without the thinking wait")
  func toolToTool() {
    var hold = ActivityLineHold()
    _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    let next = hold.resolve(candidate(toolB, now: at(show)), sessionId: "s1", now: at(show))
    #expect(next.line?.contentKey == candidate(toolB).contentKey)
  }

  @Test("empty, offline, interrupt and start candidates pass at once")
  func bypass() throws {
    var running = Sample.state(
      session: Sample.session(state: "running"), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))])
    running.sessionStream = .online
    running.apply(.turnControl(.interruptStarted(sessionId: "s1", at: t0)), now: t0)
    var starting = Sample.state(session: Sample.session(state: "starting"), messages: [])
    starting.sessionStream = .online
    let soon = at(show / 10)
    let cases: [(String, ActivityRowLine?)] = [
      ("empty", nil),
      ("offline", candidate(toolB, now: soon, downSince: t0)),
      ("interrupt", try #require(ActivityRowLine.make(state: running, sessionId: "s1", now: soon))),
      ("start", try #require(ActivityRowLine.make(state: starting, sessionId: "s1", now: soon))),
    ]
    for (name, next) in cases {
      var hold = ActivityLineHold()
      _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
      let outcome = hold.resolve(next, sessionId: "s1", now: soon)
      #expect(outcome.line == next && outcome.wakeAt == nil, "\(name)")
    }
  }

  @Test("a session switch resets the hold: the other session's line shows at once")
  func sessionSwitch() {
    var hold = ActivityLineHold()
    _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    let other = hold.resolve(candidate(toolB, now: at(show / 10)), sessionId: "s2", now: at(show / 10))
    #expect(other.line?.contentKey == candidate(toolB).contentKey && other.wakeAt == nil)
  }

  @Test("the same content again is not a change: it refreshes and does not wait")
  func sameContent() {
    var hold = ActivityLineHold()
    _ = hold.resolve(candidate(toolA), sessionId: "s1", now: t0)
    let same = hold.resolve(candidate(toolA, now: at(show / 10)), sessionId: "s1", now: at(show / 10))
    #expect(same.line == candidate(toolA, now: at(show / 10)) && same.wakeAt == nil)
  }
}
