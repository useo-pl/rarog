// Inbox cards with their text: `GET /api/inbox`, `GET /api/inbox/:sessionId` and the answer of
// `POST /api/inbox/:sessionId/remove|restore`, a mirror of `inboxListSchema`, `inboxCardResponseSchema` and
// `inboxActionResponseSchema` in `shared/src/rest.ts`. Golden responses: `inbox.*.json` and `error.inbox-*.json` in
// `shared/fixtures/rest/`. Owner: Inbox (native app).

/// The decision a `decision` card waits for, as the session summary carries it. `requestId` is the `permId` or `qId`
/// of the pending card in the session stream, which brings the card itself. A dialog in the pane without a card names
/// the recognised dialog and why it has no buttons.
public enum InboxCardDialog: Sendable, Equatable, Decodable {
  case permission(waitingFor: WaitingFor?, requestId: String?)
  case question(waitingFor: WaitingFor?, requestId: String?)
  case panel(herdrDialog: KnownDialogID?, herdrDialogReason: RefuseReason?)

  public var kind: InboxDialogKind {
    switch self {
    case .permission: .permission
    case .question: .question
    case .panel: .panel
    }
  }

  enum CodingKeys: String, CodingKey { case kind, waitingFor, requestId, herdrDialog, herdrDialogReason }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let kind: InboxDialogKind = try c.strict(.kind)
    switch kind {
    case .permission:
      self = .permission(waitingFor: try c.optional(.waitingFor), requestId: try Self.requestId(c))
    case .question:
      self = .question(waitingFor: try c.optional(.waitingFor), requestId: try Self.requestId(c))
    case .panel:
      self = .panel(
        herdrDialog: try c.strictOptional(.herdrDialog), herdrDialogReason: try c.strictOptional(.herdrDialogReason))
    }
  }

  private static func requestId(_ c: ContractContainer<CodingKeys>) throws -> String? {
    let value: String? = try c.optional(.requestId)
    if value?.isEmpty == true { throw contractViolation(c.codingPath + [CodingKeys.requestId], "empty requestId") }
    return value
  }
}

/// One visible card: the fields of its head (``InboxHead``) with the whole dialog instead of its kind, plus `text`,
/// the last message of the agent's turn, and `truncated` when that text lost its start to the server's ceiling.
public struct InboxCard: Sendable, Equatable, Decodable {
  public var sessionId: String
  public var turnId: String
  public var version: String
  public var kind: InboxCardKind
  public var state: SessionState
  public var at: String
  public var text: String
  public var truncated: Bool
  /// `decision` cards only.
  public var dialog: InboxCardDialog?

  enum CodingKeys: String, CodingKey { case sessionId, turnId, version, kind, state, at, text, truncated, dialog }
  private enum DialogKeys: String, CodingKey { case kind }

  /// `nil` = the card has an unknown `kind`, `state` or dialog kind and drops out of the list. Every other field of
  /// the card is checked first, so a broken card still rejects the response; the dialog of an unknown kind is not
  /// checked further, because its shape is unknown.
  static func decodeTolerant(from decoder: any Decoder) throws -> InboxCard? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    _ = try c.nonEmpty(.sessionId)
    _ = try c.nonEmpty(.turnId)
    _ = try c.nonEmpty(.version)
    let _: String = try c.required(.at)
    let _: String = try c.required(.text)
    let _: Bool = try c.required(.truncated)
    var readable = [try c.known(.kind, as: InboxCardKind.self), try c.known(.state, as: SessionState.self)]
    if c.contains(.dialog) {
      if try c.base.decodeNil(forKey: .dialog) {
        throw contractViolation(c.codingPath + [CodingKeys.dialog], "null instead of the dialog object")
      }
      let dialog = try ContractContainer(c.base.superDecoder(forKey: .dialog), keyedBy: DialogKeys.self)
      readable.append(try dialog.known(.kind, as: InboxDialogKind.self))
    }
    guard readable.allSatisfy({ $0 }) else { return nil }
    return try InboxCard(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.nonEmpty(.sessionId)
    turnId = try c.nonEmpty(.turnId)
    version = try c.nonEmpty(.version)
    kind = try c.strict(.kind)
    state = try c.strict(.state)
    at = try c.required(.at)
    text = try c.required(.text)
    truncated = try c.required(.truncated)
    dialog = try c.optional(.dialog)
  }
}

/// 200 of `GET /api/inbox`: every visible card, newest first. A card the app cannot read drops out and the other
/// cards stay, as in `inbox-heads`.
public struct InboxList: Sendable, Equatable, Decodable {
  public var cards: [InboxCard]

  enum CodingKeys: String, CodingKey { case cards }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    var items = try c.base.nestedUnkeyedContainer(forKey: .cards)
    var out: [InboxCard] = []
    while !items.isAtEnd {
      if let card = try InboxCard.decodeTolerant(from: items.superDecoder()) { out.append(card) }
    }
    cards = out
  }
}

/// 200 of `GET /api/inbox/:sessionId`: the session's visible card; `nil` = the session has none now.
public struct InboxCardResponse: Sendable, Equatable, Decodable {
  public var card: InboxCard?

  enum CodingKeys: String, CodingKey { case card }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    card = try c.optional(.card)
  }
}

/// `receipt` of a remove or restore answer.
public enum InboxReceipt: String, ContractEnum {
  /// The card is removed (restored), but the receipt of its result was neither given nor taken back.
  case skipped
}

/// 200 of remove and restore. `changed == false`: the card already was removed (restored), nothing happened again.
public struct InboxActionResponse: Sendable, Equatable, Decodable {
  public var changed: Bool
  public var receipt: InboxReceipt?

  enum CodingKeys: String, CodingKey { case ok, changed, receipt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let ok: Bool = try c.required(.ok)
    guard ok else { throw contractViolation(c.codingPath + [CodingKeys.ok], "ok must be true") }
    changed = try c.required(.changed)
    receipt = try c.strictOptional(.receipt)
  }
}
