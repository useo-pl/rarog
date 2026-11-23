import Foundation
import RarogContract

// Formatowanie czasu i ścieżek. Czyste
// funkcje, testowane na macOS. Słowa i kolejność są w katalogu (`docs/localization.md`)
// (`format.*`): liczba mnoga z wariantów katalogu, przypadek gramatyczny jako osobny klucz per kontekst (mianownik
// „4 minuty”, dopełniacz po „od” „4 minut”, biernik przed „temu” „4 minuty temu”), daty z wzorca w katalogu
// i locale apki (`CopyLocale`), godzina z regionu (`CopyDate.clock`).

/// Twarda spacja: liczba nie odrywa się od jednostki przy łamaniu („4 min"). W katalogu to znak U+00A0 w wartości.
let nbsp = "\u{00A0}"

/// Czas względny na liście i w nagłówkach: „12 s", „4 min", „2 h 05", „3 d".
public enum RelativeTime {
  public static func short(since: Date, now: Date) -> String {
    let (value, unit) = units(since: since, now: now)
    switch unit {
    case 0: return L("format.short.seconds", value)
    case 1: return L("format.short.minutes", value)
    case 2:
      let minutes = max(0, Int((now.timeIntervalSince(since)).rounded())) / 60
      return L("format.short.hoursMinutes", value, minutes % 60)
    default: return L("format.short.days", value)
    }
  }

  /// To samo pełnymi słowami — dla VoiceOver („4 minuty"), bo „min" bywa czytane dosłownie. Mianownik.
  public static func spoken(since: Date, now: Date) -> String {
    let (value, unit) = units(since: since, now: now)
    switch unit {
    case 0: return L("format.spoken.seconds", value)
    case 1: return L("format.spoken.minutes", value)
    case 2: return L("format.spoken.hours", value)
    default: return L("format.spoken.days", value)
    }
  }

  /// Dopełniacz po „od" — „czeka od 1 minuty", „od 4 minut", „od 22 godzin". Zdanie z „od” składa wywołujący
  /// (`activity.sinceSpoken`, `header.agentWaitingSpoken`…), więc klucze tej formy są osobne od mianownika.
  public static func spokenSince(since: Date, now: Date) -> String {
    let (value, unit) = units(since: since, now: now)
    switch unit {
    case 0: return L("format.spokenSince.seconds", value)
    case 1: return L("format.spokenSince.minutes", value)
    case 2: return L("format.spokenSince.hours", value)
    default: return L("format.spokenSince.days", value)
    }
  }

  /// Ile temu coś się SKOŃCZYŁO, zgrubnie: „przed chwilą", „4 min temu", „2 h temu", „3 d temu". Bez sekund
  /// i bez minut po godzinie: obok stoi godzina bezwzględna, a wiersz odświeża się co pół minuty, nie co sekundę.
  public static func ago(since: Date, now: Date) -> String {
    let (value, unit) = units(since: since, now: now)
    switch unit {
    case 0: return L("format.ago.now")
    case 1: return L("format.ago.minutes", value)
    case 2: return L("format.ago.hours", value)
    default: return L("format.ago.days", value)
    }
  }

  /// To samo słowami dla VoiceOver, biernik po liczbie: „1 minutę temu", „4 minuty temu", „2 godziny temu".
  public static func spokenAgo(since: Date, now: Date) -> String {
    let (value, unit) = units(since: since, now: now)
    switch unit {
    case 0: return L("format.spokenAgo.now")
    case 1: return L("format.spokenAgo.minutes", value)
    case 2: return L("format.spokenAgo.hours", value)
    default: return L("format.spokenAgo.days", value)
    }
  }

  /// Wartość i jednostka (0 s, 1 min, 2 h, 3 d) — ta sama skala we wszystkich zapisach.
  private static func units(since: Date, now: Date) -> (Int, Int) {
    let seconds = max(0, Int((now.timeIntervalSince(since)).rounded()))
    if seconds < 60 { return (seconds, 0) }
    let minutes = seconds / 60
    if minutes < 60 { return (minutes, 1) }
    let hours = minutes / 60
    if hours < 24 { return (hours, 2) }
    return (hours / 24, 3)
  }
}

/// Czasy z serwera: ISO 8601 z `toISOString()` (z milisekundami albo bez). Godzina i data w języku apki i według
/// regionu urządzenia (`CopyLocale.current`); testy podają locale jawnie.
public enum ServerTime {
  public static func parse(_ value: String) -> Date? {
    if let date = try? Date(value, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) {
      return date
    }
    return try? Date(value, strategy: .iso8601)
  }

