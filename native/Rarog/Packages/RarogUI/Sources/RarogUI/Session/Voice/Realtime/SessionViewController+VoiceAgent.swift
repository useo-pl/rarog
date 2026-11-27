#if os(iOS)
import RarogCore
import UIKit

// The voice conversation in the session screen: no window of its own. The voice agent button in the control
// row of the message field starts and ends it; while it runs the button is filled with the state color and its bars
// move with the voice of whoever speaks, and the status row of the field (`VoiceStatusView`, shared with dictation)
// says what happens. While it runs the composer mic (and ⌥⌘M) mutes and unmutes it instead of dictating
// (`toggleVoiceAgentMute`). The transcript above stays visible and scrolls. `show_prompt` writes into the message field
// (`VoiceAgentDraft`: under the user's text, the cursor at its end, a highlight that fades) and `send_prompt` sends
// the field with the same operation as ↑ (`sendField`, `+Send`). The screen is the conversation's host through
// `VoiceAgentSessionHost` (its field closures and app state, `connectVoiceAgent`). Rules without a view:
// `VoiceAgentSession`, `VoiceAgentSessionHost`, `VoiceAgentDraft.swift`, `VoiceAgentIndicator.swift`,
// `VoiceAgentRules.swift`. The controller core calls these
// functions from `+Voice`. Soniox speaks every answer; the button stands only where `VoiceAgentAvailability`
// offers the voice agent. A Debug build with `RAROG_UI_TEST_VOICE_AGENT` plays a scripted conversation
// (`ScriptedVoiceAgent`). Owner: voice agent.

/// The conversation of one session screen and what the button shows. Owner: this file.
@MainActor
final class VoiceAgentChrome {
  var session: VoiceAgentSession?
  /// Bars on the filled button; hidden outside a conversation.
  let bars = VoiceAgentBarsView()
  /// Shown levels of the conversation (they fall in silence by themselves, `RealtimeLevels.next`).
  var levels = RealtimeLevels.zero
  /// The level of the moving side on the bars and the dot (`VoiceAgentBars.level`).
  var level = 0.0
  /// The last state the screen reader heard: a change of sentence is spoken, not every tick.
  var spoken: VoiceAgentIndicator?
  var observers: [any NSObjectProtocol] = []
  /// The prompt of the agent in the message field while the conversation runs.
  var draft = VoiceAgentDraft()
  /// A prompt that waits for the end of composing a character (IME): text and version.
  var pendingPrompt: (text: String, version: Int)?
  /// The screen is writing the prompt of `show_prompt` into the field: the draft placed it already
  /// (`VoiceAgentDraft.place`), so the write is no edit of the field.
  var writingPrompt = false
  /// Seconds the highlight of a written prompt stands, and its timer (on the conversation's clock).
  static let highlightSeconds: TimeInterval = 3
  var highlightTimer: VoiceTimer?
  /// "Talk with the voice agent (⌥⌘V)" when the pointer rests on the button.
  var tip: ShortcutTipTracker?

  isolated deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    // The screen went away without `leave`: the microphone must not outlive it.
    session?.end()
  }
}

/// What a send of the message field took from a running conversation (`SessionViewController.voiceAgentSendMark`).
struct VoiceAgentSendMark {
  weak var session: VoiceAgentSession?
  let mark: VoiceAgentSession.SendMark
}

