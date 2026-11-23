import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Pamięć listy w rdzeniu: etap tury pod pracującym wierszem. Właściciel: lista.

private let at = Date(timeIntervalSince1970: 1_790_000_000)

private func activity(_ id: String, _ fields: String) throws -> ServerEvent {
  try Frames.decode(#"{"type":"activity","sessionId":"\#(id)",\#(fields)}"#)
}

private let subagent = #""kind":"tool","delegation":"agents","summary":"Przegląd","elapsedSeconds":3"#
private let command = #""backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test"}]"#

@Suite("pamięć listy: etap tury")
struct TurnStageMemoryTests {
  @Test("delegacja zostaje w pamięci przez zwykłe narzędzie, wiadomość i `idle`; licznik sekund nie")
  func delegationSurvivesTurnSteps() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")]), try activity("s1", subagent)], at: at)
    guard case let .delegation(wire, tasks) = try #require(state.turnStage["s1"]) else {
      Issue.record("oczekiwana delegacja")
      return
    }
    #expect(wire.delegation == .agents && wire.summary == "Przegląd" && tasks.isEmpty)
    #expect(wire.elapsedSeconds == nil, "pamięć trzyma fakt, nie tykający licznik")
    let remembered = state.turnStage["s1"]

    play(&state, [try activity("s1", #""kind":"tool","toolName":"Read","summary":"a.ts""#)], at: at)
    #expect(state.turnStage["s1"] == remembered, "zwykłe narzędzie etapem nie jest")
    play(&state, [try Frames.message("s1", seq: 1, text: "krok")], at: at)
    #expect(state.sessions["s1"]?.activity == nil, "wiadomość zeruje aktywność listy")
    #expect(state.turnStage["s1"] == remembered, "…ale nie pamięć tury")
    play(&state, [try Frames.activity("s1", kind: "idle"), try Frames.activity("s1", kind: "thinking")], at: at)
    #expect(state.turnStage["s1"] == remembered)
  }

  @Test("zadanie w tle skończone w trakcie tury: pamięć zostaje do jej końca")
  func backgroundEndsMidTurn() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1", extra: "," + command)])], at: at)
    guard case let .background(tasks) = try #require(state.turnStage["s1"]) else {
      Issue.record("oczekiwane zadania w tle")
      return
    }
    #expect(tasks.map(\.command) == ["pnpm test"])
    // Serwer zdejmuje `backgroundTasks` bez zmiany stanu (`manager.ts`): pamięć stoi.
    play(&state, [try Frames.sessionChanged(Frames.summary("s1"))], at: at)
    #expect(state.turnStage["s1"] == .background(tasks))
  }

  @Test("żywa delegacja wygrywa z zadaniami w tle w tej samej ramce; zadania z tej chwili idą razem z nią")
  func delegationBeatsBackground() throws {
    var state = AppState(clientBuild: 7)
    let both = #","activity":{\#(subagent)},"# + command
    play(&state, [try Frames.snapshot([Frames.summary("s1", extra: both)])], at: at)
    guard case let .delegation(_, tasks) = try #require(state.turnStage["s1"]) else {
      Issue.record("oczekiwana delegacja")
      return
    }
    #expect(tasks.count == 1)
  }

  @Test("decyzja w środku tury nie kasuje etapu; koniec tury (`state`, `session-changed`) kasuje")
  func turnEndClears() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")]), try activity("s1", subagent)], at: at)
    play(&state, [try Frames.state("s1", "waiting-permission", since: "2026-10-03T08:01:00.000Z")], at: at)
    #expect(state.turnStage["s1"] != nil, "zgoda w środku tury")
    play(&state, [try Frames.state("s1", "running", since: "2026-10-03T08:02:00.000Z")], at: at)
    #expect(state.turnStage["s1"] != nil)
    play(&state, [try Frames.state("s1", "waiting-input", since: "2026-10-03T08:03:00.000Z")], at: at)
    #expect(state.turnStage["s1"] == nil, "koniec tury")

    play(&state, [try Frames.sessionChanged(Frames.summary("s1", stateSince: "2026-10-03T08:04:00.000Z")),
                  try activity("s1", subagent)], at: at)
    #expect(state.turnStage["s1"] != nil)
    play(&state, [try Frames.sessionChanged(
      Frames.summary("s1", state: "interrupted", stateSince: "2026-10-03T08:05:00.000Z"))], at: at)
    #expect(state.turnStage["s1"] == nil, "przerwana tura")
  }

  @Test("pełny stan liczy pamięć od nowa: tura skończona i nowa ruszona w przerwie strumienia nie dziedziczy etapu")
  func snapshotRebuildsAcrossTurns() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1")]), try activity("s1", subagent)], at: at)
    #expect(state.turnStage["s1"] != nil)
    // Apka w tle: na Macu tura się kończy i rusza następna; powrót przynosi pełny stan — sesja pracuje, nowy
    // `stateSince`, bez delegacji i bez zadań w tle.
    play(&state, [try Frames.snapshot([Frames.summary("s1", stateSince: "2026-10-03T09:00:00.000Z")])], at: at)
    #expect(state.turnStage["s1"] == nil, "etap starej tury nie wisi pod nową")
    // Żywa delegacja i zadania w tle w pełnym stanie odbudowują pamięć od razu.
    let both = #","activity":{\#(subagent)},"# + command
    play(&state, [try Frames.snapshot([Frames.summary("s1", extra: both)])], at: at)
    #expect(state.turnStage["s1"] != nil)
  }

  @Test("po turze zadania w tle nie trafiają do pamięci (linia po turze idzie z żywych zadań)")
  func idleBackgroundNotRemembered() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1", state: "waiting-input", extra: "," + command)])], at: at)
    #expect(state.turnStage["s1"] == nil)
  }

  @Test("sesja spoza pełnego stanu i wylogowanie kasują pamięć")
  func removalAndLogout() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([Frames.summary("s1"), Frames.summary("s2")]),
                  try activity("s1", subagent), try activity("s2", subagent)], at: at)
    #expect(Set(state.turnStage.keys) == ["s1", "s2"])
    play(&state, [try Frames.snapshot([Frames.summary("s2")])], at: at)
    #expect(state.turnStage["s1"] == nil, "pełny stan bez s1")
    #expect(state.turnStage["s2"] == nil, "pełny stan liczy pamięć od nowa — s2 bez żywej delegacji w podsumowaniu")
    play(&state, [try activity("s2", subagent)], at: at)
    #expect(state.turnStage["s2"] != nil)
    play(&state, [try activity("s1", subagent)], at: at)
    #expect(state.turnStage["s1"] == nil, "aktywność nieznanej sesji nie zakłada pamięci")
    state.apply(.loggedOut(.deviceUnknown), now: at)
    #expect(state.turnStage.isEmpty)
  }
}

