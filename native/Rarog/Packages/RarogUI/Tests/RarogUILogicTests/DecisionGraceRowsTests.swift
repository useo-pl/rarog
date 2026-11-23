import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Okres łaski przed kartą „dialog w terminalu” w wierszach transkryptu, w regule stopy i w śladzie `client.log`:
// przez `DecisionGraceTiming.window` od wejścia w „czeka” w miejscu karty zapasowej
// stoi zastępnik bez przycisków. Właściciel: karty.

enum Grace {
  /// Chwila, w której apka odebrała przejście w „czeka” (`Sample.now`).
  static let entered = Sample.now

  static func at(_ seconds: TimeInterval) -> Date { entered.addingTimeInterval(seconds) }

  static func frame(_ json: String) -> ServerEvent {
    // swiftlint:disable:next force_try
    try! EventDecoder.decode(Data(json.utf8)).get().event
  }

  /// Sesja `s1` pracuje z pełnym transkryptem bez kart, potem przejście w `kind` odebrane w `entered`.
  static func waiting(_ kind: String = "waiting-permission") -> AppState {
    var state = Sample.state(session: Sample.session(state: "running"))
    state.apply(.frame(frame(#"{"type":"state","sessionId":"s1","state":"\#(kind)","since":"\#(Sample.iso(0))"}"#),
                       source: .global, cursor: nil), now: entered)
    return state
  }

  /// Ocena drivera przyszła: podsumowanie sesji z powodem odmowy, w tym samym czekaniu.
  static func evaluated(_ state: inout AppState, at: Date) {
    let summary = #"""
      {"id":"s1","cwd":"/Users/demo/Projects/willow","title":"willow","state":"waiting-permission",
       "stateSince":"\#(Sample.iso(0))","createdAt":"\#(Sample.iso(600))","lastActivityAt":"\#(Sample.iso(0))",
       "herdrDialogReason":"no-digit"}
      """#
    state.apply(.frame(frame(#"{"type":"session-changed","session":\#(summary)}"#), source: .global, cursor: nil), now: at)
  }

  static func rows(_ state: AppState, at seconds: TimeInterval) -> [TranscriptRow] {
    TranscriptRows.build(state: state, sessionId: "s1", now: at(seconds))
  }

  static func hasPlaceholder(_ rows: [TranscriptRow]) -> Bool { rows.contains(.decisionPending) }

  static func hasFallback(_ rows: [TranscriptRow]) -> Bool {
    rows.contains { if case .herdrDialog = $0 { true } else { false } }
  }
}

@Suite("okres łaski: zastępnik zamiast karty zapasowej")
struct DecisionGraceRowsTests {
  @Test("przejście w „czeka” bez karty: t=0 i t=1,9 s zastępnik na dnie, t=2,0 s karta zapasowa")
  func window() {
    let state = Grace.waiting()
    for seconds in [0, 1.9] {
      let rows = Grace.rows(state, at: seconds)
      #expect(rows.last == .decisionPending, "t=\(seconds)")
      #expect(!Grace.hasFallback(rows), "t=\(seconds): bez karty zapasowej")
      #expect(HerdrDialogCards.make(state: state, sessionId: "s1", ui: nil, locked: nil, now: Grace.at(seconds)) == nil)
    }
    let after = Grace.rows(state, at: 2.0)
    #expect(!Grace.hasPlaceholder(after))
    guard case .herdrDialog? = after.last else {
      Issue.record("t=2,0 s: brak karty zapasowej")
      return
    }
  }

  @Test("karta zgody przy 0,6 s: karta zgody, bez zastępnika (także po terminie)")
  func permissionArrives() {
    var state = Grace.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    for seconds in [0.6, 2.5] {
      let rows = Grace.rows(state, at: seconds)
      #expect(!Grace.hasPlaceholder(rows) && !Grace.hasFallback(rows), "t=\(seconds)")
      guard case .permission? = rows.last else {
        Issue.record("t=\(seconds): brak karty zgody")
        return
      }
    }
  }

  @Test("pola oceny drivera przy 0,8 s: karta zapasowa od razu")
  func driverEvaluated() {
    var state = Grace.waiting()
    Grace.evaluated(&state, at: Grace.at(0.8))
    let rows = Grace.rows(state, at: 0.8)
    #expect(!Grace.hasPlaceholder(rows))
    #expect(Grace.hasFallback(rows))
  }

  @Test("sesja zastana (bez czasu wejścia z reduktora, `stateSince` sprzed 30 s) → karta zapasowa od razu")
  func foundSession() {
    let state = Sample.state(session: Sample.session(state: "waiting-permission"))
    let rows = TranscriptRows.build(state: state, sessionId: "s1", now: Sample.now)
    #expect(!Grace.hasPlaceholder(rows))
    #expect(Grace.hasFallback(rows))
  }

  @Test("wyjście z „czeka” w okresie łaski → ani zastępnika, ani karty")
  func leaveDuringGrace() {
    var state = Grace.waiting()
    state.apply(.frame(Grace.frame(#"{"type":"state","sessionId":"s1","state":"running","since":"\#(Sample.iso(-1))"}"#),
                       source: .global, cursor: nil), now: Grace.at(1))
    let rows = Grace.rows(state, at: 1)
    #expect(!Grace.hasPlaceholder(rows) && !Grace.hasFallback(rows))
  }

  @Test("potwierdzenie odpowiedzi na pytanie trzyma miejsce karty: zastępnika też nie ma")
  func heldQuestionHoldsPlace() {
    let state = Grace.waiting("waiting-question")
    var ui = TranscriptUIState()
    ui.questions.begin(QuestionCardModel.make(Sample.decode(QuestionRequest.self, #"""
      {"qId":"q1","sessionId":"s1","createdAt":"\#(Sample.iso(5))",
       "questions":[{"question":"Jak?","header":"Odbiór","multiSelect":false,"options":[{"label":"Tak"}]}]}
      """#)), answers: [["Tak"]])
    let rows = TranscriptRows.build(state: state, sessionId: "s1", ui: ui, now: Grace.at(0.5))
    #expect(!Grace.hasPlaceholder(rows))
  }

  @Test("stopa w okresie łaski: decyzja z pustą kolejką; po terminie karta zapasowa; pole odsyła do karty")
  func foot() {
    let state = Grace.waiting()
    #expect(FootContent.make(state: state, sessionId: "s1", ui: TranscriptUIState(), now: Grace.at(1)) == .decision(DecisionQueue()))
    let identity = HerdrDialogCards.identity(state.sessions["s1"]!)
    #expect(FootContent.make(state: state, sessionId: "s1", ui: TranscriptUIState(), now: Grace.at(2))
      == .decision(DecisionQueue([.herdrDialog(identity: identity)])))
    // Zdanie pod polem nie skacze „w terminalu” → „na karcie”: zastępnik stoi tam, gdzie stanie karta.
    #expect(ComposerModel.make(state: state, sessionId: "s1", now: Grace.at(1)).reason
      == ComposerModel.make(state: state, sessionId: "s1", now: Grace.at(2)).reason)
  }

  @Test("czytnik nie słyszy zastępnika; słyszy kartę, która go zastąpi")
  func speech() {
    let state = Grace.waiting()
    var speech = DecisionCardSpeech()
    #expect(speech.newCards(in: Grace.rows(state, at: 0)).isEmpty)
    #expect(speech.newCards(in: Grace.rows(state, at: 0.5)).isEmpty, "zastępnik nie jest kartą")
    #expect(speech.newCards(in: Grace.rows(state, at: 2)).count == 1, "karta zapasowa po terminie — ogłoszona")
  }
}

@Suite("ślad pierwszej karty po czekaniu bez karty (client.log)")
struct DecisionCardTraceTests {
  @Test("czekanie bez karty → karta zgody kanału po 614 ms: jedna linia z rodzajem i czasem; potem cisza")
  func hookCard() {
    var state = Grace.waiting()
    var trace = DecisionCardTrace()
    #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.1), now: Grace.at(0.1)) == nil)
    let hook = Sample.permission(permId: "k1", extra: #""channel":"\#(PermissionChannel.hook.rawValue)","state":"pending""#)
    state.transcripts["s1"]?.pendingPermissions = [hook]
    let first = trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.614), now: Grace.at(0.614))
    #expect(first == DecisionCardTrace.Arrival(kind: .permissionHook, milliseconds: 614, sessionId: "s1"))
    #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.7), now: Grace.at(0.7)) == nil)
    #expect(DiagnosticsTrace.decisionCard(first!) == "decyzja s1: pierwsza karta zgoda hook po 614 ms od czekania")
  }

  @Test("karta zalogowana znika, a to samo czekanie dostaje następną kartę: bez drugiej linii")
  func sameWaitOnce() {
    var state = Grace.waiting()
    var trace = DecisionCardTrace()
    _ = trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.1), now: Grace.at(0.1))
    let hook = Sample.permission(permId: "k1", extra: #""channel":"\#(PermissionChannel.hook.rawValue)","state":"pending""#)
    state.transcripts["s1"]?.pendingPermissions = [hook]
    #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.6), now: Grace.at(0.6)) != nil)
    state.transcripts["s1"]?.pendingPermissions = []
    _ = trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.8), now: Grace.at(0.8))
    #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 2.5), now: Grace.at(2.5)) == nil)
  }

  @Test("rodzaje kart: zgoda z ekranu i z jsonl, pytanie, karta zapasowa po okresie łaski")
  func kinds() {
    for (permId, kind) in [("screen:7", DecisionCardTrace.Kind.permissionScreen), ("toolu_01", .permissionJsonl)] {
      var state = Grace.waiting()
      var trace = DecisionCardTrace()
      _ = trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0), now: Grace.at(0))
      state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: permId)]
      #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 1.3), now: Grace.at(1.3))?.kind == kind)
    }
    var question = Grace.waiting("waiting-question")
    var trace = DecisionCardTrace()
    _ = trace.observe(state: question, sessionId: "s1", rows: Grace.rows(question, at: 0), now: Grace.at(0))
    question.transcripts["s1"]?.pendingQuestions = [Sample.decode(QuestionRequest.self, #"""
      {"qId":"q1","sessionId":"s1","createdAt":"\#(Sample.iso(5))",
       "questions":[{"question":"Jak?","header":"Odbiór","multiSelect":false,"options":[{"label":"Tak"}]}]}
      """#)]
    #expect(trace.observe(state: question, sessionId: "s1", rows: Grace.rows(question, at: 1), now: Grace.at(1))?.kind
      == .question)

    let fallback = Grace.waiting()
    var late = DecisionCardTrace()
    _ = late.observe(state: fallback, sessionId: "s1", rows: Grace.rows(fallback, at: 1), now: Grace.at(1))
    let arrival = late.observe(state: fallback, sessionId: "s1", rows: Grace.rows(fallback, at: 2.01), now: Grace.at(2.01))
    #expect(arrival == DecisionCardTrace.Arrival(kind: .fallbackDialog, milliseconds: 2010, sessionId: "s1"))
    #expect(DiagnosticsTrace.decisionCard(arrival!) == "decyzja s1: pierwsza karta dialog zapasowy po 2010 ms od czekania")
  }

  @Test("karta zastana przy wejściu na ekran albo przed pierwszą migawką transkryptu: bez linii")
  func foundCard() {
    var state = Grace.waiting()
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    var trace = DecisionCardTrace()
    #expect(trace.observe(state: state, sessionId: "s1", rows: Grace.rows(state, at: 0.5), now: Grace.at(0.5)) == nil)
    var loading = Grace.waiting()
    loading.transcripts["s1"]?.snapshots = 0
    var cold = DecisionCardTrace()
    #expect(cold.observe(state: loading, sessionId: "s1", rows: Grace.rows(loading, at: 0.2), now: Grace.at(0.2)) == nil)
    loading.transcripts["s1"]?.snapshots = 1
    loading.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    #expect(cold.observe(state: loading, sessionId: "s1", rows: Grace.rows(loading, at: 0.4), now: Grace.at(0.4)) == nil)
  }

  @Test("niepewny czas wejścia: linia bez liczby; identyfikator skrócony do końcówki")
  func unknownStart() {
    let line = DiagnosticsTrace.decisionCard(
      DecisionCardTrace.Arrival(kind: .permissionJsonl, milliseconds: nil, sessionId: "herdr-w1-p1"))
    #expect(line == "decyzja …-w1-p1: pierwsza karta zgoda jsonl, czas wejścia w czekanie nieznany")
  }
}
