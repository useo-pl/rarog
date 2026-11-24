import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The voice conversation drawn on an Inbox card, on the real screen with a conversation on fakes: the agent button
/// stands in the reply row, the conversation puts the voice strip with Mute and End in place of that row, the prompt
/// block stands above it and edits in place, the end of the conversation hands the block's text to the card's field
/// or, with the Inbox left, to the session's draft, and a decision card has the button in its own row under the
/// decision. The views are driven through their accessibility elements, as a tap or VoiceOver would. With
/// `RAROG_LIST_SNAPSHOT_DIR` the tests also write `inbox-voice-*.png`.
extension InboxScreenTests {
  /// At rest the agent button stands in the reply row beside ↑; the conversation replaces the row with the strip,
  /// whose microphone mutes and whose End ends it.
  func testConversationReplacesTheReplyRowWithTheStrip() async throws {
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(voice, cards: [Rig.Card("a", minute: 3), Self.decisionCard("b", minute: 2)])
    try rig.pendingPermission("b")
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    _ = await Self.waitUntil { rig.store.state.inboxItems.allSatisfy { $0.card != nil } }
    Self.spin()
    let button = try Self.frame("inbox.voice.a", in: window)
    let send = try Self.frame("inbox.replySend.a", in: window)
    XCTAssertEqual(button.midY, send.midY, accuracy: 2, "the agent button stands in the reply row")
    XCTAssertLessThan(button.maxX, send.minX, "left of ↑")
    XCTAssertLessThan(try Self.frame("inbox.replyMic.a", in: window).maxX, button.minX, "right of the mic")
    try Self.snapshot(window, "inbox-voice-main")

    try Self.activate("inbox.voice.a", in: window)
    try await voice.listening(rig, rig.voice(in: window), card: "a")
    Self.spin()
    XCTAssertNil(Self.element("inbox.replySend.a", in: window), "the strip takes the reply row's place")
    XCTAssertNotNil(Self.element("inbox.voiceStrip.a", in: window), "the strip stands")
    let end = try XCTUnwrap(Self.element("inbox.voiceEnd.a", in: window), "End stands in the strip's row")
    XCTAssertEqual(end.accessibilityLabel, UICopy.voiceAgentEndButton)
    try Self.snapshot(window, "inbox-voice-listening")

    try Self.activate("inbox.voiceEnd.a", in: window)
    let ended = await Self.waitUntil { !rig.voice(in: window).isActive }
    XCTAssertTrue(ended, "End ends the conversation")
    Self.spin()
    XCTAssertNotNil(Self.element("inbox.replySend.a", in: window), "the reply row is back")
    XCTAssertNil(Self.element("inbox.voiceStrip.a", in: window))
  }

  /// The microphone of the strip mutes the conversation, and the card's VoiceOver action does the same.
  func testMicInTheConversationMutesAlsoAsAVoiceOverAction() async throws {
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(voice, cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    let owner = rig.voice(in: window)
    owner.toggle(try rig.card("a"))
    try await voice.listening(rig, owner, card: "a")
    Self.spin()
    XCTAssertNil(Self.element("inbox.replyMic.a", in: window), "no dictation mic in the conversation")
    let mute = try XCTUnwrap(Self.element("inbox.voiceMute.a", in: window), "the mute button")
    XCTAssertEqual(mute.accessibilityLabel, UICopy.voiceAgentMute)

    try Self.activate("inbox.voiceMute.a", in: window)
    XCTAssertTrue(owner.muted, "the mic mutes the conversation")
    XCTAssertEqual(Self.element("inbox.voiceMute.a", in: window)?.accessibilityLabel, UICopy.voiceAgentUnmute)

    let card = try XCTUnwrap(Self.element("inbox.card.a", in: window), "the card")
    XCTAssertTrue(Self.perform(UICopy.voiceAgentUnmute, on: card), "the card's VoiceOver action")
    Self.spin()
    XCTAssertFalse(owner.muted, "the VoiceOver action turns the microphone back on")
    XCTAssertTrue(owner.isActive, "the conversation goes on")
  }

  /// The prompt block stands above the strip with the read part lit; Edit turns the same block into a field with the
  /// agent's text, Cancel goes back to the text, and Send sends the person's edited text to the card's session.
  func testEditTurnsTheBlockIntoAFieldAndSendSendsTheEditedText() async throws {
    let sent = Recorder()
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(
      voice, cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, upload throws(TransportError) in
        let body = try? JSONSerialization.jsonObject(with: Self.data(upload)) as? [String: Any]
        await sent.add("\(sessionId):\(body?["text"] as? String ?? "?")")
        return nil
      }))
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    let owner = rig.voice(in: window)
    owner.toggle(try rig.card("a"))
    try await voice.listening(rig, owner, card: "a")
    try await voice.showPrompt(Self.prompt, owner: owner)
    // The fake audio never plays, so the read-along stands still; the highlight of the screenshot is set here.
    owner.readProgress = ReadingProgress(spokenPrefix: 44, end: nil)
    Self.spin()
    let block = try Self.frame("inbox.prompt.a", in: window)
    let strip = try Self.frame("inbox.voiceStrip.a", in: window)
    XCTAssertLessThan(block.maxY, strip.minY + 1, "the block stands above the strip")
    try Self.snapshot(window, "inbox-voice-prompt")