@Suite("pamięć listy: odczyt wyniku nie przesuwa wiersza")
struct HeldUnreadTests {
  private static let seen = #","seen":true"#

  private func summary(
    _ id: String, state: String = "waiting-input", created: String, since: String = "2026-10-03T08:00:00.000Z",
    extra: String = ""
  ) -> String {
    Frames.summary(id, state: state, createdAt: created, lastActivityAt: since, stateSince: since, extra: extra)
  }

  /// A i B nieodebrane, C pracuje, D obejrzana dawno.
  private func start() throws -> AppState {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.snapshot([
      summary("A", created: "2026-10-03T07:00:00.000Z"),
      summary("B", created: "2026-10-03T07:10:00.000Z"),
      summary("C", state: "running", created: "2026-10-03T07:20:00.000Z"),
      summary("D", created: "2026-10-03T06:00:00.000Z", extra: Self.seen),
    ])], at: at)
    return state
  }

  @Test("realne ramki: nieodebrany → `session-changed` z `seen` — kolejność stoi, styl idzie za prawdziwą rangą")
  func readKeepsPlace() throws {
    var state = try start()
    #expect(state.listOrder.map(\.id) == ["A", "B", "C", "D"])
    #expect(state.heldUnread == ["A": "2026-10-03T08:00:00.000Z", "B": "2026-10-03T08:00:00.000Z"],
            "obejrzana przed poznaniem nie jest trzymana")

    play(&state, [try Frames.sessionChanged(summary("A", created: "2026-10-03T07:00:00.000Z", extra: Self.seen))], at: at)
    #expect(state.listOrder.map(\.id) == ["A", "B", "C", "D"], "odczyt A nie przesuwa wiersza")
    #expect(state.sessions["A"]?.listRank == 3 && state.sessions["A"]?.statusTone == .quiet, "kropka i piętro prawdziwe")
    #expect(state.sortedSessions.map(\.id) == ["B", "C", "A", "D"], "prawdziwa ranga dla pamięci podręcznej")

    play(&state, [try Frames.sessionChanged(summary("B", created: "2026-10-03T07:10:00.000Z", extra: Self.seen))], at: at)
    #expect(state.listOrder.map(\.id) == ["A", "B", "C", "D"], "odczyt A, potem B — oba na miejscach")
  }

  @Test("zmiana stanu zwalnia wiersz; nowy wynik tej sesji trzyma się od nowa")
  func stateChangeReleases() throws {
    var state = try start()
    play(&state, [
      try Frames.sessionChanged(summary("A", created: "2026-10-03T07:00:00.000Z", extra: Self.seen)),
      try Frames.state("A", "running", since: "2026-10-03T09:00:00.000Z"),
    ], at: at)
    #expect(state.heldUnread["A"] == nil)
    #expect(state.listOrder.map(\.id) == ["B", "A", "C", "D"], "pracuje: ranga 2, remis po wieku")
    // Nowy wynik: serwer zdejmuje `seen` podsumowaniem (sama ramka `state` niesie stary znacznik).
    play(&state, [try Frames.sessionChanged(
      summary("A", created: "2026-10-03T07:00:00.000Z", since: "2026-10-03T09:10:00.000Z"))], at: at)
    #expect(state.heldUnread["A"] == "2026-10-03T09:10:00.000Z", "nowy wynik do odebrania")
    #expect(state.listOrder.map(\.id) == ["A", "B", "C", "D"])
  }

  @Test("pełny stan listy, tło apki i wylogowanie przestawiają obejrzane na miejsce rangi")
  func releases() throws {
    var state = try start()
    let read = try Frames.sessionChanged(summary("A", created: "2026-10-03T07:00:00.000Z", extra: Self.seen))
    play(&state, [read], at: at)
    state.apply(.list(.appBackgrounded), now: at)
    #expect(state.heldUnread.isEmpty)
    #expect(state.listOrder.map(\.id) == ["B", "C", "A", "D"], "tło: lista przestawia się, gdy nikt nie patrzy")

    state = try start()
    play(&state, [read, try Frames.snapshot([
      summary("A", created: "2026-10-03T07:00:00.000Z", extra: Self.seen),
      summary("B", created: "2026-10-03T07:10:00.000Z"),
    ])], at: at)
    #expect(state.heldUnread == ["B": "2026-10-03T08:00:00.000Z"], "pełny stan: obejrzana zwolniona, nieodebrana trzymana")
    #expect(state.listOrder.map(\.id) == ["B", "A"])

    state = try start()
    play(&state, [read], at: at)
    state.apply(.loggedOut(.deviceUnknown), now: at)
    #expect(state.heldUnread.isEmpty)
  }

  @Test("zadanie w tle i remisy: trzymany wiersz z pracą w tle stoi w randze 1, kilka trzymanych po wieku")
  func backgroundAndTies() throws {
    var state = AppState(clientBuild: 7)
    let tasks = #","backgroundTasks":[{"id":"t","kind":"command"}]"#
    play(&state, [try Frames.snapshot([
      summary("old", created: "2026-10-03T06:00:00.000Z"),
      summary("young", created: "2026-10-03T07:00:00.000Z"),
      summary("run", state: "running", created: "2026-10-03T05:00:00.000Z"),
    ])], at: at)
    play(&state, [
      try Frames.sessionChanged(summary("young", created: "2026-10-03T07:00:00.000Z", extra: Self.seen + tasks)),
      try Frames.sessionChanged(summary("old", created: "2026-10-03T06:00:00.000Z", extra: Self.seen)),
    ], at: at)
    #expect(state.sessions["young"]?.listRank == 2, "obejrzany z pracą w tle: prawdziwa ranga pracy")
    #expect(state.listOrder.map(\.id) == ["old", "young", "run"], "oba trzymane, remis po wieku")
    #expect(state.listOrder.map(state.listOrderRank) == [1, 1, 2])
  }
}

@MainActor
@Suite("magazyn: zejście w tło zwalnia obejrzane wyniki")
struct HeldUnreadStoreTests {
  @Test("`setScenePhase(.background)` przestawia listę, gdy nikt nie patrzy")
  func backgroundReleases() async throws {
    let (store, transport) = makeStore()
    await store.start()
    await until("online") { store.state.global == .online }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("A", state: "waiting-input"))]}"#)
    transport.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("A", state: "waiting-input", extra: #","seen":true"#))}"#)
    await until("obejrzane") { store.state.sessions["A"]?.seen == true }
    #expect(store.state.listOrderRank(try #require(store.state.sessions["A"])) == 1, "trzymany po odczycie")
    store.setScenePhase(.background)
    #expect(store.state.heldUnread.isEmpty)
    #expect(store.state.listOrderRank(try #require(store.state.sessions["A"])) == 3)
  }
}
