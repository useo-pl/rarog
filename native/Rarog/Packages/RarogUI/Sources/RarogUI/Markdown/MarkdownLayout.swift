import Foundation

// Układ markdownu bez UIKit: bloki z parsera → akapity tekstu z rolą, odstępem przed
// sobą i głębokością cytatu. `MarkdownRenderer` (iOS) zamienia je 1:1 na `NSAttributedString`;
// wszystko, o czym tu decydujemy (rytm odstępów, hierarchia nagłówków, znaczniki list, pasek
// bloku kodu), ma testy na macOS. Rytm:
// - między akapitami i po liście `--s2` (≈0,55 em), między pozycjami listy `--s1`;
// - blok z własnym tłem albo obrysem (kod, cytat, linia, tabela) dostaje więcej z OBU stron (`--s3`);
// - nagłówek po treści dostaje dużo powietrza od góry (`--s5`), a mało od dołu — należy do
//   sekcji pod sobą (inaczej nagłówek po wypunktowaniu stoi za blisko, a akapit klei się
//   do listy numerowanej).
// Właściciel: transkrypt, markdown.

/// Odstęp przed akapitem; wartość w ułamkach stopnia pisma treści (em), więc idzie za Dynamic Type.
public enum MarkdownGap: Sendable, Equatable {
  case none
  /// Między pozycjami jednej listy.
  case item
  /// Między akapitami, po nagłówku, przed listą i po niej.
  case paragraph
  /// Przed i po bloku z tłem albo obrysem.
  case block
  /// Przed nagłówkiem, który otwiera nową sekcję.
  case section

  public var em: Double {
    switch self {
    case .none: 0
    case .item: 0.3
    case .paragraph: 0.65
    case .block: 0.85
    case .section: 1.5
    }
  }
}

/// Rola akapitu w tekście wiadomości.
public enum MarkdownParagraphKind: Sendable, Equatable {
  case text
  /// Poziom ze źródła (1…6).
  case heading(level: Int)
  /// Pozycja listy ze znacznikiem gotowym do wypisania („•", „3.").
  case listItem(marker: String, depth: Int, ordered: Bool)
  /// Kolejny akapit pozycji listy (po pustej linii z wcięciem) — wcięty jak jej treść.
  case listParagraph(depth: Int)
  /// Pasek nad blokiem kodu: ikona kopiowania i nazwa języka (gdy jest językiem).
  case codeBar(language: String?, code: String)
  /// Linia bloku kodu (osobny akapit: tło bloku rysuje fragment układu).
  case codeLine(first: Bool, last: Bool)
  case rule
  case table(MarkdownTable)
}

public struct MarkdownParagraph: Sendable, Equatable {
  public var kind: MarkdownParagraphKind
  public var spans: [MarkdownSpan]
  public var gap: MarkdownGap
  /// Głębokość cytatu (0 = poza cytatem).
  public var quoteDepth: Int
  /// Kolor składni linii bloku kodu: zakresy w UTF-16 tekstu linii. Pusta = bez koloru.
  public var syntax: [SyntaxToken]
  /// Akapit pytania do użytkownika: od akapitu ze znacznikiem (``MarkdownQuestion``) do końca tekstu,
  /// razem z listą, kodem, tabelą i cytatem pod nim. Tylko przy rozpoznawaniu włączonym w układzie.
  public var question: Bool

  public init(
    _ kind: MarkdownParagraphKind, _ spans: [MarkdownSpan] = [], gap: MarkdownGap = .none, quoteDepth: Int = 0,
    syntax: [SyntaxToken] = [], question: Bool = false
  ) {
    self.kind = kind
    self.spans = spans
    self.gap = gap
    self.quoteDepth = quoteDepth
    self.syntax = syntax
    self.question = question
  }
}

public enum MarkdownLayout {
  /// Akapity tekstu; kolor składni bloków kodu z `syntax` (domyślnie wspólna pamięć skanów). `questions`
  /// włącza rozpoznawanie pytania do użytkownika — domyślnie wyłączone, więc notatki projektu i każdy
  /// inny wołający dostają dokładnie te same akapity co przed nim.
  public static func paragraphs(
    _ source: String, questions: Bool = false, syntax: SyntaxCache = .shared
  ) -> [MarkdownParagraph] {
    paragraphs(blocks: MarkdownParser.blocks(source), questions: questions, syntax: syntax)
  }

