import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The locked-phone monitor (`LockedPhoneMonitor`): the server connection hold, the heartbeat and the `client.log`
// lines around what records on the app's microphone, on a manual clock, a fake microphone use and a fake server
// probe. Owner: voice agent.

private let conversation = MicrophoneUse(
  kind: .conversation, audio: true, openAI: true, soniox: false, phase: .listening, subject: .allSessions)
private let dictation = MicrophoneUse(
  kind: .dictation, audio: false, openAI: false, soniox: true, phase: .dictating,
  subject: .session(project: nil, name: nil))

/// The app's microphone as the monitor sees it: what records, and the observers of each change.
@MainActor
private final class MicrophoneUseBox {
  private(set) var use: MicrophoneUse?
  var observers: [@MainActor () -> Void] = []

  func set(_ use: MicrophoneUse?) {
    self.use = use
    for observer in observers { observer() }
  }
}

/// The server probe: answers at once, or holds every question until `answer(_:)`.
@MainActor
private final class ServerProbe {
  private(set) var calls = 0
  var holds = false
  var reply = true
  private var waiting: [CheckedContinuation<Bool, Never>] = []

  func ask() async -> Bool {
    calls += 1
    guard holds else { return reply }
    return await withCheckedContinuation { waiting.append($0) }
  }

  func answer(_ value: Bool) {
    let held = waiting
    waiting = []
    for continuation in held { continuation.resume(returning: value) }
  }
}

@MainActor
private final class MonitorHarness {
  let clock = ManualScheduler()
  let trial = LockedPhoneTrial.memory()
  let microphone = MicrophoneUseBox()
  let probe = ServerProbe()
  var holds: [Bool] = []
  var lines: [String] = []
  private(set) var monitor: LockedPhoneMonitor!

  init(trialOn: Bool = true) {
    trial.set(trialOn)
    monitor = LockedPhoneMonitor(
      LockedPhoneMonitor.Parts(
        trial: trial, use: { [microphone] in microphone.use }, scheduler: clock,
        holdServer: { [weak self] in self?.holds.append($0) },
        serverAnswers: { [probe] in await probe.ask() },
        trace: { [weak self] in self?.lines.append($0) }))
    // As the app's factory does with the dictation center.
    microphone.observers.append { [weak monitor] in monitor?.evaluate() }
  }

  /// Locks the phone: the scene goes through `inactive` to `background`.
  func lock() {
    monitor.scene(.inactive)
    monitor.scene(.background)
  }

  func unlock() {
    monitor.scene(.inactive)
    monitor.scene(.active)
  }

  func elapse(_ seconds: TimeInterval) async {
    clock.advance(seconds)
    await dictationSettle()
  }

  var heartbeats: [String] { lines.filter { $0.contains(" s: ") } }
}

@MainActor
@Suite("locked-phone monitor")
struct LockedPhoneMonitorTests {
  // Catches a heartbeat line with the wrong prefix for what records, a field word other than the documented ones, or
  // seconds counted from something other than leaving the foreground (the `inactive` step of a lock included).
  @Test(
    "a heartbeat line every 30 s in the background says what lives, with the prefix of what records",
    arguments: [
      (conversation, true, "voice-agent: background 30 s: audio=running openai=open soniox=closed server=online"),
      (dictation, false, "dictation: background 30 s: audio=stopped openai=closed soniox=open server=offline"),
    ])
  func heartbeatLine(use: MicrophoneUse, reply: Bool, line: String) async {
    let harness = MonitorHarness()
    harness.probe.reply = reply
    harness.microphone.set(use)
    harness.monitor.scene(.inactive)
    await harness.elapse(5)
    harness.monitor.scene(.background)
    await harness.elapse(29)
    #expect(harness.heartbeats.isEmpty, "no line before 30 s")
    await harness.elapse(1)
    #expect(harness.heartbeats == [line])
    await harness.elapse(30)
    #expect(harness.heartbeats.count == 2 && harness.heartbeats.last?.contains(" background 60 s: ") == true)
    #expect(harness.probe.calls == 2, "one server question per heartbeat")
  }

