import Foundation

// Tłumacz zdań serwera (`docs/localization.md`). Serwer wysyła gotowy angielski tekst i obok niego `ref`
// (kod i argumenty z rejestru `shared/src/sentences/`); apka składa zdanie w swoim języku z katalogu
// `Copy/Localizable.xcstrings` tego pakietu i deskryptorów `Copy/SentenceDescriptors.swift` — oba generuje
// `scripts/sentences-catalog.mjs --write`. Każda niepewność kończy się tekstem serwera: tłumacz nigdy nie pokazuje
// zdania, którego nie umie złożyć w całości.

/// Tłumacz zdań serwera: czysta funkcja tekstu z drutu, jego `ref` i języka.
public enum ServerText {
  /// Zdanie w języku `language` albo `text`, gdy nie da się go złożyć. Reguły:
  /// - `ref == nil`, kod poza deskryptorami albo liczba argumentów inna niż w deskryptorze → `text`;
  /// - argument `int`/`plural` nie jest liczbą dziesiętną w zakresie `Int64` → `text`;
  /// - argument `instant` nie jest chwilą ISO 8601 → `text`; poprawny formatuje ``CopyDate`` w locale języka
  ///   (`state.limit-reached`: sama godzina, ``CopyDate/clock(_:timeZone:locale:)``);
  /// - argument `code` spoza deskryptorów, z własnymi argumentami albo bez wzorca → `text`; inaczej podzdanie
  ///   z katalogu w tym samym języku;
  /// - argument `text` idzie dosłownie (dane użytkownika i tekst obcy nigdy nie są tłumaczone);
  /// - klucz bez wzorca w katalogu albo wzorzec, którego specyfikatory nie zgadzają się z rodzajami → `text`.
  ///
  /// Specyfikatory są pozycyjne (`%N$@`, `%N$lld`, `%N$#@nazwa@`); pozycje przestawione i powtórzone wolno.
  /// Liczba mnoga idzie za locale języka (``CopyLookup``). Kody wycofane (`retired`) tłumaczą się jak zwykłe.
  public static func render(_ text: String, _ ref: SentenceRef?, language: CopyLanguage) -> String {
    render(text, ref, language: language, timeZone: .current)
  }

  /// Zdanie złożone w apce (odmowa na karcie bez decyzji, stopka ucięcia, `alt` obrazka) z kodu rejestru. Kod spoza
  /// deskryptorów albo złe argumenty → sam kod: to błąd programisty, który łapie test, nie stan apki.
  public static func sentence(code: String, args: [String] = [], language: CopyLanguage) -> String {
    render(code, SentenceRef(code: code, args: args), language: language)
  }

  /// Renderer dla ``SentenceBearing/translate(_:)`` w jednym języku.
  public static func renderer(language: CopyLanguage) -> SentenceRenderer {
    { text, ref in render(text, ref, language: language) }
  }

  /// Klucz katalogu kodu: kod obszaru `push` bez zmian (te same klucze czyta iOS z `loc-key` pusha), każdy inny
  /// `server.<kod>`. Ta sama reguła co `catalogKey` w `scripts/sentences-catalog.mjs`.
  public static func catalogKey(code: String) -> String {
    code.hasPrefix("push.") ? code : "server.\(code)"
  }

  // MARK: - Wewnętrzne (testy podają strefę, deskryptory i katalog)

  /// ``render(_:_:language:)`` w jawnej strefie czasu.
  static func render(_ text: String, _ ref: SentenceRef?, language: CopyLanguage, timeZone: TimeZone) -> String {
    render(text, ref, language: language, descriptors: SentenceDescriptors.table, bundle: .module, timeZone: timeZone)
  }

  /// Reguły ``render(_:_:language:)`` na podanych deskryptorach i katalogu.
  static func render(
    _ text: String, _ ref: SentenceRef?, language: CopyLanguage, descriptors: [String: SentenceDescriptor],
    bundle: Bundle, timeZone: TimeZone
  ) -> String {
    guard let ref, let descriptor = descriptors[ref.code], ref.args.count == descriptor.args.count else { return text }
    let locale = CopyLocale.resolve(language: language, device: .current, isTestProcess: CopyLanguage.isTestProcess)
    var arguments: [CVarArg] = []
    for (kind, value) in zip(descriptor.args, ref.args) {
      switch kind {
      case .int, .plural:
        guard let number = Int64(value) else { return text }
        arguments.append(number)
      case .text:
        arguments.append(value)
      case .instant:
        guard let date = instant(value) else { return text }
        arguments.append(ref.code == limitReached
          ? CopyDate.clock(date, timeZone: timeZone, locale: locale)
          : CopyDate.string(date, template: instantTemplate, timeZone: timeZone, locale: locale))
      case .code:
        guard descriptors[value]?.args.isEmpty == true,
          let sub = pattern(catalogKey(code: value), kinds: [], language: language, bundle: bundle)
        else { return text }
        arguments.append(sub.format)
      }
    }
    let key = catalogKey(code: ref.code)
    guard pattern(key, kinds: descriptor.args, language: language, bundle: bundle) != nil else { return text }
    return CopyLookup.string(key, bundle: bundle, language: language, arguments: arguments)
  }

