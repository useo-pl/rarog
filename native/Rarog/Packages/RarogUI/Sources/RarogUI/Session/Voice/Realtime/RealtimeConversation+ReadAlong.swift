import Foundation

// Read-along of a tool's reading: how much of the text the app reads aloud the user has heard so far, for a host that
// lights up the heard part. Owner: voice agent. The reading itself: `RealtimeConversation+Reading.swift`; the
// playback axis: `RealtimeConversation+Playback.swift`.
//
// Rules:
// - Soniox returns the characters it said with their times on the reading's own audio. They follow the text as Soniox
//   normalized it (whitespace folded, emoji dropped, a number maybe said as a word), so they are aligned to the
//   original text (``ReadAlong``), not counted.
// - The reading's start on the playback axis is the cursor before its first audio went to the queue, behind what was
//   queued before it (an answer item), so that audio does not count. A character is heard once the samples played
//   since that start reach its end, rounded to a sample as in `SonioxSpokenText.heard`.
// - The heard prefix counts characters (`Character`) of the original. Original characters with no counterpart
//   (whitespace, emoji, punctuation Soniox left out) pass together with the next spoken character; spoken characters
//   outside the original (a number said as a word) never move it back; it never shrinks. A character without a time
//   moves nothing.
// - The host hears the prefix on each change while the reading plays (a tick every `RealtimeLevelMeter.interval`)
//   and once at the reading's end: `whole` closes it to the whole text (also a trailing emoji or space); `cut` (speech
//   over it, or the host's stop) and `notRead` keep the real prefix, up to what played before the cut or the lost
//   playback. The end of the conversation tells nothing, as it tells the call nothing.
// - Only a reading whose host asked for progress keeps characters and runs the tick. The progress gates nothing:
//   whether a reading played out whole is `RealtimeReadingOutcome`.

/// The read-along of a tool's reading: the prefix of its text heard so far, and how the reading ended.
struct ReadingProgress: Equatable, Sendable {
  enum End: Sendable, Equatable {
    /// Played out whole: the prefix is the whole text.
    case whole
    /// Speech over the reading, or the host's stop, cut it.
    case cut
    /// It ended without playing out whole (`RealtimeReadingOutcome.notRead`).
    case notRead
  }

  /// Characters (`Character`) of the text heard so far, from its start.
  let spokenPrefix: Int
  /// `nil` while the reading plays.
  let end: End?
}

/// The prefix of `original` that the characters Soniox said cover once `playedUpTo` seconds of the reading's audio
/// played.
func alignedPrefix(original: String, heard: [SonioxSpokenCharacter], playedUpTo: TimeInterval) -> Int {
  let rate = RealtimeAudioFormat.sampleRate
  var along = ReadAlong(original)
  along.append(heard)
  along.advance(playedSamples: Int((playedUpTo * Double(rate)).rounded()), sampleRate: rate)
  return along.prefix
}

/// Incremental alignment of the characters Soniox said to the original text: an edit distance in which original
/// characters that are not spoken (no letter or digit) and said characters that are not spoken cost nothing, ranked
/// by cost, then by the most matched characters. After each said character the prefix is the shortest original prefix
/// with the best rank, and the result is the largest such prefix so far, so it never shrinks. One row of the table per
/// said character, `O(count)`.
struct ReadAlong {
  /// One character of either text: its comparison key (case and diacritics folded) and whether it is spoken.
  private struct Unit {
    let key: String
    let spoken: Bool

    init(_ text: String) {
      key = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
      spoken = text.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
    }
  }

  /// An alignment's rank: lower cost first, then more matched characters.
  private struct Score {
    var cost: Int
    var matches: Int

    func beats(_ other: Score) -> Bool {
      cost != other.cost ? cost < other.cost : matches > other.matches
    }

    func adding(cost: Int, matches: Int = 0) -> Score {
      Score(cost: self.cost + cost, matches: self.matches + matches)
    }
  }

  private let original: [Unit]
  /// Characters (`Character`) of the original text.
  let count: Int
  private var heard: [SonioxSpokenCharacter] = []
  /// Said characters taken into the table so far.
  private var taken = 0
  /// The table row after the said characters taken: the best alignment with each original prefix.
  private var row: [Score]
  /// The heard prefix of the original.
  private(set) var prefix = 0

  init(_ text: String) {
    original = text.map { Unit(String($0)) }
    count = original.count
    var row = [Score(cost: 0, matches: 0)]
    for unit in original { row.append(row[row.count - 1].adding(cost: unit.spoken ? 1 : 0)) }
    self.row = row
  }

  /// More characters Soniox said, in order.
  mutating func append(_ characters: [SonioxSpokenCharacter]) {
    heard.append(contentsOf: characters)
  }

