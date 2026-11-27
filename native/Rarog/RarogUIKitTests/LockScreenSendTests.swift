import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

// The Send of a message-field dictation from outside the app's screens (`AppMicrophone.sendFromLockScreen()`) on a
// real `SessionViewController`: the recording ends, its last words land in the field, and the field goes through the
// screen's one send (`sendField`) with the login of the press; every result maps to what the Lock Screen says
// (`LockScreenSend`), the text stays where the send recovery puts it, and the end and result lines carry no text. The
// recording runs on the system route with the fakes of `DictationFakes.swift`; sends go to the transport of
// `CommandSuggestionsKeysTests.Fixture`. The mapping of every result and the center's rules have package tests
// (`DictationCenterTests`). Owner: dictation.

@MainActor
final class LockScreenSendTests: XCTestCase {
  /// The field holds "abc", dictation adds "def", the press sends one request with the whole text, the field is
  /// empty, and the lines say how the recording ended and how the send did, without the text.
  func testPressSendsTheWholeFieldOnce() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    _ = try await rig.dictating()
    let result = try await rig.press().value
    XCTAssertEqual(result, .sent)
    XCTAssertEqual(rig.calls.read(\.sends), ["abc def"])
    XCTAssertEqual(rig.composer.text, "")
    XCTAssertEqual(rig.lines, ["dictation: ended live-activity-send", "dictation: live activity send sent"])
    XCTAssertFalse(rig.store.reporter.pending.contains { $0.contains("abc") || $0.contains("def") }, "no text")
    XCTAssertNil(AppMicrophone.shared.sendFromLockScreen(), "the send ended and nothing records")
  }

  /// The server keeps the message in the CLI queue: queued.
  func testQueuedMessageIsQueued() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    rig.calls.record { $0.sendQueued = true }
    _ = try await rig.dictating()
    let result = try await rig.press().value
    XCTAssertEqual(result, .queued)
    XCTAssertEqual(rig.calls.read(\.sends), ["abc def"])
    XCTAssertEqual(rig.lines.last, "dictation: live activity send queued")
  }

  /// The server refuses: not sent, the text is back in the field of the screen in the window (the send recovery), and
  /// the durable draft holds it once the task gives the result: the send emptied the field, so a draft written
  /// before the result would have none of it.
  func testRefusalGivesTheTextBackAndWritesTheDraftAfterTheResult() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "drafts-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let rig = try LockScreenSendRig(drafts: ComposerDrafts(directory: directory))
    defer { rig.close() }
    rig.calls.record {
      $0.sendFailure = .http(APIFailure(status: 400, code: "bad-request", message: "This command is not allowed."))
    }
    _ = try await rig.dictating()
    let result = try await rig.press().value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.composer.text, "abc def")
    XCTAssertEqual(ComposerDrafts(directory: directory).take(for: "s1")?.text, "abc def", "the draft on disk")
    XCTAssertEqual(rig.lines.last, "dictation: live activity send not-sent")
  }

  /// The field turns read-only while the last words come: not sent, nothing taken, the text stays in the field.
  func testReadOnlyFieldIsNotSent() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    let task = try await rig.dictating()
    task.holdsEnd = true
    let send = try rig.press()
    // The server's read-only status, as in the app: a render sets the field from the state, so a flag set by hand
    // would not hold until the send.
    try DecisionDockTests.frame(
      rig.store, #"{"type":"herdr-status","available":true,"agentCount":1,"readOnly":true}"#, source: .global)
    let locked = await VoiceAgentEvents.waitUntil { !rig.composer.isEditable }
    XCTAssertTrue(locked, "the field turned read-only")
    task.answerEnd()
    let result = await send.value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.composer.text, "abc def")
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
  }

  /// Catches an app command that runs from outside the screens: Send on the screen opens the model sheet for
  /// `/model` (and clears the field), but a press behind the Lock Screen must not act on the app. The whole field is
  /// an app command (`/model def`, `/usage def`): not sent, no request, no sheet asked for, the field as it was.
  func testAppCommandDoesNotRunAndIsNotSent() async throws {
    for command in ["/model", "/usage"] {
      let rig = try LockScreenSendRig()
      defer { rig.close() }
      _ = try await rig.dictating(command)
      let result = try await rig.press().value
      XCTAssertEqual(result, .notSent, command)
      XCTAssertEqual(rig.calls.read(\.sendCalls), 0, command)
      XCTAssertEqual(rig.composer.text, "\(command) def", command)
      XCTAssertEqual(rig.controller.modelSheetRequests.count, 0, "\(command): no model sheet")
      XCTAssertNil(rig.controller.presentedViewController, "\(command): no sheet")
    }
  }

  /// A photo in the bar: the field does not go from outside the screens, no request, the text and the photo stay.
  func testFieldWithAPhotoIsNotSent() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
    try Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let photo = ComposerAttachment(kind: .image, name: "sky.jpg", mime: "image/jpeg", bytes: 4, file: url)
    AttachmentShelf.shared.restore([photo], for: "s1")
    defer { AttachmentShelf.shared.remove([photo.id], for: "s1") }
    let shelved = await VoiceAgentEvents.waitUntil { rig.composer.attachments.count == 1 }
    XCTAssertTrue(shelved)
    _ = try await rig.dictating()
    let result = try await rig.press().value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(rig.composer.text, "abc def")
    XCTAssertEqual(rig.composer.attachments.map(\.id), [photo.id])
  }

  /// The request times out: unconfirmed, and the message waits in the send queue for "Retry".
  func testTimedOutRequestIsUnconfirmedAndQueued() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    rig.calls.record { $0.sendFailure = .timedOut }
    _ = try await rig.dictating()
    let result = try await rig.press().value
    XCTAssertEqual(result, .unconfirmed)
    XCTAssertTrue(rig.store.state.outbox.contains { $0.text == "abc def" && $0.state == .unconfirmed })
    XCTAssertEqual(rig.lines.last, "dictation: live activity send unconfirmed")
  }

  /// A second press while the last words come, and a third while the request is on its way, get the same task: one
  /// request.
  func testRepeatedPressGetsTheSameSend() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    let task = try await rig.dictating()
    task.holdsEnd = true
    let first = try rig.press()
    XCTAssertEqual(AppMicrophone.shared.sendFromLockScreen(), first, "while the last words come")
    rig.calls.record { $0.holdSends = true }
    task.answerEnd()
    let requested = await VoiceAgentEvents.waitUntil { rig.calls.read(\.sendCalls) == 1 }
    XCTAssertTrue(requested)
    XCTAssertFalse(rig.controller.dictation.isActive, "the recording ended")
    XCTAssertEqual(AppMicrophone.shared.sendFromLockScreen(), first, "while the request is on its way")
    rig.calls.record { $0.holdSends = false }
    let result = await first.value
    XCTAssertEqual(result, .sent)
    XCTAssertEqual(rig.calls.read(\.sends), ["abc def"])
    XCTAssertEqual(rig.lines.filter { $0.hasPrefix("dictation: live activity send") }.count, 1)
  }

  /// The pairing changes while the last words come: the send keeps the login of the press, so nothing goes out and
  /// the text stays in the field.
  func testPairingChangedAfterThePressSendsNothing() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    let task = try await rig.dictating()
    task.holdsEnd = true
    let send = try rig.press()
    rig.store.enterLoggedIn()
    task.answerEnd()
    let result = await send.value
    XCTAssertEqual(result, .notSent)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(rig.composer.text, "abc def")
  }

  /// Nothing records: no task, nothing changes, no line.
  func testNothingRecordingGivesNothing() throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    rig.composer.text = "abc"
    XCTAssertNil(rig.controller.dictation.sendFromLockScreen())
    XCTAssertNil(AppMicrophone.shared.sendFromLockScreen())
    XCTAssertEqual(rig.composer.text, "abc")
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(rig.lines, [])
  }

  /// The end from outside the screens still keeps the text in the field and sends nothing.
  func testEndFromLockScreenStillSendsNothing() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    _ = try await rig.dictating()
    XCTAssertEqual(AppMicrophone.shared.endFromLockScreen(), .dictation)
    let ended = await VoiceAgentEvents.waitUntil { !rig.controller.dictation.isActive }
    XCTAssertTrue(ended)
    XCTAssertEqual(rig.composer.text, "abc def")
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
    XCTAssertEqual(rig.lines, ["dictation: ended live-activity"])
  }

  /// Catches a press that hangs or still sends once its field went away: the screen is released while the last words
  /// come, so the operation ends as not sent, without a request.
  func testFieldReleasedWhileTheLastWordsComeIsNotSent() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    let task = try await rig.dictating()
    task.holdsEnd = true
    let send = try rig.press()
    weak var screen = rig.controller
    rig.release()
    let released = await VoiceAgentEvents.waitUntil { screen == nil }
    XCTAssertTrue(released, "nothing keeps the screen")
    let result = Outcome()
    Task { result.value = await send.value }
    let ended = await VoiceAgentEvents.waitUntil { result.value != nil }
    XCTAssertTrue(ended, "the operation ends")
    XCTAssertEqual(result.value, .notSent)
    XCTAssertEqual(rig.calls.read(\.sendCalls), 0)
  }

  /// Catches the end of one press's operation that clears the operation of a later recording in the same field: a new
  /// recording starts while the first message is on its way and gets its own Send; the first result changes nothing
  /// of it, so a repeated press still gets the second operation, which sends the second text.
  func testNewRecordingDuringASendKeepsItsOwnSend() async throws {
    let rig = try LockScreenSendRig()
    defer { rig.close() }
    _ = try await rig.dictating()
    rig.calls.record { $0.holdSends = true }
    let first = try rig.press()
    let requested = await VoiceAgentEvents.waitUntil { rig.calls.read(\.sendCalls) == 1 }
    XCTAssertTrue(requested, "the first message is on its way")
    let task = try await rig.dictating("ghi", words: "jkl")
    task.holdsEnd = true
    let second = try rig.press()
    XCTAssertNotEqual(second, first, "a new recording, a new operation")
    rig.calls.record { $0.holdSends = false }
    let firstResult = await first.value
    XCTAssertEqual(firstResult, .sent)
    XCTAssertEqual(AppMicrophone.shared.sendFromLockScreen(), second, "the second operation stands")
    task.answerEnd()
    let secondResult = await second.value
    XCTAssertEqual(secondResult, .sent)
    XCTAssertEqual(rig.calls.read(\.sends), ["abc def", "ghi jkl"])
  }

  /// What a task gave, read on the main actor.
  @MainActor private final class Outcome {
    var value: LockScreenSend?
  }
}

