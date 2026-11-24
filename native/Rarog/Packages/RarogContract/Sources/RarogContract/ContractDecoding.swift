// Narzędzia dekodowania kontraktu — JEDNO miejsce reguł tolerancji z `shared/src/decode.ts`.
//
// Każdy typ ramki dekoduje się ręcznie przez `ContractContainer`, nie przez syntezę `Decodable`:
// - synteza czyta pola opcjonalne `decodeIfPresent`, który zamienia `null` w brak pola, a kontrakt
//   (zod `.optional()`) `null` ODRZUCA — wtedy cała ramka wypada;
// - pole wyliczeniowe z tabeli `DEGRADATIONS` czyta `lenient`, który zapisuje degradację
//   i oddaje wartość zapasową; reszta wyliczeń czyta `strict`.
// Strażnik źródeł (`SourceGuardTests`) pilnuje, żeby `decodeIfPresent` tu nie wrócił.

/// Wyliczenie z drutu. `clientSentinel` to wartość, którą zna WYŁĄCZNIE klient (`unsupported`
/// z `UNSUPPORTED` w `decode.ts`): łańcuch równy wartownikowi od serwera nie jest „znany",
/// tylko degradowany — serwer nie ma prawa go nadać.
public protocol ContractEnum: RawRepresentable, CaseIterable, Sendable, Hashable, Encodable
where RawValue == String {
  static var clientSentinel: Self? { get }
}

extension ContractEnum {
  public static var clientSentinel: Self? { nil }

  /// Wartość znana serwerowi albo `nil` (nieznany łańcuch albo wartownik klienta).
  static func wire(_ raw: String) -> Self? {
    guard let value = Self(rawValue: raw), value != clientSentinel else { return nil }
    return value
  }
}

/// Obiekt, który przy nieznanym wyróżniku (`kind`) ZNIKA w całości (`context`, `activity`,
/// `waitingFor` w podsumowaniu sesji): kształtu nieznanego rodzaju nie znamy, więc nie ma czego
/// pokazać połowicznie. `nil` = obiekt zdjęty (degradacja zapisana), wyjątek = ramka odrzucona.
protocol TolerantDecodable {
  static func decodeTolerant(from decoder: any Decoder) throws -> Self?
}

/// JSON Pointer (RFC 6901) ze ścieżki kodowania: klucze obiektów po nazwie, indeksy tablic liczbą.
func jsonPointer(_ path: [any CodingKey]) -> String {
  path.map { key in
    let segment = key.intValue.map(String.init) ?? key.stringValue
    return "/" + segment.replacing("~", with: "~0").replacing("/", with: "~1")
  }.joined()
}

/// Indeks tablicy w ścieżce kodowania (JSON Pointer `…/0`).
struct ContractIndexKey: CodingKey {
  let intValue: Int?
  var stringValue: String { String(intValue ?? 0) }
  init(_ index: Int) { intValue = index }
  init?(intValue: Int) { self.init(intValue) }
  init?(stringValue: String) { nil }
}

/// Odrzucenie ramki z kontekstem (ścieżka trafia do `EventRejection`).
func contractViolation(_ path: [any CodingKey], _ reason: String) -> DecodingError {
  .dataCorrupted(DecodingError.Context(codingPath: path, debugDescription: reason))
}

/// Kontener z regułami kontraktu. Tworzony w każdym `init(from:)` typu z drutu.
struct ContractContainer<Key: CodingKey> {
  let base: KeyedDecodingContainer<Key>
  let sink: DegradationSink?

  init(_ decoder: any Decoder, keyedBy type: Key.Type) throws {
    base = try decoder.container(keyedBy: type)
    sink = decoder.userInfo[.rarogDegradations] as? DegradationSink
  }

  var codingPath: [any CodingKey] { base.codingPath }

  func contains(_ key: Key) -> Bool { base.contains(key) }

  /// Pole wymagane: brak, `null` i zły typ odrzucają ramkę.
  func required<T: Decodable>(_ key: Key) throws -> T {
    try base.decode(T.self, forKey: key)
  }

  /// Pole opcjonalne (zod `.optional()`): brak = `nil`, `null` ODRZUCA ramkę.
  func optional<T: Decodable>(_ key: Key) throws -> T? {
    guard base.contains(key) else { return nil }
    if try base.decodeNil(forKey: key) {
      throw contractViolation(codingPath + [key], "null w polu opcjonalnym — kontrakt zna tylko brak pola")
    }
    return try base.decode(T.self, forKey: key)
  }

