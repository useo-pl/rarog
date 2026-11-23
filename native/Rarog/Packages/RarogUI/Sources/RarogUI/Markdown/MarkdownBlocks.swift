import Foundation

// Markdown odpowiedzi agenta: akapity, nagłówki, listy zagnieżdżone
// i numerowane, bloki kodu, cytaty, linie poziome i tabele GFM. Własny parser bez zależności
// (swift-markdown nie wchodzi — łańcuch dostaw i build offline). Reguły:
// - niedomknięty blok kodu jest kodem do końca dokumentu, od razu — bez migotania w trakcie
//   strumienia (płynąca odpowiedź ma otwarty fence przez wiele delt);
// - blok domyka ten sam znak w liczbie ≥ otwierającej;
// - listy zachowują numer startowy i wcięcie kontynuacji; numeracja idzie ciągiem przez pustą linię
//   i przez blok kodu wcięty pod pozycją („1. … 1." z kodem w środku to 1 i 2);
// - miękkie łamanie zostaje łamaniem;
// - tabela: wiersz nagłówka + wiersz delimitera o tej samej liczbie komórek; krzywy wiersz dopełniony;
// - cytat zagnieżdża się najwyżej na `maxQuoteDepth` poziomów, dalsze `>` są tekstem (głębokość
//   pochodzi z wejścia, więc bez sufitu rekurencja szła tak głęboko, jak długa była linia);
// - nieobsłużona składnia (HTML, przypisy, nagłówki setext) zostaje tekstem — treść nigdy nie jest
//   interpretowana jak HTML.
// Właściciel: transkrypt, markdown.

/// Blok dokumentu.
public enum MarkdownBlock: Sendable, Equatable {
  case paragraph(String)
  /// `level` jak w źródle (1…6); o tym, jak wygląda, decyduje ``MarkdownLayout``.
  case heading(level: Int, text: String)
  /// Lista spłaszczona do pozycji z głębokością — tyle potrzebuje widok.
  case list([MarkdownListItem])
  /// Blok kodu; `closed == false` = fence bez zamknięcia (kod do końca dokumentu).
  case code(language: String?, text: String, closed: Bool)
  /// Cytat blokowy: jego wnętrze to znowu bloki (cytat w cytacie, lista w cytacie).
  case quote([MarkdownBlock])
  case rule
  case table(MarkdownTable)
}

/// Pozycja listy.
public struct MarkdownListItem: Sendable, Equatable {
  /// `nil` = punktor; liczba = numer wyświetlany (ciąg od numeru pierwszej pozycji).
  public var number: Int?
  /// Głębokość od 0.
  public var depth: Int
  /// Pierwszy akapit to treść za znacznikiem; kolejne przyszły po pustej linii z wcięciem.
  public var paragraphs: [String]
  /// Pusta linia przed pozycją: większy odstęp (lista „luźna" w tym miejscu).
  public var loose: Bool

  public init(number: Int? = nil, depth: Int = 0, paragraphs: [String], loose: Bool = false) {
    self.number = number
    self.depth = depth
    self.paragraphs = paragraphs
    self.loose = loose
  }
}

/// Tabela GFM. Wiersze mają dokładnie tyle komórek, ile nagłówek.
public struct MarkdownTable: Sendable, Equatable {
  public enum Alignment: Sendable, Equatable {
    case left, center, right
  }

  public var header: [String]
  public var alignments: [Alignment?]
  public var rows: [[String]]
  /// Linie źródła — do kopiowania zaznaczenia (tabela wraca jako markdown, nie jako znak obiektu).
  public var source: String

  public init(header: [String], alignments: [Alignment?], rows: [[String]], source: String) {
    self.header = header
    self.alignments = alignments
    self.rows = rows
    self.source = source
  }
}

