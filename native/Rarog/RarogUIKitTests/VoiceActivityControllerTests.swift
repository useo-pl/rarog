import Foundation
import RarogActivity
@testable import RarogCore
@testable import RarogUI
import XCTest

/// The voice Live Activity's controller (`VoiceActivityController`, an app file this target compiles itself through
/// `membershipExceptions`): while the app's microphone records, exactly one voice activity stands, requested once,
/// updated only when its kind, phase or subject changes (a new phase or subject keeps its timer), ended when nothing
/// records; the background rule learns whether that tile stands (refused, ended or removed: not shown); leftovers
/// end at launch; a refused request writes one line and is not repeated; the End button's handler ends what records
/// and writes its line; the Send
/// button's handler sends the dictation and leads the activity through "Sending…" to its outcome under a background
/// work. The microphone is a real `DictationCenter` with recording places of the test's own, ActivityKit and the
/// background work fakes. Owner: voice agent.
@MainActor
final class VoiceActivityControllerTests: XCTestCase {
  typealias State = VoiceActivityAttributes.ContentState

  /// A place that records, with the use the test sets; it reports a change to the center that claimed it. Its end
  /// clears the use when `endClears` (a conversation) and keeps it otherwise (a dictation that finishes its text).
  /// Its Send gives `send`'s task (`nil` = nothing to send) and writes `send` to the journal.
  @MainActor
  private final class Place: DictationHost {
    var microphoneUse: MicrophoneUse?
    var endClears = true
    var send: SendGate?
    var journal: Journal?
    private(set) var ends = 0
    private(set) var presses = 0
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

    func sendFromLockScreen() -> Task<LockScreenSend, Never>? {
      presses += 1
      journal?.all.append("send")
      return send?.task
    }
  }

  /// The task of a send whose result the test gives.
  @MainActor
  private final class SendGate {
    private var result: LockScreenSend?
    private var waiter: CheckedContinuation<LockScreenSend, Never>?
    private(set) lazy var task = Task { @MainActor in await self.value() }

    func give(_ result: LockScreenSend) {
      self.result = result
      waiter?.resume(returning: result)
      waiter = nil
    }

    private func value() async -> LockScreenSend {
      if let result { return result }
      return await withCheckedContinuation { waiter = $0 }
    }
  }

  /// What happened, in order, across the fakes.
  @MainActor
  private final class Journal {
    var all: [String] = []
  }

  /// The background work: begins and ends in the journal, an optional refusal, and the system's expiry by token.
  @MainActor
  private final class FakeWork {
    var refuse = false
    /// The system takes the time back inside `begin`, before the token returns.
    var expireWhileBeginning = false
    let journal: Journal
    private(set) var names: [String] = []
    private(set) var ended: [Int] = []
    private var expirations: [Int: @MainActor () -> Void] = [:]
    private var next = 0

    init(journal: Journal) {
      self.journal = journal
    }

    var work: VoiceActivityWork {
      VoiceActivityWork(
        // Weak: a send's task may end its work after the test.
        begin: { [weak self] name, expired in
          guard let self else { return nil }
          names.append(name)
          guard !refuse else { return nil }
          next += 1
          journal.all.append("begin \(next)")
          if expireWhileBeginning {
            expired()
          } else {
            expirations[next] = expired
          }
          return BackgroundWorkToken(raw: next)
        },
        end: { [weak self] token in
          guard let self, let token else { return }
          expirations[token.raw] = nil
          ended.append(token.raw)
          journal.all.append("end \(token.raw)")
        })
    }

    /// The system takes the time of work `raw` back.
    func expire(_ raw: Int) {
      let expired = expirations.removeValue(forKey: raw)
      expired?()
    }
  }

  /// ActivityKit's part: the calls in order, the ids it hands out and an optional refusal of every request.
  @MainActor
  private final class FakeActivities: VoiceActivitySystem {
    enum Call: Equatable {
      case request(State.Kind, State.Phase)
      case update(String, State.Kind, State.Phase)
      /// Ended at once with the content it showed.
      case end(String)
      /// Ended with a last content in this phase, left on the screen until the date.
      case endShowing(String, State.Phase, until: Date)
      /// Any other end: a policy or content the controller should not use.
      case endOther(String)
    }

