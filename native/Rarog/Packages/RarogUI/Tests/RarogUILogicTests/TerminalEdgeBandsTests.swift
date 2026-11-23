import CoreGraphics
@testable import RarogUI
import Testing

// Rozkład pasa w kolorze krawędzi siatki: pasy wyłącznie poza siatką, boki wiersz po wierszu, dół kolumna
// po kolumnie, narożniki kolorem komórki narożnej, pasek klawiszy wyłączony z malowania, brak koloru → tło
// terminala bez zakładki na siatkę, wąski pas wewnątrz powierzchni nietknięty przy zaznaczeniu. Geometria jak
// w oknie: pas okna 8 pt, odstęp powierzchni 8 pt, resztka siatki z prawej i u dołu. Właściciel: terminal.

@Suite("terminal: pas w kolorze krawędzi — rozkład")
struct TerminalEdgeBandsTests {
  static let navy = TerminalEdgeColor(red8: 0x1a, green8: 0x1b, blue8: 0x26)
  static let side = TerminalEdgeColor(red8: 0x16, green8: 0x16, blue8: 0x1e)
  static let line = TerminalEdgeColor(red8: 0x30, green8: 0x30, blue8: 0x30)
  static let mode = TerminalEdgeColor(red8: 0x7a, green8: 0xa2, blue8: 0xf7)
  static let status = TerminalEdgeColor(red8: 0x3b, green8: 0x42, blue8: 0x61)
  static let place = TerminalEdgeColor(red8: 0x9e, green8: 0xce, blue8: 0x6a)
  static let shell = TerminalEdgeColor(red8: 0x10, green8: 0x10, blue8: 0x10)

  /// Obszar 200 × 110 (pas okna z lewej 0…8), powierzchnia 16…184 × 0…90, siatka 10 × 4 komórek 15,5 × 20 pt.
  static let area = CGRect(x: 0, y: 0, width: 200, height: 110)
  static let surface = CGRect(x: 16, y: 0, width: 168, height: 90)
  static let grid = CGRect(x: 16, y: 0, width: 155, height: 80)

  static let edges = TerminalEdges(
    background: shell, leading: [side, side, line, mode], trailing: [navy, navy, line, place],
    bottom: [mode, mode, status, status, status, status, status, status, place, place])

  static func bands(
    _ edges: TerminalEdges = edges, grid: CGRect = grid, limit: CGFloat = area.maxY, scale: CGFloat = 2
  ) -> [TerminalEdgeBands.Band] {
    TerminalEdgeBands.layout(
      edges: edges, area: area, grid: grid, cols: 10, rows: 4, surface: surface, bottomLimit: limit, scale: scale)
  }

  /// Kolor pasa w punkcie; `nil` = nic tam nie maluje.
  static func color(_ x: CGFloat, _ y: CGFloat, in bands: [TerminalEdgeBands.Band]) -> TerminalEdgeColor? {
    bands.last { $0.rect.contains(CGPoint(x: x, y: y)) }?.color
  }

  @Test("boki wiersz po wierszu, dół kolumna po kolumnie, narożniki kolorem komórki narożnej")
  func colors() {
    let bands = Self.bands()
    #expect(Self.color(4, 10, in: bands) == Self.side, "lewy pas okna przy wierszu 0")
    #expect(Self.color(12, 50, in: bands) == Self.line, "lewy odstęp przy wierszu 2")
    #expect(Self.color(178, 70, in: bands) == Self.place, "wąski pas wewnątrz powierzchni przy wierszu 3")
    #expect(Self.color(196, 30, in: bands) == Self.navy, "prawy pas okna przy wierszu 1")
    #expect(Self.color(20, 85, in: bands) == Self.mode, "pod kolumną 0")
    #expect(Self.color(16 + 15.5 * 4.5, 100, in: bands) == Self.status, "pod kolumną 4, w pasie okna")
    #expect(Self.color(4, 105, in: bands) == Self.mode, "lewy dolny narożnik: komórka (0, 3)")
    #expect(Self.color(196, 105, in: bands) == Self.place, "prawy dolny narożnik: komórka (9, 3)")
    #expect(bands.count < 4 * 2 + 10 + 2, "sąsiednie kawałki w tym samym kolorze sklejone: \(bands.count)")
  }

