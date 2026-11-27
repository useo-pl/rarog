import ActivityKit
import Foundation
import RarogActivity
import RarogCore
import RarogUI

// The voice Live Activity (`VoiceActivityAttributes` from `RarogActivity`), beside the sessions board, which it leaves
// alone. Owner: voice agent. The rules run with a fake of ActivityKit in `VoiceActivityControllerTests`; the
// ActivityKit adapter stands at the end of this file.
//
// - While the app's microphone records (`AppMicrophone.recording`), exactly one voice activity stands: requested
//   once (no push type, so only the app writes it), updated only when what it shows changes (the kind, the phase, the
//   subject), ended at once when nothing records. The microphone reports
//   every change (a claim, a start, an end, every hypothesis of a dictation, every state of the conversation), so a
//   repeat with the same state changes nothing. Requests, updates and ends run one after another, in order.
// - The background rule (`BackgroundRecording`) learns whether the tile of what records stands: shown from a granted
//   request until this controller ends it, or until the system reports it ended or dismissed (the person removed it
//   from the Lock Screen); a refused request shows none. A recording whose tile went gets no new one.
// - One request per recording: a refused one (Live Activities off, the app not in the foreground, a limit) writes one
//   `client.log` line, `voice-agent: live activity not started (<reason>)`, and the next try waits until nothing has
//   recorded. The same holds after the End button while a stopped dictation still finishes its text. A request the
//   limit refused while an earlier activity's end is still on its way is tried once more after that end.
// - At launch every voice activity the system still shows ends (one a stopped process left).
// - Both buttons carry the id of the activity they stand on; a press on another activity than the one this process
//   shows for what records changes no recording and writes no line.
// - The End button (`EndVoiceActivityIntent`, whose handler the app installs) ends what records as the user's own end
//   does and writes `voice-agent: ended from live activity` or `dictation: ended from live activity`, nothing else;
//   with nothing recording it writes nothing. Then it ends every voice activity the system showed when the button
//   was pressed, except one that shows a send: one a recording started meanwhile stays. A press on an activity that
//   is no longer the current one ends only that activity. End is ignored while the activity's send runs.
// - The Send button of a dictation (`SendDictationActivityIntent`) ends the dictation and sends its field
//   (`AppMicrophone.sendFromLockScreen()`). From the press until the outcome is on the activity it holds a background
//   work that needs the server; the activity says "Sending…" with a stale date 30 s on, after which the system shows
//   it as not confirmed even when the process no longer runs. The recording's last reports and its end leave that
//   activity alone. `sent` and `queued` end it at once; `notSent` and `unconfirmed` end it with their phase and a
//   timer stopped at the outcome, left on the Lock Screen for 5 minutes, unless the app comes to the foreground or a
//   new recording asks for its own activity first. A background work the system expires before the outcome ends the
//   activity as not confirmed and writes `dictation: live activity send expired`; an outcome that still comes as sent
//   takes it off. A refused background work writes `dictation: live activity send no background time`, and the send
//   runs anyway. A new recording takes the activity from the send, which goes on without it. The send's own result
//   line comes from the microphone.
// - The state is what the microphone reports: the kind, the phase and the subject, which carries only a session's
//   project and name (`ContentState` cuts each to its ceiling). The timer counts from the moment the activity appears
//   for the recording; a new phase or subject keeps it, a new kind restarts it.

/// A refused request for the voice activity: one word for its `client.log` line.
enum VoiceActivityRefusal: String, Error {
  /// Live Activities are off for the app in Settings.
  case disabled
  /// The app was not in the foreground.
  case background
  /// The app's or the device's limit of Live Activities.
  case limit
  case failed
}

/// When an ended voice activity leaves the screen (ActivityKit's `ActivityUIDismissalPolicy`).
enum VoiceActivityDismissal: Sendable, Equatable {
  /// At once, also an activity that already ended.
  case immediate
  /// The system takes it off at this date, with no process running.
  case after(Date)
}

