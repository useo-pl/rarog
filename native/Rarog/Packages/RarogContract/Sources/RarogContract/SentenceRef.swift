import Foundation

// Kod zdania serwera — lustro `sentenceRefSchema` z `shared/src/sentences/index.ts`. Serwer wysyła gotowy
// angielski tekst i obok niego `ref`; apka tłumaczy znany kod według swojego katalogu, a nieznany pokazuje tekst.
// Pola `*Ref` w typach kontraktu czyta `ContractContainer.optional`: brak = `nil`, `null` i zły typ odrzucają.

/// `{ code, args? }`: kod zdania i jego argumenty, na drucie zawsze łańcuchy, w kolejności z rejestru.
public struct SentenceRef: Sendable, Hashable, Codable {
  /// Najwięcej argumentów jednego zdania — `MAX_SENTENCE_ARGS` rejestru.
  public static let maxArgs = 8

  /// Kod `<obszar>.<nazwa>`, niepusty.
  public var code: String
  /// Argumenty; brak pola na drucie = pusta lista.
  public var args: [String]

  enum CodingKeys: String, CodingKey { case code, args }

  public init(code: String, args: [String] = []) {
    self.code = code
    self.args = args
  }

  /// Uszkodzony `ref` (pusty `code`, `args` = `null`, ponad ``maxArgs`` argumentów, argument nie-łańcuch)
  /// odrzuca cały obiekt, tak jak zod po stronie serwera. Nieznany klucz obok `code` jest pomijany.
  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    code = try c.nonEmpty(.code)
    let args: [String] = try c.optional(.args) ?? []
    guard args.count <= Self.maxArgs else {
      throw contractViolation(c.codingPath + [CodingKeys.args], "ponad \(Self.maxArgs) argumentów zdania")
    }
    self.args = args
  }

  /// Puste `args` nie wychodzi (jak `say()` po stronie serwera), więc round-trip złotych plików jest dosłowny.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(code, forKey: .code)
    if !args.isEmpty { try c.encode(args, forKey: .args) }
  }
}
