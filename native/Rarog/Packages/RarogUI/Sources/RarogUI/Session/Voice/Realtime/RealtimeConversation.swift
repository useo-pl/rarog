import Foundation
import RarogContract

// The voice conversation with OpenAI Realtime about what its host gives it (`Content`: instructions, later content,
// tools; the session screen's host is `VoiceAgentSessionHost`). Owner: voice agent.
//
// Flow: at the tap the Soniox speech key, the ephemeral OpenAI key from the server (injected providers; the app has
// no standing OpenAI key) and the audio engine start side by side (`RealtimeConversation+Start.swift`) → with both
// keys the socket with the ephemeral key → `session.update` with the host's instructions and tools → with the
// engine running and `session.updated` the conversation listens → the user speaks to OpenAI, OpenAI answers with
// text and Soniox reads it aloud (`RealtimeConversation+Speech.swift`); there is no OpenAI voice. Everything that
// comes from the network or a tool checks two things:
// - generację rozmowy: koniec rozmowy (i każdy nowy start) podnosi numer, więc klucz, zdarzenie gniazda, wynik
//   narzędzia i start audio sprzed niego przepadają bez śladu (wzór `RarogStore+Voice.swift`, `mints == …`);
// - przerwaną odpowiedź: mowa rozmówcy (`input_audio_buffer.speech_started`) przerywa odpowiedzi w toku i grane
//   audio, a ich spóźnione delty, karty i wyniki narzędzi są odrzucane i nie wołają `response.create`. Over an
//   answer that plays the cut waits for the window of `RealtimeConversation+Noise.swift` (a short sound is noise);
//   OpenAI cancels nothing itself (`interrupt_response: false`), so the cut sends `response.cancel`. Tool calls
//   wait for that verdict.
//
// The app orders the answer (`create_response: false`): after `input_audio_buffer.committed` first the host's new
// content (`conversation.item.create`), then `response.create`. The tool results of an answer go after its
// `response.done`, together, with one `response.create`. A tool may have a text read aloud first; its result then
// waits for the reading's end (`RealtimeConversation+Reading.swift`). The OpenAI limit ends the conversation without
// a retry.
//
// The conversation has no captions and no copy: its host's screen shows its state (`VoiceAgentIndicator`; the
// session screen in the status row of the message field) and its levels (`RealtimeConversation+Levels.swift`).
// The composer mic mutes it (`RealtimeConversation+Mute.swift`).

@MainActor
final class RealtimeConversation {
  let dependencies: Dependencies
  let content: Content
  let handlers: Handlers

  private(set) var phase = Phase.idle
  /// Version of the prompt of the last `show_prompt` while it stands in the message field; `nil` = none, or it left
  /// the field (sent, cleared, replaced by the user: ``promptLeftField()``).
  var fieldPrompt: Int?

  /// Levels for the voice agent button (`RealtimeConversation+Levels.swift`).
  var meter = RealtimeLevelMeter()
  var levelTimer: VoiceTimer?
  var lastLevels = RealtimeLevels.zero

  var generation = 0
  /// Key fetches, readiness and stage times of the start (`RealtimeConversation+Start.swift`).
  var starting = StartState()
  private var audioTask: Task<Void, Never>?
  private var socket: (any VoiceSocket)?
  /// The Realtime socket to OpenAI is open (a remote close ends the conversation, so it reads `false` only around
  /// the end).
  var socketOpen: Bool { socket != nil }
  /// The Soniox speech socket of this run is open.
  var speechOpen: Bool { tts.client?.isOpen == true }
  /// The clock time of the last microphone frame of this run, muted or not.
  private var lastInputAt: TimeInterval?
  /// Model, który serwer Raroga związał z kluczem krótkim (porównanie z `session.created`).
  private var keyModel: String?
  /// `session.update` wysłane, `session.updated` jeszcze nie.
  private var configuring = false
  private var budget: Int
  private var retriedInstructions = false
  /// The readiness gate: the audio engine runs and `session.updated` came (`RealtimeConversation+Start.swift`).
  /// Microphone input, the phase and the answer paths wait for it.
  var audioRunning = false
  /// The composer mic muted the conversation: no microphone audio goes to OpenAI (`RealtimeConversation+Mute.swift`).
  /// Every conversation starts unmuted.
  var muted = false
  /// The utterance that a mute cut, or noise over the answer: its late VAD events order nothing, and its committed
  /// item leaves the conversation (`RealtimeConversation+Mute.swift`, `RealtimeConversation+Noise.swift`).
  var droppingUtterance = false
  /// Speech over an answer that plays: the window in which its end can make it noise, and the tool calls it holds
  /// (`RealtimeConversation+Noise.swift`).
  var bargeInWindow: BargeInWindow?
  /// After a noise verdict, until its utterance's `committed` is handled: the responses whose tool results wait, so
  /// the noise item leaves the conversation first (`RealtimeConversation+Noise.swift`). `nil`: nothing waits.
  var resultsAfterNoise: Set<String>?
  /// Generacja, która ostatnia wołała `audio.start` — tylko ona może zatrzymać silnik po spóźnionym starcie.
  private var audioOwner = 0

