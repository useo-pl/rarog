@testable import RarogUI
import UIKit
import XCTest

/// Tabela w wiadomości ma własne pole tekstu, bo we wspólnym polu kursor nad tabelą jest wysoki na pół tabeli
/// i nic się nie zaznacza. Pole tabeli zaznacza przez komórki i wiersze, kursor nad nim ma wysokość linii tabeli,
/// kreski siatki stoją między wierszami tekstu, a kopia idzie komórkami. Właściciel: transkrypt, markdown.
@MainActor
final class MarkdownTableSelectionTests: XCTestCase {
  static let markdown = """
    Decyzje do podjęcia:

    | | Pytanie | Rekomendacja |
    |---|---|---|
    | D1 | Token joba: plik 600 pod `denyRead` czy pęk kluczy | plik |
    | D2 | Token CLI użytkownika: `keyring logout` po sesji czy stały, z długim dopiskiem, który w wąskiej kolumnie musi się zawinąć na kilka linii | logout |
    | D3 | Szczegóły w [dokumentacji](https://example.com/doc) | tak |

    Akapit pod tabelą.
    """

  private func host(width: CGFloat) throws -> (UIWindow, UITextView, MarkdownTableView) {
    let style = TranscriptProseWidthTests.style(.large)
    let config = MessageContentConfiguration(
      voice: nil, text: MarkdownCache().text(Self.markdown, style: style), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m2.0", accessibilityPrefix: UICopy.rolePrefix(.assistant))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 2_000))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let view = config.makeContentView()
    root.view.addSubview(view)
    view.frame = CGRect(x: 0, y: 0, width: width, height: 1_800)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let outer = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first)
    outer.textLayoutManager?.ensureLayout(for: outer.textLayoutManager!.documentRange)
    outer.layoutIfNeeded()
    let table = try XCTUnwrap(TranscriptLeadingTests.views(of: MarkdownTableView.self, in: outer).first, "widok tabeli")
    table.layoutIfNeeded()
    return (window, outer, table)
  }

  /// Środek napisu `needle` w polu tabeli, we współrzędnych pola tabeli.
  private func point(of needle: String, in field: UITextView) throws -> CGPoint {
    let range = (field.text as NSString).range(of: needle)
    XCTAssertNotEqual(range.location, NSNotFound, needle)
    let start = try XCTUnwrap(field.position(from: field.beginningOfDocument, offset: range.location))
    let end = try XCTUnwrap(field.position(from: start, offset: range.length))
    let rect = field.firstRect(for: try XCTUnwrap(field.textRange(from: start, to: end)))
    return CGPoint(x: rect.midX, y: rect.midY)
  }

  /// Pole tabeli: tekst do zaznaczania, nie do edycji, schowane przed czytnikiem (czytnik słyszy tabelę z pola wiadomości).
  func testTableIsOneSelectableField() throws {
    let (window, outer, table) = try host(width: 900)
    defer { window.isHidden = true }
    let field = table.textView
    XCTAssertTrue(field.isSelectable)
    XCTAssertFalse(field.isEditable)
    XCTAssertTrue(field.text.contains("keyring logout"))
    XCTAssertTrue(table.accessibilityElementsHidden)
    XCTAssertTrue(outer.accessibilityLabel?.contains("Rekomendacja") ?? false, "tabela dla czytnika z pola wiadomości")
  }

  /// Wskaźnik nad komórką trafia w pole tabeli: kursor tekstowy wysoki na linię tabeli, nie na pół tabeli.
  func testPointerOverCellHitsTableField() throws {
    let (window, outer, table) = try host(width: 900)
    defer { window.isHidden = true }
    let field = table.textView
    let inCell = field.convert(try point(of: "pęk kluczy", in: field), to: outer)
    var hit = outer.hitTest(inCell, with: nil)
    while let view = hit, view !== field, view !== outer { hit = view.superview }
    XCTAssertTrue(hit === field, "punkt w komórce należy do pola tabeli")

    let caret = field.caretRect(for: try XCTUnwrap(field.position(from: field.beginningOfDocument, offset: 5)))
    let line = MarkdownFonts(style: TranscriptProseWidthTests.style(.large)).table.lineHeight
    XCTAssertLessThan(caret.height, 1.6 * line, "kursor tekstowy na wysokość linii tabeli: \(caret.height)")
    XCTAssertGreaterThan(table.bounds.height, 4 * caret.height, "tabela dużo wyższa od linii")
    TranscriptProseWidthTests.shoot(window, name: "tabela-szeroka", test: self)
  }

