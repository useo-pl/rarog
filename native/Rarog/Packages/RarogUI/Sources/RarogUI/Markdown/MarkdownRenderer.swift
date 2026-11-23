#if os(iOS)
import UIKit

/// Markdown → `NSAttributedString` dla `UITextView` (TextKit 2). Jeden tekst na wiadomość, żeby
/// systemowe zaznaczanie szło przez całą odpowiedź. O układzie (odstępy, nagłówki,
/// znaczniki, pasek bloku kodu) decyduje ``MarkdownLayout`` (testy na macOS); tu jest tylko
/// przekład ról na pismo, wcięcia i atrybuty. Tła i kreski rysuje ``MarkdownLayoutFragment``,
/// tabelę — widok w załączniku (``MarkdownTableAttachment``). Kolor składni linii kodu daje
/// ``SyntaxHighlight`` (zakresy w ``MarkdownParagraph/syntax``), tu tylko barwa klasy (``Palette/syntax(_:)``).
/// Właściciel: transkrypt, markdown.
extension NSAttributedString.Key {
  /// Odstęp nad wiadomością (CGFloat, na pierwszym znaku) — czyta go komórka transkryptu.
  static let rarogLeadGap = NSAttributedString.Key("pl.useo.rarog.leadGap")
  /// Na linii kodu z kolorami składni: jej atrament bez koloru (UIColor). Pod stojącą decyzją cała linia wraca do
  /// niego (``MarkdownRenderer/withoutSyntax(_:)``).
  static let rarogSyntaxInk = NSAttributedString.Key("pl.useo.rarog.syntaxInk")
  /// Kod w linii (Bool): zaokrąglone tło rysuje ``MarkdownLayoutFragment``, nie atrybut `.backgroundColor`.
  static let rarogInlineCode = NSAttributedString.Key("pl.useo.rarog.inlineCode")
}

enum MarkdownRenderer {
  struct Style: Hashable {
    var textColor: UIColor
    /// Atrament pogrubienia i nagłówków; `nil` = ten sam co `textColor`.
    var strongColor: UIColor?
    var base: UIFont.TextStyle
    var traits: UITraitCollection
    /// Rozpoznawanie pytania do użytkownika: tylko odpowiedź agenta, płynąca i domknięta — obie
    /// z tym samym stylem, więc domknięcie bierze render strumienia z pamięci. Dymek człowieka i notatki bez niego.
    var questions = false
    /// The app's text size on the flat path (``Fonts/category`` when the style is made): the traits carry no step
    /// there, so a render cached for one step must not serve another. Large on the standard path.
    var category: TextSizeCategory = Fonts.category
    /// Prose runs across the whole container instead of ending at the density's readable measure
    /// (``TranscriptSpacing/proseCap(fullWidth:)``; the transcript's full width mode, ``TranscriptWidth``); part of the
    /// key, so a render made in one mode never serves the other.
    var fullWidth = false
    /// The gaps between paragraphs and the readable measure at the transcript's density (``TranscriptSpacing``); part
    /// of the key, so a render made at one density never serves the other. The prompt bubble and its entry in flight carry it too, so the
    /// bubble does not jump at the echo.
    var spacing: TranscriptSpacing = .standard

    static func == (a: Style, b: Style) -> Bool {
      a.textColor == b.textColor && a.strongColor == b.strongColor && a.base == b.base && a.questions == b.questions
        && a.category == b.category && a.fullWidth == b.fullWidth && a.spacing == b.spacing
        && a.traits.preferredContentSizeCategory == b.traits.preferredContentSizeCategory
        && a.traits.userInterfaceStyle == b.traits.userInterfaceStyle
        && a.traits.accessibilityContrast == b.traits.accessibilityContrast
        && a.traits.legibilityWeight == b.traits.legibilityWeight
    }

    func hash(into hasher: inout Hasher) {
      hasher.combine(base)
      hasher.combine(questions)
      hasher.combine(category)
      hasher.combine(fullWidth)
      hasher.combine(spacing)
      hasher.combine(traits.preferredContentSizeCategory)
      hasher.combine(traits.userInterfaceStyle)
      hasher.combine(traits.accessibilityContrast)
    }
  }

