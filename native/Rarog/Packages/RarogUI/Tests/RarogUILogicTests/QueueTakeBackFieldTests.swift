import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The field after a queue take-back: texts one per line before the draft, the cursor in UTF-16 units, and the sentence
// under the field for each outcome. The gestures on the real screen: `RarogUIKitTests` (`QueueTakeBackUIKitTests`).
// Owner: send.

@Suite("queue take-back: field text, cursor and sentence")
struct QueueTakeBackFieldTests {
  private func items(_ pairs: [(String, String?)]) throws -> [QueueTakeBackItem] {
    let list = try pairs.map { text, id in
      let encoded = String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
      return id.map { #"{"text":\#(encoded),"clientMessageId":"\#($0)"}"# } ?? #"{"text":\#(encoded)}"#
    }
    let json = #"{"items":[\#(list.joined(separator: ","))]}"#
    return try JSONDecoder().decode(QueueTakeBackResponse.self, from: Data(json.utf8)).items
  }

  @Test("[A, B] and the draft s give A, B, s on three lines; Up puts the cursor at the end of the field")
  func beforeDraft() throws {
    let result = QueueTakeBackField.merge(try items([("A", "a"), ("B", "b")]), into: "s", tapped: nil)
    #expect(result == .init(text: "A\nB\ns", cursor: 5))
    let empty = QueueTakeBackField.merge(try items([("A", "a"), ("B", "b")]), into: "", tapped: nil)
    #expect(empty == .init(text: "A\nB", cursor: 3), "an empty field gets no trailing line")
  }

  @Test("a tap on A puts the cursor right after A; a bubble without a match puts it at the end")
  func tapped() throws {
    let list = try items([("A", "a"), ("B", "b")])
    #expect(QueueTakeBackField.merge(list, into: "s", tapped: "a").cursor == 1)
    #expect(QueueTakeBackField.merge(list, into: "s", tapped: "b").cursor == 3)
    #expect(QueueTakeBackField.merge(list, into: "s", tapped: "gone").cursor == 5)
  }

  @Test("emoji and several lines: the cursor counts UTF-16 units and lands after the tapped text")
  func emojiAndLines() throws {
    let first = "Fix 👩‍💻 the parser\nthen the 🧪 tests"
    let list = try items([(first, "a"), ("Typed at the Mac", nil), ("Last 🚀", "c")])
    let result = QueueTakeBackField.merge(list, into: "draft ✏️", tapped: "a")
    let text = result.text as NSString
    #expect(text.substring(to: result.cursor) == first)
    #expect(text.substring(from: result.cursor).hasPrefix("\nTyped at the Mac"))
    let last = QueueTakeBackField.merge(list, into: "draft ✏️", tapped: "c")
    #expect(text.substring(to: last.cursor).hasSuffix("Last 🚀"))
    #expect(text.substring(from: last.cursor) == "\ndraft ✏️")
  }

  @Test("nothing taken leaves the field as it was")
  func nothingTaken() {
    #expect(QueueTakeBackField.merge([], into: "s", tapped: "a") == .init(text: "s", cursor: 1))
  }

  @Test("sentence: incomplete is a note; a refusal, 404, no answer and a refused draft are errors with their sentence")
  func sentence() throws {
    let taken = try JSONDecoder().decode(QueueTakeBackResponse.self, from: Data(#"{"items":[]}"#.utf8))
    let partial = try JSONDecoder().decode(QueueTakeBackResponse.self, from: Data(#"{"items":[],"incomplete":true}"#.utf8))
    #expect(UICopy.queueTakeBackResult(.taken(taken)) == nil)
    let note = try #require(UICopy.queueTakeBackResult(.taken(partial)))
    #expect(!note.isError && !note.text.isEmpty)
    #expect(UICopy.queueTakeBackResult(.refused("Server sentence.")).map { $0 == ("Server sentence.", true) } == true)
    #expect(UICopy.queueTakeBackResult(.refused(nil))?.isError == true)
    #expect(UICopy.queueTakeBackResult(.serverTooOld).map { $0 == (CoreCopy.updateServer, true) } == true)
    #expect(UICopy.queueTakeBackResult(.unsure).map { $0 == (CoreCopy.noConnection, true) } == true)
    let notSaved = try #require(UICopy.queueTakeBackResult(.notSaved))
    #expect(notSaved.isError && !notSaved.text.isEmpty)
    #expect(UICopy.queueTakeBackResult(.inFlight) == nil)
    #expect(UICopy.queueTakeBackResult(.loggedOut) == nil)
  }
}