extension SessionViewController {
  /// Look and action of the button; once, from `buildVoice`.
  func buildVoiceAgent() {
    let button = composer.voiceAgentButton
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "waveform")
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 14, weight: .medium)
    config.cornerStyle = .capsule
    config.contentInsets = .zero
    button.configuration = config
    button.restyle()
    button.translatesAutoresizingMaskIntoConstraints = false
    // Szerokość 999, nie 1000: schowany przycisk dostaje od stosu szerokość 0 z priorytetem 1000 (jak mikrofon).
    let width = button.widthAnchor.constraint(equalToConstant: 32)
    width.priority = .required - 1
    NSLayoutConstraint.activate([width, button.heightAnchor.constraint(equalToConstant: 32)])
    let bars = voiceAgentChrome.bars
    bars.isHidden = true
    button.addSubview(bars)
    NSLayoutConstraint.activate([
      bars.centerXAnchor.constraint(equalTo: button.centerXAnchor),
      bars.centerYAnchor.constraint(equalTo: button.centerYAnchor),
    ])
    button.accessibilityIdentifier = "composer.voiceAgent"
    button.accessibilityLabel = UICopy.voiceAgentButton
    button.largeContentTitle = UICopy.voiceAgentButton
    button.showsLargeContentViewer = true
    button.isHidden = true
    button.addAction(UIAction { [weak self] _ in self?.toggleVoiceAgent() }, for: .primaryActionTriggered)
    voiceAgentChrome.tip = ShortcutTipTracker(view: button, line: ShortcutTipLine(UICopy.voiceAgentButton, .voiceAgent))
    dictation.status.onAgentNoticeDismissed = { [weak self] in self?.voiceAgentChrome.session?.dismissNotice() }
    dictation.onConversationMic = { [weak self] in self?.toggleVoiceAgentMute() }
    // The prompt of the agent follows every change of the field by the range the field reported for it (read before
    // other handlers can change the field): typing, paste and the edits of the field's own code, and text from code
    // as the whole field.
    let edit = composer.onEdit
    composer.onEdit = { [weak self] in
      let change = self?.composer.lastEdit.map { VoiceAgentDraft.Change(range: $0.range, replacement: $0.replacement) }
      edit?()
      self?.voiceAgentFieldChanged(change)
    }
    let replace = composer.onReplace
    composer.onReplace = { [weak self] in
      let change = self?.composer.lastEdit.map { VoiceAgentDraft.Change(range: $0.range, replacement: $0.replacement) }
      replace?()
      guard self?.voiceAgentChrome.writingPrompt == false else { return }
      self?.voiceAgentFieldChanged(change)
    }
    composer.onSelectionChange = { [weak self] in self?.writePendingVoiceAgentPrompt() }
    voiceAgentChrome.observers.append(
      NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.observeVoiceAgent() }
      })
  }

  /// First tap starts a conversation, the second one ends it.
  func toggleVoiceAgent() {
    if let session = voiceAgentChrome.session, session.isActive {
      session.end()
      return
    }
    guard voiceAgentEntry(store.state) == .enabled else { return }
    let host = VoiceAgentSessionHost(sessionId: sessionId, backend: store)
    let session = VoiceAgentSession(
      host: host, speechSpeed: store.voiceAgent.speechSpeed, backend: store,
      dependencies: { keys in
        #if DEBUG
        if ScriptedVoiceAgent.isOn { return ScriptedVoiceAgent.dependencies() }
        #endif
        return .production(
          keys: keys, audio: VoiceChatAudio(), scheduler: TaskVoiceScheduler(),
          speech: RealtimeConversation.Speech(keys: keys))
      })
    connectVoiceAgent(session, host: host)
    // One microphone: dictation that starts during the conversation ends it, and the other way round.
    DictationCenter.shared.claim(session)
    session.start()
  }

  /// The composer mic (and ⌥⌘M) during a conversation: mute or unmute it, and show it on the mic.
  func toggleVoiceAgentMute() {
    voiceAgentChrome.session?.toggleMute()
    renderVoiceAgentMic()
  }

  /// The composer mic follows the conversation: a mute toggle while one runs, dictation otherwise.
  private func renderVoiceAgentMic() {
    guard let session = voiceAgentChrome.session, session.isActive else {
      dictation.renderConversation(muted: nil)
      return
    }
    dictation.renderConversation(muted: session.muted)
  }

  /// Wires a conversation and its session host to this screen; the tests give one with fakes.
  func connectVoiceAgent(_ session: VoiceAgentSession, host: VoiceAgentSessionHost) {
    voiceAgentChrome.session?.end()
    voiceAgentChrome.session = session
    voiceAgentChrome.spoken = nil
    forgetVoiceAgentPrompt()
    session.onIndicator = { [weak self] indicator in self?.showVoiceAgent(indicator) }
    session.onLevels = { [weak self] levels in self?.voiceAgentLevels(levels) }
    host.placePrompt = { [weak self] text, version in
      self?.placeVoiceAgentPrompt(text, version: version)
        ?? RealtimePromptShown(placement: .refused(reason: "the message field is gone"))
    }
    host.sendField = { [weak self] version in await self?.sendVoiceAgentField(version) }
    host.watchInput = { [weak self] in self?.voiceAgentWatchInput() }
  }

  /// After `renderVoice` and at every change of dictation: the button, and the app state for the conversation.
  func renderVoiceAgent(_ state: AppState) {
    observeVoiceAgent()
    styleVoiceAgentButton(voiceAgentChrome.session?.indicator, entry: voiceAgentEntry(state))
    renderVoiceAgentMic()
  }

  /// The screen went away (another session, logout, the list): the conversation ends.
  func leaveVoiceAgent() {
    voiceAgentChrome.session?.end()
  }

  /// A send takes the message field now: the conversation and the prompt count it belongs to.
  func voiceAgentSendMark() -> VoiceAgentSendMark? {
    guard let session = voiceAgentChrome.session, let mark = session.sendMark else { return nil }
    return VoiceAgentSendMark(session: session, mark: mark)
  }

  /// A send takes the field: the prompt of the agent goes with it, and text that comes back is the user's.
  func voiceAgentTakePrompt() {
    voiceAgentChrome.pendingPrompt = nil
    voiceAgentChrome.draft.take()
    voiceAgentChrome.session?.promptLeftField()
  }

  /// The send that took the field with `taken` was accepted: "Sent to the session" in the status row, only in the
  /// same conversation and before a newer prompt (`VoiceAgentSession.fieldSent`).
  func voiceAgentFieldSent(_ taken: VoiceAgentSendMark?) {
    guard let taken, let session = taken.session, session === voiceAgentChrome.session else { return }
    session.fieldSent(taken.mark)
  }

  /// What of the app state counts for the conversation. Without navigation (tests) the screen counts as selected.
  func voiceAgentWatchInput() -> VoiceAgentWatch.Input {
    var input = VoiceAgentWatch.Input(
      state: store.state, sessionId: sessionId, login: store.loginEpoch, enabled: store.voiceAgent.enabled,
      sonioxAllowed: store.dictation.sonioxAllowed,
      selected: navigation == nil ? sessionId : navigation?.selectedSessionId,
      background: TranscriptAppPhase.isBackground(),
      keepsInBackground: store.voiceAgent.background.keeps(running: voiceAgentChrome.session?.isReady == true),
      fieldShown: !composer.isHidden)
    #if DEBUG
    if ScriptedVoiceAgent.isOn { input.enabled = true }
    #endif
    return input
  }

  private func observeVoiceAgent() {
    guard let session = voiceAgentChrome.session, session.isActive else { return }
    session.observe()
  }

  func voiceAgentEntry(_ state: AppState) -> VoiceAgentEntry {
    #if DEBUG
    if let entry = ScriptedVoiceAgent.entry(state: state, sessionId: sessionId, dictating: dictation.isActive) {
      return entry
    }
    #endif
    return VoiceAgentEntry.make(
      state: state, sessionId: sessionId, enabled: store.voiceAgent.enabled,
      sonioxAllowed: store.dictation.sonioxAllowed, dictating: dictation.isActive)
  }

  private func showVoiceAgent(_ indicator: VoiceAgentIndicator?) {
    dictation.status.renderAgent(indicator)
    styleVoiceAgentButton(indicator, entry: voiceAgentEntry(store.state))
    renderVoiceAgentMic()
    if indicator?.isActive != true {
      voiceAgentChrome.levels = .zero
      // The conversation ended: its prompt in the field is the user's text now.
      forgetVoiceAgentPrompt()
    }
    voiceAgentChrome.level = VoiceAgentBars.level(voiceAgentChrome.levels, motion: indicator?.motion ?? .none)
    voiceAgentChrome.bars.show(
      VoiceAgentBars.heights(
        level: voiceAgentChrome.level, motion: indicator?.motion ?? .none,
        reduceMotion: UIAccessibility.isReduceMotionEnabled))
    // The screen reader hears a change of sentence, not every tick of the seconds counter.
    if let indicator, !indicator.sameSentence(as: voiceAgentChrome.spoken), canAnnounce(in: announcementScope) {
      announcer.say(UICopy.voiceAgentStatus(indicator))
    }
    voiceAgentChrome.spoken = indicator
  }

  /// Filled with the state color and bars during a conversation; the ring with the waveform icon otherwise.
  private func styleVoiceAgentButton(_ indicator: VoiceAgentIndicator?, entry: VoiceAgentEntry) {
    let button = composer.voiceAgentButton
    let active = indicator?.isActive == true
    button.isHidden = !active && entry == .hidden
    button.isEnabled = active || entry == .enabled
    voiceAgentChrome.bars.isHidden = !active
    if var config = button.configuration {
      let image = active ? nil : UIImage(systemName: "waveform")
      if config.image != image {
        config.image = image
        button.configuration = config
      }
    }
    button.fill = active ? indicator.map { VoiceStatusView.color($0.tone) } : nil
    voiceAgentChrome.bars.tint(Palette.background)
    var traits: UIAccessibilityTraits = .button
    if active { traits.insert(.selected) }
    if !button.isEnabled { traits.insert(.notEnabled) }
    button.accessibilityTraits = traits
    button.accessibilityLabel = active ? UICopy.voiceAgentEndButton : UICopy.voiceAgentButton
    voiceAgentChrome.tip?.update(ShortcutTipLine(button.accessibilityLabel ?? UICopy.voiceAgentButton, .voiceAgent))
    button.largeContentTitle = button.accessibilityLabel
    button.accessibilityHint = !active && entry == .disabled ? UICopy.voiceAgentDictating : nil
  }

  private func voiceAgentLevels(_ levels: RealtimeLevels) {
    guard let indicator = voiceAgentChrome.session?.indicator, indicator.isActive else { return }
    voiceAgentChrome.levels = levels
    voiceAgentChrome.level = VoiceAgentBars.level(levels, motion: indicator.motion)
    let reduce = UIAccessibility.isReduceMotionEnabled
    voiceAgentChrome.bars.show(
      VoiceAgentBars.heights(level: voiceAgentChrome.level, motion: indicator.motion, reduceMotion: reduce))
    dictation.status.agentLevel(voiceAgentChrome.level)
  }

  /// `show_prompt`: the prompt with `version` in the field (`VoiceAgentDraft`). A hidden or read-only field refuses
  /// with a fixed name of its reason (`VoiceAgentToolText.closedField`). While a character is being composed (IME) the prompt waits for the end of it, and the model
  /// hears where it goes in the field as it stands.
  private func placeVoiceAgentPrompt(_ prompt: String, version: Int) -> RealtimePromptShown {
    guard !composer.isHidden else {
      return RealtimePromptShown(placement: .refused(reason: "the message field is hidden"))
    }
    guard composer.isEditable else {
      let reason = VoiceAgentToolText.closedField(state: store.state, sessionId: sessionId)
      return RealtimePromptShown(placement: .refused(reason: reason))
    }
    let attachments = !composer.attachments.isEmpty || composer.isLoadingAttachments
    guard composer.textView.markedTextRange == nil else {
      var preview = voiceAgentChrome.draft
      let insertion = preview.place(prompt, version: version, in: composer.text)
      voiceAgentChrome.pendingPrompt = (prompt, version)
      return RealtimePromptShown(placement: insertion.placement, attachments: attachments)
    }
    let insertion = writeVoiceAgentPrompt(prompt, version: version)
    return RealtimePromptShown(placement: insertion.placement, attachments: attachments)
  }

  /// The prompt into the field: the cursor at its end, a highlight that fades, the draft of the session saved.
  @discardableResult
  private func writeVoiceAgentPrompt(_ prompt: String, version: Int) -> VoiceAgentDraft.Insertion {
    voiceAgentChrome.pendingPrompt = nil
    let insertion = voiceAgentChrome.draft.place(prompt, version: version, in: composer.text)
    voiceAgentChrome.writingPrompt = true
    composer.text = insertion.text
    voiceAgentChrome.writingPrompt = false
    let end = NSRange(location: NSMaxRange(insertion.range), length: 0)
    composer.textView.selectedRange = end
    composer.textView.scrollRangeToVisible(end)
    highlightVoiceAgentPrompt(insertion.range)
    // Writing from code does not save the draft by itself (`+Drafts`).
    draftMayHaveChanged()
    return insertion
  }

  /// The end of composing a character (IME): a prompt that waited goes into the field now.
  private func writePendingVoiceAgentPrompt() {
    guard let pending = voiceAgentChrome.pendingPrompt, composer.textView.markedTextRange == nil else { return }
    guard composer.isEditable, !composer.isHidden, voiceAgentChrome.session?.isActive == true else {
      voiceAgentChrome.pendingPrompt = nil
      return
    }
    writeVoiceAgentPrompt(pending.text, version: pending.version)
  }

  /// A change of the field: the prompt follows it, and the conversation hears when it left the field.
  private func voiceAgentFieldChanged(_ change: VoiceAgentDraft.Change? = nil) {
    if voiceAgentChrome.draft.observe(composer.text, change: change) { voiceAgentChrome.session?.promptLeftField() }
    writePendingVoiceAgentPrompt()
  }

  /// `send_prompt` after the user confirmed: the send operation of the field while the prompt with `version` still
  /// stands in it (`nil` = it does not, nothing taken).
  private func sendVoiceAgentField(_ version: Int) async -> ComposerSendResult? {
    voiceAgentFieldChanged()
    guard voiceAgentChrome.draft.holds(version: version) else { return nil }
    return await sendField(byVoice: true).value
  }

  /// The background of the written prompt, gone after ``VoiceAgentChrome/highlightSeconds``; typing after it does
  /// not take the background.
  private func highlightVoiceAgentPrompt(_ range: NSRange) {
    voiceAgentChrome.highlightTimer?.cancel()
    clearVoiceAgentHighlight()
    let storage = composer.textView.textStorage
    guard range.length > 0, NSMaxRange(range) <= storage.length else { return }
    storage.addAttribute(.backgroundColor, value: Palette.promptHighlight, range: range)
    composer.textView.typingAttributes[.backgroundColor] = nil
    voiceAgentChrome.highlightTimer = voiceAgentChrome.session?.after(VoiceAgentChrome.highlightSeconds) {
      [weak self] in self?.clearVoiceAgentHighlight()
    }
  }

  private func clearVoiceAgentHighlight() {
    let storage = composer.textView.textStorage
    storage.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: storage.length))
  }

  /// No prompt of the agent in the field: a new conversation, or the end of one.
  private func forgetVoiceAgentPrompt() {
    voiceAgentChrome.draft.reset()
    voiceAgentChrome.pendingPrompt = nil
  }

  /// The highlighted range of the field, for the tests (`nil` = no highlight).
  var voiceAgentHighlight: NSRange? {
    let storage = composer.textView.textStorage
    var found: NSRange?
    storage.enumerateAttribute(.backgroundColor, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
      if value != nil, found == nil { found = range }
    }
    return found
  }
}

