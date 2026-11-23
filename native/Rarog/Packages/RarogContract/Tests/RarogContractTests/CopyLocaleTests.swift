import Foundation
@testable import RarogContract
import Testing

// Locale apki i daty copy (`docs/localization.md`, „Dates, times and locale”). Każdy test podaje język,
// region i strefę JAWNIE — wynik nie zależy od regionu ani strefy Maca, na którym biegnie.
@Suite("copy: locale apki i daty z jawnym językiem, regionem i strefą")
struct CopyLocaleTests {
  static let warsaw = TimeZone(identifier: "Europe/Warsaw")!
  static let auckland = TimeZone(identifier: "Pacific/Auckland")!

  /// 9 października 2026, 09:05 i 21:40 w Warszawie.
  static func date(_ hour: Int, _ minute: Int, day: Int = 9, month: Int = 10, zone: TimeZone = warsaw) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
  }

  @Test("locale apki: język z copy, region i preferencje z urządzenia; proces testów — region języka")
  func appLocale() {
    #expect(CopyLocale.make(language: .en, device: Locale(identifier: "pl_PL")).identifier == "en_PL")
    #expect(CopyLocale.make(language: .pl, device: Locale(identifier: "en_US")).identifier == "pl_US")
    #expect(CopyLocale.make(language: .pl, device: Locale(identifier: "pl_PL@hours=h12")).identifier == "pl_PL@hours=h12")
    #expect(CopyLocale.resolve(language: .pl, device: Locale(identifier: "en_US"), isTestProcess: true).identifier == "pl_PL")
    #expect(CopyLocale.resolve(language: .en, device: Locale(identifier: "pl_PL"), isTestProcess: true).identifier == "en_US")
    #expect(CopyLocale.resolve(language: .en, device: Locale(identifier: "pl_PL"), isTestProcess: false).identifier == "en_PL")
    #expect(CopyLocale.current.identifier == "pl_PL", "proces testów: RAROG_COPY_LANGUAGE=pl, region języka")
  }

  /// Przed „AM” ICU stawia wąską twardą spację U+202F (macOS 27).
  @Test(
    "godzina według regionu: 24 h w polskim regionie także po angielsku, 12 h w amerykańskim, preferencja urządzenia wygrywa",
    arguments: [
      ("pl_PL", "09:05", "21:40"), ("en_PL", "09:05", "21:40"), ("en_US", "9:05\u{202F}AM", "9:40\u{202F}PM"),
      ("pl_US", "9:05\u{202F}AM", "9:40\u{202F}PM"), ("pl_PL@hours=h12", "9:05\u{202F}AM", "9:40\u{202F}PM"),
      ("en_US@hours=h23", "09:05", "21:40"),
    ])
  func clock(identifier: String, morning: String, evening: String) {
    let locale = Locale(identifier: identifier)
    #expect(CopyDate.clock(Self.date(9, 5), timeZone: Self.warsaw, locale: locale) == morning)
    #expect(CopyDate.clock(Self.date(21, 40), timeZone: Self.warsaw, locale: locale) == evening)
  }

  @Test("godzina idzie za strefą: ta sama chwila w Warszawie i Auckland")
  func clockZone() {
    let pl = Locale(identifier: "pl_PL")
    #expect(CopyDate.clock(Self.date(9, 5), timeZone: Self.warsaw, locale: pl) == "09:05")
    #expect(CopyDate.clock(Self.date(9, 5), timeZone: Self.auckland, locale: pl) == "20:05")
    #expect(CopyDate.clock(Self.date(0, 5, day: 10), timeZone: Self.warsaw, locale: pl) == "00:05", "północ z zerem")
  }

  @Test("wzorzec daty z katalogu w języku locale: skróty miesięcy po polsku identyczne z listą testu")
  func patterns() {
    let pl = Locale(identifier: "pl_PL")
    let months = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"]
    for (index, month) in months.enumerated() {
      #expect(CopyDate.string(Self.date(12, 0, month: index + 1), pattern: "d MMM", timeZone: Self.warsaw, locale: pl)
        == "9 \(month)")
    }
    #expect(CopyDate.string(Self.date(12, 0), pattern: "EEE d MMM", timeZone: Self.warsaw, locale: pl) == "pt. 9 paź")
    #expect(CopyDate.string(Self.date(12, 0), pattern: "EEEE, d MMMM", timeZone: Self.warsaw, locale: pl)
      == "piątek, 9 października")
    #expect(CopyDate.string(Self.date(12, 0), pattern: "MMM d", timeZone: Self.warsaw, locale: Locale(identifier: "en_US"))
      == "Oct 9")
    #expect(CopyDate.string(Self.date(12, 0), pattern: "dd.MM", timeZone: Self.warsaw, locale: pl) == "09.10")
  }

  @Test("początek zdania: wielka litera z formattera, nie z przeróbki tekstu")
  func beginningOfSentence() {
    let pl = Locale(identifier: "pl_PL")
    let start = { (day: Int, pattern: String) in
      CopyDate.string(Self.date(12, 0, day: day), pattern: pattern, timeZone: Self.warsaw, locale: pl, context: .beginningOfSentence)
    }
    #expect(start(9, "EEEE, d MMMM") == "Piątek, 9 października")
    #expect(start(7, "EEEE, d MMMM") == "Środa, 7 października")
    #expect(start(7, "EEE d MMM") == "Śr. 7 paź")
    #expect(CopyDate.string(Self.date(12, 0), pattern: "EEEE, MMMM d", timeZone: Self.warsaw, locale: Locale(identifier: "en_US"),
      context: .beginningOfSentence) == "Friday, October 9")
  }
}
