import Foundation

// Soniox speech in the voice conversation: OpenAI Realtime answers with text only, and `SonioxSpeech` reads each
// answer item aloud; its PCM goes to the playback of the conversation (`RealtimeConversation+Playback.swift`).
// Owner: voice agent. Every conversation speaks this way (`Dependencies.speech`); there is no OpenAI voice, and the
// app offers the voice agent only where the server announces Soniox speech and the build has Soniox
// (`VoiceAgentAvailability`).
//
// Rules:
// - The speech key is fetched at the tap, beside the OpenAI key (`RealtimeConversation+Start.swift`), and both come
//   before the OpenAI socket and `session.update`. No speech key: no OpenAI socket opens, the conversation ends and
//   the end names the speech key's reason.
// - An answer item has three ends: its text (`response.output_text.done`, or the response's `response.done`), its
//   synthesis (`SonioxSpeech.Event.finished`) and its playback (the queue drained after the synthesis). The phase
//   "speaking" lasts while an item that has played audio is not over, so a `drained` before the end of the synthesis
//   ends neither the item nor the phase.
// - Items speak in the order of their first text, one Soniox stream at a time (`SonioxSpeech`, rule 1). A tool's
//   reading is a stream of its own in the same queue (`RealtimeConversation+Reading.swift`).
// - A Soniox failure during the conversation ends it with its reason, without a retry. A key near its expiry is
//   renewed through the same provider (`keyNeeded`); no key then ends the conversation too. One exception: the stream
//   limit (`SonioxSpeech.Failure.isStreamLimit`) ends that item's synthesis; what Soniox said plays out and the item
//   is fixed to it in the conversation (`RealtimeConversation+SpeechBargeIn.swift`); its later text does not go to
//   Soniox.
// - Speech over the answer: `RealtimeConversation+SpeechBargeIn.swift`.
// - The price counts the characters that went out in text frames (`SonioxSpeech`, rule 6), not text that waited in
//   the queue and was cancelled or cut off by the end.
// - `client.log` gets events and numbers only, never the text or the key: `tts start`, `tts first pcm`, `tts end`,
//   `tts cancel`, `tts error <code>`, a speech line per response (characters, GENERATED audio, price) and the total
//   in the end line.

/// Why there is no Soniox speech key.
enum SonioxSpeechKeyError: Error, Sendable, Equatable {
  /// Soniox speech is off on the server or its Soniox key does not work.
  case off
  /// The server throttles speech keys.
  case throttled
  /// Network, server, Soniox, or a key the app cannot use.
  case unavailable

  var end: RealtimeConversation.End {
    switch self {
    case .off: .speechOff
    case .throttled: .throttled
    case .unavailable: .speechUnavailable
    }
  }
}

/// The Soniox speech key of the conversation; the screen wires the server route (`VoiceAgentKeys`).
@MainActor
protocol SonioxSpeechKeyProvider: AnyObject {
  func speechKey() async throws(SonioxSpeechKeyError) -> SonioxSpeechConfig
}

extension RealtimeConversation {
  /// What Soniox speech needs: the key provider, the socket, the wall clock for the key expiry and the timing.
  struct Speech {
    var keys: any SonioxSpeechKeyProvider
    var socket: VoiceSocketFactory
    var clock: @MainActor () -> Date
    var timing: SonioxSpeech.Timing

    @MainActor
    init(
      keys: any SonioxSpeechKeyProvider, socket: @escaping VoiceSocketFactory = URLSessionVoiceSocket.factory,
      clock: @escaping @MainActor () -> Date = { Date() }, timing: SonioxSpeech.Timing = .production
    ) {
      self.keys = keys
      self.socket = socket
      self.clock = clock
      self.timing = timing
    }
  }

  /// One answer item Soniox speaks.
  struct SpokenItem {
    let response: String
    var textEnded = false
    var hadAudio = false
    var synthesized = false
    /// The characters Soniox said, with their times on the item's audio.
    var spoken = SonioxSpokenText()
    /// The stream hit Soniox's limit: the synthesis ended early, so the item is fixed to what was said.
    var cut = false
  }

