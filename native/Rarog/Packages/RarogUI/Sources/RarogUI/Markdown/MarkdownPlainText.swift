import Foundation

// Tekst wiadomości poza ekranem: do schowka (zaznaczenie) i dla czytnika ekranu.
// Wyrenderowany tekst niesie znaki, które są tylko układem — tabulator za znacznikiem listy,
// znak obiektu tabeli, spacja pustej linii kodu, pasek bloku z nazwą języka. Renderer znaczy je
// ``MarkdownReplacement`` i tu zamieniają się na to, co człowiek chce wkleić: `- ` i `3. `
// zamiast tabulatora, tabelę jako markdown, linię poziomą jako `---`, pasek bloku jako nic. Zaznaczenie WEWNĄTRZ
// tabeli (jej własne pole tekstu) idzie do schowka komórkami: tabulator między komórkami, nowa linia między wierszami.
// Właściciel: transkrypt, markdown.

extension NSAttributedString.Key {
  /// Zastępstwo zakresu przy kopiowaniu i czytaniu (``MarkdownReplacement``).
  public static let rarogReplacement = NSAttributedString.Key("pl.useo.rarog.replacement")
}

/// Wartość atrybutu zastępstwa. Klasa z tożsamością zamiast napisu: dwa sąsiednie zakresy
/// z tym samym tekstem (dwie puste linie kodu) zostają dwoma zakresami, a nie sklejają się w jeden.
public final class MarkdownReplacement: NSObject, Sendable {
  public let copy: String
  /// Wersja dla czytnika ekranu; `nil` = taka sama jak do schowka.
  public let spoken: String?

  public init(copy: String, spoken: String? = nil) {
    self.copy = copy
    self.spoken = spoken
  }
}

public enum MarkdownPlainText {
  /// Tekst do schowka z zaznaczenia (albo całości).
  public static func copy(_ text: NSAttributedString) -> String {
    tableCopy(text) ?? flatten(text, spoken: false)
  }

  /// Zaznaczenie w tekście tabeli (``MarkdownTableText``): komórki rozdzielone tabulatorem, wiersze nową linią, kawałki
  /// jednej komórki z kolejnych linii sklejone tak, jak stały w źródle. Tabulatory i łamania układu do schowka nie idą
  /// same, ale wyznaczają, które komórki zaznaczenie objęło: pusta komórka i pusty wiersz w zaznaczeniu zostają puste
  /// na swoim miejscu — wklejka do arkusza trafia w kolumny. `nil` = to nie tekst tabeli.
  static func tableCopy(_ text: NSAttributedString) -> String? {
    let string = text.string as NSString
    var rows: [(row: Int, columns: ClosedRange<Int>, cells: [Int: String])] = []
    text.enumerateAttribute(.rarogTableCell, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      guard let mark = value as? MarkdownTableCell else { return }
      if let last = rows.last, last.row == mark.row {
        rows[rows.count - 1].columns = min(last.columns.lowerBound, mark.columns.lowerBound)...max(
          last.columns.upperBound, mark.columns.upperBound)
      } else {
        rows.append((mark.row, mark.columns, [:]))
      }
      guard mark.isText else { return }
      let part = string.substring(with: range)
      let index = rows.count - 1
      rows[index].cells[mark.column] = rows[index].cells[mark.column].map { $0 + mark.gap + part } ?? part
    }
    guard !rows.isEmpty else { return nil }
    return rows.map { row in row.columns.map { row.cells[$0] ?? "" }.joined(separator: "\t") }.joined(separator: "\n")
  }

  /// Tekst dla VoiceOver.
  public static func spoken(_ text: NSAttributedString) -> String {
    flatten(text, spoken: true)
  }

  private static func flatten(_ text: NSAttributedString, spoken: Bool) -> String {
    var out = ""
    let string = text.string as NSString
    text.enumerateAttribute(.rarogReplacement, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      if let replacement = value as? MarkdownReplacement {
        out += spoken ? (replacement.spoken ?? replacement.copy) : replacement.copy
        return
      }
      // Miękkie łamanie w akapicie (U+2028) to w schowku zwykła nowa linia; znak obiektu bez
      // zastępstwa nie ma tekstowej postaci.
      out += string.substring(with: range).replacingOccurrences(of: "\u{2028}", with: "\n")
        .replacingOccurrences(of: "\u{FFFC}", with: "")
    }
    return out
  }
}
