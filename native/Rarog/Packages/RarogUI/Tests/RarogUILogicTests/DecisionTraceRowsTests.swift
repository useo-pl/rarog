import Foundation
import RarogContract
@testable import RarogCore
@testable import RarogUI
import Testing

// Ślad własnej decyzji w transkrypcie: cichy wiersz bez przycisków na miejscu decyzji, pod treścią
// z chwili decyzji; nowe wiadomości przychodzą pod nim. Właściciel: karty.

private enum T {
  static let tool = Sample.message(
    seq: 2, role: "assistant",
    blocks: #"[{"type":"tool-call","toolName":"Shell","summary":"npm test","detail":"npm test","inputKind":"shell"}]"#)
  static let after = Sample.message(seq: 3, role: "assistant", blocks: Sample.text("Testy przeszły."))

  /// Sesja czeka na zgodę: prompt, krok narzędzia i karta `p1` (Shell · npm test).
  static func waiting(_ permission: PermissionRequest = Sample.permission()) -> AppState {
    var state = Sample.state(
      session: Sample.session(state: "waiting-permission"),
      messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("Puść testy")), tool])
    state.transcripts["s1"]?.pendingPermissions = [permission]
    return state
  }

  /// Decyzja z tego urządzenia i jej wynik; przy przyjętej serwer potem zdejmuje kartę i agent pisze dalej.
  static func decide(
    _ state: inout AppState, _ cardId: String = "p1", choice: String, answers: [[String]] = [],
    kind: CardNotice.Kind = .permission, result: DecisionResultKind = .accepted
  ) {
    state.apply(.decisionStarted(sessionId: "s1", cardId: cardId, choice: choice, answers: answers), now: Sample.now)
    state.apply(.decisionFinished(sessionId: "s1", cardId: cardId, kind: kind, result: result), now: Sample.now)
  }

  /// Serwer zdjął kartę, sesja pracuje dalej (bez karty „dialog w terminalu”), agent dopisuje `messages`.
  static func resolve(_ state: inout AppState, then messages: [TranscriptMessage] = [after]) {
    state.sessions["s1"] = Sample.session(state: "running")
    state.transcripts["s1"]?.pendingPermissions = []
    state.transcripts["s1"]?.pendingQuestions = []
    state.transcripts["s1"]?.messages += messages
  }

  static func traces(_ rows: [TranscriptRow]) -> [DecisionTraceRowModel] {
    rows.compactMap { if case let .decisionTrace(model) = $0 { model } else { nil } }
  }

  static func question(_ questions: String, custom: Bool = false) -> QuestionRequest {
    Sample.decode(QuestionRequest.self, #"""
      {"qId":"q1","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":\#(custom),"questions":\#(questions)}
      """#)
  }

  static let oneQuestion = #"""
    [{"question":"Którą bazę?","header":"Baza","multiSelect":false,"options":[
      {"label":"Postgres","role":"answer"},{"label":"SQLite","role":"answer"}]}]
    """#
  static let twoQuestions = #"""
    [{"question":"Którą bazę?","header":"Baza","multiSelect":false,"options":[{"label":"Postgres"},{"label":"SQLite"}]},
     {"question":"Które klienty?","header":"Klienci","multiSelect":true,"options":[{"label":"PWA"},{"label":"Swift"}]}]
    """#
}

@Suite("ślad decyzji w transkrypcie")
struct DecisionTraceRowsTests {
  @Test("zgoda przyjęta → „Zatwierdzono: narzędzie · komenda” pod krokiem z chwili decyzji, nowa wiadomość pod śladem")
  func allowedInPlace() {
    var state = T.waiting()
    T.decide(&state, choice: "allow")
    T.resolve(&state)
    let rows = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(T.traces(rows).map(\.text) == ["Zatwierdzono: Shell · npm test"])
    #expect(T.traces(rows).map(\.outcome) == [.allowed])
    let ids = rows.map(\.id)
    let trace = ids.firstIndex(of: "trace.p1")
    #expect(trace != nil && trace == ids.firstIndex(of: "m2.0").map { $0 + 1 }, "ślad tuż pod krokiem narzędzia: \(ids)")
    #expect(ids.last == "m3.0", "nowa wiadomość pod śladem: \(ids)")
    #expect(!rows.contains { if case .notice = $0 { true } else { false } }, "własna decyzja bez `CardNotice`")
  }

  @Test("odmowa → „Odrzucono: …”; plan → „Zatwierdzono: plan” bez treści planu; komenda skrócona do pierwszej linii")
  func deniedPlanAndLongCommand() {
    var denied = T.waiting()
    T.decide(&denied, choice: "deny")
    #expect(T.traces(TranscriptRows.build(state: denied, sessionId: "s1")).map(\.text) == ["Odrzucono: Shell · npm test"])
    #expect(T.traces(TranscriptRows.build(state: denied, sessionId: "s1")).map(\.outcome) == [.denied])

    var plan = T.waiting(Sample.permission(extra: #""subject":"plan""#))
    T.decide(&plan, choice: "allow-always")
    #expect(T.traces(TranscriptRows.build(state: plan, sessionId: "s1")).map(\.text) == ["Zatwierdzono: plan"])

    let long = "cd /Users/demo/Projects/willow && npm run test:integration -- --runInBand --coverage"
    var request = Sample.permission()
    request.displayText = long + "\nnpm run lint"
    var command = T.waiting(request)
    T.decide(&command, choice: "allow")
    let text = T.traces(TranscriptRows.build(state: command, sessionId: "s1")).first?.text ?? ""
    #expect(text.hasPrefix("Zatwierdzono: Shell · cd ") && text.hasSuffix("…"), "\(text)")
    #expect(!text.contains("\n") && !text.contains("lint"), "\(text)")
    #expect(text.count <= "Zatwierdzono: Shell · ".count + DecisionTraceText.limit + 1, "\(text)")

    // An empty command (the server passes `Bash` with `command: ""` as an empty `displayText`): the tool alone,
    // without a dangling separator.
    var bare = Sample.permission()
    bare.displayText = ""
    var empty = T.waiting(bare)
    T.decide(&empty, choice: "allow")
    #expect(T.traces(TranscriptRows.build(state: empty, sessionId: "s1")).map(\.text) == ["Zatwierdzono: Shell"])
  }

  @Test("odpowiedź: etykieta opcji; własna odpowiedź skrócona; kilka pytań w jednej linii, pytania po „·”")
  func answers() {
    var one = Sample.state(session: Sample.session(state: "waiting-question"), messages: [T.tool])
    one.transcripts["s1"]?.pendingQuestions = [T.question(T.oneQuestion)]
    T.decide(&one, "q1", choice: "Postgres", answers: [["Postgres"]], kind: .question)
    #expect(T.traces(TranscriptRows.build(state: one, sessionId: "s1")).map(\.text) == ["Odpowiedź: Postgres"])
    #expect(T.traces(TranscriptRows.build(state: one, sessionId: "s1")).map(\.outcome) == [.answered])

    let own = "Żadną z nich, bo dane mieszczą się w jednym pliku JSON, a migracje tylko by przeszkadzały w testach"
    var custom = Sample.state(session: Sample.session(state: "waiting-question"), messages: [T.tool])
    custom.transcripts["s1"]?.pendingQuestions = [T.question(T.oneQuestion, custom: true)]
    T.decide(&custom, "q1", choice: own, answers: [[own]], kind: .question)
    let text = T.traces(TranscriptRows.build(state: custom, sessionId: "s1")).first?.text ?? ""
    #expect(text.hasPrefix("Odpowiedź: Żadną z nich") && text.hasSuffix("…") && !text.contains("testach"), "\(text)")

    var many = Sample.state(session: Sample.session(state: "waiting-question"), messages: [T.tool])
    many.transcripts["s1"]?.pendingQuestions = [T.question(T.twoQuestions)]
    T.decide(&many, "q1", choice: "x", answers: [["Postgres"], ["PWA", "Swift"]], kind: .question)
    #expect(T.traces(TranscriptRows.build(state: many, sessionId: "s1")).map(\.text)
      == ["Odpowiedzi: Postgres · PWA, Swift"])
  }

  @Test("karta kanału zgód: bez drugiego wiersza, karta ze zdaniem stanu zostaje śladem jak dziś")
  func hookChannelCard() {
    let channel = #""channel":"\#(PermissionChannel.hook.rawValue)","state":"\#(ConsentCardState.sent.rawValue)""#
    var state = T.waiting(Sample.permission(extra: channel))
    T.decide(&state, choice: "allow")
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(T.traces(rows).isEmpty)
    let card = rows.compactMap { if case let .permission(card) = $0 { card } else { nil } }.first
    #expect(card?.hookChannel == true && card?.consentStatus != nil)
  }

  @Test("cudza decyzja (terminal, inne urządzenie) → `CardNotice` jak dziś, bez śladu decyzji")
  func foreignDecision() {
    var state = T.waiting()
    let resolved = Sample.decode(PermissionResolvedEvent.self, #"""
      {"sessionId":"s1","permId":"p1","decision":"allow","by":"iPad"}
      """#)
    state.apply(.frame(.permissionResolved(resolved), source: .session("s1"), cursor: nil), now: Sample.now)
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(T.traces(rows).isEmpty)
    #expect(rows.contains(.notice(id: "np1", text: UICopy.notice(.resolvedElsewhere(by: "iPad")))))
  }

  @Test("decyzja, która nie doszła (błąd, 409, 410) albo jeszcze leci → bez śladu")
  func notDelivered() {
    for result in [DecisionResultKind.keep, .conflict, .gone] {
      var state = T.waiting()
      T.decide(&state, choice: "allow", result: result)
      #expect(T.traces(TranscriptRows.build(state: state, sessionId: "s1")).isEmpty, "\(result)")
    }
    var flying = T.waiting()
    flying.apply(.decisionStarted(sessionId: "s1", cardId: "p1", choice: "allow"), now: Sample.now)
    #expect(T.traces(TranscriptRows.build(state: flying, sessionId: "s1")).isEmpty)
  }

  @Test("ślad przetrwa kolejne migawki transkryptu, nie dubluje się i nie gaśnie po 6 s")
  func survivesSnapshots() {
    var state = T.waiting()
    T.decide(&state, choice: "allow")
    T.resolve(&state)
    let later = Sample.message(seq: 4, role: "assistant", blocks: Sample.text("Gotowe."))
    for messages in [state.transcripts["s1"]?.messages ?? [], (state.transcripts["s1"]?.messages ?? []) + [later]] {
      state.transcripts["s1"]?.messages = messages
      state.transcripts["s1"]?.snapshots += 1
      let ids = TranscriptRows.build(state: state, sessionId: "s1").map(\.id)
      #expect(ids.filter { $0 == "trace.p1" }.count == 1, "\(ids)")
      #expect(ids.firstIndex(of: "trace.p1") == ids.firstIndex(of: "m2.0").map { $0 + 1 }, "\(ids)")
    }
    state.apply(.pruneNotices(olderThan: Sample.now.addingTimeInterval(3600)), now: Sample.now)
    #expect(T.traces(TranscriptRows.build(state: state, sessionId: "s1")).count == 1)
  }

  @Test("decyzja przy pustym transkrypcie: ślad pod zdaniem pustego transkryptu, potem nad pierwszą wiadomością")
  func emptyTranscript() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    T.decide(&state, choice: "allow")
    T.resolve(&state, then: [])
    var ids = TranscriptRows.build(state: state, sessionId: "s1").map(\.id)
    #expect(ids == ["empty", "trace.p1"])
    state.transcripts["s1"]?.messages = [T.after]
    ids = TranscriptRows.build(state: state, sessionId: "s1").map(\.id)
    #expect(ids == ["trace.p1", "m3.0"])
  }

  @Test("seria narzędzi przerywa się na śladzie: kroki sprzed decyzji nad śladem, nowe pod nim, rozwinięcie bez przetasowań")
  func toolRunBreaksAtTrace() {
    var state = T.waiting()
    T.decide(&state, choice: "allow")
    let steps = (3...5).map { seq in
      Sample.message(
        seq: seq, role: "assistant",
        blocks: #"[{"type":"tool-call","toolName":"Grep","summary":"krok \#(seq)"}]"#)
    }
    T.resolve(&state, then: steps)
    let rows = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "trace.p1", "r3", "m5.0"], "\(rows.map(\.id))")

    // Rozwinięcie liczy te same serie co wiersze (`TranscriptReading.prepare`): seria `r3` zostaje rozwinięta.
    var ui = TranscriptUIState()
    ui.reading.prepare(state.transcripts["s1"])
    ui.reading.toggleRun(3)
    ui.reading.prepare(state.transcripts["s1"])
    #expect(ui.reading.expandedRuns == [3])
    let open = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, calendar: Sample.calendar)
    #expect(open.map(\.id) == ["m1.0", "m2.0", "trace.p1", "m3.0", "m4.0", "r3", "m5.0"], "\(open.map(\.id))")
  }

  @Test("restart serwera numeruje transkrypt od nowa: ślad zostaje pod tą samą wiadomością, jeden")
  func serverRestart() {
    func message(_ seq: Int, _ role: String, ago: TimeInterval, _ blocks: String) -> TranscriptMessage {
      Sample.decode(
        TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(blocks),"at":"\#(Sample.iso(ago))"}"#)
    }
    func snapshot(_ messages: [TranscriptMessage]) -> CoreEvent {
      let list = String(decoding: try! JSONEncoder().encode(messages), as: UTF8.self)
      let event = Sample.decode(TranscriptSnapshotEvent.self, #"""
        {"sessionId":"s1","messages":\#(list),"pendingPermissions":[],"pendingQuestions":[]}
        """#)
      return .frame(.transcriptSnapshot(event), source: .session("s1"), cursor: nil)
    }
    let tool = #"[{"type":"tool-call","toolName":"Shell","summary":"npm test","inputKind":"shell"}]"#
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.serverStartId = "start-a"
    state.apply(snapshot([message(99, "user", ago: 60, Sample.text("Puść testy")), message(100, "assistant", ago: 50, tool)]),
      now: Sample.now)
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    T.decide(&state, choice: "allow")
    #expect(state.transcripts["s1"]?.decisionTraces.map(\.afterSeq) == [100])

    // Nowy proces serwera: ta sama rozmowa z pliku, numeracja od nowa, a agent dopisał dziesięć wiadomości.
    state.serverStartId = "start-b"
    state.sessions["s1"] = Sample.session(state: "running")
    let later = (21...30).map { message($0, "assistant", ago: 40 - Double($0 - 20), Sample.text("Krok \($0).")) }
    state.apply(snapshot([message(19, "user", ago: 60, Sample.text("Puść testy")), message(20, "assistant", ago: 50, tool)]
      + later), now: Sample.now)
    let ids = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar).map(\.id)
    #expect(ids.filter { $0 == "trace.p1" }.count == 1, "\(ids)")
    #expect(ids.firstIndex(of: "trace.p1") == ids.firstIndex(of: "m20.0").map { $0 + 1 }, "\(ids)")
    #expect(ids.last == "m30.0", "\(ids)")
  }
}