  @Test("pasy tylko poza siatką (najwyżej piksel zakładki), a siatka i pasy kryją obszar bez dziur")
  func outsideGridWithoutGaps() {
    let bands = Self.bands()
    let inner = Self.grid.insetBy(dx: 0.5, dy: 0.5)
    for band in bands {
      #expect(band.rect.intersection(inner).isEmpty, "pas w siatce: \(band.rect)")
    }
    for x in stride(from: CGFloat(0.25), to: 200, by: 0.5) {
      for y in stride(from: CGFloat(0.25), to: 110, by: 0.5) where !Self.grid.contains(CGPoint(x: x, y: y)) {
        #expect(Self.color(x, y, in: bands) != nil, "dziura w (\(x), \(y))")
      }
    }
  }

  @Test("krawędzie na pełnych pikselach: pas nachodzi na skrajną komórkę o piksel zamiast zostawiać szew")
  func pixelEdges() {
    let grid = CGRect(x: 16, y: 0, width: 155.3, height: 80)
    let bands = Self.bands(grid: grid, scale: 3)
    for band in bands {
      for edge in [band.rect.minX, band.rect.maxX, band.rect.minY, band.rect.maxY] {
        #expect(abs((edge * 3).rounded() - edge * 3) < 0.001, "krawędź \(edge) poza siatką pikseli")
      }
    }
    let right = bands.last { $0.rect.contains(CGPoint(x: 178, y: 10)) }?.rect.minX ?? 0
    #expect(right <= grid.maxX - 1.0 / 3 && right > grid.maxX - 2.0 / 3, "prawy pas z pikselem zakładki: \(right)")
    let left = bands.last { $0.rect.contains(CGPoint(x: 4, y: 10)) }?.rect.maxX ?? 0
    #expect(left == grid.minX + 1.0 / 3, "lewy pas z pikselem zakładki: \(left)")
  }

  @Test("pasek klawiszy: pas pod siatką kończy się na nim, pasek i pas pod nim zostają tłem ekranu")
  func keyBarExcluded() {
    let bands = Self.bands(limit: 86)
    #expect(Self.color(20, 84, in: bands) == Self.mode, "resztka nad paskiem w kolorze dolnego wiersza")
    for x: CGFloat in [4, 50, 120, 196] {
      #expect(Self.color(x, 88, in: bands) == nil, "pasek klawiszy w x=\(x)")
      #expect(Self.color(x, 105, in: bands) == nil, "pas pod paskiem w x=\(x)")
    }
    #expect(Self.color(4, 70, in: bands) == Self.mode, "boki wierszy bez zmian")
  }

  /// Pas wchodzi w siatkę (pole przecięcia większe od zera).
  static func entersGrid(_ band: TerminalEdgeBands.Band, _ grid: CGRect) -> Bool {
    let overlap = band.rect.intersection(grid)
    return !overlap.isNull && overlap.width > 0 && overlap.height > 0
  }

  @Test("dół się nie rozszerza: pas pod siatką i narożniki w tle terminala, bez zakładki na dolny wiersz")
  func bottomNotExtended() {
    var edges = Self.edges
    edges.bottom = nil
    // Siatka na ułamkach piksela: pas nierozszerzony zaczyna się za nią, nie na jej ostatnim pikselu.
    let grid = CGRect(x: 16.2, y: 0.3, width: 155.3, height: 79.9)
    let bands = Self.bands(edges, grid: grid, scale: 3)
    for x: CGFloat in [4, 20, 100, 196] {
      #expect(Self.color(x, 100, in: bands) == Self.shell, "x=\(x)")
    }
    #expect(Self.color(4, 70, in: bands) == Self.mode, "wiersz 3 rozszerzony z boku (atrapa niezgodna z odczytem)")
    for band in bands where band.color == Self.shell {
      #expect(!Self.entersGrid(band, grid), "pas tła na komórkach: \(band.rect)")
    }
  }

