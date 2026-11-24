import Foundation
import RarogContract

// Klucz krótki OpenAI agenta głosowego. Właściciel: agent głosowy.
// The temporary Soniox speech key of the voice agent's voice goes the same way, and so do the two reads of the mode
// across sessions: the session catalog and the last turns of one session.
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

  // MARK: Mode across sessions (read only)

  /// Most turns one read asks for: `COMPANION_TURNS_MAX` in `shared/src/rest.ts`. The least is 1.
  public static let companionTurnsMax = 3

  /// `GET /api/companion/sessions` → the voice agent's session catalog (``CompanionSessions``).
  ///
  /// A read, so no mutation gate. Refusals come typed: 404 (older server or demo), 503 `companion-disabled` (the
  /// voice agent is off) and 503 `companion-sessions-disabled` (the mode across sessions is off) as `.http`.
  public func companionSessions() async throws(TransportError) -> CompanionSessions {
    let path = "/api/companion/sessions"
    let response = try await perform(.get(path))
    return try decode(CompanionSessions.self, from: response.body, path: path)
  }

  /// `GET /api/sessions/<id>/companion/turns?count=<count>` → the last `count` turns of the session's current engine
  /// conversation (``CompanionTurns``), with the server's sentences in the messages translated.
  ///
  /// `count` outside 1…``companionTurnsMax`` is refused before the request (`.invalidResponse`), as the server would
  /// answer 400. Refusals come typed: 404 (a session outside the voice agent's catalog, with the server's sentence),
  /// 503 `companion-disabled` and `companion-sessions-disabled` as `.http`.
  public func companionTurns(sessionId: String, count: Int) async throws(TransportError) -> CompanionTurns {
    let path = "/api/sessions/\(Self.segment(sessionId))/companion/turns"
    guard (1...Self.companionTurnsMax).contains(count) else {
      throw .invalidResponse("\(path): count \(count) outside 1...\(Self.companionTurnsMax)")
    }
    let response = try await perform(.get("\(path)?count=\(count)"))
    var turns = try decode(CompanionTurns.self, from: response.body, path: path)
    // The answer is not `SentenceBearing` but carries messages, so their server sentences are translated here.
    turns.messages = turns.messages.map(translated)
    return turns
  }

  // MARK: Mode across sessions: picking up a result

  /// `POST /api/sessions/<id>/seen` with the voice agent's pick-up (``SeenBody`` with all three fields of `pickUp`)
  /// → 200 `{ok: true}`: the result the agent read is received, and the session row carries `seenBy`.
  ///
  /// A mutation, so it goes through `MutationGate` (compatibility and the session gate) with `Origin`. Refusals come
  /// typed as `.http`: 409 `bad-state` when the result is not the one read (sentence `session.seen-result-changed`),
  /// 404 for an unknown session or one outside the voice agent's catalog, 503 `companion-disabled` and
  /// `companion-sessions-disabled`. A person's receipt is ``markSeen(sessionId:)``, whose body stays `{}`.
  public func pickUpResult(sessionId: String, _ pickUp: SeenPickUp) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/seen"
    let response = try await perform(.post(path, json: SeenBody(pickUp: pickUp)))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
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
