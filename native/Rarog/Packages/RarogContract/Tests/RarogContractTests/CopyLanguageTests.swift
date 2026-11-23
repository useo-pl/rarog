import Foundation
@testable import RarogContract
import Synchronization
import Testing

// Język copy (`docs/localization.md`): reguła wyboru języka procesu i wyszukanie w jawnym języku. Katalog-próbka
// `Resources/Localizable.xcstrings` tego celu testów ma `en` (źródło) i `pl`, jak katalogi pakietów apki.
@Suite("język copy: reguła wyboru i wyszukanie w jawnym języku")
struct CopyLanguageTests {
  static let key = CopyLanguage.environmentKey

  @Test("proces testów ma przypięty język: zmienna z bramki (pnpm run check, ios-check.sh) daje pl")
  func processLanguageIsPinned() {
    #expect(ProcessInfo.processInfo.environment[Self.key] == "pl")
    #expect(CopyLanguage.current == .pl)
  }

  @Test("proces testów rozpoznany po załadowanym XCTest, także pod Swift Testing")
  func detectsTestProcess() {
    #expect(CopyLanguage.isTestProcess)
  }

  @Test("bez zmiennej proces testów zatrzymuje się na pierwszym zapytaniu (proces potomny)")
  func stopsWithoutVariable() async {
    let result = await #expect(processExitsWith: .failure, observing: [\.standardErrorContent]) {
      _ = CopyLanguage.resolveOrStop(
        environment: [:], preferredLocalizations: ["pl"], isTestProcess: CopyLanguage.isTestProcess)
    }
    let stderr = String(decoding: result?.standardErrorContent ?? [], as: UTF8.self)
    #expect(stderr.contains("RAROG_COPY_LANGUAGE nie jest ustawione w procesie testów"), "\(stderr)")
  }

  @Test("zmienna środowiska wygrywa z językiem bundla, także w apce")
  func environmentWins() {
    #expect(CopyLanguage.resolve(environment: [Self.key: "en"], preferredLocalizations: ["pl"], isTestProcess: true)
      == .success(.en))
    #expect(CopyLanguage.resolve(environment: [Self.key: "pl"], preferredLocalizations: ["en"], isTestProcess: false)
      == .success(.pl))
  }

  @Test("proces testów bez zmiennej i nieznana wartość to błąd konfiguracji, nie cichy wybór")
  func misconfiguration() {
    #expect(CopyLanguage.resolve(environment: [:], preferredLocalizations: ["pl"], isTestProcess: true)
      == .failure(.missingInTests))
    for value in ["", "PL", "pl_PL", "pl-PL", "Base", "polski"] {
      #expect(CopyLanguage.resolve(environment: [Self.key: value], preferredLocalizations: ["pl"], isTestProcess: false)
        == .failure(.unsupported(value)), "\(value)")
    }
    #expect(CopyLanguage.Problem.missingInTests.description.contains("\(Self.key)=pl"))
  }

  @Test(
    "apka bez zmiennej: pierwszy język z listy bundla (bez regionu), inaczej język źródłowy en",
    arguments: [
      (["pl"], CopyLanguage.pl), (["en"], .en), (["en-GB", "pl"], .en), (["pl-PL"], .pl),
      (["de", "en"], CopyLanguage(rawValue: "de")!), (["Base", "en"], .en), (["Base"], .en), ([], .en),
    ])
  func bundlePreference(preferred: [String], expected: CopyLanguage) {
    #expect(CopyLanguage.resolve(environment: [:], preferredLocalizations: preferred, isTestProcess: false)
      == .success(expected))
  }

  @Test("język to kod, nie lista w kodzie: kolejny język bez zmiany Swift; źródłowy i zapasowy to en")
  func codes() {
    #expect(CopyLanguage(rawValue: "de")?.locale.language.languageCode?.identifier == "de")
    #expect(CopyLanguage(rawValue: "pl") == .pl)
    #expect(CopyLanguage.development == .en)
  }

  /// Lista języków urządzenia nie trafia do reguły wprost: system wybiera z niej język, dla którego bundle ma `.lproj`
  /// (QA1828), i dopiero ten wynik (`Bundle.main.preferredLocalizations`) czyta ``CopyLanguage/resolve``. Tu ten sam
  /// wybór robi `Bundle.preferredLocalizations(from:forPreferences:)` na lokalizacjach bundla próbki (`en`, `pl`).
  /// Bez dopasowania ta funkcja daje `en` (macOS 27: także przy kolejności `[pl, en]`), a główny
  /// bundel apki bierze `CFBundleDevelopmentRegion` — też `en`.
  @Test(
    "lista urządzenia: pierwszy język, który apka ma; bez dopasowania en",
    arguments: [
      (["de", "pl"], CopyLanguage.pl), (["de"], .en), (["en"], .en), (["pl"], .pl), (["fr", "de"], .en),
      (["en-GB", "pl"], .en), (["pl-PL", "en"], .pl),
    ])
  func deviceList(device: [String], expected: CopyLanguage) {
    #expect(Set(Bundle.module.localizations).isSuperset(of: ["en", "pl"]), "\(Bundle.module.localizations)")
    let chosen = Bundle.preferredLocalizations(from: Bundle.module.localizations, forPreferences: device)
    #expect(CopyLanguage.resolve(environment: [:], preferredLocalizations: chosen, isTestProcess: false)
      == .success(expected), "\(device) → \(chosen)")
  }
}

