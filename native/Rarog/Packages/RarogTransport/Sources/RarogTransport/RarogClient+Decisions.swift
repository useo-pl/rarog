import Foundation
import RarogContract

// Karty decyzji i karta stanu: decyzja o dialogu stojącym w panelu i „Wznów"
// sesji bez panelu. Każda mutacja idzie przez `perform`,
// czyli przez `MutationGate` (zgodność i bramka sesji `unsupported` — ścieżki `/api/sessions/<id>/…`).
// Właściciel: karty.
extension RarogClient {
  /// `POST /api/sessions/<id>/permission` → 200 `{ok: true}`. Dialog spoza jsonl nie ma `permId`,
  /// więc adresem jest sama sesja. 409 (dialog nierozpoznany przy `allow`, tylko do odczytu),
  /// 400 (panel poza zasięgiem), 410 (dialog zniknął) i 422 (odmowa z `reason`) jako `.http`.
  public func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/permission"
    let response = try await perform(.post(path, json: body))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
  }

  /// `POST /api/sessions/<id>/resume` → 200 `{sessionId, session}`: nowy panel z tą samą rozmową.
  /// Sesja z żywym panelem albo bez zapamiętanej rozmowy silnika: 409 ze zdaniem serwera. Odpowiedź nie jest
  /// `SentenceBearing`, ale niesie sesję, więc zdania sesji tłumaczy się tu.
  public func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse {
    let path = "/api/sessions/\(Self.segment(sessionId))/resume"
    let response = try await perform(.post(path, json: EmptyBody()))
    var resumed = try decodeCatalog(ResumeResponse.self, from: response.body, path: path)
    resumed.session = translated(resumed.session)
    return resumed
  }
}