  // Odpowiedzi i przerwania.
  var activeResponses: Set<String> = []
  var doneResponses: Set<String> = []
  var interrupted: Set<String> = []
  /// `committed` → `response.create` wysłane, `response.created` jeszcze nie.
  var awaitingResponse = false
  /// Wysłane `response.create` bez `response.created`, każde z numerem wymiany (`turnToken`) z chwili wysłania.
  /// Serwer tworzy odpowiedzi w kolejności zamówień, więc `response.created` zdejmuje pierwszy wpis.
  private var orderedResponses: [Int] = []
  /// `response.create` odrzucone, bo serwer miał jeszcze odpowiedź w toku: ponowienie po jej `response.done`.
  var retryResponse = false
  /// Numer „kolejki” wyników narzędzi: przerwanie mową go podnosi, więc wyniki sprzed niego przepadają.
  var turnToken = 0

  // Narzędzia.
  private var functionNames: [String: String] = [:]
  /// Wywołania odpowiedzi w kolejności przyjścia.
  var callsByResponse: [String: [String]] = [:]
  var results: [String: String] = [:]
  var asking: Set<String> = []
  var sending: Set<String> = []
  /// Work of tool calls whose task has not started yet, in call order (`run`).
  var unstartedWork: [UnstartedWork] = []

  // The prompt in the message field: the last version `show_prompt` gave, the response that wrote it, and the
  // utterances since (`send_prompt` waits for the user's answer).
  var promptVersion = 0
  var promptResponse: String?
  var committedSincePrompt = 0
  /// Kept utterances of the user in this run (noise and muted speech do not count): a host tool that waits for the
  /// user's word compares it (`RealtimeToolTurn`).
  var utterances = 0

  // Odtwarzanie: oś próbek silnika (`playedSamples`), na której leżą elementy odpowiedzi.
  // Playback and barge-in: `RealtimeConversation+Playback.swift`.
  var cursor = 0
  var items: [String: (response: String, start: Int, count: Int)] = [:]
  var itemOrder: [String] = []
  var playbackPending = false
  var speechStoppedAt: TimeInterval?

  /// Tokens, price and counters for `client.log` (`RealtimeConversation+Usage.swift`).
  var usage = UsageLog(startedAt: 0)
  /// Soniox speech of this run (`RealtimeConversation+Speech.swift`).
  var tts = SpeechState()
  /// What the host learns about the answers of this run (`RealtimeConversation+Answer.swift`).
  var answers = AnswerLog()
  /// Tools' readings of this run (`RealtimeConversation+Reading.swift`).
  var readings = ReadingState()

  init(dependencies: Dependencies, content: Content, handlers: Handlers) {
    self.dependencies = dependencies
    self.content = content
    self.handlers = handlers
    budget = content.budget
  }

  // MARK: - Start i koniec

  /// Otwiera rozmowę. Po końcu wolno wołać ponownie: nowa generacja, nowy klucz krótki, nowe gniazdo.
  func start() {
    switch phase {
    case .idle, .ended: break
    default: return
    }
    reset()
    generation += 1
    let generation = generation
    setPhase(.connecting)
    fetchStartKeys(generation: generation)
    startAudio(generation: generation)
  }