  /// Takes in the said characters whose end lies within `playedSamples` of the reading's audio.
  mutating func advance(playedSamples: Int, sampleRate: Int) {
    while taken < heard.count {
      let character = heard[taken]
      guard character.end.isFinite else {
        taken += 1
        continue
      }
      guard Int((character.end * Double(sampleRate)).rounded()) <= playedSamples else { return }
      taken += 1
      take(character.text)
    }
  }

  private mutating func take(_ text: String) {
    // Whitespace has no place of its own: the original's passes with the next spoken character.
    guard !text.allSatisfy(\.isWhitespace) else { return }
    let said = Unit(text)
    let insert = said.spoken ? 1 : 0
    var next = [row[0].adding(cost: insert)]
    next.reserveCapacity(row.count)
    var best = next[0]
    var bestPrefix = 0
    for index in original.indices {
      let unit = original[index]
      var score = unit.key == said.key ? row[index].adding(cost: 0, matches: 1) : row[index].adding(cost: 1)
      let skip = next[index].adding(cost: unit.spoken ? 1 : 0)
      if skip.beats(score) { score = skip }
      let extra = row[index + 1].adding(cost: insert)
      if extra.beats(score) { score = extra }
      next.append(score)
      if score.beats(best) {
        best = score
        bestPrefix = index + 1
      }
    }
    row = next
    prefix = max(prefix, bestPrefix)
  }
}

extension RealtimeConversation {
  /// The read-along of one reading whose host asked for progress.
  struct ReadAlongTrack {
    var along: ReadAlong
    let report: @MainActor (ReadingProgress) -> Void
    /// The reading's start on the playback axis: the cursor before its first audio went to the queue.
    var start: Int?
    /// The playback position past which nothing of it played: the cut or the lost playback.
    var limit: Int?
    /// The prefix last reported.
    var reported = 0

    init(_ text: String, report: @escaping @MainActor (ReadingProgress) -> Void) {
      along = ReadAlong(text)
      self.report = report
    }

    /// The heard prefix at `played` on the playback axis when it grew since the last report.
    mutating func advance(to played: Int) -> ReadingProgress? {
      guard let start else { return nil }
      along.advance(playedSamples: min(played, limit ?? .max) - start, sampleRate: RealtimeAudioFormat.sampleRate)
      guard along.prefix > reported else { return nil }
      reported = along.prefix
      return ReadingProgress(spokenPrefix: reported, end: nil)
    }

    /// The last progress of the reading: the whole text when it played out whole, otherwise the prefix heard up to
    /// `played`.
    mutating func end(_ end: ReadingProgress.End, played: Int) -> ReadingProgress {
      guard end != .whole else { return ReadingProgress(spokenPrefix: along.count, end: .whole) }
      _ = advance(to: played)
      return ReadingProgress(spokenPrefix: along.prefix, end: end)
    }
  }

  /// The reading's first audio goes to the queue now: the cursor is its start, and the tick runs.
  func readAlongAudio(_ id: String) {
    guard var track = readings.active[id]?.along else { return }
    if track.start == nil {
      track.start = cursor
      readings.active[id]?.along = track
    }
    scheduleReadAlong()
  }

  /// The last progress of a reading that ends, at the cursor (what played of it).
  func endReadAlong(_ reading: Reading, _ end: ReadingProgress.End) {
    guard var track = reading.along else { return }
    track.report(track.end(end, played: cursor))
  }

  /// The tick stops: the readings ended or the conversation did.
  func stopReadAlong() {
    readings.alongTimer?.cancel()
    readings.alongTimer = nil
  }

  private func scheduleReadAlong() {
    guard readings.alongTimer == nil else { return }
    let generation = generation
    readings.alongTimer = dependencies.scheduler.schedule(after: RealtimeLevelMeter.interval) { [weak self] in
      guard let self, self.current(generation) else { return }
      self.readings.alongTimer = nil
      guard self.audioRunning else { return }
      self.readAlongTick()
    }
  }

  /// The heard prefix of each reading that played audio, reported when it grew; the tick goes on while one plays.
  private func readAlongTick() {
    let played = dependencies.audio.playedSamples
    var reports: [(@MainActor (ReadingProgress) -> Void, ReadingProgress)] = []
    var playing = false
    for id in readings.active.keys {
      guard var track = readings.active[id]?.along, track.start != nil else { continue }
      playing = true
      if let progress = track.advance(to: played) { reports.append((track.report, progress)) }
      readings.active[id]?.along = track
    }
    if playing { scheduleReadAlong() }
    for (report, progress) in reports { report(progress) }
  }
}