/// Pomiar jako test: wyszukanie w JAWNYM języku daje tłumaczenie i polską liczbę mnogą niezależnie od języka
/// procesu (proces testów jest na `pl`, wariant `en` idzie obok bez przełącznika).
@Suite("język copy: wyszukanie w katalogu")
struct CopyLookupTests {
  static func text(_ key: String, _ language: CopyLanguage, _ arguments: CVarArg...) -> String {
    CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
  }

  @Test("zdanie bez parametrów w obu językach; procent zostaje dosłownie")
  func plain() {
    #expect(Self.text("fixture.plain", .pl) == "Cześć")
    #expect(Self.text("fixture.plain", .en) == "Hello")
    #expect(Self.text("fixture.percent", .pl) == "Gotowe w 100%")
    #expect(Self.text("fixture.percent", .en) == "100% done")
  }

  @Test(
    "polska liczba mnoga: one, few, many z jawnym językiem",
    arguments: [
      (1, "1 sesja"), (2, "2 sesje"), (4, "4 sesje"), (5, "5 sesji"), (12, "12 sesji"), (22, "22 sesje"),
      (25, "25 sesji"), (101, "101 sesji"), (0, "0 sesji"),
    ])
  func polishPlural(count: Int, expected: String) {
    #expect(Self.text("fixture.sessions", .pl, count) == expected)
  }

  @Test("angielska liczba mnoga obok, w tym samym procesie", arguments: [(1, "1 session"), (2, "2 sessions"), (22, "22 sessions")])
  func englishPlural(count: Int, expected: String) {
    #expect(Self.text("fixture.sessions", .en, count) == expected)
  }

  @Test("dwie liczby mnogie w jednym zdaniu, parametr tekstowy i %% w zdaniu z parametrami")
  func substitutions() {
    #expect(Self.text("fixture.sessionsInProjects", .pl, 2, 3) == "2 sesje w 3 projektach")
    #expect(Self.text("fixture.sessionsInProjects", .pl, 5, 1) == "5 sesji w 1 projekcie")
    #expect(Self.text("fixture.sessionsInProjects", .en, 1, 22) == "1 session in 22 projects")
    #expect(Self.text("fixture.waiting", .pl, "willow", 40) == "Sesja willow czeka (40%)")
    #expect(Self.text("fixture.waiting", .en, "willow", 40) == "Session willow is waiting (40%)")
  }

  @Test("brak klucza: sam klucz (zachowanie Foundation)")
  func missingKey() {
    #expect(Self.text("fixture.missing", .pl) == "fixture.missing")
  }

  /// Pomiar (macOS 27): `String(format:locale:)` z locale `pl` grupuje cyfry od 10 000 („12 345”),
  /// z `en` od 1000 („12,345”). Zdanie bez liczby mnogiej formatuje się bez locale, jak interpolacja Swift;
  /// locale dostaje tylko zdanie z liczbą mnogą, bo bez niego wariant wychodzi zły (pomiar wyżej). Reguła:
  /// liczby bez grupowania w każdym zdaniu i języku, także w zdaniu z liczbą mnogą (`CopyLookup.ungrouped`).
  @Test("liczby bez grupowania w każdym zdaniu i języku, także w liczbie mnogiej; wariant dalej z locale")
  func numberGrouping() {
    #expect(Self.text("fixture.waiting", .pl, "willow", 12_345) == "Sesja willow czeka (12345%)")
    #expect(Self.text("fixture.waiting", .en, "willow", -25_308) == "Session willow is waiting (-25308%)")
    #expect(Self.text("fixture.sessions", .pl, 12_345) == "12345 sesji")
    #expect(Self.text("fixture.sessions", .pl, 12_342) == "12342 sesje", "wariant „few” po liczbie powyżej 10 000")
    #expect(Self.text("fixture.sessions", .pl, -25_308) == "-25308 sesji")
    #expect(Self.text("fixture.sessions", .en, 12_345) == "12345 sessions")
    #expect(Self.text("fixture.sessions", .en, 1_000) == "1000 sessions")
    #expect(Self.text("fixture.sessions", .en, 999) == "999 sessions")
    #expect(Self.text("fixture.sessionsInProjects", .pl, 2, 22) == "2 sesje w 22 projektach")
    #expect(Self.text("fixture.sessionsInProjects", .pl, 1_012_345, 12_345) == "1012345 sesji w 12345 projektach")
    #expect(Self.text("fixture.sessionsInProjects", .en, 12_345, 1_012_345) == "12345 sessions in 1012345 projects")
  }

