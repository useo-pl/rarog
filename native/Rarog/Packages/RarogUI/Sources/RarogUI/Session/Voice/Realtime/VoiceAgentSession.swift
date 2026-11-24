import Foundation
import Observation
import RarogContract
import RarogCore

// The voice conversation core: wires `RealtimeConversation` to Rarog and to its host (`VoiceAgentHost`: content,
// tools, end rules; the session screen's host is `VoiceAgentSessionHost`). Owner: voice agent. The host's screen shows
// it (the session screen: the status row of the message field and the voice agent button,
// `SessionViewController+VoiceAgent.swift`); the rules stand here, in `VoiceAgentRules.swift` and in
// `VoiceAgentIndicator.swift`, so the tests run on macOS.
//
// - Ephemeral key from `POST /api/companion/token` (`RarogStore.mintCompanionToken`), refusals by code → end
//   reasons with their own sentence (`UICopy.voiceAgentEnd`). Before it the Soniox speech key from
//   `POST /api/companion/speech-token` (`RarogStore.mintCompanionSpeechToken`), checked by `SonioxSpeechConfig`:
//   Soniox speaks every answer.
// - The host's prompt tools: a shown prompt counts for ``VoiceAgentSession/SendMark`` and the indicator; a send goes
//   only while the login of the start holds.
// - Conversation diagnostics → `client.log` (`RarogStore.trace`), never the content.
// - End: second tap on the button, the screen goes away, dictation starts from another place (the composer mic
//   mutes instead, ``VoiceAgentSession/toggleMute()``), and every end reason of the host.

/// Droga rozmowy do Raroga: w apce magazyn, w testach atrapa.
@MainActor
protocol VoiceAgentBackend: AnyObject {
  func companionToken() async -> CompanionTokenOutcome
  /// The Soniox speech key (`POST /api/companion/speech-token`): Soniox speaks the answers.
  func companionSpeechToken() async -> CompanionSpeechTokenOutcome
  func ask(sessionId: String, question: String) async -> CompanionAskOutcome
  /// Wiadomości transkryptu sesji w oknie telefonu (projekcja i nowe tury).
  func transcript(sessionId: String) -> [TranscriptMessage]
  /// A `client.log` line under the budget the conversation names (`TraceBudget`).
  func trace(_ line: String, budget: TraceBudget)
  /// Numer zalogowania (`RarogStore.loginEpoch`): wylogowanie, odpięcie i zmiana serwera go podnoszą.
  var loginEpoch: Int { get }
  /// The session as the app's list has it, for the project and name the voice Live Activity shows; `nil` = the app
  /// does not have it.
  func sessionSummary(_ sessionId: String) -> SessionSummary?
}

extension RarogStore: VoiceAgentBackend {
  func companionToken() async -> CompanionTokenOutcome { await mintCompanionToken() }
  func companionSpeechToken() async -> CompanionSpeechTokenOutcome { await mintCompanionSpeechToken() }
  func sessionSummary(_ sessionId: String) -> SessionSummary? { state.sessions[sessionId] }

  func ask(sessionId: String, question: String) async -> CompanionAskOutcome {
    await askCompanion(sessionId: sessionId, question: question)
  }

  func transcript(sessionId: String) -> [TranscriptMessage] { state.transcripts[sessionId]?.messages ?? [] }
}

/// Dostawca klucza krótkiego dla rozmowy: trasa serwera przez ``VoiceAgentBackend``, odmowy po kodzie. It gives the
/// Soniox speech key too, in the app language and at the reading speed of the device setting.
@MainActor
final class VoiceAgentKeys: RealtimeEphemeralKeyProvider, SonioxSpeechKeyProvider {
  private weak var backend: (any VoiceAgentBackend)?
  /// Soniox reading speed (`VoiceAgentSettings.speechSpeed` at the start of the conversation); renewed keys keep it.
  private let speechSpeed: Double

  init(backend: any VoiceAgentBackend, speechSpeed: Double = VoiceAgentSettings.defaultSpeechSpeed) {
    self.backend = backend
    self.speechSpeed = speechSpeed
  }

