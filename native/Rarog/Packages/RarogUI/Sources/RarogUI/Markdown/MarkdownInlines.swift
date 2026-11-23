import Foundation

// Markdown w linii: kod, linki z etykietą, gołe adresy, pogrubienie, kursywa,
// przekreślenie i ucieczki `\*`. Dwa przebiegi, bez zaślepek w tekście:
// 1. skan od lewej wyjmuje rzeczy NIEPODZIELNE — kod w linii, link, goły adres, znak po `\` —
//    w atomy, do których emfaza nie zagląda (`https://x/a_b_c` nie dostaje kursywy w środku);
// 2. emfaza idzie po CAŁYM ciągu atomów, więc `**pogrubienie z `kodem` w środku**` i
//    `**https://x.pl**` nie rozpadają się na połówki z gołymi gwiazdkami.
// Każde wyszukiwanie domknięcia pamięta porażkę, więc złośliwe wejście (setki samotnych `*`)
// nie robi pracy kwadratowej, a zagnieżdżenie emfazy ma sufit (`Emphasis.maxDepth`), więc długie
// sparowane ciągi gwiazdek nie schodzą w głąb stosu. Właściciel: transkrypt, markdown.

/// Krój fragmentu w linii.
public struct MarkdownInlineStyle: OptionSet, Sendable, Hashable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }

  public static let bold = MarkdownInlineStyle(rawValue: 1)
  public static let italic = MarkdownInlineStyle(rawValue: 2)
  public static let strike = MarkdownInlineStyle(rawValue: 4)
  public static let code = MarkdownInlineStyle(rawValue: 8)
}

/// Fragment tekstu w linii: treść, krój i (dla linku) adres.
public struct MarkdownSpan: Sendable, Equatable {
  public var text: String
  public var style: MarkdownInlineStyle
  public var link: URL?

  public init(_ text: String, _ style: MarkdownInlineStyle = [], link: URL? = nil) {
    self.text = text
    self.style = style
    self.link = link
  }
}

public enum MarkdownInlineParser {
  public static func spans(_ text: String) -> [MarkdownSpan] {
    spans(text, allowLinks: true)
  }

  static func spans(_ text: String, allowLinks: Bool) -> [MarkdownSpan] {
    let atoms = tokenize(Array(text), allowLinks: allowLinks)
    var builder = SpanBuilder()
    var emphasis = Emphasis(atoms: atoms)
    emphasis.walk(0..<atoms.count, style: [], depth: 0, into: &builder)
    return builder.finished
  }

  // MARK: - Przebieg 1: atomy

  private static func tokenize(_ chars: [Character], allowLinks: Bool) -> [Atom] {
    var atoms: [Atom] = []
    atoms.reserveCapacity(chars.count)
    /// Długości ciągów `` ` ``, dla których domknięcia już nie ma (od miejsca porażki do końca).
    var noCodeCloser: Set<Int> = []
    var index = 0
    while index < chars.count {
      let char = chars[index]
      if char == "\\", index + 1 < chars.count, chars[index + 1].isASCII, chars[index + 1].isPunctuation || chars[index + 1].isSymbol {
        atoms.append(.literal(chars[index + 1]))
        index += 2
        continue
      }
      if char == "`" {
        var run = 0
        while index + run < chars.count, chars[index + run] == "`" { run += 1 }
        if !noCodeCloser.contains(run), let close = codeCloser(chars, from: index + run, length: run) {
          atoms.append(.opaque([MarkdownSpan(codeText(chars[(index + run)..<close]), .code)]))
          index = close + run
        } else {
          noCodeCloser.insert(run)
          for _ in 0..<run { atoms.append(.literal("`")) }
          index += run
        }
        continue
      }
      if allowLinks, char == "[", let link = labeledLink(chars, at: index) {
        atoms.append(.opaque(link.spans))
        index = link.end
        continue
      }
      if allowLinks, char == "h", let end = MarkdownLinks.bareURLEnd(chars, at: index),
        let url = URL(string: String(chars[index..<end]))
      {
        atoms.append(.opaque([MarkdownSpan(String(chars[index..<end]), link: url)]))
        index = end
        continue
      }
      atoms.append(.char(char))
      index += 1
    }
    return atoms
  }