/// A session screen in a window (`CommandSuggestionsKeysTests.Fixture`) whose field records on the system route with
/// fakes: the microphone and an Apple speech task whose results the test gives.
@MainActor
private final class LockScreenSendRig {
  let mics: MicLog
  let speech: RouteSpeech
  let store: RarogStore
  let calls: CallLog
  /// `nil` once the test released the screen.
  private var fixture: CommandSuggestionsKeysTests.Fixture?

  init(drafts: ComposerDrafts = ComposerDrafts()) throws {
    var timing = VoiceTiming()
    timing.finalizeTimeout = 0.3
    timing.stopConnectWait = 0.3
    let mics = MicLog(), speech = RouteSpeech()
    self.mics = mics
    self.speech = speech
    let voice = VoiceServices(
      microphone: { RouteMicrophone(tag: "composer", log: mics) },
      connect: { _, _, events in VoiceAgentRowSocket(events: events) },
      speech: { speech }, scheduler: TaskVoiceScheduler(), timing: timing, language: .pl, open: { _ in })
    let fixture = try CommandSuggestionsKeysTests.Fixture(state: "waiting-input", drafts: drafts, voice: voice)
    fixture.store.attachDictation(.memory(sonioxAllowed: true, choice: .system))
    self.fixture = fixture
    store = fixture.store
    calls = fixture.calls
  }

