import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Sygnał „inna sesja czegoś chce" — źródło dymka. Właściciel: łączność.

@Suite("sygnał o sesji dla dymka")
struct SignalTests {
  let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func listed(_ summaries: [String]) throws -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: now)
    state.apply(.frame(try Frames.snapshot(summaries), source: .global, cursor: nil), now: now)
    return state
  }

  private func play(_ state: inout AppState, _ frames: [ServerEvent]) {
    for frame in frames { state.apply(.frame(frame, source: .global, cursor: nil), now: now) }
  }

  @Test("wejście w zgodę: jeden sygnał niezależnie od kolejności `state` i `session-changed`")
  func orderIndependent() throws {
    var first = try listed([Frames.summary("s1", state: "running")])
    play(&first, [
      try Frames.state("s1", "waiting-permission", since: "2026-10-03T08:01:00.000Z"),
      try Frames.sessionChanged(Frames.summary("s1", state: "waiting-permission")),
    ])
    #expect(first.signal == SessionSignal(sessionId: "s1", kind: .permission, serial: 1))

    var second = try listed([Frames.summary("s1", state: "running")])
    play(&second, [
      try Frames.sessionChanged(Frames.summary("s1", state: "waiting-question")),
      try Frames.state("s1", "waiting-question", since: "2026-10-03T08:01:00.000Z"),
    ])
    #expect(second.signal == SessionSignal(sessionId: "s1", kind: .question, serial: 1))
  }

  @Test("„skończył” tylko po realnej pracy; błąd i limit zawsze; reszta milczy")
  func kinds() throws {
    var state = try listed([
      Frames.summary("run", state: "running"), Frames.summary("fresh", state: "starting"),
      Frames.summary("idle", state: "interrupted"), Frames.summary("err", state: "running"),
      Frames.summary("lim", state: "running"),
    ])
    play(&state, [try Frames.state("run", "waiting-input", since: "2026-10-03T08:01:00.000Z")])
    #expect(state.signal?.kind == .done && state.signal?.sessionId == "run")
    play(&state, [try Frames.state("fresh", "waiting-input", since: "2026-10-03T08:01:00.000Z")])
    #expect(state.signal?.sessionId == "fresh" && state.signal?.serial == 2, "start też jest pracą")
    play(&state, [try Frames.state("idle", "waiting-input", since: "2026-10-03T08:01:00.000Z")])
    #expect(state.signal?.serial == 2, "wznowienie przerwanej bez pracy to nie „skończył”")
    play(&state, [try Frames.state("err", "error", since: "2026-10-03T08:01:00.000Z")])
    #expect(state.signal?.kind == .error)
    play(&state, [try Frames.sessionChanged(Frames.summary("lim", state: "limit-reached"))])
    #expect(state.signal?.kind == .limit && state.signal?.serial == 4)
    play(&state, [try Frames.state("run", "running", since: "2026-10-03T08:02:00.000Z")])
    #expect(state.signal?.serial == 4, "ruszenie pracy nie jest sprawą do dymka")
  }

  @Test("nigdy przy pierwszym poznaniu sesji ani przy pełnym stanie listy; wylogowanie gasi")
  func firstSight() throws {
    var state = try listed([Frames.summary("s1", state: "running")])
    play(&state, [try Frames.sessionChanged(Frames.summary("nowa", state: "waiting-permission"))])
    #expect(state.signal == nil, "start z 17 panelami nie daje lawiny")
    play(&state, [try Frames.snapshot([Frames.summary("s1", state: "waiting-permission")])])
    #expect(state.signal == nil, "pełny stan po powrocie nie jest wejściem w stan")
    play(&state, [try Frames.state("s1", "waiting-permission", since: "2026-10-03T08:01:00.000Z")])
    #expect(state.signal == nil, "powtórzony stan to nie zdarzenie")
    play(&state, [try Frames.state("s1", "error", since: "2026-10-03T08:02:00.000Z")])
    #expect(state.signal != nil)
    state.apply(.loggedOut(.deviceUnknown), now: now)
    #expect(state.signal == nil)
  }
}
