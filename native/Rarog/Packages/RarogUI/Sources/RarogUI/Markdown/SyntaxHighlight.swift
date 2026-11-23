import Foundation
import Synchronization

// Kolorowanie składni w transkrypcie: skaner z rodzinami języków, listami słów, klasami tokenów
// i sufitem `SyntaxHighlight.maxLength`. Wejściem jest surowy tekst, wyjściem — zakresy z klasą. Zakresy
// liczymy w jednostkach UTF-16, więc trafiają wprost w `NSRange` atrybutów tekstu.
//
// Zasady, w tej kolejności:
// 1. NIGDY NIE GUBIMY TREŚCI — skaner nie zmienia tekstu, tylko go opisuje; nieznany język, blok ponad
//    sufitem, urwany napis czy niedomknięty komentarz dają mniej koloru, nigdy mniej znaków;
// 2. JEDEN PRZEBIEG, BEZ COFANIA SIĘ — blok bywa logiem builda, a płynąca odpowiedź renderuje się
//    od nowa przy każdej delcie;
// 3. ZERO ZALEŻNOŚCI.
// Czysta funkcja bez UIKit, testy na macOS (`SyntaxHighlightTests`). Bloki domknięte biorą tokeny z pamięci
// skanów (``SyntaxCache``). Kolory klas: `Palette.syntax` (tokeny `hl*` w `PaletteTokens`).
// Właściciel: transkrypt, markdown.

/// Klasa tokenu — te same jednoliterowe nazwy co klasy `hl-*` w PWA.
public enum SyntaxClass: String, Sendable, Equatable, CaseIterable {
  /// Komentarz (i nagłówek pliku w diffie).
  case c
  /// Napis.
  case s
  /// Słowo kluczowe (i nazwa znacznika HTML).
  case k
  /// Liczba (i kolor `#rrggbb` w CSS).
  case n
  /// Literał: `true`, `false`, `null`…
  case l
  /// Nazwa: funkcja, komenda powłoki, klucz obiektu, atrybut, `$zmienna`.
  case f
  /// Linia dodana w diffie.
  case add
  /// Linia usunięta w diffie.
  case del
}

/// Token: zakres w jednostkach UTF-16 tekstu wejściowego i jego klasa.
public struct SyntaxToken: Sendable, Equatable {
  public let range: Range<Int>
  public let kind: SyntaxClass

  public init(_ range: Range<Int>, _ kind: SyntaxClass) {
    self.range = range
    self.kind = kind
  }
}

public enum SyntaxHighlight {
  /// Powyżej tylu znaków blok zostaje bez koloru. Liczony od tekstu PO escapingu HTML
  /// (``escapedLength(_:)``). Budżet apki zmierzony osobno (`SyntaxHighlightCostTests`, build release):
  /// skan bloku pod sufitem ~1 ms, układ całej wiadomości z nim ~3 ms, przy renderze płynącej odpowiedzi
  /// najwyżej co 60 ms — sufit apki zostaje ten sam.
  public static let maxLength = 40_000

  /// Rodzina składni dla nazwy z fence'a (`nil` = nieznany język, bez koloru).
  public static func family(_ language: String) -> Family? {
    familyByName[language.lowercased()]
  }

  /// Czy dla tej nazwy z fence'a jest gramatyka (pasek bloku pokazuje wtedy język, ``MarkdownLayout``).
  public static func isKnown(_ language: String) -> Bool {
    family(language) != nil
  }

  /// Tokeny tekstu w danym języku, posortowane i rozłączne. Pusta lista = bez koloru: nieznany język,
  /// brak języka albo blok ponad ``maxLength``.
  public static func tokens(_ code: String, language: String?) -> [SyntaxToken] {
    guard let language, let family = family(language) else { return [] }
    return scan(code, family: family)
  }

  static func scan(_ code: String, family: Family) -> [SyntaxToken] {
    let units = Array(code.utf16)
    guard escapedLength(units) <= maxLength else { return [] }
    var scanner = Scanner(code: units)
    switch family {
    case .markup: scanner.markup()
    case .diff: scanner.diff()
    case let .generic(spec): scanner.generic(Specs.spec(spec))
    }
    return scanner.out
  }

  /// Długość tekstu po escapingu HTML (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`,
  /// `'` → `&#39;`) — miara sufitu ``maxLength``.
  static func escapedLength(_ units: [UInt16]) -> Int {
    var length = units.count
    for unit in units {
      switch unit {
      case Ch.amp: length += 4
      case Ch.lt, Ch.gt: length += 3
      case Ch.dquote: length += 5
      case Ch.squote: length += 4
      default: break
      }
    }
    return length
  }

