import Foundation
import RarogContractFixtures
import Testing

// Strażnik przekazań przełącznika transportu: każda funkcja i zmienna protokołów `RarogTransporting`
// i `TerminalTransporting` ma w `SwitchingTransport.swift` odpowiednik o tej samej nazwie i etykietach argumentów.
// Rozszerzenia protokołu dają domyślne odpowiedzi (404, brak odmowy klucza, trasa 0), więc brak przekazania
// kompiluje się i milczy: przełącznik oddawałby 404 zamiast pytać serwer. Test jest grepowy, bo taki brak ma się
// pokazać jako czerwony test, a nie na urządzeniu.
//
// Granice: porównuje nazwy i etykiety, nie typy (zmianę typu w protokole wyłapie kompilator, bo deklaracja
// przełącznika przestaje go spełniać i wchodzi domyślna z rozszerzenia tylko przy innej etykiecie albo nazwie).

@Suite("strażnik przekazań: przełącznik transportu ma odpowiednik każdej trasy protokołów")
struct TunnelForwardingTests {
  static let packages = "native/Rarog/Packages/RarogCore/Sources/RarogCore/"
  static let protocols: [(file: String, name: String)] = [
    ("RarogTransporting.swift", "RarogTransporting"),
    ("TerminalSession.swift", "TerminalTransporting"),
  ]
  static let switching = "Transport/SwitchingTransport.swift"

  @Test("każda func i var obu protokołów ma odpowiednik w SwitchingTransport.swift")
  func everyRouteForwarded() throws {
    let implementation = try Self.source(Self.switching)
    var required: [String] = []
    for (file, name) in Self.protocols {
      let source = try Self.source(file)
      let body = try #require(Self.protocolBody(name, in: source), "brak protokołu \(name)")
      let found = Self.declarations(in: body)
      // A parser that drops declarations would leave the guard with nothing to check. The line scan counts the
      // same protocol another way, so a new route changes both counts and a lost declaration changes only one.
      let counted = try #require(Self.declarationLines(of: name, in: source), "no protocol \(name) in the line scan")
      #expect(counted > 0, "\(name): the line scan found no declarations")
      #expect(found.count == counted, "\(name): parser \(found.count), line scan \(counted): \(found)")
      required += found
    }
    #expect(Self.missing(required, in: implementation) == [])
  }

