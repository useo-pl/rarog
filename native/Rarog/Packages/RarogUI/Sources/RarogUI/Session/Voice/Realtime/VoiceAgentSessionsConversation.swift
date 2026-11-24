import Foundation
import Observation
import RarogContract
import RarogCore

// The owner of the voice conversation across sessions. Owner: voice agent. It belongs to the root of the app, above
// navigation, so going from the list to a session and back does not end the conversation. It has no view of its own:
// a view reads `entry`, `isActive`, `indicator`, `prompt` and `levels` and calls `start()`, `end()` and
// `dismissNotice()`;
// the rules stand here, so the tests run on macOS.
//
// - Entry rule (`VoiceAgentSessionsEntry`): no button where the mode is not offered
//   (`AppState.companionSessionsOffered`), consent first where the voice agent's or the mode's own is missing
//   (`VoiceAgentSettings.sessionsAllowed`), otherwise a start. The conversation at a session does not depend on
//   the mode's consent.
// - One host per conversation: a start builds a new `VoiceAgentSessionsHost`, awaits its opening list (`prepare()`;
//   a refusal is the start's outcome with an existing end sentence), then builds the `VoiceAgentSession`. The host's
//   end check holds the session weakly; the session holds the host.
// - One microphone: right before the start the conversation takes the app's microphone (`DictationCenter`), as the
//   session screen's conversation does: a running conversation at a session ends, and so does dictation; a
//   conversation at a session or dictation that starts later ends this one (`VoiceAgentSession.handOff`).
// - Ends: the end action, the app in the background (`scene(_:)`; under the locked-phone trial not a conversation
//   past its readiness gate), a logout, another login, the mode not offered, the mode's consent withdrawn, the lost
//   server connection (`AppState.global` offline), an audio interruption, a Soniox failure, a read session's new
//   conversation. The owner's own reasons reach the host as `ownerReason`, so they end
//   through the core's end check with their reason and sentence. Every end reaches the host as `conversationEnded()`,
//   from the session's indicator, whatever ended it.
// - While a conversation runs or its opening list is read, each change of the store's state or of the consent checks
//   the end rules (`observe()`), so a withdrawn consent ends the conversation without any call from a view.

/// What the list button does now (``VoiceAgentSessionsConversation/entry``).
enum VoiceAgentSessionsEntry: Sendable, Equatable {
  /// No button: the mode across sessions is not offered.
  case hidden
  /// The button leads to consent first: the voice agent's, the mode's own, or both.
  case consent
  /// The button starts the conversation.
  case start

  static func make(state: AppState, consented: Bool, sonioxAllowed: Bool) -> VoiceAgentSessionsEntry {
    guard state.companionSessionsOffered(sonioxAllowed: sonioxAllowed) else { return .hidden }
    return consented ? .start : .consent
  }
}

/// The voice conversation across sessions of the app: one at a time, above navigation.
@MainActor
@Observable
final class VoiceAgentSessionsConversation {
  /// What ``start()`` did.
  enum StartOutcome: Sendable, Equatable {
    case started
    /// The mode is not offered (``VoiceAgentSessionsEntry/hidden``).
    case notOffered
    /// The mode's consent is missing or for an older text (``VoiceAgentSessionsEntry/consent``).
    case consentNeeded
    /// A conversation runs or its opening list is read; nothing new starts.
    case running
    /// The start was refused; the indicator carries its sentence (`UICopy.voiceAgentStatus`) and stands in
    /// ``indicator`` too.
    case refused(VoiceAgentIndicator)
    /// The end action came while the opening list was read.
    case cancelled
  }

  /// A conversation runs or its opening list is read: the lit circle stands and ``end()`` ends it.
  private(set) var isActive = false
  /// State of the conversation as the conversation at a session shows it in its status row: connecting while the
  /// opening list is read, then the conversation's indicator, and after the end its end sentence until
  /// ``dismissNotice()``. `nil` = nothing to show.
  private(set) var indicator: VoiceAgentIndicator?
  /// The session the running conversation discusses (`VoiceAgentSessionsHost+Discussion.swift`), as the host
  /// reports it; no view shows it. `nil` when none is pointed at, the pointing was cleared or the conversation ended.
  private(set) var discussed: VoiceAgentDiscussed?
  /// The prompt of `show_prompt` that waits for the user's word (`VoiceAgentSessionsHost+Prompt.swift`), for its
  /// card; `nil` when none waits, it was sent or dropped, or the conversation ended.
  private(set) var prompt: VoiceAgentShownPrompt?
  /// Input and output levels of the running conversation for the bars of the lit circle in the list header; zero
  /// without one. Only the bars' view reads them, so their 50 ms updates redraw the bars alone. The running session
  /// writes them; the UIKit tests set them to draw the bars without a conversation.
  var levels = RealtimeLevels.zero

