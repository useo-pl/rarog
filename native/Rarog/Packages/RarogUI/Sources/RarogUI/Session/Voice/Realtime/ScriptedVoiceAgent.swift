#if DEBUG
import Foundation
import RarogCore

// A voice conversation from a script, ONLY in a Debug build with `RAROG_UI_TEST_VOICE_AGENT=1` (UI tests,
// `VoiceAgentScreenshotUITests`). The simulator has no microphone and the demo server offers no voice agent, so the
// keys, the Realtime socket, the Soniox socket and the audio play a fixed script: listening, the user's speech
// ("Hearing you") for a few seconds, then an answer that calls `show_prompt`, after which the conversation listens
// with the prompt in the field. The answers carry no text, so Soniox says nothing. The button stands without the
// server's voice agent and the Settings switch (`SessionViewController+VoiceAgent.swift`). With the value `hearing`
// the user never stops speaking, so the conversation stays in "Hearing you" (for screenshots).
// Owner: voice agent.

enum ScriptedVoiceAgent {
  static let environmentKey = "RAROG_UI_TEST_VOICE_AGENT"

  static var isOn: Bool { ProcessInfo.processInfo.environment[environmentKey] != nil }

  /// The prompt the script writes into the field.
  static let prompt = "Run the login tests and fix what fails."
  /// Seconds after the start of the audio: the user's speech starts and ends (the answer follows).
  static let speechStart: TimeInterval = 1
  static var speechEnd: TimeInterval { speechEnd(environment: ProcessInfo.processInfo.environment) }

  /// `hearing`: the speech never ends; any other value: after five seconds.
  static func speechEnd(environment: [String: String]) -> TimeInterval {
    environment[environmentKey] == "hearing" ? .infinity : 6
  }

  /// The button of the script, on the sessions where the real one stands (``VoiceAgentEntry/make``), without the
  /// server's voice agent and the Settings switch; `nil` outside the script.
  static func entry(state: AppState, sessionId: String, dictating: Bool) -> VoiceAgentEntry? {
    guard isOn, let session = state.sessions[sessionId], session.engine == nil, session.showsTranscript else {
      return nil
    }
    return dictating ? .disabled : .enabled
  }

  /// Keys, sockets, audio and clock of the script.
  @MainActor
  static func dependencies() -> RealtimeConversation.Dependencies {
    let scheduler = TaskVoiceScheduler()
    let keys = ScriptedVoiceAgentKeys()
    return RealtimeConversation.Dependencies(
      keys: keys,
      socket: { _, events in ScriptedVoiceAgentSocket(scheduler: scheduler, events: events) },
      audio: ScriptedVoiceAgentAudio(scheduler: scheduler), scheduler: scheduler,
      speech: RealtimeConversation.Speech(
        keys: keys, socket: { _, _, events in ScriptedSpeechSocket(scheduler: scheduler, events: events) }))
  }

  /// 0.1 s of PCM s16le 24 kHz at a constant level (0…1).
  static func pcm(level: Float) -> Data {
    let value = Int16(max(0, min(1, level)) * 32767).littleEndian
    var data = Data(capacity: 2400 * 2)
    for _ in 0..<2400 { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
    return data
  }
}

@MainActor
final class ScriptedVoiceAgentKeys: RealtimeEphemeralKeyProvider, SonioxSpeechKeyProvider {
  func ephemeralKey() async throws(RealtimeKeyError) -> RealtimeEphemeralKey {
    RealtimeEphemeralKey(value: "ek_scripted", model: "gpt-realtime-2.1")
  }

  func speechKey() async throws(SonioxSpeechKeyError) -> SonioxSpeechConfig {
    SonioxSpeechConfig(
      apiKey: "snx_temp_scripted", expiresAt: Date().addingTimeInterval(3600),
      webSocketURL: URL(string: "wss://tts.invalid/scripted")!, model: "tts-scripted", voice: "scripted",
      sampleRate: RealtimeAudioFormat.sampleRate, language: "en")
  }
}

/// The Soniox socket of the script: it opens and takes the frames; the script's answers have no text to speak.
@MainActor
final class ScriptedSpeechSocket: VoiceSocket {
  private var timer: VoiceTimer?

  init(scheduler: any VoiceScheduler, events: VoiceSocketEvents) {
    timer = scheduler.schedule(after: 0) { events.opened() }
  }

