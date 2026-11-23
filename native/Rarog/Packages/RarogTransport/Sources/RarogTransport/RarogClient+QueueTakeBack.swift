import Foundation
import RarogContract

// The queue take-back: the prompts waiting in the CLI queue and in the server's paste queue come back to the app's
// field. A mutation through `perform`, so through `MutationGate` (compatibility and the `unsupported` session gate).
// Owner: send.
extension RarogClient {
  /// Limit of one take-back: longer than the server's worst case. The route has no limit of its own; the driver step
  /// waits up to 3 s for the `popAll` entries and up to 3 s more for a field caught half drawn, plus the settling of
  /// the last Enter and a paste ahead of it in the driver's chain.
  public static let queueTakeBackTimeout: Duration = .seconds(20)

  /// `POST /api/sessions/<id>/queue/take-back` → 200 `{items, incomplete?}`. `operationId` is the same for every
  /// retry of one take-back: the server joins a retry to the take-back in flight and answers a retry after its 200
  /// with the same body. Refusals come as 4xx with the server's sentence, before any key reached the pane; 404 means a
  /// server without the route.
  public func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    let path = "/api/sessions/\(Self.segment(sessionId))/queue/take-back"
    let body = QueueTakeBackBody(operationId: operationId.uuidString.lowercased())
    let response = try await perform(.post(path, json: body, timeout: Self.queueTakeBackTimeout))
    return try decodeCatalog(QueueTakeBackResponse.self, from: response.body, path: path)
  }
}

/// A mirror of `queueTakeBackBodySchema` in `shared/src/rest.ts`: the UUID in the lowercase form of
/// `crypto.randomUUID()`, as `clientMessageId`.
private struct QueueTakeBackBody: Encodable {
  var operationId: String
}