  @Test("strażnik pada na sztucznie dopisanej trasie bez przekazania i na zmienionej etykiecie")
  func guardCatchesMissingForward() throws {
    let implementation = try Self.source(Self.switching)
    let real = try #require(Self.protocolBody("RarogTransporting", in: try Self.source("RarogTransporting.swift")))
    let extra = real + """

        func extraRoute(id: String, _ body: Data) async throws(TransportError) -> Data
        var extraFlag: Bool { get }
        func version(refresh: Bool) async throws(TransportError) -> VersionInfo

      """
    #expect(Self.missing(Self.declarations(in: extra), in: implementation)
      == ["extraRoute(id:_:)", "var extraFlag", "version(refresh:)"])
  }

  @Test("etykiety argumentów: zagnieżdżone nawiasy, domknięcia i typy generyczne nie rozbijają listy")
  func labelsParsing() {
    let source = """
      func a(sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (Int, Int) -> Void)?)
      func b(_ scope: StreamScope, lastEventId: String? = nil, map: Dictionary<String, Int> = [:]) -> Int
      func c() async
      public var d: Bool { true }
      """
    #expect(Self.declarations(in: source) == ["a(sessionId:_:timeout:progress:)", "b(_:lastEventId:map:)", "c()", "var d"])
  }

  @Test("a protocol whose name only starts with the searched one is not taken for it, by either scan")
  func longerNameIsAnotherProtocol() throws {
    let source = """
      protocol RouteProbe: Sendable {
        func probe() async
      }
      protocol Route: Sendable {
        func a() async
        var b: Bool { get }
      }
      """
    #expect(Self.declarations(in: try #require(Self.protocolBody("Route", in: source))) == ["a()", "var b"])
    #expect(Self.declarationLines(of: "Route", in: source) == 2)
  }

  // MARK: - Skaner

  static func source(_ relative: String) throws -> String {
    let url = try GoldenFrames.repoRoot().appending(path: packages + relative)
    return SwiftSource.stripComments(try String(contentsOf: url, encoding: .utf8))
  }

  /// Wnętrze `protocol <name> … { … }` (bez klamer). The name ends where it is written: `protocol <name>Probe` is
  /// another protocol.
  static func protocolBody(_ name: String, in source: String) -> String? {
    var from = source.startIndex
    var head: Range<String.Index>?
    while head == nil, let hit = source.range(of: "protocol \(name)", range: from ..< source.endIndex) {
      let next = hit.upperBound < source.endIndex ? source[hit.upperBound] : " "
      if !(next.isLetter || next.isNumber || next == "_") { head = hit }
      from = hit.upperBound
    }
    guard let start = head else { return nil }
    let text = Array(source[start.upperBound...])
    guard let open = text.firstIndex(of: "{") else { return nil }
    var depth = 0
    for index in open ..< text.count {
      if text[index] == "{" { depth += 1 }
      if text[index] == "}" {
        depth -= 1
        if depth == 0 { return String(text[(open + 1) ..< index]) }
      }
    }
    return nil
  }

  /// Deklaracje w kolejności: `nazwa(etykieta:…)` dla funkcji, `var nazwa` dla zmiennych.
  static func declarations(in source: String) -> [String] {
    let text = Array(source)
    var out: [String] = []
    var index = 0
    while index < text.count {
      if let name = word(after: "func", at: index, in: text) {
        var cursor = name.end
        while cursor < text.count, text[cursor] != "(" { cursor += 1 }
        guard let close = matching(from: cursor, in: text) else { break }
        let labels = parameters(String(text[(cursor + 1) ..< close])).map { "\($0):" }.joined()
        out.append("\(name.word)(\(labels))")
        index = close + 1
      } else if let name = word(after: "var", at: index, in: text) {
        out.append("var \(name.word)")
        index = name.end
      } else {
        index += 1
      }
    }
    return out
  }

  /// Second, independent count of a protocol's declarations: by lines, not by braces and characters. The body runs
  /// from the line after `protocol <name>` to the first line that starts with `}`; a declaration is a line whose
  /// first word after attributes and modifiers is `func` or `var`. Each requirement starts on its own line. The
  /// protocol line is the one with the words `protocol` and `<name>` next to each other, found by words, not by
  /// the text search of `protocolBody`.
  static func declarationLines(of name: String, in source: String) -> Int? {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
    let isHead: (Substring) -> Bool = { line in
      let words = line.split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == "_") })
      return zip(words, words.dropFirst()).contains { $0 == "protocol" && $1 == name[...] }
    }
    guard let start = lines.firstIndex(where: isHead),
      let end = lines[(start + 1)...].firstIndex(where: { $0.hasPrefix("}") })
    else { return nil }
    return lines[(start + 1) ..< end].filter { line in
      let keyword = line.split(whereSeparator: \.isWhitespace).first { !$0.hasPrefix("@") && !modifiers.contains($0) }
      return keyword == "func" || keyword == "var"
    }.count
  }

  private static let modifiers: Set<Substring> = ["static", "mutating", "nonmutating", "nonisolated"]

  /// Wymagane deklaracje bez odpowiednika w źródle implementacji.
  static func missing(_ required: [String], in implementation: String) -> [String] {
    let present = Set(declarations(in: implementation))
    return required.filter { !present.contains($0) }
  }

  /// Słowo kluczowe na granicy słowa i nazwa po nim.
  private static func word(after keyword: String, at index: Int, in text: [Character]) -> (word: String, end: Int)? {
    let key = Array(keyword)
    guard index + key.count < text.count, Array(text[index ..< index + key.count]) == key else { return nil }
    if index > 0, text[index - 1].isLetter || text[index - 1].isNumber || text[index - 1] == "_" { return nil }
    var cursor = index + key.count
    guard text[cursor].isWhitespace else { return nil }
    while cursor < text.count, text[cursor].isWhitespace { cursor += 1 }
    let start = cursor
    while cursor < text.count, text[cursor].isLetter || text[cursor].isNumber || text[cursor] == "_" { cursor += 1 }
    guard cursor > start else { return nil }
    return (String(text[start ..< cursor]), cursor)
  }

  /// Indeks nawiasu zamykającego dla `(` pod `open`.
  private static func matching(from open: Int, in text: [Character]) -> Int? {
    guard open < text.count, text[open] == "(" else { return nil }
    var depth = 0
    for index in open ..< text.count {
      if text[index] == "(" { depth += 1 }
      if text[index] == ")" {
        depth -= 1
        if depth == 0 { return index }
      }
    }
    return nil
  }

  /// Etykiety zewnętrzne parametrów (`_` dla parametru bez etykiety).
  private static func parameters(_ list: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var depth = 0
    var previous: Character = " "
    for character in list {
      switch character {
      case "(", "[": depth += 1
      case ")", "]": depth -= 1
      case "<": depth += 1
      case ">" where previous != "-": depth -= 1
      case "," where depth == 0:
        parts.append(current)
        current = ""
        previous = character
        continue
      default: break
      }
      current.append(character)
      previous = character
    }
    parts.append(current)
    return parts.compactMap { part in
      let head = part.split(separator: ":", maxSplits: 1).first.map(String.init) ?? ""
      return head.split(whereSeparator: \.isWhitespace).first.map(String.init)
    }
  }
}