  // Catches a heartbeat that stacks a second server question on one still out, or writes nothing while it waits.
  // The seconds of a line are those of the moment it is written, so the late answer carries the later count.
  @Test("a heartbeat while the previous question is out says server=waiting and asks nothing more")
  func waiting() async {
    let harness = MonitorHarness()
    harness.probe.holds = true
    harness.microphone.set(conversation)
    harness.lock()
    await harness.elapse(30)
    #expect(harness.probe.calls == 1 && harness.heartbeats.isEmpty, "the first question is out")
    await harness.elapse(30)
    #expect(harness.probe.calls == 1, "no second question while the first is out")
    #expect(
      harness.heartbeats == ["voice-agent: background 60 s: audio=running openai=open soniox=closed server=waiting"])
    harness.probe.answer(true)
    await dictationSettle()
    #expect(
      harness.heartbeats.last == "voice-agent: background 60 s: audio=running openai=open soniox=closed server=online")
    await harness.elapse(30)
    #expect(harness.probe.calls == 2, "after the answer the next heartbeat asks again")
  }

  // Catches a late answer that writes a heartbeat line after the recording ended or the app came back: the line would
  // claim something lives in the background when nothing does.
  @Test("an answer that comes after the recording ended or after the app came back writes no line")
  func recheckAfterAnswer() async {
    let ended = MonitorHarness()
    ended.probe.holds = true
    ended.microphone.set(dictation)
    ended.lock()
    await ended.elapse(30)
    ended.microphone.set(nil)
    ended.probe.answer(true)
    await dictationSettle()
    #expect(ended.heartbeats.isEmpty, "the recording ended while the question was out")

    let returned = MonitorHarness()
    returned.probe.holds = true
    returned.microphone.set(conversation)
    returned.lock()
    await returned.elapse(30)
    returned.unlock()
    returned.probe.answer(true)
    await dictationSettle()
    #expect(returned.heartbeats.isEmpty, "the app came back while the question was out")

    let relocked = MonitorHarness()
    relocked.probe.holds = true
    relocked.microphone.set(conversation)
    relocked.lock()
    await relocked.elapse(30)
    relocked.unlock()
    relocked.lock()
    relocked.probe.answer(true)
    await dictationSettle()
    #expect(relocked.heartbeats.isEmpty, "a question from an earlier background stay writes nothing in a new one")
  }

  // Catches a hold that outlives what it was taken for: the tunnel would keep the server connection of a locked
  // phone open after the conversation or dictation ended, or after the user switched the trial off.
  @Test("the hold is taken while something runs and released when it ends, also when its host goes away")
  func holdFollowsTheRecording() async {
    let harness = MonitorHarness()
    harness.microphone.set(conversation)
    #expect(harness.holds == [true], "taken in the foreground already")
    harness.lock()
    await harness.elapse(30)
    harness.microphone.set(nil)
    #expect(harness.holds == [true, false], "the recording ended in the background")
    let probes = harness.probe.calls
    await harness.elapse(120)
    #expect(harness.probe.calls == probes && harness.heartbeats.count == 1, "the heartbeat stopped with it")

    // A host that is deallocated leaves the center without a host: its use reads `nil` at the change.
    let gone = MonitorHarness()
    gone.microphone.set(dictation)
    gone.microphone.set(nil)
    #expect(gone.holds == [true, false])
  }

  // Catches a switch turned off that leaves the server connection held and the heartbeat writing.
  @Test("the trial switched off while held releases the hold at the next heartbeat or change, and the heartbeat stops")
  func trialSwitchedOff() async {
    let background = MonitorHarness()
    background.microphone.set(conversation)
    background.lock()
    background.trial.set(false)
    await background.elapse(30)
    #expect(background.holds == [true, false])
    #expect(background.heartbeats.isEmpty && background.probe.calls == 0)
    await background.elapse(90)
    #expect(background.heartbeats.isEmpty && background.probe.calls == 0)

    let foreground = MonitorHarness()
    foreground.microphone.set(conversation)
    foreground.trial.set(false)
    foreground.lock()
    #expect(foreground.holds == [true, false], "released at the scene change")
    #expect(foreground.lines == ["voice-agent: background, trial off"])
  }

  // Catches a monitor that releases a running hold when the app comes back (a second lock would start without it) or
  // keeps one after the recording ended while the app was away.
  @Test("back in the foreground the hold stays while something runs")
  func foregroundKeepsTheHold() async {
    let harness = MonitorHarness()
    harness.microphone.set(conversation)
    harness.lock()
    harness.unlock()
    #expect(harness.holds == [true])
    harness.microphone.set(nil)
    #expect(harness.holds == [true, false])
  }

  // Catches lines, holds or server questions with nothing recording: the monitor would measure and hold the
  // connection for every lock of the phone.
  @Test("with nothing recording: no line, no hold, no server question", arguments: [true, false])
  func nothingRuns(trialOn: Bool) async {
    let harness = MonitorHarness(trialOn: trialOn)
    harness.lock()
    await harness.elapse(120)
    harness.unlock()
    harness.monitor.evaluate()
    #expect(harness.lines.isEmpty && harness.holds.isEmpty && harness.probe.calls == 0)
  }

  // Catches scene lines that miss the trial's state, a line at the `inactive` step of a lock, and a trial off that
  // still holds the connection or writes heartbeats.
  @Test("scene lines say the trial's state; with the trial off only the scene lines", arguments: [true, false])
  func sceneLines(trialOn: Bool) async {
    let harness = MonitorHarness(trialOn: trialOn)
    harness.microphone.set(dictation)
    harness.lock()
    await harness.elapse(90)
    harness.unlock()
    let state = trialOn ? "on" : "off"
    let scenes = harness.lines.filter { !$0.contains(" s: ") }
    #expect(scenes == ["dictation: background, trial \(state)", "dictation: foreground, trial \(state)"])
    if trialOn {
      #expect(harness.holds == [true] && harness.heartbeats.count == 3)
    } else {
      #expect(harness.holds.isEmpty && harness.heartbeats.isEmpty && harness.probe.calls == 0)
    }
  }

  // Catches a hold that flaps on every change, scene step or repeat evaluation: each release and take would reach
  // the tunnel and could cut the connection short in the background.
  @Test("a repeat evaluation, scene step or change with the same answer does not touch the hold")
  func repeatDoesNotFlap() async {
    let harness = MonitorHarness()
    harness.microphone.set(conversation)
    harness.monitor.evaluate()
    harness.monitor.evaluate()
    harness.microphone.set(conversation)
    harness.lock()
    harness.monitor.scene(.background)
    await harness.elapse(20)
    harness.monitor.evaluate()
    harness.microphone.set(conversation)
    await harness.elapse(10)
    #expect(harness.heartbeats.count == 1, "a repeat evaluation does not restart the heartbeat's 30 s")
    await harness.elapse(30)
    #expect(harness.holds == [true])
    #expect(harness.lines.filter { !$0.contains(" s: ") } == ["voice-agent: background, trial on"])
  }
}