public enum MarkdownParser {
  /// Najgłębsze zagnieżdżenie cytatu; dalsze `>` zostają tekstem akapitu. Głębokość pochodzi
  /// z wejścia, a każdy poziom to rekurencja parsera i układu oraz osobna kreska z wcięciem:
  /// bez sufitu 40 000 `>` w jednej linii przepełniało stos, a skan linii na każdym poziomie
  /// dawał pracę kwadratową.
  public static let maxQuoteDepth = 8

  public static func blocks(_ source: String) -> [MarkdownBlock] {
    parse(lines(source), quoteDepth: 0)
  }

  /// Source lines after unifying line endings; the indexes from ``located(_:)`` point into this array.
  static func lines(_ source: String) -> [String] {
    source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }

  /// Top-level blocks with the source line each one starts on (`startLines[i]` for `blocks[i]`), from one
  /// parser pass.
  static func located(_ lines: [String]) -> (blocks: [MarkdownBlock], startLines: [Int]) {
    var startLines: [Int] = []
    let blocks = parse(lines, quoteDepth: 0, startLines: &startLines)
    return (blocks, startLines)
  }

  static func parse(_ lines: [String], quoteDepth: Int) -> [MarkdownBlock] {
    var ignored: [Int] = []
    return parse(lines, quoteDepth: quoteDepth, startLines: &ignored)
  }

