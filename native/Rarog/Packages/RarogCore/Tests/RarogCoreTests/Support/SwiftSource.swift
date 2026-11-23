// Zdejmowanie komentarzy ze źródeł Swift — narzędzie strażników źródeł tego pakietu
// (`BackgroundTaskRulesGuardTests`): strażnik pyta o KOD, a komentarzom wolno cytować wszystko.
//
// KOPIA `SwiftSource` z `RarogContract/Tests/RarogContractTests/SourceGuardTests.swift`.
// Cel testów innego pakietu nie daje się importować, a wspólne miejsce (biblioteka testowa
// `RarogContractFixtures`) leży w pakiecie kontraktu. Poprawka w jednej kopii należy się drugiej; zachowanie
// tej kopii pilnuje test „zdejmowanie komentarzy" w `BackgroundTaskRulesGuardTests`.

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
