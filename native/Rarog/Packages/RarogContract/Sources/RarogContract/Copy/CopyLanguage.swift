import Foundation
import Synchronization

// Język copy apki (`docs/localization.md`). Ten plik leży w RarogContract, bo to jedyny pakiet, który widzą
// wszyscy, którzy mają copy: RarogUI i RarogCore (apka) oraz RarogActivity (apka i rozszerzenie widżetu, które
// rdzenia nie linkuje). Reguła wyboru języka jest jedna; każdy pakiet ma tylko własną funkcję `L` z własnym
// `Bundle.module`.

/// Język copy procesu — ustalany RAZ, przy pierwszym zapytaniu o tekst, i niezmienny do końca procesu.
///
/// Źródło, w tej kolejności:
/// 1. zmienna środowiska `RAROG_COPY_LANGUAGE` (testy: `pnpm run check`, `scripts/ios-check.sh`, schemat `Rarog`,
///    przepis „Selected tests next to other sessions” z `native/Rarog/docs/tests.md`);
/// 2. proces testów BEZ tej zmiennej → zatrzymanie z komunikatem. `swift test` chodzi na macOS, gdzie katalog
///    pakietu idzie za głównym bundlem procesu (`swiftpm-testing-helper` nie ma `.lproj`, więc dostaje `en`
///    także na Macu po polsku — pomiar na macOS 27), a test zakłada konkretny język;
/// 3. apka i widżet: pierwszy język z `Bundle.main.preferredLocalizations` — wybór systemu (język apki
///    w Ustawieniach, potem lista języków urządzenia, na końcu `CFBundleDevelopmentRegion`, czyli `en`) spośród
///    `.lproj` głównego bundla, więc tylko język, który apka ma: urządzenie z listą `[de, pl]` dostaje `pl`,
///    z listą `[de]` — `en`;
/// 4. inaczej ``development``.
///
/// Język to kod (`pl`, `en`, …), nie lista w kodzie: kolejny język dochodzi kolumną w katalogach, bez zmiany Swift.
///
/// Globalnego przełącznika NIE ma: suite'y Swift Testing biegną równolegle, więc test, który przestawiłby język,
/// psułby test obok. Test innego języka woła wariant `L(_:language:)` z jawnym językiem albo idzie osobnym
/// procesem z inną wartością zmiennej.
public struct CopyLanguage: RawRepresentable, Hashable, Sendable, CustomStringConvertible {
  /// Kod języka ISO 639 małymi literami (`pl`, `en`).
  public let rawValue: String

  /// Kod języka; `nil`, gdy to nie jest kod języka (`Base`, pusty, z regionem — region bierze się z urządzenia).
  public init?(rawValue: String) {
    guard rawValue.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil else { return nil }
    self.rawValue = rawValue
  }

  public static let pl = CopyLanguage(rawValue: "pl")!
  public static let en = CopyLanguage(rawValue: "en")!

  /// Język źródłowy i zapasowy (`defaultLocalization`, `sourceLanguage`, `CFBundleDevelopmentRegion`) — `en`.
  public static let development: CopyLanguage = .en

  public var description: String { rawValue }

  /// Zmienna środowiska, która przypina język procesu.
  public static let environmentKey = "RAROG_COPY_LANGUAGE"

  /// Język tego procesu. Pierwszy odczyt rozstrzyga regułę z opisu typu; potem wartość się nie zmienia.
  public static let current: CopyLanguage = resolveOrStop(
    environment: ProcessInfo.processInfo.environment,
    preferredLocalizations: Bundle.main.preferredLocalizations,
    isTestProcess: isTestProcess)

  /// ``resolve(environment:preferredLocalizations:isTestProcess:)`` albo zatrzymanie procesu z komunikatem problemu.
  static func resolveOrStop(
    environment: [String: String], preferredLocalizations: [String], isTestProcess: Bool
  ) -> CopyLanguage {
    switch resolve(environment: environment, preferredLocalizations: preferredLocalizations, isTestProcess: isTestProcess) {
    case let .success(language): language
    case let .failure(problem): preconditionFailure(problem.description)
    }
  }

  /// Czemu język procesu nie da się ustalić — błąd konfiguracji testów, nie stan apki.
  public enum Problem: Error, Equatable, CustomStringConvertible {
    /// Proces testów bez `RAROG_COPY_LANGUAGE`.
    case missingInTests
    /// Wartość zmiennej, która nie jest kodem języka.
    case unsupported(String)

