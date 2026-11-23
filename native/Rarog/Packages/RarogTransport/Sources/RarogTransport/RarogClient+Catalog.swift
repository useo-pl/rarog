import Foundation
import RarogContract

// Katalog projektów, zakładanie i zamykanie sesji. Każda mutacja idzie
// przez `perform`, czyli przez `MutationGate` (zgodność; zamknięcie także bramka sesji
// `unsupported`, bo ścieżka to `/api/sessions/<id>/close`). Właściciel: projekty i zakładki.
extension RarogClient {
  /// `GET /api/projects/recent`: directories of the last 7 days of CLI sessions and of open Rarog sessions (≤ 13).
  public func recentProjects() async throws(TransportError) -> RecentProjectList {
    let response = try await perform(.get("/api/projects/recent"))
    return try decodeCatalog(RecentProjectList.self, from: response.body, path: "/api/projects/recent")
  }

  /// `POST /api/sessions` → 202 `{sessionId, state, trustPrompt?}`. Odmowy serwera (400
  /// `cwd-not-allowed`/`model-unknown`, 409 limit paneli albo zakaz zakładania, 429 throttle)
  /// przychodzą jako `.http` z kodem i zdaniem serwera.
  public func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse {
    let response = try await perform(.post("/api/sessions", json: body))
    return try decodeCatalog(CreateSessionResponse.self, from: response.body, path: "/api/sessions")
  }

  /// `POST /api/sessions/<id>/close` → 200 `{ok: true}`. 409 (Codex, martwe gniazdo herdr,
  /// tylko do odczytu) i 404 (sesji już nie ma) jako `.http` ze zdaniem serwera.
  public func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/close"
    let response = try await perform(.post(path, json: body))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
  }

  /// Odpowiedź spoza kontraktu = `.invalidResponse` (jak w endpointach podstawowych); zdania serwera przetłumaczone.
  func decodeCatalog<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws(TransportError) -> T {
    try decode(type, from: data, path: path)
  }
}