  public static func paragraphs(
    blocks: [MarkdownBlock], questions: Bool = false, syntax: SyntaxCache = .shared
  ) -> [MarkdownParagraph] {
    var out: [MarkdownParagraph] = []
    var previous: Flow?
    // Bloki pytania to dalszy ciąg tego samego przebiegu (wspólne `previous`), więc rytm odstępów jest ten sam
    // co bez rozpoznawania — różni je tylko `question`.
    let head = (questions ? MarkdownQuestion.start(in: blocks) : nil) ?? blocks.count
    append(blocks[..<head], quoteDepth: 0, firstGap: nil, previous: &previous, syntax: syntax, into: &out)
    let asked = out.count
    append(blocks[head...], quoteDepth: 0, firstGap: nil, previous: &previous, syntax: syntax, into: &out)
    for index in asked..<out.count {
      out[index].question = true
    }
    return out
  }

  /// Odstęp nad wiadomością, która ciągnie wypowiedź tego samego głosu (bez etykiety): na żywo
  /// tura agenta przychodzi jako osobne wiadomości (wpis jsonl = wiadomość), więc akapit po liście
  /// albo nagłówek po wypunktowaniu stoją w SĄSIEDNICH komórkach — odstęp liczony jak wewnątrz
  /// jednego tekstu, po zwykłym akapicie.
  public static func leadGap(_ paragraphs: [MarkdownParagraph]) -> MarkdownGap {
    guard let first = paragraphs.first else { return .none }
    if first.quoteDepth > 0 { return .block }
    switch first.kind {
    case .heading: return .section
    case .codeBar, .codeLine, .rule, .table: return .block
    case .text, .listItem, .listParagraph: return .paragraph
    }
  }

  /// Stopień nagłówka względem pisma treści: `#` i `##` wyraźnie większe, `###` o włos,
  /// `####` i niżej tylko wagą.
  public static func headingScale(_ level: Int) -> Double {
    switch level {
    case ...1: 1.33
    case 2: 1.2
    case 3: 1.07
    default: 1
    }
  }

  /// Punktor wg głębokości: pełne koło, puste koło, kwadrat — i w kółko.
  public static func bullet(depth: Int) -> String {
    ["•", "◦", "▪"][depth % 3]
  }

  /// Znacznik pozycji przy kopiowaniu zaznaczenia: wcięcie i markdown (`- `, `3. `), nie tabulator.
  public static func copiedMarker(_ kind: MarkdownParagraphKind) -> String? {
    guard case let .listItem(marker, depth, ordered) = kind else { return nil }
    return String(repeating: "  ", count: depth) + (ordered ? "\(marker) " : "- ")
  }

  /// Nazwa języka na pasku bloku: tylko gdy naprawdę jest językiem („```wynik" to opis treści,
  /// nie język — na pasku byłby szumem). Językiem jest nazwa, dla której kolorowanie ma gramatykę
  /// (``SyntaxHighlight``): pasek i kolor mówią o bloku to samo.
  public static func displayLanguage(_ info: String?) -> String? {
    guard let info, SyntaxHighlight.isKnown(info) else { return nil }
    return info
  }

  /// Tabela dla czytnika ekranu: nagłówek, potem wiersze, komórki po przecinku.
  public static func spokenTable(_ table: MarkdownTable) -> String {
    func plain(_ cell: String) -> String {
      MarkdownInlineParser.spans(cell).map(\.text).joined()
    }
    var parts = [UICopy.tableSpokenHeader(rows: table.rows.count, header: UICopy.list(table.header.map(plain), .comma))]
    for row in table.rows {
      parts.append(UICopy.list(row.map(plain), .comma))
    }
    return UICopy.list(parts, .semicolon)
  }

  // MARK: - Spłaszczanie

  /// Klasa bloku dla rytmu odstępów.
  private enum Flow {
    case text, heading, framed
  }

  private static func flow(_ block: MarkdownBlock) -> Flow {
    switch block {
    case .paragraph, .list: .text
    case .heading: .heading
    case .code, .quote, .rule, .table: .framed
    }
  }

  private static func gap(after previous: Flow?, before next: Flow) -> MarkdownGap {
    guard let previous else { return .none }
    switch (previous, next) {
    case (.heading, .heading): return .paragraph
    case (_, .heading): return .section
    case (.framed, _), (_, .framed): return .block
    default: return .paragraph
    }
  }