    public var description: String {
      switch self {
      case .missingInTests:
        "\(CopyLanguage.environmentKey) nie jest ustawione w procesie testów: uruchom testy z "
          + "\(CopyLanguage.environmentKey)=pl (docs/localization.md, „Tests”)."
      case let .unsupported(value):
        "\(CopyLanguage.environmentKey)=\(value): to nie jest kod języka (pl, en, …)."
      }
    }
  }

  /// Reguła wyboru języka bez stanu procesu (testy podają jej wejście jawnie).
  public static func resolve(
    environment: [String: String], preferredLocalizations: [String], isTestProcess: Bool
  ) -> Result<CopyLanguage, Problem> {
    if let value = environment[environmentKey] {
      guard let language = CopyLanguage(rawValue: value) else { return .failure(.unsupported(value)) }
      return .success(language)
    }
    if isTestProcess { return .failure(.missingInTests) }
    for localization in preferredLocalizations {
      guard let code = Locale.Language(identifier: localization).languageCode?.identifier.lowercased(),
        let language = CopyLanguage(rawValue: code)
      else { continue }
      return .success(language)
    }
    return .success(development)
  }

  /// Proces testów: załadowany XCTest (`swift test` na macOS, testy UIKit na symulatorze). Apka i widżet go nie
  /// linkują, a XCUITest uruchamia apkę osobnym procesem, bez XCTest (pomiar na macOS 27: `XCTestCase` jest
  /// w procesie `swiftpm-testing-helper` także dla testów Swift Testing).
  static var isTestProcess: Bool { NSClassFromString("XCTestCase") != nil }

  /// Locale zdania z parametrami. Liczba mnoga katalogu idzie za locale FORMATOWANIA, nie za językiem
  /// wyszukania, więc oba muszą być tym samym językiem — ``CopyLookup`` składa je razem.
  public var locale: Locale { Locale(identifier: rawValue) }
}

/// Wyszukanie tekstu w katalogu pakietu (`Localizable.xcstrings`) w JAWNYM języku — jedyna droga od klucza do
/// zdania; funkcje `L` pakietów tylko podają tu swój `Bundle.module`.
///
/// Pomiar (Xcode 27, macOS 27, `swift test` i proces z `-AppleLanguages (en)`):
/// - `Bundle.localizedString(forKey:value:table:localizations:)` wybiera tłumaczenie niezależnie od języka
///   procesu, a `String(format:locale:arguments:)` z locale TEGO SAMEGO języka daje poprawną polską liczbę mnogą
///   (1 sesja, 2 sesje, 5 sesji, 22 sesje, 101 sesji) także przy dwóch argumentach i `%@`;
/// - ten sam format z `String(format:)` bez locale albo z locale innego języka wybiera zły wariant („2 sesji”,
///   „22 sesji”) — dlatego zdanie z liczbą mnogą formatuje się z ``CopyLanguage/locale``;
/// - `String(localized:table:bundle:locale:)` NIE wybiera tłumaczenia (locale służy tylko interpolacji),
///   `LocalizedStringResource(…, locale:)` wybiera, ale wymaga klucza statycznego i argumentów z `defaultValue`.
///
/// Bez argumentów tekst wraca dosłownie (bez `String(format:)`): `%` w zdaniu bez parametrów piszemy pojedynczo,
/// w zdaniu z parametrami jako `%%`. Brak klucza w katalogu → sam klucz (zachowanie Foundation); kompletność
/// katalogów i klucze użyte w kodzie sprawdza `scripts/l10n-check.mjs` w `pnpm run check`.
///
/// Locale formatowania TYLKO dla zdania z liczbą mnogą (wzorzec z `%#@…@`, tak go oddaje katalog po kompilacji do
/// `.stringsdict`). Measured on macOS 27: `String(format:locale:)` with the `pl` locale groups the digits of a number
/// from 10 000 with a no-break space ("-25 308", "12 345"), with `en` with a comma from 1000 ("5,000"); without a
/// locale the number comes out as in Swift interpolation ("-25308"). A sentence without a plural is therefore formatted
/// without a locale, so numbers keep the ungrouped form.
///
/// Liczby bez grupowania w KAŻDYM zdaniu i każdym języku: zdanie z liczbą
/// mnogą też, choć jego locale grupuje. Pomiar (macOS 27): grupowania nie wyłącza ani specyfikator
/// (`%d`, `%ld`, `%lld`, `%u`, flagi), ani własna podklasa `NSLocale` (ICU bierze identyfikator), a słownik
/// zamiast locale wywraca formatowanie liczby mnogiej. Zostaje ``ungrouped(_:arguments:locale:)``: zapis liczby
/// z separatorem tego locale wraca do zapisu bez separatora.
///
/// Pamięć podręczna (pomiar na macOS 27): `localizedString(…localizations:)` kosztuje ~700 µs
/// na wywołanie (wariant bez `localizations:` ~1,6 µs) — każdy tekst rejestru idzie tą drogą, a wiersz listy pyta
/// o kilka naraz. Wzorzec zdania (wynik wyszukania, przed formatowaniem) zapamiętujemy więc per bundle, tabela,
/// język i klucz; katalog w zbudowanej apce się nie zmienia, a język jest częścią klucza pamięci.
public enum CopyLookup {
  public static func string(
    _ key: String, table: String = "Localizable", bundle: Bundle, language: CopyLanguage, arguments: [CVarArg]
  ) -> String {
    let found = pattern(key, table: table, bundle: bundle, language: language)
    guard !arguments.isEmpty else { return found.format }
    guard found.plural else { return String(format: found.format, locale: nil, arguments: arguments) }
    let locale = locales.withLock { cache in
      if let locale = cache[language] { return locale }
      let locale = language.locale
      cache[language] = locale
      return locale
    }
    return ungrouped(String(format: found.format, locale: locale, arguments: arguments), arguments: arguments, locale: locale)
  }

