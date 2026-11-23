import Foundation
@testable import RarogUI
import Testing

// Ślad powrotu terminala z tła: zmiany siatki i pominięte układy od dezaktywacji sceny (sekcja „tło”), próbki
// układu przez 3 s od aktywacji sceny, pierwszy ekran i porcje bajtów po nim — same liczby, kilka linii, każda w granicy `RarogStore.trace` (200 znaków),
// podbudżet 4 powroty na godzinę. Okablowanie w ekranie testuje `TerminalScreenTests` (UIKit). Właściciel: terminal.

@Suite("terminal: ślad powrotu z tła")
struct TerminalReturnTraceTests {
  private let t0 = ContinuousClock.now
  private let prefix = "terminal: powrót z tła; "
  private let empty = "terminal: powrót z tła; tło brak; ekran brak; bajty brak"
  private let layoutHead = "terminal: powrót z tła; układ "

  private func at(_ milliseconds: Int) -> ContinuousClock.Instant { t0 + .milliseconds(milliseconds) }

  private func layout(
    height: Int = 748, x: Int = 0, y: Int = 74, cols: Int = 134, rows: Int = 51, offset: Int = 0, inset: Int = 0,
    keyboard: Int = 0, focused: Bool = true
  ) -> TerminalReturnLayout {
    TerminalReturnLayout(
      height: height, x: x, y: y, cols: cols, rows: rows, offset: offset, inset: inset, keyboard: keyboard,
      focused: focused)
  }

  private func started() -> TerminalReturnTrace {
    var trace = TerminalReturnTrace()
    trace.begin(at: at(0))
    return trace
  }

  /// Próbka z dużymi zmianami wszystkich pól — długa, żeby wypełnić linię.
  private func wide(_ index: Int) -> TerminalReturnLayout {
    layout(
      height: 300 + index * 41, x: index * 3, y: 74 + index * 11, rows: 15 + index, offset: -index * 7,
      inset: index * 13, keyboard: index * 37, focused: index.isMultiple(of: 2))
  }

  /// Czasy („+N”) próbek w liniach układu, po kolei.
  private func sampleTimes(_ lines: [String]) -> [Int] {
    lines.dropFirst().flatMap { line in
      line.dropFirst(layoutHead.count).components(separatedBy: ", ").compactMap { part in
        part.split(separator: " ").first.flatMap { Int($0.dropFirst()) }
      }
    }
  }

