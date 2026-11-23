import Foundation
import RarogContract

// Klucz krótki OpenAI agenta głosowego. Właściciel: agent głosowy.
// The temporary Soniox speech key of the voice agent's voice goes the same way.
extension RarogClient {
  /// `POST /api/companion/token` z pustym ciałem → klucz KRÓTKI OpenAI Realtime, jego ważność i model z serwera.
  ///
  /// Mutacja, więc idzie przez `MutationGate` (zgodność) z `Origin`. Każda rozmowa i każde ponowne połączenie pobiera
  /// NOWY klucz; klucza nie pobiera się na zapas. Odmowy przychodzą typowane: 404 (starszy serwer albo demo) i 503
  /// (`companion-disabled`, `companion-openai-key`) jako `.http`, 429 (`companion-throttled`,
  /// `companion-openai-limit`) jako `.rateLimited`, 502 (`companion-openai`) jako `.http` ze zdaniem serwera.
  ///
  /// Błąd dekodowania mówi tylko, KTÓRE pole jest złe — nigdy wartość: w ciele jedzie klucz.
  public func companionToken() async throws(TransportError) -> CompanionToken {
    try await companionKey(CompanionToken.self, path: "/api/companion/token")
  }

  /// `POST /api/companion/speech-token` with an empty body → a temporary Soniox text-to-speech key for the voice
  /// agent's voice, with the EU WebSocket address, model, voice and sample rate from the server.
  ///
  /// A mutation, so it goes through `MutationGate` (compatibility) with `Origin`. One key per conversation, never
  /// ahead of it. Refusals come typed: 404 (older server or demo), 503 (`companion-speech-unconfigured`) and 502
  /// (`companion-speech-upstream`) as `.http`, 429 (`companion-speech-throttled`) as `.rateLimited`.
  ///
  /// A decoding error names only the bad field, never a value: the body carries the key.
  public func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken {
    try await companionKey(CompanionSpeechToken.self, path: "/api/companion/speech-token")
  }

  /// A key route with an empty body; the decoding error names the field without its value.
  private func companionKey<Key: Decodable>(_ type: Key.Type, path: String) async throws(TransportError) -> Key {
    let response = try await perform(.post(path, json: EmptyBody()))
    do {
      return try JSONDecoder().decode(type, from: response.body)
    } catch let error as DecodingError {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu (\(Self.companionField(error)))")
    } catch {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu")
    }
  }

  /// Limit pytania o sesję: serwer daje Sonnetowi 60 s (`claude -p`), więc domyślne 10 s ucięłoby odpowiedź.
  public static let companionAskTimeout: Duration = .seconds(75)

  /// `POST /api/sessions/<id>/companion/ask` z pytaniem i `clientRequestId` → odpowiedź do przeczytania na głos.
  ///
  /// Mutacja (bramka zgodności i bramka sesji). Odmowy typowane jak wszędzie: 429 (`companion-busy`,
  /// `companion-limit`) jako `.rateLimited`, 503 (`companion-disabled`, `companion-cli`) i 504 (`companion-timeout`)
  /// jako `.http` ze zdaniem serwera. Odpowiedź zamknięta bez treści (nowa rozmowa silnika, `/clear`) przychodzi
  /// jako błąd sieci albo odpowiedź spoza kontraktu.
  public func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer {
    let path = "/api/sessions/\(Self.segment(sessionId))/companion/ask"
    let response = try await perform(.post(path, json: body, timeout: Self.companionAskTimeout))
    return try decode(CompanionAnswer.self, from: response.body, path: path)
  }

  /// Ścieżka pola z błędu dekodowania, bez wartości i bez opisu, który mógłby ją zacytować.
  private static func companionField(_ error: DecodingError) -> String {
    let path: [any CodingKey] =
      switch error {
      case let .typeMismatch(_, context), let .valueNotFound(_, context), let .dataCorrupted(context):
        context.codingPath
      case let .keyNotFound(key, context):
        context.codingPath + [key]
      @unknown default:
        []
      }
    let pointer = path.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: "/")
    return pointer.isEmpty ? "kształt" : "pole /\(pointer)"
  }
}
