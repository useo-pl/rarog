import Foundation
import Synchronization

// Locale apki i formatowanie dat dla copy (`docs/localization.md`, "Dates, times and locale").
// Leży obok `CopyLanguage`, bo daty formatują RarogUI (apka) i RarogActivity (kafel w rozszerzeniu widżetu, bez
// rdzenia), a sortowanie nazw — RarogCore.

/// Locale apki: JĘZYK copy procesu (``CopyLanguage/current``) z REGIONEM i preferencjami urządzenia (cykl 12/24 h,
/// pierwszy dzień tygodnia, region formatów). Na nim stoją formattery dat, sortowanie i wielkość liter, więc data
/// mówi językiem apki, a zegar idzie za regionem: polski region daje 24 h także po angielsku (pomiar na
/// macOS 27: `en_PL` → szablon `jmm` = `HH:mm`, `pl_US` → `h:mm a`, `pl_PL@hours=h12` → `h:mm a`).
public enum CopyLocale {
  /// Locale tego procesu — ustalane raz, jak język. Proces testów dostaje locale bez preferencji maszyny
  /// (``resolve(language:device:isTestProcess:)``), więc test nie zależy od regionu Maca, na którym biegnie.
  public static let current: Locale = resolve(
    language: CopyLanguage.current, device: Locale.current, isTestProcess: CopyLanguage.isTestProcess)

  /// Reguła bez stanu procesu. Apka i widżet: ``make(language:device:)``. Proces testów: język z najbardziej
  /// prawdopodobnym regionem (`pl` → `pl_PL`, `en` → `en_US`), bez preferencji urządzenia — test innego regionu
  /// podaje locale jawnie.
  public static func resolve(language: CopyLanguage, device: Locale, isTestProcess: Bool) -> Locale {
    guard isTestProcess else { return make(language: language, device: device) }
    let region = Locale.Language(identifier: language.rawValue).maximalIdentifier.split(separator: "-").last
      .map { Locale.Region(String($0)) }
    return Locale(languageCode: Locale.LanguageCode(language.rawValue), languageRegion: region)
  }

  /// Locale urządzenia z podmienionym językiem: region (także nadpisany w Ustawieniach, `rg`) i preferencje
  /// (`@hours=h23`) zostają. Pomiar na macOS 27: podmiana samego kodu języka gubi region (`en_PL` → `en`), więc
  /// region idzie jawnie.
  public static func make(language: CopyLanguage, device: Locale) -> Locale {
    var components = Locale.Components(locale: device)
    components.languageComponents = Locale.Language.Components(
      languageCode: Locale.LanguageCode(language.rawValue), script: nil, region: device.region)
    return Locale(components: components)
  }
}

/// Daty i godziny w copy: wzorzec z katalogu (`d MMM`, `EEE d MMM` — kolejność i skróty to rzecz języka) albo
/// godzina z szablonu `jmm` (cykl 12/24 h to rzecz regionu i preferencji). Zawsze kalendarz gregoriański
/// i jawna strefa.
public enum CopyDate {
  /// „14:05” — godzina i minuty według regionu locale: `HH:mm` w polskim regionie (jak
  /// `%02d:%02d`), `h:mm a` w amerykańskim.
  public static func clock(_ date: Date, timeZone: TimeZone, locale: Locale = CopyLocale.current) -> String {
    string(date, template: "jmm", timeZone: timeZone, locale: locale)
  }

  /// Data według wzorca Unicode (`DateFormatter.dateFormat`), np. `d MMM` → „9 paź”. `context` — miejsce w zdaniu:
  /// `.beginningOfSentence` daje wielką literę tam, gdzie język jej wymaga („Piątek, 9 października” na początku
  /// zdania czytnika), bez przerabiania gotowego tekstu (pomiar na macOS 27: `pl` — „Piątek”, „Śr.”; `en` bez zmian).
  public static func string(
    _ date: Date, pattern: String, timeZone: TimeZone, locale: Locale = CopyLocale.current,
    context: Formatter.Context = .unknown
  ) -> String {
    format(date, Key(pattern: pattern, template: false, locale: locale.identifier, timeZone: timeZone.identifier,
      context: context.rawValue), locale: locale, timeZone: timeZone, context: context)
  }

  /// Data według szablonu (`jmm`): wzorzec dobiera locale (`DateFormatter.dateFormat(fromTemplate:)`).
  public static func string(_ date: Date, template: String, timeZone: TimeZone, locale: Locale = CopyLocale.current)
    -> String
  {
    format(date, Key(pattern: template, template: true, locale: locale.identifier, timeZone: timeZone.identifier,
      context: Formatter.Context.unknown.rawValue), locale: locale, timeZone: timeZone, context: .unknown)
  }

  struct Key: Hashable {
    let pattern: String
    let template: Bool
    let locale: String
    let timeZone: String
    let context: Int
  }

  /// `DateFormatter` jest drogi w budowie (wiersz listy pyta o godzinę co odświeżenie), więc formatter per wzorzec,
  /// locale i strefa żyje w pamięci; formatowanie idzie pod zamkiem, bo formatter nie jest `Sendable`.
  private static let formatters = Mutex<[Key: DateFormatter]>([:])

  private static func format(_ date: Date, _ key: Key, locale: Locale, timeZone: TimeZone, context: Formatter.Context)
    -> String
  {
    formatters.withLock { cache in
      let formatter = cache[key] ?? {
        let made = DateFormatter()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = locale
        made.calendar = calendar
        made.locale = locale
        made.timeZone = timeZone
        made.formattingContext = context
        made.dateFormat = key.template
          ? DateFormatter.dateFormat(fromTemplate: key.pattern, options: 0, locale: locale) ?? key.pattern
          : key.pattern
        return made
      }()
      cache[key] = formatter
      return formatter.string(from: date)
    }
  }
}
