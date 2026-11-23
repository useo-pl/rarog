#if os(iOS)
import UIKit

// Kreski markdownu i zaokrąglone tła kodu w linii rysowane fragmentami układu TextKit 2 (linia pozioma, kreski
// cytatu; tła kodu są półprzezroczyste, więc zaznaczenie pod widokiem fragmentu prześwituje) i geometria
// pudełka bloku kodu z paskiem (od krawędzi do krawędzi kontenera, nie pod samymi glifami). Akapit niesie
// ``MarkdownDecoration`` albo kod w linii w atrybucie, a delegat układu wiadomości daje mu ``MarkdownLayoutFragment``.
// Tło bloku kodu NIE jest rysowane we fragmencie: widok fragmentu leży nad podświetleniem zaznaczenia
// `UITextView`, więc kryjące tło by je zasłoniło i zaznaczenie kursorem w bloku kodu byłoby niewidoczne.
// Pudełko to widok POD tekstem (`MessageContentView`, `CodeBlockBox`).
// Właściciel: transkrypt, markdown.

extension NSAttributedString.Key {
  /// Ozdoba akapitu (``MarkdownDecoration``) — znacznik dla fragmentu układu TextKit 2.
  static let rarogDecoration = NSAttributedString.Key("pl.useo.rarog.decoration")
}

/// Ozdoba akapitu. Klasa z tożsamością: sąsiednie akapity o tej samej ozdobie zostają osobnymi
/// zakresami atrybutu.
final class MarkdownDecoration: NSObject, Sendable {
  enum Kind: Sendable, Equatable {
    case plain
    /// Pasek bloku kodu; `code` kopiuje ikona nad paskiem.
    case codeBar(code: String)
    case codeLine(first: Bool, last: Bool)
    case rule
  }

  let kind: Kind
  let quoteDepth: Int
  /// Ile kresek cytatu ciągnie się z poprzedniego akapitu (kreska przechodzi przez odstęp).
  let quoteJoins: Int
  /// Interlinia między tym akapitem a poprzednim, przez którą też ciągnie się kreska (poza odstępem akapitu).
  let joinGap: CGFloat
  /// Akapit pytania do użytkownika: pomarańczowa kreska przy lewej krawędzi, reszta ozdób za nią.
  let question: Bool
  /// Kreska pytania ciągnie się z poprzedniego akapitu (jak ``quoteJoins``).
  let questionJoins: Bool

  init(
    kind: Kind, quoteDepth: Int, quoteJoins: Int, joinGap: CGFloat = 0, question: Bool = false, questionJoins: Bool = false
  ) {
    self.kind = kind
    self.quoteDepth = quoteDepth
    self.quoteJoins = quoteJoins
    self.joinGap = joinGap
    self.question = question
    self.questionJoins = questionJoins
  }

  /// Lewa krawędź treści akapitu: za kreską pytania i kreskami cytatu (``MarkdownRenderer/leftIndent(question:quoteDepth:)``).
  var leftIndent: CGFloat { MarkdownRenderer.leftIndent(question: question, quoteDepth: quoteDepth) }
}

/// Kolory kresek i tła kodu w linii rozwiązane dla motywu widoku (fragment rysuje poza drzewem cech UIKit).
struct MarkdownColors: Sendable {
  var hairline: CGColor
  var quoteBar: CGColor
  var inlineCode: CGColor
  /// Kreska pytania do użytkownika: `wait` (świadomy wyjątek od „kolor = stan”, `docs/design.md`).
  var questionBar: CGColor

  static let placeholder = MarkdownColors(
    hairline: UIColor.gray.cgColor, quoteBar: UIColor.gray.cgColor, inlineCode: UIColor.clear.cgColor,
    questionBar: UIColor.gray.cgColor)

  /// Pasek bloku o ton od treści bloku, z włosem pod spodem.
  static let barFill = Palette.dynamic(dark: 0x242424, light: 0xDADAE0)

  @MainActor
  static func resolved(for traits: UITraitCollection) -> MarkdownColors {
    MarkdownColors(
      hairline: Palette.border.resolvedColor(with: traits).cgColor,
      quoteBar: Palette.border.resolvedColor(with: traits).cgColor,
      inlineCode: Palette.inlineCodeBackground.resolvedColor(with: traits).cgColor,
      questionBar: Palette.wait.resolvedColor(with: traits).cgColor)
  }
}

/// Fragment układu akapitu z ozdobą albo z kodem w linii.
final class MarkdownLayoutFragment: NSTextLayoutFragment {
  /// Oddech kodu nad pierwszą i pod ostatnią linią bloku.
  static let codePadding: CGFloat = 8
  /// Tło kodu w linii: oddech po bokach (miejsce na niego robi `.kern` w ``MarkdownRenderer/inline``), oddech nad
  /// wznoszeniem i pod zejściem pisma kodu, promień rogów.
  static let inlineCodeSide: CGFloat = 3
  static let inlineCodeTop: CGFloat = 1
  static let inlineCodeBottom: CGFloat = 2
  static let inlineCodeRadius: CGFloat = 4
  /// Znaki kończące linię bez glifu: kursor przed nimi stoi tuż za glifem, bez połowy odstępu `.kern`.
  private static let lineBreaks: Set<unichar> = [0x0A, 0x0D, 0x2028, 0x2029]

