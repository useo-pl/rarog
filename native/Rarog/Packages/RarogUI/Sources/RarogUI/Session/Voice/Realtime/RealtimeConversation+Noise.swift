import Foundation

// Noise over the answer: a short sound while an answer plays does not cut it. Owner: voice agent. The cut itself
// (barge-in) stands in `RealtimeConversation+Playback.swift`, the fixes to the heard text in
// `RealtimeConversation+SpeechBargeIn.swift`.
//
// Rules:
// - OpenAI filters the microphone before its VAD (`noise_reduction` `far_field`, `RealtimeInstructions.session`), and
//   its VAD does not cancel responses (`interrupt_response: false`): the app decides the cut.
// - `speech_started` while an answer plays or waits to play (a Soniox item or a tool's reading not over, or audio in
//   the queue): the playback volume drops to ``RealtimeBargeIn/duckedVolume`` and the window
//   ``RealtimeBargeIn/window`` starts.
//   - `speech_stopped` within the window: the length of the speech by the VAD's own times decides
//     (``RealtimeBargeIn/speechLength(startMs:endMs:)``). At least ``RealtimeBargeIn/minimumSpeech``: the barge-in
//     now, as at the end of the window, and the utterance gets its answer.
//   - Shorter, or an event without its time: noise. The volume comes back, the answer goes on, the utterance orders no
//     answer and its committed item is deleted (the same path as the utterance a mute cut, `droppingUtterance`);
//     `voice-agent: noise ignored` in `client.log`.
//   - The window ends with no `speech_stopped`: the barge-in (`bargeIn()`), with what played up to now as heard (the
//     ducked part too), then the volume back.
// - The host hears each window open, with the count of kept utterances at that moment
//   (`Handlers.soundOverAnswer`): noise is dropped for the model, but a host whose tool needs the user's word may
//   refuse to act on a word that a sound followed.
// - Tool calls wait for the verdict: a call that comes within the window, and the work of a call that has not started
//   yet (registered before its task, `run`), are held (all three tools, one rule; `ask_session` only reads, and loses
//   at most the window). Noise runs them in order, as if no sound had come. The barge-in drops them with the
//   responses it cuts: no result, nothing ordered. The end and the mute drop them too; after the mute their response
//   goes on, so its other results still go.
// - The end of a tool's reading waits for the verdict too (`RealtimeConversation+Reading.swift`): noise and the mute
//   end it then, the barge-in cuts it, the end of the conversation drops it.
// - After noise, tool results and their `response.create` wait until the noise's `committed` deleted its item, so the
//   model never answers the noise. The wait is bounded by events, not a timer: the server sends that `committed`
//   before any later `speech_started`, so the next counted speech ends the wait too; the mute ends it at once (a
//   `committed` still on its way then deletes its item after the results); the end of the conversation drops it.
// - `speech_started` while nothing plays: the barge-in at once, as before the window existed.
// - The end of the conversation and the mute close the window: no cut, nothing ordered, the volume back.

enum RealtimeBargeIn {
  /// Speech over an answer shorter than this is noise. 0.4 s: a cough, a click or a door is shorter; a word meant to
  /// stop the answer is longer.
  static let minimumSpeech: TimeInterval = 0.4
  /// The window after `speech_started`. Server VAD sends `speech_stopped` only after `silence_duration_ms` of silence
  /// (`RealtimeInstructions.silenceMs`), so a sound of ``minimumSpeech`` ends at the app that much later; a window of
  /// ``minimumSpeech`` alone would never see the end of a short sound.
  static let window: TimeInterval = minimumSpeech + Double(RealtimeInstructions.silenceMs) / 1000
  /// Playback volume during the window: the user hears the answer go quiet, so they know they were heard.
  static let duckedVolume: Float = 0.25

  /// The length of the speech by the VAD's times on the input audio axis: `audio_end_ms` of `speech_stopped` minus
  /// `audio_start_ms` of `speech_started`. OpenAI's reference for these events says the start includes
  /// `prefix_padding_ms` and the end includes the silence of `silence_duration_ms` (not measured in this repo), so
  /// both come off. `nil` when an event carried no time: the arrival within the window decides then.
  static func speechLength(startMs: Int?, endMs: Int?) -> TimeInterval? {
    guard let startMs, let endMs else { return nil }
    let milliseconds = endMs - startMs - RealtimeInstructions.prefixPaddingMs - RealtimeInstructions.silenceMs
    return TimeInterval(milliseconds) / 1000
  }
}

extension RealtimeConversation {
  /// Speech over an answer that plays, until the verdict: noise or the cut.
  struct BargeInWindow {
    let timer: VoiceTimer
    /// `audio_start_ms` of the `speech_started` that opened the window; `nil` when it carried none.
    let speechStartMs: Int?
    /// Tool calls that wait for the verdict, in the order they came.
    var held: [HeldTool] = []
  }