  /// Tokeny całego bloku pocięte na linie: blok koloruje się w całości (komentarz i napis przechodzą
  /// przez granicę linii, ciało heredoca też), a każda linia dostaje swoje kawałki z zakresem liczonym
  /// od własnego początku. `lineLengths` to długości linii w UTF-16, bez `\n` między nimi.
  public static func split(_ tokens: [SyntaxToken], lineLengths: [Int]) -> [[SyntaxToken]] {
    var out: [[SyntaxToken]] = []
    out.reserveCapacity(lineLengths.count)
    var first = 0
    var lineStart = 0
    for length in lineLengths {
      let lineEnd = lineStart + length
      while first < tokens.count, tokens[first].range.upperBound <= lineStart { first += 1 }
      var pieces: [SyntaxToken] = []
      var index = first
      while index < tokens.count, tokens[index].range.lowerBound < lineEnd {
        let token = tokens[index]
        let lower = max(token.range.lowerBound, lineStart)
        let upper = min(token.range.upperBound, lineEnd)
        if lower < upper { pieces.append(SyntaxToken((lower - lineStart)..<(upper - lineStart), token.kind)) }
        index += 1
      }
      out.append(pieces)
      lineStart = lineEnd + 1
    }
    return out
  }

  /// Rodzina składni: skaner ogólny ze specyfikacją albo jeden z dwóch własnych skanerów.
  public enum Family: Sendable, Hashable {
    case generic(SpecName)
    /// Znaczniki (HTML/XML).
    case markup
    case diff
  }

  /// Gramatyki skanera ogólnego (`SPECS` w PWA).
  public enum SpecName: Sendable, Hashable {
    case js, json, sh, py, rb, go, rs, c, sql, css, yaml
  }

  /// Nazwa z fence'a → rodzina (`FAMILY` w PWA). Aliasy tutaj, żeby jedna gramatyka obsłużyła
  /// kilkanaście nazw bez kopiowania list słów.
  static let familyByName: [String: Family] = {
    var map: [String: Family] = [:]
    func add(_ names: String, _ family: Family) {
      for name in names.split(separator: " ") { map[String(name)] = family }
    }
    add("ts tsx typescript mts cts js jsx javascript mjs cjs node", .generic(.js))
    add("json jsonc json5", .generic(.json))
    add("sh bash zsh shell console terminal fish", .generic(.sh))
    add("py python python3", .generic(.py))
    add("rb ruby", .generic(.rb))
    add("go golang", .generic(.go))
    add("rs rust", .generic(.rs))
    add("java kt kotlin swift c cpp c++ h hpp cs csharp php dart scala groovy", .generic(.c))
    add("sql postgres postgresql psql mysql sqlite", .generic(.sql))
    add("css scss less sass", .generic(.css))
    add("yaml yml toml ini conf env dotenv", .generic(.yaml))
    add("html xml svg vue xhtml htm", .markup)
    add("diff patch", .diff)
    return map
  }()
}

// MARK: - Pamięć skanów

/// Pamięć wyników skanu DOMKNIĘTYCH bloków kodu, po (tekst bloku, rodzina). Płynąca odpowiedź renderuje się
/// od nowa przy każdej delcie (do ~16 razy na sekundę), a bloki nad tym, który właśnie rośnie, się nie
/// zmieniają — ich tokeny przychodzą stąd zamiast z ponownego skanu. Blok otwarty (rośnie) skanuje się za
/// każdym razem i tu nie trafia: każda jego wersja byłaby inna. Sufit liczby wpisów i łącznej liczby tokenów
/// (najstarsze użycie wypada pierwsze), żeby pamięć nie rosła z historią sesji.
public final class SyntaxCache: Sendable {
  public static let shared = SyntaxCache()

  /// Najwięcej wpisów i łącznie tokenów (~24 B na token: 250 000 to ~6 MB w najgęstszym przypadku).
  public let maxEntries: Int
  public let maxTokens: Int

  /// Klucz po DOKŁADNYCH bajtach tekstu: `String` porównuje kanonicznie („é” NFC == „e\u{301}” NFD), a zakresy
  /// tokenów liczą jednostki UTF-16 konkretnego zapisu — trafienie dla równoważnego, ale innego zapisu dałoby
  /// kolory przesunięte o znak.
  private struct Key: Hashable {
    let code: String
    let family: SyntaxHighlight.Family