  /// The host and the core of the running or the last conversation.
  @ObservationIgnored private(set) var host: VoiceAgentSessionsHost?
  @ObservationIgnored private(set) var session: VoiceAgentSession?

  @ObservationIgnored private let backend: any VoiceAgentSessionsBackend
  @ObservationIgnored private let settings: VoiceAgentSettings
  @ObservationIgnored private let sonioxAllowed: Bool
  @ObservationIgnored private let microphone: DictationCenter
  @ObservationIgnored private let now: @MainActor () -> Date
  @ObservationIgnored private let dependencies: @MainActor (VoiceAgentKeys) -> RealtimeConversation.Dependencies
  @ObservationIgnored private var background = false
  /// The opening list of the start number ``run`` is being read.
  @ObservationIgnored private var preparing = false
  /// Number of the last start: a start that the end action and a newer start overtook builds nothing.
  @ObservationIgnored private var run = 0
  @ObservationIgnored private var watching = false

  /// `backend`: the route to Rarog and the app state (the store); `settings`: the device's voice agent settings with
  /// the mode's consent and the reading speed; `sonioxAllowed`: the build's Soniox flag; `microphone`: the app's one
  /// microphone; `dependencies`: socket, audio and clock around the key provider (app: production, tests: fakes).
  init(
    backend: any VoiceAgentSessionsBackend, settings: VoiceAgentSettings, sonioxAllowed: Bool,
    microphone: DictationCenter = .shared, now: @escaping @MainActor () -> Date = Date.init,
    dependencies: @escaping @MainActor (VoiceAgentKeys) -> RealtimeConversation.Dependencies
  ) {
    self.backend = backend
    self.settings = settings
    self.sonioxAllowed = sonioxAllowed
    self.microphone = microphone
    self.now = now
    self.dependencies = dependencies
  }

  isolated deinit {
    // A new root (another server) drops the owner: the microphone and the host's data must not outlive it.
    host?.conversationEnded()
    session?.end()
  }

  /// What the list button does now.
  var entry: VoiceAgentSessionsEntry {
    VoiceAgentSessionsEntry.make(
      state: backend.state, consented: settings.sessionsAllowed, sonioxAllowed: sonioxAllowed)
  }

  /// The list button: a new host reads the opening list, then the conversation takes the microphone and starts.
  @discardableResult
  func start() async -> StartOutcome {
    switch entry {
    case .hidden: return .notOffered
    case .consent: return .consentNeeded
    case .start: break
    }
    guard !isActive else { return .running }
    if let reason = ownReason() {
      indicator = .closed(reason)
      return .refused(.closed(reason))
    }
    run += 1
    let number = run
    let host = VoiceAgentSessionsHost(backend: backend, sonioxAllowed: sonioxAllowed, now: now)
    host.ownerReason = { [weak self] in self?.ownReason() }
    // The host's discussed session and waiting prompt are also what the app's microphone reports the conversation
    // is about (`VoiceAgentHost.microphoneSubject`), so each change reaches it too.
    host.onDiscussed = { [weak self, weak host] value in
      guard let self, let host, host === self.host else { return }
      self.discussed = value
      self.session?.reportUse()
    }
    host.onPrompt = { [weak self, weak host] value in
      guard let self, let host, host === self.host else { return }
      self.prompt = value
      self.session?.reportUse()
    }
    self.host = host
    discussed = nil
    prompt = nil
    session = nil
    preparing = true
    isActive = true
    indicator = .connecting
    // The microphone goes to this start at once, so a recording that begins while the opening list is read is the
    // newer one and keeps it (`handOff()`).
    microphone.claim(self)
    watch()
    let refusal = await host.prepare()
    guard number == run, preparing else {
      host.conversationEnded()
      // Stopped while the list was read: by the end action, by a newer recording, or by an end reason.
      if number == run, case let .closed(reason)? = indicator { return .refused(.closed(reason)) }
      return .cancelled
    }
    preparing = false
    if let refusal {
      host.conversationEnded()
      let shown = Self.indicator(refusal)
      isActive = false
      indicator = shown
      return .refused(shown)
    }
    let session = VoiceAgentSession(
      host: host, speechSpeed: settings.speechSpeed, backend: backend, dependencies: dependencies)
    host.requestEndCheck = { [weak session] in session?.observe() }
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
    if let reason = session.closedBy { return .refused(.closed(reason)) }
    return .started
  }

