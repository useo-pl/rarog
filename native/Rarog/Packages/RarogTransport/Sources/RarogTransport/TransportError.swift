import Foundation
import RarogContract

/// Odpowiedź serwera inna niż 2xx — status i ciało błędu `{ error, message, reason? }`.
public struct APIFailure: Sendable, Equatable {
  public let status: Int
  /// Kod z pola `error` (`bad-token`, `bad-origin`, `refused`, `conflict`…) albo `nil`, gdy ciało
  /// nie było JSON-em API (np. 403 z Caddy poza tailnetem).
  public let code: String?
  /// Zdanie serwera do pokazania wprost: z kodem zdania (`messageRef`) przetłumaczone rendererem
  /// klienta na język apki, bez kodu — tekst serwera.
  public let message: String?
  /// Powód odmowy decyzji (422), łańcuch z `REFUSE_REASONS`.
  public let reason: String?
  /// `Retry-After` w sekundach (429 przy logowaniu).
  public let retryAfter: Int?
  /// The code of the server's sentence (`messageRef.code`, e.g. `session.conversation-changed`): it tells apart two
  /// refusals with the same `code` (`bad-state`). `nil` = the body carried no readable sentence code.
  public let sentenceCode: String?

  public init(
    status: Int, code: String? = nil, message: String? = nil, reason: String? = nil, retryAfter: Int? = nil,
    sentenceCode: String? = nil
  ) {
    self.status = status
    self.code = code
    self.message = message
    self.reason = reason
    self.retryAfter = retryAfter
    self.sentenceCode = sentenceCode
  }
}

/// Błąd transportu — typowany, żeby apka odróżniła „odmowa klucza" od „nie ma sieci"
/// i pokazała właściwe zdanie.
public enum TransportError: Error, Sendable, Equatable {
  /// 401 — serwer nie przyjął klucza urządzenia (odpięty albo nieznany; szczegół w `credentialRejection`).
  case unauthorized(APIFailure)
  /// 403 — `bad-origin` z serwera albo Caddy poza tailnetem (wtedy `code == nil`).
  case forbidden(APIFailure)
  /// 429 — dławik serwera (np. za dużo prób parowania).
  case rateLimited(APIFailure)
  /// Każdy inny status spoza 2xx (400, 404, 409, 410, 413, 422, 5xx…).
  case http(APIFailure)
  /// Bramka klienta odmówiła, zanim żądanie wyszło.
  case refused(MutationRefusal)
  /// Brak odpowiedzi w limicie czasu.
  case timedOut
  /// Brak sieci albo serwera (Tailscale wyłączony, Mac śpi) — łączymy dalej, bez wylogowania.
  case offline(URLError.Code)
  /// Żądanie przerwane przez wołającego (anulowane zadanie) — nie awaria i nie powód do ponowienia.
  case cancelled
  /// Odpowiedź, której nie da się odczytać (nie HTTP, zły JSON, zły typ treści).
  case invalidResponse(String)
}