    static func == (lhs: Key, rhs: Key) -> Bool {
      lhs.family == rhs.family && lhs.code.utf8.elementsEqual(rhs.code.utf8)
    }

    func hash(into hasher: inout Hasher) {
      hasher.combine(family)
      var code = code
      code.withUTF8 { hasher.combine(bytes: UnsafeRawBufferPointer($0)) }
    }
  }

  private struct State {
    /// Tokeny i chwila ostatniego użycia (licznik, nie zegar).
    var entries: [Key: (tokens: [SyntaxToken], used: Int)] = [:]
    var clock = 0
    var tokens = 0
    var scans = 0
  }

  private let state = Mutex(State())

  public init(maxEntries: Int = 64, maxTokens: Int = 250_000) {
    self.maxEntries = maxEntries
    self.maxTokens = maxTokens
  }

  /// Ile razy skaner naprawdę ruszył (bez trafień w pamięć) — dla testów kosztu.
  public var scans: Int { state.withLock { $0.scans } }

  /// Tokeny bloku: z pamięci dla bloku domkniętego, ze skanu dla otwartego.
  public func tokens(_ code: String, language: String?, closed: Bool) -> [SyntaxToken] {
    guard let language, let family = SyntaxHighlight.family(language) else { return [] }
    let key = Key(code: code, family: family)
    if closed, let hit = state.withLock({ state -> [SyntaxToken]? in
      guard let hit = state.entries[key]?.tokens else { return nil }
      state.clock += 1
      state.entries[key]?.used = state.clock
      return hit
    }) {
      return hit
    }
    let tokens = SyntaxHighlight.scan(code, family: family)
    state.withLock { state in
      state.scans += 1
      // Blok bez koloru (ponad sufitem) nie ma czego pamiętać — sprawdzenie sufitu kosztuje jedno przejście.
      guard closed, !tokens.isEmpty, tokens.count <= maxTokens, state.entries[key] == nil else { return }
      state.clock += 1
      state.entries[key] = (tokens, state.clock)
      state.tokens += tokens.count
      while state.entries.count > maxEntries || state.tokens > maxTokens {
        guard let oldest = state.entries.min(by: { $0.value.used < $1.value.used })?.key else { break }
        state.tokens -= state.entries.removeValue(forKey: oldest)?.tokens.count ?? 0
      }
    }
    return tokens
  }

  /// Ile wpisów i tokenów trzyma pamięć — dla testów sufitu.
  public var footprint: (entries: Int, tokens: Int) { state.withLock { ($0.entries.count, $0.tokens) } }
}

// MARK: - Gramatyki

/// Specyfikacja języka dla skanera ogólnego (`Spec` w PWA).
struct SyntaxSpec: Sendable {
  /// Prefiksy komentarza liniowego.
  var line: [[UInt16]] = []
  /// Pary komentarza blokowego (otwarcie, domknięcie).
  var block: [(open: [UInt16], close: [UInt16])] = []
  /// Znaki cudzysłowu.
  var quote: [UInt16] = []
  var key: Set<String> = []
  var lit: Set<String> = []
  /// Słowa bez rozróżniania wielkości liter (SQL).
  var ci = false
  /// Nazwa przed dwukropkiem to klucz (JSON, YAML, CSS).
  var colon = false
  /// `#rrggbb` jest liczbą, a `@media` słowem kluczowym (CSS) — i `#` nie zaczyna komentarza.
  var css = false
  /// `$zmienna` i `${zmienna}` dostają kolor nazwy (shell).
  var dollar = false
  /// Słowo w POZYCJI KOMENDY (początek linii, za `|`, `;`, `&`, `(`, za `then`/`do`/`sudo`…) dostaje kolor
  /// nazwy (shell); przypisanie `FOO=1 cmd` zostaje tekstem i nie zjada pozycji komendy.
  var cmd = false
  /// Znaki, które poza `[A-Za-z0-9_$]` też należą do identyfikatora.
  var extra: [UInt16] = []
}

enum Specs {
  private static func words(_ list: String) -> Set<String> {
    Set(list.split(separator: " ").map(String.init))
  }

  private static func units(_ text: String) -> [UInt16] { Array(text.utf16) }

  static let jsKey = words(
    "abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let new of override package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield")
  static let jsLit = words("true false null undefined NaN Infinity")

