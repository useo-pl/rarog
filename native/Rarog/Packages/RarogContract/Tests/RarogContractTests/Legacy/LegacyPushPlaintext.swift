// Kopia starego dekodera `PushPlaintext` (`Push/PushEnvelope.swift`). Zasady kopii i typy wspólne: `LegacyContract.swift`.
@testable import RarogContract

extension OldApp {
  /// Tekst jawny banera w kształcie starej apki. Pola `titleRef` i `bodyRef` są dla niego nieznane.
  struct PushPlaintext: Sendable, Equatable, Decodable {
    static let maxFieldBytes = PushCrypto.plaintextMaxBytes

    var kind: ApnsPushKind?
    var title: String?
    var body: String?
    var sessionId: String?
    var termId: String?
    var exp: Int

    enum CodingKeys: String, CodingKey {
      case kind, title, body, sessionId, termId, exp
    }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      let rawKind: String = try c.required(.kind)
      kind = ApnsPushKind.wire(rawKind)
      title = try Self.capped(c, .title)
      body = try Self.capped(c, .body)
      if c.contains(.sessionId) {
        let session = try c.nonEmpty(.sessionId)
        guard session.utf8.count <= Self.maxFieldBytes else {
          throw contractViolation(c.codingPath + [CodingKeys.sessionId], "sessionId ponad sufit")
        }
        sessionId = session
      }
      termId = try c.optional(.termId)
      if let termId, !WireFormat.isTerminalId(termId) {
        throw contractViolation(c.codingPath + [CodingKeys.termId], "termId spoza TERM_ID_RE")
      }
      exp = try c.required(.exp)
    }

    private static func capped(_ c: ContractContainer<CodingKeys>, _ key: CodingKeys) throws -> String? {
      let value: String? = try c.optional(key)
      if let value, value.utf8.count > maxFieldBytes {
        throw contractViolation(c.codingPath + [key], "pole ponad sufit")
      }
      return value
    }
  }
}
