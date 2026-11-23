#if os(macOS)
import AppKit
@testable import RarogUI
import Testing

@Suite("markdown: tabela jako jeden tekst — zaznaczanie przez komórki i wiersze, kopia komórkami")
struct MarkdownTableTextTests {
  private let font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
  private var advance: CGFloat { ("m" as NSString).size(withAttributes: [.font: font]).width }
  private var layout: [NSAttributedString.Key: Any] { [.font: font] }

  private func cell(_ text: String) -> NSAttributedString {
    NSAttributedString(string: text, attributes: [.font: font])
  }

  /// Szerokość `n` znaków pisma stałej szerokości.
  private func chars(_ n: Int) -> CGFloat { advance * CGFloat(n) }

  private func table(
    _ rows: [[String]], columns: [Int], alignments: [MarkdownTable.Alignment?] = [], gap: CGFloat = 16
  ) -> NSAttributedString {
    MarkdownTableText.text(
      rows: rows.map { $0.map(cell) }, columns: columns.map(chars), gap: gap, alignments: alignments, rowGap: 12,
      layout: layout)
  }

  /// Kawałki tekstu komórek w kolejności tekstu: „wiersz,kolumna:tekst”.
  private func pieces(_ text: NSAttributedString) -> [String] {
    var out: [String] = []
    text.enumerateAttribute(.rarogTableCell, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      guard let piece = value as? MarkdownTableCell, piece.isText else { return }
      out.append("\(piece.row),\(piece.column):\((text.string as NSString).substring(with: range))")
    }
    return out
  }

  /// Czy każdy znak tekstu tabeli niesie miejsce w tabeli.
  private func everyCharacterMarked(_ text: NSAttributedString) -> Bool {
    var marked = true
    text.enumerateAttribute(.rarogTableCell, in: NSRange(location: 0, length: text.length)) { value, _, _ in
      if value == nil { marked = false }
    }
    return marked
  }

  private func copy(_ text: NSAttributedString, _ range: NSRange? = nil) -> String {
    MarkdownPlainText.copy(text.attributedSubstring(from: range ?? NSRange(location: 0, length: text.length)))
  }

  /// Zakres napisu `needle` w tekście.
  private func range(of needle: String, in text: NSAttributedString) -> NSRange {
    (text.string as NSString).range(of: needle)
  }

  // MARK: - Łamanie komórki

  @Test("komórka łamie się na granicy słowa, bez spacji na końcu linii")
  func wrapsAtWords() {
    let text = cell("alpha beta gamma")
    let lines = MarkdownTableText.lines(text, width: chars(11)).map { (text.string as NSString).substring(with: $0) }
    #expect(lines == ["alpha beta", "gamma"])
  }

  @Test("token dłuższy od kolumny łamie się po znaku, a pusta komórka nie ma linii")
  func wrapsLongToken() {
    let text = cell("abcdefghij")
    let lines = MarkdownTableText.lines(text, width: chars(4)).map { (text.string as NSString).substring(with: $0) }
    #expect(lines == ["abcd", "efgh", "ij"])
    #expect(MarkdownTableText.lines(cell(""), width: chars(4)).isEmpty)
  }

  // MARK: - Tekst tabeli

  @Test("wiersz to akapit, kolumny na tabulatorach; każdy znak, także układu, niesie miejsce w tabeli")
  func rowsAndTabs() throws {
    let text = table([["A", "B"], ["x", "y"]], columns: [10, 10])
    #expect(text.string == "A\tB\nx\ty")
    #expect(pieces(text) == ["0,0:A", "0,1:B", "1,0:x", "1,1:y"])
    #expect(everyCharacterMarked(text))
    let style = try #require(text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
    #expect(style.tabStops.map(\.location) == [chars(10) + 16])
    #expect(style.tabStops.map(\.alignment) == [.left])
    let second = try #require(text.attribute(.paragraphStyle, at: text.length - 1, effectiveRange: nil) as? NSParagraphStyle)
    #expect(second.paragraphSpacingBefore == 12, "odstęp między wierszami")
    #expect(style.paragraphSpacingBefore == 0, "pierwszy wiersz bez odstępu nad sobą")
  }

