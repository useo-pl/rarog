import Foundation
import Observation
import RarogContract
import RarogCore

// The owner of the voice conversation of the Inbox cards: one card at a time. Owner: voice agent. The Inbox screen
// keeps it and draws the button and the state on each card (`Views/Inbox/InboxVoice.swift`); the rules stand here,
// so the tests run on macOS.
//
// - Button (`offered`): a card with `InboxCardModel.voice` (a result or a decision of a session with a transcript,
//   `InboxRules.takesVoice`) where the app offers the voice agent and its switch is on (the session screen's rule,
//   `VoiceAgentAvailability`); the mode across sessions is not needed. While one card's conversation runs, the other
//   buttons are dimmed (`dims`), and a tap on one of them moves the conversation there.
// - Start: the navigation's voice target (`onTarget`, `RarogNavigation.inboxVoiceTarget`) opens the session's
//   transcript stream, which asks a fresh `transcript-snapshot` (`refreshTranscript`): a transcript kept from an
//   earlier visit can be many turns old. The conversation is built only after a snapshot newer than the start
//   (connecting until then); no snapshot within ``snapshotLimit``, or a card that changed its turn or left in the
//   meantime, refuses the start.
// - Prompt: the card's prompt pair keeps the agent's prompt in its own block (`InboxPromptBlock`, the rules in
//   `VoiceAgentInboxConversation+Prompt.swift`): the app reads it aloud exactly as written, the person edits it in
//   place, and its Send button or the model's `send_prompt` sends it as the card's plain reply (`replyFromInbox`),
//   held to the turn of the show. The view reads ``block``, ``readProgress``, ``levels``, ``muted`` and the
//   indicator and calls the actions; it counts nothing. Every end of the conversation hands back the block's text:
//   on top of the card's reply field while it is on screen, otherwise into the session's draft, never both.
// - Ends: the session screen's rules of the card's session (logout, another login, the feature off, background
//   unless the locked-phone trial keeps a ready conversation, `/clear` and `/resume`), the card gone, the Inbox left
//   or another session opened (`VoiceAgentInboxWatch`), the second tap or ``end()`` (before "Open session" writes
//   the fields' drafts), a start on another card, dictation taking the microphone. Each change of the store's state, of the place or of the voice agent's switch in Settings
//   checks them (`watch()`), so the switch turned off ends the conversation without any call from a view.

/// The voice conversation of the Inbox cards.
@MainActor
@Observable
final class VoiceAgentInboxConversation {
  /// Seconds the start waits for the session's fresh transcript snapshot.
  static let snapshotLimit: TimeInterval = 10

  /// The card (session id) whose conversation runs or connects.
  private(set) var target: String?
  /// A conversation runs or connects.
  private(set) var isActive = false
  /// State of the conversation for its card: connecting, then the core's indicator, and after the end its sentence
  /// until ``dismissNotice()`` or the next start.
  private(set) var indicator: VoiceAgentIndicator?
  /// The card the indicator belongs to (also after the end).
  private(set) var indicatorCard: String?
  /// The agent's prompt in its block on the target card; `nil` = none. The actions of
  /// `VoiceAgentInboxConversation+Prompt.swift` change it. Whether it waits for the person's word is part of what
  /// the app's microphone reports (`VoiceAgentInboxHost.promptWaits`), so a change of that reaches it.
  var block: InboxPromptBlock? {
    didSet { if Self.waits(oldValue) != Self.waits(block) { session?.reportUse() } }
  }
  /// The heard prefix of the block's reading while it plays and at its end, for the highlight; `nil` = no reading.
  var readProgress: ReadingProgress?
  /// Input and output levels of the running conversation, for the bars.
  private(set) var levels = RealtimeLevels.zero
  /// The conversation's microphone is muted.
  private(set) var muted = false
  /// A mute chosen while the conversation connected, applied once it runs.
  @ObservationIgnored private var mutePending = false

  /// Where the person is now (the screen sets it from the navigation and the scene).
  @ObservationIgnored var place: @MainActor () -> VoiceAgentInboxPlace = {
    VoiceAgentInboxPlace(inboxOnScreen: false, openedSession: nil, background: false)
  }
  /// The navigation's voice target: the session whose transcript stream stands for the conversation.
  @ObservationIgnored var onTarget: @MainActor (String?) -> Void = { _ in }
  /// The reply fields of the screen.
  @ObservationIgnored weak var field: (any VoiceAgentInboxField)?
  /// The session drafts of the space: where the block's text goes when the card's field is not on screen.
  @ObservationIgnored let drafts: ComposerDrafts

  @ObservationIgnored private(set) var session: VoiceAgentSession?
  @ObservationIgnored let backend: any VoiceAgentInboxBackend
  @ObservationIgnored private var host: VoiceAgentInboxHost?
  @ObservationIgnored private let settings: VoiceAgentSettings
  @ObservationIgnored private let sonioxAllowed: Bool
  @ObservationIgnored private let microphone: DictationCenter
  @ObservationIgnored private let scheduler: any VoiceScheduler
  @ObservationIgnored private let dependencies: @MainActor (VoiceAgentKeys) -> RealtimeConversation.Dependencies
  /// The start waits for a snapshot: the turn the card showed and the snapshots counted before the request.
  @ObservationIgnored private var connecting: (turnId: String, snapshots: Int, timer: VoiceTimer)?
  @ObservationIgnored private var watching = false

