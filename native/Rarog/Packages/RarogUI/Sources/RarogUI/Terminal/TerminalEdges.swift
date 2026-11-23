import CoreGraphics
import Foundation

// Pas wokół siatki terminala w kolorze jej krawędzi (jak Ghostty `window-padding-color = extend`): odstęp
// między siatką a krawędzią okna Cmd+F/Cmd+G dostaje kolor komórek, które przy nim leżą, więc nvim albo lazygit
// nie mają widocznej ramy. Tu mieszka część bez UIKit: kolory krawędzi (liczy je renderer, `TerminalEdgeReader`
// w `RarogTerminal` — tylko on zna SwiftTerm) i rozkład pasów z ramki siatki (`TerminalEdgeBands`, testy na macOS:
// `TerminalEdgeBandsTests`). Maluje nakładka `TerminalEdgeFill` ekranu terminala; włącza ją wyłącznie okno.
// Właściciel: terminal.

/// Kolor sRGB komórki, 16 bitów na kanał — jak `Color` SwiftTerm, więc bez strat w obie strony.
public struct TerminalEdgeColor: Hashable, Sendable, CustomStringConvertible {
  public var red: UInt16
  public var green: UInt16
  public var blue: UInt16

  public init(red: UInt16, green: UInt16, blue: UInt16) {
    self.red = red
    self.green = green
    self.blue = blue
  }

  /// Z 8 bitów na kanał (truecolor, paleta) — jak `Color(red8:green8:blue8:)` SwiftTerm: × 257.
  public init(red8: UInt8, green8: UInt8, blue8: UInt8) {
    self.init(red: UInt16(red8) * 257, green: UInt16(green8) * 257, blue: UInt16(blue8) * 257)
  }

  public var description: String {
    String(format: "#%02x%02x%02x", Int(red) / 257, Int(green) / 257, Int(blue) / 257)
  }
}

/// Kolory krawędzi siatki z jednego odczytu emulatora. Wiersz rozszerza się na boki, a dolny wiersz także w dół,
/// tylko według reguły z ``TerminalEdgeReader`` w `RarogTerminal`: na ekranie alternatywnym zawsze, na głównym
/// wyłącznie wiersz bez komórki z tłem domyślnym. Wiersz nierozszerzony ma pas w ``background``.
public struct TerminalEdges: Equatable, Sendable {
  /// Efektywne tło terminala (także po OSC 11 programu): kolor pasa, który się nie rozszerza.
  public var background: TerminalEdgeColor
  /// Tło skrajnej lewej komórki każdego wiersza, od góry; `nil` = wiersz się nie rozszerza (pas w ``background``).
  public var leading: [TerminalEdgeColor?]
  /// Tło skrajnej prawej komórki każdego wiersza, od góry; `nil` = wiersz się nie rozszerza.
  public var trailing: [TerminalEdgeColor?]
  /// Tło dolnego wiersza kolumna po kolumnie; `nil` = dół się nie rozszerza i pas pod siatką ma ``background``.
  public var bottom: [TerminalEdgeColor]?
  /// Zaznaczenie aktywne: uchwyty SwiftTerm wchodzą w wąski pas WEWNĄTRZ powierzchni (resztka poza pełnymi
  /// komórkami z prawej i u dołu), więc nakładka go wtedy nie maluje.
  public var selecting: Bool

  public init(
    background: TerminalEdgeColor, leading: [TerminalEdgeColor?], trailing: [TerminalEdgeColor?],
    bottom: [TerminalEdgeColor]?, selecting: Bool = false
  ) {
    self.background = background
    self.leading = leading
    self.trailing = trailing
    self.bottom = bottom
    self.selecting = selecting
  }
}

/// Rozkład pasa: prostokąty i ich kolory. Boki wiersz po wierszu, dół kolumna po kolumnie, narożniki dolne
/// kolorem komórki narożnej; sąsiednie kawałki w tym samym kolorze sklejone. Krawędzie stoją na pełnych pikselach.
/// Pas rozszerzony nachodzi na skrajne komórki o jeden piksel (ten sam kolor): arkusz okna stoi na ułamku piksela,
/// a styk bez zakładki wygładza się do ciemnej kreski. Pas nierozszerzony (w tle terminala)
/// zaczyna się dopiero za siatką, żeby nie zamalować ostatniego piksela kolorowej komórki.
public enum TerminalEdgeBands {
  public struct Band: Equatable, Sendable {
    public var rect: CGRect
    public var color: TerminalEdgeColor

    public init(rect: CGRect, color: TerminalEdgeColor) {
      self.rect = rect
      self.color = color
    }
  }