  /// Pismo treści transkryptu: `callout`, 16 pt w domyślnym rozmiarze, i dalej z Dynamic Type.
  static let transcriptStyle: UIFont.TextStyle = .callout
  /// Notka systemu w transkrypcie: stopień niżej niż treść.
  static let noticeStyle: UIFont.TextStyle = .footnote

  /// O ile kod w bloku transkryptu jest mniejszy od treści (`callout`, 16 pt): 14 pt w rozmiarze domyślnym.
  static let codeBlockStep: CGFloat = 2
  /// Wysokość paska bloku kodu (cel dotyku ikony kopiowania mieści się w nim).
  static let codeBarHeight: CGFloat = 30
  /// Wcięcie treści bloku kodu od krawędzi pudełka.
  static let codeInset: CGFloat = 10
  /// Miejsce na ikonę kopiowania przed nazwą języka (przycisk leży nad tekstem).
  static let codeIconSlot: CGFloat = 30
  /// Krok wcięcia cytatu: kreska 2 pt i odstęp do tekstu.
  static let quoteStep: CGFloat = 14
  /// Szerokość kreski pytania do użytkownika: grubsza od kreski cytatu, wcięcie to samo.
  static let questionBarWidth: CGFloat = 3

  /// Lewa krawędź akapitu: krok cytatu za kreską pytania, potem krok na każdy poziom cytatu. Jedna definicja dla
  /// wcięć tekstu i dla ozdób fragmentu (``MarkdownDecoration/leftIndent``): pudełka kodu, kresek cytatu, linii
  /// poziomej i ikony kopiowania.
  static func leftIndent(question: Bool, quoteDepth: Int) -> CGFloat {
    (question ? quoteStep : 0) + CGFloat(quoteDepth) * quoteStep
  }
  static func render(_ source: String, style: Style) -> NSAttributedString {
    let paragraphs = MarkdownLayout.paragraphs(source, questions: style.questions)
    let fonts = MarkdownFonts(style: style)
    let out = NSMutableAttributedString()
    for (index, paragraph) in paragraphs.enumerated() {
      let previous = index > 0 ? paragraphs[index - 1] : nil
      let last = index == paragraphs.count - 1
      out.append(Self.paragraph(paragraph, previous: previous, last: last, fonts: fonts, style: style))
    }
    if out.length > 0 {
      let lead = CGFloat(style.spacing.em(MarkdownLayout.leadGap(paragraphs))) * fonts.body.pointSize
      // Na CAŁYM pierwszym znaku, nie na pierwszej jednostce UTF-16: każdy atrybut dzieli tekst na przebiegi
      // CoreText, więc granica w środku pary surogatów rysuje emoji na początku wiadomości (TLDR z 💡) jako
      // dwa glify LastResort (pomiar CTLine na macOS).
      let first = (out.string as NSString).rangeOfComposedCharacterSequence(at: 0)
      out.addAttribute(.rarogLeadGap, value: lead, range: first)
    }
    return out
  }

  /// Odstęp nad wiadomością ciągnącą wypowiedź głosu (``MarkdownLayout/leadGap(_:)``), w punktach;
  /// `nil` = tekst nie przyszedł z renderera (wpis kolejki).
  static func leadGap(_ text: NSAttributedString) -> CGFloat? {
    guard text.length > 0 else { return nil }
    return text.attribute(.rarogLeadGap, at: 0, effectiveRange: nil) as? CGFloat
  }

  // MARK: - Akapit

  /// Interlinia akapitu (``ProseLeading``): proza — akapit, pozycja i ciąg listy, nagłówek, także w cytacie — ma
  /// ~1,5 stopnia; pasek i linie kodu, tabela i linia pozioma zostają przy swoich wysokościach.
  static func lineSpacing(_ kind: MarkdownParagraphKind, fonts: MarkdownFonts) -> CGFloat {
    switch kind {
    case .text, .listItem, .listParagraph: fonts.bodyLineSpacing
    case let .heading(level): ProseLeading.lineSpacing(for: fonts.heading(level))
    case .codeBar, .codeLine, .rule, .table: 0
    }
  }

