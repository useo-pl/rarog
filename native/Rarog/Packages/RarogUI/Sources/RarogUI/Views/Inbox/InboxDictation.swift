#if os(iOS)
import Observation
import RarogContract
import RarogCore
import UIKit

// Dictation into the reply field of an Inbox result card: the third host of a recording, beside the message field
// (`ComposerDictation`) and a project note (`NoteDictation`), on the same parts: the recorder, the binding with the
// field (`VoiceFieldBinding` over `InboxDictationTarget`) and the core's route (`RarogStore.dictationRoute`). Written
// out rather than shared, as the other two are. One card records at a time; the screen's reply host
// (`InboxReplyHost`) owns this object and tells it of every change of a field.
//
// - The mic's tap takes the route: the asking route opens the Dictation sheet and records nothing (the next tap
//   records after a choice), the system's speech recognition or Soniox record. The app never switches the provider on
//   its own. A second tap ends the recording with its last words in the field; nothing is sent.
// - Dictation appends at the end of the field. Every change of the field during a recording, by the keyboard or by
//   code (a reply that came back, a text waiting in the draft), is a new starting point (`rebase`): otherwise the next
//   words would write the field over with its value from before the change.
// - ↑ during a recording, or while it finishes, ends it and waits for the last words, then sends the whole text once.
// - The background ends the recording; the text stays in the field and goes to the session's draft at once. Leaving
//   the Inbox and another place taking the microphone (`DictationCenter`) make the hypothesis the field's text, which
//   goes to the draft.
// - During the card's own voice conversation the host does not start a recording at all (the conversation holds the
//   microphone, and taking it would end the conversation). Owner: Inbox.

@MainActor
@Observable
final class InboxDictation: DictationHost {
  /// The recorder's state: phase, buffers, notice; the mic and the line under the field read it.
  private(set) var view = VoiceView()
  /// The server refused the Soniox route when the key was fetched: a sentence instead of the recording's state.
  private(set) var disabled: String?
  /// The card (session id) that records now or recorded last; its field shows the state line.
  private(set) var sessionId: String?

  /// The recording's parts on the device; the tests set fakes.
  @ObservationIgnored var services: VoiceServices
  /// The field's text was settled outside a typing pause (the end of a recording in the background, a hand-off):
  /// the host writes the session's draft now.
  @ObservationIgnored var onSettled: @MainActor (String) -> Void = { _ in }

  @ObservationIgnored private weak var store: RarogStore?
  @ObservationIgnored private var recorder: VoiceRecorder?
  @ObservationIgnored private var recording = 0
  @ObservationIgnored private var field: VoiceFieldBinding?
  /// Held strongly: the binding keeps its target weakly.
  @ObservationIgnored private var target: InboxDictationTarget?
  @ObservationIgnored private var spoken: VoiceView.Phase?
  @ObservationIgnored private var warned = false
  /// Who waits for the whole text (↑ while the recording finishes).
  @ObservationIgnored private var idleWaiters: [@MainActor () -> Void] = []
  @ObservationIgnored private var sendWaiting = false
  /// Background work of finishing the recording (through the store, `RarogStore.beginBackgroundWork`).
  @ObservationIgnored private var backgroundWork: BackgroundWorkToken?
  /// The background ended the current recording; set with or without background time from the system.
  @ObservationIgnored private var endedByBackground = false
  @ObservationIgnored private var observer: (any NSObjectProtocol)?

