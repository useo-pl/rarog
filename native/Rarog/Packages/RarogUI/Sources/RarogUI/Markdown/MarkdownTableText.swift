#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// Tabela markdownu jako JEDEN tekst (zaznaczanie przez komórki i wiersze; tabela z osobnych
// komórek daje nad sobą kursor wysoki na pół tabeli i nic się nie zaznacza). Wiersz tabeli to akapit, kolumny stoją na tabulatorach,
// a komórkę szerszą od kolumny łamie się tutaj: linia wiersza bierze k-tą linię każdej komórki, linie wiersza dzieli
// U+2028. Pole tekstu tabeli (``MarkdownTableView``) niczego więc nie zawija drugi raz, a zaznacza jak przeglądarka:
// od dowolnego miejsca do dowolnego, przez komórki i wiersze. Każdy znak niesie ``MarkdownTableCell``, więc do
// schowka idą komórki, nie układ (``MarkdownPlainText``). Bez widoku, więc testy biegną na macOS.
// Właściciel: transkrypt, markdown.

extension NSAttributedString.Key {
  /// Miejsce znaku w tekście tabeli (``MarkdownTableCell``).
  public static let rarogTableCell = NSAttributedString.Key("pl.useo.rarog.tableCell")
}

/// Miejsce znaku w tekście tabeli. Niesie je KAŻDY znak: kawałek komórki i znak układu (tabulator przed kolumną,
/// łamanie linii, koniec wiersza), więc schowek widzi też puste komórki i puste wiersze objęte zaznaczeniem.
/// Klasa z tożsamością: sąsiednie znaki nie sklejają się w jeden zakres.
public final class MarkdownTableCell: NSObject, Sendable {
  public let row: Int
  /// Kolumny, które znak obejmuje: zwykle jedną, a pierwszy znak linii także wszystkie przed nią — pusta pierwsza
  /// komórka nie ma własnego znaku, a zaznaczenie od początku linii ją bierze.
  public let columns: ClosedRange<Int>
  /// Kawałek tekstu komórki; `false` = znak układu, sam do schowka nie idzie.
  public let isText: Bool
  /// Białe znaki, które łamanie linii zjadło przed tym kawałkiem: w schowku wracają dokładnie te.
  public let gap: String

  /// Kolumna znaku (ostatnia z objętych).
  public var column: Int { columns.upperBound }

  public init(row: Int, columns: ClosedRange<Int>, isText: Bool, gap: String = "") {
    self.row = row
    self.columns = columns
    self.isText = isText
    self.gap = gap
  }
}