    try Self.activate("inbox.promptEdit.a", in: window)
    XCTAssertEqual(owner.block?.phase, .editing, "Edit edits the block")
    XCTAssertTrue(Self.hasField(Self.prompt, in: window), "the same block is a field with the agent's text")
    try Self.activate("inbox.promptCancel.a", in: window)
    XCTAssertEqual(owner.block?.phase, .ready, "Cancel goes back")
    XCTAssertNil(owner.block?.edited)
    XCTAssertFalse(Self.hasField(Self.prompt, in: window), "no field after Cancel")
    XCTAssertNotNil(Self.element("inbox.prompt.a", in: window), "the block stands")

    try Self.activate("inbox.promptEdit.a", in: window)
    let edited = Self.prompt + " Also add a changelog line."
    let field = try XCTUnwrap(
      Self.views(UITextView.self, in: window).first { $0.isEditable && $0.text == Self.prompt }, "the block's field")
    field.selectedRange = NSRange(location: (field.text as NSString).length, length: 0)
    field.insertText(" Also add a changelog line.")
    Self.spin()
    XCTAssertEqual(owner.block?.edited, edited, "typing in the block's field edits it")
    try Self.snapshot(window, "inbox-voice-edited")
    try Self.activate("inbox.promptSend.a", in: window)
    let delivered = await Self.waitUntil { await sent.values.count == 1 }
    let values = await sent.values
    XCTAssertTrue(delivered, "the block's Send went out: \(values)")
    XCTAssertEqual(values, ["a:\(edited)"], "the edited text goes, once")
    XCTAssertEqual(rig.replies(in: window).field(try rig.card("a")).text, "", "nothing in the card's field")
  }

  /// A Send of the block that comes back (the session stopped on a dialog) leaves the block with its text and shows
  /// why under it; nothing went out.
  func testRefusedSendShowsTheReasonInTheBlock() async throws {
    let sent = Recorder()
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(
      voice, cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
        await sent.add(sessionId)
        return nil
      }))
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    let owner = rig.voice(in: window)
    owner.toggle(try rig.card("a"))
    try await voice.listening(rig, owner, card: "a")
    try await voice.showPrompt(Self.prompt, owner: owner)
    Self.spin()
    let dialog = Rig.Card("a", minute: 1, state: "waiting-permission")
    try Rig.frame(rig.store, #"{"type":"session-changed","session":\#(dialog.summary)}"#)
    Self.spin()
    try Self.activate("inbox.promptSend.a", in: window)
    let back = await Self.waitUntil { owner.block?.reason != nil }
    XCTAssertTrue(back, "the refusal came back to the block")
    Self.spin()
    XCTAssertEqual(owner.block?.shownText, Self.prompt, "the block keeps its text")
    XCTAssertNotNil(Self.element("inbox.promptReason.a", in: window), "the reason stands in the block")
    let none = await sent.values
    XCTAssertEqual(none, [], "nothing went out")
  }

  /// The end of the conversation with a block on screen puts the block's text into the card's reply field.
  func testEndOfTheConversationPutsTheBlockInTheField() async throws {
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(voice, cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    let owner = rig.voice(in: window)
    owner.toggle(try rig.card("a"))
    try await voice.listening(rig, owner, card: "a")
    try await voice.showPrompt(Self.prompt, owner: owner)
    Self.spin()
    try Self.activate("inbox.voiceEnd.a", in: window)
    let ended = await Self.waitUntil { !owner.isActive }
    XCTAssertTrue(ended, "End ends the conversation")
    Self.spin()
    XCTAssertNil(owner.block)
    XCTAssertEqual(rig.replies(in: window).field(try rig.card("a")).text, Self.prompt)
    XCTAssertTrue(Self.hasField(Self.prompt, in: window), "the card's field shows the block's text")
  }

  /// Leaving the Inbox with a block ends the conversation, and the block's text goes to the session's draft.
  func testLeavingTheInboxPutsTheBlockInTheDraft() async throws {
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(voice, cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    let owner = rig.voice(in: window)
    owner.toggle(try rig.card("a"))
    try await voice.listening(rig, owner, card: "a")
    try await voice.showPrompt(Self.prompt, owner: owner)
    rig.navigation.openList()
    let ended = await Self.waitUntil { !owner.isActive }
    XCTAssertTrue(ended, "leaving the Inbox ends the conversation")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, Self.prompt, "the session's draft holds the block's text")
  }

  /// A decision card has the agent button in its own row under the decision buttons, never inside the permission
  /// card; its conversation puts the strip there, and the decision stays.
  func testVoiceButtonOnADecisionCardStandsInItsOwnRow() async throws {
    let voice = InboxVoiceFakes()
    let rig = try Self.voiceRig(voice, cards: [Rig.Card("a", minute: 1), Self.decisionCard("b", minute: 2)])
    try rig.pendingPermission("b")
    let window = rig.screenWindow(voice: voice.make)
    defer { window.isHidden = true }
    _ = await Self.waitUntil { rig.store.state.inboxItems.allSatisfy { $0.card != nil } }
    Self.spin()
    let allow = try Self.frame("card.allow", in: window)
    let button = try Self.frame("inbox.voice.b", in: window)
    XCTAssertGreaterThanOrEqual(button.minY, allow.maxY - 1, "the button stands under the decision buttons")
    let permission = try Self.frame("card.permission.p1", in: window)
    XCTAssertFalse(permission.contains(CGPoint(x: button.midX, y: button.midY)), "outside the permission card")

    try Self.activate("inbox.voice.b", in: window)
    try await voice.listening(rig, rig.voice(in: window), card: "b", permission: true)
    Self.spin()
    XCTAssertNotNil(Self.element("inbox.voiceStrip.b", in: window), "the strip stands on the decision card")
    XCTAssertNotNil(Self.element("card.allow", in: window), "the decision stays")
    XCTAssertGreaterThanOrEqual(
      try Self.frame("inbox.voiceStrip.b", in: window).minY, try Self.frame("card.allow", in: window).maxY - 1)
    try Self.snapshot(window, "inbox-voice-decision")
  }

  // MARK: - Voice rig

  static let prompt = "Update README.md: describe the token refresh and the new AUTH_REFRESH_TTL variable."

  static func decisionCard(_ id: String, minute: Int) -> Rig.Card {
    Rig.Card(
      id, minute: minute, kind: "decision", state: "waiting-permission", text: "Run `pnpm test` in atlas/web?",
      dialog: #"{"kind":"permission","requestId":"p1"}"#)
  }

  /// The Inbox rig with the voice agent offered: consent, a server with the voice agent and its speech, and the keys.
  static func voiceRig(
    _ voice: InboxVoiceFakes, cards: [Rig.Card], transport: UIKitTransport = UIKitTransport()
  ) throws -> Rig {
    enableAccessibility()
    var transport = transport
    transport.onCompanionToken = { () throws(TransportError) -> CompanionToken in
      try InboxVoiceFakes.decode(
        #"{"value":"ek_test_inbox","expiresAt":"2099-01-01T00:00:00.000Z","model":"gpt-realtime-2.1"}"#)
    }
    transport.onCompanionSpeechToken = { () throws(TransportError) -> CompanionSpeechToken in
      try InboxVoiceFakes.decode(
        #"{"apiKey":"snx_temp_inbox","expiresAt":"2099-01-01T00:00:00.000Z","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#)
    }
    let rig = try Rig(cards: cards, transport: transport)
    rig.store.voiceAgent.acceptConsent()
    let version = #"""
      {"version":"1.0.0","protocolVersion":3,"serverStartId":"test","capabilities":["inbox"],
       "companionEnabled":true,"companionSpeech":true}
      """#
    rig.store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    return rig
  }

  /// SwiftUI builds the accessibility elements of a hosted view only for an accessibility client (VoiceOver, UI
  /// automation). The test process turns automation on, as UI test tools do, so the card's buttons are elements the
  /// test finds and activates as VoiceOver would.
  static func enableAccessibility() {
    guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
      let symbol = dlsym(library, "_AXSSetAutomationEnabled")
    else { return XCTFail("the accessibility library") }
    typealias SetEnabled = @convention(c) (Int32) -> Void
    unsafeBitCast(symbol, to: SetEnabled.self)(1)
    if let application = dlsym(library, "_AXSApplicationAccessibilitySetEnabled") {
      unsafeBitCast(application, to: SetEnabled.self)(1)
    }
  }

  static func frame(_ identifier: String, in window: UIWindow) throws -> CGRect {
    try XCTUnwrap(element(identifier, in: window), identifier).accessibilityFrame
  }

  /// A tap through the element's accessibility activation, as VoiceOver's double tap.
  static func activate(_ identifier: String, in window: UIWindow) throws {
    let element = try XCTUnwrap(element(identifier, in: window), identifier)
    XCTAssertTrue(element.accessibilityActivate(), "\(identifier) activates")
    spin()
  }

  /// Performs the element's VoiceOver action named `name`; `false` when it has none.
  static func perform(_ name: String, on element: NSObject) -> Bool {
    guard let action = element.accessibilityCustomActions?.first(where: { $0.name == name }) else { return false }
    if let handler = action.actionHandler { return handler(action) }
    guard let target = action.target as? NSObject else { return false }
    _ = target.perform(action.selector, with: action)
    return true
  }
}

extension InboxScreenTests.Rig {
  func voice(in window: UIWindow) -> VoiceAgentInboxConversation {
    controller(in: window)!.voice
  }
}

/// The cards' voice conversation on fakes for the Inbox screen: Realtime and Soniox sockets, audio and a clock moved
/// by hand (`VoiceAgentRig.swift`), its own microphone, and the store as the route to Rarog.
@MainActor
final class InboxVoiceFakes {
  private(set) var sockets: [VoiceAgentRowSocket] = []
  private(set) var speechSockets: [VoiceAgentRowSocket] = []
  let audio = VoiceAgentRowAudio()
  let scheduler = VoiceAgentRowScheduler()
  let microphone = DictationCenter()

  var socket: VoiceAgentRowSocket { sockets[sockets.count - 1] }

  /// The screen's factory of the conversation.
  func make(_ store: RarogStore, _ drafts: ComposerDrafts) -> VoiceAgentInboxConversation {
    VoiceAgentInboxConversation(
      backend: store, settings: store.voiceAgent, sonioxAllowed: true, drafts: drafts, microphone: microphone,
      scheduler: scheduler,
      dependencies: { [unowned self] keys in
        RealtimeConversation.Dependencies(
          keys: keys,
          socket: { _, events in
            let socket = VoiceAgentRowSocket(events: events)
            self.sockets.append(socket)
            return socket
          },
          audio: self.audio, scheduler: self.scheduler,
          speech: RealtimeConversation.Speech(
            keys: keys,
            socket: { _, _, events in
              let socket = VoiceAgentRowSocket(events: events)
              self.speechSockets.append(socket)
              return socket
            }))
      })
  }

  /// The started conversation of `card` gets its fresh transcript snapshot (with the pending permission `p1` of a
  /// decision card), its sockets open, and it listens.
  func listening(
    _ rig: InboxScreenTests.Rig, _ owner: VoiceAgentInboxConversation, card: String, permission: Bool = false
  ) async throws {
    let before = sockets.count
    let pending = permission
      ? #"""
        {"permId":"p1","sessionId":"\#(card)","toolName":"Shell","displayText":"npm test","risk":"normal",
         "cwd":"/Users/demo/rarog","createdAt":"2026-10-06T10:00:00.000Z"}
        """#
      : ""
    rig.store.dispatch(.viewSession(card))
    rig.store.dispatch(.streamOpened(.session(id: card), resumedWithCursor: false))
    try InboxScreenTests.Rig.frame(
      rig.store, #"""
        {"type":"transcript-snapshot","sessionId":"\#(card)","messages":[],
         "pendingPermissions":[\#(pending)],"pendingQuestions":[]}
        """#, source: .session(card))
    let opened = await VoiceAgentEvents.waitUntil { self.sockets.count == before + 1 }
    XCTAssertTrue(opened, "the Realtime socket")
    guard opened else { throw CancellationError() }
    speechSockets.last?.events.opened()
    socket.events.opened()
    socket.reply(#"{"type":"session.updated","session":{}}"#)
    let listening = await VoiceAgentEvents.waitUntil { owner.indicator == .listening }
    XCTAssertTrue(listening, "the conversation listens")
  }

  /// The person's utterance, then the model's `show_prompt` with `text`: the block stands.
  func showPrompt(_ text: String, owner: VoiceAgentInboxConversation) async throws {
    socket.reply(VoiceAgentEvents.speechStarted)
    socket.reply(VoiceAgentEvents.speechStopped)
    socket.reply(VoiceAgentEvents.committed("in1"))
    socket.reply(VoiceAgentEvents.created("r1"))
    socket.reply(
      VoiceAgentEvents.call("r1", id: "c-r1", name: "show_prompt", arguments: #"{"text":"\#(text)"}"#))
    socket.reply(VoiceAgentEvents.done("r1"))
    let shown = await VoiceAgentEvents.waitUntil { owner.block != nil }
    XCTAssertTrue(shown, "the block stands")
  }

  nonisolated static func decode<T: Decodable>(_ json: String) throws(TransportError) -> T {
    do {
      return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    } catch {
      throw .invalidResponse("voice key")
    }
  }
}
