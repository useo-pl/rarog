import CoreGraphics
import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Kotwica zaznaczonej sesji w drzewie projektów: przycięcie przesunięcia do treści,
// warunek „cały na ekranie” i przejścia stanów `applied`/`target`/`pending`. Na prawdziwej liście: `RarogUIKitTests/
// TreeListAnchorTests`. Właściciel: lista.

@Suite("kotwica drzewa: geometria")
struct TreeListAnchorMathTests {
  private typealias Math = TreeListAnchorMath

  /// Kolekcja 700 pt z paskiem 50 pt u góry i stopką 80 pt u dołu, treść 2000 pt: przesunięcie od −50 do 1380.
  private func clamp(_ y: CGFloat, content: CGFloat = 2000) -> CGFloat {
    Math.clamp(y, contentHeight: content, boundsHeight: 700, insetTop: 50, insetBottom: 80)
  }

  @Test("przycięcie: w granicach bez zmian, nad górą do −wstawki, pod dołem do końca treści")
  func clampToContent() {
    #expect(clamp(300) == 300)
    #expect(clamp(-50) == -50 && clamp(1380) == 1380, "same granice")
    #expect(clamp(-200) == -50, "ponad górą: lista na samej górze")
    #expect(clamp(1500) == 1380, "pod dołem: 2000 + 80 − 700")
  }

  @Test("przycięcie: treść krótsza od widoku stoi u góry")
  func clampShortContent() {
    #expect(clamp(0, content: 300) == -50)
    #expect(clamp(400, content: 300) == -50)
    #expect(clamp(-90, content: 300) == -50)
  }

  /// Widoczna część przy przesunięciu 100: od 150 (pod paskiem) do 720 (nad stopką).
  private func whole(_ minY: CGFloat, _ maxY: CGFloat, offset: CGFloat = 100) -> Bool {
    Math.wholeOnScreen(minY: minY, maxY: maxY, offset: offset, boundsHeight: 700, insetTop: 50, insetBottom: 80)
  }

  @Test("cały na ekranie: granice ±0,5 pt, ucięty górą i dołem — nie")
  func wholeOnScreen() {
    #expect(whole(300, 350))
    #expect(whole(150, 200) && whole(670, 720), "dokładnie przy wstawkach")
    #expect(whole(149.5, 199.5) && whole(670.5, 720.5), "pół punktu za wstawką: zaokrąglenie układu")
    #expect(!whole(149.4, 199.4), "ucięty górą (pod paskiem)")
    #expect(!whole(670.6, 720.6), "ucięty dołem (pod stopką)")
    #expect(!whole(120, 170) && !whole(700, 750), "częściowo pod wstawką")
    #expect(!whole(140, 730), "wyższy niż widoczna część")
    #expect(!whole(900, 950) && !whole(-100, -50), "poza ekranem")
  }

  @Test("cały na ekranie: treść krótsza od widoku (lista u góry)")
  func wholeOnShortContent() {
    #expect(whole(0, 44, offset: -50), "pierwszy wiersz tuż pod paskiem")
    #expect(whole(200, 260, offset: -50))
    #expect(!whole(560, 640, offset: -50), "pod stopką także przy krótkiej treści")
  }
}

@MainActor
@Suite("kotwica drzewa: przejścia stanów applied/target/pending")
struct TreeListAnchorStateTests {
  private typealias State = TreeListAnchorState
  private let a: [ProjectTreeID] = [.project("/p1"), .session("a1"), .project("/p7"), .session("s")]
  /// Nowa sesja nad zaznaczoną.
  private let b: [ProjectTreeID] = [.project("/p1"), .session("a1"), .session("a2"), .project("/p7"), .session("s")]
  /// Zamknięta nad i nowa pod: ta sama liczba wierszy, inny indeks zaznaczonej.
  private let c: [ProjectTreeID] = [.project("/p1"), .project("/p7"), .session("s"), .session("s2")]

  private func pending(_ session: String = "s") -> State.Pending {
    State.Pending(session: session, screenTop: 420, size: CGSize(width: 320, height: 700),
                  owner: ObjectIdentifier(NSObject()))
  }

  /// Stan po pierwszym ciele z `a` (kolekcja dostaje te wiersze przy pierwszym rysowaniu).
  private func started() -> State {
    var state = State()
    _ = state.body(a, selected: "s")
    state.didApply(a)
    return state
  }