  /// A tool call the window holds: the call itself (registered with its response, not performed), or the work of a
  /// call that has not started yet (`run`).
  enum HeldTool {
    case call(response: String, callId: String, action: RealtimeToolAction?)
    case work(response: String, callId: String, work: @MainActor () async -> RealtimeToolResult)

    var response: String {
      switch self {
      case let .call(response, _, _), let .work(response, _, _): response
      }
    }

    var callId: String {
      switch self {
      case let .call(_, callId, _), let .work(_, callId, _): callId
      }
    }
  }

  /// `speech_started`: the barge-in at once while nothing plays; over an answer that plays, the window first.
  func speechOverAnswer(startMs: Int?) {
    guard bargeInWindow == nil else { return }
    guard !tts.items.isEmpty || !readings.active.isEmpty || playbackPending else {
      bargeIn()
      return
    }
    dependencies.audio.playbackVolume = RealtimeBargeIn.duckedVolume
    let generation = generation
    let timer = dependencies.scheduler.schedule(after: RealtimeBargeIn.window) { [weak self] in
      guard let self, self.current(generation) else { return }
      self.cutOverAnswer()
    }
    var window = BargeInWindow(timer: timer, speechStartMs: startMs)
    // Work whose task has not started yet waits for the verdict too; work already running goes on.
    window.held = unstartedWork.filter { accepts(generation: $0.generation, token: $0.token, response: $0.response) }
      .map { .work(response: $0.response, callId: $0.callId, work: $0.work) }
    unstartedWork = []
    bargeInWindow = window
    handlers.soundOverAnswer(utterances)
  }

  /// `speech_stopped` within the window: noise unless the VAD's times say speech, which cuts now. True when it was
  /// noise.
  func noiseOverAnswer(endMs: Int?) -> Bool {
    guard let window = bargeInWindow else { return false }
    if let length = RealtimeBargeIn.speechLength(startMs: window.speechStartMs, endMs: endMs),
      length >= RealtimeBargeIn.minimumSpeech
    {
      cutOverAnswer()
      return false
    }
    let held = closeBargeInWindow()
    droppingUtterance = true
    resultsAfterNoise = resultsAfterNoise ?? []
    handlers.diagnostic(.noiseIgnored)
    runHeld(held)
    completeWaitingReadings()
    return true
  }

  /// The noise's `committed` was handled (its item deleted), or will not come (the next speech, the mute): the tool
  /// results that waited go out, with their `response.create`.
  func releaseResultsAfterNoise() {
    guard let waiting = resultsAfterNoise else { return }
    resultsAfterNoise = nil
    for response in waiting.sorted() where !interrupted.contains(response) { flush(response) }
    updatePhase()
  }

  /// The window ends in the barge-in, then the volume comes back. The held calls go with it: the barge-in drops
  /// every call and result in flight.
  func cutOverAnswer() {
    guard let window = bargeInWindow else { return }
    window.timer.cancel()
    bargeInWindow = nil
    bargeIn()
    dependencies.audio.playbackVolume = 1
  }

  /// The window closes with no cut (noise, the end, the mute): the timer goes and the volume comes back. Returns the
  /// calls it held.
  @discardableResult
  func closeBargeInWindow() -> [HeldTool] {
    guard let window = bargeInWindow else { return [] }
    window.timer.cancel()
    bargeInWindow = nil
    dependencies.audio.playbackVolume = 1
    return window.held
  }

  /// A tool call while the window is open waits for the verdict. True when held.
  func hold(_ call: HeldTool) -> Bool {
    guard bargeInWindow != nil else { return false }
    bargeInWindow?.held.append(call)
    return true
  }

  /// Noise: the held calls run as if no sound had come. A call whose response was cut in the meantime (the engine
  /// lost the playback) is dropped, as a call of an interrupted response.
  private func runHeld(_ held: [HeldTool]) {
    for entry in held {
      switch entry {
      case let .call(response, callId, action):
        guard !interrupted.contains(response) else { continue }
        perform(action, response: response, callId: callId)
      case let .work(response, callId, work):
        run(callId: callId, response: response, work)
      }
    }
  }

  /// The mute: the held calls are dropped. Their response goes on, so they leave its calls, and its other results
  /// still go out with its `response.done`.
  func dropHeld(_ held: [HeldTool]) {
    guard !held.isEmpty else { return }
    var responses: [String] = []
    for entry in held {
      callsByResponse[entry.response]?.removeAll { $0 == entry.callId }
      if callsByResponse[entry.response]?.isEmpty == true { callsByResponse[entry.response] = nil }
      asking.remove(entry.callId)
      sending.remove(entry.callId)
      if !responses.contains(entry.response) { responses.append(entry.response) }
    }
    for response in responses where !interrupted.contains(response) { flush(response) }
    updatePhase()
  }
}