  // swiftlint:disable:next cyclomatic_complexity function_body_length
  private static func parse(_ lines: [String], quoteDepth: Int, startLines: inout [Int]) -> [MarkdownBlock] {
    var out: [MarkdownBlock] = []
    var paragraphStart = 0
    var listStart = 0
    var paragraph: [String] = []
    var list: ListBuilder?
    var index = 0

    func flushParagraph() {
      guard !paragraph.isEmpty else { return }
      out.append(.paragraph(paragraph.joined(separator: "\n")))
      startLines.append(paragraphStart)
      paragraph = []
    }
    func flushList() {
      guard let built = list?.items, !built.isEmpty else {
        list = nil
        return
      }
      out.append(.list(built))
      startLines.append(listStart)
      list = nil
    }

    while index < lines.count {
      let line = lines[index]
      if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
        flushParagraph()
        list?.sawBlank = true
        index += 1
        continue
      }
      if let fence = Fence(line) {
        flushParagraph()
        // Blok wcięty pod pozycją listy należy do niej (CommonMark): lista oddaje złożone pozycje,
        // a za blokiem wraca z tym samym stanem, więc numeracja idzie dalej. Blok od lewego brzegu
        // kończy listę.
        var resumed: ListBuilder?
        if fence.indent >= 2, var open = list {
          let items = open.takeItems()
          if !items.isEmpty {
            out.append(.list(items))
            startLines.append(listStart)
          }
          resumed = open
          list = nil
        } else {
          flushList()
        }
        let fenceLine = index
        var body: [String] = []
        var closed = false
        index += 1
        while index < lines.count {
          if fence.closes(lines[index]) {
            closed = true
            break
          }
          body.append(fence.strip(lines[index]))
          index += 1
        }
        out.append(.code(language: fence.language, text: body.joined(separator: "\n"), closed: closed))
        startLines.append(fenceLine)
        list = resumed
        index += 1
        continue
      }
      let next = index + 1 < lines.count ? lines[index + 1] : nil
      // Otwarta lista: kolejna pozycja, akapit kontynuacji albo koniec listy.
      if list != nil {
        if !isRule(line), let marker = ListMarker(line) {
          // A list resumed after a code block in an item starts a new block at this item.
          if list?.items.isEmpty == true { listStart = index }
          list?.add(marker)
          index += 1
          continue
        }
        if list?.items.isEmpty == true {
          // Lista wznowiona za blokiem kodu w pozycji: linia bez znacznika ją kończy.
          list = nil
        } else if list?.sawBlank == true {
          if indentWidth(line) >= 2, !startsBlock(line, next: next) {
            list?.addParagraph(line.trimmingCharacters(in: .whitespaces))
            index += 1
            continue
          }
          flushList()
        } else if !startsBlock(line, next: next) {
          // Linia kontynuacji pozycji (także „leniwa", bez wcięcia): to zawijanie źródła.
          list?.continueLast(line.trimmingCharacters(in: .whitespaces))
          index += 1
          continue
        } else {
          flushList()
        }
      }
      if let heading = Self.heading(line) {
        flushParagraph()
        out.append(heading)
        startLines.append(index)
        index += 1
        continue
      }
      if isRule(line) {
        flushParagraph()
        out.append(.rule)
        startLines.append(index)
        index += 1
        continue
      }
      if quoteDepth < maxQuoteDepth, quoteBody(line) != nil {
        flushParagraph()
        startLines.append(index)
        var inner: [String] = []
        while index < lines.count, let body = quoteBody(lines[index]) {
          inner.append(body)
          index += 1
        }
        out.append(.quote(parse(inner, quoteDepth: quoteDepth + 1)))
        continue
      }
      if let next, isTableStart(line, next: next) {
        flushParagraph()
        let (table, consumed) = Self.table(lines, from: index)
        out.append(.table(table))
        startLines.append(index)
        index += consumed
        continue
      }
      if let marker = ListMarker(line) {
        flushParagraph()
        var builder = ListBuilder()
        builder.add(marker)
        listStart = index
        list = builder
        index += 1
        continue
      }
      // Akapit: wcięcie początku linii to zawijanie źródła, nie treść.
      if paragraph.isEmpty { paragraphStart = index }
      paragraph.append(String(line.drop { $0 == " " || $0 == "\t" }))
      index += 1
    }
    flushParagraph()
    flushList()
    assert(startLines.count == out.count)
    return out
  }

  // MARK: - Rozpoznawanie bloków

  /// Linia, która zaczyna nowy blok i przerywa akapit (albo kończy listę bez pustej linii).
  static func startsBlock(_ line: String, next: String?) -> Bool {
    if Fence(line) != nil || heading(line) != nil || isRule(line) || quoteBody(line) != nil { return true }
    if let next, isTableStart(line, next: next) { return true }
    return false
  }

  static func heading(_ line: String) -> MarkdownBlock? {
    guard let match = line.wholeMatch(of: /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/) else { return nil }
    return .heading(level: match.output.1.count, text: String(match.output.2))
  }

  /// `---`, `***`, `___` (także ze spacjami między znakami), wcięcie ≤ 3 spacje.
  static func isRule(_ line: String) -> Bool {
    let indent = line.prefix { $0 == " " }.count
    guard indent <= 3 else { return false }
    let body = line.dropFirst(indent).filter { $0 != " " && $0 != "\t" }
    guard let first = body.first, first == "-" || first == "*" || first == "_" else { return false }
    return body.count >= 3 && body.allSatisfy { $0 == first }
  }

  /// Treść linii cytatu bez `>` (i jednej spacji po nim); `nil` = to nie jest linia cytatu.
  static func quoteBody(_ line: String) -> String? {
    let indent = line.prefix { $0 == " " }.count
    guard indent <= 3 else { return nil }
    let body = line.dropFirst(indent)
    guard body.first == ">" else { return nil }
    let rest = body.dropFirst()
    return String(rest.first == " " || rest.first == "\t" ? rest.dropFirst() : rest)
  }

  static func indentWidth(_ line: String) -> Int {
    var width = 0
    for char in line {
      if char == " " { width += 1 } else if char == "\t" { width += 4 } else { break }
    }
    return width
  }

  // MARK: - Tabele GFM

  /// Nagłówek z kreską pionową + delimiter o tej samej liczbie komórek = początek tabeli.
  static func isTableStart(_ line: String, next: String) -> Bool {
    guard line.contains("|"), let aligns = delimiterRow(next) else { return false }
    let head = tableCells(line).count
    return head > 0 && head == aligns.count
  }

  /// Wiersz delimitera (`| --- | :--: |`): wyrównania kolumn; `nil` = to nie delimiter.
  static func delimiterRow(_ line: String) -> [MarkdownTable.Alignment?]? {
    guard line.contains("-") else { return nil }
    let cells = tableCells(line)
    guard !cells.isEmpty else { return nil }
    var out: [MarkdownTable.Alignment?] = []
    for cell in cells {
      guard cell.wholeMatch(of: /:?-+:?/) != nil else { return nil }
      let left = cell.hasPrefix(":")
      let right = cell.hasSuffix(":")
      out.append(left && right ? .center : right ? .right : left ? .left : nil)
    }
    // Delimiter bez żadnej kreski pionowej i z jedną kolumną to linia pozioma albo setext — nie tabela.
    if cells.count == 1, !line.contains("|") { return nil }
    return out
  }

  /// Komórki wiersza: `\|` to kreska w treści; skrajne puste komórki z `| a |` odpadają.
  static func tableCells(_ line: String) -> [String] {
    var cells: [String] = []
    var current = ""
    var escaped = false
    for char in line {
      if escaped {
        current.append(char == "|" ? "|" : "\\")
        if char != "|" { current.append(char) }
        escaped = false
      } else if char == "\\" {
        escaped = true
      } else if char == "|" {
        cells.append(current)
        current = ""
      } else {
        current.append(char)
      }
    }
    if escaped { current.append("\\") }
    cells.append(current)
    var trimmed = cells.map { $0.trimmingCharacters(in: .whitespaces) }
    if trimmed.first == "" { trimmed.removeFirst() }
    if trimmed.last == "", !trimmed.isEmpty { trimmed.removeLast() }
    return trimmed
  }

  /// Tabela od linii `start` (nagłówek, delimiter, wiersze do pustej linii albo innego bloku).
  static func table(_ lines: [String], from start: Int) -> (MarkdownTable, Int) {
    let header = tableCells(lines[start])
    let aligns = delimiterRow(lines[start + 1]) ?? []
    var rows: [[String]] = []
    var end = start + 2
    while end < lines.count {
      let line = lines[end]
      let next = end + 1 < lines.count ? lines[end + 1] : nil
      // Wiersz tabeli musi nieść kreskę; linia bez niej to już następny akapit.
      if line.trimmingCharacters(in: .whitespaces).isEmpty || !line.contains("|") || startsBlock(line, next: next) {
        break
      }
      let cells = tableCells(line)
      // Liczba komórek wg nagłówka (GFM): nadmiar odpada, niedobór dopełniamy pustymi.
      rows.append((0..<header.count).map { $0 < cells.count ? cells[$0] : "" })
      end += 1
    }
    let source = lines[start..<end].map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
    return (MarkdownTable(header: header, alignments: aligns, rows: rows, source: source), end - start)
  }
}