  var decoration: MarkdownDecoration?
  var colors = MarkdownColors.placeholder

  /// Linie akapitu w układzie fragmentu.
  private var lines: CGRect {
    var lines = CGRect.null
    for line in textLineFragments { lines = lines.union(line.typographicBounds) }
    return lines.isNull ? CGRect(origin: .zero, size: layoutFragmentFrame.size) : lines
  }

  private var containerWidth: CGFloat {
    textLayoutManager?.textContainer?.size.width ?? layoutFragmentFrame.width
  }

  /// Pudełko bloku kodu (pasek albo linia) w układzie kontenera tekstu — rysuje je `MessageContentView`.
  var codeBoxInContainer: CGRect? {
    codeBox?.offsetBy(dx: layoutFragmentFrame.minX, dy: layoutFragmentFrame.minY)
  }

  /// Pudełko bloku kodu (dla paska i linii) w układzie fragmentu.
  private var codeBox: CGRect? {
    guard let decoration else { return nil }
    let lines = lines
    let left = decoration.leftIndent - layoutFragmentFrame.minX
    let width = containerWidth - decoration.leftIndent
    switch decoration.kind {
    case .codeBar:
      return CGRect(x: left, y: lines.minY, width: width, height: lines.height)
    case let .codeLine(first, last):
      let top = first ? lines.minY - Self.codePadding : lines.minY
      // Linia nie-ostatnia zachodzi 1 pt na następną: kryjące tło bez włoskowatej szczeliny.
      let bottom = last ? lines.maxY + Self.codePadding : lines.maxY + 1
      return CGRect(x: left, y: top, width: width, height: bottom - top)
    case .plain, .rule:
      return nil
    }
  }

  private var paragraphStyle: NSParagraphStyle? {
    (textElement as? NSTextParagraph).flatMap {
      $0.attributedString.length > 0
        ? $0.attributedString.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        : nil
    }
  }

  /// Odstęp przed akapitem ze stylu akapitu: przez niego ciągnie się kreska z poprzedniego akapitu.
  private var spacingBefore: CGFloat { paragraphStyle?.paragraphSpacingBefore ?? 0 }

  /// Kreski cytatu: od góry linii (albo od dołu poprzedniego akapitu, gdy kreska się ciągnie), za kreską pytania.
  /// W układzie fragmentu.
  var quoteBars: [CGRect] {
    guard let decoration, decoration.quoteDepth > 0 else { return [] }
    let lines = lines
    let spacingBefore = spacingBefore
    let start = MarkdownRenderer.leftIndent(question: decoration.question, quoteDepth: 0)
    return (1...decoration.quoteDepth).map { level in
      let top = level <= decoration.quoteJoins ? lines.minY - spacingBefore - decoration.joinGap : lines.minY
      let x = start + CGFloat(level - 1) * MarkdownRenderer.quoteStep - layoutFragmentFrame.minX
      return CGRect(x: x, y: top, width: 2, height: lines.maxY - top)
    }
  }

  /// Kreska pytania do użytkownika: przy lewej krawędzi kontenera, od góry linii albo — gdy pytanie
  /// trwa od poprzedniego akapitu — od jego dołu, przez odstęp i interlinię, tak jak kreska cytatu. W dół sięga też
  /// przez odstęp PO akapicie (ma go ostatnia linia bloku kodu, `codePadding`): bez tego pod blokiem kodu w pytaniu
  /// zostaje 8-punktowa przerwa (`TranscriptQuestionTests`). W układzie fragmentu.
  var questionBar: CGRect? {
    guard let decoration, decoration.question else { return nil }
    let lines = lines
    let top = decoration.questionJoins ? lines.minY - spacingBefore - decoration.joinGap : lines.minY
    let bottom = lines.maxY + (paragraphStyle?.paragraphSpacing ?? 0)
    return CGRect(x: -layoutFragmentFrame.minX, y: top, width: MarkdownRenderer.questionBarWidth, height: bottom - top)
  }

