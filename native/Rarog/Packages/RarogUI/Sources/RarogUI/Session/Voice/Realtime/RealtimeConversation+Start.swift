import Foundation

// The start of a voice conversation: what runs at the tap and when the conversation is ready. Owner: voice agent.
//
// - The tap starts three steps side by side: the Soniox speech key, the ephemeral OpenAI key (both server routes)
//   and the audio engine (`RealtimeConversation.startAudio`). None waits for another, so the conversation is ready
//   after the slowest of them, not after their sum.
// - The OpenAI socket opens only with both keys in hand: a speech key refusal opens no OpenAI socket. A refusal ends
//   the conversation with its reason and stops the engine. The speech key's reason wins whatever the order of
//   arrival: a speech refusal ends at once, an OpenAI refusal waits for the speech key's result.
// - One readiness gate (`audioRunning`): the engine runs AND `session.updated` came, in either order. Only then the
//   phase leaves "connecting", microphone audio goes to OpenAI and counts, and the answer paths run; input before
//   the gate is dropped.
// - `client.log` gets one ready line per conversation when the gate opens, with the stage times from the tap; a
//   conversation that never gets ready writes none.

extension RealtimeConversation {
  /// Start of one conversation run: the key results, the two halves of the readiness gate and the stage times.
  struct StartState {
    var speechTask: Task<Void, Never>?
    var openAITask: Task<Void, Never>?
    var speech: Result<SonioxSpeechConfig, SonioxSpeechKeyError>?
    var openAI: Result<RealtimeEphemeralKey, RealtimeKeyError>?
    /// The audio engine started.
    var engineRunning = false
    /// `session.updated` came for the `session.update` of the start.
    var sessionConfigured = false
    /// Scheduler times of the tap and of the stages: both keys in hand, `session.updated`, the engine started.
    var tappedAt: TimeInterval = 0
    var keysAt: TimeInterval?
    var sessionAt: TimeInterval?
    var audioAt: TimeInterval?

    mutating func cancel() {
      speechTask?.cancel()
      speechTask = nil
      openAITask?.cancel()
      openAITask = nil
    }
  }

  /// Stage times of the ready line, in whole milliseconds. `keys` and `audio` count from the tap, `session` from
  /// both keys in hand to `session.updated` (socket open and `session.update`).
  struct StartTimes: Sendable, Equatable {
    var total: Int
    var keys: Int
    var session: Int
    var audio: Int

    var traceLine: String {
      "voice-agent: ready after \(total) ms (keys \(keys) ms, session \(session) ms, audio \(audio) ms)"
    }
  }

  /// Both key fetches of the start, side by side; each result goes to ``keysSettled(generation:)``.
  func fetchStartKeys(generation: Int) {
    let speechKeys = dependencies.speech.keys
    starting.speechTask = Task { [weak self] in
      let result: Result<SonioxSpeechConfig, SonioxSpeechKeyError>
      do throws(SonioxSpeechKeyError) {
        result = .success(try await speechKeys.speechKey())
      } catch {
        result = .failure(error)
      }
      // The end of the conversation meanwhile: the late key belongs to an old generation.
      guard let self, self.current(generation), !Task.isCancelled else { return }
      self.starting.speechTask = nil
      self.starting.speech = result
      self.keysSettled(generation: generation)
    }
    let keys = dependencies.keys
    starting.openAITask = Task { [weak self] in
      let result: Result<RealtimeEphemeralKey, RealtimeKeyError>
      do throws(RealtimeKeyError) {
        result = .success(try await keys.ephemeralKey())
      } catch {
        result = .failure(error)
      }
      guard let self, self.current(generation), !Task.isCancelled else { return }
      self.starting.openAITask = nil
      self.starting.openAI = result
      self.keysSettled(generation: generation)
    }
  }

  /// A key result came: a speech refusal ends the conversation at once; an OpenAI refusal waits for the speech key,
  /// whose refusal wins; both keys in hand open the socket.
  private func keysSettled(generation: Int) {
    guard let speech = starting.speech else { return }
    let config: SonioxSpeechConfig
    switch speech {
    case let .failure(error):
      end(error.end)
      return
    case let .success(value): config = value
    }
    switch starting.openAI {
    case nil: return
    case let .failure(error)?: end(error.end)
    case let .success(key)?:
      starting.keysAt = dependencies.scheduler.now
      connect(key, speech: config, generation: generation)
    }
  }

  /// The audio engine of this run started.
  func engineStarted() {
    starting.engineRunning = true
    starting.audioAt = dependencies.scheduler.now
    openGateIfReady()
  }

  /// `session.updated` came for the `session.update` of the start.
  func sessionConfigured() {
    starting.sessionConfigured = true
    starting.sessionAt = dependencies.scheduler.now
    openGateIfReady()
  }

  /// Opens the readiness gate once both halves are in: levels, the phase and the ready line.
  private func openGateIfReady() {
    guard starting.engineRunning, starting.sessionConfigured, !audioRunning else { return }
    cursor = dependencies.audio.playedSamples
    audioRunning = true
    startLevels()
    let now = dependencies.scheduler.now
    let keysAt = starting.keysAt ?? now
    handlers.diagnostic(
      .ready(
        StartTimes(
          total: Self.milliseconds(now - starting.tappedAt),
          keys: Self.milliseconds(keysAt - starting.tappedAt),
          session: Self.milliseconds((starting.sessionAt ?? now) - keysAt),
          audio: Self.milliseconds((starting.audioAt ?? now) - starting.tappedAt))))
    updatePhase()
  }

  private static func milliseconds(_ seconds: TimeInterval) -> Int { Int((seconds * 1000).rounded()) }
}

extension RealtimeKeyError {
  /// The end of a conversation whose ephemeral key was refused.
  var end: RealtimeConversation.End {
    switch self {
    case .keyMissing: .keyMissing
    case .keyRejected: .keyRejected
    case .limit: .openAILimit
    case .throttled: .throttled
    case .unavailable: .unavailable
    }
  }
}
