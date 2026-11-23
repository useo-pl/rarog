import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Okres łaski przed kartą „dialog w terminalu”: stan „czeka” przychodzi strumieniem
// globalnym przed kartą z treścią (kanał hooka mediana 614 ms, ścieżka drivera ok. 1,3 s), więc przez
// `DecisionGraceTiming.window` zamiast karty zapasowej stoi zastępnik bez przycisków. Właściciel: karty.

private enum G {
  /// Chwila, w której apka odebrała przejście w „czeka”.
  static let entered = Date(timeIntervalSince1970: 1_790_000_000)

  static func iso(_ date: Date) -> String { ISOTime.string(date) }

  /// Sesja `s1` pracuje (lista i pełny transkrypt bez kart), potem przejście w „czeka na zgodę” odebrane w `entered`.
  static func waiting(_ kind: String = "waiting-permission") throws -> AppState {
    var state = AppState(clientBuild: 1)
    let before = entered.addingTimeInterval(-60)
    state.apply(.frame(try Frames.snapshot([Frames.summary("s1", state: "running", stateSince: iso(before))]),
                       source: .global, cursor: nil), now: before)
    state.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: before)
    state.apply(.frame(try Frames.state("s1", kind, since: iso(entered)), source: .global, cursor: nil), now: entered)
    return state
  }

  static func at(_ seconds: TimeInterval) -> Date { entered.addingTimeInterval(seconds) }
}

@Suite("okres łaski przed kartą „dialog w terminalu”")
struct DecisionGraceTests {
  @Test("przejście w „czeka” bez karty: zastępnik do 2,0 s, bez karty zapasowej i bez zatwierdzenia")
  func graceWindow() throws {
    let state = try G.waiting()
    #expect(state.decisionLoading(for: "s1", now: G.at(0)))
    #expect(!state.herdrDialogShown(for: "s1", now: G.at(0)))
    #expect(state.dialogAllowId(for: "s1", now: G.at(0)) == nil)
    #expect(state.herdrDialogSignature(for: "s1", now: G.at(0)) == nil)
    #expect(state.decisionGraceEnds(for: "s1", now: G.at(0)) == G.at(DecisionGraceTiming.window))
    #expect(state.decisionLoading(for: "s1", now: G.at(1.9)))
    #expect(!state.herdrDialogShown(for: "s1", now: G.at(1.9)))
    #expect(!state.decisionLoading(for: "s1", now: G.at(2.0)))
    #expect(state.herdrDialogShown(for: "s1", now: G.at(2.0)))
    #expect(state.decisionGraceEnds(for: "s1", now: G.at(2.0)) == nil)
  }

  @Test("pytanie też: okres łaski przy „czeka na odpowiedź”")
  func question() throws {
    let state = try G.waiting("waiting-question")
    #expect(state.decisionLoading(for: "s1", now: G.at(0.5)))
    #expect(state.herdrDialogShown(for: "s1", now: G.at(2.5)))
  }

