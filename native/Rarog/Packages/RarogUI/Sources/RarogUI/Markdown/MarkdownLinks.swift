import Foundation

// Adresy w odpowiedzi agenta. Reguły:
// - link z etykietą: tylko `http`, `https`, `mailto`; `javascript:`, `data:` i `//host` zostają
//   tekstem (CR-05: taki tap „zjadał" apkę); znaki sterujące i spacje w adresie nie ratują
//   schematu (`java\tscript:`);
// - goły adres: tylko `http(s)://` z niepustym hostem; kończąca interpunkcja, gwiazdki i
//   podkreślenia emfazy oraz niesparowany nawias należą do zdania.
// Odstępstwo od PWA: adres WZGLĘDNY nie ma w apce bazy (PWA rozwiązywała go względem własnej
// strony, czyli w pustkę), więc zostaje sama etykieta, bez linku.
// Te same reguły gołego adresu stosuje terminal (`TerminalLinks` w RarogTerminal).
// Właściciel: transkrypt, markdown.
public enum MarkdownLinks {
  public enum Target: Sendable, Equatable {
    case url(URL)
    /// Adres względny: etykieta zostaje tekstem, bez linku.
    case relative
    /// Schemat spoza listy albo `//host`: cały zapis zostaje tekstem.
    case rejected
  }

  /// Cel linku z etykietą `[x](adres)`.
  public static func target(_ raw: String) -> Target {
    let cleaned = String(raw.unicodeScalars.filter { $0.value > 0x20 })
    guard !cleaned.isEmpty, !cleaned.hasPrefix("//") else { return .rejected }
    if cleaned.wholeMatch(of: /[A-Za-z][A-Za-z0-9+.\-]*:.*/) != nil {
      let lower = cleaned.lowercased()
      guard lower.hasPrefix("http:") || lower.hasPrefix("https:") || lower.hasPrefix("mailto:"),
        let url = URL(string: cleaned)
      else { return .rejected }
      return .url(url)
    }
    return .relative
  }

  /// Znaki gołego adresu: RFC 3986 (bez `"`, `'`, `<`, `>`, które kończą adres w tekście).
  private static let urlCharacters = CharacterSet(
    charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&()*+,;=%")
  /// Znaki, które na końcu adresu należą do zdania albo do składni markdownu, nie do adresu.
  private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "*", "_", "~"]

  /// Znak, który może stać w gołym adresie. Terminal skleja nim adres zawinięty na kilka wierszy.
  public static func isURLCharacter(_ char: Character) -> Bool {
    guard char.unicodeScalars.count == 1, let scalar = char.unicodeScalars.first else { return false }
    return urlCharacters.contains(scalar)
  }

  /// Koniec gołego adresu `http(s)://…` zaczynającego się na `start`; `nil` = to nie adres.
  public static func bareURLEnd(_ chars: [Character], at start: Int) -> Int? {
    let scheme: Int
    if hasPrefix(chars, at: start, "https://") {
      scheme = 8
    } else if hasPrefix(chars, at: start, "http://") {
      scheme = 7
    } else {
      return nil
    }
    var end = start + scheme
    while end < chars.count, isURLCharacter(chars[end]) {
      end += 1
    }
    end = trimTail(chars, from: start, to: end)
    // Sam schemat bez hosta („https://" na końcu zdania) linkiem nie jest.
    return end > start + scheme ? end : nil
  }

  private static func hasPrefix(_ chars: [Character], at start: Int, _ prefix: String) -> Bool {
    var index = start
    for char in prefix {
      guard index < chars.count, chars[index] == char else { return false }
      index += 1
    }
    return true
  }

  /// Ucina ogon: interpunkcję zdania i nawias domykający bez pary w samym adresie (linki do wiki
  /// potrafią mieć nawias w środku — wtedy zamykający należy do adresu). Bilans nawiasów liczony
  /// raz i poprawiany przy każdym uciętym znaku: ogon z 50 000 `)` to praca liniowa, nie
  /// ponowne liczenie całego adresu za każdym znakiem.
  private static func trimTail(_ chars: [Character], from start: Int, to end: Int) -> Int {
    var end = end
    var parens = 0
    var brackets = 0
    for char in chars[start..<end] {
      switch char {
      case "(": parens += 1
      case ")": parens -= 1
      case "[": brackets += 1
      case "]": brackets -= 1
      default: break
      }
    }
    while end > start {
      let last = chars[end - 1]
      if trailing.contains(last) {
        end -= 1
      } else if last == ")", parens < 0 {
        parens += 1
        end -= 1
      } else if last == "]", brackets < 0 {
        brackets += 1
        end -= 1
      } else {
        break
      }
    }
    return end
  }
}
