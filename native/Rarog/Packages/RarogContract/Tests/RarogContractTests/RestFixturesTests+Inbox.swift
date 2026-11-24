// `GET /api/inbox` with a card this app cannot read: the card drops, the rest of the list stays. The server never
// sends an unknown kind, state or dialog kind, so the sample is the golden `inbox.list.json` with one value replaced.
// Owner: Inbox (native app).
import Foundation
import RarogContract
import Testing

extension RestFixturesTests {
  /// The golden list with `value` at `field` of card `index` (`dialog` sets the dialog's own `kind`).
  static func inboxList(card index: Int, field: String, value: Any?) throws -> Data {
    var body = try #require(try JSONSerialization.jsonObject(with: body("inbox.list.json")) as? [String: Any])
    var cards = try #require(body["cards"] as? [[String: Any]])
    if field == "dialog" {
      var dialog = try #require(cards[index]["dialog"] as? [String: Any])
      dialog["kind"] = value ?? NSNull()
      cards[index]["dialog"] = dialog
    } else if let value {
      cards[index][field] = value
    } else {
      cards[index].removeValue(forKey: field)
    }
    body["cards"] = cards
    return try JSONSerialization.data(withJSONObject: body)
  }

  @Test(
    "Inbox list: an unknown kind, state or dialog kind drops only that card",
    arguments: [("kind", "summary"), ("state", "paused"), ("dialog", "browser"), ("state", "unsupported")])
  func inboxListDropsUnreadableCard(field: String, value: String) throws {
    let golden = try Self.decode(InboxList.self, "inbox.list.json")
    #expect(golden.cards.count >= 3)
    let decoded = try JSONDecoder().decode(InboxList.self, from: Self.inboxList(card: 0, field: field, value: value))
    #expect(decoded.cards == Array(golden.cards.dropFirst()))
  }

  @Test("Inbox list: a broken card still rejects the whole list")
  func inboxListRejectsBrokenCard() throws {
    for (field, value) in [("kind", nil), ("version", ""), ("kind", 3), ("text", nil)] as [(String, Any?)] {
      let body = try Self.inboxList(card: 1, field: field, value: value)
      #expect(throws: (any Error).self, "\(field)") { _ = try JSONDecoder().decode(InboxList.self, from: body) }
    }
    // An unknown kind does not excuse a broken field next to it.
    let unknownKind = try Self.inboxList(card: 1, field: "kind", value: "summary")
    var body = try #require(try JSONSerialization.jsonObject(with: unknownKind) as? [String: Any])
    var cards = try #require(body["cards"] as? [[String: Any]])
    cards[1]["version"] = ""
    body["cards"] = cards
    let data = try JSONSerialization.data(withJSONObject: body)
    #expect(throws: (any Error).self) { _ = try JSONDecoder().decode(InboxList.self, from: data) }
  }

  @Test("Inbox card: an unknown kind in `GET /api/inbox/:id` still rejects the answer (one item, nothing to keep)")
  func inboxCardResponseStaysStrict() throws {
    var card = try #require(try JSONSerialization.jsonObject(with: Self.body("inbox.card.json")) as? [String: Any])
    var inner = try #require(card["card"] as? [String: Any])
    inner["kind"] = "summary"
    card["card"] = inner
    let data = try JSONSerialization.data(withJSONObject: card)
    #expect(throws: (any Error).self) { _ = try JSONDecoder().decode(InboxCardResponse.self, from: data) }
  }
}