  func ephemeralKey() async throws(RealtimeKeyError) -> RealtimeEphemeralKey {
    guard let backend else { throw .unavailable }
    switch await backend.companionToken() {
    case let .token(token):
      let expires = try? Date(token.expiresAt, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
      return RealtimeEphemeralKey(value: token.value, expiresAt: expires, model: token.model)
    case .disabled: throw .keyMissing
    case .keyRejected: throw .keyRejected
    case .throttled: throw .throttled
    case .openAILimit: throw .limit
    // Spóźniony wynik innego zalogowania, anulowanie, bramka zgodności: rozmowa się nie zaczyna.
    case .refused, .loggedOut, .cancelled, .unavailable: throw .unavailable
    }
  }

  func speechKey() async throws(SonioxSpeechKeyError) -> SonioxSpeechConfig {
    guard let backend else { throw .unavailable }
    switch await backend.companionSpeechToken() {
    case let .token(token):
      guard var config = SonioxSpeechConfig(token, language: SonioxSpeechConfig.language(.current)) else {
        throw .unavailable
      }
      config.speed = speechSpeed
      return config
    case .disabled: throw .off
    case .throttled: throw .throttled
    // A late result of another login, a cancel, the compatibility gate: the conversation does not start.
    case .refused, .loggedOut, .cancelled, .unavailable: throw .unavailable
    }
  }
}

extension SonioxSpeechConfig {
  /// The key from the server, checked at the boundary: a `snx_temp_` key, an expiry date, a `wss` address and the
  /// playback rate of the conversation (24 kHz). `nil` = the app cannot use it.
  init?(_ token: CompanionSpeechToken, language: String) {
    // Soniox gives the expiry with or without fractional seconds; the server passes it on as it is.
    let fractional = Date.ISO8601FormatStyle.iso8601.year().month().day().time(includingFractionalSeconds: true)
    guard SonioxKey.protocols(token.apiKey) != nil,
      let expiresAt = (try? Date(token.expiresAt, strategy: fractional))
        ?? (try? Date(token.expiresAt, strategy: .iso8601)),
      let url = URL(string: token.webSocketUri), url.scheme == "wss",
      token.sampleRate == RealtimeAudioFormat.sampleRate
    else { return nil }
    self.init(
      apiKey: token.apiKey, expiresAt: expiresAt, webSocketURL: url, model: token.model, voice: token.voice,
      sampleRate: token.sampleRate, language: language)
  }

  /// The stream language is the app language: Polish for a Polish app, English otherwise.
  static func language(_ copy: CopyLanguage) -> String { copy == .pl ? "pl" : "en" }
}

/// One voice conversation of a host: the conversation, its indicator for the status row and the button, its levels
/// and the end through the host's end rules. The session screen creates one per start with its host and shows what it
/// reports (`SessionViewController+VoiceAgent.swift`).
@MainActor
final class VoiceAgentSession {
  /// Seconds the "sent" state stands in the status row.
  static let sentSeconds: TimeInterval = 3

  /// What a send of the message field took: the conversation run and the number of prompts `show_prompt` wrote so
  /// far. Its result shows "Sent to the session" only while both still hold (``fieldSent(_:)``), so a late result
  /// covers neither a newer prompt nor the next conversation.
  struct SendMark: Sendable, Equatable {
    let run: Int
    let prompts: Int
  }

  /// What the conversation is about: content, tools and end rules.
  let host: any VoiceAgentHost
  private(set) var phase: RealtimeConversation.Phase = .idle
  /// What closed the conversation from outside (app state); `nil` = ended by the button, by itself, or running.
  private(set) var closedBy: VoiceAgentWatch.Reason?
  /// State of the status row and the button; `nil` = no row.
  private(set) var indicator: VoiceAgentIndicator?

  /// Every change of ``indicator``.
  var onIndicator: (@MainActor (VoiceAgentIndicator?) -> Void)?
  /// Levels for the button bars and the dot.
  var onLevels: (@MainActor (RealtimeLevels) -> Void)?

  private let backend: any VoiceAgentBackend
  private let scheduler: any VoiceScheduler
  /// The app's microphone that holds this conversation: it learns each phase change and the deinit
  /// (`DictationCenter.changed(_:)`).
  weak var microphoneCenter: DictationCenter?
  /// The subject the microphone's observers last heard from `observe()`.
  private var reportedSubject: MicrophoneSubject?
  private var conversation: RealtimeConversation!
  /// Login in which the conversation started; a send of the field checks it right before it goes out.
  private var startLogin: Int?
  /// Number of the conversation run of this session and of the prompts written in it (``SendMark``).
  private var run = 0
  private var prompts = 0

  private var hearing = false
  private var transient: (kind: VoiceAgentIndicator.Transient, number: Int)?
  /// Number of the last transient state: a timer of an older one does not clear a newer one.
  private var transientNumber = 0
  private var checkingSince: TimeInterval?
  private var checkingTimer: VoiceTimer?
  private var sentTimer: VoiceTimer?
  /// The end sentence was dismissed (tap on the row, field edit).
  private var noticeDismissed = false

