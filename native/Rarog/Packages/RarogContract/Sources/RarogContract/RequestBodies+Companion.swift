import Foundation

// Agent głosowy — ciało `POST /api/sessions/:id/companion/ask`, lustro `companionAskBodySchema` z
// `shared/src/rest.ts`. Złote ciało: `shared/fixtures/requests/companion.ask.json`.

/// Pytanie o sesję. Serwer pyta o rozmowę silnika, którą sesja pisze w chwili przyjęcia żądania; apka jej nie podaje.
/// Nowa rozmowa w trakcie (`/clear`, `/resume`) zamyka odpowiedź bez treści, a spóźniony wynik odrzuca generacja
/// rozmowy głosowej w apce. `clientRequestId` to UUID pytania, tylko do logu serwera.
public struct CompanionAskBody: Sendable, Equatable, Encodable {
  /// `COMPANION_QUESTION_MAX_CHARS`: sufit pytania w jednostkach UTF-16 (zod liczy `string.length`).
  public static let maxQuestionUnits = 2000

  public var question: String
  public var clientRequestId: String

  public init(question: String, clientRequestId: String) {
    self.question = question
    self.clientRequestId = clientRequestId
  }
}
