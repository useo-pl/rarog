import Foundation
import RarogContract
import RarogCore

// Rozwinięcie gita i diff sesji: lista zmienionych plików, wiersz
// ostatniego commita, linie patcha z rodzajem i bilans policzony z patcha. Czyste funkcje,
// testowane na macOS.
// Właściciel: nagłówek.

public enum GitChangesModel {
  /// Wiersze listy w dymku gita: z ramki `git-status`, te same co w prawym panelu (`InspectorChanges`). Litera
  /// i bilans z `fileDetails`, bez pola same ścieżki. Dymek niczego nie pobiera — do tego dnia pobierał
  /// cały diff sesji tylko po litery i liczby.
  public static func rows(fresh: GitStatusEvent?) -> [InspectorFileRow] {
    fresh.map(InspectorChanges.rows) ?? []
  }

  /// „pokazano 50 z 73": ramka niesie najwyżej 50 plików, a jej licznik wszystkie (jak w panelu). `nil` = lista
  /// jest cała albo jeszcze nie przyszła.
  public static func shownNote(fresh: GitStatusEvent?, rows: Int) -> String? {
    guard rows > 0, let dirty = fresh?.dirtyCount, dirty > rows else { return nil }
    return UICopy.inspectorChangesShown(rows, of: dirty)
  }

  /// Zdanie zamiast pustej listy. Licznik przychodzi z rejestru i przeżywa restart, a LISTA
  /// nazw tylko ramką `git-status` — zanim dojedzie, mówimy prawdę o obu faktach zamiast „brak".
  public static func emptyNote(meta: GitMeta) -> String {
    let dirty = meta.dirtyCount ?? 0
    return dirty > 0 ? UICopy.dirtyRefreshing(dirty) : UICopy.noChangedFiles
  }

  /// Przycisk Diff gaśnie przy ZNANYM zerze zmian; nieznana liczba go nie gasi.
  public static func diffAvailable(meta: GitMeta) -> Bool { meta.dirtyCount != 0 }

  /// Kiedy wylądował commit: `3 paź 14:05` w bieżącym roku, `24 gru 2025` w innym. Czas
  /// BEZWZGLĘDNY — wiersz stoi w rozwinięciu bez tykania, a słowo względne by się zestarzało.
  public static func commitWhen(_ iso: String, now: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current)
    -> String?
  {
    guard let date = ServerTime.parse(iso) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    guard calendar.component(.year, from: now) == calendar.component(.year, from: date) else {
      return ServerTime.dayYear(date, timeZone: timeZone, locale: locale)
    }
    return ServerTime.dayClock(date, timeZone: timeZone, locale: locale)
  }
}

/// Rodzaj linii patcha — wyłącznie z PREFIKSU, świadomie zero parsera diffa. Nagłówek pliku
/// (`--- a/`, `+++ b/`) zaczyna się jak linie usunięte i dodane, więc idzie pierwszy. Pozostałe linie nagłówka
/// (tryb pliku, rename, plik binarny) zaczynają się od litery, a linia treści w hunku nigdy: ta ma na początku
/// spację, plus, minus albo ukośnik wsteczny.
public enum PatchLineKind: Sendable, Equatable {
  case meta, hunk, added, deleted, context

  /// Początki linii nagłówka patcha jednego pliku.
  static let metaPrefixes = [
    "diff --git ", "index ", "--- ", "+++ ", "new file mode ", "deleted file mode ", "old mode ", "new mode ",
    "similarity index ", "dissimilarity index ", "rename from ", "rename to ", "copy from ", "copy to ",
    "Binary files ", "GIT binary patch",
  ]

  public init(_ line: Substring) {
    if Self.metaPrefixes.contains(where: { line.hasPrefix($0) }) {
      self = .meta
      return
    }
    switch line.first {
    case "@": self = .hunk
    case "+": self = .added
    case "-": self = .deleted
    default: self = .context
    }
  }
}

/// Linia patcha do narysowania.
public struct PatchRow: Sendable, Equatable, Identifiable {
  public let id: String
  public let text: String
  public let kind: PatchLineKind
}

public enum PatchParser {
  /// Linie patcha JEDNEGO pliku z rodzajem i tożsamością `ścieżka#linia` — identyfikatory linii różnych
  /// plików w jednym leniwym stosie się nie zderzają. Bloków nie dzieli: odpowiedź dla pliku bywa dłuższa niż
  /// jeden `diff --git` (zmiana typu pliku), a wszystko stoi pod jednym nagłówkiem sekcji.
  public static func rows(_ patch: String, path: String) -> [PatchRow] {
    guard !patch.isEmpty else { return [] }
    var lines = lines(patch)
    // Patch kończy się znakiem nowej linii — ostatni pusty element to artefakt podziału.
    if lines.count > 1, lines.last == "" { lines.removeLast() }
    return lines.enumerated().map { PatchRow(id: "\(path)#\($0.offset)", text: String($0.element), kind: PatchLineKind($0.element)) }
  }

  /// Linie patcha. Koniec linii to LF albo CRLF: w Swifcie `\r\n` jest JEDNYM znakiem, którego podział po
  /// `"\n"` nie widzi, więc plik z końcami CRLF skleiłby się w jedną linię (ten sam przypadek co `MiniDiff`).
  static func lines(_ patch: String) -> [Substring] {
    patch.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" })
  }
}

/// Bilans policzony z patcha jednego pliku — dla pliku, któremu lista zmian liczników nie dała (nieśledzony
/// albo liczniki nie zmieściły się w budżecie serwera). Liczyć wolno tylko KOMPLETNY patch: liczba z uciętego
/// udawałaby pełny wynik.
public enum PatchStat: Sendable, Equatable {
  case lines(added: Int, deleted: Int)
  /// Git nie pokazuje linii tego pliku („Binary files … differ").
  case binary

  /// Linie `+` i `−` liczą się tylko WEWNĄTRZ hunków: nagłówek pliku (`--- a/x`, `+++ b/x`) zaczyna się tak
  /// samo, a usunięta linia `-- komentarz` wygląda w hunku jak nagłówek. W hunku linia zaczyna się od spacji,
  /// plusa, minusa albo ukośnika wstecznego, więc `diff --git` zawsze otwiera następny blok.
  public init(_ patch: String) {
    var added = 0
    var deleted = 0
    var inHunk = false
    for line in PatchParser.lines(patch) {
      if line.hasPrefix("diff --git ") {
        inHunk = false
      } else if line.hasPrefix("@@") {
        inHunk = true
      } else if inHunk {
        if line.hasPrefix("+") { added += 1 } else if line.hasPrefix("-") { deleted += 1 }
      } else if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") {
        self = .binary
        return
      }
    }
    self = .lines(added: added, deleted: deleted)
  }
}