/// The ActivityKit calls of the voice activity, behind a protocol so the rules run with a fake in the tests.
@MainActor
protocol VoiceActivitySystem: AnyObject {
  /// Ids of every voice activity the system may still show, also one a stopped process left.
  func shownIds() -> [String]
  /// Starts the activity; its id. `gone` learns once that the system reports it ended or dismissed, also by someone
  /// else than the app (the person removed it from the Lock Screen).
  func request(
    _ state: VoiceActivityAttributes.ContentState, gone: @escaping @MainActor (String) -> Void
  ) throws(VoiceActivityRefusal) -> String
  /// `staleDate`: from then on the system marks the content stale, also with no process running; `nil` = never.
  func update(_ id: String, to state: VoiceActivityAttributes.ContentState, staleDate: Date?) async
  /// Ends the activity with `final` as its last content (`nil` = the content it shows) and takes it off the screen as
  /// `dismissal` says.
  func end(_ id: String, final state: VoiceActivityAttributes.ContentState?, dismissal: VoiceActivityDismissal) async
}

/// The background work of a send from the activity: the store's (`RarogStore.beginBackgroundWork`), which keeps the
/// process and the server connection; the tests give a fake.
struct VoiceActivityWork {
  /// Starts a work that needs the server; `expired` learns that the system took the time back before the end.
  /// `nil` = the system refused.
  var begin: @MainActor (_ name: String, _ expired: @escaping @MainActor () -> Void) -> BackgroundWorkToken?
  var end: @MainActor (BackgroundWorkToken?) -> Void
}

/// The voice Live Activity around the app's microphone.
@MainActor
final class VoiceActivityController {
  typealias State = VoiceActivityAttributes.ContentState

  /// A send's activity turns stale this long after the press: it then reads as not confirmed.
  static let sendStale: TimeInterval = 30
  /// A failed or unconfirmed send's activity stays on the Lock Screen this long after its outcome.
  static let failureShown: TimeInterval = 5 * 60

  private let microphone: AppMicrophone
  /// The background rule: told whether the tile of what records stands.
  private let background: BackgroundRecording
  private let system: any VoiceActivitySystem
  private let work: VoiceActivityWork
  private let now: () -> Date
  private let trace: @MainActor (String) -> Void

  /// The one activity this process shows for what records (or for the send that runs); the background rule follows
  /// whether it stands.
  private var shown: (id: String, state: State)? {
    didSet { background.tile(shown: shown != nil) }
  }
  /// A request went out for the recording that runs (or its End was pressed): no other until nothing records.
  private var attempted = false
  /// The system calls run one after another, in the order the rules made them.
  private var queue: Task<Void, Never>?
  /// System calls made and not finished.
  private var pending = 0
  /// A request waits for the calls on their way (the limit refused it, or a failed send's activity leaves first); no
  /// other request goes out until it ran.
  private var retrying = false
  /// The send from the activity that still owns it: its number, the activity of its press, and whether the recording
  /// it ended stopped reporting (a recording after that is a new one). `nil` once a new recording took the activity,
  /// or once its outcome came.
  private var sending: (number: Int, activity: String, recordingOver: Bool)?
  /// Sends whose outcome has not come yet, by number.
  private var running: Set<Int> = []
  private var sends = 0
  /// The ended activity that shows a failed or unconfirmed send until the system takes it off.
  private var failure: String?
  /// The app is in the foreground: a failed send's outcome needs no activity, the field shows its text.
  private var foreground = false
  /// The send whose background work is starting, and whether the system took the time back before `begin` returned.
  private var starting: (number: Int, expired: Bool)?

  init(
    microphone: AppMicrophone, background: BackgroundRecording, system: any VoiceActivitySystem,
    work: VoiceActivityWork, now: @escaping () -> Date, trace: @escaping @MainActor (String) -> Void
  ) {
    self.microphone = microphone
    self.background = background
    self.system = system
    self.work = work
    self.now = now
    self.trace = trace
  }

  /// The app's controller: the app's microphone, the background rule from `store.voiceAgent` (so the app builds it
  /// after `attachVoiceAgent`), ActivityKit, the store's background work, and the store's `client.log` lines on
  /// the voice agent budget.
  static func live(store: RarogStore) -> VoiceActivityController {
    let work = VoiceActivityWork(
      begin: { [weak store] name, expired in store?.beginBackgroundWork(name, needsServer: true, expired: expired) },
      end: { [weak store] token in store?.endBackgroundWork(token) })
    return VoiceActivityController(
      microphone: .shared, background: store.voiceAgent.background, system: ActivityKitVoiceActivities(), work: work,
      now: Date.init, trace: { [weak store] line in store?.trace(line, budget: .voiceAgent) })
  }