  /// `backend`: the store; `settings`: the device's voice agent settings; `sonioxAllowed`: the build's Soniox flag;
  /// `drafts`: the session drafts of the space; `microphone`: the app's one microphone; `scheduler`: the clock of the
  /// snapshot limit; `dependencies`: socket, audio and clock around the key provider (app: production, tests: fakes).
  init(
    backend: any VoiceAgentInboxBackend, settings: VoiceAgentSettings, sonioxAllowed: Bool, drafts: ComposerDrafts,
    microphone: DictationCenter = .shared, scheduler: any VoiceScheduler,
    dependencies: @escaping @MainActor (VoiceAgentKeys) -> RealtimeConversation.Dependencies
  ) {
    self.backend = backend
    self.drafts = drafts
    self.settings = settings
    self.sonioxAllowed = sonioxAllowed
    self.microphone = microphone
    self.scheduler = scheduler
    self.dependencies = dependencies
  }

  isolated deinit {
    // The screen went away with its fields: the block's text goes to the session's draft, and the microphone must
    // not outlive the screen.
    if let target, let text = InboxPromptBlock.end(&block) { drafts.save(text, note: nil, for: target) }
    session?.end()
    connecting?.timer.cancel()
  }

  // MARK: - Button

  /// The voice agent button stands on `card`.
  func offered(_ card: InboxCardModel) -> Bool {
    card.voice && settings.enabled
      && VoiceAgentAvailability.offered(state: backend.state, sonioxAllowed: sonioxAllowed)
  }

  /// Another card's conversation runs or connects: this card's button is dimmed.
  func dims(_ cardId: String) -> Bool {
    isActive && target != cardId
  }

  /// The card's button: ends its own conversation, otherwise starts one there (ending another card's).
  func toggle(_ card: InboxCardModel) {
    if isActive, target == card.id {
      end()
      return
    }
    start(card)
  }

  /// Ends the running or connecting conversation without a sentence. The block's text is handed back before the
  /// conversation ends, so "Open session", which writes the fields' drafts right after, carries it.
  func end() {
    if connecting != nil {
      stopConnecting(nil)
      return
    }
    releaseBlock()
    session?.end()
  }

  /// The microphone of the card's row during its conversation: mutes or unmutes it. No conversation runs: nothing.
  func toggleMute() {
    guard isActive else { return }
    guard let session, session.isActive else {
      // Still connecting: the button shows the choice now and the conversation takes it once it runs.
      muted.toggle()
      mutePending = muted
      return
    }
    session.toggleMute()
    muted = session.muted
  }

  /// A tap on the end sentence: it goes.
  func dismissNotice() {
    guard !isActive else { return }
    indicator = nil
    indicatorCard = nil
  }

  /// The app state or the place changed: a connecting start checks its snapshot and its card, a running conversation
  /// its end rules.
  func observe() {
    guard let target else { return }
    if let connecting {
      // The end rules from this moment; a card gone while the snapshot is awaited is a changed card.
      if let reason = host(for: target).startRefusal() {
        stopConnecting(.closed(reason == .cardGone ? .cardChanged : reason))
        return
      }
      guard backend.state.inboxVoiceTarget(target)?.turnId == connecting.turnId else {
        stopConnecting(.closed(.cardChanged))
        return
      }
      if (backend.state.transcripts[target]?.snapshots ?? 0) > connecting.snapshots { begin(target) }
      return
    }
    guard let session, session.isActive else { return }
    session.observe()
  }

  /// The Inbox stands where the person sees the card's field now: on screen and the app in front.
  var fieldInSight: Bool {
    let place = place()
    return place.inboxOnScreen && !place.background
  }

  /// A line of `client.log` under the voice agent's budget.
  func trace(_ line: String) { backend.trace(line, budget: .voiceAgent) }

  // MARK: - Start

  private func start(_ card: InboxCardModel) {
    guard offered(card) else { return }
    end()
    let sessionId = card.id
    target = sessionId
    isActive = true
    indicator = .connecting
    indicatorCard = sessionId
    muted = false
    mutePending = false
    block = nil
    readProgress = nil
    host = nil
    session = nil
    let snapshots = backend.state.transcripts[sessionId]?.snapshots ?? 0
    let timer = scheduler.schedule(after: Self.snapshotLimit) { [weak self] in
      guard let self, self.connecting != nil, self.target == sessionId else { return }
      self.stopConnecting(.ended(.unavailable))
    }
    connecting = (card.turnId, snapshots, timer)
    // The microphone goes to this start at once: a recording that begins while the snapshot is awaited keeps it.
    microphone.claim(self)
    backend.refreshTranscript(sessionId)
    onTarget(sessionId)
    watch()
    observe()
  }