  @Test("identyczne próbki (poza czasem) zlewają się; następne niosą tylko zmienione pola; bez pierwszego ekranu „brak”")
  func coalescing() {
    var trace = started()
    let full = layout()
    let half = layout(height: 374, rows: 25, keyboard: 374)
    for (ms, sample) in [(0, full), (50, full), (100, full), (150, half), (200, half), (250, full), (300, full)] {
      trace.sample(sample, at: at(ms))
    }
    #expect(trace.lines() == [
      empty,
      layoutHead + "+0 748pt x0 y74 134×51 p0 w0 k0 fokus, +150 374pt 134×25 k374, +250 748pt 134×51 k0",
    ])
  }

  @Test("pozycja kontenera w oknie: x i y w pierwszej próbce, potem tylko zmienione")
  func position() {
    var trace = started()
    trace.sample(layout(), at: at(0))
    trace.sample(layout(y: 400), at: at(40))
    trace.sample(layout(x: -12, y: 400), at: at(90))
    #expect(trace.lines().last == layoutHead + "+0 748pt x0 y74 134×51 p0 w0 k0 fokus, +40 y400, +90 x-12")
  }

  @Test("sufit 12 próbek: nadmiar jako „+N dalszych”")
  func sampleCap() {
    var trace = started()
    for ms in 0..<15 { trace.sample(layout(keyboard: ms % 2), at: at(ms)) }
    let rest = (1..<12).map { ", +\($0) k\($0 % 2)" }.joined()
    let lines = trace.lines()
    #expect(lines == [empty, layoutHead + "+0 748pt x0 y74 134×51 p0 w0 k0 fokus" + rest + " +3 dalszych"])
  }

  @Test("próbki po kolei w najwyżej dwóch liniach układu; druga zaczyna się pełną próbką; reszta „+N dalszych”")
  func twoLayoutLines() {
    var trace = started()
    for index in 0..<12 { trace.sample(wide(index), at: at(index * 250)) }
    let lines = trace.lines()
    #expect(lines.count == 3, "\(lines)")
    for line in lines { #expect(line.count <= 200, "\(line.count): \(line)") }
    #expect(lines[1].hasPrefix(layoutHead + "+0 300pt x0 y74 134×15 p0 w0 k0 fokus, +250 341pt x3 y85 134×16 p-7 w13"))
    let times = sampleTimes(lines)
    #expect(times == (0..<times.count).map { $0 * 250 }, "próbki po kolei, bez dziur: \(lines)")
    let second = lines[2].dropFirst(layoutHead.count)
    let firstOfSecond = second.components(separatedBy: ", ").first ?? ""
    #expect(firstOfSecond.split(separator: " ").count >= 9, "druga linia od pełnej próbki: \(firstOfSecond)")
    #expect(second.hasSuffix(" +\(12 - times.count) dalszych"), "\(lines[2])")
  }

  @Test("każda linia ≤ 200 znaków i żadna nie kończy się w pół słowa — także przy pełnym nagłówku")
  func everyLineFits() {
    var trace = TerminalReturnTrace()
    for index in 0..<6 {
      let even = index.isMultiple(of: 2)
      trace.grid(cols: even ? 134 : 97, rows: even ? 51 : 70, state: .background)
    }
    trace.begin(at: at(0))
    for index in 0..<12 { trace.sample(wide(index), at: at(index * 50)) }
    trace.firstScreen(at: at(640))
    for index in 0..<7 { trace.bytes(1_530_000, at: at(1000 + index * 200)) }
    let lines = trace.lines()
    #expect(lines.count == 3)
    for line in lines {
      #expect(line.count <= 200, "\(line.count): \(line)")
      #expect(line.hasPrefix(prefix))
      let last = line.split(separator: " ").last.map(String.init) ?? ""
      let complete = last == "dalszych" || last == "fokus" || last == "fokusu" || last.hasSuffix("B")
      #expect(complete, "koniec w pół słowa: \(line)")
    }
    #expect(lines[0].hasPrefix(prefix + "tło t134×51 t97×70 t134×51 t97×70 t134×51 t97×70; ekran +640 ms; bajty +1000 1530000B"))
    #expect(lines[0].hasSuffix(" dalszych"), "porcje, które się nie mieszczą, jako licznik: \(lines[0])")
  }

  @Test("nagłówek za długi także bez porcji bajtów: elementy sekcji „tło” od końca do licznika")
  func headerGridsShrink() {
    var trace = TerminalReturnTrace()
    let huge = 1_000_000_000_000_000
    for index in 0..<6 { trace.grid(cols: huge + index, rows: huge, state: .background) }
    trace.begin(at: at(0))
    trace.firstScreen(at: at(640))
    for index in 0..<7 { trace.bytes(1_530_000, at: at(1000 + index * 200)) }
    let first = trace.lines()[0]
    #expect(first.count <= 200, "\(first.count): \(first)")
    let grids = (0..<3).map { "t\(huge + $0)×\(huge)" }.joined(separator: " ")
    #expect(first == prefix + "tło \(grids) +3 dalszych; ekran +640 ms; bajty +7 dalszych")
  }

  @Test("sekcja „tło”: powtórzenia pod rząd zlewają się, 6 pierwszych, reszta „+N dalszych”; po aktywacji nic")
  func backgroundGrids() {
    var trace = TerminalReturnTrace()
    for grid in [(97, 70), (97, 70), (134, 51), (97, 70), (97, 70), (40, 10), (41, 10), (42, 10), (43, 10), (44, 10)] {
      trace.grid(cols: grid.0, rows: grid.1, state: .background)
    }
    trace.grid(cols: 44, rows: 10, state: .background)  // powtórzenie ponad sufitem też się zlewa
    trace.begin(at: at(0))
    trace.grid(cols: 1, rows: 1, state: .active)
    trace.skippedLayout(height: 10, state: .active)
    #expect(trace.lines() == [
      prefix + "tło t97×70 t134×51 t97×70 t40×10 t41×10 t42×10 +2 dalszych; ekran brak; bajty brak", layoutHead + "brak",
    ])
  }

  /// Nagranie iPada (build 3549): w chwili, gdy ślad był ślepy, przyszedł układ na połowę wysokości. Ten sam element
  /// w innym stanie sceny to inny element.
  @Test("sekcja „tło”: pominięty układ `<stan>~<wysokość>pt`, zmiana siatki `<stan><kolumny>×<wiersze>`, stany a/n/t")
  func pausesWithSceneState() {
    var trace = TerminalReturnTrace()
    #expect(!trace.sawBackground)
    trace.skippedLayout(height: 820, state: .inactive)
    trace.skippedLayout(height: 820, state: .inactive)
    trace.enteredBackground()
    trace.skippedLayout(height: 820, state: .background)
    trace.skippedLayout(height: 410, state: .background)
    trace.grid(cols: 134, rows: 51, state: .active)
    trace.grid(cols: 134, rows: 26, state: .inactive)
    #expect(trace.sawBackground)
    trace.begin(at: at(0))
    #expect(trace.lines().first == prefix + "tło n~820pt t~820pt t~410pt a134×51 n134×26; ekran brak; bajty brak")
  }

  @Test("bajty: przed pierwszym ekranem pominięte, porcje bliższe niż 100 ms sklejone, najwyżej 6 porcji")
  func bytePortions() {
    var trace = started()
    trace.bytes(5000, at: at(500))  // okno pierwszego ekranu — należy do niego
    trace.firstScreen(at: at(640))
    trace.firstScreen(at: at(900))  // liczy się pierwszy
    for (ms, count) in [(700, 100), (750, 200), (840, 1), (1000, 50), (1060, 10)] { trace.bytes(count, at: at(ms)) }
    #expect(trace.lines().first == prefix + "tło brak; ekran +640 ms; bajty +700 301B, +1000 60B")

    var many = started()
    many.firstScreen(at: at(10))
    for index in 0..<8 { many.bytes(1, at: at(100 + index * 200)) }
    many.bytes(1, at: at(1550))  // sklejone z porcją ponad sufitem: nie nowa porcja
    #expect(many.lines().first == prefix + "tło brak; ekran +10 ms; bajty +100 1B, +300 1B, +500 1B, "
      + "+700 1B, +900 1B, +1100 1B +2 dalszych")
  }

  @Test("pełny ślad: linia tła, ekranu i bajtów, potem linia układu; przed aktywacją nic poza sekcją „tło”")
  func fullTrace() {
    var trace = TerminalReturnTrace()
    trace.sample(layout(), at: at(-100))
    trace.firstScreen(at: at(-50))
    trace.grid(cols: 97, rows: 70, state: .background)
    trace.grid(cols: 134, rows: 51, state: .background)
    trace.begin(at: at(0))
    trace.sample(layout(), at: at(0))
    trace.sample(layout(height: 374, rows: 25, keyboard: 374), at: at(85))
    trace.firstScreen(at: at(640))
    trace.bytes(2100, at: at(710))
    trace.sample(layout(), at: at(1900))
    trace.bytes(15300, at: at(1930))
    #expect(trace.lines() == [
      prefix + "tło t97×70 t134×51; ekran +640 ms; bajty +710 2100B, +1930 15300B",
      layoutHead + "+0 748pt x0 y74 134×51 p0 w0 k0 fokus, +85 374pt 134×25 k374, +1900 748pt 134×51 k0",
    ])
  }

  @Test("punkty z układu: zaokrąglone, przycięte, NaN i nieskończoność = 0")
  func points() {
    #expect(TerminalReturnLayout.points(373.5) == 374)
    #expect(TerminalReturnLayout.points(-12.4) == -12)
    #expect(TerminalReturnLayout.points(.nan) == 0)
    #expect(TerminalReturnLayout.points(.infinity) == 0)
    #expect(TerminalReturnLayout.points(1e300) == 1_000_000)
  }

  @Test("podbudżet: 4 powroty na godzinę od pierwszego śladu okna, potem cisza do końca okna; nowe okno od nowa")
  func budget() {
    var budget = TerminalReturnTraceBudget()
    let admitted = (0..<6).map { budget.admit(now: t0 + .seconds($0 * 60)) }
    #expect(admitted == [true, true, true, true, false, false])
    let lastSecond = budget.admit(now: t0 + .seconds(3599))
    #expect(!lastSecond, "do końca okna cisza")
    let next = (0..<5).map { budget.admit(now: t0 + .seconds(3600 + $0)) }
    #expect(next == [true, true, true, true, false])
  }
}
