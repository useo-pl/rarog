// Strażnik źródeł natywnej apki. Kod Swift po zdjęciu komentarzy nie zna
// nazw narzędzi CLI, tekstów CLI ani nie decyduje po kanale odpowiedzi: gdy CLI się zmieni,
// poprawia się serwer, a apka zostaje bez nowej wersji.
//
// WYJĄTKI (jawne):
// - `RarogUI/Copy/ToolActivity.swift` — the tool name as a presentation key only: copy (verb, line label), glyph
//   category and typeface of the activity line; only tool name literals are allowed there;
// - ten plik — niesie wzorce i syntetyczne próbki, więc jest pominięty w całości.
import Foundation
import RarogContractFixtures
import Testing

@Suite("strażnik źródeł: native/Rarog nie decyduje po nazwach narzędzi, kanale ani tekstach CLI")
struct SourceGuardTests {
  /// Reguła: nazwa, wzorzec i zakres plików (ścieżka względem `native/Rarog/`).
  struct Rule: Sendable, CustomTestStringConvertible {
    let name: String
    let pattern: String
    let applies: @Sendable (String) -> Bool
    var testDescription: String { name }
  }

  static let contractPackage = "Packages/RarogContract/"
  static let contractSources = "Packages/RarogContract/Sources/RarogContract/"
  static let toolActivityCopy = "RarogUI/Copy/ToolActivity.swift"
  static let terminalPackage = "Packages/RarogTerminal/"
  static let selfFile = "Packages/RarogContract/Tests/RarogContractTests/SourceGuardTests.swift"

  static let rules: [Rule] = [
    Rule(
      name: "literał nazwy narzędzia CLI",
      pattern: #""(?:ExitPlanMode|AskUserQuestion|Bash|Agent|Workflow|Task)""#,
      applies: { !$0.hasSuffix(SourceGuardTests.toolActivityCopy) }
    ),
    Rule(name: "tekst opcji CLI", pattern: #"(?i)type something|chat about"#, applies: { _ in true }),
    Rule(
      // Notkę harnessu klasyfikuje serwer (`TranscriptMessage.notice`) — apka nie parsuje tagów.
      name: "literał tagu harnessu CLI",
      pattern: #"(?i)task-notification|system-reminder|<(?:summary|status|task-id|tool-use-id)>"#,
      applies: { _ in true }
    ),
    Rule(
      name: "kanał odpowiedzi (`.channel`) poza RarogContract",
      pattern: #"\.channel\b"#,
      applies: { !$0.hasPrefix(SourceGuardTests.contractPackage) }
    ),
    Rule(
      name: "porównanie z kanałem (`== .keys`, `== .hook`)",
      pattern: #"[!=]=\s*\.(?:keys|hook)\b|\.(?:keys|hook)\s*[!=]="#,
      applies: { _ in true }
    ),
    Rule(
      name: "`case .keys`/`.hook` poza RarogContract",
      pattern: #"\bcase\b[^\n:]*\.(?:keys|hook)\b"#,
      applies: { !$0.hasPrefix(SourceGuardTests.contractPackage) }
    ),
    Rule(
      name: "wartość kanału jako literał poza RarogContract",
      pattern: #""(?:hook|keys)""#,
      applies: { !$0.hasPrefix(SourceGuardTests.contractPackage) }
    ),
    Rule(
      // Synteza i `decodeIfPresent` zamieniają `null` w brak pola; kontrakt `null` odrzuca.
      name: "`decodeIfPresent` w dekoderze kontraktu (null ≠ brak pola)",
      pattern: #"\bdecodeIfPresent\b"#,
      applies: { $0.hasPrefix(SourceGuardTests.contractSources) }
    ),
    Rule(
      // Treść terminala (bajty PTY, wejście, wklejka, historia) nie trafia do logów, na dysk,
      // do pamięci podręcznej ani do `client.log`. Pliki źródłowe z „Terminal" w nazwie, wszystko w katalogach
      // `Terminal/` (np. `RarogUI/Terminal`) i cały pakiet `RarogTerminal` (renderer SwiftTerm) nie mają czym
      // tego zrobić — nowy plik terminala wchodzi pod regułę sam.
      name: "log, zapis albo raport w pliku terminala",
      pattern: #"\b(?:print|debugPrint|dump|NSLog|os_log|Logger|UserDefaults|FileManager|FileHandle|clientLog|reportUnhandled|reporter|URLCache|write\(to)\b"#,
      applies: { path in
        guard !path.contains("Tests/") else { return false }
        return (path as NSString).lastPathComponent.contains("Terminal") || path.contains("/Terminal/")
          || path.hasPrefix(SourceGuardTests.terminalPackage)
      }
    ),
    Rule(
      name: "ogłoszenie VoiceOver poza wspólnym kanałem",
      pattern: #"\.announcement\b"#,
      applies: {
        $0.hasPrefix("Packages/RarogUI/Sources/") && !$0.hasSuffix("/Model/Announcer.swift")
      }
    ),
  ]

  /// Wszystkie pliki `.swift` pod `native/Rarog/` (bez artefaktów buildu), ścieżki względne.
  static func sources() throws -> [(path: String, text: String)] {
    let root = try GoldenFrames.repoRoot().appending(path: "native/Rarog", directoryHint: .isDirectory)
    let rootPath = root.standardizedFileURL.path + "/"
    guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
      return []
    }
    var out: [(String, String)] = []
    for case let url as URL in walker {
      // `build/` = DerivedData z `scripts/ios-build.sh` (pliki generowane przez Xcode, nie źródła apki).
      if [".build", "build", "DerivedData"].contains(url.lastPathComponent) || url.lastPathComponent.hasSuffix(".xcodeproj") {
        walker.skipDescendants()
        continue
      }
      guard url.pathExtension == "swift" else { continue }
      let path = url.standardizedFileURL.path.replacing(rootPath, with: "")
      out.append((path, try String(contentsOf: url, encoding: .utf8)))
    }
    return out.sorted { $0.0 < $1.0 }
  }

