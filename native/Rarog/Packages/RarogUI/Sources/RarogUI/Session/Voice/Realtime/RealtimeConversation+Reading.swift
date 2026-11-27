import Foundation

// A tool's reading in the voice conversation: the work of a host tool (`RealtimeToolAction.workAndRead`) hands the
// conversation a text, Soniox reads exactly that text, and the call's result goes to the model only after the reading
// ended. Owner: voice agent. Soniox speech of the answers: `RealtimeConversation+Speech.swift`; the playback and the
// cut: `RealtimeConversation+Playback.swift`; the noise window: `RealtimeConversation+Noise.swift`.
//
// Rules:
// - A reading is a Soniox utterance of its own, with an id no OpenAI item has, queued behind the items already in the
//   Soniox queue: it plays after the audio queued before it and before the model's next answer, which waits for the
//   call's result. Its PCM goes on the playback axis like an answer item's, but it is no OpenAI conversation item:
//   nothing is fixed or deleted for it, it never tells the host `playedWhole`, and it changes nothing in how the
//   answers count (`RealtimeConversation+Answer.swift`).
// - Played out whole: Soniox ended its stream after audio, with no stream limit and no error on that stream, and the
//   playback queue drained after that, so every sample of the stream played. Otherwise it is not read: no audio, the
//   stream limit, an error on its stream, no first audio or no end of its stream within the waits below, the playback
//   lost by an engine restart, or no Soniox speech. A failure of the whole Soniox connection ends the conversation,
//   as during an answer.
// - Its stream started (its text went out in the start frame, after the streams queued before it ended) and no audio
//   of it came: the wait for the first audio is `SonioxSpeech.Timing.firstAudioLimit`. Past it the stream gets Soniox
//   `cancel` and the reading is not read (`no-first-audio`). Its first audio, a cut and the end of the conversation
//   stop the wait, and the noise window holds this end as any other.
// - The queue drained with the reading's audio played and its stream not over: the wait for the stream's end is
//   `SonioxSpeech.Timing.drainLimit`, started again at the next drain when more audio of it came. Past it the stream
//   gets Soniox `cancel` and the reading is not read (`stalled`); a cut and the end of the conversation stop the
//   wait, and the noise window holds this end as any other.
// - The call's result goes at the reading's end; the host's `then` turns the outcome into it (`RealtimeToolResult`).
//   A reading that is not read ends once what Soniox said of it played.
// - A host may ask for the read-along of the text: the heard prefix while it plays and once at its end, also at a cut
//   (`RealtimeConversation+ReadAlong.swift`). Without it the reading keeps no characters.
// - Speech over a reading, also one that waits for its stream, is speech over the answer: the noise window, then the
//   cut (`bargeIn()`): its stream gets Soniox `cancel`, its call is dropped with the other results in flight (`then`
//   is never called), and the host hears `cut`. Noise lets it go on. The end of the conversation drops it the same
//   way, with nothing told.
// - A host may stop the reading itself (``stopReading()``: the person edits or sends the text by hand): the same
//   cut, at once, with no noise window. Without a reading in progress it does nothing.
// - While the noise window is open, the end of a reading waits for the verdict, whatever the outcome (played out, the
//   playback lost): noise, or the mute that closes the window, ends it then, once; the cut drops it as above.
// - The phase is "speaking" while a reading that played audio is not over and its end does not wait.
// - Its characters and its audio count in the Soniox total of the end line, in no response's speech line; a reading
//   whose synthesis did not end when the conversation ends makes that audio a floor, as an answer item does.
// - The mark: the conversation counts the microphone samples it appends to OpenAI's input buffer since the Realtime
//   session started (input before the readiness gate and muted input never go, so they do not count): the axis of
//   `audio_start_ms`. A reading that starts drops the mark. Only the reading started last in the run places it, once
//   it played out whole: an older reading that plays out whole while a newer one runs places none, and a last one
//   that is not read, is cut or still runs leaves none.
// - The mark lies by capture time. Microphone audio captured before the playback ended can still be on its way from
//   the engine when the app learns of the end, so at the end of the whole reading the conversation notes the time on
//   the engine's host clock (`Dependencies.hostClock`, the clock of the capture times in
//   `RealtimeAudioHandlers.input`) and the mark is pending. The first appended buffer captured at or after that time
//   places it: the input position after that buffer, in whole milliseconds rounded up, so it lies after every
//   sample captured before the playback ended. A buffer without a capture time, and muted input, never place it.
// - Each kept utterance while a mark stands, pending or placed, is compared with it: after it when the mark is placed
//   and the `audio_start_ms` of the utterance's counted `speech_started` is greater. A pending mark, no time, a start
//   that names another item, or a `committed` without its own start: not after. The moment of each tool call after
//   that says whether such an utterance came since the mark (`RealtimeToolTurn.utteranceAfterReading`). A new
//   conversation is a new Realtime session whose axis starts at zero: no mark.
// - The comparison is on the app's count, not a guarantee about OpenAI's clock. OpenAI's reference (not measured in
//   this repo) says `audio_start_ms` includes `prefix_padding_ms`, so speech that starts within the padding after the
//   reading's end counts as not after.
// - `client.log`, never the text: per reading `reading whole, mark pending` (`no mark` for an older reading) or
//   `reading not-read <code>`, `reading mark <ms> ms` when the mark is placed, and per kept utterance while a mark
//   stands `utterance start <ms|none> vs mark <ms ms|pending>: after|not-after`.

