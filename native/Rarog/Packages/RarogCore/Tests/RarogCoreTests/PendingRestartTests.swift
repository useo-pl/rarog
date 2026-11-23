import Foundation
import RarogContract
@testable import RarogCore
import Testing

// A restart in progress as the list shows it: the newer-CLI pill hides from the tap until the card shows the end.
// Owner: header.

@Suite("restart in progress")
struct PendingRestartTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)
  private let update = #","cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#

  private func card(_ state: String, update: Bool = false, detail: String? = nil) -> String {
    let detailField = detail.map { #","stateDetail":"x","stateDetailRef":{"code":"\#($0)"}"# } ?? ""
    return Frames.summary("s1", state: state, extra: (update ? self.update : "") + detailField)
  }

  /// A session with a newer CLI whose restart the server accepted at `t0`.
  private func accepted() throws -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.frame(try Frames.snapshot([card("waiting-input", update: true)]), source: .global, cursor: nil), now: t0)
    state.apply(.session(.restartStarted(sessionId: "s1", until: t0.addingTimeInterval(90))), now: t0)
    state.apply(.session(.restartFinished(sessionId: "s1")), now: t0)
    return state
  }

  @discardableResult
  private func frame(_ state: inout AppState, _ summary: String, at seconds: TimeInterval) throws -> [CoreEffect] {
    state.apply(.frame(try Frames.sessionChanged(summary), source: .global, cursor: nil), now: t0.addingTimeInterval(seconds))
  }

  @Test("success: in progress through exit, the card without a process, the start and a stale cliUpdate on the live card")
  func success() throws {
    var state = try accepted()
    #expect(state.restartInProgress("s1"), "from the tap, after the reply")
    try frame(&state, card("waiting-input", update: true, detail: "restart.exiting.version"), at: 1)
    try frame(&state, card("resumable", detail: "restart.launching.version"), at: 3)
    try frame(&state, card("starting", update: true), at: 4)
    #expect(state.restartInProgress("s1"), "the new process still starting")
    let effects = try frame(&state, card("waiting-input", update: true), at: 6)
    #expect(state.restartInProgress("s1"), "the server has not read the new version yet")
    #expect(effects.contains(.scheduleRestartGrace(sessionId: "s1", settledAt: t0.addingTimeInterval(6))))
    try frame(&state, card("waiting-input"), at: 6.5)
    #expect(!state.restartInProgress("s1"))
    #expect(state.sessionControls.pendingRestarts.isEmpty)
  }

  @Test("a canceled or failed restart ends at once, before or after the exit")
  func failure() throws {
    for (code, cardState) in [("restart.exit-timeout", "waiting-input"), ("restart.failed.panel-gone", "resumable")] {
      var state = try accepted()
      try frame(&state, card(cardState, update: cardState != "resumable", detail: code), at: 12)
      #expect(!state.restartInProgress("s1"), "\(code)")
    }
  }

  @Test("a failure sentence left from an earlier restart does not end the new one until it shows progress")
  func earlierFailure() throws {
    var state = AppState(clientBuild: 1)
    let left = card("waiting-input", update: true, detail: "restart.exit-timeout")
    state.apply(.frame(try Frames.snapshot([left]), source: .global, cursor: nil), now: t0)
    state.apply(.session(.restartStarted(sessionId: "s1", until: t0.addingTimeInterval(90))), now: t0)
    state.apply(.session(.restartFinished(sessionId: "s1")), now: t0)
    try frame(&state, left, at: 0.5)
    #expect(state.restartInProgress("s1"), "the sentence of the earlier restart")
    try frame(&state, card("waiting-input", update: true, detail: "restart.exiting"), at: 1)
    try frame(&state, left, at: 12)
    #expect(!state.restartInProgress("s1"), "this restart timed out as well")
  }

  @Test("the update did not apply: the grace after the live card ends the restart; an older grace does not")
  func notApplied() throws {
    var state = try accepted()
    try frame(&state, card("resumable", detail: "restart.launching"), at: 3)
    try frame(&state, card("waiting-input", update: true), at: 6)
    state.apply(.session(.restartGraceEnded(sessionId: "s1", settledAt: t0.addingTimeInterval(2))), now: t0.addingTimeInterval(11))
    #expect(state.restartInProgress("s1"), "a grace of another settle")
    state.apply(.session(.restartGraceEnded(sessionId: "s1", settledAt: t0.addingTimeInterval(6))), now: t0.addingTimeInterval(11))
    #expect(!state.restartInProgress("s1"))
  }

  @Test("before the relaunch a live card with cliUpdate stays in progress; a card missing from the list is left to the limit")
  func waitsForEvidence() throws {
    var state = try accepted()
    #expect(try frame(&state, card("waiting-input", update: true), at: 2).isEmpty)
    #expect(state.restartInProgress("s1"), "the old process has not exited yet")
    state.apply(.frame(try Frames.snapshot([]), source: .global, cursor: nil), now: t0.addingTimeInterval(4))
    #expect(state.restartInProgress("s1"), "the server rebuilds the card")
    state.apply(.session(.restartExpired(sessionId: "s1", until: t0.addingTimeInterval(30))), now: t0.addingTimeInterval(30))
    #expect(state.restartInProgress("s1"), "the limit of another restart")
    state.apply(.session(.restartExpired(sessionId: "s1", until: t0.addingTimeInterval(90))), now: t0.addingTimeInterval(90))
    #expect(!state.restartInProgress("s1"))
  }

  @Test("a refused request ends the restart at once")
  func refused() throws {
    var state = try accepted()
    state.apply(.session(.restartRefused(sessionId: "s1", uncertain: false)), now: t0)
    #expect(!state.restartInProgress("s1"))
  }

  @Test("a lost reply ends the restart only when the list showed no progress yet")
  func lostReply() throws {
    var quiet = try accepted()
    quiet.apply(.session(.restartRefused(sessionId: "s1", uncertain: true)), now: t0)
    #expect(!quiet.restartInProgress("s1"), "nothing says the server got the request")
    var exiting = try accepted()
    try frame(&exiting, card("waiting-input", update: true, detail: "restart.exiting"), at: 1)
    exiting.apply(.session(.restartRefused(sessionId: "s1", uncertain: true)), now: t0.addingTimeInterval(2))
    #expect(exiting.restartInProgress("s1"), "the server is exiting the old process")
  }

  @Test("missed phases: a snapshot with a new pane counts as the relaunch")
  func missedPhases() throws {
    var state = AppState(clientBuild: 1)
    let before = Frames.summary("s1", state: "waiting-input", extra: update + #","paneId":"p-1""#)
    state.apply(.frame(try Frames.snapshot([before]), source: .global, cursor: nil), now: t0)
    state.apply(.session(.restartStarted(sessionId: "s1", until: t0.addingTimeInterval(90))), now: t0)
    state.apply(.session(.restartFinished(sessionId: "s1")), now: t0)
    let after = Frames.summary("s1", state: "waiting-input", extra: #","paneId":"p-2""#)
    state.apply(.frame(try Frames.snapshot([after]), source: .global, cursor: nil), now: t0.addingTimeInterval(40))
    #expect(!state.restartInProgress("s1"))
  }
}
