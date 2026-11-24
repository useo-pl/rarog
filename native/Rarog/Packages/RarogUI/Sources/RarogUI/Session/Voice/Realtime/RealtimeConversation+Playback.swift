import Foundation

// Playback and barge-in of the voice agent conversation: Soniox PCM on the engine's sample axis
// (`RealtimeAudio.playedSamples`), the answer items that lie on it, the drained queue, and the cut to what the
// user heard when they speak over the answer or the engine restarts. Owner: voice agent. The events that call in
// stand in `RealtimeConversation.swift` and `RealtimeConversation+Speech.swift`; the fixes of the conversation to
// the heard text in `RealtimeConversation+SpeechBargeIn.swift`; the window that tells noise from speech over the
// answer in `RealtimeConversation+Noise.swift`. A tool's reading plays on the same axis without an answer item
// (`RealtimeConversation+Reading.swift`); the cut stops it and a lost playback ends it as not read.

extension RealtimeConversation {
  func play(_ pcm: Data, response: String, item: String) {
    guard audioRunning, !interrupted.contains(response), !pcm.isEmpty else { return }
    let count = RealtimeAudioFormat.samples(in: pcm)
    if var entry = items[item] {
      entry.count += count
      items[item] = entry
    } else {
      items[item] = (response, cursor, count)
      itemOrder.append(item)
    }
    enqueue(pcm)
  }

  /// `pcm` at the end of the playback queue, at the cursor: an answer item's or a reading's
  /// (`RealtimeConversation+Reading.swift`).
  func enqueue(_ pcm: Data) {
    meter.queued(pcm, at: cursor)
    cursor += RealtimeAudioFormat.samples(in: pcm)
    playbackPending = true
    dependencies.audio.play(pcm)
    updatePhase()
  }

  func playbackStarted(latency: TimeInterval) {
    guard let stoppedAt = speechStoppedAt else { return }
    speechStoppedAt = nil
    let milliseconds = Int(((dependencies.scheduler.now - stoppedAt + latency) * 1000).rounded())
    handlers.diagnostic(.firstAudio(milliseconds: milliseconds))
  }

  func drained() {
    playbackPending = false
    speechDrained()
    readingsDrained()
    // Elementy zamkniętych odpowiedzi są całe odtworzone; element odpowiedzi w toku zostaje, bo jego dalsze delty
    // dochodzą na tej samej osi. An item is over only after its synthesis too (`+Speech`).
    itemOrder.removeAll { item in
      guard items[item] != nil, tts.items[item] == nil else { return false }
      items[item] = nil
      return true
    }
    updatePhase()
  }

  /// Mowa rozmówcy: przerwane odpowiedzi w toku i grane audio, przycięte do tego, co rozmówca usłyszał. Over an
  /// answer that plays it comes after the window of `RealtimeConversation+Noise.swift`.
  func bargeIn() {
    interrupted.formUnion(activeResponses)
    // `interrupt_response: false` (`RealtimeInstructions.session`): OpenAI goes on generating until the app cancels.
    for response in activeResponses.sorted() { send(RealtimeClientEvent.responseCancel(response)) }
    for entry in items.values where !doneResponses.contains(entry.response) || playbackPending {
      interrupted.insert(entry.response)
    }
    // With the queue drained, everything queued has played.
    let played = playbackPending ? truncatePlayback() : cursor
    speechInterrupted(played: played, responses: activeResponses)
    cutReadings()
    activeResponses = []
    awaitingResponse = false
    // Wyniki narzędzi w toku i odpowiedzi zamówione przed tą chwilą należą do przerwanej wymiany.
    turnToken += 1
    retryResponse = false
    // A response.create held for the fixes belonged to the utterance now spoken over.
    tts.orderHeld = false
    asking = []
    sending = []
    unstartedWork = []
    callsByResponse = [:]
    results = [:]
    items = [:]
    itemOrder = []
    speechStoppedAt = nil
    zeroLevels()
    answerCut()
    updatePhase()
  }

  /// Silnik audio wystartował od nowa i zgubił kolejkę odtwarzania: elementy przycięte do tego, co rozmówca
  /// usłyszał, a dalsze delty tych odpowiedzi nie grają, bo oś odtwarzania już się z nimi nie zgadza.
  func playbackLost() {
    guard playbackPending else { return }
    for entry in items.values { interrupted.insert(entry.response) }
    let played = truncatePlayback()
    speechInterrupted(played: played, responses: [])
    items = [:]
    itemOrder = []
    zeroLevels()
    answerCut()
    loseReadings()
    updatePhase()
  }

  /// The playback queue thrown away; the cursor at this moment. Returns the sample the user heard up to; the text
  /// items are fixed to it with `delete` + `create` (`RealtimeConversation+SpeechBargeIn.swift`).
  private func truncatePlayback() -> Int {
    let played = dependencies.audio.clearPlayback()
    cursor = played
    playbackPending = false
    return played
  }
}
