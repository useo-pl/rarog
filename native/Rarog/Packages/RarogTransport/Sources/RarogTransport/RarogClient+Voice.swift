import Foundation
import RarogContract

// Klucz tymczasowy dyktowania. Właściciel: dyktowanie.
extension RarogClient {
  /// `POST /api/voice/token` z pustym ciałem → klucz TYMCZASOWY Soniox i konfiguracja strumienia.
  ///
  /// Mutacja, więc idzie przez `MutationGate` (zgodność) z `Origin`. Każde dyktowanie i każda
  /// ponowna próba połączenia pobiera NOWY klucz (`single_use`); klucza nie pobiera się na zapas.
  /// Odmowy przychodzą typowane: 404 (starszy serwer bez endpointu) i 503 (`voice_unconfigured`)
  /// jako `.http`, 429 jako `.rateLimited`, 502 (`voice_upstream`) jako `.http` ze zdaniem serwera.
  ///
  /// Błąd dekodowania mówi tylko, KTÓRE pole jest złe — nigdy wartość: w ciele jedzie klucz.
  public func voiceToken() async throws(TransportError) -> VoiceToken {
    let path = "/api/voice/token"
    let response = try await perform(.post(path, json: EmptyBody()))
    do {
      return try JSONDecoder().decode(VoiceToken.self, from: response.body)
    } catch let error as DecodingError {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu (\(Self.voiceField(error)))")
    } catch {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu")
    }
  }

  /// Ścieżka pola z błędu dekodowania, bez wartości i bez opisu, który mógłby ją zacytować.
  private static func voiceField(_ error: DecodingError) -> String {
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
