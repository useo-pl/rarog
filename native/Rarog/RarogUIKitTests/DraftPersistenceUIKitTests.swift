@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// The persistent draft on a real `SessionViewController` while a failed send's text waits in the draft store's memory
/// for a screen that is alive but out of the window (under a full-screen presentation): the field's next write takes
/// the text into the field first instead of writing over it. The take-back answer in the same spot:
/// `QueueTakeBackUIKitTests`; the draft store's rules: `DraftPersistenceTests` (RarogUI). Owner: session control.
@MainActor
final class DraftPersistenceUIKitTests: XCTestCase {
  private typealias Fixture = CommandSuggestionsKeysTests.Fixture

  /// Catches background time of a dictation's end released while the Send that end woke is still on its way: the
  /// send emptied the field, so a process removed before the message is stored loses the text.
  func testDictationEndWaitsForTheSendOfTheField() async throws {
    let fixture = try Fixture(state: "waiting-input")
    defer { fixture.close() }
    fixture.calls.record { $0.holdSends = true }
    fixture.controller.composer.text = "Run"
    fixture.controller.composer.onSend?()
    let settled = Flag()
    let wait = Task { @MainActor in
      await fixture.controller.dictationEndWait()()
      settled.set()
    }
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertFalse(settled.isSet, "the wait stands while the send is on its way")
    fixture.calls.record { $0.holdSends = false }
    await wait.value
    XCTAssertTrue(settled.isSet)
  }

  @MainActor
  private final class Flag {
    private(set) var isSet = false
    func set() { isSet = true }
  }

  /// The send fails under the presentation; back in the window the user types, and the write after the pause keeps the
  /// failed text above the typed one, in the field and on disk.
  func testFieldWriteKeepsAFailedSendThatWaitsInMemory() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "drafts-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let drafts = ComposerDrafts(directory: directory)
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    try fixture.failSendUnderCover("B")
    fixture.window.rootViewController = fixture.controller
    fixture.wait("screen back") { fixture.controller.view.window != nil }
    fixture.composer.textView.insertText("x")
    fixture.wait("the write took the failed text into the field") { fixture.composer.text == "B\nx" }
    drafts.flush()
    XCTAssertEqual(ComposerDrafts(directory: directory).take(for: "s1")?.text, "B\nx", "and wrote it to the disk")
  }

  /// An unchanged field writes nothing when the user leaves the session, so the failed text keeps waiting in memory
  /// for the next opening instead of going into a field that is about to be released. The draft store has no disk
  /// here, as when the disk refuses the draft too: memory is the only copy.
  func testUnchangedFieldLeavesAFailedSendWaitingForTheNextOpening() throws {
    let drafts = ComposerDrafts()
    let fixture = try Fixture(state: "running", drafts: drafts)
    defer { fixture.close() }
    try fixture.failSendUnderCover("B")
    fixture.window.rootViewController = fixture.controller
    fixture.wait("screen back") { fixture.controller.view.window != nil }
    fixture.window.rootViewController = nil
    let reopened = SessionViewController(store: fixture.store, sessionId: "s1", drafts: drafts)
    fixture.window.rootViewController = reopened
    reopened.view.layoutIfNeeded()
    XCTAssertEqual(reopened.composer.text, "B", "the session opened again gets the failed text")
  }
}

extension CommandSuggestionsKeysTests.Fixture {
  /// `text` leaves the field while the outbox refuses to store it, and a full-screen presentation covers the session
  /// screen before the refusal comes back: the send recovery puts the text into the session's draft, where it waits in
  /// memory, because a screen out of the window does not take it into its field (`SendRecovery.saveDraft`).
  func failSendUnderCover(_ text: String) throws {
    let manager = FileManager.default
    let outbox = store.persistence.directory
    try manager.createDirectory(at: outbox, withIntermediateDirectories: true)
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: outbox.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: outbox.path) }
    composer.text = text
    let send = controller.sendField()
    window.rootViewController = UIViewController()
    XCTAssertNil(controller.view.window, "the presentation covers the screen before the refusal comes back")
    let result = ResultBox<ComposerSendResult>()
    Task { @MainActor in result.value = await send.value }
    wait("send refused") { result.value != nil }
    XCTAssertEqual(result.value, .notSent, "the outbox refused the message")
    XCTAssertEqual(composer.text, "", "the covered screen does not take the text back")
  }
}