  @Test("komórka zawinięta: linia wiersza bierze k-tą linię każdej komórki, pusta kolumna zostaje tabulatorem")
  func wrappedRow() {
    let text = table([["alpha beta", "z"]], columns: [6, 10])
    #expect(text.string == "alpha\tz\u{2028}beta\t")
    #expect(pieces(text) == ["0,0:alpha", "0,1:z", "0,0:beta"])
  }

  @Test("pierwsza kolumna do prawej albo na środku też stoi na tabulatorze")
  func alignedFirstColumn() throws {
    let text = table([["1", "a"]], columns: [4, 6], alignments: [.right, .center])
    #expect(text.string == "\t1\ta")
    let style = try #require(text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
    #expect(style.tabStops.map(\.alignment) == [.right, .center])
    #expect(style.tabStops.map(\.location) == [chars(4), chars(4) + 16 + chars(6) / 2])
  }

  // MARK: - Schowek

  @Test("cała tabela do schowka: tabulator między komórkami, nowa linia między wierszami")
  func copyWhole() {
    #expect(copy(table([["A", "B"], ["x", "y"]], columns: [10, 10])) == "A\tB\nx\ty")
  }

  @Test("fragment jednej komórki idzie do schowka bez układu")
  func copyInsideCell() {
    let text = table([["keyring logout", "tak"]], columns: [20, 10])
    #expect(copy(text, range(of: "keyring logout", in: text)) == "keyring logout")
    #expect(copy(text, range(of: "yrin", in: text)) == "yrin")
  }

  @Test("zawinięta komórka wraca do schowka w jednym kawałku, słowo złamane w środku bez spacji")
  func copyWrapped() {
    #expect(copy(table([["alpha beta", "z"]], columns: [6, 10])) == "alpha beta\tz")
    #expect(copy(table([["abcdefghij", "z"]], columns: [4, 10])) == "abcdefghij\tz")
  }

  @Test("pusta komórka między zaznaczonymi zostaje pusta — wklejka do arkusza trafia w kolumny")
  func copyEmptyMiddle() {
    #expect(copy(table([["a", "", "c"]], columns: [4, 4, 4])) == "a\t\tc")
  }

  @Test("pusta komórka na skraju i pusty wiersz zostają na swoim miejscu (nagłówek z pustą pierwszą kolumną)")
  func copyEmptyEdgesAndRows() {
    let text = table([["", "B", "C"], ["a", "b", "c"], ["", "", ""], ["x", "y", ""]], columns: [4, 4, 4])
    #expect(copy(text) == "\tB\tC\na\tb\tc\n\t\t\nx\ty\t")
  }

  @Test("zaznaczenie od początku drugiej linii wiersza bierze jej pustą pierwszą kolumnę")
  func copyFromLineStart() {
    let text = table([["a", "alpha beta"]], columns: [4, 6])
    #expect(text.string == "a\talpha\u{2028}\tbeta")
    let start = NSMaxRange(range(of: "\u{2028}", in: text))
    #expect(copy(text, NSRange(location: start, length: text.length - start)) == "\tbeta")
  }

  @Test("łamanie zawiniętego kodu nie zjada spacji: wracają dokładnie te, które stały w źródle")
  func copyWrappedKeepsSpaces() {
    let text = table([["aaaa   bbbb"]], columns: [6])
    #expect(text.string == "aaaa\u{2028}bbbb")
    #expect(copy(text) == "aaaa   bbbb")
  }

  @Test("zaznaczenie od środka wiersza do środka następnego bierze tylko zaznaczone komórki")
  func copyAcrossRows() {
    let text = table([["a1", "b1", "c1"], ["a2", "b2", "c2"]], columns: [4, 4, 4])
    let start = range(of: "1\tc1", in: text).location
    let end = NSMaxRange(range(of: "b2", in: text))
    #expect(copy(text, NSRange(location: start, length: end - start)) == "1\tc1\na2\tb2")
  }

  @Test("tekst bez komórek tabeli kopiuje się po staremu")
  func copyPlain() {
    #expect(MarkdownPlainText.tableCopy(cell("zwykły\u{2028}tekst")) == nil)
    #expect(MarkdownPlainText.copy(cell("zwykły\u{2028}tekst")) == "zwykły\ntekst")
  }