  @Test("karta zgody przy 0,6 s: karta zgody, bez zastępnika i bez karty zapasowej")
  func permissionArrives() throws {
    var state = try G.waiting()
    let pending = try Frames.decode(#"{"type":"permission-pending","request":\#(Frames.permission("s1", permId: "p1"))}"#)
    state.apply(.frame(pending, source: .session("s1"), cursor: nil), now: G.at(0.6))
    #expect(!state.decisionLoading(for: "s1", now: G.at(0.6)))
    #expect(!state.herdrDialogShown(for: "s1", now: G.at(0.6)))
    #expect(!state.herdrDialogShown(for: "s1", now: G.at(3)))
  }

  @Test("pola oceny drivera przy 0,8 s: karta zapasowa od razu", arguments: [
    #","herdrDialogReason":"no-digit""#, #","herdrDialog":"trust""#, #","herdrDialogScreen":"? Do you trust""#,
    #","cliDialog":"permission""#,
  ])
  func driverFields(_ extra: String) throws {
    var state = try G.waiting()
    let changed = try Frames.sessionChanged(
      Frames.summary("s1", state: "waiting-permission", stateSince: G.iso(G.entered), extra: extra))
    state.apply(.frame(changed, source: .global, cursor: nil), now: G.at(0.8))
    #expect(!state.decisionLoading(for: "s1", now: G.at(0.8)))
    #expect(state.herdrDialogShown(for: "s1", now: G.at(0.8)))
    #expect(state.decisionGraceEnds(for: "s1", now: G.at(0.8)) == nil)
  }

  @Test("pusty wycinek ekranu oceną nie jest — jak na karcie (blok bez treści nie staje)")
  func emptyScreenIsNoEvaluation() throws {
    var state = try G.waiting()
    state.sessions["s1"]?.herdrDialogScreen = ""
    #expect(state.decisionLoading(for: "s1", now: G.at(0.8)))
  }

  @Test("sesja zastana z migawki: `stateSince` sprzed 10 s → karta zapasowa od razu; sprzed 0,5 s → reszta okresu")
  func snapshotSession() throws {
    let now = G.at(0)
    var old = AppState(clientBuild: 1)
    old.apply(.frame(try Frames.snapshot([
      Frames.summary("s1", state: "waiting-permission", stateSince: G.iso(now.addingTimeInterval(-10))),
    ]), source: .global, cursor: nil), now: now)
    old.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(!old.decisionLoading(for: "s1", now: now))
    #expect(old.herdrDialogShown(for: "s1", now: now))

    var fresh = AppState(clientBuild: 1)
    fresh.apply(.frame(try Frames.snapshot([
      Frames.summary("s1", state: "waiting-permission", stateSince: G.iso(now.addingTimeInterval(-0.5))),
    ]), source: .global, cursor: nil), now: now)
    fresh.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(fresh.decisionLoading(for: "s1", now: now))
    #expect(fresh.decisionGraceEnds(for: "s1", now: now) == now.addingTimeInterval(1.5))
    #expect(fresh.herdrDialogShown(for: "s1", now: now.addingTimeInterval(1.5)))
  }

  @Test("niepewny czas wejścia (`stateSince` w przyszłości, nieczytelny, stan spoza reduktora) → bez okresu łaski",
        arguments: ["future", "garbage", "direct"])
  func uncertainStart(_ variant: String) throws {
    let now = G.at(0)
    var state = AppState(clientBuild: 1)
    let since = variant == "future" ? G.iso(now.addingTimeInterval(1)) : variant == "garbage" ? "wczoraj" : G.iso(now)
    let summary = Frames.summary("s1", state: "waiting-permission", stateSince: since)
    if variant == "direct" {
      // Stan złożony z pominięciem reduktora (testy, pamięć podręczna): czasu wejścia nie znamy.
      guard case let .sessionsSnapshot(snapshot) = try Frames.snapshot([summary]) else { return }
      state.sessions["s1"] = snapshot.sessions[0]
    } else {
      state.apply(.frame(try Frames.snapshot([summary]), source: .global, cursor: nil), now: now)
    }
    state.apply(.frame(try Frames.transcript("s1"), source: .session("s1"), cursor: nil), now: now)
    #expect(!state.decisionLoading(for: "s1", now: now))
    #expect(state.herdrDialogShown(for: "s1", now: now))
  }

  @Test("cofnięty zegar (teraz przed wejściem) → bez okresu łaski")
  func clockBackwards() throws {
    let state = try G.waiting()
    #expect(!state.decisionLoading(for: "s1", now: G.at(-1)))
    #expect(state.herdrDialogShown(for: "s1", now: G.at(-1)))
  }

  @Test("wyjście z „czeka” w okresie łaski → nic: ani zastępnika, ani karty, czas wejścia zapomniany")
  func leaveDuringGrace() throws {
    var state = try G.waiting()
    state.apply(.frame(try Frames.state("s1", "running", since: G.iso(G.at(1))), source: .global, cursor: nil), now: G.at(1))
    #expect(!state.decisionLoading(for: "s1", now: G.at(1)))
    #expect(!state.herdrDialogShown(for: "s1", now: G.at(1)))
    #expect(state.cards.decisionWaits["s1"] == nil)
  }

  @Test("powtórzony stan i pełny stan z tym samym `stateSince` nie przesuwają czasu wejścia; nowe czekanie — tak")
  func sameWaitKeepsStart() throws {
    var state = try G.waiting()
    state.apply(.frame(try Frames.state("s1", "waiting-permission", since: G.iso(G.entered)), source: .global, cursor: nil),
                now: G.at(1))
    state.apply(.frame(try Frames.snapshot([
      Frames.summary("s1", state: "waiting-permission", stateSince: G.iso(G.entered)),
    ]), source: .global, cursor: nil), now: G.at(1.5))
    #expect(state.cards.decisionWaits["s1"]?.at == G.entered)
    #expect(!state.decisionLoading(for: "s1", now: G.at(2)))
    // Pytanie po zgodzie: nowe czekanie, nowy okres łaski od chwili odbioru.
    state.apply(.frame(try Frames.state("s1", "waiting-question", since: G.iso(G.at(5))), source: .global, cursor: nil),
                now: G.at(5.2))
    #expect(state.cards.decisionWaits["s1"]?.at == G.at(5.2))
    #expect(state.decisionLoading(for: "s1", now: G.at(7.1)))
    #expect(!state.decisionLoading(for: "s1", now: G.at(7.2)))
  }

  @Test("wylogowanie kasuje czasy wejścia")
  func logoutClears() throws {
    var state = try G.waiting()
    state.apply(.loggedOut(.deviceUnknown), now: G.at(1))
    #expect(state.cards.decisionWaits.isEmpty)
  }
}
