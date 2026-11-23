// Kopia starego dekodera `APIErrorBody` (`RestResponses.swift`). Zasady kopii i typy wspólne: `LegacyContract.swift`.
@testable import RarogContract

extension OldApp {
  /// Ciało odmowy REST w kształcie starej apki: kod, zdanie i powód; pole `messageRef` jest dla niego nieznane.
  struct APIErrorBody: Sendable, Equatable, Decodable {
    var error: String
    var message: String?
    var reason: String?

    enum CodingKeys: String, CodingKey { case error, message, reason }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      error = try c.required(.error)
      message = try c.optionalOrNull(.message)
      reason = try c.optionalOrNull(.reason)
    }
  }
}