  // MARK: - Układ TextKit 2

  @Test("kolumny stoją tam, gdzie siatka: do lewej od początku kolumny, do prawej do jej końca")
  func columnsLineUp() throws {
    let columns = [8, 13, 6]
    let text = table(
      [["Nazwa", "Opis długi", "Ile"], ["q", "dzieli linie", "12345"]], columns: columns, alignments: [nil, .left, .right])
    let layout = TextKit2Layout(text, width: chars(columns.reduce(0, +)) + 2 * 16 + 64)
    let second = chars(8) + 16
    let third = second + chars(13) + 16
    #expect(abs(try layout.minX(of: range(of: "Opis", in: text)) - second) < 0.5)
    #expect(abs(try layout.minX(of: range(of: "dzieli", in: text)) - second) < 0.5)
    #expect(abs(try layout.maxX(of: range(of: "Ile", in: text)) - (third + chars(6))) < 0.5)
    #expect(abs(try layout.maxX(of: range(of: "12345", in: text)) - (third + chars(6))) < 0.5)
    #expect(abs(try layout.minX(of: range(of: "q", in: text)) - 0) < 0.5)
  }

  @Test("pusta pierwsza kolumna do prawej (szerokość 0) nie przesuwa kolumn")
  func emptyAlignedFirstColumn() throws {
    let text = MarkdownTableText.text(
      rows: [[cell(""), cell("B"), cell("C")]], columns: [0, chars(9), chars(10)], gap: 16, alignments: [.right, nil, nil],
      rowGap: 12, layout: layout)
    #expect(text.string == "\tB\tC")
    let typeset = TextKit2Layout(text, width: chars(19) + 2 * 16 + 64)
    #expect(abs(try typeset.minX(of: range(of: "B", in: text)) - 16) < 0.5)
    #expect(abs(try typeset.minX(of: range(of: "C", in: text)) - (16 + chars(9) + 16)) < 0.5)
  }

  @Test("zasięg wierszy: jeden na wiersz, zawinięty wyższy, między wierszami odstęp wiersza")
  func rowExtents() {
    let text = table([["A", "B"], ["alpha beta", "z"], ["x", "y"]], columns: [6, 10])
    let rows = MarkdownTableText.rowExtents(text, width: chars(16) + 16 + 64)
    #expect(rows.count == 3)
    let heights = rows.map { $0.upperBound - $0.lowerBound }
    #expect(heights[1] > heights[0] * 1.8, "zawinięty wiersz ma dwie linie")
    #expect(abs(heights[2] - heights[0]) < 0.5)
    for (upper, lower) in zip(rows, rows.dropFirst()) {
      #expect(abs(lower.lowerBound - upper.upperBound - 12) < 0.5, "odstęp wiersza")
    }
    #expect(rows[0].lowerBound < 0.5, "pierwszy wiersz od góry")
  }
}

/// Układ TextKit 2 tekstu w kontenerze `width`: krawędzie zakresu z segmentów zaznaczenia.
private struct TextKit2Layout {
  let storage = NSTextContentStorage()
  let manager = NSTextLayoutManager()

  init(_ text: NSAttributedString, width: CGFloat) {
    storage.addTextLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: width, height: 0))
    container.lineFragmentPadding = 0
    manager.textContainer = container
    storage.attributedString = text
    manager.ensureLayout(for: manager.documentRange)
  }

  func minX(of range: NSRange) throws -> CGFloat { try frames(range).map(\.minX).min() ?? .nan }
  func maxX(of range: NSRange) throws -> CGFloat { try frames(range).map(\.maxX).max() ?? .nan }

  private func frames(_ range: NSRange) throws -> [CGRect] {
    let start = try #require(storage.location(storage.documentRange.location, offsetBy: range.location))
    let end = try #require(storage.location(start, offsetBy: range.length))
    let textRange = try #require(NSTextRange(location: start, end: end))
    var out: [CGRect] = []
    manager.enumerateTextSegments(in: textRange, type: .standard, options: []) { _, frame, _, _ in
      out.append(frame)
      return true
    }
    return out
  }
}
#endif