  /// The right end of a paragraph's lines. Prose (paragraph, list item and its continuation, heading, also in a quote)
  /// ends at most `capEm` of the body text from the content edge: the density's readable measure
  /// (``TranscriptSpacing/proseCap(fullWidth:)``), so an agent reply reads at a glance also in a 1050–1330 pt iPad
  /// column. A positive `tailIndent` counts from the container's edge, not from the indent (a nested list and a quote
  /// end in the same column), and one wider than the container is clamped to it (measured in
  /// `TextKitTypesetProbeTests`): the style does not depend on the width, so a rotation or a window change does not
  /// rebuild the text, and the render cache stays keyed by source and style. Code keeps its inset from the box's right
  /// edge; a table and a rule span the whole container. Without a cap (`nil`, the full width mode) prose runs to the
  /// container's edge too.
  static func tailIndent(_ kind: MarkdownParagraphKind, fonts: MarkdownFonts, capEm: Double?) -> CGFloat {
    switch kind {
    case .text, .listItem, .listParagraph, .heading: capEm.map { CGFloat($0) * fonts.body.pointSize } ?? 0
    case .codeBar, .codeLine: -codeInset
    case .rule, .table: 0
    }
  }

  // swiftlint:disable:next function_body_length cyclomatic_complexity
  private static func paragraph(
    _ paragraph: MarkdownParagraph, previous: MarkdownParagraph?, last: Bool, fonts: MarkdownFonts, style: Style
  ) -> NSAttributedString {
    // Pytanie do użytkownika stoi za pomarańczową kreską, wcięte jak cytat, ale w atramencie prozy:
    // przesuwa się tylko lewa krawędź, kolory zostają (cytat w pytaniu dalej w `muted`).
    let indent = leftIndent(question: paragraph.question, quoteDepth: paragraph.quoteDepth)
    let color = paragraph.quoteDepth > 0 ? Palette.muted : style.textColor
    // Pogrubienie i nagłówek prozy agenta jaśniejsze od niej; cytat zostaje cały w `muted`.
    let strong = paragraph.quoteDepth > 0 ? color : style.strongColor ?? color
    let para = NSMutableParagraphStyle()
    para.paragraphSpacingBefore = CGFloat(style.spacing.em(paragraph.gap)) * fonts.body.pointSize
    para.firstLineHeadIndent = indent
    para.headIndent = indent
    para.lineBreakMode = .byWordWrapping
    para.lineSpacing = lineSpacing(paragraph.kind, fonts: fonts)
    para.tailIndent = tailIndent(
      paragraph.kind, fonts: fonts, capEm: style.spacing.proseCap(fullWidth: style.fullWidth))
    let separator = last ? "" : "\n"
    var decoration = MarkdownDecoration.Kind.plain
    var replacement: MarkdownReplacement?
    let out = NSMutableAttributedString()

    switch paragraph.kind {
    case .text:
      out.append(inline(paragraph.spans, font: fonts.body, fonts: fonts, color: color, strong: strong))
    case let .heading(level):
      let font = fonts.heading(level)
      out.append(inline(paragraph.spans, font: font, fonts: fonts, color: strong, strong: strong))
      // Ścisk liter nagłówka dokłada się do oddechu kodu w linii (`.kern` z ``inline``), nie zastępuje go.
      let tracking = -0.01 * font.pointSize
      out.enumerateAttribute(.kern, in: NSRange(location: 0, length: out.length)) { value, range, _ in
        out.addAttribute(.kern, value: tracking + ((value as? CGFloat) ?? 0), range: range)
      }
    case let .listItem(marker, depth, ordered):
      let start = indent + CGFloat(depth) * fonts.listGutter
      para.firstLineHeadIndent = start
      para.headIndent = start + fonts.listGutter
      // Znacznik wyrównany do prawej w rynnie, treść od wspólnej krawędzi (jak `<ol>` w przeglądarce).
      para.tabStops = [
        NSTextTab(textAlignment: .right, location: start + fonts.listGutter - fonts.markerGap),
        NSTextTab(textAlignment: .left, location: start + fonts.listGutter),
      ]
      para.defaultTabInterval = fonts.markerGap
      let markerFont = ordered ? fonts.body.monospacedDigits : fonts.body
      let copied = MarkdownLayout.copiedMarker(paragraph.kind) ?? ""
      out.append(NSAttributedString(string: "\t\(marker)\t", attributes: [
        .font: markerFont, .foregroundColor: ordered ? color : Palette.muted,
        .rarogReplacement: MarkdownReplacement(copy: copied, spoken: ordered ? "\(marker) " : ""),
      ]))
      out.append(inline(paragraph.spans, font: fonts.body, fonts: fonts, color: color, strong: strong))
    case let .listParagraph(depth):
      let start = indent + CGFloat(depth + 1) * fonts.listGutter
      para.firstLineHeadIndent = start
      para.headIndent = start
      out.append(inline(paragraph.spans, font: fonts.body, fonts: fonts, color: color, strong: strong))
    case let .codeBar(language, code):
      let left = indent + codeInset + codeIconSlot
      para.firstLineHeadIndent = left
      para.headIndent = left
      para.minimumLineHeight = codeBarHeight
      para.maximumLineHeight = codeBarHeight
      para.lineBreakMode = .byTruncatingTail
      out.append(NSAttributedString(string: language ?? "", attributes: [
        .font: fonts.bar, .foregroundColor: Palette.muted2,
        .baselineOffset: (codeBarHeight - fonts.bar.lineHeight) / 2,
      ]))
      decoration = .codeBar(code: code)
      replacement = MarkdownReplacement(copy: "", spoken: "")
    case let .codeLine(first, isLast):
      para.firstLineHeadIndent = indent + codeInset
      para.headIndent = indent + codeInset
      // Łamanie na granicy słowa, a token dłuższy od linii (adres, hash) po znaku — kod na iPadzie
      // się zawija, nie przewija.
      para.lineBreakMode = .byWordWrapping
      para.paragraphSpacingBefore = first ? MarkdownLayoutFragment.codePadding : 0
      para.paragraphSpacing = isLast ? MarkdownLayoutFragment.codePadding : 0
      let text = paragraph.spans.map(\.text).joined()
      out.append(codeLine(text, syntax: paragraph.syntax, fonts: fonts, color: style.textColor))
      decoration = .codeLine(first: first, last: isLast)
      // Pusta linia kodu stoi jako spacja (inaczej nie ma wysokości) — do schowka idzie pusta.
      if text.isEmpty { replacement = MarkdownReplacement(copy: separator, spoken: "") }
    case .rule:
      para.minimumLineHeight = fonts.body.pointSize * 0.8
      para.maximumLineHeight = fonts.body.pointSize * 0.8
      out.append(NSAttributedString(string: "\u{00A0}", attributes: [.font: fonts.body, .foregroundColor: color]))
      decoration = .rule
      replacement = MarkdownReplacement(copy: "---" + separator, spoken: "")
    case let .table(table):
      let attachment = MarkdownTableAttachment(table: table, look: MarkdownTableLook(fonts: fonts, color: color))
      out.append(NSAttributedString(attachment: attachment))
      replacement = MarkdownReplacement(copy: table.source + separator, spoken: MarkdownLayout.spokenTable(table) + separator)
    }

    out.append(NSAttributedString(string: separator, attributes: [.font: fonts.body, .foregroundColor: color]))
    let whole = NSRange(location: 0, length: out.length)
    out.addAttribute(.paragraphStyle, value: para, range: whole)
    let quoteJoins = min(previous?.quoteDepth ?? 0, paragraph.quoteDepth)
    if decoration != .plain || paragraph.quoteDepth > 0 || paragraph.question {
      // Kreska cytatu ciągnie się przez odstęp akapitu ORAZ przez interlinię między akapitami (lineSpacing liczy się
      // też po ostatniej linii akapitu, pomiar w `TextKitTypesetProbeTests`). Większa z dwóch: nadmiar tylko zachodzi na kreskę nad sobą.
      let joinGap = max(Self.lineSpacing(paragraph.kind, fonts: fonts), previous.map { Self.lineSpacing($0.kind, fonts: fonts) } ?? 0)
      out.addAttribute(.rarogDecoration, value: MarkdownDecoration(
        kind: decoration, quoteDepth: paragraph.quoteDepth, quoteJoins: quoteJoins, joinGap: joinGap,
        question: paragraph.question, questionJoins: paragraph.question && previous?.question == true), range: whole)
    }
    if let replacement { out.addAttribute(.rarogReplacement, value: replacement, range: whole) }
    return out
  }