  /// Pole wymagane, które może mieć wartość `null` (zod `.nullable()`, np. `degradedSince` statusu APNs).
  func nullable<T: Decodable>(_ key: Key) throws -> T? {
    guard base.contains(key) else {
      throw DecodingError.keyNotFound(key, DecodingError.Context(
        codingPath: codingPath, debugDescription: "brak wymaganego pola (null jest dozwolony)"))
    }
    if try base.decodeNil(forKey: key) { return nil }
    return try base.decode(T.self, forKey: key)
  }

  /// Pole odpowiedzi REST, w którym serwer pisze `null` zamiast pominąć klucz (`tailnet`).
  func optionalOrNull<T: Decodable>(_ key: Key) throws -> T? {
    guard base.contains(key), try !base.decodeNil(forKey: key) else { return nil }
    return try base.decode(T.self, forKey: key)
  }

  /// Łańcuch niepusty (zod `.string().min(1)`).
  func nonEmpty(_ key: Key) throws -> String {
    let value: String = try required(key)
    guard !value.isEmpty else { throw contractViolation(codingPath + [key], "pusty łańcuch") }
    return value
  }

  /// Wyliczenie bez pozycji w `DEGRADATIONS`: nieznana wartość odrzuca ramkę.
  func strict<E: ContractEnum>(_ key: Key) throws -> E {
    let raw: String = try required(key)
    guard let value = E.wire(raw) else {
      throw contractViolation(codingPath + [key], "nieznana wartość „\(raw)” w polu bez degradacji")
    }
    return value
  }

  /// Wyliczenie bez pozycji w `DEGRADATIONS`, pole opcjonalne: brak = `nil`, `null` i nieznana wartość odrzucają ramkę.
  func strictOptional<E: ContractEnum>(_ key: Key) throws -> E? {
    guard base.contains(key) else { return nil }
    if try base.decodeNil(forKey: key) {
      throw contractViolation(codingPath + [key], "null w polu opcjonalnym — kontrakt zna tylko brak pola")
    }
    return try strict(key)
  }

  /// Wyliczenie z `DEGRADATIONS`, pole wymagane: nieznany ŁAŃCUCH → wartość zapasowa
  /// i degradacja; `null`, liczba i brak dalej odrzucają ramkę.
  func lenient<E: ContractEnum>(_ key: Key, degrade: DegradationKey) throws -> E {
    guard let value: E = try lenientValue(key, degrade: degrade) else {
      throw contractViolation(codingPath + [key], "pole wymagane bez wartości zapasowej (\(degrade.rawValue))")
    }
    return value
  }

  /// Wyliczenie z `DEGRADATIONS`, pole opcjonalne: brak = `nil`; nieznany łańcuch → zapas
  /// (także `nil` = pole znika) i degradacja; `null` odrzuca ramkę.
  func lenientOptional<E: ContractEnum>(_ key: Key, degrade: DegradationKey) throws -> E? {
    guard base.contains(key) else { return nil }
    if try base.decodeNil(forKey: key) {
      throw contractViolation(codingPath + [key], "null w polu opcjonalnym — kontrakt zna tylko brak pola")
    }
    return try lenientValue(key, degrade: degrade)
  }

  /// Obiekt znikający przy nieznanym wyróżniku (``TolerantDecodable``), pole opcjonalne.
  func tolerantOptional<T: TolerantDecodable>(_ key: Key) throws -> T? {
    guard base.contains(key) else { return nil }
    if try base.decodeNil(forKey: key) {
      throw contractViolation(codingPath + [key], "null zamiast obiektu")
    }
    return try T.decodeTolerant(from: base.superDecoder(forKey: key))
  }

  /// Opcjonalna tablica łańcuchów wyliczenia: nieznany element degraduje się do wartości zapasowej (ścieżka
  /// z indeksem, jak `notes/0` w `decode.ts`); element bez wartości zapasowej odrzuca ramkę.
  func lenientArray<E: ContractEnum>(_ key: Key, degrade field: DegradationKey) throws -> [E]? {
    guard let raws: [String] = try optional(key) else { return nil }
    return try raws.enumerated().map { index, raw in
      if let value = E.wire(raw) { return value }
      let path = codingPath + [key, ContractIndexKey(index)]
      sink?.record(path: jsonPointer(path), value: raw)
      guard let fallback = field.fallbackRawValue, let value = E(rawValue: fallback) else {
        throw contractViolation(path, "element bez wartości zapasowej (\(field.rawValue))")
      }
      return value
    }
  }