  /// Tła kodu w linii w układzie fragmentu: po jednym na kawałek kodu w każdej linii, od glifu pierwszej litery do końca
  /// glifu ostatniej, z oddechem po bokach. Kawałek na początku linii wystaje oddechem przed kolumnę tekstu — kod trzyma
  /// krawędź akapitu; kawałek bez odstępu `.kern` za sobą (kod złamany na końcu linii, w komórce tabeli) wystaje za nią.
  ///
  /// Kursor między dwoma glifami TextKit 2 stawia w połowie odstępu `.kern` lewego znaku, a na końcu linii i przed
  /// znakiem nowej linii tuż za glifem (pomiar: `kod,` — 1 pt z 2 pt, `kod` na końcu — 0 pt).
  /// Brzegi glifów to więc pozycja kursora poprawiona o tę połowę.
  var inlineCodeBoxes: [CGRect] {
    var boxes: [CGRect] = []
    for line in textLineFragments {
      let text = line.attributedString
      let string = text.string as NSString
      let bounds = line.typographicBounds
      let baseline = bounds.minY + line.glyphOrigin.y
      func kern(at index: Int) -> CGFloat { text.attribute(.kern, at: index, effectiveRange: nil) as? CGFloat ?? 0 }
      text.enumerateAttribute(.rarogInlineCode, in: line.characterRange) { value, range, _ in
        guard value != nil, let font = text.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont else { return }
        let end = NSMaxRange(range)
        let atLineStart = range.location == line.characterRange.location
        let atLineEnd = end == NSMaxRange(line.characterRange) || Self.lineBreaks.contains(string.character(at: end))
        let first = line.locationForCharacter(at: range.location).x + (atLineStart ? 0 : kern(at: range.location - 1) / 2)
        let last = line.locationForCharacter(at: end).x - (atLineEnd ? 0 : kern(at: end - 1) / 2)
        let left = bounds.minX + first - Self.inlineCodeSide
        let right = bounds.minX + last + Self.inlineCodeSide
        boxes.append(CGRect(
          x: left, y: baseline - font.ascender - Self.inlineCodeTop, width: right - left,
          height: font.ascender - font.descender + Self.inlineCodeTop + Self.inlineCodeBottom))
      }
    }
    return boxes
  }

  override var renderingSurfaceBounds: CGRect {
    var bounds = super.renderingSurfaceBounds
    for bar in quoteBars { bounds = bounds.union(bar) }
    if let bar = questionBar { bounds = bounds.union(bar) }
    if decoration?.kind == .rule { bounds = bounds.union(ruleLine) }
    for box in inlineCodeBoxes { bounds = bounds.union(box) }
    return bounds
  }

  /// Linia pozioma od lewej krawędzi treści do prawej krawędzi kontenera. W układzie fragmentu.
  var ruleLine: CGRect {
    let indent = decoration?.leftIndent ?? 0
    let lines = lines
    return CGRect(x: indent - layoutFragmentFrame.minX, y: lines.midY.rounded(), width: containerWidth - indent, height: 1)
  }

  override func draw(at point: CGPoint, in context: CGContext) {
    context.saveGState()
    if let decoration {
      if let bar = questionBar {
        context.setFillColor(colors.questionBar)
        context.fill(bar.offsetBy(dx: point.x, dy: point.y))
      }
      for bar in quoteBars {
        context.setFillColor(colors.quoteBar)
        context.fill(bar.offsetBy(dx: point.x, dy: point.y))
      }
      if decoration.kind == .rule {
        context.setFillColor(colors.hairline)
        context.fill(ruleLine.offsetBy(dx: point.x, dy: point.y))
      }
    }
    // Jedna ścieżka na wszystkie tła: półprzezroczyste tła, które się stykają, nie ciemnieją na styku.
    let radius = Self.inlineCodeRadius
    for box in inlineCodeBoxes {
      context.addPath(CGPath(
        roundedRect: box.offsetBy(dx: point.x, dy: point.y), cornerWidth: radius, cornerHeight: radius, transform: nil))
    }
    context.setFillColor(colors.inlineCode)
    context.fillPath()
    context.restoreGState()
    super.draw(at: point, in: context)
  }

}

/// Delegat układu tekstu wiadomości: akapity z ozdobą albo z kodem w linii dostają ``MarkdownLayoutFragment``.
final class MarkdownLayoutDelegate: NSObject, NSTextLayoutManagerDelegate {
  /// Kolory rozwiązane dla motywu widoku (zmiana motywu przebudowuje tekst i fragmenty).
  nonisolated(unsafe) var colors = MarkdownColors.placeholder

  func textLayoutManager(
    _ textLayoutManager: NSTextLayoutManager, textLayoutFragmentFor location: any NSTextLocation, in textElement: NSTextElement
  ) -> NSTextLayoutFragment {
    let range = textElement.elementRange
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0
    else { return NSTextLayoutFragment(textElement: textElement, range: range) }
    let text = paragraph.attributedString
    let decoration = text.attribute(.rarogDecoration, at: 0, effectiveRange: nil) as? MarkdownDecoration
    guard decoration != nil || Self.hasInlineCode(text)
    else { return NSTextLayoutFragment(textElement: textElement, range: range) }
    let fragment = MarkdownLayoutFragment(textElement: textElement, range: range)
    fragment.decoration = decoration
    fragment.colors = colors
    return fragment
  }

  private static func hasInlineCode(_ text: NSAttributedString) -> Bool {
    var found = false
    text.enumerateAttribute(
      .rarogInlineCode, in: NSRange(location: 0, length: text.length), options: .longestEffectiveRangeNotRequired
    ) { value, _, stop in
      guard value != nil else { return }
      found = true
      stop.pointee = true
    }
    return found
  }
}
#endif
