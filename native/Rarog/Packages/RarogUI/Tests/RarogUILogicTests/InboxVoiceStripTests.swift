import Foundation
import RarogCore
@testable import RarogUI
import Testing

// What the voice strip and the prompt block of an Inbox card show (`InboxVoiceStripState`, `InboxPromptHighlight`):
// the strip's state over the conversation's indicator and the block's phase, and the read-along split of the block's
// text by characters. Owner: Inbox.

private func block(_ text: String = "Run the tests") throws -> InboxPromptBlock {
  var block: InboxPromptBlock?
  #expect(InboxPromptBlock.show(text, turnId: "t1", response: "r1", on: &block) == nil)
  return try #require(block)
}

@Suite("Inbox voice strip: the state of the strip and the read-along split of the prompt block")
struct InboxVoiceStripTests {
  @Test("the strip says the reading of the block, in the answer's tone, while the app reads it")
  func readingPrompt() throws {
    let reading = try block()
    #expect(InboxVoiceStripState.make(indicator: .answering, block: reading) == .readingPrompt)
    #expect(InboxVoiceStripState.make(indicator: .thinking, block: reading) == .readingPrompt)
    #expect(InboxVoiceStripState.readingPrompt.tone == VoiceAgentIndicator.answering.tone)
    #expect(InboxVoiceStripState.readingPrompt.motion == .output)
  }

  @Test("mute, the person's speech, the end and a block not read keep the conversation's own state")
  func ownState() throws {
    let reading = try block()
    #expect(InboxVoiceStripState.make(indicator: .muted, block: reading) == .indicator(.muted))
    #expect(InboxVoiceStripState.make(indicator: .hearing, block: reading) == .indicator(.hearing))
    #expect(InboxVoiceStripState.make(indicator: .ended(.dropped), block: reading) == .indicator(.ended(.dropped)))
    var ready = reading
    ready.readingEnded(version: ready.version, .whole)
    #expect(InboxVoiceStripState.make(indicator: .answering, block: ready) == .indicator(.answering))
    #expect(InboxVoiceStripState.make(indicator: .listening, block: nil) == .indicator(.listening))
    #expect(InboxVoiceStripState.make(indicator: nil, block: reading) == nil)
  }

  @Test(
    "the split lights the heard part and the word being said",
    arguments: [
      ("Run tests now.", 0, "", "Run", " tests now."),
      ("Run tests now.", 3, "Run ", "tests", " now."),
      ("Run tests now.", 4, "Run ", "tests", " now."),
      ("Run tests now.", 6, "Run ", "tests", " now."),
      ("Run  tests", 4, "Run  ", "tests", ""),
      ("Zażółć gęślą jaźń", 2, "", "Zażółć", " gęślą jaźń"),
      ("Fix 🐛 now", 4, "Fix ", "🐛", " now"),
      ("Run tests now.", -3, "", "Run", " tests now."),
    ])
  func split(_ text: String, _ prefix: Int, _ heard: String, _ now: String, _ rest: String) {
    let split = InboxPromptHighlight.split(text, progress: ReadingProgress(spokenPrefix: prefix, end: nil))
    #expect(split == InboxPromptHighlight(heard: heard, now: now, rest: rest))
  }

  @Test("no reading, an ended reading and the whole text heard show the text plain")
  func plain() {
    #expect(InboxPromptHighlight.split("Run tests", progress: nil) == nil)
    #expect(InboxPromptHighlight.split("Run tests", progress: ReadingProgress(spokenPrefix: 3, end: .cut)) == nil)
    #expect(InboxPromptHighlight.split("Run tests", progress: ReadingProgress(spokenPrefix: 9, end: .whole)) == nil)
    #expect(InboxPromptHighlight.split("Run tests", progress: ReadingProgress(spokenPrefix: 9, end: nil)) == nil)
    #expect(InboxPromptHighlight.split("Run tests ", progress: ReadingProgress(spokenPrefix: 9, end: nil)) == nil)
  }

  @Test("the block shows the text it holds: the person's edit while editing and while it goes, else the agent's")
  func shownText() throws {
    var shown = try block("Run the tests")
    #expect(shown.shownText == "Run the tests" && !shown.showsEdit)
    let edits = shown.edit()
    #expect(edits)
    shown.editText("Run the tests twice")
    #expect(shown.shownText == "Run the tests twice" && shown.showsEdit)
    let sent = shown.send(id: UUID())
    #expect(sent?.send.text == "Run the tests twice")
    #expect(shown.phase == .sending)
    #expect(shown.shownText == "Run the tests twice" && shown.showsEdit, "the edited text goes, so it stays shown")
  }
}