  /// Linia bloku kodu w kolorach składni: barwa i krój na zakresach tokenów, tekst bez zmian, więc
  /// zaznaczanie i schowek widzą ten sam znak w znak kod. Komentarz to wyciszenie z kursywą.
  private static func codeLine(_ text: String, syntax: [SyntaxToken], fonts: MarkdownFonts, color: UIColor) -> NSAttributedString {
    let line = NSMutableAttributedString(string: text.isEmpty ? " " : text, attributes: [.font: fonts.code, .foregroundColor: color])
    guard !syntax.isEmpty else { return line }
    // Znacznik atramentu raz na linię, kolor po jednym atrybucie na token: słownik atrybutów na token kosztował
    // ~4 razy więcej (mostkowanie do NSDictionary, pomiar: 8 000 tokenów 12 ms wobec 3 ms).
    line.addAttribute(.rarogSyntaxInk, value: color, range: NSRange(location: 0, length: line.length))
    for token in syntax {
      let range = NSRange(location: token.range.lowerBound, length: token.range.count)
      line.addAttribute(.foregroundColor, value: Palette.syntax(token.kind), range: range)
      // Kursywa SF Mono ma te same metryki i szerokości co prosty krój (zmierzone), więc zdjęcie
      // koloru (blok przerasta sufit w trakcie strumienia, przygaszenie) nie rusza układu.
      if token.kind == .c { line.addAttribute(.font, value: fonts.codeComment, range: range) }
    }
    return line
  }

