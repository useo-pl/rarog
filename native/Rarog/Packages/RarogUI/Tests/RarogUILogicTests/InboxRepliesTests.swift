import Foundation
@testable import RarogUI
import Testing

// The reply fields of the Inbox cards: the turn a text answers, ↑ taking the text, a reply that did not go out
// coming back with its reason, and the draft a field appears with. The send on a real store: `StoreInboxTests`;
// the field on the screen: `InboxScreenTests`. Owner: Inbox.

@Suite("Inbox reply fields: text, turn and the reason a reply came back")
struct InboxRepliesTests {
  @Test("the first character records the turn the card shows; a later turn does not move it; emptying forgets it")
  func turnOfTheText() {
    var replies = InboxReplies()
    replies.edit("A", text: "S", shownTurn: "t1")
    replies.edit("A", text: "Ship", shownTurn: "t2")
    #expect(replies.field("A")?.turnId == "t1", "the text was written against the first turn")
    replies.edit("A", text: "", shownTurn: "t2")
    #expect(replies.field("A")?.turnId == nil)
    replies.edit("A", text: "Go", shownTurn: "t2")
    #expect(replies.field("A")?.turnId == "t2")
  }

  @Test("↑ takes the text with its turn and empties the field; an empty or blank field sends nothing")
  func take() throws {
    var replies = InboxReplies()
    let fromEmpty = replies.take("A")
    #expect(fromEmpty == nil)
    replies.edit("A", text: "  \n", shownTurn: "t1")
    let fromBlank = replies.take("A")
    #expect(fromBlank == nil)
    #expect(replies.field("A")?.text == "  \n", "a blank text stays in the field")
    replies.edit("A", text: "Ship it", shownTurn: "t1")
    let next = replies.take("A")
    let taken = try #require(next)
    #expect(taken.text == "Ship it" && taken.turnId == "t1")
    #expect(replies.field("A") == InboxReplyField())
  }

  @Test("a text that waited in the session's draft comes on top with its reason; an empty field takes the turn shown")
  func placeWaiting() {
    var replies = InboxReplies()
    replies.edit("A", text: "Typed", shownTurn: "t1")
    replies.placeWaiting("A", text: "Taken back", note: nil, shownTurn: "t2")
    #expect(replies.field("A") == InboxReplyField(text: "Taken back\nTyped", turnId: "t1"))
    replies.placeWaiting("A", text: "Failed", note: "Why.", shownTurn: "t2")
    #expect(
      replies.field("A")
        == InboxReplyField(text: "Failed\nTaken back\nTyped", turnId: "t1", note: "Why.", noteIsError: true))
    _ = replies.take("A")
    replies.placeWaiting("A", text: "Late", note: nil, shownTurn: "t2")
    #expect(replies.field("A") == InboxReplyField(text: "Late", turnId: "t2"), "↑ emptied the field")
  }

  @Test("a reply that did not go out comes back on top with the reason, under the turn shown now; an edit clears it")
  func giveBack() {
    var replies = InboxReplies()
    replies.edit("A", text: "Ship it", shownTurn: "t1")
    _ = replies.take("A")
    replies.edit("A", text: "and tag it", shownTurn: "t1")
    replies.giveBack("A", text: "Ship it", note: "The card changed.", isError: false, shownTurn: "t2")
    let field = replies.field("A")
    #expect(field?.text == "Ship it\nand tag it")
    #expect(field?.turnId == "t2", "the next ↑ answers the card the person now reads")
    #expect(field?.note == "The card changed." && field?.noteIsError == false)
    replies.edit("A", text: "Ship it", shownTurn: "t2")
    #expect(replies.field("A")?.note == nil)
  }

  @Test("a field appears with the session's draft under the shown turn and keeps its own text afterwards")
  func load() {
    var replies = InboxReplies()
    replies.load("A", draft: "draft text", note: "Sending failed.", shownTurn: "t1")
    #expect(replies.field("A") == InboxReplyField(text: "draft text", turnId: "t1", note: "Sending failed.", noteIsError: true))
    replies.edit("A", text: "typed", shownTurn: "t1")
    replies.load("A", draft: "other", note: nil, shownTurn: "t1")
    #expect(replies.field("A")?.text == "typed")
    replies.load("B", draft: "", note: nil, shownTurn: "t9")
    #expect(replies.field("B")?.turnId == nil, "an empty draft answers no turn yet")
    replies.forget("A")
    #expect(replies.field("A") == nil)
  }

  @Test("replies to two cards stay apart")
  func twoCards() {
    var replies = InboxReplies()
    replies.edit("A", text: "For A", shownTurn: "tA")
    replies.edit("C", text: "For C", shownTurn: "tC")
    let first = replies.take("A")
    let second = replies.take("C")
    #expect(first?.text == "For A" && first?.turnId == "tA")
    #expect(second?.text == "For C" && second?.turnId == "tC")
  }
}
