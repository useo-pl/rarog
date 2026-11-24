// Body of `POST /api/inbox/:sessionId/remove` and `/restore`, a mirror of `inboxActionBodySchema` in
// `shared/src/rest.ts`. Golden body: `shared/fixtures/requests/inbox.action.json`. Owner: Inbox (native app).

/// The card the device acts on: the turn and the version from its head. Another turn or version on the server is a
/// 409 `inbox-card-changed` without effect.
public struct InboxActionBody: Sendable, Equatable, Encodable {
  public var turnId: String
  public var version: String

  public init(turnId: String, version: String) {
    self.turnId = turnId
    self.version = version
  }
}