  /// Enum field of a list element that drops whole on an unknown value (Inbox heads and cards): `false` and a
  /// recorded degradation for an unknown string; `null`, another type and a missing field reject as in `strict`.
  func known<E: ContractEnum>(_ key: Key, as type: E.Type) throws -> Bool {
    let raw: String = try required(key)
    guard E.wire(raw) == nil else { return true }
    degrade(key, raw: raw)
    return false
  }

  /// Optional variant of ``known(_:as:)``: a missing field is known, `null` rejects.
  func knownOptional<E: ContractEnum>(_ key: Key, as type: E.Type) throws -> Bool {
    guard base.contains(key) else { return true }
    if try base.decodeNil(forKey: key) {
      throw contractViolation(codingPath + [key], "null in an optional field: the contract knows only a missing field")
    }
    return try known(key, as: type)
  }

  /// Zapisuje degradację pola `key` z nieznanym łańcuchem `raw`.
  func degrade(_ key: Key, raw: String) {
    sink?.record(path: jsonPointer(codingPath + [key]), value: raw)
  }

  private func lenientValue<E: ContractEnum>(_ key: Key, degrade field: DegradationKey) throws -> E? {
    let raw: String = try required(key)
    if let value = E.wire(raw) { return value }
    degrade(key, raw: raw)
    guard let fallback = field.fallbackRawValue else { return nil }
    guard let value = E(rawValue: fallback) else {
      // Błąd tabeli, nie serwera: wartość zapasowa spoza typu pola. Odrzucamy, nie zgadujemy.
      throw contractViolation(codingPath + [key], "wartość zapasowa „\(fallback)” spoza typu \(E.self)")
    }
    return value
  }
}

// MARK: - Walidacja kształtu łańcuchów (lustro wzorców z `protocol.ts`)

enum WireFormat {
  /// `MAX_IMAGE_DATA_URL_BYTES` = `Math.round(1.5 * 1024 * 1024)`.
  static let maxImageDataURLBytes = 1_572_864

  /// `IMAGE_DATA_URL_PATTERN`: wyłącznie base64 png/jpeg, w limicie długości. Granica
  /// bezpieczeństwa w PWA (`img[src]`), tu ten sam zbiór akceptacji co dekoder TS.
  static func isImageDataURL(_ value: String) -> Bool {
    let utf8 = value.utf8
    guard utf8.count <= maxImageDataURLBytes else { return false }
    for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,"] where value.hasPrefix(prefix) {
      return isBase64Body(utf8.dropFirst(prefix.utf8.count))
    }
    return false
  }

  /// `UPLOAD_IMAGE_FILE_PATTERN` = `^\d+-[0-9a-f]{16}\.(?:png|jpg)$`.
  static func isUploadImageFile(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard let dash = bytes.firstIndex(of: UInt8(ascii: "-")), dash > 0,
      bytes[..<dash].allSatisfy(isDigit)
    else { return false }
    let rest = bytes[(dash + 1)...]
    // 16 znaków hex + `.png` albo `.jpg` (oba rozszerzenia mają cztery znaki).
    guard rest.count == 16 + 4 else { return false }
    let hex = rest.prefix(16)
    let ext = String(decoding: rest.dropFirst(16), as: UTF8.self)
    return hex.allSatisfy(isLowerHex) && (ext == ".png" || ext == ".jpg")
  }

  /// `TERM_ID_RE` = `^[0-9a-f]{16}$` — id terminala, które wchodzi do ścieżki gniazda WS.
  static func isTerminalId(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return bytes.count == 16 && bytes.allSatisfy(isLowerHex)
  }

  /// `[A-Za-z0-9+/]+={0,2}` do końca łańcucha.
  private static func isBase64Body(_ body: Substring.UTF8View) -> Bool {
    var padding = 0
    var symbols = 0
    for byte in body {
      if byte == UInt8(ascii: "=") {
        padding += 1
        if padding > 2 { return false }
      } else if padding == 0, isBase64Symbol(byte) {
        symbols += 1
      } else {
        return false
      }
    }
    return symbols > 0
  }

  private static func isBase64Symbol(_ byte: UInt8) -> Bool {
    switch byte {
    case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
      UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "+"), UInt8(ascii: "/"):
      true
    default: false
    }
  }

  private static func isDigit(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
  }

  private static func isLowerHex(_ byte: UInt8) -> Bool {
    isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
  }
}