// MARK: - Listy

/// Składa pozycje jednej listy: głębokość ze stosu wcięć znaczników, numeracja ciągiem per głębokość.
private struct ListBuilder {
  var items: [MarkdownListItem] = []
  /// Pusta linia od ostatniej pozycji (następna pozycja jest „luźna", wcięty tekst = akapit pozycji).
  var sawBlank = false
  /// Wcięcia znaczników otwartych poziomów (indeks = głębokość).
  private var indents: [Int] = []
  /// Następny numer na danej głębokości; `nil` = poziom jest punktowany albo jeszcze pusty.
  private var nextNumber: [Int: Int] = [:]

  mutating func add(_ marker: ListMarker) {
    // Głębiej = wcięcie co najmniej o 2 większe od rodzica; płycej = zdejmujemy poziomy.
    while let last = indents.last, marker.indent < last {
      indents.removeLast()
    }
    if let last = indents.last, marker.indent >= last + 2 {
      indents.append(marker.indent)
    } else if indents.isEmpty {
      indents.append(marker.indent)
    } else {
      indents[indents.count - 1] = marker.indent
    }
    let depth = min(indents.count - 1, 5)
    // Głębsze poziomy zaczynają numerację od nowa, gdy wraca płytszy.
    for key in nextNumber.keys where key > depth { nextNumber[key] = nil }
    var number: Int?
    if let start = marker.number {
      let value = nextNumber[depth] ?? start
      number = value
      nextNumber[depth] = value + 1
    } else {
      nextNumber[depth] = nil
    }
    items.append(MarkdownListItem(number: number, depth: depth, paragraphs: [marker.text], loose: sawBlank && !items.isEmpty))
    sawBlank = false
  }