  var controller: SessionViewController { fixture!.controller }
  var composer: ComposerView { fixture!.composer }

  /// The `dictation:` lines of `client.log`.
  var lines: [String] { store.reporter.pending.filter { $0.hasPrefix("dictation:") } }

  func close() {
    fixture?.controller.dictation.leave()
    fixture?.close()
  }

  /// The screen goes away with its field, as a closed window takes it: nothing of the rig keeps it.
  func release() {
    fixture?.close()
    fixture?.window.rootViewController = nil
    fixture = nil
  }

  /// `text` in the field, a recording whose microphone opened, and `words` dictated after the text.
  func dictating(_ text: String = "abc", words: String = "def") async throws -> RouteSpeechTask {
    let previous = speech.task
    composer.text = text
    controller.dictation.toggle()
    let opened = await VoiceAgentEvents.waitUntil {
      DictationCenter.shared.use != nil && self.speech.task !== previous && self.speech.task?.cancelled == false
    }
    XCTAssertTrue(opened, "the microphone opened")
    let task = try XCTUnwrap(speech.task)
    task.partial(words)
    let shown = await VoiceAgentEvents.waitUntil { self.composer.text == "\(text) \(words)" }
    XCTAssertTrue(shown, "dictated words in the field: \(composer.text)")
    return task
  }

  /// The Send of the Live Activity.
  func press() throws -> Task<LockScreenSend, Never> {
    try XCTUnwrap(AppMicrophone.shared.sendFromLockScreen(), "a dictation records")
  }
}
