import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The prompt of the voice conversation in the message field without a view: the "Prompt in the field" table of the
// plan (`VoiceAgentDraft`), how the prompt follows edits of the field, and the typed result of one send of the field
// (`ComposerSendResult`). Owner: voice agent.

private typealias Draft = VoiceAgentDraft

/// The draft after `show_prompt` wrote `prompt` into `field` (version 1).
private func placed(_ prompt: String, in field: String = "") -> (draft: Draft, text: String) {
  var draft = Draft()
  let insertion = draft.place(prompt, version: 1, in: field)
  return (draft, insertion.text)
}

/// The prompt of version 1 at `location` with `length`.
private func at(_ location: Int, _ length: Int, edited: Bool) -> Draft.Prompt {
  Draft.Prompt(version: 1, range: NSRange(location: location, length: length), edited: edited)
}

@Suite("voice conversation: the prompt in the message field")
struct VoiceAgentDraftTests {
  // MARK: The "Prompt in the field" table

  @Test(
    "no prompt of the agent in the field: empty → the prompt alone; text → the prompt on a new line under it",
    arguments: [
      ("", "P", RealtimePromptPlacement.alone),
      (" \n\t", "P", .alone),
      ("abc", "abc\nP", .underUserText),
      ("abc\n", "abc\nP", .underUserText),
      ("abc  \n\n", "abc\nP", .underUserText),
      ("a\nb", "a\nb\nP", .underUserText),
    ])
  func withoutPrompt(field: String, text: String, placement: RealtimePromptPlacement) {
    var draft = Draft()
    let insertion = draft.place("P", version: 1, in: field)
    #expect(insertion.text == text)
    #expect(insertion.placement == placement)
    #expect(insertion.range == NSRange(location: (text as NSString).length - 1, length: 1))
    #expect(draft.holds(version: 1))
  }

  @Test("“abc\\n” + P untouched at the end → the new prompt takes its place under the user's text")
  func replacesUntouchedPrompt() {
    var (draft, text) = placed("Run the tests", in: "abc")
    #expect(text == "abc\nRun the tests")
    let insertion = draft.place("Run the linter", version: 2, in: text)
    #expect(insertion.text == "abc\nRun the linter")
    #expect(insertion.placement == .replacedUnderUserText)
    #expect(insertion.range == NSRange(location: 4, length: 14))
    #expect(draft.holds(version: 2) && !draft.holds(version: 1))
  }

  @Test("P alone and untouched → the new prompt alone in its place")
  func replacesPromptAlone() {
    var (draft, text) = placed("Run the tests")
    let insertion = draft.place("Run the linter", version: 2, in: text)
    #expect(insertion.text == "Run the linter")
    #expect(insertion.placement == .replacedAlone)
  }

  @Test("the user's text above P edited, P untouched → P is still replaced")
  func userTextEditedAbovePrompt() {
    var (draft, text) = placed("Run the tests", in: "abc")
    let edited = "abd" + text.dropFirst(3)
    draft.observe(String(edited))
    let insertion = draft.place("B", version: 2, in: String(edited))
    #expect(insertion.text == "abd\nB")
    #expect(insertion.placement == .replacedUnderUserText)
  }

  @Test("“abc\\n” + P' (the user edited the prompt) → the new prompt goes under P', nothing is removed")
  func editedPromptStays() {
    var (draft, text) = placed("Run the tests", in: "abc")
    let edited = text + " twice"
    #expect(draft.observe(edited) == false, "an edit keeps the prompt")
    let insertion = draft.place("B", version: 2, in: edited)
    #expect(insertion.text == "abc\nRun the tests twice\nB")
    #expect(insertion.placement == .underEditedPrompt)
  }

  // MARK: The prompt follows the field

  @Test("typing before the prompt moves it; it stays untouched")
  func typingBeforeMoves() {
    var (draft, text) = placed("Run", in: "abc")
    #expect(draft.observe("x" + text) == false)
    #expect(draft.prompt == .init(version: 1, range: NSRange(location: 5, length: 3), edited: false))
  }

  @Test("text put back on top of the field (a failed send) moves the prompt")
  func restoredTextOnTop() {
    var (draft, text) = placed("Run", in: "abc")
    #expect(draft.observe("old\n" + text) == false)
    #expect(draft.prompt?.range == NSRange(location: 8, length: 3))
    #expect(draft.prompt?.edited == false)
  }

  @Test(
    "an edit inside the prompt or right at its end makes it P'",
    arguments: [
      ("abc\nRun!", NSRange(location: 4, length: 4)),
      ("abc\nRu", NSRange(location: 4, length: 2)),
      ("abc\nRxn", NSRange(location: 4, length: 3)),
      // The user's text and the start of the prompt replaced by one letter: what is left of it, with the letter.
      ("abXun", NSRange(location: 2, length: 3)),
    ])
  func editInsideMakesEdited(field: String, range: NSRange) {
    var (draft, _) = placed("Run", in: "abc")
    #expect(draft.observe(field) == false)
    #expect(draft.prompt?.edited == true)
    #expect(draft.prompt?.range == range)
    #expect(draft.holds(version: 1))
  }

  @Test(
    "the prompt is gone when an edit covers it whole: deleted, the field cleared, everything replaced",
    arguments: ["abc\n", "abc", "", "x", "Other text"])
  func coveredIsGone(field: String) {
    var (draft, _) = placed("Run", in: "abc")
    #expect(draft.observe(field) == true)
    #expect(draft.prompt == nil)
    #expect(!draft.holds(version: 1))
  }

