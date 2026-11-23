import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Ślad czasu otwarcia terminala: linia z samych liczb i słów stałych
// i podbudżet 6 linii na godzinę. Ekran, który ją składa, testuje `TerminalScreenTests`
// (UIKit). Właściciel: terminal.

@Suite("terminal: ślad czasu otwarcia")
struct TerminalOpenTraceTests {
  private let t0 = ContinuousClock.now

  private func at(_ milliseconds: Int) -> ContinuousClock.Instant { t0 + .milliseconds(milliseconds) }

  private func timing(
    _ trigger: TerminalConnectTiming.Trigger = .start, open: TerminalConnectTiming.Open, socket: Int, bytes: Int
  ) -> TerminalConnectTiming {
    TerminalConnectTiming(trigger: trigger, started: at(2), open: open, socketOpened: at(socket), firstBytes: at(bytes))
  }

  @Test("nowy ekran: całość od pojawienia się, składowe POST → gniazdo → bajty → okno")
  func newScreen() {
    let line = TerminalOpenTrace.line(
      .newScreen(appeared: at(0)), timing: timing(open: .answered(at(120)), socket: 325, bytes: 334), drawn: at(414))
    #expect(line == "terminal: pierwszy ekran 414 ms (nowy ekran; POST 118 ms, gniazdo 205 ms, bajty 9 ms, okno 80 ms)")
  }

  @Test("powrót z tła: całość od startu próby (wznowienia sesji)")
  func returnFromBackground() {
    let line = TerminalOpenTrace.line(
      .returnFromBackground, timing: timing(.resume, open: .answered(at(52)), socket: 152, bytes: 160), drawn: at(242))
    #expect(line == "terminal: pierwszy ekran 240 ms (powrót z tła; POST 50 ms, gniazdo 100 ms, bajty 8 ms, okno 82 ms)")
  }

  @Test("POST pominięty: gniazdo od startu próby; POST po odmowie: od startu próby, razem z odrzuconym gniazdem")
  func postVariants() {
    let skipped = TerminalOpenTrace.line(
      .newScreen(appeared: at(0)), timing: timing(open: .skipped, socket: 202, bytes: 210), drawn: at(290))
    #expect(skipped == "terminal: pierwszy ekran 290 ms (nowy ekran; POST pominięty, gniazdo 200 ms, bajty 8 ms, okno 80 ms)")
    let refused = TerminalOpenTrace.line(
      .newScreen(appeared: at(0)), timing: timing(open: .answeredAfterRefusal(at(182)), socket: 382, bytes: 390),
      drawn: at(470))
    #expect(
      refused
        == "terminal: pierwszy ekran 470 ms (nowy ekran; POST po odmowie 180 ms, gniazdo 200 ms, bajty 8 ms, okno 80 ms)")
  }

  @Test("ekran z parkingu: postój w pełnych sekundach w dół, stan gniazda słowem")
  func parked() {
    #expect(TerminalOpenTrace.parked(after: .milliseconds(34_900), live: true)
      == "terminal: ekran z parkingu po 34 s (gniazdo żywe)")
    #expect(TerminalOpenTrace.parked(after: .milliseconds(400), live: false)
      == "terminal: ekran z parkingu po 0 s (łączy się)")
  }

  @Test("milisekundy zaokrąglone i nigdy ujemne")
  func millisecondsRounding() {
    #expect(TerminalOpenTrace.milliseconds(.microseconds(1_499)) == 1)
    #expect(TerminalOpenTrace.milliseconds(.microseconds(1_500)) == 2)
    #expect(TerminalOpenTrace.milliseconds(.milliseconds(-5)) == 0)
  }

  @Test("podbudżet: 6 linii na godzinę od pierwszego śladu okna, potem cisza do końca okna; nowe okno od nowa")
  func budget() {
    var budget = TerminalOpenTraceBudget()
    let admitted = (0..<8).map { budget.admit(now: t0 + .seconds($0 * 60)) }
    #expect(admitted == [true, true, true, true, true, true, false, false])
    let lastMinute = budget.admit(now: t0 + .seconds(3599))
    #expect(!lastMinute, "do końca okna cisza")
    let nextWindow = budget.admit(now: t0 + .seconds(3600))
    #expect(nextWindow, "nowe okno")
    let next = (1..<7).map { budget.admit(now: t0 + .seconds(3600 + $0)) }
    #expect(next == [true, true, true, true, true, false])
  }
}