  /// Ten sam tekst z kolorami składni zamienionymi na atrament linii (kursywa komentarza zostaje). Pod stojącą
  /// decyzją transkrypt przygasa tak, żeby tekst trzymał 7:1, a kolory składni mają mniej już bez
  /// przygaszenia — wracają więc do zwykłego atramentu. Tekst bez tokenów wraca bez kopii.
  static func withoutSyntax(_ text: NSAttributedString) -> NSAttributedString {
    var out: NSMutableAttributedString?
    text.enumerateAttribute(.rarogSyntaxInk, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      guard let ink = value as? UIColor else { return }
      if out == nil { out = NSMutableAttributedString(attributedString: text) }
      out?.addAttribute(.foregroundColor, value: ink, range: range)
    }
    return out ?? text
  }

  // MARK: - W linii

  /// Fragmenty w linii z krojem: pogrubienie i kursywa przez cechy kroju, przekreślenie atrybutem,
  /// kod pismem stałej szerokości na tle, link stonowanym niebieskim z podkreśleniem.
  /// Pogrubienie w atramencie `strong`, gdy go podano.
  /// Miękkie łamanie zostaje w akapicie (U+2028): `\n` zacząłby nowy akapit, z jego odstępem i bez wcięcia
  /// pozycji listy.
  static func inline(
    _ spans: [MarkdownSpan], font: UIFont, fonts: MarkdownFonts, color: UIColor, strong: UIColor? = nil
  ) -> NSAttributedString {
    let out = NSMutableAttributedString()
    // Brzegi zaokrąglonego tła kodu liczy fragment układu z pozycji kursora, co zakłada pismo od lewej. W akapicie
    // z pismem od prawej kod zostaje na prostym tle TextKit, bez oddechu.
    let rightToLeft = spans.contains { $0.text.unicodeScalars.contains(where: Self.isRightToLeft) }
    for span in spans {
      let ink = span.style.contains(.bold) ? strong ?? color : color
      var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: ink]
      attributes[.font] = span.style.contains(.code)
        ? fonts.inlineCode(size: font.pointSize, bold: span.style.contains(.bold))
        : font.with(bold: span.style.contains(.bold), italic: span.style.contains(.italic))
      if span.style.contains(.code) {
        // Kod w linii: jaśniejsze tło i ciepły, wygaszony atrament (`inlineCodeInk`), żeby kod
        // odznaczał się od prozy. Pod stojącą decyzją zdejmuje go `withoutSyntax`, jak kolory składni.
        if rightToLeft {
          attributes[.backgroundColor] = Palette.inlineCodeBackground
        } else {
          attributes[.rarogInlineCode] = true
        }
        attributes[.foregroundColor] = Palette.inlineCodeInk
        attributes[.rarogSyntaxInk] = ink
      }
      if span.style.contains(.strike) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let link = span.link {
        // Adres `claude.ai` idzie do przeglądarki, nie do apki Claude; widoczny tekst bez zmian.
        attributes[.link] = BrowserLinks.outside(link)
        attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        attributes[.underlineColor] = Palette.muted
        if !span.style.contains(.code) {
          // Kod w linku zostaje w atramencie kodu. Pod stojącą decyzją kolor linku zdejmuje `withoutSyntax`.
          attributes[.foregroundColor] = Palette.linkInk
          attributes[.underlineColor] = Palette.linkInk.withAlphaComponent(0.5)
          attributes[.rarogSyntaxInk] = ink
        }
      }
      let piece = NSMutableAttributedString(
        string: span.text.replacingOccurrences(of: "\n", with: "\u{2028}"), attributes: attributes)
      if span.style.contains(.code), !rightToLeft, piece.length > 0 {
        // Oddech po bokach tła kodu: odstęp za znakiem przed kodem i za ostatnim znakiem kodu, więc tło nie wchodzi
        // na sąsiednie litery ani na interpunkcję.
        func lastCharacter(_ text: NSAttributedString) -> NSRange {
          (text.string as NSString).rangeOfComposedCharacterSequence(at: text.length - 1)
        }
        piece.addAttribute(.kern, value: MarkdownLayoutFragment.inlineCodeSide, range: lastCharacter(piece))
        if out.length > 0 { out.addAttribute(.kern, value: MarkdownLayoutFragment.inlineCodeSide, range: lastCharacter(out)) }
      }
      out.append(piece)
    }
    return out
  }

  /// Litera pisma od prawej do lewej (hebrajskie, arabskie i pokrewne, z formami prezentacji) albo znak kierunku RTL.
  private static func isRightToLeft(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF, 0x10800...0x10FFF, 0x1E800...0x1EFFF,
         0x200F, 0x202B, 0x202E, 0x2067:
      true
    default:
      false
    }
  }
}