  @Test(
    "an edit with its range from the field follows the same rules (“abc\\nRun”, P = 4..<7)",
    arguments: [
      (NSRange(location: 0, length: 0), "x", at(5, 3, edited: false)),
      (NSRange(location: 3, length: 1), " ", at(4, 3, edited: false)),
      (NSRange(location: 7, length: 0), "!", at(4, 4, edited: true)),
      (NSRange(location: 5, length: 1), "x", at(4, 3, edited: true)),
      (NSRange(location: 2, length: 3), "X", at(2, 3, edited: true)),
      (NSRange(location: 4, length: 3), "", nil),
      (NSRange(location: 4, length: 3), "Other", nil),
      (NSRange(location: 0, length: 7), "x", nil),
    ] as [(NSRange, String, VoiceAgentDraft.Prompt?)])
  func editWithRange(range: NSRange, replacement: String, prompt: VoiceAgentDraft.Prompt?) {
    var (draft, text) = placed("Run", in: "abc")
    let field = (text as NSString).replacingCharacters(in: range, with: replacement)
    #expect(draft.observe(field, change: .init(range: range, replacement: replacement)) == (prompt == nil))
    #expect(draft.prompt == prompt)
  }

  @Test(
    "a replacement of the whole prompt that shares its start or its end with it, or repeats it, makes it gone",
    arguments: ["Private note.", "Run nothing", "Run the tests."])
  func replacementSharingTextIsGone(replacement: String) {
    var (draft, _) = placed("Run the tests.")
    let change = Draft.Change(range: NSRange(location: 0, length: 14), replacement: replacement)
    #expect(draft.observe(replacement, change: change) == true)
    #expect(draft.prompt == nil)
  }

  @Test("without a range (text from code) or with one that does not match the field, the texts are compared")
  func changeFallsBackToComparison() {
    var (fromCode, _) = placed("Run the tests.")
    #expect(fromCode.observe("Private note.") == false, "a shared end looks like an edit inside")
    #expect(fromCode.prompt?.edited == true)
    var (stale, _) = placed("Run", in: "abc")
    let change = Draft.Change(range: NSRange(location: 0, length: 0), replacement: "zzz")
    #expect(stale.observe("abc\nRun!", change: change) == false)
    #expect(stale.prompt == .init(version: 1, range: NSRange(location: 4, length: 4), edited: true))
  }

  @Test("a deleted prompt stays gone when the user types again where it stood")
  func goneStaysGone() {
    var (draft, _) = placed("Run", in: "abc")
    draft.observe("abc\n")
    draft.observe("abc\nRun")
    #expect(draft.prompt == nil)
    let insertion = draft.place("B", version: 2, in: "abc\nRun")
    #expect(insertion.placement == .underUserText)
    #expect(insertion.text == "abc\nRun\nB")
  }

  @Test("a send takes the prompt: text back in the field is the user's, the next prompt goes under it")
  func takenPromptIsNotLive() {
    var (draft, text) = placed("Run", in: "abc")
    draft.take()
    #expect(!draft.holds(version: 1))
    let insertion = draft.place("B", version: 2, in: text)
    #expect(insertion.placement == .underUserText)
    #expect(insertion.text == "abc\nRun\nB")
  }

  @Test("the same field without a change keeps the prompt as it is; reset forgets it")
  func sameFieldAndReset() {
    var (draft, text) = placed("Run", in: "abc")
    #expect(draft.observe(text) == false)
    #expect(draft.prompt?.edited == false)
    draft.reset()
    #expect(draft.prompt == nil)
  }

  @Test("emoji and other characters of two UTF-16 units keep the range right")
  func utf16() {
    var (draft, text) = placed("Fix 🐛", in: "😀")
    #expect(text == "😀\nFix 🐛")
    #expect(draft.prompt?.range == NSRange(location: 3, length: 6))
    let insertion = draft.place("B", version: 2, in: text)
    #expect(insertion.text == "😀\nB")
  }

  // MARK: One send of the field

  @Test(
    "the store's outcome → the typed result of the send",
    arguments: [
      (SendOutcome.accepted(UUID()), false, ComposerSendResult.accepted(queued: false)),
      (.accepted(UUID()), true, .accepted(queued: true)),
      (.unconfirmed(UUID()), false, .unconfirmed),
      (.refused(UUID(), code: "bad-request", message: "No."), false, .refused(code: "bad-request", message: "No.")),
      (.refused(UUID(), code: OutboxEntry.RefusalCode.cancelled, message: nil), false, .stopped),
      (.blocked(.herdrReadOnly), false, .blocked(.herdrReadOnly)),
      (.empty, false, .notSent),
      (.notPersisted("disk"), false, .notSent),
      (.ignored, false, .notSent),
    ])
  func sendResult(outcome: SendOutcome, queued: Bool, result: ComposerSendResult) {
    #expect(ComposerSendResult(outcome, queued: queued) == result)
  }

  @Test("a send the user stopped: the model hears that nothing went out and that nothing is back in the field")
  func stoppedSend() {
    let output = VoiceAgentToolText.send(.stopped)
    #expect(output.contains("stopped") && output.contains("nothing was sent"), "\(output)")
    #expect(!output.contains("back in the field"), "\(output)")
  }
}