enum MarkdownTableText {
  /// Linie komórki złożonej w szerokości `width`: zakresy bez spacji i znaku łamania na końcu.
  static func lines(_ cell: NSAttributedString, width: CGFloat) -> [NSRange] {
    guard cell.length > 0 else { return [] }
    let storage = NSTextStorage(attributedString: cell)
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: max(width, 1), height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    layout.addTextContainer(container)
    storage.addLayoutManager(layout)
    let string = cell.string as NSString
    var out: [NSRange] = []
    layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, _, _, glyphs, _ in
      var range = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
      while range.length > 0, isSpace(string.character(at: NSMaxRange(range) - 1)) { range.length -= 1 }
      out.append(range)
    }
    return out
  }

  /// Tekst tabeli: wiersz `rows[r]` jako akapit z tabulatorami kolumn (``tabStops(columns:gap:alignments:)``),
  /// między wierszami `rowGap`. Tabulatory, łamania linii i końce wierszy biorą atrybuty `layout` (pismo tabeli bez
  /// linku i tła kodu).
  static func text(
    rows: [[NSAttributedString]], columns: [CGFloat], gap: CGFloat, alignments: [MarkdownTable.Alignment?],
    rowGap: CGFloat, layout: [NSAttributedString.Key: Any]
  ) -> NSAttributedString {
    let stops = tabStops(columns: columns, gap: gap, alignments: alignments)
    let leadingTab = alignment(alignments, columns: columns, column: 0) != nil
    let last = max(columns.count - 1, 0)
    let out = NSMutableAttributedString()
    for (row, cells) in rows.enumerated() {
      let start = out.length
      let wrapped = columns.indices.map { column in
        column < cells.count ? lines(cells[column], width: columns[column]) : []
      }
      for line in 0..<max(wrapped.map(\.count).max() ?? 0, 1) {
        if line > 0 { out.append(mark("\u{2028}", row: row, columns: last...last, layout: layout)) }
        var lineStart = true
        for column in columns.indices {
          let covered = (lineStart ? 0 : column)...column
          // Pierwsza kolumna do lewej zaczyna linię; każda inna stoi na swoim tabulatorze.
          if column > 0 || leadingTab {
            out.append(mark("\t", row: row, columns: covered, layout: layout))
            lineStart = false
          }
          guard line < wrapped[column].count, wrapped[column][line].length > 0 else { continue }
          let range = wrapped[column][line]
          let cell = cells[column]
          let eaten = line > 0 ? NSMaxRange(wrapped[column][line - 1]) : range.location
          let piece = NSMutableAttributedString(attributedString: cell.attributedSubstring(from: range))
          let whole = NSRange(location: 0, length: piece.length)
          piece.removeAttribute(.paragraphStyle, range: whole)
          piece.addAttribute(.rarogTableCell, value: MarkdownTableCell(
            row: row, columns: covered, isText: true,
            gap: (cell.string as NSString).substring(with: NSRange(location: eaten, length: range.location - eaten))),
            range: whole)
          out.append(piece)
          lineStart = false
        }
      }
      if row < rows.count - 1 { out.append(mark("\n", row: row, columns: last...last, layout: layout)) }
      let paragraph = NSMutableParagraphStyle()
      paragraph.tabStops = stops
      // Linie złamane wyżej: pole tabeli niczego nie zawija, a ułamek punktu za kolumną nie spycha kawałka niżej.
      paragraph.lineBreakMode = .byClipping
      paragraph.paragraphSpacingBefore = row > 0 ? rowGap : 0
      out.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: start, length: out.length - start))
    }
    return out
  }

  /// Tabulatory kolumn: kolumna do lewej — na swoim początku, wyśrodkowana — w środku, do prawej — na końcu.
  /// Pierwsza kolumna do lewej tabulatora nie ma (zaczyna linię).
  static func tabStops(columns: [CGFloat], gap: CGFloat, alignments: [MarkdownTable.Alignment?]) -> [NSTextTab] {
    var stops: [NSTextTab] = []
    var x: CGFloat = 0
    for (column, width) in columns.enumerated() {
      switch alignment(alignments, columns: columns, column: column) {
      case .center: stops.append(NSTextTab(textAlignment: .center, location: x + width / 2))
      case .right: stops.append(NSTextTab(textAlignment: .right, location: x + width))
      case .left, nil: if column > 0 { stops.append(NSTextTab(textAlignment: .left, location: x)) }
      }
      x += width + gap
    }
    return stops
  }

  /// Pionowy zasięg glifów każdego wiersza (od góry pierwszej linii do dołu ostatniej) w układzie TextKit 2 tego samego
  /// tekstu w kontenerze szerokim na `width` — z niego wysokość pola tabeli i kreski między wierszami.
  static func rowExtents(_ text: NSAttributedString, width: CGFloat) -> [ClosedRange<CGFloat>] {
    let storage = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    storage.addTextLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: max(width, 1), height: 0))
    container.lineFragmentPadding = 0
    manager.textContainer = container
    storage.attributedString = text
    var out: [ClosedRange<CGFloat>] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      let frame = fragment.layoutFragmentFrame
      let lines = fragment.textLineFragments.map { $0.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY) }
      if let top = lines.map(\.minY).min(), let bottom = lines.map(\.maxY).max() { out.append(top...bottom) }
      return true
    }
    return out
  }

  /// Wyrównanie kolumny w układzie; `nil` = do lewej. Pusta pierwsza kolumna (szerokość 0) stoi do lewej: jej tabulator
  /// w punkcie 0 nie zadziała (tabulator idzie do punktu ZA kursorem) i przesunąłby wszystkie kolumny o jedną.
  private static func alignment(
    _ alignments: [MarkdownTable.Alignment?], columns: [CGFloat], column: Int
  ) -> MarkdownTable.Alignment? {
    guard column < alignments.count, column < columns.count, column > 0 || columns[0] > 0 else { return nil }
    return alignments[column] == .left ? nil : alignments[column]
  }

  /// Znak układu (tabulator, łamanie linii, koniec wiersza) z miejscem w tabeli.
  private static func mark(
    _ character: String, row: Int, columns: ClosedRange<Int>, layout: [NSAttributedString.Key: Any]
  ) -> NSAttributedString {
    var attributes = layout
    attributes[.rarogTableCell] = MarkdownTableCell(row: row, columns: columns, isText: false)
    return NSAttributedString(string: character, attributes: attributes)
  }

  /// Spacja albo znak łamania (też U+2028).
  private static func isSpace(_ unit: unichar) -> Bool {
    Unicode.Scalar(unit).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false
  }
}