  /// Indeks domykającego ciągu `` ` `` o DOKŁADNIE tej długości (dłuższy ciąg nie domyka).
  private static func codeCloser(_ chars: [Character], from start: Int, length: Int) -> Int? {
    var index = start
    while index < chars.count {
      guard chars[index] == "`" else {
        index += 1
        continue
      }
      var run = 0
      while index + run < chars.count, chars[index + run] == "`" { run += 1 }
      if run == length, index > start { return index }
      index += run
    }
    return nil
  }

  /// Treść kodu w linii: łamanie linii to spacja, jedna spacja z obu stron odpada (CommonMark).
  private static func codeText(_ slice: ArraySlice<Character>) -> String {
    var text = String(slice).replacingOccurrences(of: "\n", with: " ")
    if text.count >= 2, text.first == " ", text.last == " ", text.contains(where: { $0 != " " }) {
      text = String(text.dropFirst().dropLast())
    }
    return text
  }

  /// `[etykieta](adres "tytuł")` — etykieta bez `]` i łamania linii, adres bez nawiasów i spacji.
  /// Adres odrzucony (`javascript:`, `//host`) albo względny: etykieta zostaje tekstem.
  private static func labeledLink(_ chars: [Character], at start: Int) -> (spans: [MarkdownSpan], end: Int)? {
    var index = start + 1
    while index < chars.count, chars[index] != "]" {
      if chars[index] == "\n" || chars[index] == "[" { return nil }
      index += 1
    }
    guard index + 1 < chars.count, chars[index] == "]", chars[index + 1] == "(" else { return nil }
    let label = String(chars[(start + 1)..<index])
    var cursor = index + 2
    let urlStart = cursor
    while cursor < chars.count, chars[cursor] != ")", chars[cursor] != "(", !chars[cursor].isWhitespace {
      cursor += 1
    }
    let raw = String(chars[urlStart..<cursor])
    // Opcjonalny tytuł w cudzysłowie — pomijamy go, nie jest widoczny.
    var titleEnd = cursor
    while titleEnd < chars.count, chars[titleEnd] == " " { titleEnd += 1 }
    if titleEnd > cursor, titleEnd < chars.count, chars[titleEnd] == "\"" {
      var close = titleEnd + 1
      while close < chars.count, chars[close] != "\"", chars[close] != "\n" { close += 1 }
      guard close < chars.count, chars[close] == "\"" else { return nil }
      cursor = close + 1
    }
    guard cursor < chars.count, chars[cursor] == ")" else { return nil }
    switch MarkdownLinks.target(raw) {
    case .rejected:
      return nil
    case .relative:
      return (spans(label, allowLinks: false), cursor + 1)
    case let .url(url):
      let inner = spans(label, allowLinks: false).map { span in
        var linked = span
        linked.link = url
        return linked
      }
      return (inner.isEmpty ? [MarkdownSpan(raw, link: url)] : inner, cursor + 1)
    }
  }
}

// MARK: - Przebieg 2: emfaza

/// Atom: znak (może być ogranicznikiem emfazy), znak dosłowny (po `\`, nigdy ogranicznik)
/// albo gotowe fragmenty niepodzielne (kod, link, adres).
private enum Atom {
  case char(Character)
  case literal(Character)
  case opaque([MarkdownSpan])

  var delimiter: Character? {
    if case let .char(char) = self, char == "*" || char == "_" || char == "~" { return char }
    return nil
  }

  /// Do oceny brzegów ogranicznika: atom niepodzielny liczy się jak interpunkcja.
  var isWhitespace: Bool {
    switch self {
    case let .char(char), let .literal(char): char.isWhitespace
    case .opaque: false
    }
  }

  var isWordChar: Bool {
    switch self {
    case let .char(char), let .literal(char): char.isLetter || char.isNumber
    case .opaque: false
    }
  }
}

private struct Emphasis {
  let atoms: [Atom]

  /// `(znak, długość) → pozycja`, od której domknięcia na pewno nie ma (w danym zakresie).
  private struct Miss: Hashable {
    let char: Character
    let length: Int
    let upper: Int
  }

  private var misses: [Miss: Int] = [:]

  /// Najgłębsze zagnieżdżenie emfazy; głębiej ograniczniki zostają tekstem. Prawdziwa odpowiedź
  /// ma najwyżej trzy poziomy (kursywa w pogrubieniu w przekreśleniu). Limit trzyma rekurencję
  /// i liczbę przebiegów po tekście stałą: każdy poziom skanuje rozłączne zakresy, więc całość
  /// to O(limit · n) także dla `40 000 * + x + 40 000 *` (bez limitu: 20 000 poziomów stosu
  /// i praca kwadratowa na wątku głównym).
  static let maxDepth = 8