  /// `dependencies`: socket, audio and clock around the key provider (app: `production`, tests: fakes); the same
  /// provider gives the Soniox speech key of `speech`, read at `speechSpeed`.
  init(
    host: any VoiceAgentHost, speechSpeed: Double = VoiceAgentSettings.defaultSpeechSpeed,
    backend: any VoiceAgentBackend, dependencies: (VoiceAgentKeys) -> RealtimeConversation.Dependencies
  ) {
    self.host = host
    self.backend = backend
    let built = dependencies(VoiceAgentKeys(backend: backend, speechSpeed: speechSpeed))
    scheduler = built.scheduler
    var content = host.content()
    content.tools = content.tools.map { [weak self] tool in
      RealtimeToolSpec(
        name: tool.name, schema: tool.schema, tally: tool.tally,
        action: { arguments in Self.guarded(tool.action(arguments), session: self) })
    }
    conversation = RealtimeConversation(
      dependencies: built,
      content: content,
      handlers: .init(
        phase: { [weak self] in self?.phaseChanged($0) },
        speech: { [weak self] in self?.speech($0) },
        levels: { [weak self] in self?.onLevels?($0) },
        diagnostic: { [weak self] in self?.backend.trace($0.traceLine, budget: $0.traceBudget) },
        answer: { [weak self] in self?.host.answer($0) },
        soundOverAnswer: { [weak self] in self?.host.soundOverAnswer(utterances: $0) }))
  }

  /// A conversation dropped without an end still tells the microphone center, so nothing stays held for it.
  isolated deinit {
    microphoneCenter?.changed(self)
  }

  var isActive: Bool {
    switch phase {
    case .idle, .ended: false
    default: true
    }
  }

  /// The conversation runs past its readiness gate: the audio engine runs and OpenAI took the session, so the
  /// microphone's audio goes out. While it connects (keys, socket, engine start) it is active but not ready. The gate
  /// opening moves the phase on from connecting, so every change of this value comes with a phase change.
  var isReady: Bool { isActive && conversation.audioRunning }

  /// The login of the start is still the app's login (no logout, unpairing or other server since).
  var loginUnchanged: Bool { startLogin != nil && backend.loginEpoch == startLogin }

  /// Start with the current app state: the host's end rules count from it, and a reason they give now keeps the
  /// conversation from starting.
  func start() {
    if let reason = host.startRefusal() {
      closedBy = reason
      refresh()
      return
    }
    closedBy = nil
    noticeDismissed = false
    startLogin = backend.loginEpoch
    run += 1
    prompts = 0
    conversation.start()
  }

  /// The app state changed: an end reason of the host ends the conversation.
  func observe() {
    guard isActive else { return }
    guard let reason = host.endReason() else {
      // The session's name can change under a status that stays: the microphone's observers learn the new one.
      let subject = host.microphoneSubject
      if subject != reportedSubject {
        reportedSubject = subject
        reportUse()
      }
      return
    }
    closedBy = reason
    conversation.end(.closed, detail: reason.traceName)
  }

  /// Second tap on the button, the screen goes away, dictation takes the microphone; `detail`: what closed it, for
  /// the end line in `client.log` (`live-activity` for an end button outside the app's screens).
  func end(detail: String? = nil) {
    conversation.end(.closed, detail: detail)
  }

  /// What of the conversation lives (the locked-phone monitor's heartbeat): a microphone frame within
  /// `MicrophoneUse.frameWindow` seconds, the Realtime socket to OpenAI, the Soniox speech socket.
  var liveParts: (audio: Bool, openAI: Bool, soniox: Bool) {
    (conversation.inputFresh(within: MicrophoneUse.frameWindow), conversation.socketOpen, conversation.speechOpen)
  }

  /// The microphone of the conversation is muted (the composer mic shows it lit).
  var muted: Bool { conversation.muted }

  /// The host's subject or waiting prompt changed (`VoiceAgentHost.microphoneSubject`, `promptWaits`): the app's
  /// microphone learns it, as it learns every change of the indicator.
  func reportUse() {
    microphoneCenter?.changed(self)
  }

  /// The composer mic (and ⌥⌘M) during a conversation: mutes or unmutes it. No conversation runs: nothing.
  func toggleMute() {
    guard isActive else { return }
    conversation.setMuted(!conversation.muted)
    let before = indicator
    refresh()
    // A mute over a state the status row keeps (a prompt in the field, an answer) changes the microphone's phase too.
    if indicator == before { reportUse() }
  }

  /// The mark of a send that takes the message field now; `nil` = no conversation runs.
  var sendMark: SendMark? { isActive ? SendMark(run: run, prompts: prompts) : nil }

