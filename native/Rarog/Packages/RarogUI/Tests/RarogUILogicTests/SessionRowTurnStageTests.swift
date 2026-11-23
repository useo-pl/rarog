import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Linia etapu z pamięci tury: pod pracującym wierszem tylko delegacja i tło, a linia raz pokazana
// stoi do końca tury. Ramki idą przez reduktor rdzenia — ten sam, który widzi każdą ramkę na żywo.
// Właściciel: lista.

@Suite("wiersz listy: linia etapu lepka do końca tury")
struct SessionRowTurnStageTests {
  private func frame(_ json: String) -> ServerEvent { Sample.decode(ServerEvent.self, json) }

  private func summary(state: String = "running", since: String = "2026-10-08T08:00:00.000Z", extra: String = "") -> String {
    #"""
      {"id":"s1","cwd":"/Users/demo/Projects/willow","title":"willow","state":"\#(state)",
       "stateSince":"\#(since)","createdAt":"2026-10-08T07:00:00.000Z","lastActivityAt":"\#(since)"\#(extra)}
      """#
  }

  private func play(_ state: inout AppState, _ frames: [String]) {
    for json in frames { state.apply(.frame(frame(json), source: .global, cursor: nil), now: Sample.now) }
  }

  private func row(_ state: AppState) throws -> SessionRowModel {
    try #require(state.sessionRows.first { $0.id == "s1" })
  }

  private func activity(_ fields: String) -> String {
    #"{"type":"activity","sessionId":"s1",\#(fields)}"#
  }

  private let message = #"""
    {"type":"message","sessionId":"s1","message":{"seq":1,"role":"assistant",
     "blocks":[{"type":"text","text":"krok"}],"at":"2026-10-08T08:01:00.000Z"}}
    """#

  @Test("delegacja → zwykłe narzędzie → wiadomość → idle: linia z pamięci, bez liczników i bez kropki")
  func subagentSticks() throws {
    var state = AppState(clientBuild: 1)
    play(&state, [#"{"type":"sessions-snapshot","sessions":[\#(summary())]}"#])
    #expect(try row(state).stage == nil, "tura bez delegacji: bez linii")

    play(&state, [activity(#""kind":"tool","delegation":"agents","summary":"Przegląd","elapsedSeconds":4"#)])
    let live = try row(state)
    #expect(live.stage == "subagent: Przegląd" && live.backgroundDot, "żywy subagent: kropka")

    for step in [activity(#""kind":"tool","toolName":"Read","summary":"a.ts""#), message, activity(#""kind":"idle""#)] {
      play(&state, [step])
      let remembered = try row(state)
      #expect(remembered.stage == "subagent: Przegląd", "linia stoi: \(step)")
      #expect(!remembered.backgroundDot && remembered.progress == nil, "z pamięci bez kropki i paska")
    }

    play(&state, [#"{"type":"state","sessionId":"s1","state":"waiting-input","since":"2026-10-08T08:02:00.000Z"}"#])
    #expect(try row(state).stage == nil, "koniec tury kasuje linię")
  }

  @Test("workflow: na żywo liczniki i pasek, z pamięci sama nazwa")
  func workflowSticksWithoutCounters() throws {
    var state = AppState(clientBuild: 1)
    play(&state, [
      #"{"type":"sessions-snapshot","sessions":[\#(summary())]}"#,
      activity(#"""
        "kind":"tool","delegation":"workflow","workflow":"refaktor","agents":1,"agentsDone":2,
        "phases":[{"title":"A1","agents":2,"done":2},{"title":"A2","agents":1,"done":0}]
        """#),
    ])
    let live = try row(state)
    #expect(live.stage == "refaktor · faza 2/2 A2 · 1 agent · 2 skończyło" && live.progress != nil && !live.backgroundDot)
    play(&state, [message])
    let remembered = try row(state)
    #expect(remembered.stage == "workflow: refaktor")
    #expect(remembered.progress == nil && !remembered.backgroundDot)
  }

  @Test("zadanie w tle skończone w trakcie tury: linia zostaje (bez kropki), wysokość wiersza stoi")
  func backgroundEndsMidTurn() throws {
    var state = AppState(clientBuild: 1)
    let tasks = #","backgroundTasks":[{"id":"t1","kind":"command","command":"pnpm test"}]"#
    play(&state, [#"{"type":"sessions-snapshot","sessions":[\#(summary(extra: tasks))]}"#])
    let live = try row(state)
    #expect(live.stage == "w tle: komenda · pnpm test" && live.backgroundDot)
    // Żywe zadanie w tle wygrywa ze zwykłym narzędziem (dawniej linia mówiła „czyta plik").
    play(&state, [activity(#""kind":"tool","toolName":"Read","summary":"a.ts""#)])
    #expect(try row(state).stage == "w tle: komenda · pnpm test")
    play(&state, [#"{"type":"session-changed","session":\#(summary())}"#])
    let remembered = try row(state)
    #expect(remembered.stage == "w tle: komenda · pnpm test" && !remembered.backgroundDot)
  }

  @Test("zwykła tura (narzędzia, myślenie): linii nie ma ani razu")
  func plainTurnHasNoLine() throws {
    var state = AppState(clientBuild: 1)
    play(&state, [#"{"type":"sessions-snapshot","sessions":[\#(summary())]}"#])
    for step in [
      activity(#""kind":"thinking""#), activity(#""kind":"tool","toolName":"Grep","summary":"TODO""#), message,
      activity(#""kind":"tool","toolName":"Edit","summary":"a.ts""#), activity(#""kind":"waiting""#),
    ] {
      play(&state, [step])
      #expect(try row(state).stage == nil, "\(step)")
    }
  }

  @Test("pamięć z kilku zadań w tle: same rodzaje, bez liczby; subagent bez opisu: samo słowo")
  func rememberedForms() {
    let several = Sample.decode([BackgroundTask].self, #"""
      [{"id":"a","kind":"agent"},{"id":"b","kind":"command","command":"x"},{"id":"c","kind":"agent"}]
      """#)
    #expect(ActivityText.rememberedText(.background(several)) == "w tle: subagent, komenda")
    let bare = Sample.decode(Activity.self, #"{"kind":"tool","delegation":"agents"}"#)
    #expect(ActivityText.rememberedText(.delegation(bare, tasks: [])) == "subagent")
    let described = Sample.decode([BackgroundTask].self, #"[{"id":"a","kind":"agent","description":"Research"}]"#)
    #expect(ActivityText.rememberedText(.delegation(bare, tasks: described)) == "subagent: Research",
            "opis z zadania w tle, gdy puls go zgubił")
    let unnamed = Sample.decode(Activity.self, #"{"kind":"tool","delegation":"workflow","agents":3}"#)
    #expect(ActivityText.rememberedText(.delegation(unnamed, tasks: [])) == "workflow")
  }
}

@Suite("wiersz listy: odczyt wyniku nie przesuwa wiersza")
struct SessionRowHeldOrderTests {
  private func summary(_ id: String, created: String, extra: String = "") -> String {
    #"""
      {"id":"\#(id)","cwd":"/Users/demo/Projects/\#(id)","title":"\#(id)","state":"waiting-input",
       "stateSince":"2026-10-08T08:00:00.000Z","createdAt":"\#(created)","lastActivityAt":"2026-10-08T08:00:00.000Z"\#(extra)}
      """#
  }

  @Test("obejrzany wynik stoi wśród nieodebranych, ale z szarą kropką i wyciszony")
  func heldRowKeepsPlaceWithRealStyle() {
    var state = AppState(clientBuild: 1)
    for json in [
      #"{"type":"sessions-snapshot","sessions":[\#(summary("a", created: "2026-10-08T07:00:00.000Z")),\#(summary("b", created: "2026-10-08T07:30:00.000Z"))]}"#,
      #"{"type":"session-changed","session":\#(summary("a", created: "2026-10-08T07:00:00.000Z", extra: #","seen":true"#))}"#,
    ] {
      state.apply(.frame(Sample.decode(ServerEvent.self, json), source: .global, cursor: nil), now: Sample.now)
    }
    let rows = state.sessionRows
    #expect(rows.map(\.id) == ["a", "b"], "wiersz a nie zjeżdża pod b")
    #expect(rows[0].status.tone == .quiet && rows[0].quiet && rows[0].section == .idle, "styl z prawdziwej rangi")
    #expect(rows[1].status.tone == .unread && !rows[1].quiet)
  }
}