  /// Linia kontynuacji: zostaje w tym samym akapicie pozycji (miękkie łamanie).
  mutating func continueLast(_ text: String) {
    guard !items.isEmpty, !items[items.count - 1].paragraphs.isEmpty else { return }
    let last = items[items.count - 1].paragraphs.count - 1
    items[items.count - 1].paragraphs[last] += "\n" + text
  }

  /// Oddaje złożone pozycje i zostaje otwarta z tym samym stanem (wcięcia poziomów, numeracja):
  /// blok kodu w pozycji przerywa listę w układzie, nie w numeracji.
  mutating func takeItems() -> [MarkdownListItem] {
    defer {
      items = []
      sawBlank = false
    }
    return items
  }

  /// Akapit po pustej linii z wcięciem: należy do ostatniej pozycji.
  mutating func addParagraph(_ text: String) {
    guard !items.isEmpty else { return }
    items[items.count - 1].paragraphs.append(text)
    sawBlank = false
  }
}

/// Znacznik pozycji listy: `-`/`*`/`+` albo `N.`/`N)` i spacja.
private struct ListMarker {
  let number: Int?
  let indent: Int
  let text: String

  init?(_ line: String) {
    let body = line.drop { $0 == " " || $0 == "\t" }
    if let bullet = body.wholeMatch(of: /[-*+][ \t]+(.*)/) {
      number = nil
      text = String(bullet.output.1)
    } else if let ordered = body.wholeMatch(of: /(\d{1,9})[.)][ \t]+(.*)/), let value = Int(ordered.output.1) {
      number = value
      text = String(ordered.output.2)
    } else {
      return nil
    }
    indent = MarkdownParser.indentWidth(line)
  }
}

// MARK: - Bloki kodu

/// Otwarcie bloku kodu: ≥ 3 jednakowe znaki (`` ` `` albo `~`), wcięcie ≤ 3 spacje.
private struct Fence {
  let char: Character
  let count: Int
  let indent: Int
  let language: String?

  init?(_ line: String) {
    let indent = line.prefix { $0 == " " }.count
    guard indent <= 3 else { return nil }
    let body = line.dropFirst(indent)
    guard let char = body.first, char == "`" || char == "~" else { return nil }
    let run = body.prefix { $0 == char }.count
    guard run >= 3 else { return nil }
    let info = body.dropFirst(run).trimmingCharacters(in: .whitespaces)
    // Info fence'u z odwrotnymi apostrofami nie otwiera bloku (CommonMark).
    if char == "`", info.contains("`") { return nil }
    self.char = char
    count = run
    self.indent = indent
    language = info.split(separator: " ").first.map(String.init)
  }

  /// Domknięcie: ten sam znak w liczbie ≥ otwierającej, nic poza spacjami.
  func closes(_ line: String) -> Bool {
    let indent = line.prefix { $0 == " " }.count
    guard indent <= 3 else { return false }
    let body = line.dropFirst(indent)
    let run = body.prefix { $0 == char }.count
    return run >= count && body.dropFirst(run).allSatisfy { $0 == " " || $0 == "\t" }
  }

  /// Zdejmuje z linii kodu wcięcie fence'u (nie więcej).
  func strip(_ line: String) -> String {
    var dropped = 0
    var rest = Substring(line)
    while dropped < indent, rest.first == " " {
      rest = rest.dropFirst()
      dropped += 1
    }
    return String(rest)
  }
}
