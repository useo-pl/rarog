import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Dictation into the reply field of an Inbox result card on the real Inbox screen and a real store, with the
/// scripted microphone and a Soniox socket driven by the test: the mic records straight into the card's field, ↑ during
/// a recording waits for the last words and sends once, the asking route opens the Dictation sheet, the background and
/// leaving the Inbox end the recording with the text in the session's draft, a typed character and a reply that came
/// back during a recording are neither doubled nor overwritten, and the card's voice conversation keeps the microphone.
/// Owner: Inbox.
@MainActor
final class InboxDictationTests: XCTestCase {
  // MARK: - Recording

  /// The mic's tap at the Soniox route records into the card's field, and a second tap ends the recording with its
  /// last words in the field.
  func testMicRecordsIntoTheCardField() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(Rig.hypothesis)
    let shown = await rig.until { rig.text == "Dyktuję z" }
    XCTAssertTrue(shown, "the hypothesis is in the card's field: \(rig.text)")
    XCTAssertTrue(rig.host.dictation.records("a"))

    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    try await rig.finish(socket, tail: " z iPada.")
    XCTAssertEqual(rig.text, "Dyktuję z iPada.")
    XCTAssertEqual(rig.microphones, 1)
  }

  /// ↑ during a recording ends it, waits for the last words and sends the whole text once, also when tapped twice.
  func testSendDuringRecordingWaitsForTheTailAndSendsOnce() async throws {
    let sent = Sent()
    let rig = try Rig(transport: UIKitTransport(onSend: { sessionId, upload throws(TransportError) in
      let body = try? JSONSerialization.jsonObject(with: InboxScreenTests.data(upload)) as? [String: Any]
      await sent.add("\(sessionId):\(body?["text"] as? String ?? "?")")
      return nil
    }))
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(Rig.hypothesis)
    _ = await rig.until { rig.text == "Dyktuję z" }

    rig.host.send(try rig.card(), store: rig.store)
    rig.host.send(try rig.card(), store: rig.store)
    var early = await sent.values
    XCTAssertEqual(early, [], "↑ waits for the last words")
    try await rig.finish(socket, tail: " z iPada.")
    let delivered = await rig.until { await sent.values.count == 1 }
    XCTAssertTrue(delivered, "the reply went out")
    try await Task.sleep(for: .milliseconds(300))
    early = await sent.values
    XCTAssertEqual(early, ["a:Dyktuję z iPada."], "the whole text, once")
    XCTAssertEqual(rig.text, "", "↑ emptied the field")
  }

  /// ↑ on card a waits for its last words and the mic of card b is tapped meanwhile: a's reply goes at once with what
  /// a's field holds, once, b records into its own field, and nothing of a's stream lands anywhere afterwards.
  func testSwitchingCardsWhileTheSendWaitsForTheTail() async throws {
    let sent = Sent()
    let rig = try Rig(
      transport: UIKitTransport(onSend: { sessionId, upload throws(TransportError) in
        let body = try? JSONSerialization.jsonObject(with: InboxScreenTests.data(upload)) as? [String: Any]
        await sent.add("\(sessionId):\(body?["text"] as? String ?? "?")")
        return nil
      }),
      cards: ["a", "b"])
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card("a"), navigation: rig.navigation)
    let first = try await rig.socket()
    first.reply(Rig.hypothesis)
    _ = await rig.until { rig.text == "Dyktuję z" }
    rig.host.send(try rig.card("a"), store: rig.store)
    let stopped = await rig.until { first.texts.contains("") || first.closed }
    XCTAssertTrue(stopped, "↑ ended the audio and waits for the last words")
    var values = await sent.values
    XCTAssertEqual(values, [], "nothing went before the switch")

    rig.host.toggleDictation(try rig.card("b"), navigation: rig.navigation)
    let delivered = await rig.until { await sent.values.count == 1 }
    XCTAssertTrue(delivered, "a's reply went at the switch, not at b's end")
    XCTAssertTrue(first.closed, "a's stream went down")
    first.reply(#"{"tokens":[{"text":" z iPada.","is_final":true}]}"#)
    let second = try await rig.socket(2)
    second.reply(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
    let recorded = await rig.until { rig.text(of: "b") == "Dyktuję" }
    XCTAssertTrue(recorded, "b records into its own field: \(rig.text(of: "b"))")
    XCTAssertTrue(rig.host.dictation.records("b"))
    XCTAssertEqual(rig.text, "", "↑ emptied a's field and a's late words went nowhere")
    try await Task.sleep(for: .milliseconds(300))
    values = await sent.values
    XCTAssertEqual(values, ["a:Dyktuję z"], "what a's field held, once")
  }

  /// No dictation choice yet: the tap opens the Dictation sheet and records nothing.
  func testAskingRouteOpensTheDictationSheet() async throws {
    let rig = try Rig(choice: nil)
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    XCTAssertNotNil(rig.navigation.dictationSheet, "the Dictation sheet")
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(rig.microphones, 0, "nothing records")
    XCTAssertFalse(rig.host.dictation.records("a"))
  }

  // MARK: - Ends

  /// The app going to the background ends the recording; its last words are in the session's draft at once, without
  /// waiting for the typing pause, which may never come before the app sleeps.
  func testBackgroundEndsTheRecordingWithTheTextInTheDraft() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(Rig.hypothesis)
    _ = await rig.until { rig.text == "Dyktuję z" }

    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    try await rig.finish(socket, tail: " z iPada.")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, "Dyktuję z iPada.", "the draft holds the whole text")
  }

  /// Leaving the Inbox during a recording: the hypothesis becomes the field's text and goes to the session's draft, and
  /// nothing the socket says afterwards lands anywhere.
  func testLeavingTheInboxKeepsTheTextInTheDraft() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(Rig.hypothesis)
    _ = await rig.until { rig.text == "Dyktuję z" }

    rig.host.screenDisappeared()
    XCTAssertFalse(rig.host.dictation.records("a"), "the recording ended")
    XCTAssertTrue(socket.closed, "the stream went down")
    socket.reply(#"{"tokens":[{"text":" później","is_final":true}]}"#)
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.take(for: "a")?.text, "Dyktuję z")
  }

  // MARK: - Changes of the field during a recording

  /// A character typed in the real field during a recording is the person's: the next words come after it, not over
  /// it.
  func testTypingDuringRecordingKeepsTheTypedText() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
    _ = await rig.until { rig.text == "Dyktuję" }
    InboxScreenTests.spin()
    let field = try XCTUnwrap(
      InboxScreenTests.views(UITextView.self, in: rig.window).first { $0.isEditable && $0.text == "Dyktuję" },
      "the card's field shows the dictated text")
    XCTAssertTrue(field.becomeFirstResponder())
    field.selectedRange = NSRange(location: (field.text as NSString).length, length: 0)
    field.insertText(" ręcznie")
    InboxScreenTests.spin()
    XCTAssertEqual(rig.text, "Dyktuję ręcznie")

    socket.reply(#"{"tokens":[{"text":" dalej","is_final":true}]}"#)
    let next = await rig.until { rig.text.hasSuffix("dalej") }
    XCTAssertTrue(next, "the next words came: \(rig.text)")
    XCTAssertEqual(rig.text, "Dyktuję ręcznie dalej", "after the typed text, nothing doubled")
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    try await rig.finish(socket, tail: nil)
    XCTAssertEqual(rig.text, "Dyktuję ręcznie dalej")
  }

  /// A reply refused while a new recording runs comes back on top of the dictated text, and the next words go after
  /// both: the returned text is not overwritten by the recording, nor the dictated text doubled.
  func testReplyBackDuringRecordingStaysOnTop() async throws {
    let gate = AsyncStream<Void>.makeStream()
    let sent = Sent()
    let rig = try Rig(transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
      await sent.add(sessionId)
      for await _ in gate.stream { break }
      throw .http(APIFailure(status: 409, code: "conflict", message: "Test: refused."))
    }))
    defer { rig.close() }
    rig.host.edit(try rig.card(), "Ship it")
    rig.host.send(try rig.card(), store: rig.store)
    let inFlight = await rig.until { await sent.values.count == 1 }
    XCTAssertTrue(inFlight, "the reply is on its way")

    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
    _ = await rig.until { rig.text == "Dyktuję" }
    gate.continuation.yield()
    let back = await rig.until { rig.text.hasPrefix("Ship it") }
    XCTAssertTrue(back, "the refused reply came back: \(rig.text)")
    XCTAssertEqual(rig.text, "Ship it\nDyktuję")

    socket.reply(#"{"tokens":[{"text":" dalej","is_final":true}]}"#)
    let next = await rig.until { rig.text.hasSuffix("dalej") }
    XCTAssertTrue(next, "the next words came: \(rig.text)")
    XCTAssertEqual(rig.text, "Ship it\nDyktuję dalej")
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    try await rig.finish(socket, tail: nil)
    XCTAssertEqual(rig.text, "Ship it\nDyktuję dalej")
  }

  /// A text that came into the session's draft during a recording (a queue take-back) joins the field on top at the
  /// next draft write, and the next words go after the dictated text: nothing doubled, nothing written over.
  func testDraftTextJoinsDuringRecordingOnTop() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
    _ = await rig.until { rig.text == "Dyktuję" }
    // The typing pause's write of the dictated text goes first, so the field holds the draft.
    try await Task.sleep(for: SessionViewController.draftDebounce * 2)
    let saved = await rig.drafts.saveTaken("Ship it", for: "a")
    XCTAssertTrue(saved)

    socket.reply(#"{"tokens":[{"text":" dalej","is_final":true}]}"#)
    let joined = await rig.until { rig.text.hasPrefix("Ship it") }
    XCTAssertTrue(joined, "the waiting text joined the field: \(rig.text)")
    XCTAssertEqual(rig.text, "Ship it\nDyktuję dalej")
    socket.reply(#"{"tokens":[{"text":" ręcznie","is_final":true}]}"#)
    let next = await rig.until { rig.text.hasSuffix("ręcznie") }
    XCTAssertTrue(next, "the next words came: \(rig.text)")
    XCTAssertEqual(rig.text, "Ship it\nDyktuję dalej ręcznie")
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    try await rig.finish(socket, tail: nil)
    XCTAssertEqual(rig.text, "Ship it\nDyktuję dalej ręcznie")
  }

  /// The system's speech recognition: the person edits the field while the recording finishes. The edit ends the
  /// recording there and stands; the final result neither writes the field over nor doubles it.
  func testSystemDictationEditWhileFinishingKeepsTheEdit() async throws {
    let rig = try Rig(choice: .system, finalizeTimeout: ScriptedVoice.tailDelay + 2)
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let partial = await rig.until { rig.text == ScriptedVoice.systemPartial }
    XCTAssertTrue(partial, "the hypothesis is in the card's field: \(rig.text)")
    XCTAssertEqual(rig.sockets.count, 0, "the system route opens no Soniox socket")

    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    XCTAssertEqual(rig.host.dictation.view.phase, .finalizing, "the recording waits for its last words")
    // The audio's end reaches the recognizer once the microphone flushed; the final result comes well after.
    try await Task.sleep(for: .milliseconds(200))
    let edited = ScriptedVoice.systemPartial + " ręcznie"
    rig.host.edit(try rig.card(), edited)
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertFalse(rig.host.dictation.records("a"), "the edit ends the finishing recording at once")
    XCTAssertEqual(rig.text, edited)
    try await Task.sleep(for: .seconds(ScriptedVoice.tailDelay + 0.5))
    XCTAssertEqual(rig.text, edited, "the final result lands nowhere")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, edited)
  }

  // MARK: - Voice conversation of the card

  /// While the card's voice conversation runs (here: connecting), its mic neither records nor ends the conversation.
  func testMicDuringTheCardConversationNeitherRecordsNorEndsIt() async throws {
    let rig = try Rig(voiceAgent: true)
    defer { rig.close() }
    rig.voice.toggle(try rig.card())
    InboxScreenTests.spin()
    XCTAssertTrue(rig.voice.isActive, "the conversation connects")

    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(rig.microphones, 0, "nothing records")
    XCTAssertFalse(rig.host.dictation.records("a"))
    XCTAssertTrue(rig.voice.isActive, "the conversation goes on")
    XCTAssertEqual(rig.voice.target, "a")
  }

  /// The card's voice conversation starting during a recording takes the microphone: the hypothesis stays in the
  /// field as its text, and in the session's draft.
  func testConversationStartDuringRecordingKeepsTheText() async throws {
    let rig = try Rig(voiceAgent: true)
    defer { rig.close() }
    rig.host.toggleDictation(try rig.card(), navigation: rig.navigation)
    let socket = try await rig.socket()
    socket.reply(Rig.hypothesis)
    _ = await rig.until { rig.text == "Dyktuję z" }

    rig.voice.toggle(try rig.card())
    XCTAssertTrue(rig.voice.isActive, "the conversation connects")
    XCTAssertFalse(rig.host.dictation.records("a"), "the recording ended")
    XCTAssertTrue(socket.closed)
    XCTAssertEqual(rig.text, "Dyktuję z", "the hypothesis is the field's text")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, "Dyktuję z")
  }

  // MARK: - Rig

  /// The Inbox screen with result cards (`a` by default) in a window, its reply host recording through the scripted
  /// microphone and sockets the test answers.
  @MainActor
  private final class Rig {
    static let hypothesis = #"{"tokens":[{"text":"Dyktuję","is_final":true},{"text":" z","is_final":false}]}"#
    private static func summary(_ id: String) -> String {
      #"""
        {"id":"\#(id)","cwd":"/Users/demo/rarog","title":"rarog","label":"session \#(id)","state":"waiting-input",
         "seen":false,"stateSince":"2026-10-06T10:01:00.000Z","createdAt":"2026-10-06T09:00:00.000Z",
         "lastActivityAt":"2026-10-06T10:01:00.000Z"}
        """#
    }
    private static func head(_ id: String) -> String {
      #"""
        {"sessionId":"\#(id)","turnId":"t-\#(id)","version":"v1","kind":"result","state":"waiting-input",
         "at":"2026-10-06T10:01:00.000Z"}
        """#
    }
    nonisolated private static func cards(_ ids: [String]) -> String {
      let cards = ids.map { id in
        #"""
          {"sessionId":"\#(id)","turnId":"t-\#(id)","version":"v1","kind":"result","state":"waiting-input",
           "at":"2026-10-06T10:01:00.000Z","text":"Done. Tests pass.","truncated":false}
          """#
      }
      return #"{"cards":[\#(cards.joined(separator: ","))]}"#
    }
    private static let token = #"""
      {"apiKey":"snx_temp_test_a","expiresAt":"2026-08-23T12:00:00.000Z",
       "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
       "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
      """#

    let store: RarogStore
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let toasts = ToastCenter()
    let drafts = ComposerDrafts(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    let window: UIWindow
    let host: InboxReplyHost
    let voice: VoiceAgentInboxConversation
    private(set) var sockets: [VoiceAgentRowSocket] = []
    /// Microphones the recordings opened.
    private(set) var microphones = 0

    /// `cards`: the result cards' session ids; `finalizeTimeout`: the recording's wait for its last words.
    init(
      choice: DictationChoice? = .soniox, voiceAgent: Bool = false, transport: UIKitTransport = UIKitTransport(),
      cards ids: [String] = ["a"], finalizeTimeout: TimeInterval = 1
    ) throws {
      var transport = transport
      let list = Self.cards(ids)
      transport.onInboxCards = { () throws(TransportError) -> InboxList in
        do {
          return try JSONDecoder().decode(InboxList.self, from: Data(list.utf8))
        } catch {
          throw .invalidResponse("inbox cards")
        }
      }
      let token = try JSONDecoder().decode(VoiceToken.self, from: Data(Self.token.utf8))
      transport.onVoiceToken = { () throws(TransportError) -> VoiceToken in token }
      store = RarogStore(
        transport: transport, rules: MutationRules(),
        outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
      store.dispatch(.loggedIn)
      store.dispatch(.streamOpened(.global, resumedWithCursor: false))
      try Self.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
      let version = #"""
        {"version":"1.0.0","protocolVersion":3,"serverStartId":"test","capabilities":["inbox"],"voiceEnabled":true,
         "companionEnabled":true,"companionSpeech":true}
        """#
      store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
      let summaries = ids.map(Self.summary).joined(separator: ",")
      try Self.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(summaries)]}"#)
      try Self.frame(store, #"{"type":"inbox-heads","heads":[\#(ids.map(Self.head).joined(separator: ","))]}"#)
      store.attachDictation(.memory(sonioxAllowed: true, choice: choice))
      if voiceAgent { store.voiceAgent.acceptConsent() }

      navigation.openInbox()
      store.inboxOpened()
      window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
      window.rootViewController = UIHostingController(
        rootView: InboxScreen(store: store, drafts: drafts).environment(navigation).environment(toasts))
      window.makeKeyAndVisible()
      InboxScreenTests.spin()
      let controller = try XCTUnwrap(Self.controller(window.rootViewController), "the Inbox list")
      host = controller.replies
      voice = controller.voice
      host.dictation.services = services(finalizeTimeout: finalizeTimeout)
    }

    func close() {
      window.isHidden = true
    }

    private static func frame(_ store: RarogStore, _ json: String) throws {
      let event = try EventDecoder.decode(Data(json.utf8)).get().event
      store.dispatch(.frame(event, source: .global, cursor: nil))
    }

    private static func controller(_ controller: UIViewController?) -> InboxViewController? {
      guard let controller else { return nil }
      if let found = controller as? InboxViewController { return found }
      return controller.children.lazy.compactMap { Self.controller($0) }.first
    }

    private func services(finalizeTimeout: TimeInterval) -> VoiceServices {
      var timing = VoiceTiming()
      timing.reconnectDelays = [0.01, 0.01, 0.01]
      timing.minMintInterval = 0
      timing.finalizeTimeout = finalizeTimeout
      timing.stopConnectWait = 0.3
      let scheduler = TaskVoiceScheduler()
      return VoiceServices(
        microphone: { [weak self] in
          self?.microphones += 1
          return ScriptedMicrophone(scheduler: scheduler, denied: false)
        },
        connect: { [weak self] _, _, events in
          let socket = VoiceAgentRowSocket(events: events)
          self?.sockets.append(socket)
          Task { @MainActor in events.opened() }
          return socket
        },
        speech: { ScriptedSpeech(scheduler: scheduler) }, scheduler: scheduler, timing: timing, language: .pl,
        open: { _ in }, microphoneGranted: { true })
    }

    func card(_ id: String = "a") throws -> InboxCardModel {
      try XCTUnwrap(store.state.inboxCardModels.first { $0.id == id }, "card \(id)")
    }

    /// Card `a`'s reply field as its host keeps it.
    var text: String { text(of: "a") }

    /// The reply field of card `id` as its host keeps it.
    func text(of id: String) -> String {
      guard let card = try? card(id) else { return "" }
      return host.field(card).text
    }

    /// The Soniox socket of the `number`-th recording.
    func socket(_ number: Int = 1) async throws -> VoiceAgentRowSocket {
      let ready = await until { self.sockets.count == number }
      XCTAssertTrue(ready, "the Soniox socket")
      try await Task.sleep(for: .milliseconds(50))
      return try XCTUnwrap(sockets.last)
    }

    /// The end of the audio reached the socket: Soniox gives the tail and finishes; waits for the end of card `id`'s
    /// recording.
    func finish(_ socket: VoiceAgentRowSocket, tail: String?, card id: String = "a") async throws {
      let ended = await until { socket.texts.contains("") || socket.closed }
      XCTAssertTrue(ended, "the end of the audio: \(socket.texts.suffix(2))")
      if let tail { socket.reply(#"{"tokens":[{"text":"\#(tail)","is_final":true}]}"#) }
      socket.reply(#"{"finished":true}"#)
      let done = await until { !self.host.dictation.records(id) }
      XCTAssertTrue(done, "the recording ended")
    }

    func until(_ condition: @MainActor () async -> Bool) async -> Bool {
      await InboxScreenTests.waitUntil(condition)
    }
  }

  private actor Sent {
    private(set) var values: [String] = []
    func add(_ value: String) { values.append(value) }
  }
}
