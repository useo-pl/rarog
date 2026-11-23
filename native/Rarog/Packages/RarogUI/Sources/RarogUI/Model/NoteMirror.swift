import Foundation

// „Lustro" markdownu w polu notatki projektu: pole pokazuje składnię, nie ukrywa jej. Żaden znak nie znika
// i nic się nie przesuwa (to nie WYSIWYG): znaczniki `#`, `- `, `1. `, `**` i backticki stoją w wyciszonym
// atramencie, linia nagłówka i wnętrze `**…**` są półgrube, kod w linii pismem stałej szerokości na tle kodu, goły
// adres w atramencie linku, a linia listy ma wiszące wcięcie. Tu same zakresy ról w jednostkach UTF-16 (`NSRange`
// pola tekstowego), czyste i testowane na macOS; atrybuty kładzie pole (`NoteTextView.applyMirror`). Reguły
// czyta linia po linii — notatka to kilka akapitów, nie dokument z blokami. Właściciel: notatki (apka natywna).
enum NoteMirror {
  enum Role: Equatable {
    /// Znacznik składni: `#`, `- `, `1. `, `**`, backticki.
    case marker
    /// Cała linia nagłówka.
    case heading
    /// Wnętrze `**…**`.
    case bold
    /// Kod w linii razem z backtickami (krój i tło); same backticki są też znacznikami.
    case code
    /// Goły adres `http(s)://`.
    case link
    /// Cała linia pozycji listy; `prefix` = jednostki UTF-16 wcięcia i znacznika (szerokość wiszącego wcięcia).
    case listItem(prefix: Int)
  }

  struct Span: Equatable {
    let range: NSRange
    let role: Role
  }

  static func spans(_ text: String) -> [Span] {
    var out: [Span] = []
    let ns = text as NSString
    ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: .byLines) { line, range, _, _ in
      guard let line, !line.isEmpty else { return }
      out += lineSpans(Array(line), offset: range.location)
    }
    return out
  }

  /// Role jednej linii; `offset` = początek linii w polu (UTF-16).
  private static func lineSpans(_ chars: [Character], offset: Int) -> [Span] {
    // Początek każdego znaku w jednostkach UTF-16 od początku linii (plus koniec linii).
    var units = [0]
    for char in chars { units.append(units[units.count - 1] + char.utf16.count) }
    func range(_ from: Int, _ to: Int) -> NSRange { NSRange(location: offset + units[from], length: units[to] - units[from]) }

    var out: [Span] = []
    var indent = 0
    while indent < chars.count, chars[indent] == " " || chars[indent] == "\t" { indent += 1 }
    if let hashes = headingMarker(chars) {
      out.append(Span(range: range(0, chars.count), role: .heading))
      out.append(Span(range: range(0, hashes), role: .marker))
    } else if let marker = listMarker(chars, from: indent) {
      out.append(Span(range: range(0, chars.count), role: .listItem(prefix: units[marker])))
      out.append(Span(range: range(indent, marker), role: .marker))
    }

    // Kod w linii: pojedynczy backtick otwiera, następny pojedynczy zamyka; dłuższa seria (```) to sam znacznik.
    // Maska pozycji kodu, nie lista zakresów: pytanie „czy w kodzie" pada dla każdego znaku linii, a linia przy
    // suficie potrafi mieć tysiące fragmentów kodu (przegląd listy dawał koszt kwadratowy przy każdym znaku).
    var code = [Bool](repeating: false, count: chars.count)
    var index = 0
    var open: Int?
    while index < chars.count {
      guard chars[index] == "`" else {
        index += 1
        continue
      }
      var end = index
      while end < chars.count, chars[end] == "`" { end += 1 }
      if end - index > 1 {
        out.append(Span(range: range(index, end), role: .marker))
      } else if let start = open {
        if index > start + 1 {
          for position in start...index { code[position] = true }
          out.append(Span(range: range(start, index + 1), role: .code))
          out.append(Span(range: range(start, start + 1), role: .marker))
          out.append(Span(range: range(index, index + 1), role: .marker))
        }
        open = nil
      } else {
        open = index
      }
      index = end
    }
    func inCode(_ position: Int) -> Bool { code[position] }

    // `**…**` poza kodem: niepuste wnętrze, bez spacji tuż przy znacznikach.
    index = 0
    while index + 1 < chars.count {
      guard chars[index] == "*", chars[index + 1] == "*", !inCode(index),
        index + 2 < chars.count, !chars[index + 2].isWhitespace, chars[index + 2] != "*"
      else {
        index += 1
        continue
      }
      var close = index + 3
      while close + 1 < chars.count, !(chars[close] == "*" && chars[close + 1] == "*") { close += 1 }
      guard close + 1 < chars.count, !chars[close - 1].isWhitespace, !(index..<(close + 2)).contains(where: inCode)
      else {
        index += 2
        continue
      }
      out.append(Span(range: range(index, index + 2), role: .marker))
      out.append(Span(range: range(index + 2, close), role: .bold))
      out.append(Span(range: range(close, close + 2), role: .marker))
      index = close + 2
    }

    // Gołe adresy poza kodem — te same reguły końca adresu co w transkrypcie.
    index = 0
    while index < chars.count {
      let startsWord = index == 0 || chars[index - 1].isWhitespace || "(<[".contains(chars[index - 1])
      if chars[index] == "h", startsWord, !inCode(index), let end = MarkdownLinks.bareURLEnd(chars, at: index) {
        out.append(Span(range: range(index, end), role: .link))
        index = end
      } else {
        index += 1
      }
    }
    return out
  }

  /// `#`–`######` i spacja na początku linii → koniec znacznika (indeks znaku za spacją).
  private static func headingMarker(_ chars: [Character]) -> Int? {
    var hashes = 0
    while hashes < chars.count, chars[hashes] == "#" { hashes += 1 }
    guard (1...6).contains(hashes), hashes < chars.count, chars[hashes] == " " || chars[hashes] == "\t" else {
      return nil
    }
    return hashes + 1
  }

  /// `- `, `* `, `+ ` albo `1. `/`1) ` po wcięciu → koniec znacznika (indeks znaku za spacją).
  private static func listMarker(_ chars: [Character], from start: Int) -> Int? {
    guard start < chars.count else { return nil }
    var end = start
    if "-*+".contains(chars[start]) {
      end = start + 1
    } else {
      while end < chars.count, end - start < 9, chars[end].isASCII, chars[end].isNumber { end += 1 }
      guard end > start, end < chars.count, chars[end] == "." || chars[end] == ")" else { return nil }
      end += 1
    }
    guard end < chars.count, chars[end] == " " || chars[end] == "\t" else { return nil }
    return end + 1
  }
}
