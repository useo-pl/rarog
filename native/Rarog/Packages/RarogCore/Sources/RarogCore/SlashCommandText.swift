import Foundation

/// Tekst wiadomości, który serwer czyta jak komendę Claude Code: po wiodących białych znakach zaczyna się od
/// `/`. Białe znaki są te same co w `trimStart` i `\s` serwera (ECMAScript WhiteSpace i LineTerminator: z BOM U+FEFF,
/// bez U+0085), nie Unicode `White_Space` z `Character.isWhitespace` — inaczej wklejony tekst z BOM byłby dla serwera
/// komendą, a dla apki zwykłą wiadomością. Jedna definicja dla cech klawiatury pola
/// (`ComposerTextTraits` w RarogUI), podpowiedzi po „/” (`CommandSuggestions`) i odświeżenia listy komend po odmowie
/// wysyłki (`RarogStore+Commands`).
public enum SlashCommandText {
  /// Pierwszy znak po wiodących białych znakach to `/`.
  public static func isCommand(_ text: String) -> Bool {
    text.unicodeScalars.first(where: { !isServerWhitespace($0) }) == "/"
  }

  /// Biały znak serwera: `trimStart` zdejmuje go z początku, a nazwa komendy kończy się na pierwszym takim znaku.
  public static func isServerWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "\t", "\u{0B}", "\u{0C}", "\u{FEFF}", "\n", "\r", "\u{2028}", "\u{2029}": return true
    default: return scalar.properties.generalCategory == .spaceSeparator
    }
  }
}