extension RealtimeConversation {
  /// A reading in progress: the call whose result waits for it and what Soniox did with it so far.
  struct Reading {
    /// Its number in the run: the reading with the highest one started last.
    let number: Int
    let then: @MainActor (RealtimeReadingOutcome) -> String
    let call: ToolCall
    var hadAudio = false
    var synthesized = false
    /// Known before its end: it cannot play out whole (the stream limit, an error on its stream).
    var notRead: ReadingNotRead?
    /// Its end came while the noise window was open: it waits for the verdict.
    var waiting = false
    /// The bound on the wait for its stream: for the first audio once the stream started (``awaitFirstAudio(_:)``),
    /// then for the stream's end once its audio played (``awaitStreamEnd(_:)``). Audio of it stops either.
    var streamEndTimer: VoiceTimer?
    /// Its read-along, when the host asked for progress (`RealtimeConversation+ReadAlong.swift`).
    var along: ReadAlongTrack?
  }

  /// Why a reading was not read; the code of its `client.log` line.
  enum ReadingNotRead: String, Sendable, Equatable {
    case noAudio = "no-audio"
    case streamLimit = "stream-limit"
    case failed
    case lostPlayback = "lost-playback"
    case noSpeech = "no-speech"
    /// Speech over the reading cut it; its call is dropped, so only the log line knows.
    case cut
    /// Its audio played and Soniox did not end its stream within the wait (``awaitStreamEnd(_:)``).
    case stalled
    /// Its stream started and Soniox sent no audio of it and no end within the wait (``awaitFirstAudio(_:)``).
    case noFirstAudio = "no-first-audio"
  }

  /// How a reading ended, for its `client.log` line.
  enum ReadingEnd: Sendable, Equatable {
    /// Played out whole. `marks`: it started last, so its mark is pending; `false`: a newer reading started, so this
    /// one places no mark.
    case whole(marks: Bool)
    case notRead(ReadingNotRead)
  }

  /// The mark of the last reading on the input audio axis.
  enum ReadingMark: Equatable {
    /// The reading played out whole at this time on the host clock; no buffer captured at or after it came yet.
    case pending(endedAt: TimeInterval)
    /// The input position, in ms, after the first appended buffer captured at or after the end.
    case placed(ms: Int)

    var ms: Int? {
      if case let .placed(ms) = self { ms } else { nil }
    }
  }

  /// The readings of one conversation run, and the mark of the last one on the input audio axis.
  struct ReadingState {
    /// Readings started in this run, also those concluded at once; numbers the readings and their Soniox utterance
    /// ids.
    var started = 0
    /// Readings not over, by Soniox utterance id.
    var active: [String: Reading] = [:]
    /// Microphone samples appended to OpenAI's input buffer in this run: the position on the axis of
    /// `audio_start_ms`.
    var inputSamples = 0
    /// The mark of the last reading started in this run, once it played out whole; `nil`: no reading, or the last one
    /// runs, was not read or was cut.
    var mark: ReadingMark?
    /// A kept utterance since the mark began after it.
    var afterMark = false
    /// The counted `speech_started` of the utterance in progress.
    var speechStart: SpeechStart?
    /// The read-along tick, while a reading that reports progress plays (`RealtimeConversation+ReadAlong.swift`).
    var alongTimer: VoiceTimer?
  }

