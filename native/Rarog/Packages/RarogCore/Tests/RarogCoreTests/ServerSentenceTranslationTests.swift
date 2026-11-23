import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Testing

// Zdania serwera w rdzeniu (`docs/localization.md`, „Server sentences in the app”): każda ramka SSE z `*Ref`
// tłumaczy się raz, na wejściu do reduktora (strumień globalny, strumień sesji, replay po kursorze, historia
// i `transcript-snapshot` tą samą drogą). Renderer `pl` podany jawnie; `*Ref` zostają w stanie.

private let polish = ServerText.renderer(language: .pl)
private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

/// Ramki po tłumaczu, potem reduktor — ta sama kolejność co w magazynie.
private func playTranslated(
  _ state: inout AppState, _ frames: [ServerEvent], source: FrameSource = .global,
  render: SentenceRenderer = polish
) {
  for frame in frames {
    state.apply(.frame(frame.translated(render), source: source, cursor: nil), now: t0)
  }
}

private let herdrUnknown = #","stateDetail":"pane state not known yet","stateDetailRef":{"code":"state.herdr-unknown"}"#

@Suite("zdania serwera: ramki SSE tłumaczone na wejściu reduktora")
struct ServerSentenceTranslationTests {
  @Test("`sessions-snapshot` ze `stateDetailRef` `state.herdr-unknown` → polski `stateDetail`; `ref` zostaje")
  func snapshotStateDetail() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary("s1", state: "unknown", extra: herdrUnknown)])])
    #expect(state.sessions["s1"]?.stateDetail == "stan panelu jeszcze nieznany")
    #expect(state.sessions["s1"]?.stateDetailRef == SentenceRef(code: "state.herdr-unknown"))
  }

  @Test("`session-changed` bez `stateDetail` po stanie z `stateDetailRef` → oba `nil`")
  func sessionChangedClearsBoth() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary("s1", state: "unknown", extra: herdrUnknown)])])
    playTranslated(&state, [try Frames.sessionChanged(Frames.summary("s1", state: "running"))])
    #expect(state.sessions["s1"]?.stateDetail == nil)
    #expect(state.sessions["s1"]?.stateDetailRef == nil)
  }

  @Test("ramka `state` niesie `detailRef` do stanu; następna bez `detail` zeruje `stateDetail` i `stateDetailRef`")
  func stateEventCarriesAndClearsRef() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary("s1", state: "running")])])
    playTranslated(&state, [try Frames.decode(#"""
      {"type":"state","sessionId":"s1","state":"unknown","since":"2026-10-03T09:00:00.000Z",
      "detail":"pane state not known yet","detailRef":{"code":"state.herdr-unknown"}}
      """#)])
    #expect(state.sessions["s1"]?.stateDetail == "stan panelu jeszcze nieznany")
    #expect(state.sessions["s1"]?.stateDetailRef == SentenceRef(code: "state.herdr-unknown"))
    playTranslated(&state, [try Frames.state("s1", "running", since: "2026-10-03T09:01:00.000Z")])
    #expect(state.sessions["s1"]?.stateDetail == nil)
    #expect(state.sessions["s1"]?.stateDetailRef == nil)
  }

  @Test("limit planu: `stateDetail` z tokenu `resetAt=` po polsku, `args[0]` zostaje w `stateDetailRef`")
  func limitReachedKeepsArgs() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary("demo-willow", state: "running")])])
    playTranslated(&state, [try Frames.golden("state.max.json")])
    let session = try #require(state.sessions["demo-willow"])
    #expect(session.stateDetail?.hasPrefix("Limit planu — spróbuj po ") == true)
    #expect(session.stateDetailRef?.code == "state.limit-reached")
    #expect(session.stateDetailRef?.args == ["2026-10-03T11:00:21.400Z"])
  }

  @Test("`herdr-status` i `herdrStatus` startowy z `detailRef` → polski powód; `detailRef` zostaje")
  func herdrDetail() throws {
    var state = AppState(clientBuild: 7)
    let herdr = #"""
      ,"herdrStatus":{"available":true,"agentCount":14,"readOnly":false,"canLaunch":false,
      "detail":"Rarog pane limit reached. Close a session and try again.","detailRef":{"code":"herdr.pane-cap"}}
      """#
    playTranslated(&state, [try Frames.snapshot([], extra: herdr)])
    let polishCap = "Osiągnięty limit paneli Raroga — zamknij którąś sesję i spróbuj ponownie."
    #expect(state.herdr?.detail == polishCap)
    #expect(state.herdr?.detailRef == SentenceRef(code: "herdr.pane-cap"))

    var live = AppState(clientBuild: 7)
    playTranslated(&live, [try Frames.snapshot([])])
    playTranslated(&live, [try Frames.golden("herdr-status.pane-cap.json")])
    #expect(live.herdr?.detail == polishCap)
    #expect(live.herdr?.detailRef == SentenceRef(code: "herdr.pane-cap"))
  }

  @Test("`labelRef` `session.fallback-label` → `sesja N`; etykieta bez `labelRef` bez zmian")
  func fallbackLabel() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([
      Frames.summary("s3", label: "session 3", extra: #","labelRef":{"code":"session.fallback-label","args":["3"]}"#),
      Frames.summary("s4", label: "session 4"),
    ])])
    #expect(state.sessions["s3"]?.label == "sesja 3")
    #expect(state.sessions["s3"]?.labelRef == SentenceRef(code: "session.fallback-label", args: ["3"]))
    #expect(state.sessions["s4"]?.label == "session 4", "apka nie zgaduje po treści")

    var golden = AppState(clientBuild: 7)
    playTranslated(&golden, [try Frames.golden("sessions-snapshot.label-ref.json")])
    #expect(golden.sessions["herdr-w7-p14"]?.label == "sesja 2")
  }

  @Test("blok `text` z `ref` w `message` i `transcript-snapshot` → polski; blok agenta i narzędzie bez zmian")
  func transcriptBlocks() throws {
    var state = AppState(clientBuild: 7)
    let id = "herdr-w7-p14"
    playTranslated(&state, [try Frames.snapshot([Frames.summary(id)])])
    playTranslated(&state, [try Frames.golden("transcript-snapshot.refs.json")], source: .session(id))
    let snapshotBlocks = try #require(state.transcripts[id]?.messages.first?.blocks)
    #expect(snapshotBlocks.first == .text("[obraz]", ref: SentenceRef(code: "transcript.image-placeholder")))
    guard case let .toolCall(tool)? = snapshotBlocks.last else {
      Issue.record("brak bloku narzędzia")
      return
    }
    #expect(tool.detail?.hasSuffix("… (92 characters cut off)") == true, "stopkę narzędzia składa RarogUI")

    playTranslated(&state, [
      try Frames.golden("message.refs.json"),
      try Frames.message(id, seq: 5, text: "session 3 — tekst agenta"),
    ], source: .session(id))
    let messages = try #require(state.transcripts[id]?.messages)
    #expect(messages.first { $0.seq == 4 }?.blocks.first == .text("[obraz]", ref: SentenceRef(code: "transcript.image-placeholder")))
    #expect(messages.first { $0.seq == 5 }?.blocks == [.text("session 3 — tekst agenta", ref: nil)])
  }

  @Test("`permission-pending` z `displayTextRef` i `question-pending` z `questionRef` → polskie")
  func cards() throws {
    var state = AppState(clientBuild: 7)
    let id = "herdr-w7-p14"
    playTranslated(&state, [try Frames.snapshot([Frames.summary(id)])])
    playTranslated(&state, [try Frames.transcript(id)], source: .session(id))
    playTranslated(&state, [try Frames.decode(#"""
      {"type":"permission-pending","request":{"permId":"p1","sessionId":"\#(id)","toolName":"dialog",
      "displayText":"Rarog couldn't confirm what this dialog is about. From here you can only deny it. Allow it in the terminal.",
      "displayTextRef":{"code":"dialogs.degraded-display"},"risk":"normal","cwd":"/Users/demo/projekt",
      "createdAt":"2026-10-03T08:00:00.000Z"}}
      """#), try Frames.golden("question-pending.fallback.json")], source: .session(id))
    let view = try #require(state.transcripts[id])
    #expect(view.pendingPermissions.first?.displayText.hasPrefix("Rarog nie potwierdził, czego dotyczy ten dialog.") == true)
    #expect(view.pendingPermissions.first?.displayTextRef == SentenceRef(code: "dialogs.degraded-display"))
    #expect(view.pendingQuestions.first?.questions.first?.question == "Agent zadał pytanie w terminalu.")
  }

  @Test("karty w `transcript-snapshot` przechodzą tę samą drogę co ramki pojedyncze")
  func snapshotCards() throws {
    var state = AppState(clientBuild: 7)
    let id = "herdr-w7-p14"
    playTranslated(&state, [try Frames.snapshot([Frames.summary(id)])])
    playTranslated(&state, [try Frames.golden("transcript-snapshot.refs.json")], source: .session(id))
    let dialog = state.transcripts[id]?.pendingPermissions.first { $0.permId == "toolu_62" }
    #expect(dialog?.displayText.hasPrefix("Rarog nie potwierdził") == true)
  }

  @Test("kod nieznany apce → angielski tekst serwera bez zmian")
  func unknownCode() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary(
      "s1", state: "unknown", extra: #","stateDetail":"Something new.","stateDetailRef":{"code":"state.from-the-future"}"#)])])
    #expect(state.sessions["s1"]?.stateDetail == "Something new.")
    #expect(state.sessions["s1"]?.stateDetailRef?.code == "state.from-the-future")
  }

  @Test("tłumaczenie w innym języku z tych samych `*Ref` (po angielsku: tekst angielski)")
  func englishRenderer() throws {
    var state = AppState(clientBuild: 7)
    playTranslated(&state, [try Frames.snapshot([Frames.summary("s1", state: "unknown", extra: herdrUnknown)])],
                   render: ServerText.renderer(language: .en))
    #expect(state.sessions["s1"]?.stateDetail == "pane state not known yet")
  }
}

/// Magazyn z atrapą transportu i rendererem `pl` (jak `makeStore`, z jawnym tłumaczem).
@MainActor
private func translatingStore(render: @escaping SentenceRenderer = polish) -> (RarogStore, FakeTransport) {
  let transport = FakeTransport()
  let rules = MutationRules(timing: fastTiming)
  transport.gate = MutationGate(policy: rules)
  let store = RarogStore(
    transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming,
    renderer: render)
  return (store, transport)
}

extension ServerSentenceTranslationTests {
  @MainActor
  @Test("magazyn: strumień globalny, strumień sesji i replay po kursorze idą przez jego renderer")
  func storeTranslatesEveryStream() async throws {
    let (store, transport) = translatingStore()
    await store.start()
    await until("online") { store.state.global == .online }
    let id = "herdr-w7-p14"
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary(id, label: "session 3", extra: #","labelRef":{"code":"session.fallback-label","args":["3"]}"#))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    #expect(store.state.sessions[id]?.label == "sesja 3")

    store.openSession(id)
    await until("strumień sesji") { transport.streamCalls.contains { $0.scope == .session(id: id) } }
    try transport.pushGolden(.session(id: id), "transcript-snapshot.refs.json", id: "c1")
    await until("transkrypt") { store.state.transcripts[id]?.messages.isEmpty == false }
    #expect(store.state.transcripts[id]?.messages.first?.blocks.first == .text("[obraz]", ref: SentenceRef(code: "transcript.image-placeholder")))

    // Zerwanie i powrót z kursorem: replay serwera to te same ramki `message` — ta sama droga.
    transport.end(.session(id: id))
    await until("ponowienie z kursorem") {
      transport.streamCalls.last { $0.scope == .session(id: id) }?.lastEventId == "c1"
    }
    transport.push(.session(id: id), json: #"""
      {"type":"message","sessionId":"\#(id)","message":{"seq":9,"role":"system",
      "blocks":[{"type":"text","text":"[image]","ref":{"code":"transcript.image-placeholder"}}],"at":"2026-10-03T08:01:00.000Z"}}
      """#.replacingOccurrences(of: "\n", with: ""), id: "c2")
    await until("replay") { store.state.transcripts[id]?.messages.contains { $0.seq == 9 } == true }
    #expect(store.state.transcripts[id]?.messages.first { $0.seq == 9 }?.blocks.first == .text("[obraz]", ref: SentenceRef(code: "transcript.image-placeholder")))
  }
}
