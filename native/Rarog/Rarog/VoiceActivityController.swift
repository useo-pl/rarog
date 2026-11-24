import ActivityKit
import Foundation
import RarogActivity
import RarogCore
import RarogUI

// The voice Live Activity of the locked-phone trial (`VoiceActivityAttributes` from `RarogActivity`), beside the
// sessions board, which it leaves alone. Owner: voice agent. The rules run with a fake of ActivityKit in
// `VoiceActivityControllerTests`; the ActivityKit adapter stands at the end of this file.
//
// - While the trial is on and the app's microphone records (`AppMicrophone.recording`), exactly one voice activity
//   stands: requested once (no push type, so only the app writes it), updated only when what it shows changes (the
//   kind, the phase, the subject), ended at once when nothing records or the trial goes off. The microphone reports
//   every change (a claim, a start, an end, every hypothesis of a dictation, every state of the conversation), so a
//   repeat with the same state changes nothing. Requests, updates and ends run one after another, in order.
// - One request per recording: a refused one (Live Activities off, the app not in the foreground, a limit) writes one
//   `client.log` line, `voice-agent: live activity not started (<reason>)`, and the next try waits until nothing has
//   recorded. The same holds after the End button while a stopped dictation still finishes its text. A request the
//   limit refused while an earlier activity's end is still on its way is tried once more after that end.
// - At launch every voice activity the system still shows ends (one a stopped process left).
// - The End button (`EndVoiceActivityIntent`, whose handler the app installs) ends what records as the user's own end
//   does and writes `voice-agent: ended from live activity` or `dictation: ended from live activity`, nothing else;
//   with nothing recording it writes nothing. Then it ends every voice activity the system showed when the button
//   was pressed: one a recording started meanwhile stays.
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

/// The ActivityKit calls of the voice activity, behind a protocol so the rules run with a fake in the tests.
@MainActor
protocol VoiceActivitySystem: AnyObject {
  /// Ids of every voice activity the system may still show, also one a stopped process left.
  func shownIds() -> [String]
  /// Starts the activity; its id.
  func request(_ state: VoiceActivityAttributes.ContentState) throws(VoiceActivityRefusal) -> String
  func update(_ id: String, to state: VoiceActivityAttributes.ContentState) async
  /// Ends the activity and takes it off the screen at once.
  func end(_ id: String) async
}

/// The voice Live Activity around the app's microphone.
@MainActor
final class VoiceActivityController {
  typealias State = VoiceActivityAttributes.ContentState

  private let microphone: AppMicrophone
  private let trial: LockedPhoneTrial
  private let system: any VoiceActivitySystem
  private let now: () -> Date
  private let trace: @MainActor (String) -> Void

  /// The one activity this process shows.
  private var shown: (id: String, state: State)?
  /// A request went out for the recording that runs (or its End was pressed): no other until nothing records.
  private var attempted = false
  /// The system calls run one after another, in the order the rules made them.
  private var queue: Task<Void, Never>?
  /// System calls made and not finished.
  private var pending = 0
  /// A request the limit refused waits for the calls on their way; no other request goes out until it ran.
  private var retrying = false

  init(
    microphone: AppMicrophone, trial: LockedPhoneTrial, system: any VoiceActivitySystem, now: @escaping () -> Date,
    trace: @escaping @MainActor (String) -> Void
  ) {
    self.microphone = microphone
    self.trial = trial
    self.system = system
    self.now = now
    self.trace = trace
  }

  /// The app's controller: the app's microphone, the device's trial switch from `store.voiceAgent` (so the app builds
  /// it after `attachVoiceAgent`), ActivityKit, and the store's `client.log` lines on the voice agent budget.
  static func live(store: RarogStore) -> VoiceActivityController {
    VoiceActivityController(
      microphone: .shared, trial: store.voiceAgent.lockedPhoneTrial, system: ActivityKitVoiceActivities(),
      now: Date.init, trace: { [weak store] line in store?.trace(line, budget: .voiceAgent) })
  }

  /// At launch: ends the leftovers, then follows the microphone and the trial switch.
  func start() {
    for id in system.shownIds() { enqueue { system in await system.end(id) } }
    microphone.observe { [weak self] in self?.evaluate() }
    watchTrial()
    evaluate()
  }

  /// The End button of the activity: ends what records and writes its line, then ends every voice activity shown.
  func endFromLiveActivity() async {
    // What stands at the press: the wait below lets a new recording start, and its activity is not this button's.
    let own = shown?.id
    let leftovers = system.shownIds().filter { $0 != own }
    if let ended = microphone.endFromLockScreen() {
      trace("\(Self.prefix(ended)): ended from live activity")
    }
    // A stopped dictation still reports its use until its last words land: no new activity for it.
    if microphone.recording != nil { attempted = true }
    retrying = false
    if shown?.id == own { endShown() }
    for id in leftovers { enqueue { system in await system.end(id) } }
    await settled()
  }

  /// Waits for the system calls made so far.
  func settled() async {
    await queue?.value
  }

  private func evaluate() {
    guard trial.on, let recording = microphone.recording else {
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
      enqueue { system in await system.update(shown.id, to: next) }
      return
    }
    guard !attempted else { return }
    attempted = true
    let state = Self.state(recording, startedAt: now())
    do {
      shown = (try system.request(state), state)
    } catch {
      // The end of the activity before this one may still hold its place: once more after the calls on their way.
      // One retry at a time: the reports that come meanwhile find `attempted` set and ask for nothing.
      if error == .limit, pending > 0, !retrying {
        retrying = true
        enqueue(counts: false) { [weak self] _ in
          // The End button, the recording's end or the trial going off took the retry back.
          guard let self, self.retrying else { return }
          self.retrying = false
          self.attempted = false
          self.evaluate()
        }
        return
      }
      trace("voice-agent: live activity not started (\(error.rawValue))")
    }
  }

  private func endShown() {
    guard let shown else { return }
    self.shown = nil
    enqueue { system in await system.end(shown.id) }
  }

  /// The switch changes only through Observation; `onChange` comes before the new value is stored, so the rule
  /// runs on the next main-actor turn.
  private func watchTrial() {
    withObservationTracking {
      _ = trial.on
    } onChange: { [weak self] in
      Task { @MainActor in
        self?.evaluate()
        self?.watchTrial()
      }
    }
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

/// `ActivityKit.Activity<VoiceActivityAttributes>`: started without a push type, ended with `.immediate`.
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

  func request(_ state: VoiceActivityAttributes.ContentState) throws(VoiceActivityRefusal) -> String {
    do {
      let content = ActivityContent(state: state, staleDate: nil, relevanceScore: Self.relevance)
      return try Handle.request(attributes: VoiceActivityAttributes(), content: content, pushType: nil).id
    } catch let error as ActivityAuthorizationError {
      throw VoiceActivityRefusal(error)
    } catch {
      throw .failed
    }
  }

  func update(_ id: String, to state: VoiceActivityAttributes.ContentState) async {
    await Self.update(id, state: state)
  }

  func end(_ id: String) async {
    await Self.end(id)
  }

  // `Activity` is not `Sendable`, and its `end` and `update` run off the main actor: the handle looked up by id in
  // the same context does not cross an isolation boundary.
  private nonisolated static func update(_ id: String, state: VoiceActivityAttributes.ContentState) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    await activity.update(ActivityContent(state: state, staleDate: nil, relevanceScore: relevance))
  }

  private nonisolated static func end(_ id: String) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    await activity.end(nil, dismissalPolicy: .immediate)
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
