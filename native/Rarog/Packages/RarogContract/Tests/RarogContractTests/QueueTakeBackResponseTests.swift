// The queue take-back response: the golden files `queue.take-back*.json` and the reading rules of
// `queueTakeBackResponseSchema` (`incomplete` only as the literal `true`, `null` in an optional field rejects).
// Owner: send.
import Foundation
import RarogContract
import Testing

@Suite("REST contract: queue take-back")
struct QueueTakeBackResponseTests {
  private func decode(_ json: String) throws -> QueueTakeBackResponse {
    try JSONDecoder().decode(QueueTakeBackResponse.self, from: Data(json.utf8))
  }

  @Test("golden files: a held message carries its id, a Mac prompt none; `incomplete` only when part stayed")
  func goldenFiles() throws {
    let whole = try RestFixturesTests.decode(QueueTakeBackResponse.self, "queue.take-back.json")
    #expect(whole.items.count == 2 && !whole.incomplete)
    #expect(whole.items.first?.clientMessageId?.isEmpty == false)
    #expect(whole.items.last?.clientMessageId == nil)
    let partial = try RestFixturesTests.decode(QueueTakeBackResponse.self, "queue.take-back.incomplete.json")
    #expect(partial.incomplete && !partial.items.isEmpty)
    #expect(partial.items.allSatisfy { $0.clientMessageId == nil })
  }

  @Test("an empty list is nothing queued; an empty text and unknown keys pass")
  func tolerated() throws {
    let empty = try decode(#"{"items":[]}"#)
    #expect(empty.items.isEmpty && !empty.incomplete)
    let item = try #require(try decode(#"{"items":[{"text":"","later":1}],"later":true}"#).items.first)
    #expect(item.text.isEmpty && item.clientMessageId == nil)
  }

  @Test("`incomplete: false`, `null` in an optional field, a missing or null list and a wrong type reject")
  func rejects() {
    for broken in [
      #"{"items":[],"incomplete":false}"#,
      #"{"items":[],"incomplete":null}"#,
      #"{"items":[{"text":"a","clientMessageId":null}]}"#,
      #"{"items":[{"clientMessageId":"c"}]}"#,
      #"{"items":[{"text":1}]}"#,
      #"{"items":null}"#,
      #"{}"#,
    ] {
      #expect(throws: DecodingError.self, "\(broken)") { try decode(broken) }
    }
  }
}
