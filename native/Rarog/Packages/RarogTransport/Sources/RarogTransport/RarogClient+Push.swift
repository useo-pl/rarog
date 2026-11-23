import Foundation
import RarogContract

// Powiadomienia APNs i Live Activity apki natywnej. Właściciel: push; trasy Live
// Activity woła `RarogStore+LiveActivity`. Każda trasa to POST przez `perform`, więc idzie przez `MutationGate` (zgodność)
// z `Origin` i kluczem urządzenia. Token urządzenia to adres do wysyłki: jedzie WYŁĄCZNIE
// w ciele (status też POST-em — logi Caddy notują zapytanie) i nie trafia do opisu żadnego błędu.
extension RarogClient {
  /// `POST /api/push/apns` → 204: upsert tokenu urządzenia (przy starcie, logowaniu i powrocie z tła).
  ///
  /// Etykietę bierze z konfiguracji (`clientLabel`, np. `iPad·Rarog`) — ta sama co przy parowaniu. `topic` = bundle id apki (temat APNs wpisu; inny niż serwera → 400 `topic-mismatch`).
  /// `alerts` = zgoda systemowa na powiadomienia; `test` prosi o push próbny (dławik serwera: 429 jako
  /// `.rateLimited`, rejestracja i tak się zapisała). Każda rejestracja deklaruje formaty banera, które apka czyta
  /// (`pushFormats: [3]`): od niej serwer daje wpisowi baner formatu 3 z treścią szyfrowaną. Ciało
  /// deklaruje też klucze lokalizacji pushy (`locKeys: true`, wartość domyślna `ApnsRegisterBody`): tekst zastępczy
  /// banera i dzwonek kafla przychodzą wtedy kluczami katalogu apki.
  public func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError) {
    let body = ApnsRegisterBody(
      token: token, environment: environment, label: config.clientLabel, alerts: alerts, test: test ? true : nil,
      topic: topic, pushFormats: ApnsRegisterBody.supportedPushFormats)
    _ = try await perform(.post("/api/push/apns", json: body))
  }

  /// `POST /api/push/apns/unregister` → 204, idempotentnie (także nieznany token).
  public func unregisterApns(token: String) async throws(TransportError) {
    _ = try await perform(.post("/api/push/apns/unregister", json: ApnsTokenBody(token: token)))
  }

  /// `POST /api/push/apns/status` → stan kanału dla tego tokenu (baner degradacji).
  public func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus {
    let path = "/api/push/apns/status"
    let response = try await perform(.post(path, json: ApnsTokenBody(token: token)))
    do {
      return try JSONDecoder().decode(ApnsStatus.self, from: response.body)
    } catch {
      // Bez opisu dekodera: w odpowiedzi nie ma tokenu, ale zasada jest jedna — żadnej wartości w logu.
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu")
    }
  }

  /// `POST /api/push/live-activity` → 204: token aktualizacji aktywności przypięty do urządzenia.
  public func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError) {
    _ = try await perform(.post("/api/push/live-activity", json: body))
  }

  /// `POST /api/push/live-activity/end` → 204; serwer ignoruje `activityId`, który nie pasuje.
  public func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError) {
    _ = try await perform(.post("/api/push/live-activity/end", json: body))
  }
}
