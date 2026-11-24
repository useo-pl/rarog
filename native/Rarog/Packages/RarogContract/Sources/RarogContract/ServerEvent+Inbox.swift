// Inbox heads on the global stream: `inbox-heads`, `inbox-head` and `inbox-removed`, a mirror of
// `shared/src/protocol/inbox.ts`. A stream gets them only when it opens with `inbox=1`; the card text comes from
// `GET /api/inbox` (`RestResponses+Inbox.swift`). Golden frames: `inbox-*.json` in `shared/fixtures/sse/`.
// Owner: Inbox (native app).

/// `INBOX_CARD_KINDS`: the turn ended with a result, waits for a person, or stopped.
public enum InboxCardKind: String, ContractEnum {
  case result, decision, failed
}

/// `INBOX_DIALOG_KINDS`: what a `decision` card waits for.
public enum InboxDialogKind: String, ContractEnum {
  case permission, question, panel
}

/// The head of one visible card, without its text. `turnId` and `version` are opaque: a new `version` means new
/// text to fetch, and remove and restore send both back. A head with an unknown `kind`, `state` or `dialog` drops out
/// of `inbox-heads` (``decodeTolerant(from:)``) and ignores a single `inbox-head` frame whole; the next head or
/// `GET /api/inbox` mends it.
public struct InboxHead: Sendable, Equatable, Codable {
  public var sessionId: String
  public var turnId: String
  public var version: String
  public var kind: InboxCardKind
  /// The session state when the card was read; the app hides the card in `starting` and `running`.
  public var state: SessionState
  /// Orders the cards, newest first.
  public var at: String
  /// `decision` cards only.
  public var dialog: InboxDialogKind?

  enum CodingKeys: String, CodingKey { case sessionId, turnId, version, kind, state, at, dialog }

  /// `nil` = the head has an unknown `kind`, `state` or `dialog` (each recorded as a degradation `inbox.head`) and
  /// drops out of the list. Every other field is checked first, so a broken head still rejects the frame, as in
  /// `shared/src/decode.ts`.
  static func decodeTolerant(from decoder: any Decoder) throws -> InboxHead? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    _ = try c.nonEmpty(.sessionId)
    _ = try c.nonEmpty(.turnId)
    _ = try c.nonEmpty(.version)
    let _: String = try c.required(.at)
    let readable = [
      try c.known(.kind, as: InboxCardKind.self),
      try c.known(.state, as: SessionState.self),
      try c.knownOptional(.dialog, as: InboxDialogKind.self),
    ]
    guard readable.allSatisfy({ $0 }) else { return nil }
    return try InboxHead(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.nonEmpty(.sessionId)
    turnId = try c.nonEmpty(.turnId)
    version = try c.nonEmpty(.version)
    kind = try c.strict(.kind)
    state = try c.strict(.state)
    at = try c.required(.at)
    dialog = try c.strictOptional(.dialog)
  }
}

/// Every visible card, newest first, once per stream right after `sessions-snapshot`. A head the app cannot read
/// drops out and the other heads stay, so a card kind added later does not empty the Inbox of this app.
public struct InboxHeadsEvent: Sendable, Equatable, Codable {
  public var heads: [InboxHead]

  enum CodingKeys: String, CodingKey { case heads }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    var items = try c.base.nestedUnkeyedContainer(forKey: .heads)
    var out: [InboxHead] = []
    while !items.isAtEnd {
      if let head = try InboxHead.decodeTolerant(from: items.superDecoder()) { out.append(head) }
    }
    heads = out
  }
}

/// A card that became visible or whose head changed.
public struct InboxHeadEvent: Sendable, Equatable, Codable {
  public var head: InboxHead

  enum CodingKeys: String, CodingKey { case head }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    head = try c.required(.head)
  }
}

/// The card of this turn left the visible cards: removed on a device, the session closed, or its conversation
/// changed.
public struct InboxRemovedEvent: Sendable, Equatable, Codable {
  public var sessionId: String
  public var turnId: String

  enum CodingKeys: String, CodingKey { case sessionId, turnId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.nonEmpty(.sessionId)
    turnId = try c.nonEmpty(.turnId)
  }
}