  /// Kod, którego chwila to godzina powrotu (`Limit planu — spróbuj po 14:05.`).
  static let limitReached = "state.limit-reached"

  /// Szablon chwili w innych zdaniach: dzień, miesiąc i godzina według locale (`9 lis, 14:05`, `Nov 9, 2:05 PM`).
  static let instantTemplate = "MMMdjmm"

  /// Wzorzec klucza w języku `language`, jeśli istnieje i jego specyfikatory zgadzają się z rodzajami `kinds`.
  /// Brak klucza Foundation oddaje jako sam klucz.
  static func pattern(_ key: String, kinds: [SentenceArgKind], language: CopyLanguage, bundle: Bundle)
    -> CopyLookup.Pattern?
  {
    let found = CopyLookup.pattern(key, table: "Localizable", bundle: bundle, language: language)
    guard found.format != key, specifiersMatch(found.format, kinds: kinds, plural: found.plural) else { return nil }
    return found
  }

  /// Specyfikatory wzorca zgodne z rodzajami argumentów:
  /// - zdanie bez argumentów wraca dosłownie (`%` jest znakiem), więc nie może mieć specyfikatora pozycyjnego;
  /// - zdanie z argumentami ma tylko `%%` i specyfikatory pozycyjne: `%N$@` dla `text`, `code`, `instant`,
  ///   `%N$lld` dla `int` i `plural`, `%N$#@nazwa@` dla `plural`; `N` od 1 do liczby rodzajów;
  /// - bez liczby mnogiej każda pozycja stoi we wzorcu; z liczbą mnogą część pozycji siedzi w wariantach, których
  ///   wzorzec po kompilacji katalogu nie pokazuje — ich zgodność sprawdza generator i `l10n-check`.
  static func specifiersMatch(_ format: String, kinds: [SentenceArgKind], plural: Bool) -> Bool {
    if kinds.isEmpty { return format.firstMatch(of: /%[0-9]+\$/) == nil }
    let token = /%(?:(%)|([0-9]+)\$(@|lld|#@[A-Za-z][A-Za-z0-9_]*@))/
    var used = Set<Int>()
    for match in format.matches(of: token) where match.output.1 == nil {
      guard let digits = match.output.2, let conversion = match.output.3, let position = Int(digits),
        (1...kinds.count).contains(position)
      else { return false }
      let kind = kinds[position - 1]
      let fits = switch conversion {
      case "@": kind == .text || kind == .code || kind == .instant
      case "lld": kind == .int || kind == .plural
      default: kind == .plural
      }
      guard fits else { return false }
      used.insert(position)
    }
    guard !format.replacing(token, with: "").contains("%") else { return false }
    return plural || used.count == kinds.count
  }

  /// Chwila ISO 8601 z sekundami, z ułamkiem albo bez, w UTC (`Z`, tak pisze serwer `toISOString()`) albo
  /// z przesunięciem. Foundation przewija pola spoza zakresu (30 lutego → 2 marca), więc dzień, godzinę, minutę
  /// i sekundę sprawdzamy najpierw sami: nieistniejąca chwila odpada.
  static func instant(_ value: String) -> Date? {
    let shape = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
    guard let match = value.wholeMatch(of: shape), let year = Int(match.output.1), let month = Int(match.output.2),
      let day = Int(match.output.3), let hour = Int(match.output.4), let minute = Int(match.output.5),
      let second = Int(match.output.6), hour < 24, minute < 60, second < 60,
      DateComponents(calendar: Calendar(identifier: .gregorian), year: year, month: month, day: day).isValidDate
    else { return nil }
    let style = Date.ISO8601FormatStyle(includingFractionalSeconds: match.output.7 != nil)
    return try? Date(value, strategy: style)
  }
}