  /// At launch: ends the leftovers, then follows the microphone.
  func start() {
    for id in system.shownIds() { enqueue { system in await system.end(id, final: nil, dismissal: .immediate) } }
    microphone.observe { [weak self] in self?.evaluate() }
    evaluate()
  }

  /// The app's scene phase: in the foreground the app shows where a failed send's text is, so its activity goes.
  func scene(_ phase: ScenePhase) {
    foreground = phase == .active
    guard foreground else { return }
    endFailure()
  }

  /// The End button of the activity `activityID`: ends what records and writes its line, then ends every voice
  /// activity shown. On an activity that is not the current one it ends only that activity; while the activity's
  /// send runs it does nothing.
  func endFromLiveActivity(activityID: String?) async {
    guard let activityID, sending?.activity != activityID else { return }
    guard activityID == shown?.id else {
      enqueue { system in await system.end(activityID, final: nil, dismissal: .immediate) }
      await settled()
      return
    }
    // What stands at the press: the wait below lets a new recording start, and its activity is not this button's.
    let own = activityID
    let leftovers = system.shownIds().filter { $0 != own }
    if let ended = microphone.endFromLockScreen() {
      trace("\(Self.prefix(ended)): ended from live activity")
    }
    // A stopped dictation still reports its use until its last words land: no new activity for it.
    if microphone.recording != nil { attempted = true }
    retrying = false
    if shown?.id == own { endShown() }
    if leftovers.contains(where: { $0 == failure }) { failure = nil }
    for id in leftovers { enqueue { system in await system.end(id, final: nil, dismissal: .immediate) } }
    await settled()
  }

  /// The Send button of the activity `activityID`: on the current activity of a recording dictation, ends it and sends
  /// the field, shows "Sending…" and returns; the outcome reaches the activity later (``finishSend(_:_:)``). On any
  /// other activity, or with nothing to send, nothing changes and no line is written.
  func sendFromLiveActivity(activityID: String?) async {
    guard let shown, shown.id == activityID, shown.state.kind == .dictation, shown.state.phase == .dictating else {
      return
    }
    sends += 1
    let number = sends
    // Before the microphone hears of the press: the reports of the recording's end leave the activity alone.
    sending = (number, shown.id, false)
    // The work starts before the recording stops, while its open microphone still keeps the app running.
    starting = (number, false)
    let token = work.begin("dictation send") { [weak self] in self?.expired(number) }
    let expiredEarly = starting?.expired == true
    starting = nil
    guard let operation = microphone.sendFromLockScreen() else {
      sending = nil
      work.end(token)
      evaluate()
      return
    }
    running.insert(number)
    if token == nil { trace("dictation: live activity send no background time") }
    let stale = now() + Self.sendStale
    var state = shown.state
    state.phase = .sending
    state.stoppedAt = stale
    self.shown = (shown.id, state)
    enqueue { system in await system.update(shown.id, to: state, staleDate: stale) }
    let work = work
    Task { [weak self] in
      let result = await operation.value
      await self?.finishSend(number, result)
      work.end(token)
    }
    if expiredEarly { expired(number) }
    await settled()
  }

  /// Waits for the system calls made so far.
  func settled() async {
    await queue?.value
  }

  private func evaluate() {
    if let sending {
      // The recording the send ended finishes its text and stops: the activity keeps saying "Sending…".
      guard isNew(microphone.recording) else { return }
      // A new recording took the microphone: the send goes on without its activity.
      self.sending = nil
      attempted = false
      if shown?.id == sending.activity {
        endShown()
        // The new recording asks for its own activity once the send's is off the screen.
        attempted = true
        retryAfterPending()
        return
      }
    }
    guard let recording = microphone.recording else {
      attempted = false
      retrying = false
      endShown()
      return
    }
    if let shown {
      // The same recording keeps its timer; another kind is another recording.
      let sameKind = shown.state.kind == Self.kind(recording.kind)
      let next = Self.state(recording, startedAt: sameKind ? shown.state.startedAt : now())
      guard next != shown.state else { return }
      self.shown = (shown.id, next)
      enqueue { system in await system.update(shown.id, to: next, staleDate: nil) }
      return
    }
    guard !attempted else { return }
    attempted = true
    if let failure {
      // A failed send's activity leaves before the new recording asks for its own.
      self.failure = nil
      enqueue { system in await system.end(failure, final: nil, dismissal: .immediate) }
      retryAfterPending()
      return
    }
    let state = Self.state(recording, startedAt: now())
    do {
      shown = (try system.request(state) { [weak self] id in self?.gone(id) }, state)
    } catch {
      // The end of the activity before this one may still hold its place: once more after the calls on their way.
      // One retry at a time: the reports that come meanwhile find `attempted` set and ask for nothing.
      if error == .limit, pending > 0, !retrying {
        retryAfterPending()
        return
      }
      trace("voice-agent: live activity not started (\(error.rawValue))")
    }
  }

