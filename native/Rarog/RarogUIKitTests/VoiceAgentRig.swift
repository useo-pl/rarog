import Foundation
import RarogContract
@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

// A real session screen with a voice conversation on fakes, for the UIKit tests of the voice agent
// (`VoiceAgentRowTests`, `VoiceAgentFieldTests`): Realtime and Soniox sockets, audio, clock and route to Rarog, and
// the transport of `CommandSuggestionsKeysTests.Fixture` for sends. Owner: voice agent.

@MainActor
final class VoiceAgentRig {
  let store: RarogStore
  let controller: SessionViewController
  let backend: VoiceAgentRowBackend
  /// Sends that reached the transport; holds and failures on request (`CallLog.Calls`).
  let calls: CallLog
  let audio = VoiceAgentRowAudio()
  let scheduler = VoiceAgentRowScheduler()
  private let fixture: CommandSuggestionsKeysTests.Fixture
  private var sockets: [VoiceAgentRowSocket] = []
  private var speechSockets: [VoiceAgentRowSocket] = []

  /// The session screen in a window with the focus in the field (`CommandSuggestionsKeysTests.Fixture`), a
  /// transport that answers a send 202, and a server that offers the voice agent. `speech: false`: an older server
  /// that announces the voice agent without Soniox speech (`companionSpeech`), so the app does not offer it.
  init(state: String = "waiting-input", drafts: ComposerDrafts = ComposerDrafts(), speech: Bool = true) throws {
    fixture = try CommandSuggestionsKeysTests.Fixture(state: state, drafts: drafts)
    store = fixture.store
    controller = fixture.controller
    calls = fixture.calls
    store.voiceAgent.acceptConsent()
    // The server offers the voice agent (`companionEnabled`) with Soniox speech (`companionSpeech`).
    let version =
      #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"test","companionEnabled":true,"companionSpeech":\#(speech)}"#
    store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    backend = VoiceAgentRowBackend(loginEpoch: store.loginEpoch)
    controller.renderVoiceAgent(store.state)
  }

  func close() {
    controller.leaveVoiceAgent()
    fixture.close()
  }

  /// The send of `text` got the store's answer (202: the entry waits for its echo) and the screen handled it.
  func sendSettled(_ text: String) async {
    let accepted = await VoiceAgentEvents.waitUntil {
      self.store.state.outbox.contains { entry in
        guard entry.text == text, case .sent = entry.state else { return false }
        return true
      }
    }
    XCTAssertTrue(accepted, "accepted: \(text)")
    try? await Task.sleep(for: .milliseconds(50))
  }

  var composer: ComposerView { controller.composer }
  var button: RingButton { composer.voiceAgentButton }
  var barsHidden: Bool { controller.voiceAgentChrome.bars.isHidden }
  var socket: VoiceAgentRowSocket { sockets[sockets.count - 1] }

  /// Text of the status row; `nil` when the row is hidden.
  var status: String? {
    let row = controller.dictation.status
    guard !row.isHidden else { return nil }
    return labels(in: row).first { $0.accessibilityIdentifier == "composer.voice.status" }?.text
  }