  init(services: VoiceServices = .current) {
    self.services = services
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.enteredBackground() }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    // The screen went without a hand-off: the microphone and the stream must not outlive it.
    recorder?.cancel()
    finishBackgroundWork()
  }

  /// The card's field records or finishes a recording.
  func records(_ sessionId: String) -> Bool {
    view.active && self.sessionId == sessionId
  }

  /// The line under the card's field: the recording's state, or its notice until the next edit. `opensSettings`: the
  /// refusal is fixed in the iOS Settings.
  func statusLine(_ sessionId: String) -> (text: String, isError: Bool, opensSettings: Bool)? {
    guard self.sessionId == sessionId else { return nil }
    if let disabled { return (disabled, true, false) }
    let text = UICopy.voiceStatus(view)
    guard !text.isEmpty else { return nil }
    return (text, view.notice?.isError == true, view.notice?.opensSettings == true)
  }

  func openSettings() {
    services.openSettings()
  }

  /// The mic of a card's field: ends that card's recording, otherwise starts by the route (a recording on another
  /// card hands its text over first). `read` and `write` reach the field in the reply host.
  func toggle(
    _ sessionId: String, store: RarogStore, navigation: RarogNavigation?,
    read: @escaping @MainActor (String) -> String, write: @escaping @MainActor (String, String) -> Void
  ) {
    if let recorder, recorder.active {
      if self.sessionId == sessionId {
        recorder.stop()
        return
      }
      handOff()
    }
    self.store = store
    switch store.dictationRoute {
    case .ask:
      navigation?.openDictation()
    case .system:
      start(InboxDictationTarget(sessionId: sessionId, read: read, write: write), engine: .system)
    case .soniox:
      start(InboxDictationTarget(sessionId: sessionId, read: read, write: write), engine: .soniox)
    }
  }

  /// ↑ of a card's field: during that card's recording it ends the recording and waits for its last words (at most
  /// the finalization limit), so the reply carries the whole sentence and no late word lands in the emptied field;
  /// a second ↑ meanwhile sends nothing more. Otherwise it sends at once.
  func send(_ sessionId: String, _ send: @escaping @MainActor () -> Void) {
    guard let recorder, recorder.active, self.sessionId == sessionId else {
      send()
      return
    }
    guard !sendWaiting else { return }
    // The waiter goes in before `stop()`: a recording with no stream yet ends synchronously, and a waiter added
    // after that would miss this end and fire at the next recording's.
    sendWaiting = true
    idleWaiters.append { [weak self] in
      self?.sendWaiting = false
      send()
    }
    if recorder.view.phase != .finalizing { recorder.stop() }
  }

  /// The card's field changed, by the person (`byPerson`) or by code. During its recording a change other than the
  /// recording's own write is a new starting point; after a recording the person's edit answers its notice, which goes.
  func fieldChanged(_ sessionId: String, byPerson: Bool) {
    guard self.sessionId == sessionId else { return }
    guard let recorder, recorder.active else {
      if byPerson, view.notice != nil || disabled != nil {
        view = VoiceView()
        disabled = nil
      }
      return
    }
    if field?.fieldChanged() == true { recorder.rebase() }
  }

  /// Hands over the recording of `sessionId`'s field only (its field leaves the host).
  func handOff(_ sessionId: String) {
    guard self.sessionId == sessionId else { return }
    handOff()
  }

  /// The Inbox leaves or another place takes the microphone: the hypothesis becomes the field's text, the stream goes
  /// down without waiting, and the field goes to the session's draft. A ↑ waiting for the last words still sends what
  /// the field holds now: leaving is not taking the reply back. The binding goes before the cancel, which reports
  /// empty buffers that would write over the dictated text.
  func handOff() {
    guard let recorder, recorder.active else { return }
    if let field { field.write(field.value(SonioxText.fold(recorder.view.buffers))) }
    let pendingSend = sendWaiting ? idleWaiters : []
    let settled = target?.sessionId
    field = nil
    idleWaiters = []
    sendWaiting = false
    spoken = .finalizing
    recorder.cancel()
    for wake in pendingSend { wake() }
    if let settled { onSettled(settled) }
  }

  // MARK: - Recording

  private func start(_ target: InboxDictationTarget, engine: DictationEngine) {
    DictationCenter.shared.claim(self)
    self.target = target
    sessionId = target.sessionId
    field = VoiceFieldBinding(target: target)
    spoken = nil
    warned = false
    disabled = nil
    endedByBackground = false
    recording += 1
    let id = recording
    let recorder = VoiceRecorder(
      deps: services.recorder(
        engine, mint: { [weak self] in await self?.mint() ?? .stop("") },
        trace: { [weak self] line in self?.store?.trace(line) }),
      handlers: .init(
        view: { [weak self] view in
          guard let self, self.recording == id else { return }
          self.show(view)
        },
        level: { _ in },
        disabled: { [weak self] message in self?.serverDisabled(message) }))
    self.recorder = recorder
    recorder.start()
  }

  private func mint() async -> VoiceMint {
    guard let store else { return .stop("") }
    return VoiceMint(await store.mintVoiceToken())
  }

  private func show(_ next: VoiceView) {
    field?.show(next.buffers, final: next.phase == .idle)
    view = next
    announce(next)
    if next.phase == .idle { finished() }
  }

  private func finished() {
    field = nil
    // A recording ended by the background: the typing pause's draft write may not run before the app sleeps.
    if endedByBackground, let settled = target?.sessionId { onSettled(settled) }
    endedByBackground = false
    finishBackgroundWork()
    let waiters = idleWaiters
    idleWaiters = []
    for wake in waiters { wake() }
  }

  private func enteredBackground() {
    guard let recorder, recorder.active else { return }
    // No server needed: the audio goes straight to Soniox, and a key for a retry has its own background work
    // (`RarogStore.mintVoiceToken`). An expired time closes the task in the adapter; a later end does nothing then.
    if backgroundWork == nil {
      backgroundWork = store?.beginBackgroundWork("inbox dictation", needsServer: false)
    }
    endedByBackground = true
    recorder.interrupt()
  }

  private func finishBackgroundWork() {
    guard let work = backgroundWork else { return }
    backgroundWork = nil
    store?.endBackgroundWork(work)
  }

  private func serverDisabled(_ message: String) {
    disabled = message
    Announcer.shared.say(message)
  }

  private func announce(_ view: VoiceView) {
    if spoken != view.phase {
      spoken = view.phase
      var quiet = view
      quiet.secondsLeft = nil
      let text = UICopy.voiceStatus(quiet)
      if !text.isEmpty { Announcer.shared.say(text) }
    }
    if let left = view.secondsLeft, !warned {
      warned = true
      Announcer.shared.say(UICopy.voiceLimitSpoken(seconds: left))
    }
  }
}
#endif