/// Message fonts at the text size: body text from its text style, headings and code from a size at the default
/// size scaled by the style (``Fonts/scaled(_:relativeTo:traits:category:)``).
struct MarkdownFonts {
  let style: MarkdownRenderer.Style
  let body: UIFont
  let code: UIFont
  /// Komentarz w bloku kodu: krój kodu w kursywie (różnica niebarwna obok wyciszenia).
  let codeComment: UIFont
  let bar: UIFont
  let table: UIFont
  /// Szerokość rynny znacznika listy (i krok zagnieżdżenia).
  let listGutter: CGFloat
  let markerGap: CGFloat
  /// Interlinia prozy w piśmie treści (``ProseLeading``).
  let bodyLineSpacing: CGFloat

  init(style: MarkdownRenderer.Style) {
    self.style = style
    body = Fonts.text(style.base, traits: style.traits, category: style.category)
    bodyLineSpacing = ProseLeading.lineSpacing(for: body)
    // Tabela stopień niżej niż treść: przy treści transkryptu 13 pt, przy notce systemu 12 pt. Kod w bloku
    // transkryptu 14 pt — o 2 pt mniej niż treść. Kod w notce systemu zostaje 12 pt.
    let main = style.base == MarkdownRenderer.transcriptStyle
    let smaller: UIFont.TextStyle = main ? .footnote : .caption1
    code = main
      ? Self.mono(
        MarkdownRenderer.transcriptStyle, plus: -MarkdownRenderer.codeBlockStep, traits: style.traits,
        category: style.category)
      : Fonts.mono(smaller, traits: style.traits, category: style.category)
    codeComment = code.with(bold: false, italic: true)
    bar = Fonts.mono(.caption1, traits: style.traits, category: style.category)
    table = Fonts.text(smaller, traits: style.traits, category: style.category)
    listGutter = (body.pointSize * 1.45).rounded()
    markerGap = (body.pointSize * 0.4).rounded()
  }