  /// A conversation with fakes, wired to the screen like the button does, up to "Listening".
  func ready() async throws {
    let host = VoiceAgentSessionHost(sessionId: "s1", backend: backend)
    let session = VoiceAgentSession(
      host: host, backend: backend,
      dependencies: { [unowned self] keys in
        RealtimeConversation.Dependencies(
          keys: keys,
          socket: { request, events in
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
    controller.connectVoiceAgent(session, host: host)
    let before = sockets.count
    session.start()
    let opened = await VoiceAgentEvents.waitUntil { self.sockets.count == before + 1 }
    XCTAssertTrue(opened, "socket")
    speechSockets.last?.events.opened()
    socket.events.opened()
    socket.reply(#"{"type":"session.updated","session":{}}"#)
    let listening = await VoiceAgentEvents.waitUntil { session.phase == .listening }
    XCTAssertTrue(listening, "phase: \(session.phase)")
  }

  /// One utterance (`item`) whose answer (`response`) calls `show_prompt` with `text`.
  func showPrompt(_ text: String, response: String = "r1", item: String = "in1") {
    utterance(item)
    socket.reply(VoiceAgentEvents.created(response))
    socket.reply(
      VoiceAgentEvents.call(response, id: "c-\(response)", name: "show_prompt", arguments: #"{"text":"\#(text)"}"#))
    socket.reply(VoiceAgentEvents.done(response))
  }

  /// The user's utterance `item`: speech start, end and the closed input.
  func utterance(_ item: String) {
    socket.reply(VoiceAgentEvents.speechStarted)
    socket.reply(VoiceAgentEvents.speechStopped)
    socket.reply(VoiceAgentEvents.committed(item))
  }

  /// The answer the app orders after tool results, over at once.
  func answered(_ response: String) {
    socket.reply(VoiceAgentEvents.created(response))
    socket.reply(VoiceAgentEvents.done(response))
  }

  /// `show_prompt` with `text` in `r1`, its answer over, then the user's "yes, send it": the next call may send.
  func promptConfirmed(_ text: String) async {
    let before = outputs.count
    showPrompt(text)
    let placed = await VoiceAgentEvents.waitUntil { self.outputs.count == before + 1 }
    XCTAssertTrue(placed, "show_prompt answered")
    answered("r1f")
    utterance("in2")
  }

  /// The model calls `send_prompt` in `response`; the result it hears.
  func sendByVoice(response: String = "r2") async -> String {
    let before = outputs.count
    socket.reply(VoiceAgentEvents.created(response))
    socket.reply(VoiceAgentEvents.call(response, id: "c-\(response)", name: "send_prompt", arguments: "{}"))
    socket.reply(VoiceAgentEvents.done(response))
    let answered = await VoiceAgentEvents.waitUntil { self.outputs.count == before + 1 }
    XCTAssertTrue(answered, "send_prompt answered")
    return outputs.count > before ? outputs[before] : ""
  }

  /// Tool results sent to the model, in order.
  var outputs: [String] {
    socket.sent("conversation.item.create").compactMap { ($0["item"] as? [String: Any])?["output"] as? String }
  }

  func end() {
    controller.leaveVoiceAgent()
  }

  private func labels(in root: UIView) -> [UILabel] {
    root.subviews.flatMap { view in ((view as? UILabel).map { [$0] } ?? []) + labels(in: view) }
  }
}

@MainActor
final class VoiceAgentRowBackend: VoiceAgentBackend {
  let loginEpoch: Int

  init(loginEpoch: Int) {
    self.loginEpoch = loginEpoch
  }

  func companionToken() async -> CompanionTokenOutcome {
    let json = #"{"value":"ek_test_row","expiresAt":"2099-01-01T00:00:00.000Z","model":"gpt-realtime-2.1"}"#
    // swiftlint:disable:next force_try
    return .token(try! JSONDecoder().decode(CompanionToken.self, from: Data(json.utf8)))
  }

  /// The Soniox speech key the conversation asks for first.
  func companionSpeechToken() async -> CompanionSpeechTokenOutcome {
    let json =
      #"{"apiKey":"snx_temp_row","expiresAt":"2099-01-01T00:00:00.000Z","webSocketUri":"wss://tts-rt.eu.soniox.com/tts-websocket","model":"tts-rt-v2","voice":"Maya","sampleRate":24000}"#
    // swiftlint:disable:next force_try
    return .token(try! JSONDecoder().decode(CompanionSpeechToken.self, from: Data(json.utf8)))
  }

  func ask(sessionId: String, question: String) async -> CompanionAskOutcome { .disabled(message: nil) }
  func transcript(sessionId: String) -> [TranscriptMessage] { [] }
  func trace(_ line: String, budget: TraceBudget) {}
}

@MainActor
final class VoiceAgentRowSocket: VoiceSocket {
  let events: VoiceSocketEvents
  private(set) var texts: [String] = []
  private(set) var closed = false

  init(events: VoiceSocketEvents) {
    self.events = events
  }

  func send(text: String) { texts.append(text) }
  func send(data: Data) {}
  func close() { closed = true }
  func reply(_ json: String) { events.message(json) }

  func sent(_ type: String) -> [[String: Any]] {
    texts.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
      .filter { $0["type"] as? String == type }
  }
}

@MainActor
final class VoiceAgentRowAudio: RealtimeAudio {
  private(set) var handlers: RealtimeAudioHandlers?
  private(set) var stops = 0
  let playedSamples = 0

  func start(_ handlers: RealtimeAudioHandlers) async throws(VoiceMicError) { self.handlers = handlers }
  func play(_ pcm: Data) {}
  func clearPlayback() -> Int { 0 }
  var playbackVolume: Float = 1
  func stop() { stops += 1 }
}

/// A clock moved by hand: the level timer, the seconds counter and the highlight fade fire only on `advance`.
@MainActor
final class VoiceAgentRowScheduler: VoiceScheduler {
  private var queue: [(id: Int, at: TimeInterval, work: @MainActor () -> Void)] = []
  private var nextId = 0
  private(set) var now: TimeInterval = 0

  func schedule(after seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer {
    nextId += 1
    let id = nextId
    queue.append((id, now + seconds, work))
    return VoiceTimer { [weak self] in self?.queue.removeAll { $0.id == id } }
  }

  func advance(_ seconds: TimeInterval) {
    let target = now + seconds
    while let next = queue.filter({ $0.at <= target }).min(by: { $0.at < $1.at }) {
      queue.removeAll { $0.id == next.id }
      now = max(now, next.at)
      next.work()
    }
    now = target
  }
}

// MARK: - Realtime events

/// Server events of the Realtime fakes and a wait on the main actor.
enum VoiceAgentEvents {
  static let speechStarted = #"{"type":"input_audio_buffer.speech_started","item_id":"in1","audio_start_ms":100}"#
  static let speechStopped = #"{"type":"input_audio_buffer.speech_stopped","item_id":"in1","audio_end_ms":900}"#

  static func committed(_ item: String) -> String {
    #"{"type":"input_audio_buffer.committed","item_id":"\#(item)"}"#
  }

  static func created(_ id: String) -> String { #"{"type":"response.created","response":{"id":"\#(id)"}}"# }

  static func done(_ id: String) -> String {
    #"{"type":"response.done","response":{"id":"\#(id)","status":"completed","output":[]}}"#
  }

  static func call(_ response: String, id: String, name: String, arguments: String) -> String {
    let args = arguments.replacing("\"", with: "\\\"")
    return
      #"{"type":"response.function_call_arguments.done","response_id":"\#(response)","item_id":"fc_\#(id)","call_id":"\#(id)","name":"\#(name)","arguments":"\#(args)"}"#
  }

  static func loudPCM(_ samples: Int, value: Int16 = 8192) -> Data {
    var data = Data(capacity: samples * 2)
    for _ in 0..<samples { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    return data
  }

  @MainActor
  static func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<300 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }
}
