import Foundation

// Voice levels of the conversation for the voice agent button and the status dot: the microphone peak since the
// last event and the peak of the output samples that are PLAYING now. Owner: voice agent.
//
// - At most one event per `RealtimeLevelMeter.interval` (about 20 per second) on the main actor, from a timer of
//   its own: microphone PCM goes to OpenAI chunk by chunk, the meter only keeps the peak, so no sample is lost.
// - Output follows the playback axis (`RealtimeAudio.playedSamples`), not the moment of `play()`: buffers wait in
//   the queue seconds ahead, and a queued answer does not move the bars before it plays.
// - The levels are the SHOWN ones: up at once with a new peak, down by a fifth per event in silence, and zero once
//   the tail falls below ``RealtimeLevels/rest``. The fall happens before the "only on a change" rule, so silence
//   always brings the bars and the dot to rest, and silence at rest costs no events.
// - Barge-in, an engine restart and the end of the conversation zero both levels.

/// Shown levels 0…1 for one event.
struct RealtimeLevels: Sendable, Equatable {
  var input: Float
  var output: Float

  static let zero = RealtimeLevels(input: 0, output: 0)
  /// Below this the falling tail drops to zero (about a second from a full level).
  static let rest: Float = 0.01

  /// The shown levels after the peaks of one tick, on each side: the new peak at once, otherwise the previous
  /// level lowered by a fifth, and zero below ``rest``.
  func next(_ peaks: RealtimeLevels) -> RealtimeLevels {
    RealtimeLevels(input: Self.fall(input, peak: peaks.input), output: Self.fall(output, peak: peaks.output))
  }

  static func fall(_ previous: Float, peak: Float) -> Float {
    let tail = previous * 0.8
    return max(peak, tail < rest ? 0 : tail)
  }
}

/// Pure level meter on the playback sample axis of the conversation (tested on macOS).
struct RealtimeLevelMeter {
  /// Seconds between level events.
  static let interval: TimeInterval = 0.05

  /// Microphone peak since the last tick, as a sample magnitude 0…32768.
  private var inputPeak = 0
  /// Output chunks still not played to the end: start on the axis and PCM s16le.
  private var chunks: [(start: Int, pcm: Data)] = []
  /// Axis position up to which output was already measured.
  private var measured: Int

  init(played: Int = 0) {
    measured = played
  }

  /// A microphone chunk on its way to OpenAI: only its peak stays.
  mutating func input(_ pcm: Data) {
    inputPeak = max(inputPeak, Self.peak(pcm, from: 0, to: pcm.count / 2))
  }

  /// An output chunk queued at `start` on the playback axis.
  mutating func queued(_ pcm: Data, at start: Int) {
    guard !pcm.isEmpty else { return }
    chunks.append((start, pcm))
  }

  /// Levels since the last tick: the microphone peak, and the peak of the samples played between the last tick
  /// and `played`. Played chunks are dropped.
  mutating func tick(played: Int) -> RealtimeLevels {
    var output = 0
    if played > measured {
      for chunk in chunks {
        let count = chunk.pcm.count / 2
        let from = max(measured, chunk.start) - chunk.start
        let to = min(played, chunk.start + count) - chunk.start
        guard from < to else { continue }
        output = max(output, Self.peak(chunk.pcm, from: from, to: to))
      }
      measured = played
    }
    chunks.removeAll { $0.start + $0.pcm.count / 2 <= measured }
    let levels = RealtimeLevels(input: Self.level(inputPeak), output: Self.level(output))
    inputPeak = 0
    return levels
  }

  /// Mute: the microphone peak since the last tick is forgotten.
  mutating func dropInput() {
    inputPeak = 0
  }

  /// Barge-in, restart, end: the queue is gone and the axis continues from `played`.
  mutating func reset(played: Int) {
    inputPeak = 0
    chunks = []
    measured = played
  }

  private static func level(_ peak: Int) -> Float { min(1, Float(peak) / 32768) }

  private static func peak(_ pcm: Data, from: Int, to: Int) -> Int {
    var loudest = 0
    pcm.withUnsafeBytes { raw in
      for index in from..<to {
        let value = Int(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)))
        loudest = max(loudest, abs(value))
      }
    }
    return loudest
  }
}

extension RealtimeConversation {
  /// Starts the level timer when the conversation gets ready (`RealtimeConversation+Start.swift`).
  func startLevels() {
    meter = RealtimeLevelMeter(played: dependencies.audio.playedSamples)
    lastLevels = .zero
    scheduleLevels(generation: generation)
  }

  /// Both levels to zero now (barge-in, lost playback, end); the timer keeps running while audio runs.
  func zeroLevels() {
    meter.reset(played: dependencies.audio.playedSamples)
    emitLevels(.zero)
  }

  /// The microphone level to zero now (mute); the output level goes on.
  func zeroInputLevel() {
    meter.dropInput()
    emitLevels(RealtimeLevels(input: 0, output: lastLevels.output))
  }

  /// Stops the timer; the end of the conversation calls it before ``zeroLevels()``.
  func stopLevels() {
    levelTimer?.cancel()
    levelTimer = nil
  }

  private func scheduleLevels(generation: Int) {
    levelTimer?.cancel()
    levelTimer = dependencies.scheduler.schedule(after: RealtimeLevelMeter.interval) { [weak self] in
      guard let self, self.current(generation), self.audioRunning else { return }
      let peaks = self.meter.tick(played: self.dependencies.audio.playedSamples)
      self.emitLevels(self.lastLevels.next(peaks))
      self.scheduleLevels(generation: generation)
    }
  }

  /// An event only when a shown level changed: silence at rest costs nothing on the main actor.
  private func emitLevels(_ levels: RealtimeLevels) {
    guard levels != lastLevels else { return }
    lastLevels = levels
    handlers.levels(levels)
  }
}