  /// The rule runs once more after the calls on their way. One retry at a time: the reports that come meanwhile
  /// find `attempted` set and ask for nothing.
  private func retryAfterPending() {
    retrying = true
    enqueue(counts: false) { [weak self] _ in
      // The End button or the recording's end took the retry back.
      guard let self, self.retrying else { return }
      self.retrying = false
      self.attempted = false
      self.evaluate()
    }
  }

  /// Whether `recording` is another one than the recording the send ended. A host claims the microphone before it
  /// opens it and reports no use until then (`DictationHost`), so the sent recording's end always comes first.
  private func isNew(_ recording: AppMicrophone.Recording?) -> Bool {
    guard let recording else {
      sending?.recordingOver = true
      return false
    }
    return sending?.recordingOver == true || recording.kind != .dictation
  }

  /// The outcome of send `number`: on the activity that still shows it, an end at once (`sent`, `queued`, any outcome
  /// with the app in the foreground) or an end with the failure's phase and a stopped timer, left on the Lock Screen
  /// for ``failureShown``. A send that lost its activity changes no activity.
  private func finishSend(_ number: Int, _ result: LockScreenSend) async {
    running.remove(number)
    guard let sending, sending.number == number else { return }
    self.sending = nil
    let arrived = result == .sent || result == .queued
    let at = now()
    if let shown, shown.id == sending.activity {
      self.shown = nil
      if arrived || foreground {
        enqueue { system in await system.end(shown.id, final: nil, dismissal: .immediate) }
      } else {
        var state = shown.state
        state.phase = result == .notSent ? .notSent : .unconfirmed
        state.stoppedAt = at
        failure = shown.id
        enqueue { system in await system.end(shown.id, final: state, dismissal: .after(at + Self.failureShown)) }
      }
    } else if arrived, failure == sending.activity {
      // The background time ran out first and the activity says "Not confirmed"; the message did arrive.
      endFailure()
    }
    evaluate()
    await settled()
  }

  /// The system took the background time of send `number` back before its outcome: the activity that shows the send
  /// ends as not confirmed, where the system may stop the process at any moment.
  private func expired(_ number: Int) {
    if starting?.number == number {
      // `begin` reports the expiry before it returns: the send is shown first, then ends as not confirmed.
      starting?.expired = true
      return
    }
    guard running.contains(number) else { return }
    trace("dictation: live activity send expired")
    guard let sending, sending.number == number, let shown, shown.id == sending.activity else { return }
    self.shown = nil
    let at = now()
    var state = shown.state
    state.phase = .unconfirmed
    state.stoppedAt = at
    failure = shown.id
    enqueue { system in await system.end(shown.id, final: state, dismissal: .after(at + Self.failureShown)) }
  }

  private func endShown() {
    guard let shown else { return }
    self.shown = nil
    enqueue { system in await system.end(shown.id, final: nil, dismissal: .immediate) }
  }

  private func endFailure() {
    guard let failure else { return }
    self.failure = nil
    enqueue { system in await system.end(failure, final: nil, dismissal: .immediate) }
  }

  /// The system reports activity `id` ended or dismissed. The controller's own ends cleared ``shown`` before; for the
  /// current tile this is someone else's end (the person removed it from the Lock Screen), so it no longer stands for
  /// the background rule, and the same recording asks for none again.
  private func gone(_ id: String) {
    guard shown?.id == id else { return }
    shown = nil
  }

