import Foundation
@testable import RarogTerminal
import Testing

// Adres pod komórką ekranu terminala: reguła na syntetycznych wierszach, bez SwiftTerm. Kształty
// wierszy z pomiaru (herdr 0.9.5, Claude Code 2.1.319): Claude Code łamie adres sam (nowy wiersz i 2 spacje
// wcięcia), a herdr rysuje wiersz zawinięty przez terminal od kolumny 1 bez znacznika zawinięcia. Właściciel: terminal.

@Suite("terminal: adres pod palcem, także zawinięty na kilka wierszy")
struct TerminalLinksTests {
  /// Wiersze ekranu o szerokości `cols`, dopełnione spacjami jak puste komórki.
  private func screen(_ lines: [String], cols: Int) -> [[Character]] {
    lines.map { line in
      precondition(line.count <= cols, "wiersz dłuższy niż ekran: \(line)")
      return Array(line) + Array(repeating: " ", count: cols - line.count)
    }
  }

  private func link(_ rows: [[Character]], row: Int, col: Int) -> String? {
    TerminalLinks.url(in: rows, at: TerminalLinks.Cell(row: row, col: col))?.absoluteString
  }

  @Test("adres w jednym wierszu: w adresie jest, obok nie ma")
  func singleRow() {
    let rows = screen(["ls https://example.com/a/b koniec"], cols: 40)
    #expect(link(rows, row: 0, col: 3) == "https://example.com/a/b", "pierwszy znak")
    #expect(link(rows, row: 0, col: 25) == "https://example.com/a/b", "ostatni znak")
    #expect(link(rows, row: 0, col: 1) == nil)
    #expect(link(rows, row: 0, col: 27) == nil)
    #expect(link(rows, row: 0, col: 39) == nil, "pusta komórka")
  }

  @Test("Claude Code: adres złamany przy krawędzi, dalszy ciąg po wcięciu 2 spacji — jeden adres z obu wierszy")
  func claudeWrapped() {
    let rows = screen([
      "⏺ https://github.com/migueldeicaza/SwiftTerm/blob/",
      "  main/Sources/SwiftTerm/iOS/View.swift",
      "  oraz dalej",
    ], cols: 50)
    let full = "https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/iOS/View.swift"
    #expect(link(rows, row: 0, col: 10) == full)
    #expect(link(rows, row: 1, col: 2) == full, "pierwszy znak dalszego ciągu")
    #expect(link(rows, row: 1, col: 38) == full, "ostatni znak dalszego ciągu")
    #expect(link(rows, row: 1, col: 0) == nil, "wcięcie nie jest adresem")
    #expect(link(rows, row: 2, col: 3) == nil, "wiersz za adresem")
  }

  @Test("komórki adresu (podkreślenie): wszystkie wiersze, bez wcięcia i bez uciętego ogona")
  func cells() throws {
    let rows = screen(["ab https://a.com/xyz", "  dalej)."], cols: 20)
    let found = try #require(TerminalLinks.link(in: rows, at: TerminalLinks.Cell(row: 1, col: 3)))
    #expect(found.url.absoluteString == "https://a.com/xyzdalej")
    let byRow = Dictionary(grouping: found.cells, by: \.row).mapValues { $0.map(\.col) }
    #expect(byRow[0] == Array(3..<20))
    #expect(byRow[1] == Array(2..<7), "bez „).” na końcu")
  }

  @Test("herdr: wiersz zawinięty przez terminal ciągnie się od pierwszej kolumny, przez trzy wiersze")
  func terminalWrapped() {
    let rows = screen([
      "A2 https://example.com/bardzo/dlugi/adre",
      "s/ktory/na/pewno/przekroczy/czterdziesci",
      "/kolumn?x=1&y=2 END",
    ], cols: 40)
    let full = "https://example.com/bardzo/dlugi/adres/ktory/na/pewno/przekroczy/czterdziesci/kolumn?x=1&y=2"
    #expect(link(rows, row: 0, col: 3) == full)
    #expect(link(rows, row: 1, col: 20) == full)
    #expect(link(rows, row: 2, col: 0) == full)
    #expect(link(rows, row: 2, col: 16) == nil, "END za spacją nie należy do adresu")
  }

  @Test("adres kończy się z dala od krawędzi: następnego wiersza nie dokleja")
  func shortNotJoined() {
    let rows = screen(["zobacz https://a.com/x", "  dalej"], cols: 40)
    #expect(link(rows, row: 0, col: 8) == "https://a.com/x")
    #expect(link(rows, row: 1, col: 3) == nil)
  }