  /// A heading: a step over the body text (``MarkdownLayout/headingScale(_:)``) taken from the style's size at the
  /// default size and scaled by that style, so it follows the text size like the body text.
  func heading(_ level: Int) -> UIFont {
    let font = UIFont.systemFont(
      ofSize: Fonts.base(style.base) * MarkdownLayout.headingScale(level), weight: .semibold)
    return Fonts.scaled(font, relativeTo: style.base, traits: style.traits, category: style.category)
  }

  /// A monospaced font `plus` points larger (negative: smaller) than `style` at the default size, scaled by that
  /// style, so it follows the text size like ``Fonts/mono(_:weight:traits:category:)``.
  static func mono(
    _ style: UIFont.TextStyle, plus: CGFloat, traits: UITraitCollection, category: TextSizeCategory
  ) -> UIFont {
    let font = UIFont.monospacedSystemFont(ofSize: Fonts.base(style) + plus, weight: .regular)
    return Fonts.scaled(font, relativeTo: style, traits: traits, category: category)
  }

  /// Kod w linii: pismo stałej szerokości o ~0,9 stopnia otoczenia.
  func inlineCode(size: CGFloat, bold: Bool) -> UIFont {
    UIFont.monospacedSystemFont(ofSize: (size * 0.9).rounded(), weight: bold ? .semibold : .regular)
  }
}

extension UIFont {
  func with(bold: Bool, italic: Bool) -> UIFont {
    var traits = fontDescriptor.symbolicTraits
    if bold { traits.insert(.traitBold) }
    if italic { traits.insert(.traitItalic) }
    guard traits != fontDescriptor.symbolicTraits, let descriptor = fontDescriptor.withSymbolicTraits(traits) else { return self }
    return UIFont(descriptor: descriptor, size: pointSize)
  }

  /// Cyfry równej szerokości (numery list stoją w kolumnie).
  var monospacedDigits: UIFont {
    let descriptor = fontDescriptor.addingAttributes([
      .featureSettings: [[UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
                          UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector]],
    ])
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

/// Pamięć wyrenderowanych tekstów (render tylko przy zmianie treści albo rozmiaru pisma). Wiadomość płynąca
/// ma JEDNO miejsce na swoją ostatnią wersję (``live(_:style:)``): każda delta to inny tekst, a trzymanie
/// wszystkich wersji mnożyłoby pamięć przez liczbę delt (długi blok kodu w strumieniu: setki kopii).
@MainActor
final class MarkdownCache {
  private var entries: [Key: NSAttributedString] = [:]
  private var current: (key: Key, text: NSAttributedString)?

  struct Key: Hashable {
    let source: String
    let style: MarkdownRenderer.Style
  }

  func text(_ source: String, style: MarkdownRenderer.Style) -> NSAttributedString {
    let key = Key(source: source, style: style)
    if let hit = entries[key] { return hit }
    // Wiadomość, która właśnie się domknęła z tym samym tekstem, bierze ostatnią wersję strumienia.
    let rendered = if let current, current.key == key { current.text } else { MarkdownRenderer.render(source, style: style) }
    if entries.count > 600 { entries.removeAll(keepingCapacity: true) }
    entries[key] = rendered
    return rendered
  }

  /// Wersja wiadomości płynącej: bez wpisu w pamięci stałej, tylko ostatnia.
  func live(_ source: String, style: MarkdownRenderer.Style) -> NSAttributedString {
    let key = Key(source: source, style: style)
    if let hit = entries[key] { return hit }
    if let current, current.key == key { return current.text }
    let rendered = MarkdownRenderer.render(source, style: style)
    current = (key, rendered)
    return rendered
  }

  func removeAll() {
    entries.removeAll()
    current = nil
  }
}
#endif
