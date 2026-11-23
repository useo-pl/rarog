import Foundation

// Kafel „zawsze” na karcie zgody w dwóch wierszach. Właściciel: karty.

/// Dosłowna etykieta opcji eskalującej („Yes, and don't ask again for pnpm commands in /Users/u/Projects/atlas")
/// rozcięta na POCZĄTEK (pogrubiony wiersz kafla) i ZAKRES reguły (drobny wiersz pod nim). Cięcie zna wyłącznie
/// cztery początki z ekranów CLI; każda inna etykieta, także przełącznik trybu, zostaje w całości (fail-safe) —
/// kafel nazywa zmianę dosłownie, a zakres nigdy nie znika. Ścieżki w zakresie skraca się: katalog domowy do `~`,
/// katalog tymczasowy macOS do `$TMPDIR` (cały segment, bez ucinania dalszych: to nie jest podsumowanie, tylko
/// reguła). Ścieżki zakresu widok pisze pismem stałej szerokości (``scopeRuns(_:)``).
public enum AlwaysLabelParts {
  public struct Parts: Equatable, Sendable {
    /// „Yes, and don't ask again" — dosłownie, z apostrofem z ekranu.
    public let head: String
    /// „for pnpm commands in ~/Projects/atlas" — zakres reguły, ścieżki skrócone.
    public let scope: String
  }

  /// Odcinek zakresu: zwykły tekst albo ścieżka.
  public struct Run: Equatable, Sendable {
    public let text: String
    public let isPath: Bool
  }

  /// `nil` = etykieta poza znanymi początkami albo bez zakresu: kafel pokazuje ją w całości.
  public static func split(_ label: String) -> Parts? {
    let line = label.trimmingCharacters(in: .whitespacesAndNewlines)
    // Etykieta z łamaniem wiersza to nie jest pojedyncza opcja z ekranu — nie zgadujemy.
    guard !line.contains("\n") else { return nil }
    // Cztery początki z ekranów CLI (apostrof prosty albo typograficzny, jak w „don’t ask again for: cd *").
    // Wzorce się nie nakładają („Yes, and allow” ≠ „Yes, allow reading”). Czwarty
    // („Yes, allow reading from <katalog> from this project” albo „… during this session”) tnie się tylko
    // przed „from”, jak sygnatura `readGrantComplete` serwera — inne „Yes, allow reading …” zostają w całości.
    let heads: [Regex<(Substring, Substring, Substring)>] = [
      /^(Yes, and don['’]t ask again)\s+(\S.*)$/,
      /^(Yes, and always allow)\s+(\S.*)$/,
      /^(Yes, and allow)\s+(\S.*)$/,
      /^(Yes, allow reading)\s+(from\s+\S.*)$/,
    ]
    for pattern in heads {
      guard let match = line.wholeMatch(of: pattern) else { continue }
      let scope = String(match.output.2).trimmingCharacters(in: .whitespaces)
      guard !scope.isEmpty else { return nil }
      return Parts(head: String(match.output.1), scope: tmpShortened(homeShortened(scope)))
    }
    return nil
  }

  /// `/Users/<ktoś>` i `/home/<ktoś>` → `~` w dowolnym miejscu tekstu, tylko na początku ścieżki (przed nim
  /// początek, spacja, cudzysłów albo nawias), jak `PathText.shortPath` dla całego katalogu.
  static func homeShortened(_ text: String) -> String {
    text.replacing(/(^|[\s"'(\[])\/(?:Users|home)\/[^\/\s"')\]]+/) { match in
      String(match.output.1) + "~"
    }
  }

  /// Katalog tymczasowy macOS `/private/var/folders/<a>/<b>/T` (i bez `/private`) → `$TMPDIR`, z tymi samymi
  /// granicami początku co ``homeShortened(_:)``. Tylko katalog `T` (sąsiednie `C` i `0` to cache i dane systemu,
  /// nie `$TMPDIR`) i tylko cały segment: za `T` koniec ścieżki albo `/`.
  static func tmpShortened(_ text: String) -> String {
    text.replacing(
      /(^|[\s"'(\[])(?:\/private)?\/var\/folders\/[^\/\s"')\]]+\/[^\/\s"')\]]+\/T(?=$|[\/\s"')\]])/
    ) { match in
      String(match.output.1) + "$TMPDIR"
    }
  }

  /// Zakres pocięty na odcinki tekstu i ścieżek (widok pisze ścieżki pismem stałej szerokości). Ścieżka zaczyna się
  /// od `/`, `~` albo `$TMPDIR` (po `~` i `$TMPDIR` tylko `/` albo jej koniec) na początku zakresu albo po spacji,
  /// cudzysłowie lub nawiasie, i biegnie do spacji, cudzysłowu albo nawiasu zamykającego. Złączone odcinki dają
  /// zakres znak w znak; czego reguła nie rozpozna, zostaje zwykłym tekstem (to tylko styl).
  public static func scopeRuns(_ scope: String) -> [Run] {
    let path = /(^|[\s"'(\[])((?:\/|~(?=$|[\/\s"')\]])|\$TMPDIR(?=$|[\/\s"')\]]))[^\s"')\]]*)/
    var runs: [Run] = []
    var cursor = scope.startIndex
    for match in scope.matches(of: path) {
      let found = match.output.2
      if cursor < found.startIndex { runs.append(Run(text: String(scope[cursor..<found.startIndex]), isPath: false)) }
      runs.append(Run(text: String(found), isPath: true))
      cursor = found.endIndex
    }
    if cursor < scope.endIndex { runs.append(Run(text: String(scope[cursor...]), isPath: false)) }
    return runs
  }
}