  /// A counted `speech_started`: the item it names and its `audio_start_ms` (`nil` when the event carries none).
  struct SpeechStart {
    let item: String?
    let ms: Int?
  }

  /// The Soniox utterance ids of readings start with this; OpenAI item ids never do.
  static let readingPrefix = "rarog-reading-"

  /// A reading that played audio has not ended, and its end does not wait for the noise window.
  var readingSpeaking: Bool { readings.active.values.contains { $0.hadAudio && !$0.waiting } }

  /// The work of `call` asked to read `text` aloud; the call's result goes at the reading's end.
  func read(
    _ text: String, then: @escaping @MainActor (RealtimeReadingOutcome) -> String,
    progress: (@MainActor (ReadingProgress) -> Void)?, call: ToolCall
  ) {
    // A cut or the end since the call's work began: the call is dropped and nothing is read.
    guard accepts(generation: call.generation, token: call.token, response: call.response) else { return }
    // Only the last reading can mark, and only once it played out whole.
    readings.mark = nil
    readings.afterMark = false
    readings.started += 1
    let reading = Reading(
      number: readings.started, then: then, call: call, along: progress.map { ReadAlongTrack(text, report: $0) })
    guard audioRunning, let client = tts.client else {
      conclude(reading, notRead: .noSpeech)
      return
    }
    let id = Self.readingPrefix + String(reading.number)
    readings.active[id] = reading
    client.append(text, to: id)
    client.end(id)
    updatePhase()
  }

  /// A Soniox event of a reading; false for an event of an answer item or of the whole connection.
  func readingEvent(_ event: SonioxSpeech.Event) -> Bool {
    switch event {
    case let .audio(id, pcm):
      guard id.hasPrefix(Self.readingPrefix) else { return false }
      readingAudio(pcm, id: id)
    case let .characters(id, characters):
      guard id.hasPrefix(Self.readingPrefix) else { return false }
      readings.active[id]?.along?.along.append(characters)
    case let .finished(id):
      guard id.hasPrefix(Self.readingPrefix) else { return false }
      readingFinished(id)
    case let .failed(failure):
      guard case let .stream(id, _, _, _) = failure, id.hasPrefix(Self.readingPrefix) else { return false }
      handlers.diagnostic(.speechError(code: failure.logCode))
      // The stream ended early, so its audio is a floor; its `finished` follows.
      readings.active[id]?.notRead = failure.isStreamLimit ? .streamLimit : .failed
      tts.total.cut = true
    case .keyNeeded:
      return false
    }
    return true
  }

  /// The playback queue drained: every reading whose synthesis ended played out; one whose audio played while its
  /// stream runs waits for the stream's end, bounded.
  func readingsDrained() {
    for (id, reading) in readings.active where !reading.waiting {
      if reading.synthesized {
        completeReading(id)
      } else if reading.hadAudio {
        awaitStreamEnd(id)
      }
    }
  }

  /// The host stops the reading (the person took the text into their own hands): the cut that speech over it makes,
  /// at once and with no noise window, so its audio stops, its call goes with the results in flight and the host
  /// hears `cut`. No reading in progress: nothing, and a playing answer goes on.
  func stopReading() {
    guard !readings.active.isEmpty else { return }
    if bargeInWindow != nil {
      cutOverAnswer()
    } else {
      bargeIn()
    }
  }

  /// The end of the conversation: the readings go with nothing told and no line.
  func dropReadings() {
    stopReadAlong()
    for reading in readings.active.values { reading.streamEndTimer?.cancel() }
    readings.active = [:]
  }