  /// `counts`: a system call, which may hold an activity's place until it finishes; a retry of the rule does not.
  private func enqueue(counts: Bool = true, _ work: @escaping @MainActor (any VoiceActivitySystem) async -> Void) {
    let previous = queue
    let system = system
    if counts { pending += 1 }
    queue = Task {
      await previous?.value
      await work(system)
      if counts { self.pending -= 1 }
    }
  }

  /// The activity's state for what records: its kind, phase and subject, nothing else.
  private static func state(_ recording: AppMicrophone.Recording, startedAt: Date) -> State {
    let phase: State.Phase =
      switch recording.phase {
      case .working: .working
      case .listening: .listening
      case .answering: .answering
      case .reading: .reading
      case .prompt: .prompt
      case .muted: .muted
      case .dictating: .dictating
      }
    switch recording.subject {
    case .allSessions:
      return State(kind: kind(recording.kind), phase: phase, scope: .allSessions, startedAt: startedAt)
    case let .session(project, name):
      return State(
        kind: kind(recording.kind), phase: phase, scope: .session, project: project, name: name, startedAt: startedAt)
    }
  }

  private static func kind(_ kind: AppMicrophone.Recording.Kind) -> State.Kind {
    switch kind {
    case .conversation: .conversation
    case .dictation: .dictation
    }
  }

  private static func prefix(_ kind: AppMicrophone.Recording.Kind) -> String {
    switch kind {
    case .conversation: "voice-agent"
    case .dictation: "dictation"
    }
  }
}

// MARK: - ActivityKit

/// `ActivityKit.Activity<VoiceActivityAttributes>`: started without a push type, ended with the controller's content
/// and dismissal.
final class ActivityKitVoiceActivities: VoiceActivitySystem {
  private typealias Handle = ActivityKit.Activity<VoiceActivityAttributes>

  /// The sessions board's content carries no score of its own; this one asks the system to order the voice
  /// activity first.
  nonisolated static let relevance: Double = 100

  /// Ended activities count: the system keeps them on the Lock Screen until an `.immediate` end takes them off.
  func shownIds() -> [String] {
    Handle.activities
      .filter { [.active, .stale, .pending, .ended].contains($0.activityState) }
      .map(\.id)
  }

  func request(
    _ state: VoiceActivityAttributes.ContentState, gone: @escaping @MainActor (String) -> Void
  ) throws(VoiceActivityRefusal) -> String {
    let activity: Handle
    do {
      let content = ActivityContent(state: state, staleDate: nil, relevanceScore: Self.relevance)
      activity = try Handle.request(attributes: VoiceActivityAttributes(), content: content, pushType: nil)
    } catch let error as ActivityAuthorizationError {
      throw VoiceActivityRefusal(error)
    } catch {
      throw .failed
    }
    let id = activity.id
    let updates = activity.activityStateUpdates
    Task { @MainActor in
      for await state in updates where state == .ended || state == .dismissed {
        gone(id)
        return
      }
    }
    return id
  }

  func update(_ id: String, to state: VoiceActivityAttributes.ContentState, staleDate: Date?) async {
    await Self.update(id, state: state, staleDate: staleDate)
  }

  func end(_ id: String, final state: VoiceActivityAttributes.ContentState?, dismissal: VoiceActivityDismissal) async {
    await Self.end(id, state: state, dismissal: dismissal)
  }

  // `Activity` is not `Sendable`, and its `end` and `update` run off the main actor: the handle looked up by id in
  // the same context does not cross an isolation boundary.
  private nonisolated static func update(
    _ id: String, state: VoiceActivityAttributes.ContentState, staleDate: Date?
  ) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    await activity.update(ActivityContent(state: state, staleDate: staleDate, relevanceScore: relevance))
  }

  private nonisolated static func end(
    _ id: String, state: VoiceActivityAttributes.ContentState?, dismissal: VoiceActivityDismissal
  ) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    let content = state.map { ActivityContent(state: $0, staleDate: nil, relevanceScore: relevance) }
    let policy: ActivityUIDismissalPolicy =
      switch dismissal {
      case .immediate: .immediate
      case let .after(date): .after(date)
      }
    await activity.end(content, dismissalPolicy: policy)
  }
}

extension VoiceActivityRefusal {
  init(_ error: ActivityAuthorizationError) {
    switch error {
    case .denied: self = .disabled
    case .visibility: self = .background
    case .globalMaximumExceeded, .targetMaximumExceeded: self = .limit
    default: self = .failed
    }
  }
}
