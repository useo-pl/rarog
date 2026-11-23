#if os(iOS)
import UIKit

// Tabela markdownu w tekście wiadomości: załącznik TextKit 2 z widokiem, który
// przewija SZEROKĄ tabelę w poziomie we własnym pudełku — transkrypt nigdy nie jedzie bokiem.
// Komórka ma szerokość najszerszej treści w kolumnie, aż do sufitu (``MarkdownTableGeometry``),
// za nim zawija. Siatkę niosą wyłącznie poziome kreski: pionowe przy gęstych
// danych robią kratownicę. Dla pola wiadomości tabela jest jednym znakiem: zaznaczenie przez nią
// bierze ją całą, a do schowka idzie jej markdown (``MarkdownReplacement``). W środku tabela ma
// WŁASNE pole tekstu (``MarkdownTableText``): zaznacza się przez komórki i wiersze, kursor nad nią
// ma wysokość linii tabeli, a link w komórce otwiera się jak w treści.
// Właściciel: transkrypt, markdown.

/// Pisma i kolor tabeli (cichsza stopniem niż treść).
struct MarkdownTableLook {
  let fonts: MarkdownFonts
  let color: UIColor

  var body: UIFont { fonts.table }
  var header: UIFont { fonts.table.with(bold: true, italic: false) }
}

/// Geometria i tekst tabeli dla danej szerokości dostępnej.
struct MarkdownTableGrid {
  static let columnGap: CGFloat = 16
  static let rowPadding: CGFloat = 6
  /// Zapas szerokości pola tekstu tabeli za ostatnią kolumną: linie są złamane z góry, a ułamek punktu różnicy pomiaru
  /// nie może złamać żadnej drugi raz. Zapas leży poza treścią przewijania, więc go nie widać.
  static let slack: CGFloat = 64

  /// Tekst tabeli dla jej pola (``MarkdownTableText``).
  let text: NSAttributedString
  let columns: [CGFloat]
  /// Zasięg glifów każdego wiersza od góry pola tabeli (z górną wstawką).
  let rows: [ClosedRange<CGFloat>]
  let height: CGFloat

  var width: CGFloat { columns.reduce(0, +) + Self.columnGap * CGFloat(max(columns.count - 1, 0)) }

  /// Kreski między wierszami: w pół drogi między dołem wiersza a górą następnego.
  var separators: [CGFloat] {
    zip(rows, rows.dropFirst()).map { ($0.upperBound + $1.lowerBound) / 2 }
  }

  init(table: MarkdownTable, look: MarkdownTableLook, available: CGFloat) {
    let header = table.header.map { Self.cell($0, font: look.header, color: Palette.muted, look: look) }
    let body = table.rows.map { row in row.map { Self.cell($0, font: look.body, color: look.color, look: look) } }
    let cells = [header] + body
    let natural = cells.map { row in
      row.map { Double($0.boundingRect(with: CGSize(width: 100_000, height: 1_000), options: [.usesLineFragmentOrigin], context: nil).width) }
    }
    columns = MarkdownTableGeometry.columnWidths(natural: natural, available: Double(available)).map { CGFloat($0) }
    text = MarkdownTableText.text(
      rows: cells, columns: columns, gap: Self.columnGap, alignments: table.alignments, rowGap: 2 * Self.rowPadding,
      layout: [.font: look.body, .foregroundColor: look.color])
    let width = columns.reduce(0, +) + Self.columnGap * CGFloat(max(columns.count - 1, 0))
    let extents = MarkdownTableText.rowExtents(text, width: width + Self.slack)
    rows = extents.map { ($0.lowerBound + Self.rowPadding)...($0.upperBound + Self.rowPadding) }
    height = ((extents.last?.upperBound ?? 0) + 2 * Self.rowPadding).rounded(.up)
  }