    var leftovers: [String] = []
    var refusal: VoiceActivityRefusal?
    /// The most activities at once (`nil` = no limit): one more is refused with `limit`.
    var capacity: Int?
    /// Runs once inside the next `end`, while the controller waits for it.
    var duringEnd: (() -> Void)?
    var journal: Journal?
    private(set) var calls: [Call] = []
    /// The whole state of each request and update, in order.
    private(set) var states: [State] = []
    /// The stale date of each update, in order.
    private(set) var staleDates: [Date?] = []
    /// The last content of each end that carried one, in order.
    private(set) var finals: [State] = []
    private(set) var live: [String] = []
    private var issued = 0
    /// The controller's callback for an activity the system reports ended or dismissed (the last request's).
    private var gone: (@MainActor (String) -> Void)?

    func shownIds() -> [String] { leftovers + live }

    /// The person removes activity `id` from the Lock Screen: the system reports it gone.
    func remove(_ id: String) {
      live.removeAll { $0 == id }
      gone?(id)
    }

    func request(_ state: State, gone: @escaping @MainActor (String) -> Void) throws(VoiceActivityRefusal) -> String {
      self.gone = gone
      calls.append(.request(state.kind, state.phase))
      states.append(state)
      if let refusal { throw refusal }
      if let capacity, live.count >= capacity { throw .limit }
      issued += 1
      let id = "voice-\(issued)"
      live.append(id)
      return id
    }

    func update(_ id: String, to state: State, staleDate: Date?) async {
      calls.append(.update(id, state.kind, state.phase))
      states.append(state)
      staleDates.append(staleDate)
    }

    func end(_ id: String, final state: State?, dismissal: VoiceActivityDismissal) async {
      switch (state, dismissal) {
      case (nil, .immediate): calls.append(.end(id))
      case let (state?, .after(date)): calls.append(.endShowing(id, state.phase, until: date))
      default: calls.append(.endOther(id))
      }
      if let state { finals.append(state) }
      journal?.all.append("activity end \(id)")
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
    /// The background rule the controller tells whether the running recording's tile stands.
    let background = BackgroundRecording()
    let system = FakeActivities()
    let lines = Lines()
    let clock = Clock()
    let journal = Journal()
    let work: FakeWork
    let controller: VoiceActivityController

    init(leftovers: [String] = [], refusal: VoiceActivityRefusal? = nil) {
      system.leftovers = leftovers
      system.refusal = refusal
      system.journal = journal
      work = FakeWork(journal: journal)
      let lines = lines
      let clock = clock
      controller = VoiceActivityController(
        microphone: AppMicrophone(center: center), background: background, system: system, work: work.work,
        now: { clock.now }, trace: { lines.all.append($0) })
      controller.start()
    }

    /// A place claims the microphone and reports its use.
    @discardableResult
    func record(_ kind: MicrophoneUse.Kind?) -> Place {
      let place = Place(kind)
      place.journal = journal
      center.claim(place)
      return place
    }

    /// A dictation on its activity (`voice-1`) whose Send gives the gate's task, pressed on that activity: the
    /// activity shows "Sending…".
    func pressedSend() async -> (Place, SendGate) {
      let place = record(.dictation)
      place.endClears = false
      let gate = SendGate()
      place.send = gate
      await controller.sendFromLiveActivity(activityID: "voice-1")
      return (place, gate)
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

  /// Catches a tile that does not reach the background rule: without it the background would end a recording whose
  /// tile stands, or keep one whose tile is gone. A recording started in the foreground gets its tile with no setting.
  func testTileShownFollowsTheActivityOfTheRecording() async {
    let rig = Rig()
    XCTAssertFalse(rig.background.tileShown)
    let place = rig.record(.conversation)
    XCTAssertEqual(rig.system.calls, [.request(.conversation, .working)])
    XCTAssertTrue(rig.background.tileShown, "the tile stands")
    place.microphoneUse = nil
    place.report()
    XCTAssertFalse(rig.background.tileShown, "the recording ended, and its tile with it")
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.request(.conversation, .working), .end("voice-1")])
  }

  /// Catches a refused tile counted as shown: on a phone with Live Activities off, at a limit or after an error, the
  /// background must end the recording as it does without a tile.
  func testRefusedTileIsNotShown() async {
    for refusal in [VoiceActivityRefusal.disabled, .limit, .failed] {
      let rig = Rig(refusal: refusal)
      rig.record(.dictation)
      await rig.controller.settled()
      XCTAssertFalse(rig.background.tileShown, "\(refusal)")
      XCTAssertEqual(rig.lines.all, ["voice-agent: live activity not started (\(refusal.rawValue))"])
    }
  }