  /// Zdanie z liczbą mnogą bez grupowania cyfr: każdy argument całkowity, który `locale` zapisuje
  /// z separatorem tysięcy („12 345”, „12,345”), wraca do zapisu bez niego („12345”) — tak jak w zdaniu bez liczby
  /// mnogiej. Liczba poniżej 1000 nie ma separatora w żadnym języku, więc jej nie szukamy.
  /// Dłuższy zapis idzie pierwszy: „1,012,345” zawiera „12,345”. Tekst parametru z identycznym zapisem liczby
  /// z separatorem (nazwa pliku „12 345”) też by się zmienił — w zdaniach rejestru takiego parametru nie ma.
  static func ungrouped(_ text: String, arguments: [CVarArg], locale: Locale) -> String {
    let numbers = Set(arguments.compactMap(integer).filter { $0.magnitude >= 1000 })
    guard !numbers.isEmpty else { return text }
    let pairs = numbers.map { (grouped: String(format: "%lld", locale: locale, $0), plain: String($0)) }
      .filter { $0.grouped != $0.plain }
      .sorted { $0.grouped.count > $1.grouped.count }
    return pairs.reduce(text) { $0.replacingOccurrences(of: $1.grouped, with: $1.plain) }
  }

  /// Argument całkowity (`Int` i rodzina) jako `Int64`; tekst i reszta — `nil`.
  static func integer(_ value: CVarArg) -> Int64? {
    switch value {
    case let value as Int: Int64(value)
    case let value as Int64: value
    case let value as Int32: Int64(value)
    case let value as UInt: Int64(exactly: value)
    case let value as UInt32: Int64(value)
    default: nil
    }
  }

  /// Wzorzec zdania z katalogu (bez formatowania) i to, czy niesie liczbę mnogą (`%#@…@`, także `%1$#@…@`).
  struct Pattern: Sendable {
    let format: String
    let plural: Bool
  }

  /// ``Pattern`` z pamięci podręcznej.
  static func pattern(_ key: String, table: String, bundle: Bundle, language: CopyLanguage) -> Pattern {
    let id = Entry(bundle: bundle.bundlePath, table: table, language: language, key: key)
    if let hit = patterns.withLock({ $0[id] }) { return hit }
    let format = bundle.localizedString(
      forKey: key, value: nil, table: table, localizations: [Locale.Language(identifier: language.rawValue)])
    let found = Pattern(format: format, plural: format.range(of: #"%(?:[0-9]+\$)?#@"#, options: .regularExpression) != nil)
    patterns.withLock { $0[id] = found }
    return found
  }

  struct Entry: Hashable {
    let bundle: String
    let table: String
    let language: CopyLanguage
    let key: String
  }

  private static let patterns = Mutex<[Entry: Pattern]>([:])
  private static let locales = Mutex<[CopyLanguage: Locale]>([:])
}
