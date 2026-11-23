import Foundation

// Mask of secret shapes in the text the app sends to OpenAI: the session projection, new turns during the
// conversation and the answer of the `ask_session` tool. Owner: voice agent (session companion plan).
//
// Sito na typowe kształty, nie gwarancja: sekret w innym kształcie przechodzi bez zmian. Reguły, ich kolejność
// i syntetyczny przykład każdej stoją we wspólnej tabeli `shared/fixtures/companion/secret-shapes.json`; ta sama
// tabela steruje maską serwera (`server/src/companion/mask.ts`). Test `RealtimeSecretMaskTests` sprawdza, że reguły
// tutaj to dokładnie reguły tabeli i że każdy wiersz `cases` wychodzi jak w tabeli.

enum RealtimeSecretMask {
  /// Czym staje się zamaskowany sekret.
  static let mask = "[secret]"

  struct Rule: Sendable {
    let name: String
    let pattern: String
    let caseInsensitive: Bool
    /// Szablon `NSRegularExpression`: `$1` zostawia słowo schematu (`Bearer`).
    let replacement: String
  }

  /// Reguły w kolejności stosowania: najpierw poświadczenia po słowie schematu, więc `Bearer sk-…` zachowuje słowo.
  static let rules: [Rule] = [
    Rule(
      name: "rarog-device", pattern: #"(Rarog-Device)\s+[^\s"',;]+"#, caseInsensitive: true,
      replacement: "$1 [secret]"),
    Rule(
      name: "bearer", pattern: #"\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}"#, caseInsensitive: true,
      replacement: "$1 [secret]"),
    Rule(name: "sk-key", pattern: #"\bsk-[A-Za-z0-9_-]{20,}"#, caseInsensitive: false, replacement: "[secret]"),
    Rule(
      name: "github-token", pattern: #"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"#,
      caseInsensitive: false, replacement: "[secret]"),
    Rule(
      name: "aws-access-key-id", pattern: #"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#, caseInsensitive: false,
      replacement: "[secret]"),
    Rule(name: "slack-token", pattern: #"\bxox[abposr]-[A-Za-z0-9-]{10,}"#, caseInsensitive: false, replacement: "[secret]"),
  ]

  /// Skompilowane raz; wzorce są stałe, więc błąd kompilacji to błąd programisty (test go łapie).
  private static let compiled: [(NSRegularExpression, String)] = rules.compactMap { rule in
    let options: NSRegularExpression.Options = rule.caseInsensitive ? [.caseInsensitive] : []
    guard let regex = try? NSRegularExpression(pattern: rule.pattern, options: options) else { return nil }
    return (regex, rule.replacement)
  }

  /// Ile reguł się skompilowało (test: wszystkie).
  static var compiledCount: Int { compiled.count }

  /// Tekst z każdym trafieniem reguł zastąpionym; drugie przejście niczego nie zmienia.
  static func apply(_ text: String) -> String {
    var out = text
    for (regex, replacement) in compiled {
      let range = NSRange(out.startIndex..., in: out)
      out = regex.stringByReplacingMatches(in: out, options: [], range: range, withTemplate: replacement)
    }
    return out
  }
}