  /// Catches a tile the person removed from the Lock Screen that still counts as shown (the recording would go on
  /// unseen in the background), a new tile asked for during the same recording, and the removal of another activity
  /// that clears the current one.
  func testRemovedTileIsNoLongerShown() async {
    let rig = Rig()
    let place = rig.record(.dictation)
    XCTAssertTrue(rig.background.tileShown)
    rig.system.remove("old-9")
    XCTAssertTrue(rig.background.tileShown, "another activity's removal changes nothing")
    rig.system.remove("voice-1")
    XCTAssertFalse(rig.background.tileShown, "the removed tile no longer counts")
    place.report()
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating)], "no new tile for the same recording")
    place.microphoneUse = nil
    place.report()
    rig.record(.conversation)
    XCTAssertTrue(rig.background.tileShown, "the next recording gets its own")
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
    await rig.controller.endFromLiveActivity(activityID: "voice-1")
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
    await rig.controller.endFromLiveActivity(activityID: "voice-1")
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
    await rig.controller.endFromLiveActivity(activityID: "voice-1")
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
    await rig.controller.endFromLiveActivity(activityID: "old-1")
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.system.calls, [.end("old-1")])
  }

  // MARK: - Send from the activity

  /// Catches an activity that keeps the recording's last reports instead of "Sending…" (each hypothesis and the
  /// recording's end used to update it back or end it), a send without a stale date, and an activity that stays
  /// after the message arrived: the press shows "Sending…" with a stale date 30 s on, where its timer stops; the
  /// recording's reports and its end change nothing; `sent` and `queued` end it at once.
  func testSendShowsSendingAndEndsAtOnceWhenTheMessageArrives() async {
    for result in [LockScreenSend.sent, .queued] {
      let rig = Rig()
      let (place, gate) = await rig.pressedSend()
      XCTAssertEqual(place.presses, 1)
      place.microphoneUse?.subject = .allSessions
      place.report()
      place.microphoneUse = nil
      place.report()
      await rig.controller.settled()
      XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating), .update("voice-1", .dictation, .sending)])
      let stale = Date(timeIntervalSince1970: 1030)
      XCTAssertEqual(rig.system.staleDates, [stale])
      XCTAssertEqual(rig.system.states.last?.stoppedAt, stale, "the timer stops when the activity turns stale")
      XCTAssertEqual(rig.system.states.last?.startedAt, Date(timeIntervalSince1970: 1000), "the recording's timer")
      gate.give(result)
      await waitUntil { rig.work.ended == [1] }
      XCTAssertEqual(rig.system.calls.last, .end("voice-1"), "\(result)")
      XCTAssertEqual(rig.lines.all, [], "\(result): the microphone writes the result line")
    }
  }

  /// Catches a failed send whose activity vanishes (the user would think the message went) or keeps a running timer:
  /// `notSent` and `unconfirmed` end the activity with their phase, a timer stopped at the outcome, and a stay of
  /// 5 minutes on the Lock Screen.
  func testFailedSendLeavesItsOutcomeForFiveMinutes() async {
    for (result, phase) in [(LockScreenSend.notSent, State.Phase.notSent), (.unconfirmed, .unconfirmed)] {
      let rig = Rig()
      let (place, gate) = await rig.pressedSend()
      place.microphoneUse = nil
      place.report()
      rig.clock.now += 4
      gate.give(result)
      await waitUntil { rig.work.ended == [1] }
      let outcome = Date(timeIntervalSince1970: 1004)
      XCTAssertEqual(rig.system.calls.last, .endShowing("voice-1", phase, until: outcome + 300), "\(result)")
      XCTAssertEqual(rig.system.finals.last?.stoppedAt, outcome, "\(result): the timer stops at the outcome")
      XCTAssertEqual(rig.system.finals.last?.startedAt, Date(timeIntervalSince1970: 1000))
      XCTAssertEqual(rig.system.finals.last?.project, nil, "\(result): only the subject the state had")
    }
  }

  /// Catches a failed send's activity that stays over the app or over the next recording's activity: the app in
  /// the foreground takes it off; a new recording takes it off before it asks for its own activity, which it gets.
  func testForegroundAndNewRecordingTakeTheFailedSendOff() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    place.microphoneUse = nil
    place.report()
    gate.give(.notSent)
    await waitUntil { rig.work.ended == [1] }
    rig.controller.scene(.background)
    rig.controller.scene(.inactive)
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls.last, .endShowing("voice-1", .notSent, until: Date(timeIntervalSince1970: 1300)))
    rig.controller.scene(.active)
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls.last, .end("voice-1"), "the foreground takes it off")

    let next = Rig()
    let (first, failed) = await next.pressedSend()
    first.microphoneUse = nil
    first.report()
    failed.give(.unconfirmed)
    await waitUntil { next.work.ended == [1] }
    let second = next.record(.dictation)
    await waitUntil { next.system.live.contains("voice-2") }
    XCTAssertEqual(Array(next.system.calls.suffix(3)), [
      .endShowing("voice-1", .unconfirmed, until: Date(timeIntervalSince1970: 1300)), .end("voice-1"),
      .request(.dictation, .dictating),
    ])
    XCTAssertEqual(next.system.states.last?.phase, .dictating)
    XCTAssertNotNil(second.microphoneUse)
  }

  /// Catches a send that leaves "Sending…" up when the system took the background time back, and one that leaves
  /// "Not confirmed" up although the message arrived after all: the expiry ends the activity as not confirmed with
  /// its line, and a later `sent` takes it off.
  func testExpiredWorkEndsAsNotConfirmedAndALateSentTakesItOff() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    place.microphoneUse = nil
    place.report()
    rig.clock.now += 25
    rig.work.expire(1)
    await rig.controller.settled()
    XCTAssertEqual(rig.lines.all, ["dictation: live activity send expired"])
    let expiredAt = Date(timeIntervalSince1970: 1025)
    XCTAssertEqual(rig.system.calls.last, .endShowing("voice-1", .unconfirmed, until: expiredAt + 300))
    XCTAssertEqual(rig.system.finals.last?.stoppedAt, expiredAt)
    gate.give(.sent)
    await waitUntil { rig.system.calls.last == .end("voice-1") }
    XCTAssertEqual(rig.lines.all, ["dictation: live activity send expired"], "no second line")
  }

  /// Catches a failed send's activity that stays over the app for five minutes when the app came to the foreground
  /// before the outcome: the outcome then ends the activity at once.
  func testFailureWithTheAppInTheForegroundEndsTheActivityAtOnce() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    rig.controller.scene(.background)
    place.microphoneUse = nil
    place.report()
    rig.controller.scene(.inactive)
    rig.controller.scene(.active)
    gate.give(.notSent)
    await waitUntil { rig.work.ended == [1] }
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls.last, .end("voice-1"))
    XCTAssertFalse(rig.system.calls.contains { if case .endShowing = $0 { true } else { false } })
  }

  /// Catches an expiry that the system reports inside `begin`, before the send is set up: the activity would say
  /// "Sending…" with no expiry line. It shows the send, then ends as not confirmed with its line.
  func testExpiryReportedWhileTheWorkBeginsEndsAsNotConfirmed() async {
    let rig = Rig()
    rig.work.expireWhileBeginning = true
    let (place, gate) = await rig.pressedSend()
    XCTAssertEqual(rig.lines.all, ["dictation: live activity send expired"])
    XCTAssertEqual(Array(rig.system.calls.suffix(2)), [
      .update("voice-1", .dictation, .sending),
      .endShowing("voice-1", .unconfirmed, until: Date(timeIntervalSince1970: 1300)),
    ])
    place.microphoneUse = nil
    place.report()
    gate.give(.sent)
    await waitUntil { rig.system.calls.last == .end("voice-1") }
    XCTAssertEqual(rig.lines.all, ["dictation: live activity send expired"], "no second line")
  }

  /// Catches a send that the refused background time stops: it runs anyway, and one line says the time was refused.
  func testRefusedBackgroundWorkStillSends() async {
    let rig = Rig()
    rig.work.refuse = true
    let (place, gate) = await rig.pressedSend()
    XCTAssertEqual(place.presses, 1)
    XCTAssertEqual(rig.lines.all, ["dictation: live activity send no background time"])
    XCTAssertEqual(rig.system.calls.last, .update("voice-1", .dictation, .sending))
    gate.give(.sent)
    await waitUntil { rig.system.calls.last == .end("voice-1") }
  }

  /// Catches a press that acts on a recording started since: Send or Stop on an activity that is not the current
  /// one, or Send on a conversation, ends and sends nothing and writes no line (Stop on an old activity takes only
  /// that one off).
  func testPressOnAnotherActivityChangesNothing() async {
    let rig = Rig()
    let place = rig.record(.dictation)
    place.send = SendGate()
    await rig.controller.sendFromLiveActivity(activityID: "old-1")
    await rig.controller.sendFromLiveActivity(activityID: nil)
    await rig.controller.endFromLiveActivity(activityID: "old-1")
    XCTAssertEqual(place.presses, 0)
    XCTAssertEqual(place.ends, 0)
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating), .end("old-1")])
    XCTAssertEqual(rig.work.names, [])
    place.microphoneUse = nil
    place.report()
    let conversation = rig.record(.conversation)
    await rig.controller.sendFromLiveActivity(activityID: "voice-2")
    XCTAssertEqual(conversation.ends, 0)
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.work.names, [], "no background work for nothing to send")
  }

  /// Catches a dictation whose Send gives nothing (a Send on the screen already waits) that still holds a background
  /// work or changes the activity.
  func testSendWithNothingToSendChangesNothing() async {
    let rig = Rig()
    let place = rig.record(.dictation)
    await rig.controller.sendFromLiveActivity(activityID: "voice-1")
    XCTAssertEqual(place.presses, 1)
    XCTAssertEqual(rig.work.ended, [1], "the work of the press ends")
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating)])
  }

  /// Catches a process the system may stop before the outcome is on the Lock Screen: the background work starts
  /// before the microphone hears of the press, and ends only after the outcome came and the activity's end ran.
  func testWorkHoldsFromThePressUntilTheOutcomeIsShown() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    place.microphoneUse = nil
    place.report()
    gate.give(.notSent)
    await waitUntil { rig.work.ended == [1] }
    XCTAssertEqual(rig.work.names, ["dictation send"])
    XCTAssertEqual(rig.journal.all, ["begin 1", "send", "activity end voice-1", "end 1"])
  }

  /// Catches a Stop that ends the activity of a send on its way (the dictation is already over, and the activity
  /// would no longer show the outcome), and a second Send that starts a second operation: both are ignored.
  func testStopAndSecondSendDuringTheSendAreIgnored() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    await rig.controller.endFromLiveActivity(activityID: "voice-1")
    await rig.controller.sendFromLiveActivity(activityID: "voice-1")
    XCTAssertEqual(place.ends, 0)
    XCTAssertEqual(place.presses, 1)
    XCTAssertEqual(rig.work.names, ["dictation send"])
    XCTAssertEqual(rig.lines.all, [])
    XCTAssertEqual(rig.system.calls, [.request(.dictation, .dictating), .update("voice-1", .dictation, .sending)])
    gate.give(.sent)
    await waitUntil { rig.system.calls.last == .end("voice-1") }
  }

  /// Catches the outcome of an earlier send that ends or changes the activity of a recording started while it ran:
  /// the new recording takes the microphone, the sending activity goes, the new one comes, and the old outcome
  /// leaves it alone; the new recording's own Send still works.
  func testNewRecordingDuringTheSendKeepsItsActivity() async {
    let rig = Rig()
    let (place, gate) = await rig.pressedSend()
    place.microphoneUse = nil
    place.report()
    // A host claims the microphone before it opens it: no use until then.
    let next = rig.record(nil)
    next.microphoneUse = MicrophoneUse(
      kind: .dictation, audio: true, openAI: false, soniox: false, phase: .dictating,
      subject: .session(project: nil, name: nil))
    next.report()
    await waitUntil { rig.system.live.contains("voice-2") }
    gate.give(.notSent)
    await waitUntil { rig.work.ended == [1] }
    await rig.controller.settled()
    XCTAssertEqual(rig.system.calls, [
      .request(.dictation, .dictating), .update("voice-1", .dictation, .sending), .end("voice-1"),
      .request(.dictation, .dictating),
    ])
    XCTAssertEqual(rig.system.live, ["voice-2"])
    let second = SendGate()
    next.send = second
    await rig.controller.sendFromLiveActivity(activityID: "voice-2")
    XCTAssertEqual(rig.system.calls.last, .update("voice-2", .dictation, .sending))
    second.give(.sent)
    await waitUntil { rig.system.calls.last == .end("voice-2") }
  }

  /// Catches a store that drops the expiry of the background work it starts (a protocol method dispatched to its
  /// default, which never reports one): the send would then never learn that its time ran out.
  func testStoreBackgroundWorkReportsTheSystemExpiry() {
    let system = FakeBackgroundSystem()
    let store = RarogStore(
      transport: UIKitTransport(), rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.pushRuntime.background = UIKitBackgroundWork(system: system.system)
    let lines = Lines()
    let token = store.beginBackgroundWork("dictation send", needsServer: true) { lines.all.append("expired") }
    XCTAssertNotNil(token)
    system.expire(1)
    XCTAssertEqual(lines.all, ["expired"])
  }

  /// Main-actor turns until `condition` holds (the system's calls run on later turns).
  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<100 where !condition() {
      await Task.yield()
    }
    XCTAssertTrue(condition(), "condition not reached")
  }
}