/// Five bars drawn by the app on the voice agent button (`VoiceAgentBars`).
@MainActor
final class VoiceAgentBarsView: UIView {
  private static let barWidth: CGFloat = 2
  private static let gap: CGFloat = 1
  private var bars: [UIView] = []
  private var heights: [NSLayoutConstraint] = []

  init() {
    super.init(frame: .zero)
    translatesAutoresizingMaskIntoConstraints = false
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    let stack = UIStackView()
    stack.axis = .horizontal
    stack.alignment = .center
    stack.spacing = Self.gap
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      heightAnchor.constraint(equalToConstant: VoiceAgentBars.maxHeight),
    ])
    for height in VoiceAgentBars.rest {
      let bar = UIView()
      bar.layer.cornerRadius = Self.barWidth / 2
      bar.translatesAutoresizingMaskIntoConstraints = false
      let constraint = bar.heightAnchor.constraint(equalToConstant: height)
      NSLayoutConstraint.activate([bar.widthAnchor.constraint(equalToConstant: Self.barWidth), constraint])
      stack.addArrangedSubview(bar)
      bars.append(bar)
      heights.append(constraint)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// Bar heights in points (`VoiceAgentBars.heights`).
  func show(_ values: [Double]) {
    for (constraint, value) in zip(heights, values) where constraint.constant != CGFloat(value) {
      constraint.constant = CGFloat(value)
    }
  }

  func tint(_ color: UIColor) {
    for bar in bars { bar.backgroundColor = color }
  }

  /// Current heights, for the tests.
  var shownHeights: [Double] { heights.map { Double($0.constant) } }
}
#endif
