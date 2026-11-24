import Foundation
import RarogActivity
import RarogCore
@testable import RarogUI
import XCTest

/// The voice Live Activity's controller (`VoiceActivityController`, an app file this target compiles itself through
/// `membershipExceptions`): while the locked-phone trial is on and the app's microphone records, exactly one voice
/// activity stands, requested once, updated only when its kind, phase or subject changes (a new phase or subject
/// keeps its timer), ended when nothing records or the trial goes off; leftovers end at launch; a refused request
/// writes one line and is not repeated; the End button's handler ends what records and writes its line. The
/// microphone is a real `DictationCenter` with recording places of the test's own, ActivityKit a fake. Owner: voice
/// agent.
@MainActor
final class VoiceActivityControllerTests: XCTestCase {
  typealias State = VoiceActivityAttributes.ContentState

  /// A place that records, with the use the test sets; it reports a change to the center that claimed it. Its end
  /// clears the use when `endClears` (a conversation) and keeps it otherwise (a dictation that finishes its text).
  @MainActor
  private final class Place: DictationHost {
    var microphoneUse: MicrophoneUse?
    var endClears = true
    private(set) var ends = 0
    private weak var center: DictationCenter?

    init(_ kind: MicrophoneUse.Kind?) {
      microphoneUse = kind.map {
        MicrophoneUse(
          kind: $0, audio: true, openAI: $0 == .conversation, soniox: false,
          phase: $0 == .conversation ? .working : .dictating, subject: .session(project: nil, name: nil))
      }
    }

    func handOff() {}
    func claimed(by center: DictationCenter) { self.center = center }
    func report() { center?.changed(self) }

    func endFromLockScreen() {
      ends += 1
      if endClears { microphoneUse = nil }
      report()
    }
  }

  /// ActivityKit's part: the calls in order, the ids it hands out and an optional refusal of every request.
  @MainActor
  private final class FakeActivities: VoiceActivitySystem {
    enum Call: Equatable {
      case request(State.Kind, State.Phase)
      case update(String, State.Kind, State.Phase)
      case end(String)
    }

    var leftovers: [String] = []
    var refusal: VoiceActivityRefusal?
    /// The most activities at once (`nil` = no limit): one more is refused with `limit`.
    var capacity: Int?
    /// Runs once inside the next `end`, while the controller waits for it.
    var duringEnd: (() -> Void)?
    private(set) var calls: [Call] = []
    /// The whole state of each request and update, in order.
    private(set) var states: [State] = []
    private(set) var live: [String] = []
    private var issued = 0

    func shownIds() -> [String] { leftovers + live }

    func request(_ state: State) throws(VoiceActivityRefusal) -> String {
      calls.append(.request(state.kind, state.phase))
      states.append(state)
      if let refusal { throw refusal }
      if let capacity, live.count >= capacity { throw .limit }
      issued += 1
      let id = "voice-\(issued)"
      live.append(id)
      return id
    }

    func update(_ id: String, to state: State) async {
      calls.append(.update(id, state.kind, state.phase))
      states.append(state)
    }

    func end(_ id: String) async {
      calls.append(.end(id))
      leftovers.removeAll { $0 == id }
      live.removeAll { $0 == id }
      let during = duringEnd
      duringEnd = nil
      during?()
    }
  }

  @MainActor
  private struct Rig {
    let center = DictationCenter()
    let trial = LockedPhoneTrial.memory()
    let system = FakeActivities()
    let lines = Lines()
    let clock = Clock()
    let controller: VoiceActivityController

    init(trial on: Bool = true, leftovers: [String] = [], refusal: VoiceActivityRefusal? = nil) {
      trial.set(on)
      system.leftovers = leftovers
      system.refusal = refusal
      let lines = lines
      let clock = clock
      controller = VoiceActivityController(
        microphone: AppMicrophone(center: center), trial: trial, system: system,
        now: { clock.now }, trace: { lines.all.append($0) })
      controller.start()
    }

    /// A place claims the microphone and reports its use.
    @discardableResult
    func record(_ kind: MicrophoneUse.Kind?) -> Place {
      let place = Place(kind)
      center.claim(place)
      return place
    }
  }

  @MainActor
  private final class Lines {
    var all: [String] = []
  }

  /// The controller's clock; the test moves it.
  @MainActor
  private final class Clock {
    var now = Date(timeIntervalSince1970: 1000)
  }

