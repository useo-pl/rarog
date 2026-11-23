import Foundation
import RarogUI

/// Adres pod komórką ekranu terminala. Stuknięcie w adres otwiera go w przeglądarce, przytrzymanie
/// daje „Otwórz link” i „Kopiuj link”.
///
/// Adres zawinięty na kilka wierszy trzeba skleić na ekranie, bo nikt po drodze tego nie robi (pomiar na
/// herdr 0.9.5, Claude Code 2.1.319): Claude Code łamie adres sam (nowy wiersz i wcięcie), a herdr rysuje wiersz
/// zawinięty przez terminal pozycjonowaniem kursora, więc SwiftTerm nie widzi zawinięcia. Linków OSC 8 Claude Code pod
/// herdr nie wysyła; inne programy mogą, a herdr je przepuszcza (``web(_:)``).
///
/// Reguła sklejania: adres, którego ostatni znak stoi przy prawej krawędzi (za nim najwyżej ``edgeGap`` pustych
/// kolumn), ciągnie się w następnym wierszu, jeśli ten po wcięciu najwyżej ``maxIndent`` spacji zaczyna się znakiem
/// adresu. Znane ograniczenie: zwykłe słowo na początku następnego wiersza doklei się do adresu, który przypadkiem
/// kończy się przy krawędzi. Znaki adresu, ucinanie interpunkcji i niesparowanego nawiasu: ``MarkdownLinks``.
enum TerminalLinks {
  /// Najwięcej pustych kolumn za adresem, który ciągnie się dalej. Claude Code zostawiał 1–2.
  static let edgeGap = 2
  /// Najgłębsze wcięcie dalszego ciągu adresu (Claude Code: 2 spacje, herdr: 0).
  static let maxIndent = 8

  /// Komórka ekranu (od 0).
  struct Cell: Hashable {
    let row: Int
    let col: Int
  }

  /// Adres http(s) obejmujący komórkę `cell`; `rows` to wiersze ekranu po komórkach (pusta komórka = spacja).
  ///
  /// Koszt liniowy względem ekranu: schemat sprawdza się na najwyżej 8 znakach, a po ciągu zaczętym schematem
  /// szukanie idzie dalej ZA tym ciągiem. Adres zaczęty wewnątrz ciągu kończy się tam, gdzie ciąg, więc gdy ciąg
  /// komórki nie obejmuje, nie obejmuje jej też żaden adres w jego środku. Bez tego ekran pełen „h” bez spacji
  /// sklejałby resztę ekranu przy każdym znaku.
  static func url(in rows: [[Character]], at cell: Cell) -> URL? {
    link(in: rows, at: cell)?.url
  }

  /// Adres pod komórką z komórkami, które zajmuje na ekranie (podkreślenie po najechaniu wskaźnikiem).
  static func link(in rows: [[Character]], at cell: Cell) -> (url: URL, cells: [Cell])? {
    guard rows.indices.contains(cell.row) else { return nil }
    // Adres zaczyna się w wierszu stuknięcia albo wyżej.
    var row = 0
    var col = 0
    while row <= cell.row {
      guard col < rows[row].count else {
        row += 1
        col = 0
        continue
      }
      guard rows[row][col] == "h", hasScheme(run(in: rows, row: row, col: col, limit: 8).chars) else {
        col += 1
        continue
      }
      let whole = run(in: rows, row: row, col: col, limit: nil)
      if let stop = MarkdownLinks.bareURLEnd(whole.chars, at: 0), whole.cells[0..<stop].contains(cell) {
        guard let url = web(String(whole.chars[0..<stop])) else { return nil }
        return (url, Array(whole.cells[0..<stop]))
      }
      guard let last = whole.cells.last else { return nil }
      row = last.row
      col = last.col + 1
    }
    return nil
  }

  /// Cel linku OSC 8: tylko `http` i `https` z hostem.
  static func web(_ raw: String) -> URL? {
    guard case .url(let url) = MarkdownLinks.target(raw),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      url.host(percentEncoded: false)?.isEmpty == false
    else { return nil }
    return url
  }

  private static func hasScheme(_ chars: [Character]) -> Bool {
    chars.starts(with: "https://") || chars.starts(with: "http://")
  }

  /// Ciąg znaków adresu od komórki `row`, `col`, sklejony z dalszych wierszy; `limit` ucina go po tylu znakach.
  /// Pierwsza komórka (`h`) jest znakiem adresu, więc ciąg nigdy nie jest pusty.
  private static func run(
    in rows: [[Character]], row: Int, col: Int, limit: Int?
  ) -> (chars: [Character], cells: [Cell]) {
    var chars: [Character] = []
    var cells: [Cell] = []
    var current = row
    var start = col
    while true {
      let line = rows[current]
      var end = start
      while end < line.count, MarkdownLinks.isURLCharacter(line[end]) {
        chars.append(line[end])
        cells.append(Cell(row: current, col: end))
        end += 1
        if let limit, chars.count >= limit { return (chars, cells) }
      }
      guard end > start, reachesEdge(line, from: end), current + 1 < rows.count,
        let next = continuation(rows[current + 1])
      else { break }
      current += 1
      start = next
    }
    return (chars, cells)
  }

  /// Za kolumną `end` są same spacje i jest ich najwyżej ``edgeGap``.
  private static func reachesEdge(_ line: [Character], from end: Int) -> Bool {
    line.count - end <= edgeGap && line[end...].allSatisfy { $0 == " " }
  }

  /// Kolumna początku dalszego ciągu adresu albo `nil`.
  private static func continuation(_ line: [Character]) -> Int? {
    guard let first = line.firstIndex(where: { $0 != " " }), first <= maxIndent,
      MarkdownLinks.isURLCharacter(line[first])
    else { return nil }
    return first
  }
}
