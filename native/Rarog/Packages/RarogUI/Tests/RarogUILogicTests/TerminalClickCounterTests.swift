import CoreGraphics
@testable import RarogUI
import Testing

// Kliknięcia wskaźnika na terminalu: seria w odstępie < 0,35 s i < 5 pt, sufit ×3.
// Właściciel: terminal.

@Suite("terminal: licznik kliknięć wskaźnika")
struct TerminalClickCounterTests {
  @Test("×1, ×2, ×3 w tym samym miejscu; czwarte zostaje ×3 (wiersz, jak na Macu)")
  func series() {
    var counter = TerminalClickCounter()
    let point = CGPoint(x: 100, y: 40)
    let counts = [0.0, 0.2, 0.4, 0.6].map { counter.register(at: point, time: 10 + $0) }
    #expect(counts == [1, 2, 3, 3])
  }

  @Test("za długa przerwa albo za daleko — nowa seria; drżenie poniżej 5 pt nie przerywa")
  func breaks() {
    var counter = TerminalClickCounter()
    let base = CGPoint(x: 100, y: 40)
    let first = counter.register(at: base, time: 1)
    let shaky = counter.register(at: CGPoint(x: 103, y: 43), time: 1.3)
    #expect([first, shaky] == [1, 2], "3,0 + 3,0 pt to jeszcze to samo miejsce")
    let late = counter.register(at: CGPoint(x: 103, y: 43), time: 1.7)
    #expect(late == 1, "0,4 s przerwy (sufit 0,35 s) to nowa seria")
    let far = counter.register(at: CGPoint(x: 103 + TerminalClickCounter.slop, y: 43), time: 1.8)
    #expect(far == 1, "5 pt dalej to nowa seria")
    let backwards = counter.register(at: CGPoint(x: 108, y: 43), time: 1.7)
    #expect(backwards == 1, "zegar wstecz nie skleja serii")
  }
}
