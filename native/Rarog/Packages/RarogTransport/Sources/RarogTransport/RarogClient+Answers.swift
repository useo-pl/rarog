import Foundation
import RarogContract

// Odpowiedź na kartę pytania. Mutacja idzie przez `perform`, czyli przez
// `MutationGate` (zgodność i bramka sesji `unsupported`). Właściciel: karty pytań.
extension RarogClient {
  /// `POST /api/sessions/<id>/answers/<qId>` → 200 `{ok: true}`. Odpowiedź przychodzi bez treści,
  /// której apka potrzebuje (rozstrzygnięcie jedzie po SSE), więc ciała nie dekodujemy — sukces
  /// nie może zamienić się w porażkę przez nowe pole odpowiedzi. 409 `conflict` = odpowiedź padła
  /// na innym urządzeniu, 410 = pytania już nie ma, 422/409 `bad-state`/400 = odmowa ze zdaniem
  /// serwera — wszystkie jako `.http` z kodem.
  public func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/answers/\(Self.segment(qId))"
    _ = try await perform(.post(path, json: body))
  }
}
