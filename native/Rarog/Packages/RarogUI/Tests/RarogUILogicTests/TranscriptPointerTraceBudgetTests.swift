import Foundation
@testable import RarogUI
import Testing

// The trace budget of the transcript's pointer selection: every press would otherwise write a line to `client.log`,
// so each touch kind is traced once per process and only the first few selection gestures are. The screen that feeds
// it: `TranscriptPointerSelectionTests` (UIKit). Owner: transcript.
@Suite("transcript pointer trace budget")
struct TranscriptPointerTraceBudgetTests {
  private static func gesture(listWon: Bool = true, frames: Int = 0) -> TranscriptPointerGestureTrace {
    TranscriptPointerGestureTrace(listWon: listWon, clicks: 1, autoscrollFrames: frames)
  }

  @Test("each touch kind is traced once, repeated presses add no line")
  func touchKindOnce() {
    var budget = TranscriptPointerTraceBudget()
    #expect(budget.touch(.indirectPointer) != nil)
    #expect(budget.touch(.indirectPointer) == nil)
    #expect(budget.touch(.direct) != nil, "another kind still gets its line")
    #expect(budget.touch(.direct) == nil)
  }

  @Test("selection gestures stop at the budget, and touch lines do not use it up")
  func gestureBudget() {
    var budget = TranscriptPointerTraceBudget()
    for kind in TranscriptTouchKind.allCases { _ = budget.touch(kind) }
    let traced = (0..<(TranscriptPointerTraceBudget.gestures + 2)).compactMap { budget.gesture(Self.gesture(frames: $0)) }
    #expect(traced.count == TranscriptPointerTraceBudget.gestures)
  }

  @Test("the line tells which recognizer took the drag")
  func lineNamesWinner() {
    #expect(Self.gesture(listWon: true).traceLine != Self.gesture(listWon: false).traceLine)
  }
}