  /// Soniox speech state of one conversation run.
  struct SpeechState {
    var client: SonioxSpeech?
    var keyTask: Task<Void, Never>?
    /// Answer items not over yet, by item id. Speech over the answer takes them out.
    var items: [String: SpokenItem] = [:]
    /// Speech of each response until its line goes to `client.log`.
    var counts: [String: SpeechCount] = [:]
    var total = SpeechCount()
    /// The end of speech whose first PCM is already logged.
    var firstPCMFor: TimeInterval?
    // Fixes of the conversation to what the user heard (`RealtimeConversation+SpeechBargeIn.swift`).
    /// Text items of each response in the order of their first delta, spoken or not.
    var written: [String: [String]] = [:]
    /// Items the conversation keeps as they are: played out whole, or fixed already.
    var settled: Set<String> = []
    /// What the user heard of an item that is to be fixed; "" = nothing (the item is only deleted).
    var heardText: [String: String] = [:]
    /// The item before each assistant item (`conversation.item.added`), for the item that replaces it.
    var previous: [String: String] = [:]
    /// Interrupted responses whose items are fixed at their `response.done`.
    var toFix: Set<String> = []
    /// A `response.create` waits until the fixes of `toFix` went out.
    var orderHeld = false
    /// Items the stream limit cut: their later text never goes to Soniox, also after they played out.
    var limited: Set<String> = []
  }

  /// An item or a reading that played audio has not ended: the conversation speaks.
  var speechSpeaking: Bool { tts.items.values.contains { $0.hadAudio } || readingSpeaking }
  /// An item waits for its synthesis or playback, or a response waits for the fixes.
  var speechWaiting: Bool { !tts.items.isEmpty || tts.orderHeld }

  /// The total for the end line. An item or a tool's reading whose synthesis did not end makes it a floor.
  var speechTotal: SpeechCount {
    var total = tts.total
    let itemCut = tts.items.values.contains { !$0.synthesized }
    let readingCut = readings.active.values.contains { !$0.synthesized }
    if itemCut || readingCut { total.cut = true }
    return total
  }

  // MARK: - Start and end

  /// The Soniox client of this run; its socket opens now, ahead of the first text.
  func startSpeech(_ config: SonioxSpeechConfig, generation: Int) {
    let speech = dependencies.speech
    let client = SonioxSpeech(
      config: config, connect: speech.socket, scheduler: dependencies.scheduler, clock: speech.clock,
      timing: speech.timing,
      onEvent: { [weak self] event in
        guard let self, self.current(generation) else { return }
        self.speechEvent(event, generation: generation)
      },
      sent: { [weak self] item, characters in
        guard let self, self.current(generation) else { return }
        self.speechSent(characters, item: item)
      })
    tts.client = client
    client.start()
  }

  func stopSpeech() {
    tts.keyTask?.cancel()
    tts.keyTask = nil
    tts.client?.close()
    tts.client = nil
  }

  // MARK: - Text from OpenAI

  func speak(_ text: String, response: String, item: String) {
    // Every text item counts for the fixes, also one of an interrupted response that never speaks.
    if tts.written[response]?.contains(item) != true { tts.written[response, default: []].append(item) }
    guard audioRunning, let client = tts.client, !interrupted.contains(response), !text.isEmpty,
      !tts.settled.contains(item), !tts.limited.contains(item)
    else { return }
    if tts.items[item] == nil {
      tts.items[item] = SpokenItem(response: response)
      handlers.diagnostic(.speechStart)
    }
    guard let entry = tts.items[item], !entry.textEnded else { return }
    client.append(text, to: item)
    updatePhase()
  }

  /// Characters of an item or a reading went out to Soniox: they count for the price.
  private func speechSent(_ characters: Int, item: String) {
    guard let response = tts.items[item]?.response else {
      guard readings.active[item] != nil else { return }
      tts.total.characters += characters
      // A reading's whole text goes out with its start frame: its stream started.
      readingStreamStarted(item)
      return
    }
    tts.counts[response, default: SpeechCount()].characters += characters
    tts.total.characters += characters
  }

  func speechTextDone(item: String) {
    guard var entry = tts.items[item], !entry.textEnded else { return }
    entry.textEnded = true
    tts.items[item] = entry
    // A stream the limit ended is over at Soniox: an end now would queue the item again.
    if !entry.cut { tts.client?.end(item) }
  }

  /// `response.done`: every item of the response has its whole text (a cancelled response sends no
  /// `output_text.done`), and its speech line goes out once its items are over.
  func speechResponseDone(_ response: String) {
    for (item, entry) in tts.items where entry.response == response && !entry.textEnded { speechTextDone(item: item) }
    fixAtDone(response)
    logSpeech(response)
    answerMayBeOver(response)
  }

  // MARK: - Playback