  @Test("pierwsze ciało: applied = target, bez odczytu (kolekcji jeszcze nie ma)")
  func firstBody() {
    var state = State()
    #expect(state.body(a, selected: "s") == .none)
    #expect(state.applied == a && state.target == a && state.pending == nil)
  }

  @Test("ciało z tym samym celem jest idempotentne: jeden odczyt, odczyt zostaje")
  func idempotentBody() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    let measured = pending()
    state.measured(measured)
    for _ in 0..<3 {
      #expect(state.body(b, selected: "s") == .none)
    }
    #expect(state.pending == measured)
    #expect(state.target == b && state.applied == a)
  }

  @Test("A→B→C przed aktualizacją kolekcji: odczyt z A zostaje, cel przestawiony na C")
  func chainKeepsFirstMeasurement() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    let first = pending()
    state.measured(first)
    #expect(state.body(c, selected: "s") == .none, "drugi odczyt przy kolekcji z A byłby ten sam albo gorszy")
    #expect(state.pending == first && state.target == c && state.applied == a)
    // Kolekcja ma C: zaznaczona pod indeksem 2 w C (w A była pod 3) — korekta.
    #expect(state.confirmation(items: c.count, selectedItems: [2]) == .target(2))
    // Kolekcja ma jeszcze A — czekać.
    #expect(state.confirmation(items: a.count, selectedItems: [3]) == .waiting)
    // Ta sama liczba co A i C, ale zaznaczenie gdzie indziej: ani A, ani C.
    #expect(state.confirmation(items: c.count, selectedItems: [1]) == .lost)
    #expect(state.confirmation(items: b.count, selectedItems: [4]) == .lost, "kolekcja z B, celem jest C")
  }

  @Test("liczba wierszy sama nie potwierdza celu: zaznaczony element kolekcji rozstrzyga")
  func countAloneDoesNotConfirm() {
    // A i C mają po 4 wiersze; zaznaczona w A pod 3, w C pod 2.
    var state = started()
    #expect(state.body(c, selected: "s") == .measure)
    state.measured(pending())
    #expect(state.confirmation(items: 4, selectedItems: [3]) == .waiting, "kolekcja wciąż z A")
    #expect(state.confirmation(items: 4, selectedItems: [2]) == .target(2), "kolekcja z C")
    #expect(state.confirmation(items: 4, selectedItems: []) == .lost, "bez zaznaczenia")
  }

  @Test("odczyt tylko z kolekcji, która ma applied: liczba i zaznaczony element")
  func measureIndex() {
    let state = started()
    #expect(state.measureIndex(session: "s", items: 4, selectedItems: [3]) == 3)
    #expect(state.measureIndex(session: "s", items: 5, selectedItems: [3]) == nil, "kolekcja ma inne wiersze")
    #expect(state.measureIndex(session: "s", items: 4, selectedItems: [1]) == nil, "zaznaczony inny element")
    #expect(state.measureIndex(session: "s", items: 4, selectedItems: [1, 3]) == nil, "dwa zaznaczone")
    #expect(state.measureIndex(session: "x", items: 4, selectedItems: [3]) == nil, "sesji nie ma w drzewie")
  }

  @Test("zmiana zaznaczenia przed korektą unieważnia odczyt, także bez zmiany wierszy")
  func selectionChangeDropsPending() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    state.measured(pending())
    #expect(state.body(b, selected: "a1") == .none)
    #expect(state.pending == nil)
    var cleared = started()
    #expect(cleared.body(b, selected: "s") == .measure)
    cleared.measured(pending())
    #expect(cleared.body(b, selected: nil) == .none && cleared.pending == nil, "zaznaczenie zdjęte")
  }

  @Test("bez zaznaczenia — bez odczytu")
  func noSelection() {
    var state = started()
    #expect(state.body(b, selected: nil) == .none)
  }

  @Test("zapowiedź gestu jednego projektu: ta aktualizacja bez kotwicy, także z dołączoną zmianą serwera")
  func announcedGesture() {
    var state = started()
    state.expect(b)
    #expect(state.body(b, selected: "s") == .none)
    #expect(state.skipping && state.skip.expected == nil, "zapowiedź zużyta, gest w drodze")
    // Zmiana serwera przed narysowaniem gestu jedzie razem z nim.
    #expect(state.body(c, selected: "s") == .none)
    state.didApply(b)
    #expect(state.skipping, "kolekcja jeszcze nie ma celu")
    state.didApply(c)
    #expect(!state.skipping)
    #expect(state.body(a, selected: "s") == .measure, "następna zmiana bez gestu — kotwica trzyma")
  }

  @Test("gest jednego projektu w trakcie odczytu: odczyt przepada (jedzie razem z gestem)")
  func gestureAfterMeasurement() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    state.measured(pending())
    state.expect(c)
    #expect(state.body(c, selected: "s") == .none)
    #expect(state.pending == nil && state.skipping)
  }

  @Test("nietrafiona zapowiedź znika i kotwica trzyma")
  func missedAnnouncement() {
    var state = started()
    state.expect(c)
    #expect(state.body(b, selected: "s") == .measure)
    #expect(state.skip.expected == nil && !state.skipping)
  }

  @Test("cel wraca do tego, co kolekcja ma: odczyt i gest w drodze znikają")
  func targetBackToApplied() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    state.measured(pending())
    #expect(state.body(a, selected: "s") == .none)
    #expect(state.pending == nil)
    state.expect(b)
    #expect(state.body(b, selected: "s") == .none && state.skipping)
    #expect(state.body(a, selected: "s") == .none && !state.skipping)
  }

  @Test("szkielet i pusta lista (puste wiersze) w obie strony — bez odczytu")
  func throughEmpty() {
    var state = started()
    #expect(state.body([], selected: "s") == .measure, "ciało chce mierzyć — kolekcja zdecyduje")
    state.didApply([])
    #expect(state.measureIndex(session: "s", items: 5, selectedItems: []) == nil, "szkielet: 5 wierszy bez drzewa")
    #expect(state.body(a, selected: "s") == .measure)
    #expect(state.measureIndex(session: "s", items: 5, selectedItems: []) == nil, "sesji nie ma w pustym applied")
  }

  /// Korekta przycięta przy końcu treści stawia sesję gdzie indziej niż przed zmianą, więc
  /// następna zmiana w oknie dogrywki bierze miejsce po korekcie, nie sprzed poprzedniej zmiany.
  @Test("dogrywka: nowy cel przenosi miejsce po korekcie (także przyciętej), nie sprzed poprzedniej zmiany")
  func carryAfterCorrection() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    state.measured(pending())
    #expect(!state.settling, "przed pierwszą korektą — bez dogrywki")
    state.corrected(settledTop: 610)
    #expect(state.settling && state.settledTop == 610)
    state.didApply(b)
    #expect(state.body(c, selected: "s") == .carry(screenTop: 610))
    let carried = State.Pending(session: "s", screenTop: 610, size: CGSize(width: 320, height: 700),
                                owner: ObjectIdentifier(NSObject()))
    state.measured(carried)
    #expect(!state.settling && state.settledTop == nil, "przeniesiony odczyt czeka na korektę nowego celu")
    #expect(state.pending == carried && state.target == c)
  }

  @Test("dogrywka kończy się z odczytem: drop, zmiana zaznaczenia, gest jednego projektu")
  func settleEnds() {
    func settled() -> State {
      var state = started()
      _ = state.body(b, selected: "s")
      state.measured(pending())
      state.corrected(settledTop: 400)
      state.didApply(b)
      return state
    }
    var dropped = settled()
    dropped.drop()
    #expect(!dropped.settling && dropped.settledTop == nil)
    var reselected = settled()
    #expect(reselected.body(c, selected: "a1") == .measure, "inna sesja — świeży odczyt, bez przeniesienia")
    #expect(reselected.settledTop == nil)
    var gesture = settled()
    gesture.expect(c)
    #expect(gesture.body(c, selected: "s") == .none && !gesture.settling)
    var same = settled()
    #expect(same.body(b, selected: "s") == .none, "ten sam cel — bez zmian")
    #expect(same.settling)
    #expect(same.body(a, selected: "s") == .carry(screenTop: 400), "kolejny cel w dogrywce — przeniesienie")
    var empty = State()
    empty.corrected(settledTop: 100)
    #expect(empty.settledTop == nil, "korekta bez odczytu niczego nie zapisuje")
  }

  @Test("odczyt wykorzystany: drop czyści, kolejna zmiana mierzy od nowa")
  func dropThenNext() {
    var state = started()
    #expect(state.body(b, selected: "s") == .measure)
    state.measured(pending())
    state.didApply(b)
    state.drop()
    #expect(state.pending == nil)
    #expect(state.body(c, selected: "s") == .measure)
  }
}