  static func offenders(of rule: Rule, in files: [(path: String, text: String)]) throws -> [String] {
    // Proste granice słów (`\b` jak w JS), nie Unicode UAX#29: tam `c.decodeIfPresent`
    // i `x.channel.isEmpty` to JEDNO słowo i `\b` w środku nie istnieje.
    let regex = try Regex(rule.pattern).wordBoundaryKind(.simple)
    var out: [String] = []
    for file in files where file.path != selfFile && rule.applies(file.path) {
      for (index, line) in SwiftSource.stripComments(file.text).split(
        separator: "\n", omittingEmptySubsequences: false
      ).enumerated() where line.contains(regex) {
        out.append("native/Rarog/\(file.path):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
      }
    }
    return out
  }

  @Test("skan obejmuje pakiety native/Rarog, a zdjęcie komentarzy nie zjada kodu")
  func scanCoversPackages() throws {
    let files = try Self.sources()
    let paths = Set(files.map(\.path))
    #expect(paths.contains("Packages/RarogContract/Sources/RarogContract/ServerEvent.swift"))
    #expect(paths.contains("Packages/RarogTransport/Sources/RarogTransport/SSEParser.swift"))
    let event = try #require(files.first { $0.path.hasSuffix("RarogContract/ServerEvent.swift") })
    #expect(SwiftSource.stripComments(event.text).contains("public enum ServerEvent"))
  }

  @Test("brak", arguments: rules)
  func rule(_ rule: Rule) throws {
    #expect(try Self.offenders(of: rule, in: Self.sources()) == [])
  }

  @Test("reguły łapią próbki, komentarze ich nie wyzwalają, wyjątek copy działa")
  func rulesCatchSamples() throws {
    let samples: [(path: String, text: String)] = [
      ("RarogUI/Cards/Bad.swift", #"if block.toolName == "ExitPlanMode" { plan() }"#),
      ("RarogUI/Cards/Bad2.swift", #"if request.channel == .keys { digits() }"#),
      ("RarogUI/Cards/Bad2b.swift", #"let k = card.channel.map(String.init)"#),
      ("RarogCore/Bad3.swift", "switch c {\ncase .hook: a()\n}"),
      ("RarogUI/Bad4.swift", #"let x = "Chat about this""#),
      ("RarogUI/Bad5.swift", #"let raw = "keys""#),
      ("RarogUI/Rows/Bad7.swift", #"if text.hasPrefix("<task-notification>") { notice() }"#),
      ("RarogCore/Bad8.swift", #"let status = tag(text, "<status>")"#),
      ("Packages/RarogContract/Sources/RarogContract/Bad6.swift", "let v = try c.decodeIfPresent(String.self, forKey: .a)"),
      ("RarogUI/Ok.swift", "// \"Bash\" w komentarzu wolno\n/* .channel == .hook */ let url = \"https://x\" // \"Task\""),
      ("RarogUI/Copy/ToolActivity.swift", #"let copy = ["Bash": "uruchamia polecenie"]"#),
      ("Packages/RarogUI/Sources/RarogUI/Views/BadAnnouncement.swift",
        "UIAccessibility.post(notification: .announcement, argument: text)"),
      ("Packages/RarogUI/Sources/RarogUI/Model/Announcer.swift",
        "UIAccessibility.post(notification: .announcement, argument: text)"),
      ("Packages/RarogCore/Sources/RarogCore/TerminalBad.swift", "print(String(decoding: bytes, as: UTF8.self))"),
      ("Packages/RarogUI/Sources/RarogUI/Terminal/TerminalHistoryBad.swift", "UserDefaults.standard.set(text, forKey: \"h\")"),
      ("Packages/RarogCore/Sources/RarogCore/Selectors.swift", "print(state)"),
      ("Packages/RarogUI/Sources/RarogUI/Terminal/ResizeBad.swift", "os_log(\"%@\", text)"),
      ("Packages/RarogTerminal/Sources/RarogTerminal/SwiftTermBad.swift", "let log = Logger()"),
      ("Packages/RarogTerminal/Tests/RarogTerminalTests/SurfaceOkTests.swift", "print(frames)"),
      ("Packages/RarogCore/Tests/RarogCoreTests/TerminalOkTests.swift", "let file = FileManager.default"),
    ]
    var hits: [String: [String]] = [:]
    for rule in Self.rules {
      for line in try Self.offenders(of: rule, in: samples) {
        hits[rule.name, default: []].append(String(line.split(separator: ":")[0]))
      }
    }
    #expect(hits["literał nazwy narzędzia CLI"] == ["native/Rarog/RarogUI/Cards/Bad.swift"])
    #expect(hits["kanał odpowiedzi (`.channel`) poza RarogContract"]
      == ["native/Rarog/RarogUI/Cards/Bad2.swift", "native/Rarog/RarogUI/Cards/Bad2b.swift"])
    #expect(hits["porównanie z kanałem (`== .keys`, `== .hook`)"] == ["native/Rarog/RarogUI/Cards/Bad2.swift"])
    #expect(hits["`case .keys`/`.hook` poza RarogContract"] == ["native/Rarog/RarogCore/Bad3.swift"])
    #expect(hits["tekst opcji CLI"] == ["native/Rarog/RarogUI/Bad4.swift"])
    #expect(hits["wartość kanału jako literał poza RarogContract"] == ["native/Rarog/RarogUI/Bad5.swift"])
    #expect(hits["literał tagu harnessu CLI"]
      == ["native/Rarog/RarogUI/Rows/Bad7.swift", "native/Rarog/RarogCore/Bad8.swift"])
    #expect(hits["`decodeIfPresent` w dekoderze kontraktu (null ≠ brak pola)"]
      == ["native/Rarog/Packages/RarogContract/Sources/RarogContract/Bad6.swift"])
    #expect(hits["ogłoszenie VoiceOver poza wspólnym kanałem"]
      == ["native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/BadAnnouncement.swift"])
    #expect(hits["log, zapis albo raport w pliku terminala"] == [
      "native/Rarog/Packages/RarogCore/Sources/RarogCore/TerminalBad.swift",
      "native/Rarog/Packages/RarogUI/Sources/RarogUI/Terminal/TerminalHistoryBad.swift",
      "native/Rarog/Packages/RarogUI/Sources/RarogUI/Terminal/ResizeBad.swift",
      "native/Rarog/Packages/RarogTerminal/Sources/RarogTerminal/SwiftTermBad.swift",
    ])
  }

  @Test("zdejmowanie komentarzy: zagnieżdżone bloki, łańcuchy z `//`, interpolacja, surowe łańcuchy")
  func commentStripping() {
    let source = #"""
      let a = "x // nie komentarz" // komentarz
      /* zewn /* wewn */ dalej komentarz */ let b = 1
      let c = "\(f("y")) // też łańcuch"
      let d = #"surowy " // wciąż łańcuch"#
      """#
    let stripped = SwiftSource.stripComments(source)
    #expect(stripped.contains(#""x // nie komentarz""#))
    #expect(!stripped.contains("// komentarz"))
    #expect(!stripped.contains("wewn"))
    #expect(stripped.contains("let b = 1"))
    #expect(stripped.contains("// też łańcuch"))
    #expect(stripped.contains("// wciąż łańcuch"))
    #expect(stripped.split(separator: "\n", omittingEmptySubsequences: false).count == 4)
  }
}

/// Zdejmowanie komentarzy Swift z zachowaniem łańcuchów i numerów linii.
///
/// Maszyna stanów, nie wyrażenie regularne: Swift ma zagnieżdżone komentarze blokowe, łańcuchy
/// surowe (`#"…"#`), wieloliniowe (`"""`) i interpolację `\( … )` z łańcuchami w środku.
enum SwiftSource {
  private enum Mode {
    case code(parens: Int)
    case string(hashes: Int, multiline: Bool)
  }

  static func stripComments(_ text: String) -> String {
    let s = Array(text.unicodeScalars)
    var out = String.UnicodeScalarView()
    var stack: [Mode] = [.code(parens: 0)]
    var i = 0

    func at(_ offset: Int, _ literal: String) -> Bool {
      let chars = Array(literal.unicodeScalars)
      guard offset + chars.count <= s.count else { return false }
      return Array(s[offset..<offset + chars.count]) == chars
    }

    while i < s.count {
      switch stack.last ?? .code(parens: 0) {
      case let .code(parens):
        if at(i, "//") {
          while i < s.count, s[i] != "\n" { i += 1 }
        } else if at(i, "/*") {
          var depth = 0
          repeat {
            if at(i, "/*") {
              depth += 1
              i += 2
            } else if at(i, "*/") {
              depth -= 1
              i += 2
            } else {
              if s[i] == "\n" { out.append("\n") }
              i += 1
            }
          } while depth > 0 && i < s.count
        } else if s[i] == "#" || s[i] == "\"" {
          var hashes = 0
          while i + hashes < s.count, s[i + hashes] == "#" { hashes += 1 }
          let quote = i + hashes
          guard quote < s.count, s[quote] == "\"" else {
            out.append(s[i])
            i += 1
            continue
          }
          let multiline = at(quote, "\"\"\"")
          let end = quote + (multiline ? 3 : 1)
          out.append(contentsOf: s[i..<end])
          i = end
          stack.append(.string(hashes: hashes, multiline: multiline))
        } else {
          if s[i] == "(" {
            stack[stack.count - 1] = .code(parens: parens + 1)
          } else if s[i] == ")" {
            if parens == 0, stack.count > 1 {
              // Koniec interpolacji `\( … )` — wracamy do łańcucha.
              stack.removeLast()
            } else if parens > 0 {
              stack[stack.count - 1] = .code(parens: parens - 1)
            }
          }
          out.append(s[i])
          i += 1
        }
      case let .string(hashes, multiline):
        let terminator = (multiline ? "\"\"\"" : "\"") + String(repeating: "#", count: hashes)
        let escape = "\\" + String(repeating: "#", count: hashes)
        if at(i, terminator) {
          out.append(contentsOf: terminator.unicodeScalars)
          i += terminator.unicodeScalars.count
          stack.removeLast()
        } else if at(i, escape + "(") {
          out.append(contentsOf: (escape + "(").unicodeScalars)
          i += escape.unicodeScalars.count + 1
          stack.append(.code(parens: 0))
        } else if at(i, escape), i + escape.unicodeScalars.count < s.count {
          let next = i + escape.unicodeScalars.count
          out.append(contentsOf: s[i...next])
          i = next + 1
        } else {
          out.append(s[i])
          i += 1
        }
      }
    }
    return String(out)
  }
}