  /// The cut: every reading stops, also one whose end waits for the noise window, and its call goes with the other
  /// results in flight.
  func cutReadings() {
    for (id, reading) in readings.active {
      reading.streamEndTimer?.cancel()
      // A reading whose end waits has no stream left: it ended, or the playback loss cancelled it.
      if !reading.synthesized && !reading.waiting {
        tts.client?.cancel(id)
        tts.total.cut = true
      }
      handlers.diagnostic(.reading(.notRead(.cut)))
    }
    let cut = readings.active.values.sorted { $0.number < $1.number }
    readings.active = [:]
    stopReadAlong()
    // The cursor is where the playback stopped: what the user heard of each.
    for reading in cut { endReadAlong(reading, .cut) }
  }

  /// The engine lost the playback queue: a reading that played audio cannot play out whole, so its stream stops and
  /// its call gets the not-read result. A reading that has played no audio goes on.
  func loseReadings() {
    for (id, reading) in readings.active where reading.hadAudio && !reading.waiting {
      if !reading.synthesized {
        tts.client?.cancel(id)
        tts.total.cut = true
      }
      readings.active[id]?.notRead = .lostPlayback
      // Nothing of it played past the cursor, also when its end waits for the noise window.
      readings.active[id]?.along?.limit = cursor
      completeReading(id)
    }
  }

  /// The noise window closed with no cut (noise, the mute): the readings whose end waited for it end now, in the
  /// order they started.
  func completeWaitingReadings() {
    let waiting = readings.active.filter { $0.value.waiting }.sorted { $0.value.number < $1.value.number }
    for (id, _) in waiting { completeReading(id) }
  }

  // MARK: - The mark on the input audio axis

  /// Microphone audio went to OpenAI's input buffer: the position moves by its samples. The first buffer captured at
  /// or after the end of the whole reading places its pending mark after itself.
  func inputAppended(_ pcm: Data, capturedAt: TimeInterval?) {
    readings.inputSamples += RealtimeAudioFormat.samples(in: pcm)
    guard case let .pending(endedAt) = readings.mark, let capturedAt, capturedAt >= endedAt else { return }
    readings.mark = .placed(ms: inputMs)
    handlers.diagnostic(.readingMark(ms: inputMs))
  }

  /// A counted `speech_started` opens the utterance in progress.
  func noteSpeechStart(item: String?, ms: Int?) {
    readings.speechStart = SpeechStart(item: item, ms: ms)
  }

  /// The `speech_started` of the committed utterance, used up whether the utterance is kept or dropped, so a
  /// `committed` without its own start finds none.
  func takeSpeechStart() -> SpeechStart? {
    defer { readings.speechStart = nil }
    return readings.speechStart
  }

  /// A kept utterance against the mark: after it when the mark is placed and its `audio_start_ms` is greater. A
  /// pending mark, no time, a start that names another item, or no mark: not after. Logged only while a mark stands.
  func compareUtterance(_ item: String?, start: SpeechStart?) {
    guard let mark = readings.mark else { return }
    let startMs = start.flatMap { start in start.item == nil || item == nil || start.item == item ? start.ms : nil }
    let after = mark.ms.flatMap { mark in startMs.map { $0 > mark } } ?? false
    handlers.diagnostic(.utteranceCompared(startMs: startMs, markMs: mark.ms, after: after))
    if after { readings.afterMark = true }
  }

  /// The input position in whole milliseconds, rounded up, so the mark never lies before audio it counts.
  private var inputMs: Int {
    let rate = RealtimeAudioFormat.sampleRate
    return (readings.inputSamples * 1000 + rate - 1) / rate
  }

  // MARK: - Soniox and playback

  private func readingAudio(_ pcm: Data, id: String) {
    guard var reading = readings.active[id], audioRunning, !pcm.isEmpty else { return }
    tts.total.samples += RealtimeAudioFormat.samples(in: pcm)
    logFirstPCM()
    reading.hadAudio = true
    // The stream still delivers: the wait for its end starts again at the next `drained`.
    reading.streamEndTimer?.cancel()
    reading.streamEndTimer = nil
    readings.active[id] = reading
    readAlongAudio(id)
    enqueue(pcm)
  }

  private func readingFinished(_ id: String) {
    guard var reading = readings.active[id] else { return }
    reading.synthesized = true
    readings.active[id] = reading
    // Its audio already played, or it had none: it is over at once; otherwise at the next `drained`.
    if !reading.hadAudio || !playbackPending { completeReading(id) }
    updatePhase()
  }