  /// Wąska kolumna: komórka D2 łamie się na kilka linii, a kreski siatki stoją w odstępach między wierszami tekstu, który
  /// pole tabeli NAPRAWDĘ ułożyło (siatka liczona osobnym układem musi się z nim zgadzać). Tekst mieści się w polu.
  func testGridMatchesFieldLayout() throws {
    let (window, _, table) = try host(width: 420)
    defer { window.isHidden = true }
    let field = table.textView
    let manager = try XCTUnwrap(field.textLayoutManager)
    manager.ensureLayout(for: manager.documentRange)
    var rows: [ClosedRange<CGFloat>] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      let frame = fragment.layoutFragmentFrame
      let lines = fragment.textLineFragments.map { $0.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY) }
      if let top = lines.map(\.minY).min(), let bottom = lines.map(\.maxY).max() {
        rows.append((top + field.textContainerInset.top)...(bottom + field.textContainerInset.top))
      }
      return true
    }
    XCTAssertEqual(rows.count, 4, "nagłówek i trzy wiersze")
    let wrapped = try XCTUnwrap(rows[safe: 2])
    XCTAssertGreaterThan(wrapped.upperBound - wrapped.lowerBound, 2.5 * (rows[0].upperBound - rows[0].lowerBound), "D2 zawinięte")
    let lines = table.subviews.filter { $0 !== field && !$0.isHidden && $0.bounds.height <= 0.5 && $0.bounds.width > 0 }
      .map(\.frame.midY).sorted()
    XCTAssertEqual(lines.count, 3, "kreski między czterema wierszami")
    for (index, y) in lines.enumerated() {
      XCTAssertGreaterThan(y, rows[index].upperBound, "kreska \(index) pod wierszem")
      XCTAssertLessThan(y, rows[index + 1].lowerBound, "kreska \(index) nad następnym wierszem")
    }
    XCTAssertLessThanOrEqual(rows.last!.upperBound + field.textContainerInset.bottom, table.bounds.height + 0.5, "nic nie ucięte")
    XCTAssertEqual(field.frame.height, table.bounds.height, accuracy: 0.5)
    TranscriptProseWidthTests.shoot(window, name: "tabela-waska", test: self)
  }

  /// Zaznaczenie w tabeli idzie do schowka komórkami: tabulator między komórkami, nowa linia między wierszami,
  /// zawinięta komórka w jednym kawałku, bez znaczników markdownu. Runner testów bez apki nie może czytać schowka, więc
  /// treść liczy ta sama droga co `copy(_:)` pola (``MarkdownPlainText``), a zapis widać po liczniku zmian schowka.
  func testCopyFromTableGoesCellByCell() throws {
    let (window, _, table) = try host(width: 420)
    defer { window.isHidden = true }
    let field = table.textView
    let text = field.text as NSString
    let start = text.range(of: "D1").location
    // Do końca OSTATNIEJ linii wiersza D2: „logout” z trzeciej kolumny stoi w jego pierwszej linii, więc zaznaczenie do
    // niego wzięłoby tylko pierwszą linię zawiniętej komórki — tak, jak widać na ekranie.
    let end = NSMaxRange(text.range(of: "linii"))
    field.selectedRange = NSRange(location: start, length: end - start)
    let before = UIPasteboard.general.changeCount
    field.copy(nil)
    XCTAssertGreaterThan(UIPasteboard.general.changeCount, before, "kopia poszła do schowka")
    let copied = MarkdownPlainText.copy(field.attributedText.attributedSubstring(from: field.selectedRange))
    let lines = copied.components(separatedBy: "\n")
    XCTAssertEqual(lines.count, 2, copied)
    XCTAssertEqual(lines.first, "D1\tToken joba: plik 600 pod denyRead czy pęk kluczy\tplik")
    XCTAssertTrue(lines.last?.hasPrefix("D2\tToken CLI użytkownika: keyring logout po sesji czy stały, z długim dopiskiem") ?? false, copied)
    XCTAssertTrue(lines.last?.hasSuffix("na kilka linii\tlogout") ?? false, copied)
    XCTAssertFalse(copied.contains("\u{2028}"), "bez łamań układu")
  }
}

extension Array {
  fileprivate subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