  init(atoms: [Atom]) {
    self.atoms = atoms
  }

  mutating func walk(_ range: Range<Int>, style: MarkdownInlineStyle, depth: Int, into out: inout SpanBuilder) {
    var index = range.lowerBound
    while index < range.upperBound {
      let atom = atoms[index]
      guard let char = atom.delimiter, depth < Self.maxDepth else {
        out.append(atom, style: style)
        index += 1
        continue
      }
      var run = 0
      while index + run < range.upperBound, atoms[index + run].delimiter == char { run += 1 }
      if let match = opener(at: index, run: run, char: char, range: range) {
        walk((index + match.length)..<match.close, style: style.union(match.style), depth: depth + 1, into: &out)
        index = match.close + match.length
        continue
      }
      for offset in 0..<run { out.append(atoms[index + offset], style: style) }
      index += run
    }
  }

  private mutating func opener(
    at index: Int, run: Int, char: Character, range: Range<Int>
  ) -> (length: Int, close: Int, style: MarkdownInlineStyle)? {
    let length: Int
    let trait: MarkdownInlineStyle
    switch char {
    case "~":
      // Przekreślenie GFM: dokładnie `~~`; pojedyncza tylda zostaje tekstem.
      guard run == 2 else { return nil }
      length = 2
      trait = .strike
    default:
      length = run >= 2 ? 2 : 1
      trait = length == 2 ? .bold : .italic
    }
    let after = index + run
    guard after < range.upperBound, !atoms[after].isWhitespace else { return nil }
    // `_` nigdy w środku słowa (`snake_case`, `__init__`); pojedyncza `*` też nie (`2*3*4`).
    let intraword = char == "_" || (char == "*" && length == 1)
    if intraword, index > range.lowerBound, atoms[index - 1].isWordChar { return nil }
    guard let close = closer(char: char, length: length, from: index + length, range: range, intraword: intraword)
    else { return nil }
    return (length, close, trait)
  }

  /// Początek domknięcia: ciąg tego samego znaku o długości ≥ `length` (bierzemy jego koniec),
  /// poprzedzony czymś innym niż biały znak; przy `_` i `*` nie przed literą.
  private mutating func closer(char: Character, length: Int, from start: Int, range: Range<Int>, intraword: Bool) -> Int? {
    let key = Miss(char: char, length: length, upper: range.upperBound)
    if let missed = misses[key], start >= missed { return nil }
    var index = start
    while index < range.upperBound {
      guard atoms[index].delimiter == char else {
        index += 1
        continue
      }
      var run = 0
      while index + run < range.upperBound, atoms[index + run].delimiter == char { run += 1 }
      let begin = index + run - length
      // `index > start`: treść między ogranicznikami nie może być pusta.
      let valid = run >= length && (char != "~" || run == 2) && index > start
        && !atoms[index - 1].isWhitespace
        && !(intraword && index + run < range.upperBound && atoms[index + run].isWordChar)
      if valid { return begin }
      index += run
    }
    if misses[key] == nil { misses[key] = start }
    return nil
  }
}

/// Skleja kolejne znaki o tym samym kroju w jeden fragment.
private struct SpanBuilder {
  var spans: [MarkdownSpan] = []
  private var buffer = ""
  private var bufferStyle: MarkdownInlineStyle = []

  mutating func append(_ atom: Atom, style: MarkdownInlineStyle) {
    switch atom {
    case let .char(char), let .literal(char):
      if style != bufferStyle { flush() }
      bufferStyle = style
      buffer.append(char)
    case let .opaque(parts):
      flush()
      for part in parts {
        var styled = part
        styled.style.formUnion(style)
        push(styled)
      }
    }
  }

  /// Wynik po domknięciu bufora.
  var finished: [MarkdownSpan] {
    var copy = self
    copy.flush()
    return copy.spans
  }

  private mutating func flush() {
    guard !buffer.isEmpty else { return }
    push(MarkdownSpan(buffer, bufferStyle))
    buffer = ""
  }

  private mutating func push(_ span: MarkdownSpan) {
    if let last = spans.last, last.style == span.style, last.link == span.link {
      spans[spans.count - 1].text += span.text
    } else {
      spans.append(span)
    }
  }
}