  func send(text: String) {}
  func send(data: Data) {}

  func close() {
    timer?.cancel()
    timer = nil
  }
}

/// The Realtime server of the script: `session.updated`, the speech of the user, and two answers, the first with a
/// `show_prompt` call.
@MainActor
final class ScriptedVoiceAgentSocket: VoiceSocket {
  private let scheduler: any VoiceScheduler
  private let events: VoiceSocketEvents
  private var timers: [VoiceTimer] = []
  private var responses = 0
  private var closed = false

  init(scheduler: any VoiceScheduler, events: VoiceSocketEvents) {
    self.scheduler = scheduler
    self.events = events
    later(0) { $0.events.opened() }
  }

  func send(text: String) {
    guard let data = text.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let type = object["type"] as? String
    else { return }
    switch type {
    case "session.update":
      later(0) { $0.events.message(#"{"type":"session.updated","session":{}}"#) }
      later(ScriptedVoiceAgent.speechStart) {
        $0.events.message(#"{"type":"input_audio_buffer.speech_started","item_id":"in1","audio_start_ms":100}"#)
      }
      let speechEnd = ScriptedVoiceAgent.speechEnd
      if speechEnd.isFinite {
        later(speechEnd) {
          $0.events.message(#"{"type":"input_audio_buffer.speech_stopped","item_id":"in1","audio_end_ms":5000}"#)
          $0.events.message(#"{"type":"input_audio_buffer.committed","item_id":"in1"}"#)
        }
      }
    case "response.create":
      responses += 1
      let id = "r\(responses)"
      let first = responses == 1
      later(0.3) { socket in
        socket.events.message(#"{"type":"response.created","response":{"id":"\#(id)"}}"#)
        if first {
          let arguments = #"{\"text\":\"\#(ScriptedVoiceAgent.prompt)\"}"#
          socket.events.message(
            #"{"type":"response.function_call_arguments.done","response_id":"\#(id)","item_id":"fc_1","call_id":"c1","name":"show_prompt","arguments":"\#(arguments)"}"#
          )
        }
        socket.events.message(#"{"type":"response.done","response":{"id":"\#(id)","status":"completed","output":[]}}"#)
      }
    default:
      break
    }
  }

  func send(data: Data) {}

  func close() {
    closed = true
    for timer in timers { timer.cancel() }
    timers = []
  }

  private func later(_ seconds: TimeInterval, _ work: @escaping @MainActor (ScriptedVoiceAgentSocket) -> Void) {
    timers.append(
      scheduler.schedule(after: seconds) { [weak self] in
        guard let self, !self.closed else { return }
        work(self)
      })
  }
}

/// The audio of the script: the microphone sends speech between ``ScriptedVoiceAgent/speechStart`` and
/// ``ScriptedVoiceAgent/speechEnd`` and silence otherwise; nothing plays.
@MainActor
final class ScriptedVoiceAgentAudio: RealtimeAudio {
  private let scheduler: any VoiceScheduler
  private var handlers: RealtimeAudioHandlers?
  private var timer: VoiceTimer?
  private var startedAt: TimeInterval = 0
  let playedSamples = 0

  init(scheduler: any VoiceScheduler) {
    self.scheduler = scheduler
  }

  func start(_ handlers: RealtimeAudioHandlers) async throws(VoiceMicError) {
    self.handlers = handlers
    startedAt = scheduler.now
    handlers.started("in scripted 24000 Hz 1 ch, out scripted")
    tick()
  }

  func play(_ pcm: Data) {}

  func clearPlayback() -> Int { 0 }

  var playbackVolume: Float = 1

  func stop() {
    timer?.cancel()
    timer = nil
    handlers = nil
  }

  private func tick() {
    timer = scheduler.schedule(after: 0.1) { [weak self] in
      guard let self, let handlers = self.handlers else { return }
      let elapsed = self.scheduler.now - self.startedAt
      let speaking = elapsed >= ScriptedVoiceAgent.speechStart && elapsed < ScriptedVoiceAgent.speechEnd
      // A voice that varies a little, so the bars move.
      let level: Float = speaking ? 0.2 + 0.15 * Float(sin(elapsed * 7) + 1) / 2 : 0
      handlers.input(ScriptedVoiceAgent.pcm(level: level))
      self.tick()
    }
  }
}
#endif
