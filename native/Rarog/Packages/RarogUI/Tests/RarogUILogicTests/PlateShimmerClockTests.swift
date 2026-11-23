@testable import RarogUI
import Testing

/// Wspólny zegar poświaty wpisów kolejki: każde pasmo startuje na granicy cyklu
/// jednego zegara, więc dymki w kolejce płyną razem, bez względu na to, kiedy powstała ich komórka.
@Suite("zegar poświaty dymków w kolejce")
struct PlateShimmerClockTests {
  @Test("rytm pasma: start przed lewą krawędzią, środek w połowie przejścia, przerwa poza kształtem")
  func bandRhythm() {
    #expect(abs(PlateShimmerClock.bandStart(at: 0) - -0.6) < 0.001)
    #expect(abs(PlateShimmerClock.bandStart(at: PlateShimmerClock.sweep / 2) - 0.2) < 0.001)
    #expect(PlateShimmerClock.bandStart(at: PlateShimmerClock.sweep + 0.1) == 1, "przerwa: pasmo za prawą krawędzią")
    #expect(abs(PlateShimmerClock.bandStart(at: PlateShimmerClock.period) - -0.6) < 0.001, "kolejny cykl")
  }

  @Test("dwa pasma włączone w różnych chwilach jednego cyklu mają ten sam początek, więc tę samą fazę")
  func sharedPhase() {
    let period = PlateShimmerClock.period
    let first = 1_000 * period + 0.3
    let later = first + 0.9
    #expect(PlateShimmerClock.cycleStart(at: first) == PlateShimmerClock.cycleStart(at: later))
    #expect(abs(PlateShimmerClock.cycleStart(at: first) - 1_000 * period) < 0.000_1)
    // Pasmo włączone w następnym cyklu (recykling komórki, powrót z tła) startuje dokładnie cykl później.
    let nextCycle = first + period
    #expect(abs(PlateShimmerClock.cycleStart(at: nextCycle) - PlateShimmerClock.cycleStart(at: first) - period) < 0.000_1)
  }

  @Test("faza z początku cyklu = faza `bandStart` w tej samej chwili (pasmo dymku i kafla w jednym rytmie)")
  func phaseMatchesBandStart() {
    for time in [12.0, 345.67, 9_876.5] {
      let elapsed = time - PlateShimmerClock.cycleStart(at: time)
      #expect(elapsed >= 0 && elapsed < PlateShimmerClock.period)
      #expect(abs(PlateShimmerClock.bandStart(at: elapsed) - PlateShimmerClock.bandStart(at: time)) < 0.000_1)
    }
  }
}