  /// The send that took the field with `mark` was accepted: "Sent to the session" for ``sentSeconds``, and the prompt
  /// state ends. A mark of an earlier prompt or conversation changes nothing.
  func fieldSent(_ mark: SendMark?) {
    guard let mark, mark == sendMark else { return }
    let number = nextTransient(.sent)
    sentTimer?.cancel()
    sentTimer = scheduler.schedule(after: Self.sentSeconds) { [weak self] in
      guard let self, self.transient?.number == number else { return }
      self.transient = nil
      self.refresh()
    }
    refresh()
  }

  /// The prompt of the agent left the message field (a send took it, the user cleared or replaced it): `send_prompt`
  /// refuses until the next `show_prompt`.
  func promptLeftField() {
    conversation.promptLeftField()
  }

  /// The host stops the app's reading in progress (the person edits or sends the text by hand): it ends as speech
  /// over it ends it, with no result for the model. No reading: nothing.
  func stopReading() {
    conversation.stopReading()
  }

  /// A timer on the conversation's clock (the screen fades the prompt highlight with it; tests advance it).
  func after(_ seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> VoiceTimer {
    scheduler.schedule(after: seconds, work)
  }

  /// Tap on the status row or an edit of the field: the end sentence goes; a running conversation keeps its row.
  func dismissNotice() {
    guard !isActive, indicator != nil else { return }
    noticeDismissed = true
    refresh()
  }

  // MARK: - Conversation events

  private func phaseChanged(_ next: RealtimeConversation.Phase) {
    let previous = phase
    phase = next
    // The prompt state lasts while the conversation listens after it; the next phase other than listening ends it.
    if previous == .listening, next != .listening, transient?.kind == .promptInField { transient = nil }
    if case .ended = next {
      transient = nil
      hearing = false
    }
    if next == .checkingSession {
      if previous != .checkingSession { startChecking() }
    } else {
      stopChecking()
    }
    refresh(reports: false)
    // Readiness and the end both come with a phase change, so the center learns every change of the use here.
    microphoneCenter?.changed(self)
  }

  private func speech(_ started: Bool) {
    hearing = started
    if started, transient?.kind == .promptInField { transient = nil }
    refresh()
  }

  /// The core's part of the host's prompt tools: a shown prompt counts (``SendMark``, the indicator), and a send
  /// after the user confirmed goes only while the login of the start holds (another server or pairing would get the
  /// message). Other actions pass as they are.
  private static func guarded(_ action: RealtimeToolAction, session: VoiceAgentSession?) -> RealtimeToolAction {
    switch action {
    case let .showPrompt(place):
      return .showPrompt { [weak session] version in
        let outcome = place(version)
        if case .shown = outcome { session?.promptShown() }
        return outcome
      }
    case let .sendPrompt(refusals, send):
      return .sendPrompt(refusals: refusals) { [weak session] version in
        guard let session, session.loginUnchanged else { return refusals.unreachable }
        return await send(version)
      }
    case .answer, .work, .workAtTurn, .workAndRead:
      return action
    }
  }

  private func promptShown() {
    prompts += 1
    nextTransient(.promptInField)
    refresh()
  }

  @discardableResult
  private func nextTransient(_ kind: VoiceAgentIndicator.Transient) -> Int {
    transientNumber += 1
    transient = (kind, transientNumber)
    return transientNumber
  }

  private func startChecking() {
    checkingSince = scheduler.now
    scheduleChecking()
  }

  private func scheduleChecking() {
    checkingTimer?.cancel()
    checkingTimer = scheduler.schedule(after: 1) { [weak self] in
      guard let self, self.checkingSince != nil else { return }
      self.refresh()
      self.scheduleChecking()
    }
  }

  private func stopChecking() {
    checkingTimer?.cancel()
    checkingTimer = nil
    checkingSince = nil
  }

  /// `reports`: a changed indicator reaches the app's microphone, whose use carries its phase; a phase change
  /// reports once itself.
  private func refresh(reports: Bool = true) {
    let seconds = checkingSince.map { Int(max(0, scheduler.now - $0)) } ?? 0
    var next = VoiceAgentIndicator.make(
      phase: phase, hearing: hearing, muted: conversation.muted, transient: transient?.kind, closedBy: closedBy,
      checkingSeconds: seconds)
    if let shown = next, !shown.isActive, noticeDismissed { next = nil }
    guard next != indicator else { return }
    indicator = next
    onIndicator?(next)
    if reports { microphoneCenter?.changed(self) }
  }
}