  /// The queue drained: every synthesized item played out.
  func speechDrained() {
    for (item, entry) in tts.items where entry.synthesized { completeSpeech(item) }
  }

  // MARK: - Soniox events

  private func speechEvent(_ event: SonioxSpeech.Event, generation: Int) {
    if readingEvent(event) { return }
    switch event {
    case let .audio(item, pcm): speechAudio(pcm, item: item)
    case let .characters(item, characters): tts.items[item]?.spoken.append(characters)
    case let .finished(item): speechFinished(item)
    case .keyNeeded: renewSpeechKey(generation: generation)
    case let .failed(failure):
      handlers.diagnostic(.speechError(code: failure.logCode))
      // The stream limit ends that item's synthesis only; its `finished` follows.
      if failure.isStreamLimit, case let .stream(item, _, _) = failure, var entry = tts.items[item] {
        entry.cut = true
        tts.items[item] = entry
        tts.limited.insert(item)
        answers.limited.insert(entry.response)
        tts.counts[entry.response, default: SpeechCount()].cut = true
        tts.total.cut = true
        return
      }
      end(.speechFailed)
    }
  }

  private func speechAudio(_ pcm: Data, item: String) {
    guard var entry = tts.items[item] else { return }
    // Generated audio counts for the price whether it plays or not.
    let samples = RealtimeAudioFormat.samples(in: pcm)
    tts.counts[entry.response, default: SpeechCount()].samples += samples
    tts.total.samples += samples
    logFirstPCM()
    guard !interrupted.contains(entry.response) else { return }
    entry.hadAudio = true
    tts.items[item] = entry
    answers.audible.insert(entry.response)
    play(pcm, response: entry.response, item: item)
  }

  /// The first PCM from Soniox since the end of the user's speech: its time goes to `client.log` once.
  func logFirstPCM() {
    guard let stoppedAt = speechStoppedAt, tts.firstPCMFor != stoppedAt else { return }
    tts.firstPCMFor = stoppedAt
    let milliseconds = Int(((dependencies.scheduler.now - stoppedAt) * 1000).rounded())
    handlers.diagnostic(.speechFirstPCM(milliseconds: milliseconds))
  }

  private func speechFinished(_ item: String) {
    guard var entry = tts.items[item] else { return }
    handlers.diagnostic(.speechEnd)
    entry.synthesized = true
    tts.items[item] = entry
    // Its audio already played (or it had none): the item is over now; otherwise at the next `drained`.
    if !entry.hadAudio || !playbackPending { completeSpeech(item) }
    updatePhase()
  }

  /// The item played out whole: the conversation keeps it, unless the stream limit cut its synthesis short.
  private func completeSpeech(_ item: String) {
    guard let entry = tts.items.removeValue(forKey: item) else { return }
    // Text the user never heard: the response does not count as played out whole.
    if !entry.hadAudio { answers.silent.insert(entry.response) }
    if !playbackPending, items[item] != nil {
      items[item] = nil
      itemOrder.removeAll { $0 == item }
    }
    if entry.cut {
      tts.heardText[item] = entry.spoken.heard(playedSamples: .max, sampleRate: RealtimeAudioFormat.sampleRate)
      if doneResponses.contains(entry.response) { fixItem(item) }
    } else {
      tts.settled.insert(item)
    }
    logSpeech(entry.response)
    answerMayBeOver(entry.response)
  }

  /// The speech line of a response that is over and whose items all ended.
  func logSpeech(_ response: String) {
    guard doneResponses.contains(response), !tts.items.values.contains(where: { $0.response == response }),
      let number = usage.numbers[response], let count = tts.counts.removeValue(forKey: response)
    else { return }
    handlers.diagnostic(.speechResponse(number: number, count))
  }

  /// `keyNeeded`: a new key through the same provider; no key ends the conversation (no retry).
  private func renewSpeechKey(generation: Int) {
    guard tts.keyTask == nil else { return }
    let keys = dependencies.speech.keys
    tts.keyTask = Task { [weak self] in
      let result: Result<SonioxSpeechConfig, SonioxSpeechKeyError>
      do throws(SonioxSpeechKeyError) {
        result = .success(try await keys.speechKey())
      } catch {
        result = .failure(error)
      }
      guard let self, self.current(generation), !Task.isCancelled else { return }
      self.tts.keyTask = nil
      switch result {
      case let .success(config): self.tts.client?.renew(config)
      case let .failure(error): self.end(error.end)
      }
    }
  }
}