  /// Catches an activity that keeps saying what the recording did first (no update for a new phase or subject), a
  /// timer that restarts at each update, and an update for a repeat of the same state (each one is a call to the
  /// system; the microphone reports every frame window and every second of a session check).
  func testPhaseAndSubjectChangesUpdateTheActivityAndKeepItsTimer() async throws {
    let rig = Rig()
    let place = rig.record(.conversation)
    rig.clock.now += 30
    place.microphoneUse?.phase = .listening
    place.microphoneUse?.subject = .allSessions
    place.report()
    place.microphoneUse?.audio = false
    place.report()
    place.microphoneUse?.subject = .session(project: "atlas", name: "demo")
    place.report()
    place.report()
    place.microphoneUse?.phase = .prompt
    place.report()
    place.microphoneUse = nil
    place.report()
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [
      .request(.conversation, .working), .update("voice-1", .conversation, .listening),
      .update("voice-1", .conversation, .listening), .update("voice-1", .conversation, .prompt), .end("voice-1"),
    ])
    let started = Date(timeIntervalSince1970: 1000)
    func named(_ phase: State.Phase) -> State {
      State(kind: .conversation, phase: phase, scope: .session, project: "atlas", name: "demo", startedAt: started)
    }
    XCTAssertEqual(rig.system.states, [
      State(kind: .conversation, phase: .working, scope: .session, startedAt: started),
      State(kind: .conversation, phase: .listening, scope: .allSessions, startedAt: started),
      named(.listening), named(.prompt),
    ])
  }

  /// Catches a timer that goes on from the conversation when a dictation takes the same activity: another kind is
  /// another recording, so its timer starts at the change.
  func testAnotherKindRestartsTheTimer() async {
    let rig = Rig()
    rig.record(.conversation)
    rig.clock.now += 30
    let dictation = rig.record(.dictation)
    await rig.controller.settled()
    XCTAssertEqual(rig.system.states.map(\.startedAt), [
      Date(timeIntervalSince1970: 1000), Date(timeIntervalSince1970: 1030),
    ])
    XCTAssertEqual(rig.system.states.last?.kind, .dictation)
    XCTAssertNotNil(dictation.microphoneUse)
  }

  /// Catches a controller that asks ActivityKit again at every change the microphone reports, misses a change of
  /// kind, or leaves the activity after the recording: request, one update for the new kind, end.
  func testStartUpdateEndFollowTheRecording() async {
    let rig = Rig()
    let conversation = rig.record(.conversation)
    conversation.report()
    let dictation = Place(.dictation)
    rig.center.claim(dictation)
    dictation.report()
    dictation.microphoneUse = nil
    dictation.report()
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [
      .request(.conversation, .working), .update("voice-1", .dictation, .dictating), .end("voice-1"),
    ])
    XCTAssertEqual(rig.lines.all, [])
  }

  /// Catches a second activity or a needless update for changes that leave the kind and the phase as they are (the
  /// audio and socket flags change at every frame window).
  func testOneActivityForEveryChangeOfTheSameRecording() async {
    let rig = Rig()
    let place = rig.record(.dictation)
    for audio in [false, true, false] {
      place.microphoneUse?.audio = audio
      place.report()
    }
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating)])
  }

  /// Catches an activity outside the trial: with the trial off a recording shows nothing.
  func testNothingWithTheTrialOff() async {
    let rig = Rig(trial: false)
    rig.record(.conversation).report()
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [])
  }

  /// Catches an activity that outlives the trial: switched off while shown, the activity ends at once.
  func testTrialSwitchedOffEndsTheActivity() async {
    let rig = Rig()
    rig.record(.conversation)
    rig.trial.set(false)
    await waitUntil { rig.system.calls.count == 2 }
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.request(.conversation, .working), .end("voice-1")])
  }

  /// Catches a tile a stopped process left: at launch every leftover voice activity ends, and with nothing
  /// recording nothing is requested.
  func testLeftoversEndAtLaunch() async {
    let rig = Rig(leftovers: ["old-1", "old-2"])
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.end("old-1"), .end("old-2")])
  }

  /// Catches a retry loop: a refused request writes one line with its reason word and is not repeated while the same
  /// recording reports changes; the next recording tries once again.
  func testRefusedRequestWritesOneLineAndIsNotRepeated() async {
    let rig = Rig(refusal: .background)
    let place = rig.record(.dictation)
    place.report()
    place.report()
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating)])
    XCTAssertEqual(rig.lines.all, ["voice-agent: live activity not started (background)"])
    place.microphoneUse = nil
    place.report()
    rig.record(.conversation)
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating), .request(.conversation, .working)])
    XCTAssertEqual(rig.lines.all.count, 2)
  }

  /// Catches an End button that does not end the conversation, writes no line or a line with content, or leaves
  /// the activity.
  func testEndFromTheActivityEndsAConversation() async {
    let rig = Rig()
    let place = rig.record(.conversation)
    await rig.controller.endFromLiveActivity()
    XCTAssertEqual(place.ends, 1)
    XCTAssertEqual(rig.lines.all, ["voice-agent: ended from live activity"])
    XCTAssertEqual(rig.system.calls, [.request(.conversation, .working), .end("voice-1")])
  }

  /// Catches the activity coming back while a stopped dictation still finishes its text (its use stays set until
  /// the last words land): the dictation ends once, its line is written, and no new request goes out.
  func testEndFromTheActivityStopsADictationWithoutANewActivity() async {
    let rig = Rig()
    let place = rig.record(.dictation)
    place.endClears = false
    await rig.controller.endFromLiveActivity()
    place.report()
    await rig.controller.settled()
    XCTAssertEqual(place.ends, 1)
    XCTAssertEqual(rig.lines.all, ["dictation: ended from live activity"])
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating), .end("voice-1")])
  }

  /// Catches an End button that also takes the activity of a recording started while it waited for the system: that
  /// recording would go on with no activity and no End button.
  func testEndFromTheActivityLeavesARecordingStartedMeanwhile() async {
    let rig = Rig()
    // The center holds its place weakly: the test keeps both places for the whole case.
    let conversation = rig.record(.conversation)
    let dictation = Place(.dictation)
    rig.system.duringEnd = { rig.center.claim(dictation) }
    await rig.controller.endFromLiveActivity()
    await rig.controller.settled()
    XCTAssertEqual(conversation.ends, 1)
    XCTAssertEqual(rig.system.calls, [
      .request(.conversation, .working), .end("voice-1"), .request(.dictation, .dictating),
    ])
    XCTAssertEqual(rig.system.live, ["voice-2"], "the new recording keeps its activity")
    XCTAssertEqual(dictation.ends, 0)
  }

  /// Catches a recording that never gets its activity because the one before it still held the place: its end was
  /// on its way when the request went out, the limit refused it, and no other try followed.
  func testRequestRefusedByTheLimitIsRepeatedAfterThePendingEnd() async {
    let rig = Rig()
    rig.system.capacity = 1
    let first = rig.record(.conversation)
    first.microphoneUse = nil
    first.report()
    let second = rig.record(.dictation)
    // The reports of the same recording that come before the end ran ask for nothing more.
    second.report()
    second.report()
    await waitUntil { rig.system.live == ["voice-2"] }
    XCTAssertEqual(rig.system.calls, [
      .request(.conversation, .working), .request(.dictation, .dictating), .end("voice-1"),
      .request(.dictation, .dictating),
    ])
    XCTAssertEqual(rig.lines.all, [], "a retried request writes no line")
    XCTAssertEqual(second.ends, 0)
  }

  /// Catches a retry loop at the limit: with no end on its way the refusal writes its line and is not repeated.
  func testRequestRefusedByTheLimitWithNothingPendingWritesItsLine() async {
    let rig = Rig()
    await rig.controller.settled()
    rig.system.capacity = 0
    rig.record(.conversation)
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.request(.conversation, .working)])
    XCTAssertEqual(rig.lines.all, ["voice-agent: live activity not started (limit)"])
  }

  /// Catches a line written when nothing ran, and a leftover tile the button does not take away.
  func testEndWithNothingRecordingWritesNoLineAndEndsTheLeftover() async {
    let rig = Rig()
    await rig.controller.settled()
    rig.system.leftovers = ["old-1"]
    await rig.controller.endFromLiveActivity()
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.system.calls, [.end("old-1")])
  }

  /// Main-actor turns until `condition` holds (the trial switch reaches the controller on the next turn).
  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<100 where !condition() {
      await Task.yield()
    }
    XCTAssertTrue(condition(), "condition not reached")
  }
}
