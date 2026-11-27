import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

// The prompt of the voice conversation in the message field and the send of the field by voice, on a real
// `SessionViewController` (`VoiceAgentRig.swift`): where `show_prompt` writes, the cursor and the fading highlight,
// composing a character (IME), the draft of the session, and every exit of the send operation shared with ↑
// (`sendField`). The rules without a view have package tests (`VoiceAgentDraftTests`, `VoiceAgentSessionTests`).
// Owner: voice agent.

@MainActor
final class VoiceAgentFieldTests: XCTestCase {
  // MARK: The prompt in the field

  /// An empty field gets the prompt alone, the cursor at its end and a highlight that fades after 3 s; typing after
  /// it does not take the highlight.
  func testPromptAloneInTheEmptyFieldWithCursorAndFadingHighlight() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    rig.showPrompt("Run the tests")
    let placed = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(placed)
    XCTAssertEqual(rig.composer.text, "Run the tests")
    XCTAssertEqual(rig.composer.textView.selectedRange, NSRange(location: 13, length: 0))
    XCTAssertTrue(rig.outputs[0].contains("prompt alone in the field"), rig.outputs[0])
    XCTAssertTrue(rig.outputs[0].contains("A send takes only this prompt"), rig.outputs[0])
    XCTAssertFalse(rig.outputs[0].contains("Run the tests"), "the result never carries the field text")
    XCTAssertEqual(rig.controller.voiceAgentHighlight, NSRange(location: 0, length: 13))
    XCTAssertNil(rig.composer.textView.typingAttributes[.backgroundColor])
    rig.scheduler.advance(2.9)
    XCTAssertNotNil(rig.controller.voiceAgentHighlight)
    rig.scheduler.advance(0.2)
    XCTAssertNil(rig.controller.voiceAgentHighlight, "the highlight fades after 3 s")
    rig.end()
  }

  /// Text in the field: the prompt goes on a new line under it, trailing whitespace becomes that one line; a second
  /// prompt over the untouched first one takes its place.
  func testPromptUnderTheUserTextThenReplacedWhileUntouched() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "Fix the login  \n"
    rig.showPrompt("A")
    let first = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(first)
    XCTAssertEqual(rig.composer.text, "Fix the login\nA")
    XCTAssertEqual(rig.controller.voiceAgentHighlight, NSRange(location: 14, length: 1))
    XCTAssertTrue(rig.outputs[0].contains("under the user's text"), rig.outputs[0])
    XCTAssertTrue(rig.outputs[0].contains("A send takes the whole field"), rig.outputs[0])
    rig.answered("r1f")
    rig.showPrompt("B", response: "r2", item: "in2")
    let second = await VoiceAgentEvents.waitUntil { rig.outputs.count == 2 }
    XCTAssertTrue(second)
    XCTAssertEqual(rig.composer.text, "Fix the login\nB")
    XCTAssertTrue(rig.outputs[1].contains("replaced your previous prompt, under the user's text"), rig.outputs[1])
    rig.end()
  }

  /// The user edits the prompt (P'): the next prompt goes under it, nothing is removed.
  func testEditedPromptStaysAndTheNextGoesUnderIt() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    rig.showPrompt("Run")
    let first = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(first)
    rig.answered("r1f")
    rig.composer.textView.insertText(" twice")
    XCTAssertEqual(rig.composer.text, "Run twice")
    rig.showPrompt("B", response: "r2", item: "in2")
    let second = await VoiceAgentEvents.waitUntil { rig.outputs.count == 2 }
    XCTAssertTrue(second)
    XCTAssertEqual(rig.composer.text, "Run twice\nB")
    XCTAssertTrue(rig.outputs[1].contains("under the user's text and your earlier edited prompt"), rig.outputs[1])
    rig.end()
  }

  /// A selection or a cursor the user put inside the text: the prompt still goes at the end, the selection is not
  /// replaced, and the cursor moves to the end of the prompt.
  func testSelectionAndManualCursorDoNotMoveThePrompt() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "abc def"
    rig.composer.textView.selectedRange = NSRange(location: 0, length: 3)
    rig.showPrompt("Run")
    let placed = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(placed)
    XCTAssertEqual(rig.composer.text, "abc def\nRun")
    XCTAssertEqual(rig.composer.textView.selectedRange, NSRange(location: 11, length: 0))
    rig.end()
  }

  /// A character being composed (IME): the prompt waits for the end of composing, then goes under the text.
  func testPromptWaitsForTheEndOfComposing() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    let field = rig.composer.textView
    field.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
    XCTAssertNotNil(field.markedTextRange)
    rig.showPrompt("Run")
    let answered = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(answered)
    XCTAssertEqual(rig.composer.text, "か", "nothing written while composing")
    XCTAssertTrue(rig.outputs[0].contains("under the user's text"), rig.outputs[0])
    field.unmarkText()
    // The system reports the end of composing as a change of the selection.
    rig.composer.textViewDidChangeSelection(field)
    XCTAssertEqual(rig.composer.text, "か\nRun")
    XCTAssertEqual(field.selectedRange, NSRange(location: 5, length: 0))
    rig.end()
  }

  /// The written prompt is in the draft of the session: a screen opened again shows it without any store event.
  func testWrittenPromptIsInTheDraftOfAReopenedScreen() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let rig = try VoiceAgentRig(drafts: drafts)
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "Mine"
    rig.showPrompt("Run the tests")
    let placed = await VoiceAgentEvents.waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(placed)
    rig.end()
    try? await Task.sleep(for: SessionViewController.draftDebounce + .milliseconds(200))
    drafts.flush()
    let reopened = SessionViewController(store: rig.store, sessionId: "s1", drafts: drafts)
    reopened.loadViewIfNeeded()
    XCTAssertEqual(reopened.composer.text, "Mine\nRun the tests")
  }

  // MARK: Sending the field by voice

  /// Confirmed by voice: the whole field goes like ↑ (the user's text above the prompt too), the field is empty, the
  /// model hears "sent", and the row says "Sent to the session".
  func testVoiceSendTakesTheWholeFieldAndShowsSent() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "Context from me"
    await rig.promptConfirmed("Run the tests")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("sent") && !output.contains("error"), output)
    XCTAssertEqual(rig.calls.read(\.sends), ["Context from me\nRun the tests"])
    XCTAssertEqual(rig.composer.text, "")
    rig.answered("r2f")
    let sent = await VoiceAgentEvents.waitUntil { rig.status == UICopy.voiceAgentStatus(.sent) }
    XCTAssertTrue(sent, "\(rig.status ?? "nil")")
    rig.end()
  }

  /// The user selects the whole prompt and pastes a text that ends like it (the period): the prompt is gone, not
  /// edited, so `send_prompt` refuses and nothing is sent. The paste goes as UIKit runs it (`shouldChangeTextIn` with
  /// the range, then the edit); the test host may not read the pasteboard.
  func testTextOverTheWholePromptMakesItGone() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run the tests.")
    let field = rig.composer.textView
    let whole = NSRange(location: 0, length: 14)
    field.selectedRange = whole
    // The keyboard and a paste ask the delegate before the edit; `insertText` from code does not (measured: no range
    // in `onEdit`), so the test asks it the way UIKit does.
    let asked = field.delegate?.textView?(field, shouldChangeTextIn: whole, replacementText: "Private note.")
    XCTAssertEqual(asked, true)
    field.insertText("Private note.")
    XCTAssertEqual(rig.composer.text, "Private note.")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("no longer holds your prompt"), output)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    rig.end()
  }

  /// A pasteboard with text and an address pastes its text from the field's own code, not through the keyboard: over
  /// the whole prompt it still makes the prompt gone, though the two addresses share their start and end.
  func testPastedTextWithAnAddressOverTheWholePromptMakesItGone() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    let prompt = "https://public.example.com"
    await rig.promptConfirmed(prompt)
    rig.composer.textView.selectedRange = NSRange(location: 0, length: (prompt as NSString).length)
    rig.composer.textView.pasteText("https://private.example.com")
    XCTAssertEqual(rig.composer.text, "https://private.example.com")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("no longer holds your prompt"), output)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    rig.end()
  }

  /// Undo after the prompt was gone brings its text back but not the right to send it: only a new `show_prompt`
  /// does.
  func testUndoDoesNotBringBackAGonePrompt() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run the tests.")
    let field = rig.composer.textView
    field.selectedRange = NSRange(location: 0, length: 14)
    field.deleteBackward()
    XCTAssertEqual(rig.composer.text, "")
    try? await Task.sleep(for: .milliseconds(50))
    let undo = try XCTUnwrap(field.undoManager)
    XCTAssertTrue(undo.canUndo)
    undo.undo()
    XCTAssertEqual(rig.composer.text, "Run the tests.")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("no longer holds your prompt"), output)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    rig.end()
  }

  /// ↑ sent the prompt: a voice send after it hears the field no longer holds the prompt; nothing goes twice.
  func testSendButtonTakesThePromptSoAVoiceSendRefuses() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    rig.composer.onSend?()
    await rig.sendSettled("Run")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("no longer holds your prompt"), output)
    XCTAssertEqual(rig.calls.read(\.sends), ["Run"])
    rig.end()
  }

  /// The user cleared the field while the agent works: the voice send refuses and never stops the turn.
  func testClearedFieldDuringARunningTurnRefusesWithoutStop() async throws {
    let rig = try VoiceAgentRig(state: "running")
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    let field = rig.composer.textView
    field.selectedRange = NSRange(location: 0, length: (rig.composer.text as NSString).length)
    field.deleteBackward()
    XCTAssertEqual(rig.composer.text, "")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("no longer holds your prompt"), output)
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(rig.calls.read(\.sends), [])
    XCTAssertEqual(rig.calls.read(\.interrupts), [], "no Stop")
    rig.end()
  }

  /// A read-only field at the moment of the send: refused with the reason, nothing taken.
  func testReadOnlyFieldRefusesTheSend() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    // The server's read-only status, as in the app: a render sets the field from the state, so a flag set by hand
    // would not hold until the send.
    try DecisionDockTests.frame(
      rig.store, #"{"type":"herdr-status","available":true,"agentCount":1,"readOnly":true}"#, source: .global)
    let locked = await VoiceAgentEvents.waitUntil { !rig.composer.isEditable }
    XCTAssertTrue(locked, "the field turned read-only")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("error") && output.contains("read-only"), output)
    XCTAssertEqual(rig.composer.text, "Run")
    XCTAssertEqual(rig.calls.read(\.sends), [])
    rig.end()
  }

  /// The agent is still starting (`canSend` false): the field takes the prompt, the send is refused, nothing taken.
  func testStartingAgentRefusesTheSend() async throws {
    let rig = try VoiceAgentRig(state: "starting")
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    XCTAssertEqual(rig.composer.text, "Run")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("error") && output.contains("read-only"), output)
    XCTAssertEqual(rig.composer.text, "Run")
    XCTAssertEqual(rig.calls.read(\.sends), [])
    rig.end()
  }

  /// The field holds an app command: the app handles it like ↑, nothing goes to the session, no "Sent".
  func testAppCommandInTheFieldIsNotSent() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    try await rig.ready()
    await rig.promptConfirmed("/model")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("error") && output.contains("app command"), output)
    rig.answered("r2f")
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(rig.calls.read(\.sends), [])
    XCTAssertNotEqual(rig.status, UICopy.voiceAgentStatus(.sent))
    rig.end()
  }

  /// More attachments than one message takes: `show_prompt` says they would go, the send refuses, nothing taken.
  func testTooManyAttachmentsRefuseTheSend() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    let files = (0...AttachmentLimits.maxFiles).map { index in
      ComposerAttachment(
        kind: .file, name: "note\(index).txt", mime: "text/plain", bytes: 7,
        file: FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt"))
    }
    AttachmentShelf.shared.restore(files, for: "s1")
    defer { AttachmentShelf.shared.remove(Set(files.map(\.id)), for: "s1") }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    XCTAssertTrue(rig.outputs[0].contains("attachments will go too"), rig.outputs[0])
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("too many attachments"), output)
    XCTAssertEqual(rig.composer.text, "Run")
    XCTAssertEqual(rig.calls.read(\.sends), [])
    rig.end()
  }

  /// Not known whether the message arrived: the model hears "not confirmed", the row does not say "Sent".
  func testUnconfirmedSendIsNotSent() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    rig.calls.record { $0.sendFailure = .timedOut }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("error") && output.contains("not confirmed"), output)
    rig.answered("r2f")
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.listening))
    rig.end()
  }

  /// The server refuses the message: the model hears the code, the text is back in the field as the user's, and a
  /// second voice send does not take it as the prompt.
  func testRefusedSendGivesTheTextBackAsTheUsers() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    rig.calls.record {
      $0.sendFailure = .http(APIFailure(status: 400, code: "bad-request", message: "This command is not allowed."))
    }
    try await rig.ready()
    await rig.promptConfirmed("Run")
    let output = await rig.sendByVoice()
    XCTAssertTrue(output.contains("error") && output.contains("bad-request"), output)
    let back = await VoiceAgentEvents.waitUntil { rig.composer.text == "Run" }
    XCTAssertTrue(back, "text back: \(rig.composer.text)")
    rig.answered("r2f")
    rig.utterance("in3")
    let again = await rig.sendByVoice(response: "r3")
    XCTAssertTrue(again.contains("no longer holds your prompt"), again)
    XCTAssertEqual(rig.calls.read(\.sends), ["Run"])
    rig.end()
  }

  /// The login changes after a voice send took the field and before the send starts (another pairing or server):
  /// nothing goes out, the text and the attachments are back, the model hears "not sent".
  func testVoiceSendDoesNotGoToALoginThatChangedAfterTakingTheField() async throws {
    let rig = try VoiceAgentRig()
    defer { rig.close() }
    // A real file: a missing one would fail the staging of the send and hide what this test checks.
    let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    try Data("a note\n".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let file = ComposerAttachment(kind: .file, name: "note.txt", mime: "text/plain", bytes: 7, file: url)
    AttachmentShelf.shared.restore([file], for: "s1")
    defer { AttachmentShelf.shared.remove([file.id], for: "s1") }
    rig.composer.text = "Run"
    let shelved = await VoiceAgentEvents.waitUntil { rig.composer.attachments.count == 1 }
    XCTAssertTrue(shelved)
    let send = rig.controller.sendField(byVoice: true)
    XCTAssertEqual(rig.composer.text, "", "the field is taken at once")
    rig.store.enterLoggedIn()
    let result = await send.value
    XCTAssertEqual(result, .notSent)
    XCTAssertTrue(VoiceAgentToolText.send(result).contains("not sent"))
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0, "no transport got the message")
    XCTAssertEqual(rig.composer.text, "Run")
    XCTAssertEqual(rig.composer.attachments.map(\.id), [file.id])
  }

  /// Another server after a voice send took the field: the interface is built again (the screen leaves the window,
  /// `interfaceEpoch`), the shelf is wiped and a new login starts. The session of the new server with the same id gets
  /// nothing on its shelf, the files of the attachments are gone, and the text does not reach a draft.
  func testVoiceSendGivesNothingBackToTheSessionOfAnotherSpace() async throws {
    let drafts = ComposerDrafts()
    let rig = try VoiceAgentRig(drafts: drafts)
    defer { rig.close() }
    let (file, url) = try await rig.attachedFile()
    defer {
      AttachmentShelf.shared.remove([file.id], for: "s1")
      try? FileManager.default.removeItem(at: url)
    }
    let send = rig.controller.sendField(byVoice: true)
    rig.controller.view.removeFromSuperview()
    rig.store.interfaceEpoch += 1
    AttachmentShelf.shared.removeAll()
    rig.store.enterLoggedIn()
    let result = await send.value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(AttachmentShelf.shared.attachments(for: "s1"), [], "nothing on the new server's shelf")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)), "the file is discarded")
    XCTAssertNil(drafts.take(for: "s1"), "no text in a draft")
  }

  /// A new login in the same space (the interface stays) while the screen is gone from the window: the text goes to
  /// the draft of the session, the attachments are discarded instead of going back to the shelf.
  func testVoiceSendAfterANewLoginInTheSameSpaceKeepsOnlyTheText() async throws {
    let drafts = ComposerDrafts()
    let rig = try VoiceAgentRig(drafts: drafts)
    defer { rig.close() }
    let (file, url) = try await rig.attachedFile()
    defer {
      AttachmentShelf.shared.remove([file.id], for: "s1")
      try? FileManager.default.removeItem(at: url)
    }
    let send = rig.controller.sendField(byVoice: true)
    rig.controller.view.removeFromSuperview()
    rig.store.enterLoggedIn()
    let result = await send.value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(AttachmentShelf.shared.attachments(for: "s1"), [])
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
    XCTAssertEqual(drafts.take(for: "s1")?.text, "Run")
  }
}

extension VoiceAgentRig {
  /// "Run" in the field with one real file on the shelf of `s1` (a missing file would fail the staging of the send
  /// and hide what the test checks). The caller removes it from the shelf and the disk.
  fileprivate func attachedFile() async throws -> (ComposerAttachment, URL) {
    let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    try Data("a note\n".utf8).write(to: url)
    let file = ComposerAttachment(kind: .file, name: "note.txt", mime: "text/plain", bytes: 7, file: url)
    AttachmentShelf.shared.restore([file], for: "s1")
    composer.text = "Run"
    let shelved = await VoiceAgentEvents.waitUntil { self.composer.attachments.count == 1 }
    XCTAssertTrue(shelved)
    return (file, url)
  }
}
