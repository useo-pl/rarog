import Foundation
import RarogContract
@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

// The voice conversation in the session screen: the status row of the message field and the voice agent
// button on a real `SessionViewController`, with a fake Realtime socket, audio, clock and route to Rarog
// (`VoiceAgentRig.swift`). The prompt in the field and the send by voice: `VoiceAgentFieldTests`. The rules without a
// view have package tests (`VoiceAgentIndicatorTests`, `VoiceAgentStatusRowTests`). Owner: voice agent.

@MainActor
final class VoiceAgentRowTests: XCTestCase {
  /// Before a conversation the button is a ring with the waveform icon; during it the button is filled with the
  /// state color, its bars show and it ends the conversation; the row says what happens.
  func testRunningConversationFillsTheButtonAndOwnsTheRow() async throws {
    let rig = try Rig()
    defer { rig.close() }
    XCTAssertFalse(rig.button.isHidden)
    XCTAssertNil(rig.button.fill)
    XCTAssertEqual(rig.button.accessibilityLabel, UICopy.voiceAgentButton)
    XCTAssertTrue(rig.barsHidden)
    XCTAssertNil(rig.status)

    try await rig.ready()
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.listening))
    XCTAssertEqual(rig.button.fill, VoiceStatusView.color(.run))
    XCTAssertEqual(rig.button.accessibilityLabel, UICopy.voiceAgentEndButton)
    XCTAssertTrue(rig.button.accessibilityTraits.contains(.selected))
    XCTAssertFalse(rig.barsHidden)

    rig.socket.reply(speechStarted)
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.hearing))
    rig.socket.reply(speechStopped)
    rig.socket.reply(committed("in1"))
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.thinking))
    XCTAssertEqual(rig.button.fill, VoiceStatusView.color(.wait))

    rig.button.sendActions(for: .primaryActionTriggered)
    XCTAssertNil(rig.status, "a conversation ended by the button leaves no sentence")
    XCTAssertNil(rig.button.fill)
    XCTAssertEqual(rig.button.accessibilityLabel, UICopy.voiceAgentButton)
    XCTAssertTrue(rig.barsHidden)
    XCTAssertTrue(rig.socket.closed)
  }

  /// An older server announces the voice agent without Soniox speech (`companionSpeech` false): no button and no
  /// ⌥⌘V; the voice agent needs Soniox.
  func testServerWithoutSonioxSpeechHidesTheButtonAndTheShortcut() throws {
    let rig = try Rig(speech: false)
    XCTAssertTrue(rig.button.isHidden)
    XCTAssertTrue(rig.controller.voiceAgentKeyCommands.isEmpty)
    rig.close()
    let offered = try Rig()
    defer { offered.close() }
    XCTAssertFalse(offered.button.isHidden)
    XCTAssertEqual(offered.controller.voiceAgentKeyCommands.count, 1)
  }

  /// During a conversation the composer mic mutes it instead of dictating: a crossed microphone, lit while muted,
  /// "Muted" in the row, no microphone audio to OpenAI; after the end it dictates again.
  func testComposerMicMutesTheConversation() async throws {
    let rig = try Rig()
    defer { rig.close() }
    let mic = rig.controller.dictation.buttons.mic
    XCTAssertEqual(mic.accessibilityLabel, UICopy.voiceMic)
    try await rig.ready()
    XCTAssertEqual(mic.accessibilityLabel, UICopy.voiceAgentMute)
    XCTAssertNil(mic.tone)
    XCTAssertFalse(mic.accessibilityTraits.contains(.selected))
    XCTAssertTrue(rig.controller.dictation.canToggle)

    mic.sendActions(for: .primaryActionTriggered)
    XCTAssertFalse(rig.controller.dictation.isActive, "the mic does not start dictation during a conversation")
    XCTAssertTrue(rig.controller.voiceAgentChrome.session?.isActive == true, "nor does it end the conversation")
    XCTAssertEqual(mic.accessibilityLabel, UICopy.voiceAgentUnmute)
    XCTAssertEqual(mic.tone, Palette.err)
    XCTAssertTrue(mic.accessibilityTraits.contains(.selected))
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.muted))
    XCTAssertEqual(rig.socket.sent("input_audio_buffer.clear").count, 1)
    rig.audio.handlers?.input(loudPCM(1200))
    XCTAssertTrue(rig.socket.sent("input_audio_buffer.append").isEmpty)

    rig.controller.toggleVoiceAgentMute()
    XCTAssertEqual(mic.accessibilityLabel, UICopy.voiceAgentMute)
    XCTAssertNil(mic.tone)
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.listening))
    rig.audio.handlers?.input(loudPCM(1200))
    XCTAssertEqual(rig.socket.sent("input_audio_buffer.append").count, 1)

    mic.sendActions(for: .primaryActionTriggered)
    rig.button.sendActions(for: .primaryActionTriggered)
    XCTAssertEqual(mic.accessibilityLabel, UICopy.voiceMic, "after the end the mic dictates again")
    XCTAssertNil(mic.tone)
  }

  /// The microphone level moves the bars of the button between the rest heights and the maximum.
  func testMicrophoneLevelMovesTheBars() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    let quiet = rig.controller.voiceAgentChrome.bars.shownHeights
    rig.audio.handlers?.input(loudPCM(1200))
    rig.scheduler.advance(RealtimeLevelMeter.interval)
    let loud = rig.controller.voiceAgentChrome.bars.shownHeights
    XCTAssertGreaterThan(loud[2], quiet[2], "\(quiet) → \(loud)")
    XCTAssertLessThanOrEqual(loud[2], VoiceAgentBars.maxHeight)
    rig.end()
  }

  /// The field sent with ↑ while the conversation listens: "Sent to the session".
  func testSendShowsSent() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "A"
    rig.composer.onSend?()
    await rig.sendSettled("A")
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.sent))
  }

  /// ↑ sends the field (A) and its result comes late, after the agent wrote a newer prompt (B): "Sent to the
  /// session" is about A, so it leaves the state of B.
  func testLateSendResultKeepsTheNewerPrompt() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.calls.record { $0.holdSends = true }
    rig.composer.text = "A"
    rig.composer.onSend?()
    let requested = await waitUntil { rig.calls.read(\.sends) == ["A"] }
    XCTAssertTrue(requested)
    rig.showPrompt("B")
    let placed = await waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(placed)
    rig.socket.reply(created("r2"))
    rig.socket.reply(done("r2"))
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.promptInField))
    rig.calls.record { $0.holdSends = false }
    await rig.sendSettled("A")
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.promptInField))
  }

  /// A send result that belongs to the previous conversation does not touch the next one.
  func testSendResultOfThePreviousConversationKeepsTheNextOne() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.calls.record { $0.holdSends = true }
    rig.composer.text = "A"
    rig.composer.onSend?()
    let requested = await waitUntil { rig.calls.read(\.sends) == ["A"] }
    XCTAssertTrue(requested)
    rig.end()
    try await rig.ready()
    rig.calls.record { $0.holdSends = false }
    await rig.sendSettled("A")
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.listening))
  }

  /// After speech, silence brings the bars and the dot back to rest: they do not stop at the last fallen level.
  func testSilenceBringsTheBarsToRest() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    let rest = VoiceAgentBars.heights(level: 0, motion: .microphone, reduceMotion: false)
    rig.audio.handlers?.input(loudPCM(1200))
    rig.scheduler.advance(RealtimeLevelMeter.interval)
    XCTAssertGreaterThan(rig.controller.voiceAgentChrome.bars.shownHeights[2], rest[2])
    rig.scheduler.advance(2)
    XCTAssertEqual(rig.controller.voiceAgentChrome.bars.shownHeights, rest)
    XCTAssertEqual(rig.controller.voiceAgentChrome.level, 0, "the dot follows the same level")
    rig.end()
  }

  /// `show_prompt` writes the prompt under the user's text with the cursor at its end; the row says so once the
  /// answer is over. A field edit during the conversation keeps the row.
  func testShowPromptWritesUnderTheUserText() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "Fix the login"
    rig.showPrompt("Run the tests")
    let placed = await waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(placed)
    XCTAssertEqual(rig.composer.text, "Fix the login\nRun the tests")
    XCTAssertEqual(rig.composer.textView.selectedRange, NSRange(location: (rig.composer.text as NSString).length, length: 0))
    XCTAssertTrue(rig.outputs[0].contains("under the user's text"), rig.outputs[0])
    rig.socket.reply(created("r2"))
    rig.socket.reply(done("r2"))
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.promptInField))

    rig.controller.dictation.status.noticeEdit()
    XCTAssertEqual(rig.status, UICopy.voiceAgentStatus(.promptInField), "an edit does not hide a running row")
    rig.end()
  }

  /// A read-only field refuses the prompt: the text stays as it was and the model hears why.
  func testReadOnlyFieldRefusesThePrompt() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.text = "Mine"
    rig.composer.isEditable = false
    rig.showPrompt("Run the tests")
    let answered = await waitUntil { rig.outputs.count == 1 }
    XCTAssertTrue(answered)
    XCTAssertEqual(rig.composer.text, "Mine")
    XCTAssertTrue(rig.outputs[0].contains("read-only"), rig.outputs[0])
    rig.end()
  }

  /// The field goes away (a state card or the decision dock takes its place): the conversation ends and the row
  /// says why; the button is a ring again.
  func testHiddenFieldEndsTheConversation() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.composer.isHidden = true
    rig.controller.renderVoiceAgent(rig.store.state)
    XCTAssertEqual(rig.controller.voiceAgentChrome.session?.closedBy, .fieldHidden)
    XCTAssertEqual(rig.status, UICopy.voiceAgentClosed(.fieldHidden))
    XCTAssertNil(rig.button.fill)
    XCTAssertTrue(rig.socket.closed)
    XCTAssertEqual(rig.audio.stops, 1)
  }

  /// Catches a conversation at the session screen that its length limit does not end, or that ends without its
  /// sentence in the row.
  func testLengthLimitEndsTheConversationWithItsSentence() async throws {
    let rig = try Rig()
    defer { rig.close() }
    try await rig.ready()
    rig.scheduler.advance(VoiceAgentSession.sessionLimit)
    XCTAssertEqual(rig.status, UICopy.voiceAgentEnd(.sessionLimit))
    XCTAssertNil(rig.button.fill)
    XCTAssertTrue(rig.socket.closed)
    XCTAssertEqual(rig.audio.stops, 1)
  }

  // MARK: - Background

  /// Catches a conversation at the session screen that outlives its tile removed while the app is in the
  /// background: the store's state does not change then, so the screen must follow the background rule itself.
  func testTileRemovedInTheBackgroundEndsTheConversation() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.store.voiceAgent.background.tile(shown: true)
    let session = try await backgroundReady(rig)
    rig.store.voiceAgent.background.tile(shown: false)
    try await expectEndedByBackground(rig, session)
  }

  /// Catches a device without tiles (an iPad) whose conversation at the session screen ends at an app switch, or
  /// outlives the screen lock that comes while the app is in the background with no other change.
  func testWithoutTilesTheLockEndsTheConversation() async throws {
    let rig = try Rig()
    defer { rig.close() }
    let rule = BackgroundRecording(noTiles: true)
    rig.store.attachVoiceAgent(VoiceAgentSettings(preferences: .memory(), background: rule))
    rig.store.voiceAgent.acceptConsent()
    let session = try await backgroundReady(rig)
    rig.store.voiceAgent.background.screenLocked()
    try await expectEndedByBackground(rig, session)
  }

  /// Catches a tile removal that a render waiting behind the screen's render throttle swallows: the conversation
  /// must end from the rule's change, not wait for a later change of the store.
  func testTileRemovedWithARenderPendingEndsTheConversation() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.store.voiceAgent.background.tile(shown: true)
    let session = try await backgroundReady(rig)
    rig.controller.renderNow()
    rig.controller.scheduleRender()
    rig.store.voiceAgent.background.tile(shown: false)
    try await expectEndedByBackground(rig, session)
  }

  /// A ready conversation, then the app in the background (the screen's own notification) with the rule keeping it.
  private func backgroundReady(_ rig: Rig) async throws -> VoiceAgentSession {
    try await rig.ready()
    let session = try XCTUnwrap(rig.controller.voiceAgentChrome.session)
    XCTAssertTrue(session.isReady, "the microphone records")
    TranscriptAppPhase.isBackground = { true }
    addTeardownBlock { @MainActor in
      TranscriptAppPhase.isBackground = { UIApplication.shared.applicationState == .background }
    }
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    try? await Task.sleep(for: .milliseconds(150))
    XCTAssertTrue(session.isActive, "the background keeps the conversation while the rule keeps it")
    XCTAssertFalse(rig.socket.closed)
    XCTAssertEqual(rig.audio.stops, 0)
    return session
  }

  private func expectEndedByBackground(_ rig: Rig, _ session: VoiceAgentSession) async throws {
    let ended = await waitUntil { !session.isActive }
    XCTAssertTrue(ended, "the rule's change alone ends the conversation")
    XCTAssertEqual(session.closedBy, .background)
    XCTAssertTrue(rig.socket.closed)
    XCTAssertEqual(rig.audio.stops, 1)
  }
}

// MARK: - Fakes and events (`VoiceAgentRig.swift`)

private typealias Rig = VoiceAgentRig
private let speechStarted = VoiceAgentEvents.speechStarted
private let speechStopped = VoiceAgentEvents.speechStopped
private func committed(_ item: String) -> String { VoiceAgentEvents.committed(item) }
private func created(_ id: String) -> String { VoiceAgentEvents.created(id) }
private func done(_ id: String) -> String { VoiceAgentEvents.done(id) }
private func loudPCM(_ samples: Int) -> Data { VoiceAgentEvents.loudPCM(samples) }

@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
  await VoiceAgentEvents.waitUntil(condition)
}