  /// End of the conversation: audio and socket closed, requests in flight invalidated (the ephemeral key fetch too),
  /// levels and speech back to zero. `detail`: what in the app closed it (`VoiceAgentWatch.Reason`), for the end
  /// line in `client.log`.
  func end(_ reason: End = .closed, detail: String? = nil) {
    if case .ended = phase { return }
    if phase == .idle { return }
    generation += 1
    starting.cancel()
    audioTask?.cancel()
    audioTask = nil
    socket?.close()
    socket = nil
    stopSpeech()
    closeBargeInWindow()
    // The total sees the readings still in synthesis before they go.
    let spoken = speechTotal
    dropReadings()
    unstartedWork = []
    resultsAfterNoise = nil
    dependencies.audio.stop()
    audioRunning = false
    muted = false
    droppingUtterance = false
    configuring = false
    fieldPrompt = nil
    stopLevels()
    zeroLevels()
    handlers.speech(false)
    var line = usage.ended(reason, now: dependencies.scheduler.now, ordered: !orderedResponses.isEmpty)
    if case var .ended(summary) = line {
      summary.detail = detail
      summary.spoken = spoken
      line = .ended(summary)
    }
    handlers.diagnostic(line)
    setPhase(.ended(reason))
  }

  private func reset() {
    starting.cancel()
    starting = StartState(tappedAt: dependencies.scheduler.now)
    keyModel = nil
    configuring = false
    budget = content.budget
    retriedInstructions = false
    audioRunning = false
    muted = false
    droppingUtterance = false
    bargeInWindow = nil
    resultsAfterNoise = nil
    activeResponses = []
    doneResponses = []
    interrupted = []
    awaitingResponse = false
    orderedResponses = []
    retryResponse = false
    turnToken = 0
    functionNames = [:]
    callsByResponse = [:]
    results = [:]
    asking = []
    sending = []
    unstartedWork = []
    promptVersion = 0
    promptResponse = nil
    committedSincePrompt = 0
    utterances = 0
    fieldPrompt = nil
    cursor = dependencies.audio.playedSamples
    items = [:]
    itemOrder = []
    playbackPending = false
    speechStoppedAt = nil
    usage = UsageLog(startedAt: dependencies.scheduler.now)
    tts = SpeechState()
    answers = AnswerLog()
    readings = ReadingState()
    lastInputAt = nil
  }

  /// A microphone frame of this run came within `seconds` by the conversation's clock.
  func inputFresh(within seconds: TimeInterval) -> Bool {
    guard let lastInputAt else { return false }
    return dependencies.scheduler.now - lastInputAt < seconds
  }

  func current(_ generation: Int) -> Bool {
    guard self.generation == generation else { return false }
    if case .ended = phase { return false }
    return true
  }

  private func setPhase(_ next: Phase) {
    guard phase != next else { return }
    phase = next
    handlers.phase(next)
  }

  // MARK: - Gniazdo i sesja