  private static func cell(_ text: String, font: UIFont, color: UIColor, look: MarkdownTableLook) -> NSAttributedString {
    MarkdownRenderer.inline(MarkdownInlineParser.spans(text), font: font, fonts: look.fonts, color: color)
  }
}

/// Załącznik tabeli: model i pamięć geometrii dla ostatniej szerokości.
final class MarkdownTableAttachment: NSTextAttachment {
  let table: MarkdownTable
  let look: MarkdownTableLook
  private var cached: (width: CGFloat, grid: MarkdownTableGrid)?

  init(table: MarkdownTable, look: MarkdownTableLook) {
    self.table = table
    self.look = look
    super.init(data: nil, ofType: nil)
    allowsTextAttachmentView = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  func grid(width: CGFloat) -> MarkdownTableGrid {
    if let cached, cached.width == width { return cached.grid }
    let grid = MarkdownTableGrid(table: table, look: look, available: width)
    cached = (width, grid)
    return grid
  }

  /// Miejsce w tekście: cała szerokość linii, wysokość siatki.
  func bounds(proposedWidth: CGFloat) -> CGRect {
    let width = max(proposedWidth, 1)
    // Dół tabeli na linii zejścia pisma: wiersz tekstu nie dokłada pod tabelą pustego pasa.
    return CGRect(x: 0, y: look.fonts.body.descender, width: width, height: grid(width: width).height)
  }

  override func viewProvider(
    for parentView: UIView?, location: any NSTextLocation, textContainer: NSTextContainer?
  ) -> NSTextAttachmentViewProvider? {
    let provider = MarkdownTableViewProvider(
      textAttachment: self, parentView: parentView, textLayoutManager: textContainer?.textLayoutManager, location: location)
    // Miejsce w tekście daje dostawca (``MarkdownTableViewProvider/attachmentBounds``), nie obrazek
    // załącznika — bez tego zostaje domyślny rozmiar ikony pliku i widok tabeli jest przycięty.
    provider.tracksTextAttachmentViewBounds = true
    return provider
  }
}

final class MarkdownTableViewProvider: NSTextAttachmentViewProvider {
  override func loadView() {
    guard let found = textAttachment as? MarkdownTableAttachment else { return }
    // Widok powstaje przy układzie tekstu `UITextView`, czyli na wątku głównym — tam też żyje
    // załącznik (TextKit nie układa tekstu widoku poza nim).
    nonisolated(unsafe) let attachment = found
    view = MainActor.assumeIsolated { MarkdownTableView(attachment: attachment) }
  }

  override func attachmentBounds(
    for attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?,
    proposedLineFragment: CGRect, position: CGPoint
  ) -> CGRect {
    // Tabela w pytaniu i w cytacie stoi za kreską: TextKit proponuje linię na całą szerokość kontenera także
    // przy wcięciu akapitu (pomiar w pytaniu: 568 pt przy wcięciu 14 pt, tabela wystawałaby za prawą
    // krawędź pola).
    let indent = (attributes[.paragraphStyle] as? NSParagraphStyle)?.firstLineHeadIndent ?? 0
    let width = min(proposedLineFragment.width, (textContainer?.size.width ?? proposedLineFragment.width) - indent)
    return (textAttachment as? MarkdownTableAttachment)?.bounds(proposedWidth: width) ?? .zero
  }
}

/// Widok tabeli: przewijany w poziomie, gdy jest szerszy od kolumny tekstu; w środku pole tekstu tabeli i kreski.
final class MarkdownTableView: UIScrollView {
  private let attachment: MarkdownTableAttachment
  /// Tekst tabeli w jednym polu: zaznaczanie przez komórki i wiersze, kopia komórkami (``MarkdownPlainText``) i powrót
  /// fokusu po kopii kursorem jak w polu wiadomości (``MessageTextView``).
  let textView = MessageTextView(usingTextLayoutManager: true)
  private var lines: [UIView] = []
  private var shownText: NSAttributedString?
  private var builtWidth: CGFloat = -1
  /// Tła kodu w linii w komórkach rysują fragmenty układu (``MarkdownLayoutFragment``), jak w treści wiadomości.
  private let layoutDelegate = MarkdownLayoutDelegate()

