import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The field card's activity band: open from the start of a turn to its end, closed
// while idle; a row that goes blank mid-turn does not close it.

@Suite("activity band of the field card")
struct ActivityBandTests {
  private func state(_ session: String, open: String? = nil) -> AppState {
    var state = Sample.state(
      session: Sample.session(state: session), messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("zrób"))],
      open: open)
    state.sessionStream = .online
    return state
  }

  private func band(_ state: AppState) -> Bool {
    let row = ActivityRowLine.make(state: state, sessionId: "s1", now: Sample.now)
    return ActivityBand.isOpen(rowHasContent: row != nil, session: state.sessions["s1"]?.state)
  }

  @Test("idle session with an empty row: no band")
  func idle() {
    for session in ["waiting-input", "done", "interrupted", "error", "resumable", "limit-reached"] {
      #expect(!band(state(session)), "\(session)")
    }
    #expect(!ActivityBand.isOpen(rowHasContent: false, session: nil), "unknown session")
  }

  @Test("a turn holds the band: working, starting, a decision inside the turn")
  func turn() {
    #expect(band(state("running")))
    #expect(band(state("starting")))
    #expect(ActivityBand.isOpen(rowHasContent: false, session: .waitingPermission))
    #expect(ActivityBand.isOpen(rowHasContent: false, session: .waitingQuestion))
  }

  @Test("the row goes blank mid-turn (a streaming answer has its own cursor): the band stays")
  func blankMidTurn() {
    let streaming = state("running", open: "piszę…")
    #expect(ActivityRowLine.make(state: streaming, sessionId: "s1", now: Sample.now) == nil, "the row is blank")
    #expect(band(streaming), "the band stays open")
  }

  @Test("a transient status opens the band outside a turn")
  func transient() {
    #expect(ActivityBand.isOpen(rowHasContent: true, session: .waitingInput))
    #expect(ActivityBand.isOpen(rowHasContent: true, session: nil))
  }
}