  func connect(_ key: RealtimeEphemeralKey, speech: SonioxSpeechConfig, generation: Int) {
    startSpeech(speech, generation: generation)
    keyModel = key.model
    usage.model = key.model
    let request = RealtimeEndpoint.socketRequest(model: key.model, secret: key.value, auth: dependencies.socketAuth)
    let events = VoiceSocketEvents(
      opened: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.configure()
      },
      message: { [weak self] text in
        guard let self, self.current(generation) else { return }
        self.receive(text, generation: generation)
      },
      closed: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.socket = nil
        self.end(.dropped)
      })
    socket = dependencies.socket(request, events)
  }

  /// `session.update` with the host's instructions in the current budget and its tools: a text session, Soniox
  /// speaks the answers.
  private func configure() {
    let instructions = content.instructions(budget)
    configuring = true
    send(RealtimeClientEvent.sessionUpdate(instructions: instructions, tools: content.tools.map(\.schema)))
  }

  func send(_ event: String) {
    socket?.send(text: event)
  }

  private func receive(_ text: String, generation: Int) {
    guard let event = RealtimeServerEvent.parse(text) else { return }
    switch event {
    case let .sessionCreated(model):
      // Model wiąże klucz krótki; inny w sesji to wpis w `client.log`, nie koniec rozmowy.
      if let expected = keyModel, let model, model != expected {
        handlers.diagnostic(.modelMismatch(expected: expected, actual: model))
      }
      handlers.diagnostic(.session(model: model ?? keyModel))
      if let model { usage.model = model }
    case .sessionUpdated:
      guard configuring else { return }
      configuring = false
      sessionConfigured()
    case let .error(error):
      handle(error)
    case let .speechStarted(itemId, audioStartMs):
      guard speechStartCounts() else { return }
      noteSpeechStart(item: itemId, ms: audioStartMs)
      // The server sends a noise's `committed` before any later `speech_started`: it is not coming now.
      releaseResultsAfterNoise()
      usage.speechStarted()
      handlers.diagnostic(.speechStarted)
      speechOverAnswer(startMs: audioStartMs)
      handlers.speech(true)
    case let .speechStopped(audioEndMs):
      guard !muted, !droppingUtterance else { return }
      handlers.diagnostic(.speechStopped)
      handlers.speech(false)
      // Noise over the answer: the answer goes on, and its time to first audio is not this sound's.
      if noiseOverAnswer(endMs: audioEndMs) { return }
      speechStoppedAt = dependencies.scheduler.now
    case let .committed(itemId):
      let start = takeSpeechStart()
      guard commitCounts(itemId) else {
        // A noise item left the conversation: the tool results that waited for it go now.
        releaseResultsAfterNoise()
        return
      }
      committed(itemId, start: start)
    case let .responseCreated(id):
      responseCreated(id)
    case let .textDelta(responseId, itemId, text):
      speak(text, response: responseId, item: itemId)
    case let .textDone(_, itemId):
      speechTextDone(item: itemId)
    case let .assistantItemAdded(itemId, previousId):
      speechItemAdded(itemId, previous: previousId)
    case let .functionCallAdded(callId, name):
      functionNames[callId] = name
    case let .functionCall(responseId, callId, name, arguments):
      call(response: responseId, callId: callId, name: name.isEmpty ? functionNames[callId] ?? "" : name, arguments: arguments)
    case let .responseDone(id, status, error, usage):
      if let line = self.usage.done(id: id, status: status, usage: usage) { handlers.diagnostic(line) }
      responseDone(id: id, status: status, error: error)
    case .other:
      return
    }
  }

  private func handle(_ error: RealtimeServerError) {
    switch error.kind {
    case .rateLimit:
      end(.openAILimit)
    case .instructionsTooLong where configuring && !retriedInstructions:
      retriedInstructions = true
      budget /= 2
      handlers.diagnostic(.instructionsRetry)
      configure()
    case .instructionsTooLong:
      end(.instructionsTooLong)
    case .activeResponse:
      // Zamówienie przegrało wyścig z odpowiedzią, której serwer jeszcze nie zamknął (zwykle przerwanej mową):
      // tego `response.create` serwer nie wykona, więc ponowienie idzie po jej `response.done`.
      handlers.diagnostic(.serverError(code: error.code ?? "unknown"))
      if !orderedResponses.isEmpty { orderedResponses.removeLast() }
      awaitingResponse = !orderedResponses.isEmpty
      retryResponse = true
      updatePhase()
    case .other:
      if configuring {
        end(.failed)
      } else {
        handlers.diagnostic(.serverError(code: error.code ?? error.type ?? "unknown"))
      }
    }
  }

  // MARK: - Audio

  private func startAudio(generation: Int) {
    let audio = dependencies.audio
    audioOwner = generation
    let handlers = RealtimeAudioHandlers(
      started: { [weak self] format in
        guard let self, self.current(generation) else { return }
        self.handlers.diagnostic(.audioStarted(format: format))
      },
      input: { [weak self] pcm, capturedAt in
        guard let self, self.current(generation) else { return }
        self.lastInputAt = self.dependencies.scheduler.now
        // Before the readiness gate, and muted: the engine runs (playback, echo cancellation), but nothing goes out
        // or counts.
        guard self.audioRunning, !self.muted else { return }
        self.usage.input(pcm)
        self.meter.input(pcm)
        self.send(RealtimeClientEvent.appendAudio(pcm))
        self.inputAppended(pcm, capturedAt: capturedAt)
      },
      playbackStarted: { [weak self] latency in
        guard let self, self.current(generation) else { return }
        self.playbackStarted(latency: latency)
      },
      drained: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.drained()
      },
      interrupted: { [weak self] cause in
        guard let self, self.current(generation) else { return }
        self.handlers.diagnostic(.audioInterrupted(cause: cause))
        self.end(.audioInterrupted)
      },
      restarted: { [weak self] cause, lostPlayback in
        guard let self, self.current(generation) else { return }
        self.handlers.diagnostic(.audioRestarted(cause: cause))
        if lostPlayback { self.playbackLost() }
        self.zeroLevels()
      },
      startFailed: { [weak self] cause in
        guard let self, self.current(generation) else { return }
        self.handlers.diagnostic(.audioStartFailed(cause: cause))
      })
    audioTask = Task { [weak self] in
      do throws(VoiceMicError) {
        try await audio.start(handlers)
      } catch {
        guard let self, self.current(generation) else { return }
        self.end(.microphone(error))
        return
      }
      guard let self else {
        audio.stop()
        return
      }
      guard self.current(generation) else {
        // Rozmowa skończyła się w trakcie startu (np. pytania o zgodę na mikrofon). Silnik, który właśnie ruszył,
        // zatrzymuje tylko ten start, który jest wciąż ostatni: nowsza rozmowa mogła już wystartować ten sam silnik.
        if self.audioOwner == generation { audio.stop() }
        return
      }
      self.audioTask = nil
      self.engineStarted()
    }
  }

  // MARK: - Wypowiedź i odpowiedź

  /// The utterance is closed: the host's new content as a conversation item, then the answer is ordered. `start`: its
  /// `speech_started`, for the mark of the last reading (`RealtimeConversation+Reading.swift`).
  private func committed(_ itemId: String?, start: SpeechStart?) {
    guard audioRunning else { return }
    if fieldPrompt != nil { committedSincePrompt += 1 }
    utterances += 1
    compareUtterance(itemId, start: start)
    if speechStoppedAt == nil { speechStoppedAt = dependencies.scheduler.now }
    syncContent()
    // The fixes of an interrupted response go first (`RealtimeConversation+SpeechBargeIn.swift`).
    if !holdOrderForFixes() { orderResponse() }
    updatePhase()
  }

  /// The host's content that is new since the instructions, as a system item before the answer is ordered.
  private func syncContent() {
    guard let update = content.update() else { return }
    send(RealtimeClientEvent.sessionUpdateItem(update))
  }

  /// A `response.create` sent before the last speech over the answer has neither its `response.created` nor its
  /// `activeResponse` error yet.
  var ordersBeforeSpeechPending: Bool { orderedResponses.contains { $0 != turnToken } }

  /// Zamówienie odpowiedzi z numerem bieżącej wymiany.
  func orderResponse() {
    send(RealtimeClientEvent.responseCreate())
    orderedResponses.append(turnToken)
    awaitingResponse = true
  }

  /// Odpowiedź zamówiona przed ostatnim przerwaniem mową należy do starej wymiany: anulowana i odrzucona, zanim
  /// przyjdzie jej audio albo narzędzie.
  private func responseCreated(_ id: String) {
    usage.created(id)
    let token = orderedResponses.isEmpty ? turnToken : orderedResponses.removeFirst()
    awaitingResponse = !orderedResponses.isEmpty
    if token != turnToken {
      interrupted.insert(id)
      send(RealtimeClientEvent.responseCancel(id))
      speechResponseCancelled(id)
    } else {
      activeResponses.insert(id)
    }
    updatePhase()
  }

  private func responseDone(id: String, status: String, error: RealtimeServerError?) {
    activeResponses.remove(id)
    doneResponses.insert(id)
    if status == "failed", let error, error.kind == .rateLimit {
      end(.openAILimit)
      return
    }
    speechResponseDone(id)
    var ordered = !interrupted.contains(id) && flush(id)
    if releaseHeldOrder(ordered: ordered) { ordered = true }
    if retryResponse {
      retryResponse = false
      if !ordered { orderResponse() }
    }
    updatePhase()
  }

  func updatePhase() {
    guard audioRunning else { return }
    if case .ended = phase { return }
    // An answer item speaks until its Soniox synthesis and its playback are over, not until `response.done`.
    if playbackPending || speechSpeaking {
      setPhase(.speaking)
    } else if !asking.isEmpty {
      setPhase(.checkingSession)
    } else if awaitingResponse || !activeResponses.isEmpty || !sending.isEmpty || speechWaiting {
      setPhase(.thinking)
    } else {
      setPhase(.listening)
    }
  }
}
