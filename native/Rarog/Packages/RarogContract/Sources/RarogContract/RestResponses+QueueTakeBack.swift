// REST response of the queue take-back: a mirror of `queueTakeBackResponseSchema` in `shared/src/rest.ts`
// (`POST /api/sessions/:id/queue/take-back`). The same tolerance as the rest of REST: unknown keys are dropped, `null`
// in an optional field and a wrong type reject the response.
// Owner: send.

/// One prompt that left the queues. `clientMessageId` marks a message from this app whose echo the server held; a
/// prompt typed at the Mac and a message pasted onto a draft at the desk come without it.
public struct QueueTakeBackItem: Sendable, Equatable, Decodable {
  public var text: String
  public var clientMessageId: String?

  enum CodingKeys: String, CodingKey { case text, clientMessageId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    text = try c.required(.text)
    clientMessageId = try c.optional(.clientMessageId)
  }
}

/// `POST /api/sessions/<id>/queue/take-back` (200): the prompts in queue order (the CLI queue first, then the
/// server's own), one per item; an empty list means nothing was queued. `incomplete`: part of the CLI queue stayed with
/// Claude Code.
public struct QueueTakeBackResponse: Sendable, Equatable, Decodable {
  public var items: [QueueTakeBackItem]
  public var incomplete: Bool

  enum CodingKeys: String, CodingKey { case items, incomplete }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    items = try c.required(.items)
    // `incomplete` is the literal `true` or absent: `false` does not exist on the wire.
    let flag: Bool? = try c.optional(.incomplete)
    if flag == false {
      throw contractViolation(c.codingPath + [CodingKeys.incomplete], "incomplete is the literal true")
    }
    incomplete = flag == true
  }
}