  init(attachment: MarkdownTableAttachment) {
    self.attachment = attachment
    super.init(frame: .zero)
    showsVerticalScrollIndicator = false
    alwaysBounceVertical = false
    alwaysBounceHorizontal = false
    isDirectionalLockEnabled = true
    backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: MarkdownTableGrid.rowPadding, left: 0, bottom: MarkdownTableGrid.rowPadding, right: 0)
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.adjustsFontForContentSizeCategory = false
    // Wygląd linku niesie tekst (jak w treści), nie odcień widoku.
    textView.linkTextAttributes = [:]
    textView.textLayoutManager?.delegate = layoutDelegate
    // Menu zaznaczenia w komórkach to menu wiadomości, w której stoi tabela (z „Zaznacz więcej…”).
    textView.delegate = self
    addSubview(textView)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
      (self: MarkdownTableView, _: UITraitCollection) in
      self.refreshCodeColors()
    }
    // Czytnik słyszy tabelę z pola wiadomości, komórkami (``MarkdownLayout/spokenTable(_:)``) — drugi raz nie.
    accessibilityElementsHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.width != builtWidth else { return }
    builtWidth = bounds.width
    build(attachment.grid(width: bounds.width))
  }

  private func build(_ grid: MarkdownTableGrid) {
    let width = max(grid.width, bounds.width)
    contentSize = CGSize(width: width, height: grid.height)
    // Tło kodu w linii na początku pierwszej kolumny wystaje oddechem przed tabelę, jak w treści; przycina je tylko
    // tabela przewijana w poziomie.
    clipsToBounds = grid.width > bounds.width
    if shownText !== grid.text {
      shownText = grid.text
      layoutDelegate.colors = MarkdownColors.resolved(for: traitCollection)
      textView.attributedText = grid.text
    }
    textView.frame = CGRect(x: 0, y: 0, width: width + MarkdownTableGrid.slack, height: grid.height)
    let separators = grid.separators
    while lines.count < separators.count {
      let line = UIView()
      line.isUserInteractionEnabled = false
      insertSubview(line, belowSubview: textView)
      lines.append(line)
    }
    for (index, line) in lines.enumerated() {
      line.isHidden = index >= separators.count
      guard index < separators.count else { continue }
      line.frame = CGRect(x: 0, y: separators[index] - 0.25, width: grid.width, height: 0.5)
      // Pod nagłówkiem kreska wyraźniejsza, pod wierszami cichsza; ostatni wiersz bez kreski.
      line.backgroundColor = index == 0 ? Palette.muted2.withAlphaComponent(0.5) : Palette.border
    }
  }

  /// Zmiana motywu albo „Zwiększ kontrast”: fragmenty już ułożone dostają kolory wprost i przerysowują się (jak
  /// ``MessageContentView``).
  private func refreshCodeColors() {
    let colors = MarkdownColors.resolved(for: traitCollection)
    layoutDelegate.colors = colors
    guard let manager = textView.textLayoutManager else { return }
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: []) { fragment in
      (fragment as? MarkdownLayoutFragment)?.colors = colors
      return true
    }
    manager.invalidateLayout(for: manager.documentRange)
    textView.setNeedsLayout()
  }
}

extension MarkdownTableView: UITextViewDelegate {
  /// Zaznaczenie w komórce żyje w polu tabeli, nie w polu wiadomości, więc menu buduje wiadomość nad tabelą
  /// (``MessageContentView``). Tabela poza wiadomością (np. w pytaniu) zostaje przy menu systemu.
  func textView(
    _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    var view = superview
    while let current = view, !(current is MessageContentView) { view = current.superview }
    return (view as? MessageContentView)?.textView(textView, editMenuForTextIn: range, suggestedActions: suggestedActions)
  }
}
#endif