  /// Pasy wokół siatki `cols` × `rows`.
  /// - Parameters:
  ///   - area: cały obszar pasa (ekran razem z pasem okna); wszystkie ramki w jego układzie.
  ///   - grid: ramka pełnych komórek siatki.
  ///   - surface: ramka widoku powierzchni; wąski pas między nią a siatką rysuje sam renderer.
  ///   - bottomLimit: dolna granica pasa pod siatką — górna krawędź paska klawiszy albo dół obszaru.
  ///   - scale: skala ekranu (piksele na punkt).
  /// Wiersz albo kolumna bez koloru (odczyt sprzed zmiany siatki) to pas nierozszerzony.
  public static func layout(
    edges: TerminalEdges, area: CGRect, grid: CGRect, cols: Int, rows: Int, surface: CGRect, bottomLimit: CGFloat,
    scale: CGFloat
  ) -> [Band] {
    guard cols > 0, rows > 0, grid.width > 0, grid.height > 0, scale > 0, !area.isEmpty else { return [] }
    func down(_ value: CGFloat) -> CGFloat { (value * scale).rounded(.down) / scale }
    func up(_ value: CGFloat) -> CGFloat { (value * scale).rounded(.up) / scale }
    func near(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }
    let cellWidth = grid.width / CGFloat(cols)
    let cellHeight = grid.height / CGFloat(rows)
    let pixel = 1 / scale
    // Granice pasa przy siatce: rozszerzony z pikselem zakładki, nierozszerzony za siatką. Prawy bok i dół przy
    // zaznaczeniu zaczynają się dopiero za powierzchnią (wąski pas wewnątrz należy do uchwytów SwiftTerm).
    func leftEnd(_ extends: Bool) -> CGFloat { extends ? up(grid.minX) + pixel : down(grid.minX) }
    func rightStart(_ extends: Bool) -> CGFloat {
      if edges.selecting { return max(down(max(surface.maxX, grid.maxX)), up(grid.maxX)) }
      return extends ? down(grid.maxX) - pixel : up(grid.maxX)
    }
    let extendsDown = edges.bottom != nil
    let bottomTop = extendsDown ? down(grid.maxY) - pixel : up(grid.maxY)
    let columnsTop = edges.selecting ? max(bottomTop, down(surface.maxY)) : bottomTop
    let limit = min(bottomLimit, area.maxY)
    var bands: [Band] = []

    func add(_ rect: CGRect, _ color: TerminalEdgeColor) {
      guard rect.width > 0, rect.height > 0 else { return }
      // Sklejanie: ten sam kolor tuż obok (ten sam rząd albo ta sama kolumna pasa).
      if let last = bands.last, last.color == color {
        let sameRow = last.rect.minY == rect.minY && last.rect.maxY == rect.maxY && last.rect.maxX == rect.minX
        let sameColumn = last.rect.minX == rect.minX && last.rect.maxX == rect.maxX && last.rect.maxY == rect.minY
        if sameRow || sameColumn {
          bands[bands.count - 1].rect = last.rect.union(rect)
          return
        }
      }
      bands.append(Band(rect: rect, color: color))
    }
    /// Kolor rozszerzonego wiersza albo kolumny; `nil` = pas nierozszerzony.
    func extended(_ colors: [TerminalEdgeColor?]?, _ index: Int) -> TerminalEdgeColor? {
      guard let colors, colors.indices.contains(index) else { return nil }
      return colors[index]
    }

    let rowEdges = (0...rows).map { near(grid.minY + CGFloat($0) * cellHeight) }
    for row in 0..<rows {
      let y = rowEdges[row]
      let height = rowEdges[row + 1] - y
      let leading = extended(edges.leading, row)
      let left = leftEnd(leading != nil)
      add(CGRect(x: area.minX, y: y, width: left - area.minX, height: height), leading ?? edges.background)
    }
    for row in 0..<rows {
      let y = rowEdges[row]
      let height = rowEdges[row + 1] - y
      let trailing = extended(edges.trailing, row)
      let right = rightStart(trailing != nil)
      add(CGRect(x: right, y: y, width: area.maxX - right, height: height), trailing ?? edges.background)
    }

    guard limit > bottomTop else { return bands }
    let bottom = edges.bottom.map { $0.map(Optional.some) }
    let left = leftEnd(extendsDown)
    let right = rightStart(extendsDown)
    add(
      CGRect(x: area.minX, y: bottomTop, width: left - area.minX, height: limit - bottomTop),
      extended(bottom, 0) ?? edges.background)
    if limit > columnsTop, right > left {
      var start = left
      for column in 0..<cols {
        let end = column == cols - 1 ? right : min(max(near(grid.minX + CGFloat(column + 1) * cellWidth), left), right)
        add(
          CGRect(x: start, y: columnsTop, width: end - start, height: limit - columnsTop),
          extended(bottom, column) ?? edges.background)
        start = end
      }
    }
    add(
      CGRect(x: right, y: bottomTop, width: area.maxX - right, height: limit - bottomTop),
      extended(bottom, cols - 1) ?? edges.background)
    return bands
  }
}