  /// „14:05" w strefie urządzenia; `nil`, gdy serwer dał coś, co nie jest czasem.
  public static func clock(_ value: String, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String? {
    parse(value).map { clock($0, timeZone: timeZone, locale: locale) }
  }

  /// „14:05" chwili urządzenia (wpis w locie: `createdAt`) w strefie `timeZone`: cykl 24 h w polskim regionie
  /// (`HH:mm`), 12 h w regionie, który go używa (`CopyDate.clock`).
  public static func clock(_ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String {
    CopyDate.clock(date, timeZone: timeZone, locale: locale)
  }

  /// „9 paź" — dzień chwili w strefie `timeZone`, bez roku: stoi obok „3 d temu", więc rok mówi odległość.
  public static func day(
    _ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current, language: CopyLanguage = .current
  ) -> String {
    CopyDate.string(date, pattern: L("format.dayPattern", language: language), timeZone: timeZone, locale: locale)
  }

  /// „24 gru 2025" — dzień z rokiem (chwila z innego roku).
  public static func dayYear(_ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String {
    CopyDate.string(date, pattern: L("format.dayYearPattern"), timeZone: timeZone, locale: locale)
  }

  /// „9 paź 21:40" — dzień i godzina.
  public static func dayClock(
    _ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current, language: CopyLanguage = .current
  ) -> String {
    L(
      "format.dayClock", language: language, day(date, timeZone: timeZone, locale: locale, language: language),
      clock(date, timeZone: timeZone, locale: locale))
  }

  /// "14.11" — the day in digits, without the clock (reset line of the list footer card).
  public static func dayNumeric(_ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current) -> String {
    CopyDate.string(date, pattern: L("format.dayNumericPattern"), timeZone: timeZone, locale: locale)
  }

  /// „09.10 17:20" — dzień cyframi i godzina (pole limitów: wąsko, a obok stoi tylko godzina).
  public static func dayNumericClock(_ date: Date, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current)
    -> String
  {
    L("format.dayNumericClock", dayNumeric(date, timeZone: timeZone, locale: locale), clock(date, timeZone: timeZone, locale: locale))
  }
}

/// Ścieżki w copy. Klient nie zna `$HOME` serwera, więc katalog domowy rozpoznaje po wzorcu.
public enum PathText {
  /// `/Users/u/Projects/willow` → `~/Projects/willow`.
  public static func shortPath(_ path: String) -> String {
    guard let match = path.firstMatch(of: /^\/(?:Users|home)\/[^\/]+/) else { return path }
    return "~" + path[match.range.upperBound...]
  }

  /// Nazwa projektu = ostatni segment katalogu (korzeń: skrócona ścieżka).
  public static func projectName(_ cwd: String) -> String {
    var path = cwd
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    let name = path.split(separator: "/").last.map(String.init) ?? ""
    return name.isEmpty ? shortPath(path) : name
  }

  /// Ścieżka z `git status` bez cytowania gita: `"za\305\274\303\263\305\202\304\207.txt"` → `zażółć.txt`. Git
  /// bierze w cudzysłów ścieżkę ze znakami spoza ASCII (bajty UTF-8 ósemkowo) albo specjalnymi, a serwer oddaje
  /// ją dosłownie. Ścieżka bez cudzysłowów wraca bez zmian; bajty, które nie składają się w UTF-8 — też (to tylko
  /// pokaz, plik dalej nazywa oryginał).
  public static func gitUnquoted(_ path: String) -> String {
    guard path.count >= 2, path.hasPrefix("\""), path.hasSuffix("\"") else { return path }
    var input = Array(path.utf8.dropFirst().dropLast())[...]
    var bytes: [UInt8] = []
    while let byte = input.popFirst() {
      guard byte == UInt8(ascii: "\\"), let next = input.popFirst() else {
        bytes.append(byte)
        continue
      }
      switch next {
      case UInt8(ascii: "0")...UInt8(ascii: "3"):
        // Bajt ósemkowo: do trzech cyfr.
        var value = Int(next - UInt8(ascii: "0"))
        var digits = 1
        while digits < 3, let digit = input.first, (UInt8(ascii: "0")...UInt8(ascii: "7")).contains(digit) {
          value = value * 8 + Int(digit - UInt8(ascii: "0"))
          input.removeFirst()
          digits += 1
        }
        bytes.append(UInt8(truncatingIfNeeded: value))
      case UInt8(ascii: "a"): bytes.append(7)
      case UInt8(ascii: "b"): bytes.append(8)
      case UInt8(ascii: "t"): bytes.append(9)
      case UInt8(ascii: "n"): bytes.append(10)
      case UInt8(ascii: "v"): bytes.append(11)
      case UInt8(ascii: "f"): bytes.append(12)
      case UInt8(ascii: "r"): bytes.append(13)
      // `\\` i `\"`: sam znak.
      default: bytes.append(next)
      }
    }
    return String(bytes: bytes, encoding: .utf8) ?? path
  }

  /// Ile ostatnich segmentów ścieżki zostaje w jednolinijkowym podsumowaniu.
  public static let segmentsShown = 3

  /// Skraca ścieżki w tekście do 3 ostatnich segmentów: `Edit: /Users/x/a/b/c/d.ts` →
  /// `Edit: …/b/c/d.ts`. Zostaje nazwa pliku — jedyne, czym różnią się kolejne kroki.
  /// Adresów (`https://host/a/b`) nie rusza: znak przed ścieżką nie może być `:` ani `/`.
  public static func shortenPaths(_ text: String) -> String {
    let pattern = /(^|[^A-Za-z0-9_:\/])(~?(?:\/[A-Za-z0-9_.@+~\-]+)+)/
    return text.replacing(pattern) { match in
      let before = String(match.output.1)
      let home = shortPath(String(match.output.2))
      let rest = home.hasPrefix("~") ? String(home.dropFirst()) : home
      let segments = rest.split(separator: "/", omittingEmptySubsequences: true)
      guard segments.count > segmentsShown else { return before + home }
      return before + "…/" + segments.suffix(segmentsShown).joined(separator: "/")
    }
  }
}