  /// The fresh snapshot came: the conversation is built and starts.
  private func begin(_ sessionId: String) {
    connecting?.timer.cancel()
    connecting = nil
    let host = host(for: sessionId)
    let session = VoiceAgentSession(
      host: host, speechSpeed: settings.speechSpeed, backend: backend, dependencies: dependencies)
    session.onIndicator = { [weak self, weak session] next in
      guard let self, let session else { return }
      self.shown(next, by: session)
    }
    session.onLevels = { [weak self, weak session] next in
      guard let self, let session, session === self.session else { return }
      self.levels = next
    }
    self.session = session
    microphone.claim(session)
    session.start()
  }

  /// A refusal before the conversation exists, or the end action while connecting: the target goes.
  private func stopConnecting(_ shown: VoiceAgentIndicator?) {
    connecting?.timer.cancel()
    connecting = nil
    finish(shown)
  }

  private func shown(_ next: VoiceAgentIndicator?, by session: VoiceAgentSession) {
    guard session === self.session else { return }
    if next?.isActive == true || isActive { indicator = next }
    if mutePending, session.isActive {
      mutePending = false
      if !session.muted { session.toggleMute() }
    }
    muted = session.isActive ? session.muted : mutePending
    guard isActive, !session.isActive else { return }
    finish(next)
  }

  private func finish(_ shown: VoiceAgentIndicator?) {
    releaseBlock()
    indicator = shown
    isActive = false
    levels = .zero
    muted = false
    mutePending = false
    target = nil
    onTarget(nil)
  }

  /// The host of the card's conversation, built once per start.
  private func host(for sessionId: String) -> VoiceAgentInboxHost {
    if let host, host.sessionId == sessionId { return host }
    let host = VoiceAgentInboxHost(
      sessionId: sessionId, backend: backend,
      showPrompt: { [weak self] text, turn in
        self?.showPrompt(text, at: turn, sessionId: sessionId)
          ?? .output(RealtimeConversation.toolError(RealtimeInstructions.inboxPromptRefused("the Inbox is gone")))
      },
      sendPrompt: { [weak self] turn in
        await self?.sendPrompt(at: turn, sessionId: sessionId) ?? VoiceAgentToolText.unreachable
      })
    host.watchInput = { [weak self] in self?.watchInput(sessionId) }
    host.blockWaits = { [weak self] in Self.waits(self?.block) }
    self.host = host
    return host
  }

  /// The block holds the agent's prompt for a spoken yes or no: read aloud or ready, not edited by hand or sending.
  private static func waits(_ block: InboxPromptBlock?) -> Bool {
    block?.phase == .reading || block?.phase == .ready
  }

  /// While a conversation runs or connects, the next change of the store's state, of the place (the navigation it
  /// reads) or of the voice agent's switch in Settings checks it, so the switch turned off ends it without any other
  /// change. The change comes before the new value is in place, so the check runs on the next turn of the main actor.
  private func watch() {
    guard !watching else { return }
    watching = true
    let owner = WeakOwner(self)
    withObservationTracking {
      _ = backend.state
      _ = place()
      _ = settings.enabled
    } onChange: {
      Task { @MainActor in
        guard let self = owner.value as? VoiceAgentInboxConversation else { return }
        self.watching = false
        guard self.isActive else { return }
        self.observe()
        self.watch()
      }
    }
  }

  private func watchInput(_ sessionId: String) -> VoiceAgentInboxWatch.Input {
    let place = place()
    let state = backend.state
    return VoiceAgentInboxWatch.Input(
      app: VoiceAgentWatch.Input(
        state: state, sessionId: sessionId, login: backend.loginEpoch, enabled: settings.enabled,
        sonioxAllowed: sonioxAllowed, selected: sessionId, background: place.background,
        keepsInBackground: settings.lockedPhoneTrial.keeps(running: session?.isReady == true)),
      place: place, cardStands: state.inboxVoiceTarget(sessionId) != nil)
  }
}

extension VoiceAgentInboxConversation: DictationHost {
  /// A recording takes the microphone while the snapshot is awaited: the start is given up. A running conversation is
  /// its session's to end.
  func handOff() {
    guard connecting != nil else { return }
    stopConnecting(nil)
  }
}

#if os(iOS)
extension VoiceAgentInboxConversation {
  /// The Inbox screen's owner: the store as the route to Rarog, the device's voice agent settings, the build's Soniox
  /// flag, the space's session drafts, the app's one microphone and the device's audio.
  static func live(store: RarogStore, drafts: ComposerDrafts) -> VoiceAgentInboxConversation {
    VoiceAgentInboxConversation(
      backend: store, settings: store.voiceAgent, sonioxAllowed: store.dictation.sonioxAllowed, drafts: drafts,
      scheduler: TaskVoiceScheduler(),
      dependencies: { keys in
        .production(
          keys: keys, audio: VoiceChatAudio(), scheduler: TaskVoiceScheduler(),
          speech: RealtimeConversation.Speech(keys: keys))
      })
  }
}
#endif