  // swiftlint:disable:next function_body_length
  private static func append(
    _ blocks: ArraySlice<MarkdownBlock>, quoteDepth: Int, firstGap: MarkdownGap?, previous: inout Flow?,
    syntax cache: SyntaxCache, into out: inout [MarkdownParagraph]
  ) {
    for (index, block) in blocks.enumerated() {
      let current = flow(block)
      let gap = index == 0 ? (firstGap ?? gap(after: previous, before: current)) : gap(after: previous, before: current)
      switch block {
      case let .paragraph(text):
        out.append(MarkdownParagraph(.text, MarkdownInlineParser.spans(text), gap: gap, quoteDepth: quoteDepth))
      case let .heading(level, text):
        out.append(MarkdownParagraph(.heading(level: level), MarkdownInlineParser.spans(text), gap: gap, quoteDepth: quoteDepth))
      case let .list(items):
        for (position, item) in items.enumerated() {
          let marker = item.number.map { "\($0)." } ?? bullet(depth: item.depth)
          let itemGap = position == 0 ? gap : item.loose ? MarkdownGap.paragraph : .item
          let kind = MarkdownParagraphKind.listItem(marker: marker, depth: item.depth, ordered: item.number != nil)
          out.append(MarkdownParagraph(kind, MarkdownInlineParser.spans(item.paragraphs.first ?? ""), gap: itemGap, quoteDepth: quoteDepth))
          for more in item.paragraphs.dropFirst() {
            out.append(MarkdownParagraph(
              .listParagraph(depth: item.depth), MarkdownInlineParser.spans(more), gap: .paragraph, quoteDepth: quoteDepth))
          }
        }
      case let .code(language, text, closed):
        out.append(MarkdownParagraph(.codeBar(language: displayLanguage(language), code: text), gap: gap, quoteDepth: quoteDepth))
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        // Kolor liczony dla CAŁEGO bloku, potem cięty na linie: komentarz blokowy, napis w backtickach
        // i ciało heredoca przechodzą przez granicę linii. Parser zamienia CR na `\n`, a `\n`
        // jest zawsze osobnym znakiem, więc linie znaków i linie UTF-16 to te same linie. Blok domknięty
        // bierze tokeny z pamięci (płynąca odpowiedź nie skanuje od nowa bloków nad tym, który rośnie).
        let tokens = cache.tokens(text, language: language, closed: closed)
        let syntax = tokens.isEmpty
          ? Array(repeating: [], count: lines.count)
          : SyntaxHighlight.split(tokens, lineLengths: lines.map(\.utf16.count))
        for (number, line) in lines.enumerated() {
          let kind = MarkdownParagraphKind.codeLine(first: number == 0, last: number == lines.count - 1)
          out.append(MarkdownParagraph(
            kind, [MarkdownSpan(String(line), .code)], quoteDepth: quoteDepth, syntax: syntax[number]))
        }
      case .rule:
        out.append(MarkdownParagraph(.rule, gap: gap, quoteDepth: quoteDepth))
      case let .table(table):
        out.append(MarkdownParagraph(.table(table), gap: gap, quoteDepth: quoteDepth))
      case let .quote(inner):
        // Rekurencja ograniczona: parser nie zagnieżdża cytatów głębiej niż `maxQuoteDepth`.
        var innerPrevious: Flow?
        append(inner[...], quoteDepth: quoteDepth + 1, firstGap: gap, previous: &innerPrevious, syntax: cache, into: &out)
      }
      previous = current
    }
  }
}

/// Szerokości kolumn tabeli: kolumna ma szerokość najszerszej komórki w jednej linii,
/// ale nie więcej niż sufit — wtedy jej komórki się zawijają. Szersza od kolumny tekstu tabela
/// przewija się w swoim pudełku; jedna komórka-akapit nie robi z niej taśmy na kilka ekranów.
public enum MarkdownTableGeometry {
  /// Sufit kolumny dla dostępnej szerokości.
  public static func columnCap(available: Double) -> Double {
    max(available * 0.66, 220)
  }

  /// `natural[wiersz][kolumna]` = szerokość komórki w jednej linii.
  public static func columnWidths(natural: [[Double]], available: Double) -> [Double] {
    let cap = columnCap(available: available)
    let columns = natural.map(\.count).max() ?? 0
    return (0..<columns).map { column in
      let widest = natural.compactMap { column < $0.count ? $0[column] : nil }.max() ?? 0
      return min(widest.rounded(.up), cap)
    }
  }
}