  @Test("wiersz nierozszerzony: pas w tle terminala za siatką; rozszerzony obok z pikselem zakładki")
  func rowNotExtended() {
    // Goła powłoka: odwrócony „%” zsh w kolumnie 0 wiersza 1 (kolor komórki ≠ tło), dolny wiersz mieszany.
    let edges = TerminalEdges(
      background: Self.shell, leading: [Self.side, nil, nil, nil], trailing: [Self.navy, nil, nil, nil], bottom: nil)
    let grid = CGRect(x: 16.2, y: 0.3, width: 155.3, height: 79.9)
    let bands = Self.bands(edges, grid: grid, scale: 3)
    #expect(Self.color(4, 30, in: bands) == Self.shell, "wiersz 1 bez pasa w kolorze komórki")
    #expect(Self.color(196, 30, in: bands) == Self.shell)
    #expect(Self.color(4, 10, in: bands) == Self.side, "wiersz 0 w całości kolorowy")
    let rows = grid.minY + 20...grid.maxY
    for band in bands where band.rect.minY >= rows.lowerBound - 1 {
      #expect(!Self.entersGrid(band, grid), "pas nierozszerzony na komórkach: \(band.rect) \(band.color)")
    }
    let first = bands.filter { Self.entersGrid($0, grid) }
    #expect(first.allSatisfy { $0.rect.maxY <= rows.lowerBound + 0.5 }, "w siatkę wchodzi tylko wiersz 0: \(first)")
    // Ta sama siatka, wszystko nierozszerzone: ani jeden pas na komórkach.
    let shell = TerminalEdges(background: Self.shell, leading: [nil, nil, nil, nil], trailing: [], bottom: nil)
    for band in Self.bands(shell, grid: grid, scale: 3) {
      #expect(!Self.entersGrid(band, grid), "goła powłoka: \(band.rect)")
    }
  }

  @Test("brak koloru dla wiersza albo kolumny (odczyt sprzed zmiany siatki) → tło terminala")
  func missingColors() {
    let edges = TerminalEdges(background: Self.shell, leading: [Self.side], trailing: [], bottom: [Self.mode])
    let bands = Self.bands(edges)
    #expect(Self.color(4, 10, in: bands) == Self.side)
    #expect(Self.color(4, 30, in: bands) == Self.shell, "wiersz 1 bez koloru")
    #expect(Self.color(196, 10, in: bands) == Self.shell, "prawy bok bez kolorów")
    #expect(Self.color(16 + 15.5 * 5.5, 100, in: bands) == Self.shell, "kolumna 5 bez koloru")
    #expect(Self.color(4, 105, in: bands) == Self.mode, "narożnik z kolumny 0")
  }

  @Test("zaznaczenie: wąski pas wewnątrz powierzchni (uchwyty SwiftTerm) zostaje rendererowi")
  func selectionKeepsInnerStrip() {
    var edges = Self.edges
    edges.selecting = true
    let bands = Self.bands(edges)
    let strip = [
      CGRect(x: Self.grid.maxX, y: 0, width: Self.surface.maxX - Self.grid.maxX, height: Self.surface.height),
      CGRect(
        x: Self.surface.minX, y: Self.grid.maxY, width: Self.surface.width, height: Self.surface.maxY - Self.grid.maxY),
    ]
    for band in bands {
      for part in strip {
        let overlap = band.rect.intersection(part)
        #expect(overlap.isEmpty || min(overlap.width, overlap.height) <= 1, "pas na uchwytach: \(band.rect)")
      }
    }
    #expect(Self.color(196, 30, in: bands) == Self.navy, "pas okna z prawej zostaje")
    #expect(Self.color(100, 100, in: bands) == Self.status, "pas okna pod powierzchnią zostaje")
    #expect(Self.color(4, 85, in: bands) == Self.mode, "lewy narożnik leży poza powierzchnią")
  }

  @Test("pusta siatka albo obszar: nic do malowania")
  func empty() {
    #expect(TerminalEdgeBands.layout(
      edges: Self.edges, area: Self.area, grid: .zero, cols: 0, rows: 0, surface: Self.surface, bottomLimit: 110,
      scale: 2).isEmpty)
    #expect(TerminalEdgeBands.layout(
      edges: Self.edges, area: .zero, grid: Self.grid, cols: 10, rows: 4, surface: Self.surface, bottomLimit: 0,
      scale: 2).isEmpty)
  }

  @Test("kolor 8-bitowy jak w SwiftTerm: × 257, opis szesnastkowy")
  func colorValues() {
    let color = TerminalEdgeColor(red8: 0x1a, green8: 0xff, blue8: 0)
    #expect(color.red == 0x1a * 257 && color.green == 65535 && color.blue == 0)
    #expect(color.description == "#1aff00")
  }
}