  /// Every sample Soniox sent for the reading played, and its stream has not ended. Soniox has the whole text and its
  /// end from the start, so a working stream ends with or soon after its last audio, before that audio has played.
  /// The wait is the one `SonioxSpeech` gives a stream whose `terminated` does not come (`Timing.drainLimit`); new
  /// audio of the reading stops it. Past it the stream gets Soniox `cancel` and the reading is not read.
  private func awaitStreamEnd(_ id: String) {
    readings.active[id]?.streamEndTimer?.cancel()
    let generation = generation
    let timer = dependencies.scheduler.schedule(after: dependencies.speech.timing.drainLimit) { [weak self] in
      guard let self, self.current(generation) else { return }
      self.readingStalled(id)
    }
    readings.active[id]?.streamEndTimer = timer
  }

  /// The wait for the stream's end ran out. A cut, the end of the conversation or the stream's end since cancelled
  /// it or took the reading away.
  private func readingStalled(_ id: String) {
    guard let reading = readings.active[id], !reading.synthesized, !reading.waiting else { return }
    stopStream(id, notRead: .stalled)
  }

  /// The reading's stream started at Soniox: its text went out in a start frame (`SonioxSpeech`, rule 6), which comes
  /// only once the streams queued before it ended. The wait for its first audio is `Timing.firstAudioLimit`; the
  /// first audio stops it, past it the stream gets Soniox `cancel` and the reading is not read.
  func readingStreamStarted(_ id: String) {
    guard let reading = readings.active[id], !reading.hadAudio, reading.streamEndTimer == nil else { return }
    let generation = generation
    let timer = dependencies.scheduler.schedule(after: dependencies.speech.timing.firstAudioLimit) { [weak self] in
      guard let self, self.current(generation) else { return }
      self.readingSilent(id)
    }
    readings.active[id]?.streamEndTimer = timer
  }

  /// The wait for the first audio ran out. Audio, a cut, the end of the conversation or the stream's end since
  /// cancelled it or took the reading away.
  private func readingSilent(_ id: String) {
    guard let reading = readings.active[id], !reading.hadAudio, !reading.synthesized, !reading.waiting else { return }
    stopStream(id, notRead: .noFirstAudio)
  }

  /// A bound on the reading's stream ran out: the stream gets Soniox `cancel` and the reading is not read.
  private func stopStream(_ id: String, notRead: ReadingNotRead) {
    readings.active[id]?.streamEndTimer = nil
    readings.active[id]?.notRead = notRead
    tts.client?.cancel(id)
    tts.total.cut = true
    completeReading(id)
  }

  /// The reading is over. While the noise window is open it waits for the verdict instead
  /// (``completeWaitingReadings()`` or the cut).
  private func completeReading(_ id: String) {
    readings.active[id]?.streamEndTimer?.cancel()
    readings.active[id]?.streamEndTimer = nil
    guard bargeInWindow == nil else {
      readings.active[id]?.waiting = true
      updatePhase()
      return
    }
    guard let reading = readings.active.removeValue(forKey: id) else { return }
    conclude(reading, notRead: reading.notRead ?? (reading.hadAudio ? nil : .noAudio))
  }

  /// The reading ended: a whole one that started last notes the end on the host clock for its mark, then the host
  /// turns the outcome into the call's result, which goes at once.
  private func conclude(_ reading: Reading, notRead: ReadingNotRead?) {
    if let notRead {
      handlers.diagnostic(.reading(.notRead(notRead)))
    } else if reading.number == readings.started {
      readings.mark = .pending(endedAt: dependencies.hostClock())
      readings.afterMark = false
      handlers.diagnostic(.reading(.whole(marks: true)))
    } else {
      handlers.diagnostic(.reading(.whole(marks: false)))
    }
    // The host hears the end of the read-along also when the call is dropped below.
    endReadAlong(reading, notRead == nil ? .whole : .notRead)
    let call = reading.call
    guard accepts(generation: call.generation, token: call.token, response: call.response) else {
      updatePhase()
      return
    }
    let output = reading.then(notRead == nil ? .whole : .notRead)
    deliver(output, callId: call.callId, response: call.response, token: call.token)
  }
}