  @Test("luz przy krawędzi: najwyżej 2 wolne kolumny za adresem skleja, 3 — nie")
  func edgeGap() {
    let far = screen(["xxxx https://a.com/" + String(repeating: "b", count: 8), "  c"], cols: 30)
    #expect(far[0].lastIndex { $0 != " " } == 26, "3 wolne kolumny")
    #expect(link(far, row: 0, col: 6) == "https://a.com/bbbbbbbb")
    let near = screen(["xxxx https://a.com/" + String(repeating: "b", count: 9), "  c"], cols: 30)
    #expect(near[0].lastIndex { $0 != " " } == 27, "2 wolne kolumny")
    #expect(link(near, row: 0, col: 6) == "https://a.com/bbbbbbbbbc")
  }

  @Test("znane ograniczenie: adres do krawędzi, a następny wiersz zaczyna zwykłe słowo — reguła je dokleja")
  func knownFalseJoin() {
    let rows = screen(["zobacz https://a.com/abcdefghijklm", "  dalej"], cols: 34)
    #expect(link(rows, row: 0, col: 8) == "https://a.com/abcdefghijklmdalej")
  }

  @Test("bez doklejania: pusty następny wiersz, wcięcie głębsze niż 8, znak spoza adresu na początku, ostatni wiersz")
  func noContinuation() {
    let edge = "https://example.com/abcdefghij" // 30 znaków do krawędzi
    #expect(link(screen([edge, ""], cols: 30), row: 0, col: 0) == edge)
    #expect(link(screen([edge, String(repeating: " ", count: 9) + "x"], cols: 30), row: 0, col: 0) == edge)
    #expect(link(screen([edge, String(repeating: " ", count: 8) + "x"], cols: 30), row: 0, col: 0) == edge + "x")
    #expect(link(screen([edge, "  │ x"], cols: 30), row: 0, col: 0) == edge)
    #expect(link(screen([edge], cols: 30), row: 0, col: 0) == edge)
  }

  @Test("ogon jak w transkrypcie: interpunkcja, niesparowany nawias, link markdown złamany w środku")
  func trailing() {
    let rows = screen(["(https://a.com/x).", "wiki https://w.org/A_(b) ok"], cols: 40)
    #expect(link(rows, row: 0, col: 1) == "https://a.com/x")
    #expect(link(rows, row: 0, col: 16) == nil, "nawias zamykający należy do zdania")
    #expect(link(rows, row: 1, col: 6) == "https://w.org/A_(b)")
    let markdown = screen(["  oraz [link](https://example.com/markdown-link-t", "  arget)"], cols: 50)
    #expect(link(markdown, row: 1, col: 3) == "https://example.com/markdown-link-target")
  }

  @Test("schemat złamany na krawędzi też skleja; sam schemat, ftp i adres bez hosta nie są linkami")
  func scheme() {
    let split = screen(["abcdefg http", "  s://a.com"], cols: 12)
    #expect(link(split, row: 0, col: 9) == "https://a.com")
    #expect(link(split, row: 1, col: 4) == "https://a.com")
    #expect(link(screen(["https:// x"], cols: 20), row: 0, col: 2) == nil)
    #expect(link(screen(["ftp://a.com/x"], cols: 20), row: 0, col: 2) == nil)
  }

  @Test("link OSC 8: tylko http i https z hostem")
  func explicitLinks() {
    #expect(TerminalLinks.web("https://example.com/x")?.absoluteString == "https://example.com/x")
    #expect(TerminalLinks.web("HTTP://example.com") != nil, "wielkość liter schematu bez znaczenia")
    for raw in ["javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.c", "//example.com", "https://", "x"] {
      #expect(TerminalLinks.web(raw) == nil, "\(raw)")
    }
  }

  @Test("pełny ekran 60×250 przeszukuje się szybko (każde stuknięcie liczy od nowa)")
  func cost() {
    let line = String(repeating: "h https://e.com/" + String(repeating: "x", count: 30) + " ", count: 5)
    let rows = screen(Array(repeating: String(line.prefix(250)), count: 60), cols: 250)
    let clock = ContinuousClock()
    let elapsed = clock.measure {
      for _ in 0..<20 { _ = TerminalLinks.url(in: rows, at: TerminalLinks.Cell(row: 59, col: 249)) }
    }
    #expect(elapsed < .milliseconds(500), "\(elapsed) za 20 przeszukań")
  }

  @Test("koszt liniowy: ekran 60×250 bez spacji, pełen „h” albo samych schematów, sklejony w jeden ciąg")
  func costWithoutSpaces() {
    let clock = ContinuousClock()
    let tap = TerminalLinks.Cell(row: 59, col: 249)
    let letters = screen(Array(repeating: String(repeating: "h", count: 250), count: 60), cols: 250)
    let lettersTime = clock.measure { #expect(TerminalLinks.url(in: letters, at: tap) == nil) }
    #expect(lettersTime < .milliseconds(200), "\(lettersTime)")

    let schemes = String(String(repeating: "https://", count: 32).prefix(250))
    let chained = screen(Array(repeating: schemes, count: 60), cols: 250)
    let chainedTime = clock.measure { _ = TerminalLinks.url(in: chained, at: tap) }
    #expect(chainedTime < .milliseconds(200), "\(chainedTime)")
  }
}
