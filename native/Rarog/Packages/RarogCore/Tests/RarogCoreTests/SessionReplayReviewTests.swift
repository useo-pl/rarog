import Foundation
import RarogContract
@testable import RarogCore
import Testing

@Suite("dwa SSE: starszy replay sesji nie cofa świeżej karty globalnej")
struct SessionReplayReviewTests {
  private let newer = "2026-10-03T10:00:00.000Z"
  private let older = "2026-10-03T09:00:00.000Z"

  private func freshState(_ current: String = "running") throws -> AppState {
    var state = AppState(clientBuild: 7)
    state.apply(.loggedIn, now: Date())
    state.apply(.streamOpened(.global, resumedWithCursor: false), now: Date())
    play(&state, [try Frames.snapshot([Frames.summary("s1", state: current, stateSince: newer)])])
    play(&state, [try Frames.activity("s1", kind: "thinking")])
    return state
  }

  @Test("state i session-changed z ogona nie cofają running do wcześniejszego wyniku", arguments: [false, true])
  func replayDoesNotRewindCard(summary: Bool) throws {
    var state = try freshState()
    let replay = try summary
      ? Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", stateSince: older))
      : Frames.state("s1", "waiting-input", since: older)
    play(&state, [replay], source: .session("s1"))
    #expect(state.sessions["s1"]?.state == .running)
    #expect(state.sessions["s1"]?.stateSince == newer)
    #expect(state.sessions["s1"]?.activity?.kind == .thinking, "stary wynik nie gasi bieżącej aktywności")
    #expect(state.seenTarget("s1") == nil, "replay nie oznacza wyniku jako obejrzanego")
  }

  @Test("import historii tego samego stanu może skorygować zegar wstecz")
  func sameStateHistoryCorrectsTimestamp() throws {
    var state = try freshState()
    play(&state, [try Frames.sessionChanged(Frames.summary("s1", state: "running", stateSince: older))])
    #expect(state.sessions["s1"]?.state == .running)
    #expect(state.sessions["s1"]?.stateSince == older)
  }

  @Test("replay przez dwie tury: korekta zegara tego samego stanu nie wpuszcza starszego przejścia")
  func replayAcrossTwoTurns() throws {
    let firstTurn = "2026-10-03T08:00:00.000Z"
    let pause = "2026-10-03T08:30:00.000Z"
    let later = "2026-10-03T11:00:00.000Z"
    var state = try freshState()
    play(&state, [try Frames.transcript("s1", activity: #"{"kind":"thinking"}"#)], source: .session("s1"))
    // Ring sesji po powrocie z tła: running (pierwsza tura) → waiting-input (druga), a bieżąca tura (trzecia) przyszła globalnie.
    play(&state, [
      try Frames.state("s1", "running", since: firstTurn),
      try Frames.sessionChanged(Frames.summary("s1", state: "running", stateSince: firstTurn)),
      try Frames.state("s1", "waiting-input", since: pause),
      try Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", stateSince: pause)),
    ], source: .session("s1"))
    #expect(state.sessions["s1"]?.state == .running, "stara pauza nie cofa bieżącej tury")
    #expect(state.transcripts["s1"]?.activity?.kind == .thinking, "stara pauza nie gasi aktywności")
    #expect(state.transcripts["s1"]?.joinedMidTurn == true, "znacznik „…” dołączenia zostaje")
    #expect(state.signal == nil, "replay nie daje dymka „skończył”")
    play(&state, [try Frames.state("s1", "waiting-input", since: later)], source: .session("s1"))
    #expect(state.sessions["s1"]?.state == .waitingInput, "prawdziwe nowe przejście przechodzi")
    #expect(state.signal?.kind == .done)
  }

  @Test("nowszy stan i równy timestamp nadal przechodzą", arguments: [false, true])
  func currentTransitionStillApplies(summary: Bool) throws {
    var state = try freshState()
    let incoming = try summary
      ? Frames.sessionChanged(Frames.summary("s1", state: "waiting-input", stateSince: newer))
      : Frames.state("s1", "waiting-input", since: newer)
    play(&state, [incoming], source: .session("s1"))
    #expect(state.sessions["s1"]?.state == .waitingInput)
    #expect(state.seenTarget("s1") == newer)
  }
}