  static let pyKey = words(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield self case")
  static let pyLit = words("True False None NotImplemented Ellipsis")

  static let shKey = words(
    "if then else elif fi for while until do done case esac function in return local export readonly declare typeset unset shift source alias set trap eval exec break continue echo cd test")
  /// Po tych słowach dalej stoi komenda (`then cmd`, `sudo cmd`, `time cmd`).
  static let shPrefix = words("if then else elif while until do time sudo exec nohup env command builtin")

  static let goKey = words(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var bool byte error float32 float64 int int8 int16 int32 int64 rune string uint uintptr")
  static let goLit = words("true false nil iota")

  static let rsKey = words(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while bool char f32 f64 i8 i16 i32 i64 isize str u8 u16 u32 u64 usize String Vec Option Result")
  static let rsLit = words("true false None Some Ok Err self Self")

  static let rbKey = words(
    "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer include extend private public protected raise")
  static let rbLit = words("true false nil __FILE__ __LINE__")

  /// Jedna lista na rodzinę „nawiasy klamrowe i średniki": Java, C/C++, C#, Kotlin, Swift, PHP.
  static let cKey = words(
    "abstract assert bool boolean break byte case catch char class const continue decimal default delegate do double else enum event explicit extends extension final finally float for foreach fun func function goto guard if implements import in inline instanceof int interface internal is lazy let long namespace native new object open operator out override package private protected public readonly record ref return sealed short sizeof static string struct super switch synchronized template this throw throws transient try typedef typeof union unsigned using val var virtual void volatile when where while")
  static let cLit = words("true false null nil None NULL nullptr undefined self this")

  static let sqlKey = words(
    "add all alter and any as asc between by case cascade check column constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert intersect into is join key left like limit not null offset on or order outer primary references returning right select set table then union unique update using values view when where with recursive as_of asc")
  static let sqlLit = words("null true false")

  static let yamlLit = words("true false null yes no on off True False Null Yes No On Off")

  private static let slashes = [units("//")]
  private static let cBlock = [(open: units("/*"), close: units("*/"))]
  private static let hash = [units("#")]
  private static let dq = Ch.dquote
  private static let sq = Ch.squote
  private static let tick = Ch.backtick

  static let js = SyntaxSpec(line: slashes, block: cBlock, quote: [dq, sq, tick], key: jsKey, lit: jsLit)
  static let json = SyntaxSpec(line: slashes, block: cBlock, quote: [dq], lit: words("true false null"), colon: true)
  static let sh = SyntaxSpec(line: hash, quote: [dq, sq], key: shKey, dollar: true, cmd: true)
  static let py = SyntaxSpec(line: hash, quote: [dq, sq], key: pyKey, lit: pyLit)
  static let rb = SyntaxSpec(line: hash, quote: [dq, sq], key: rbKey, lit: rbLit, extra: units("?!"))
  static let go = SyntaxSpec(line: slashes, block: cBlock, quote: [dq, tick], key: goKey, lit: goLit)
  static let rs = SyntaxSpec(line: slashes, block: cBlock, quote: [dq], key: rsKey, lit: rsLit)
  static let c = SyntaxSpec(line: slashes, block: cBlock, quote: [dq, sq], key: cKey, lit: cLit)
  static let sql = SyntaxSpec(line: [units("--")], block: cBlock, quote: [sq, dq], key: sqlKey, lit: sqlLit, ci: true)
  static let css = SyntaxSpec(line: slashes, block: cBlock, quote: [dq, sq], colon: true, css: true, extra: units("-"))
  static let yaml = SyntaxSpec(line: hash, quote: [dq, sq], lit: yamlLit, colon: true, extra: units("-."))

  static func spec(_ name: SyntaxHighlight.SpecName) -> SyntaxSpec {
    switch name {
    case .js: js
    case .json: json
    case .sh: sh
    case .py: py
    case .rb: rb
    case .go: go
    case .rs: rs
    case .c: c
    case .sql: sql
    case .css: css
    case .yaml: yaml
    }
  }
}

// MARK: - Znaki

/// Jednostki UTF-16 znaków, o które pyta skaner. `none` (-1) to odpowiednik pustego `charAt` w JS:
/// pozycja poza tekstem, różna od każdego znaku — także od NUL, który bywa w tekście.
enum Ch {
  static let none = -1
  static let tab: UInt16 = 0x09
  static let newline: UInt16 = 0x0A
  static let space: UInt16 = 0x20
  static let bang: UInt16 = 0x21
  static let dquote: UInt16 = 0x22
  static let hash: UInt16 = 0x23
  static let dollar: UInt16 = 0x24
  static let percent: UInt16 = 0x25
  static let amp: UInt16 = 0x26
  static let squote: UInt16 = 0x27
  static let lparen: UInt16 = 0x28
  static let plus: UInt16 = 0x2B
  static let dash: UInt16 = 0x2D
  static let dot: UInt16 = 0x2E
  static let slash: UInt16 = 0x2F
  static let colon: UInt16 = 0x3A
  static let semicolon: UInt16 = 0x3B
  static let lt: UInt16 = 0x3C
  static let equals: UInt16 = 0x3D
  static let gt: UInt16 = 0x3E
  static let question: UInt16 = 0x3F
  static let at: UInt16 = 0x40
  static let backslash: UInt16 = 0x5C
  static let underscore: UInt16 = 0x5F
  static let backtick: UInt16 = 0x60
  static let lbrace: UInt16 = 0x7B
  static let pipe: UInt16 = 0x7C
  static let rbrace: UInt16 = 0x7D
  static let tilde: UInt16 = 0x7E

  static func isDigit(_ c: Int) -> Bool { c >= 0x30 && c <= 0x39 }
  static func isLetter(_ c: Int) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
  static func isHex(_ c: Int) -> Bool { isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66) }

  /// Ciało liczby `[0-9a-fA-F_.xXoObB]`: `0x1f`, `1_000`, `1.5`, `1e9`; bez `+`/`-`, żeby `1-2` się nie skleiło.
  static func isNum(_ c: Int) -> Bool {
    isHex(c) || c == Int(underscore) || c == Int(dot) || c == 0x78 || c == 0x58 || c == 0x6F || c == 0x4F
      || c == 0x62 || c == 0x42
  }

  /// `[A-Za-z0-9_$]`.
  static func isWordChar(_ c: Int) -> Bool { isLetter(c) || isDigit(c) || c == Int(underscore) || c == Int(dollar) }

  /// Początek nazwy komendy `[A-Za-z_./~]`.
  static func isCmdStart(_ c: Int) -> Bool {
    isLetter(c) || c == Int(underscore) || c == Int(dot) || c == Int(slash) || c == Int(tilde)
  }

  /// Znak nazwy komendy `[A-Za-z0-9_./~+-]`: `./scripts/x.sh`, `~/bin/a-b`, `g++`.
  static func isCmdWord(_ c: Int) -> Bool { isCmdStart(c) || isDigit(c) || c == Int(plus) || c == Int(dash) }

  /// Słowo terminatora heredoca bez cudzysłowu `[A-Za-z0-9_]`.
  static func isHeredocWord(_ c: Int) -> Bool { isLetter(c) || isDigit(c) || c == Int(underscore) }

  /// Znak, za którym dalszy znak należy do ścieżki `[A-Za-z0-9_./~%]`.
  static func isPathChar(_ c: Int) -> Bool {
    isLetter(c) || isDigit(c) || c == Int(underscore) || c == Int(dot) || c == Int(slash) || c == Int(tilde)
      || c == Int(percent)
  }

  /// Nazwa znacznika i atrybutu `[A-Za-z0-9_:.!?/-]`: `<my-tag>`, `<?xml`, `<!DOCTYPE`, `xlink:href`.
  static func isTagName(_ c: Int) -> Bool {
    isLetter(c) || isDigit(c) || c == Int(underscore) || c == Int(colon) || c == Int(dot) || c == Int(bang)
      || c == Int(question) || c == Int(slash) || c == Int(dash)
  }

  /// Biały znak w sensie `\s` z JS (komentarz `#` otwiera się tylko po nim).
  static func isSpace(_ c: Int) -> Bool {
    switch c {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }
}

// MARK: - Skaner

/// Stałe ciągi skanerów znaczników i diffu (bez alokacji w pętli).
private enum Lit {
  static let commentOpen = Array("<!--".utf16)
  static let commentClose = Array("-->".utf16)
  static let newFile = Array("+++".utf16)
  static let oldFile = Array("---".utf16)
  static let diffHeader = Array("diff ".utf16)
  static let hunk = Array("@@".utf16)
}

private struct Scanner {
  let code: [UInt16]
  var out: [SyntaxToken] = []

  init(code: [UInt16]) {
    self.code = code
  }

  /// `code.charAt(i)`: jednostka pod `i` albo `Ch.none` poza tekstem.
  func at(_ i: Int) -> Int { i >= 0 && i < code.count ? Int(code[i]) : Ch.none }

  mutating func token(_ start: Int, _ end: Int, _ kind: SyntaxClass) {
    out.append(SyntaxToken(start..<end, kind))
  }

  /// `code.startsWith(prefix, at)` z końcem przeszukiwania `limit` (diff patrzy w obrębie linii).
  func starts(_ prefix: [UInt16], at index: Int, limit: Int? = nil) -> Bool {
    let end = limit ?? code.count
    guard index >= 0, index + prefix.count <= end else { return false }
    for (offset, unit) in prefix.enumerated() where code[index + offset] != unit { return false }
    return true
  }

  /// `code.indexOf(unit, from)` przed `limit`; -1 = brak.
  func index(of unit: UInt16, from: Int, limit: Int? = nil) -> Int {
    let end = limit ?? code.count
    var i = max(from, 0)
    while i < end {
      if code[i] == unit { return i }
      i += 1
    }
    return -1
  }

  /// `code.indexOf(text, from)`; -1 = brak.
  func index(of text: [UInt16], from: Int) -> Int {
    guard let first = text.first else { return min(max(from, 0), code.count) }
    var i = max(from, 0)
    while i + text.count <= code.count {
      if code[i] == first, starts(text, at: i) { return i }
      i += 1
    }
    return -1
  }

  func string(_ start: Int, _ end: Int) -> String {
    String(decoding: code[start..<end], as: UTF16.self)
  }

  func isWord(_ c: Int, _ extra: [UInt16]) -> Bool {
    Ch.isWordChar(c) || (c != Ch.none && extra.contains(UInt16(c)))
  }

  /// Czy zaraz za `at` (po spacjach i tabulatorach w TEJ SAMEJ linii) stoi `unit`.
  func follows(_ at: Int, _ unit: UInt16) -> Bool {
    var i = at
    while i < code.count, code[i] == Ch.space || code[i] == Ch.tab { i += 1 }
    return self.at(i) == Int(unit)
  }

  /// `#` zaczyna komentarz tylko na początku słowa: `${VAR#prefix}` w shellu i `x#y` w adresie
  /// zjadałyby resztę linii.
  func opensComment(_ at: Int, _ prefix: [UInt16]) -> Bool {
    guard prefix == [Ch.hash] else { return true }
    if at == 0 { return true }
    return Ch.isSpace(self.at(at - 1))
  }

  /// Czy znak pod `at` jest DALSZĄ częścią ścieżki albo nazwy pliku (shell): `web/test/x-2026.ts` to jedna
  /// nazwa — `test` nie jest w niej słowem kluczowym, a `2026` liczbą. Wyjątek: `-1` po białym znaku albo
  /// `=` to flaga albo liczba ujemna, nie ogon nazwy.
  func inPath(_ at: Int) -> Bool {
    let prev = self.at(at - 1)
    if prev == Ch.none { return false }
    if prev == Int(Ch.dash) || prev == Int(Ch.plus) {
      let before = self.at(at - 2)
      return !(before == Ch.none || before == Int(Ch.space) || before == Int(Ch.tab) || before == Int(Ch.newline)
        || before == Int(Ch.equals))
    }
    return Ch.isPathChar(prev)
  }

  // MARK: Skaner ogólny

  // swiftlint:disable:next function_body_length cyclomatic_complexity
  mutating func generic(_ spec: SyntaxSpec) {
    let n = code.count
    let extra = spec.extra
    // Pozycja komendy (shell): prawdziwa na starcie i po separatorach, fałszywa po każdym innym tokenie.
    var atCmd = spec.cmd
    // W trakcie `FOO=wartość` przed komendą: do białego znaku albo separatora nic nie rusza pozycji komendy.
    var assigning = false
    // Otwarty backtick: pozycję komendy otwiera TYLKO otwierający (`echo \`date\` plik` — `plik` to argument).
    var inTick = false
    // Heredoki zapowiedziane w bieżącej linii: ich ciała od następnego wiersza są DANYMI, bez koloru.
    var heredocs: [(word: [UInt16], dash: Bool)] = []
    var i = 0
    while i < n {
      let ch = Int(code[i])

      // --- ciało heredoca (shell): od nowej linii do wiersza równego terminatorowi ---
      if !heredocs.isEmpty, ch == Int(Ch.newline) {
        i += 1
        for doc in heredocs {
          var j = i
          while j < n {
            let eol = index(of: Ch.newline, from: j)
            let stop = eol == -1 ? n : eol
            var lineStart = j
            if doc.dash { while lineStart < stop, code[lineStart] == Ch.tab { lineStart += 1 } }
            if code[lineStart..<stop].elementsEqual(doc.word) {
              j = stop
              break
            }
            j = eol == -1 ? n : eol + 1
          }
          i = j
        }
        heredocs = []
        atCmd = true
        continue
      }

      // --- zapowiedź heredoca `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` (shell) ---
      if spec.cmd, ch == Int(Ch.lt), at(i + 1) == Int(Ch.lt), at(i + 2) != Int(Ch.lt) {
        var j = i + 2
        let dash = at(j) == Int(Ch.dash)
        if dash { j += 1 }
        while at(j) == Int(Ch.space) { j += 1 }
        let quote = at(j)
        let quoted = quote == Int(Ch.squote) || quote == Int(Ch.dquote)
        let wordAt = quoted ? j + 1 : j
        var k = wordAt
        while k < n, quoted ? Int(code[k]) != quote : Ch.isHeredocWord(Int(code[k])) { k += 1 }
        if k > wordAt, !quoted || at(k) == quote {
          let end = quoted ? k + 1 : k
          if quoted { token(j, end, .s) }
          heredocs.append((Array(code[wordAt..<k]), dash))
          atCmd = false
          i = end
          continue
        }
      }

      // --- słowo w pozycji komendy (shell) ---
      if atCmd, !assigning, Ch.isCmdStart(ch) {
        var j = i
        while j < n, Ch.isCmdWord(Int(code[j])) { j += 1 }
        if at(j) == Int(Ch.equals) {
          assigning = true
          i = j
          continue
        }
        let word = string(i, j)
        if spec.key.contains(word) || Specs.shPrefix.contains(word) {
          token(i, j, .k)
          atCmd = Specs.shPrefix.contains(word)
        } else {
          token(i, j, .f)
          atCmd = false
        }
        i = j
        continue
      }
      if spec.cmd {
        if ch == Int(Ch.backtick) {
          inTick.toggle()
          atCmd = inTick
          assigning = false
        } else if ch == Int(Ch.newline) || ch == Int(Ch.pipe) || ch == Int(Ch.semicolon) || ch == Int(Ch.amp)
          || ch == Int(Ch.lparen) {
          atCmd = true
          assigning = false
        } else if ch == Int(Ch.space) || ch == Int(Ch.tab) {
          if assigning {
            assigning = false
            atCmd = true
          }
        } else if !assigning {
          atCmd = false
        }
      }

      // --- komentarz blokowy ---
      if let block = spec.block.first(where: { starts($0.open, at: i) }) {
        let end = index(of: block.close, from: i + block.open.count)
        let stop = end == -1 ? n : end + block.close.count
        token(i, stop, .c)
        i = stop
        continue
      }

      // --- komentarz liniowy ---
      if let line = spec.line.first(where: { starts($0, at: i) }), opensComment(i, line) {
        let end = index(of: Ch.newline, from: i)
        let stop = end == -1 ? n : end
        token(i, stop, .c)
        i = stop
        continue
      }

      // --- napis ---
      if ch != Ch.none, spec.quote.contains(UInt16(ch)) {
        var j = i + 1
        while j < n {
          let c = Int(code[j])
          if c == Int(Ch.backslash) {
            j += 2
            continue
          }
          if c == ch {
            j += 1
            break
          }
          // Napis bez domknięcia kończy się na linii — inaczej apostrof w komentarzu („don't”)
          // przemalowałby resztę bloku.
          if c == Int(Ch.newline), ch != Int(Ch.backtick) { break }
          j += 1
        }
        let stop = min(j, n)
        token(i, stop, spec.colon && follows(stop, Ch.colon) ? .f : .s)
        i = stop
        continue
      }

      // --- `#rrggbb` i `@media` (CSS) ---
      if spec.css, ch == Int(Ch.hash), Ch.isHex(at(i + 1)) {
        var j = i + 1
        while j < n, Ch.isHex(Int(code[j])) { j += 1 }
        token(i, j, .n)
        i = j
        continue
      }
      if spec.css, ch == Int(Ch.at), isWord(at(i + 1), extra) {
        var j = i + 1
        while j < n, isWord(Int(code[j]), extra) { j += 1 }
        token(i, j, .k)
        i = j
        continue
      }

      // --- `$zmienna` / `${zmienna}` (shell) ---
      if spec.dollar, ch == Int(Ch.dollar) {
        var j = i + 1
        if at(j) == Int(Ch.lbrace) {
          let end = index(of: Ch.rbrace, from: j)
          j = end == -1 ? n : end + 1
        } else {
          while j < n, isWord(Int(code[j]), extra) { j += 1 }
        }
        if j > i + 1 {
          token(i, j, .f)
          i = j
          continue
        }
      }

      // --- liczba ---
      if Ch.isDigit(ch), !(spec.cmd && inPath(i)) {
        var j = i
        while j < n, Ch.isNum(Int(code[j])) { j += 1 }
        token(i, j, .n)
        i = j
        continue
      }

      // --- identyfikator ---
      if isWord(ch, extra), !Ch.isDigit(ch) {
        var j = i
        while j < n, isWord(Int(code[j]), extra) { j += 1 }
        let word = string(i, j)
        let probe = spec.ci ? word.lowercased() : word
        if spec.cmd, inPath(i) {
          // ogon ścieżki: zwykły tekst
        } else if spec.key.contains(probe) {
          token(i, j, .k)
        } else if spec.lit.contains(probe) {
          token(i, j, .l)
        } else if spec.colon, follows(j, Ch.colon) {
          token(i, j, .f)
        } else if follows(j, Ch.lparen) {
          token(i, j, .f)
        }
        i = j
        continue
      }

      i += 1
    }
  }

  // MARK: Znaczniki (HTML/XML)

  mutating func markup() {
    let n = code.count
    var i = 0
    while i < n {
      let lt = index(of: Ch.lt, from: i)
      if lt == -1 { break }
      if starts(Lit.commentOpen, at: lt) {
        let end = index(of: Lit.commentClose, from: lt)
        let stop = end == -1 ? n : end + 3
        token(lt, stop, .c)
        i = stop
        continue
      }
      let gt = index(of: Ch.gt, from: lt)
      let stop = gt == -1 ? n : gt + 1
      tag(lt, stop)
      i = stop
    }
  }

  /// Wnętrze `<…>` w `start..<stop`: nazwa znacznika, potem atrybuty i ich wartości. `<` zostaje tekstem.
  private mutating func tag(_ start: Int, _ stop: Int) {
    var i = start + 1
    var j = i
    while j < stop, Ch.isTagName(Int(code[j])) { j += 1 }
    if j > i { token(i, j, .k) }
    i = j
    // Po `=` idzie WARTOŚĆ atrybutu, nie kolejna nazwa — także bez cudzysłowu (`<img src=x onerror=…>`).
    var value = false
    while i < stop {
      let ch = code[i]
      if ch == Ch.dquote || ch == Ch.squote {
        let end = index(of: ch, from: i + 1, limit: stop)
        let close = end == -1 ? stop : end + 1
        token(i, close, .s)
        value = false
        i = close
        continue
      }
      if Ch.isTagName(Int(ch)), ch != Ch.slash {
        var k = i
        while k < stop, Ch.isTagName(Int(code[k])), code[k] != Ch.slash { k += 1 }
        token(i, k, value ? .s : .f)
        value = false
        i = k
        continue
      }
      if ch == Ch.equals { value = true }
      i += 1
    }
  }

  // MARK: Diff

  /// Diff czyta się linia po linii, więc i kolor jest linijkowy; nagłówki plików (`+++`, `---`) wyglądają
  /// jak dodanie i usunięcie, a nimi nie są.
  mutating func diff() {
    let n = code.count
    var lineStart = 0
    while true {
      let eol = index(of: Ch.newline, from: lineStart)
      let lineEnd = eol == -1 ? n : eol
      if starts(Lit.newFile, at: lineStart, limit: lineEnd) || starts(Lit.oldFile, at: lineStart, limit: lineEnd)
        || starts(Lit.diffHeader, at: lineStart, limit: lineEnd) {
        token(lineStart, lineEnd, .c)
      } else if starts(Lit.hunk, at: lineStart, limit: lineEnd) {
        token(lineStart, lineEnd, .f)
      } else if starts([Ch.plus], at: lineStart, limit: lineEnd) {
        token(lineStart, lineEnd, .add)
      } else if starts([Ch.dash], at: lineStart, limit: lineEnd) {
        token(lineStart, lineEnd, .del)
      }
      if eol == -1 { break }
      lineStart = eol + 1
    }
  }
}
