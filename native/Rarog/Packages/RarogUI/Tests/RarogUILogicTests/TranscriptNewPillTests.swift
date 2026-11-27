import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Pigułka „N nowych wiadomości" nad linią „NOWE": liczba, odmiana, położenie
// linii i stan wizyty. Widok i przewijanie: `RarogUIKitTests/TranscriptNewMarkerTests`. Właściciel: transkrypt.

private enum Pill {
  static func message(_ seq: Int, _ role: String = "assistant", ago: TimeInterval, _ blocks: [String]) -> TranscriptMessage {
    Sample.decode(TranscriptMessage.self, #"""
      {"seq":\#(seq),"role":"\#(role)","blocks":[\#(blocks.joined(separator: ","))],"at":"\#(Sample.iso(ago))"}
      """#)
  }

  static func text(_ value: String) -> String {
    #"{"type":"text","text":\#(String(data: try! JSONEncoder().encode(value), encoding: .utf8)!)}"#
  }

  static let tool = #"{"type":"tool-call","toolName":"Grep","summary":"krok"}"#

  static func notice(_ seq: Int, ago: TimeInterval) -> TranscriptMessage {
    Sample.decode(TranscriptMessage.self, #"""
      {"seq":\#(seq),"role":"user","blocks":\#(Sample.text("wpis harnessu")),"at":"\#(Sample.iso(ago))",
       "notice":{"kind":"command","outcome":"done","name":"pnpm test","exitCode":0}}
      """#)
  }

  static func view(_ messages: [TranscriptMessage], snapshots: Int = 1) -> TranscriptState {
    var view = TranscriptState()
    view.messages = messages
    view.snapshots = snapshots
    return view
  }
}

@Suite("pigułka „N nowych wiadomości”")
struct TranscriptNewPillTests {
  @Test("liczba: bloki tekstu agenta od linii w dół; narzędzia, prompty, notki i pusty tekst się nie liczą")
  func countsAgentTextBlocks() {
    let messages = [
      Pill.message(1, ago: 500, [Pill.text("odpowiedź z przerwy")]),
      Pill.message(2, ago: 450, [Pill.tool]),
      Pill.message(3, "user", ago: 400, [Pill.text("prompt z terminala")]),
      Pill.notice(4, ago: 350),
      // Historia po restarcie serwera skleja turę: jedna wiadomość, trzy bloki tekstu przedzielone narzędziem.
      Pill.message(5, ago: 300, [Pill.text("a"), Pill.tool, Pill.text("b"), Pill.text("c"), Pill.text("  \n ")]),
      Pill.message(6, "system", ago: 250, [Pill.text("wynik przerwania")]),
    ]
    #expect(NewMarker.count(messages) == 4)
    #expect(NewMarker.count(messages[1...]) == 3, "od linii w dół, nie od początku")
    #expect(NewMarker.count([Pill.message(1, ago: 10, [Pill.tool]), Pill.notice(2, ago: 5)]) == 0)
    // Na żywo (urodzone od wejścia) się nie liczy — liczba mówi, ile ominęło przy wejściu albo powrocie.
    let entered = Sample.now.addingTimeInterval(-320)
    #expect(NewMarker.count(messages, bornBefore: entered) == 1)
  }

  @Test("odmiana: 1 nowa, 2–4 nowe (także 22–24), 12–14 i reszta nowych; czytnik słyszy, co zrobi tap")
  func polishPlural() {
    let cases: [(Int, String)] = [
      (1, "1 nowa wiadomość"), (2, "2 nowe wiadomości"), (4, "4 nowe wiadomości"), (5, "5 nowych wiadomości"),
      (12, "12 nowych wiadomości"), (13, "13 nowych wiadomości"), (14, "14 nowych wiadomości"),
      (21, "21 nowych wiadomości"), (22, "22 nowe wiadomości"), (25, "25 nowych wiadomości"),
      (112, "112 nowych wiadomości"),
    ]
    for (count, text) in cases { #expect(UICopy.newPill(count) == text) }
    #expect(UICopy.newPillSpoken(7) == "7 nowych wiadomości, przewiń do pierwszej")
  }

  @Test("linia względem ekranu: nad górną krawędzią, choćby częściowo na ekranie, pod dolną")
  func linePlace() {
    #expect(NewLinePlace.of(lineMinY: 70, lineMaxY: 100, top: 100, bottom: 900) == .above)
    #expect(NewLinePlace.of(lineMinY: 80, lineMaxY: 101, top: 100, bottom: 900) == .visible)
    #expect(NewLinePlace.of(lineMinY: 899, lineMaxY: 930, top: 100, bottom: 900) == .visible)
    #expect(NewLinePlace.of(lineMinY: 900, lineMaxY: 930, top: 100, bottom: 900) == .below)
  }

  @Test("stoi, póki linia nad ekranem; gaśnie do końca wizyty tylko pod gestem albo po tapie; nowa wizyta od nowa")
  func pillLifecycle() {
    let messages = [
      Pill.message(1, ago: 900, [Pill.text("przed przerwą")]),
      Pill.message(2, ago: 600, [Pill.text("pod nieobecność"), Pill.text("i dalej")]),
      Pill.message(3, ago: 500, [Pill.text("jeszcze")]),
    ]
    var decision = NewMarkerDecision(seenAt: messages[0].at)
    #expect(decision.pill(.above, gesture: false) == .hidden, "bez linii: bez pigułki")
    decision.settle(Pill.view(messages))
    #expect(decision.seq == 2 && decision.count == 3 && decision.fixed)
    #expect(decision.pill(nil, gesture: false) == .hidden, "linia wycięta przycięciem albo nie w liście: bez pigułki")
    #expect(decision.pill(.below, gesture: true) == .hidden, "czytelnik nad linią: bez pigułki, linia niewidziana")
    #expect(decision.pill(.above, gesture: false) == .shown(3), "zamrożona: od razu")
    // Linia przez chwilę na ekranie bez gestu (zejście na dno, powrót na miejsce, dogrywanie): pigułka zostaje.
    #expect(decision.pill(.visible, gesture: false) == .hidden && !decision.lineSeen)
    #expect(decision.pill(.above, gesture: false) == .shown(3), "przewinięcie z kodu nie odczytuje za człowieka")
    #expect(decision.pill(.visible, gesture: true) == .hidden && decision.lineSeen)
    #expect(decision.pill(.above, gesture: false) == .hidden, "gest doszedł do linii: pigułka nie wraca")

    var tapped = NewMarkerDecision(seenAt: messages[0].at)
    tapped.settle(Pill.view(messages))
    tapped.reachLine()
    #expect(tapped.pill(.above, gesture: false) == .hidden, "tap: w tej wizycie nie wraca")

    var next = NewMarkerDecision(seenAt: messages[0].at, snapshotsAtEntry: 1, enteredAt: Sample.now)
    next.settle(Pill.view(messages, snapshots: 2))
    #expect(next.pill(.above, gesture: false) == .shown(3), "nowa wizyta: nowa decyzja, pigułka od nowa")

    var notices = NewMarkerDecision(seenAt: messages[0].at)
    notices.settle(Pill.view([messages[0], Pill.notice(2, ago: 100)]))
    #expect(notices.seq == 2 && notices.pill(.above, gesture: false) == .hidden, "same notki: linia bez pigułki")
  }

  /// „×” na pigułce: linia i pigułka znikają do końca wizyty, także gdy decyzja jeszcze nie zamarzła —
  /// dogrywanie treści (powtórka, pełny stan) ich nie przywraca.
  @Test("„×”: linia i pigułka znikają do końca wizyty, dogrywanie ich nie przywraca")
  func dismissRetiresLineForVisit() {
    let messages = [
      Pill.message(1, ago: 900, [Pill.text("przed przerwą")]),
      Pill.message(2, ago: 600, [Pill.text("pod nieobecność")]),
    ]
    var decision = NewMarkerDecision(seenAt: messages[0].at, snapshotsAtEntry: 1)
    decision.settle(Pill.view(messages, snapshots: 1))
    #expect(decision.seq == 2 && !decision.fixed, "linia stoi, decyzja jeszcze otwarta")
    decision.dismiss()
    #expect(decision.seq == nil && decision.count == 0 && decision.lineSeen)
    #expect(decision.pill(.above, gesture: false) == .hidden)
    decision.settle(Pill.view(messages + [Pill.message(3, ago: 100, [Pill.text("dograne")])], snapshots: 2))
    #expect(decision.seq == nil && decision.pill(.above, gesture: false) == .hidden, "dogrywanie nie przywraca linii")
  }

  @Test("przed zamrożeniem czeka na ciszę po ostatniej zmianie linii albo liczby; potem już nie miga")
  func pillWaitsForQuietBeforeFreezing() {
    let entered = Sample.now.addingTimeInterval(-60)
    let start = Sample.now
    let before = Pill.message(1, ago: 900, [Pill.text("przed przerwą")])
    var view = Pill.view([before], snapshots: 2)
    var decision = NewMarkerDecision(seenAt: before.at, snapshotsAtEntry: 2, enteredAt: entered)
    view.messages.append(Pill.message(2, ago: 400, [Pill.text("pod nieobecność")]))
    decision.settle(view, now: start)
    #expect(!decision.fixed, "powtórka z bufora bez snapshotu: decyzja otwarta")
    let quiet = NewMarkerDecision.pillQuiet
    func waits(_ state: NewPillState) -> TimeInterval? {
      if case let .wait(left) = state { left } else { nil }
    }
    let first = waits(decision.pill(.above, gesture: false, now: start.addingTimeInterval(0.1)))
    #expect(first.map { abs($0 - (quiet - 0.1)) < 0.001 } == true, "czeka resztę ciszy: \(String(describing: first))")
    // Następna porcja powtórki: liczba się zmienia, cisza liczy się od nowa.
    view.messages.append(Pill.message(3, ago: 300, [Pill.text("a"), Pill.text("b")]))
    decision.settle(view, now: start.addingTimeInterval(0.3))
    let second = waits(decision.pill(.above, gesture: false, now: start.addingTimeInterval(0.6)))
    #expect(second.map { abs($0 - (quiet - 0.3)) < 0.001 } == true, "cisza od nowej porcji: \(String(describing: second))")
    let settled = start.addingTimeInterval(0.3 + quiet + 0.01)
    #expect(decision.pill(.above, gesture: false, now: settled) == .shown(3),
      "cisza: stoi bez zamrożenia — przy bezczynnym agencie zamrożenie nie przyszłoby nigdy")
    // Spóźniona porcja po pokazaniu zmienia liczbę, ale pigułki nie chowa.
    view.messages.append(Pill.message(4, ago: 200, [Pill.text("spóźniona")]))
    decision.settle(view, now: settled.addingTimeInterval(0.1))
    #expect(decision.pill(.above, gesture: false, now: settled.addingTimeInterval(0.1)) == .shown(4))
  }

  @Test("liczba stoi po zamrożeniu: wiadomości na żywo jej nie zmieniają; przed nim rośnie z powtórką")
  func countFreezesWithTheLine() {
    let entered = Sample.now.addingTimeInterval(-60)
    let before = Pill.message(1, ago: 900, [Pill.text("przed przerwą")])
    var view = Pill.view([before], snapshots: 2)
    var decision = NewMarkerDecision(seenAt: before.at, snapshotsAtEntry: 2, enteredAt: entered)
    decision.settle(view)
    view.messages.append(Pill.message(2, ago: 400, [Pill.text("pod nieobecność")]))
    decision.settle(view)
    #expect(decision.seq == 2 && decision.count == 1 && !decision.fixed)
    view.messages.append(Pill.message(3, ago: 300, [Pill.text("a"), Pill.text("b")]))
    decision.settle(view)
    #expect(decision.count == 3)
    view.messages.append(Pill.message(4, ago: 30, [Pill.text("na żywo")]))
    decision.settle(view)
    #expect(decision.fixed && decision.count == 3, "pierwsza żywa zamyka decyzję i się nie liczy")
    #expect(decision.pill(.above, gesture: false) == .shown(3), "zamrożona: bez czekania")
    view.messages.append(Pill.message(5, ago: 10, [Pill.text("dalej na żywo")]))
    decision.settle(view)
    #expect(decision.count == 3)
  }

  @Test("skok: linia 6 pt pod paskiem cytatu; bez promptów i przy samej górze treści pasek się nie zjawi")
  func jumpOffset() {
    // Deep in the content: the band above the line = the 39 pt bar hanging from the top and the 6 pt gap under it.
    #expect(NewLineJump.offset(lineMinY: 2000, insetTop: 24, bar: 39) == 2000 - 24 - 39 - 6)
    // Bez promptów paska nie będzie: linia 6 pt pod górą safe area.
    #expect(NewLineJump.offset(lineMinY: 2000, insetTop: 24, bar: nil) == 2000 - 24 - 6)
    // Przy samej górze (przesunięcie od góry < nearTop) pasek zostaje schowany: linia 6 pt pod górą, bez pustego pasa.
    #expect(NewLineJump.offset(lineMinY: 40, insetTop: 24, bar: 39) == 40 - 24 - 6)
    // Między progami: 6 pt pod górą pasek by się pokazał i zasłonił linię — lista staje tuż przed progiem.
    let between = NewLineJump.offset(lineMinY: 90, insetTop: 24, bar: 39)
    #expect(between + 24 < PromptBar.nearTop, "pasek schowany")
    #expect(90 - between - 24 >= NewLineJump.gap && 90 - between - 24 < 39 + 6, "linia pod górą, pas krótszy od paska")
  }

  @Test("fokus czytnika po skoku: pierwszy wiersz treści za linią, nie znacznik godziny")
  func focusRow() {
    #expect(NewLineJump.focusRow(["m1.0", "new", "t2", "m2.0", "m3.0"]) == "m2.0")
    #expect(NewLineJump.focusRow(["m1.0", "new", "m2.n"]) == "m2.n", "notka harnessu")
    #expect(NewLineJump.focusRow(["m1.0", "m2.0"]) == nil)
  }

  @Test("linia przeszła przed zamrożeniem: widziana była tamta, pigułka dla nowej od nowa")
  func movedLineIsNotSeen() {
    let old = Pill.message(1, ago: 900, [Pill.text("przed przerwą")])
    let cached = [old, Pill.message(3, ago: 300, [Pill.text("z pamięci")])]
    var decision = NewMarkerDecision(seenAt: old.at, snapshotsAtEntry: 1)
    decision.settle(Pill.view(cached))
    #expect(decision.seq == 3 && !decision.fixed)
    _ = decision.pill(.visible, gesture: true)
    #expect(decision.lineSeen)
    // Świeży stan z serwera ma wcześniejszą odpowiedź z przerwy: linia staje wyżej.
    decision.settle(Pill.view([old, Pill.message(2, ago: 600, [Pill.text("wcześniej")]), cached[1]], snapshots: 2))
    #expect(decision.seq == 2 && decision.fixed && !decision.lineSeen)
    #expect(decision.pill(.above, gesture: false) == .shown(2))
  }
}
