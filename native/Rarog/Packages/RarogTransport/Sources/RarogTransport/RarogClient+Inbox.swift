import Foundation
import RarogContract

// Inbox card routes: the text of every visible card, the text of one card, and removing and restoring a card. The
// heads come on the global stream opened with `inbox=1` (`StreamScope.global`). Remove and restore are mutations
// through `perform`, so through `MutationGate`. Owner: Inbox (native app).
extension RarogClient {
  /// `GET /api/inbox` → 200 `{cards}`: every visible card with its text, newest first; 503 `inbox-disabled` when the
  /// server keeps no Inbox.
  public func inboxCards() async throws(TransportError) -> InboxList {
    let response = try await perform(.get("/api/inbox"))
    return try decode(InboxList.self, from: response.body, path: "/api/inbox")
  }

  /// `GET /api/inbox/<id>` → 200 `{card?}`: the session's visible card, `nil` when it has none now; 404 for an
  /// unknown session.
  public func inboxCard(sessionId: String) async throws(TransportError) -> InboxCardResponse {
    let path = "/api/inbox/\(Self.segment(sessionId))"
    let response = try await perform(.get(path))
    return try decode(InboxCardResponse.self, from: response.body, path: path)
  }

  /// `POST /api/inbox/<id>/remove` → 200 `{ok, changed, receipt?}`. 409 `inbox-card-changed` = another turn or version
  /// on the server, nothing happened; 500 = the removal was not saved and the card stays.
  public func removeInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError)
    -> InboxActionResponse
  {
    try await inboxAction("remove", sessionId: sessionId, body)
  }

  /// `POST /api/inbox/<id>/restore` with the same `{turnId, version}` as the removal; answers as remove.
  public func restoreInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError)
    -> InboxActionResponse
  {
    try await inboxAction("restore", sessionId: sessionId, body)
  }

  private func inboxAction(_ action: String, sessionId: String, _ body: InboxActionBody) async throws(TransportError)
    -> InboxActionResponse
  {
    let path = "/api/inbox/\(Self.segment(sessionId))/\(action)"
    let response = try await perform(.post(path, json: body))
    return try decode(InboxActionResponse.self, from: response.body, path: path)
  }
}