  @Test("cofnięcie grupowania: dłuższy zapis pierwszy, tekst bez liczby nietknięty, typy całkowite")
  func ungroupedRule() {
    let en = Locale(identifier: "en")
    #expect(CopyLookup.ungrouped("1,012,345 and 12,345", arguments: [12_345, 1_012_345], locale: en) == "1012345 and 12345")
    #expect(CopyLookup.ungrouped("Ala ma kota", arguments: [12_345], locale: en) == "Ala ma kota")
    #expect(CopyLookup.ungrouped("999 x", arguments: [999], locale: en) == "999 x")
    #expect(CopyLookup.ungrouped("12,345 x", arguments: [Int64(12_345)], locale: en) == "12345 x")
    #expect(CopyLookup.ungrouped("12,345 x", arguments: ["12,345"], locale: en) == "12,345 x", "tekst nie jest liczbą")
  }

  /// Pomiar (macOS 27): `localizedString(…localizations:)` kosztuje ~700 µs na wywołanie, więc 2000
  /// wyszukań bez pamięci podręcznej trwa ~1,4 s; z pamięcią — kilka milisekund. Próg 0,5 s zostawia zapas na
  /// obciążony Mac i nadal łapie powrót do wyszukania przy każdym wywołaniu.
  @Test("powtórne wyszukanie idzie z pamięci podręcznej: te same zdania w obu językach, bez kosztu ~700 µs")
  func cached() {
    let pl = Self.text("fixture.sessions", .pl, 22)
    let en = Self.text("fixture.sessions", .en, 22)
    var same = 0
    let elapsed = ContinuousClock().measure {
      for round in 0..<2000 {
        let language: CopyLanguage = round.isMultiple(of: 2) ? .pl : .en
        if Self.text("fixture.sessions", language, 22) == (language == .pl ? pl : en) { same += 1 }
      }
    }
    #expect(pl == "22 sesje" && en == "22 sessions")
    #expect(same == 2000)
    #expect(elapsed < .milliseconds(500), "2000 wyszukań: \(elapsed); bez pamięci podręcznej ~1,4 s")
  }

  /// Klucz pamięci to bundle, tabela, język i klucz: ten sam klucz w innym bundlu albo tabeli nie bierze cudzego
  /// zdania, a równoległe pierwsze odczyty (wiele wątków naraz) dają to samo co odczyt pojedynczy.
  @Test("pamięć podręczna: osobno per bundle i tabela; równoległe pierwsze odczyty zgodne")
  func cacheIsolationAndConcurrency() {
    let other = CopyLookup.string("fixture.plain", table: "BrakTabeli", bundle: .module, language: .pl, arguments: [])
    let main = CopyLookup.string("fixture.plain", bundle: .main, language: .pl, arguments: [])
    #expect(Self.text("fixture.plain", .pl) == "Cześć")
    #expect(other == "fixture.plain")
    #expect(main == "fixture.plain")
    #expect(Self.text("fixture.plain", .pl) == "Cześć")
    // (klucz, język, parametr tekstowy albo nil, liczba, oczekiwane zdanie)
    let keys: [(String, CopyLanguage, String?, Int, String)] = [
      ("fixture.waiting", .pl, "willow", 7, "Sesja willow czeka (7%)"),
      ("fixture.waiting", .en, "willow", 7, "Session willow is waiting (7%)"),
      ("fixture.sessions", .pl, nil, 5, "5 sesji"),
      ("fixture.sessions", .en, nil, 1, "1 session"),
    ]
    let results = Mutex<[String]>([])
    DispatchQueue.concurrentPerform(iterations: 64) { index in
      let (key, language, word, count, expected) = keys[index % keys.count]
      let arguments: [CVarArg] = word.map { [$0, count] } ?? [count]
      let text = CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
      if text != expected { results.withLock { $0.append("\(key)[\(language)]: \(text)") } }
    }
    #expect(results.withLock { $0 } == [])
  }
}