  /// The lit circle's end action: ends the running conversation, or the start whose opening list is read.
  func end() {
    guard preparing else {
      session?.end()
      return
    }
    preparing = false
    isActive = false
    indicator = nil
    host?.conversationEnded()
  }

  /// The app state or the consent changed: an end rule ends the running conversation with its reason. The owner
  /// calls it itself while a conversation runs; calling it more often changes nothing.
  func observe() {
    if preparing, let reason = host?.endReason() {
      // The reason may be gone when the list arrives; the start it met stays stopped.
      end()
      indicator = .closed(reason)
      return
    }
    guard let session, session.isActive else { return }
    session.observe()
  }

  /// The scene phase of the app: in the background no start begins, and the running conversation ends unless the
  /// locked-phone trial keeps it (``ownReason()``).
  func scene(_ phase: ScenePhase) {
    background = phase == .background
    observe()
  }

  /// A tap on the end sentence: it goes; a running conversation keeps its state.
  func dismissNotice() {
    guard !isActive, indicator != nil else { return }
    if let session, session.indicator != nil {
      session.dismissNotice()
    } else {
      indicator = nil
    }
  }

  // MARK: - Ends

  /// Every indicator of the conversation: the lit circle's state, and at the end the host learns it.
  private func shown(_ next: VoiceAgentIndicator?, by session: VoiceAgentSession) {
    guard session === self.session else { return }
    indicator = next
    guard isActive, !session.isActive else { return }
    isActive = false
    host?.conversationEnded()
    discussed = nil
    prompt = nil
    levels = .zero
  }

  /// The owner's end reasons for the host (``VoiceAgentSessionsHost/ownerReason``). The background ends a start, the
  /// opening list and a conversation still connecting; under the locked-phone trial it keeps a ready one.
  private func ownReason() -> VoiceAgentWatch.Reason? {
    if background, !settings.lockedPhoneTrial.keeps(running: session?.isReady == true) { return .background }
    if !settings.sessionsAllowed { return .disabled }
    if case .offline = backend.state.global { return .connectionLost }
    return nil
  }

  /// While a conversation runs or its opening list is read, the next change of the store's state or of the consent
  /// checks the end rules. The change comes before the new value is in place, so the check runs on the next turn of
  /// the main actor.
  private func watch() {
    guard !watching else { return }
    watching = true
    let owner = WeakOwner(self)
    withObservationTracking {
      _ = backend.state
      _ = settings.sessionsAllowed
    } onChange: {
      Task { @MainActor in
        guard let self = owner.value as? VoiceAgentSessionsConversation else { return }
        self.watching = false
        guard self.isActive else { return }
        self.observe()
        self.watch()
      }
    }
  }

  /// A refused opening list as an existing end sentence.
  private static func indicator(_ refusal: VoiceAgentSessionsHost.PrepareRefusal) -> VoiceAgentIndicator {
    switch refusal {
    case .loggedOut: .closed(.loggedOut)
    case .off: .closed(.disabled)
    case .unavailable: .ended(.unavailable)
    }
  }
}

extension VoiceAgentSessionsConversation: DictationHost {
  /// A recording or a conversation at a session takes the microphone while the opening list is read: the start is
  /// given up. A running conversation is its session's to end (`VoiceAgentSession.handOff()`).
  func handOff() {
    guard preparing else { return }
    end()
  }
}

#if os(iOS)
extension VoiceAgentSessionsConversation {
  /// The app's owner, made once at the root of the app: the store as the route to Rarog, the device's voice agent
  /// settings, the build's Soniox flag, the app's one microphone and the device's audio.
  static func live(store: RarogStore) -> VoiceAgentSessionsConversation {
    VoiceAgentSessionsConversation(
      backend: store, settings: store.voiceAgent, sonioxAllowed: store.dictation.sonioxAllowed,
      dependencies: { keys in
        .production(
          keys: keys, audio: VoiceChatAudio(), scheduler: TaskVoiceScheduler(),
          speech: RealtimeConversation.Speech(keys: keys))
      })
  }
}
#endif
