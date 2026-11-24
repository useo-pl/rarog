import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The app's one microphone as an observer outside the app's screens reads it (`DictationCenter`): every claim and
// every change a host reports reaches all observers, the use is read from the host that holds the microphone, and
// the end from outside the screens ends only what runs. Fakes: a recording place of the test's own, and a voice
// conversation at a session on `VoiceAgentFakeDevice` with the route to Rarog `FakeVoiceAgentBackend`. All session
// data is synthetic. Owner: dictation.

/// A place that records, with the use the test sets; it reports a change to the center that claimed it.
@MainActor
private final class Place: DictationHost {
  var microphoneUse: MicrophoneUse?
  private(set) var handedOff = 0
  private(set) var ends = 0
  private weak var center: DictationCenter?

  func handOff() { handedOff += 1 }
  func endFromLockScreen() { ends += 1 }
  func claimed(by center: DictationCenter) { self.center = center }
  func report() { center?.changed(self) }
}

/// Calls of one observer; the observer captures only this box, never the test's hosts.
@MainActor
final class Calls {
  var count = 0
}

/// What a host reports while a prompt waits or text stands in a field: its phase and exactly the subject it may name,
/// and none of `hidden` (a prompt, dictated text) anywhere in the use, which reaches the Lock Screen. The one check of
/// every host that names a subject.
@MainActor
func expectNamesOnly(
  _ use: MicrophoneUse?, _ subject: MicrophoneSubject, phase: MicrophonePhase, hiding hidden: [String],
  sourceLocation: SourceLocation = #_sourceLocation
) {
  #expect(use?.subject == subject, sourceLocation: sourceLocation)
  #expect(use?.phase == phase, sourceLocation: sourceLocation)
  let dump = String(reflecting: use)
  for text in hidden {
    #expect(!dump.contains(text), "\(text) in \(dump)", sourceLocation: sourceLocation)
  }
}

/// A voice conversation at session `id-a` on its own device, claimed by a microphone center of its own.
@MainActor
private final class Conversation {
  let backend = FakeVoiceAgentBackend()
  let device = VoiceAgentFakeDevice()
  let center = DictationCenter()
  private(set) var voice: VoiceAgentSession!

  init() {
    backend.state = appState([session("id-a", project: "atlas", label: "demo")])
    let host = VoiceAgentSessionHost(sessionId: "id-a", backend: backend)
    host.watchInput = { [unowned self] in
      VoiceAgentWatch.Input(
        state: self.backend.state, sessionId: "id-a", login: self.backend.loginEpoch, enabled: true,
        sonioxAllowed: true, selected: "id-a", background: false)
    }
    voice = VoiceAgentSession(host: host, backend: backend, dependencies: { [unowned self] in
      self.device.dependencies($0)
    })
  }

  /// The microphone first, then the start, as the session screen starts it.
  func start() {
    center.claim(voice)
    voice.start()
  }

  func ready() async {
    start()
    await device.ready(voice)
  }
}

@MainActor
@Suite("the app's one microphone: observers, the use of the host that holds it, the end from outside the screens")
struct DictationCenterTests {
  // Catches an observer list that keeps only the last observer, or a claim or a host's change that reaches no one.
  @Test("every observer learns each claim and each change the host that holds the microphone reports")
  func everyObserverLearns() {
    let center = DictationCenter()
    let first = Calls()
    let second = Calls()
    center.observe { [first] in first.count += 1 }
    center.observe { [second] in second.count += 1 }
    let place = Place()
    center.claim(place)
    #expect(first.count == 1 && second.count == 1)
    place.report()
    #expect(first.count == 2 && second.count == 2)
  }

  // Catches a late change of a host the microphone already left (a recording that ends after a conversation took
  // over) reaching the observers as if it were the running one.
  @Test("a change from a host that no longer holds the microphone tells no one; the holder's change does")
  func changeFromFormerHost() {
    let center = DictationCenter()
    let calls = Calls()
    center.observe { [calls] in calls.count += 1 }
    let former = Place()
    let holder = Place()
    center.claim(former)
    center.claim(holder)
    #expect(former.handedOff == 1)
    let afterClaims = calls.count
    former.report()
    #expect(calls.count == afterClaims)
    holder.report()
    #expect(calls.count == afterClaims + 1)
  }

  // Catches a use read from a host the microphone left, or a use that outlives its host.
  @Test("the use is the holder's own: nil with no holder, the new holder's after a claim, nil once it is gone")
  func useOfTheHolder() {
    let center = DictationCenter()
    #expect(center.use == nil)
    let recording = MicrophoneUse(
      kind: .dictation, audio: true, openAI: false, soniox: true, phase: .dictating,
      subject: .session(project: "atlas", name: "demo"))
    let former = Place()
    former.microphoneUse = recording
    center.claim(former)
    #expect(center.use == recording)
    var holder: Place? = Place()
    if let holder { center.claim(holder) }
    #expect(center.use == nil, "the new holder reports none, whatever the former one says")
    holder?.microphoneUse = recording
    #expect(center.use == recording)
    holder = nil
    #expect(center.use == nil, "a holder that is gone reports nothing")
  }

  // Catches a conversation reported while it still connects (the observer would show a microphone that may never
  // open), a ready one never reported, its heartbeat parts read wrong, a session named by anything but its project
  // and name, and a mute the observers never learn (the Live Activity would keep saying it listens).
  @Test("a conversation reports no use while its start prepares, then its use once ready: live parts, phase, session")
  func conversationUse() async throws {
    let rig = Conversation()
    let calls = Calls()
    rig.center.observe { [calls] in calls.count += 1 }
    rig.start()
    #expect(rig.voice.isActive && !rig.voice.isReady)
    #expect(rig.center.use == nil)
    let beforeReady = calls.count
    await rig.device.ready(rig.voice)
    #expect(calls.count > beforeReady, "readiness reaches the observers")
    #expect(
      rig.center.use
        == MicrophoneUse(
          kind: .conversation, audio: false, openAI: true, soniox: true, phase: .listening,
          subject: .session(project: "atlas", name: "demo")))
    try rig.device.input(milliseconds: 20)
    #expect(rig.center.use?.audio == true)
    rig.device.scheduler.advance(MicrophoneUse.frameWindow)
    #expect(rig.center.use?.audio == false, "no frame within the window")
    let beforeMute = calls.count
    rig.voice.toggleMute()
    #expect(calls.count > beforeMute && rig.center.use?.phase == .muted, "the mute reaches the observers")
    try rig.device.input(milliseconds: 20)
    #expect(rig.center.use?.audio == true, "a muted microphone still runs")
  }

  // Catches a phase that changes with the seconds of a session check or with the speech flag of listening (each
  // change would update the Live Activity for nothing), a waiting prompt hidden while the conversation listens, and
  // a prompt shown over an answer still read aloud or over a muted microphone.
  @Test("a conversation's phase from its status, with and without a waiting prompt")
  func conversationPhase() {
    let table: [(VoiceAgentIndicator?, MicrophonePhase, MicrophonePhase)] = [
      (.connecting, .working, .working), (.thinking, .working, .working), (nil, .working, .working),
      (.listening, .listening, .prompt), (.hearing, .listening, .prompt), (.sent, .listening, .prompt),
      (.promptInField, .prompt, .prompt), (.answering, .answering, .answering),
      (.checkingSession(seconds: 1), .reading, .reading), (.checkingSession(seconds: 2), .reading, .reading),
      (.muted, .muted, .muted), (.closed(.background), .working, .working),
    ]
    for (indicator, alone, waiting) in table {
      #expect(MicrophonePhase.conversation(indicator, promptWaits: false) == alone, "\(String(describing: indicator))")
      #expect(MicrophonePhase.conversation(indicator, promptWaits: true) == waiting, "\(String(describing: indicator))")
    }
  }

  // Catches a tile that asks for a spoken yes or no, or says it listens, while the muted microphone drops speech:
  // the status row keeps "prompt in the field" and "sent" over a mute.
  @Test("a muted conversation is muted wherever it would listen, with or without a waiting prompt")
  func mutedConversationPhase() {
    let listens: [VoiceAgentIndicator] = [.listening, .hearing, .sent, .promptInField, .muted]
    for indicator in listens {
      for promptWaits in [false, true] {
        #expect(
          MicrophonePhase.conversation(indicator, promptWaits: promptWaits, muted: true) == .muted, "\(indicator)")
      }
    }
    #expect(MicrophonePhase.conversation(.answering, promptWaits: true, muted: true) == .answering)
    #expect(MicrophonePhase.conversation(.checkingSession(seconds: 1), promptWaits: false, muted: true) == .reading)
  }

  // Catches a session renamed during the conversation that keeps its old name on the tile until the status changes,
  // and a report at every app state change that changes no name.
  @Test("a session's new name reaches the observers at the next app state change, an unchanged one tells nothing")
  func renamedSessionReachesObservers() async throws {
    let rig = Conversation()
    let calls = Calls()
    rig.start()
    await rig.device.ready(rig.voice)
    rig.voice.observe()
    rig.center.observe { [calls] in calls.count += 1 }
    rig.voice.observe()
    #expect(calls.count == 0, "the same name tells nothing")
    rig.backend.state = appState([session("id-a", project: "atlas", label: "renamed")])
    rig.voice.observe()
    #expect(calls.count == 1)
    #expect(rig.center.use?.subject == .session(project: "atlas", name: "renamed"))
  }

  // Catches a session named by something else than the list's project and label, or an empty name kept as text
  // (the tile would show a stray dot).
  @Test("a session is named by its project and label, each left out when empty; no session names nothing")
  func subjectOfSession() {
    let named = MicrophoneSubject.of(session("a", project: "atlas", label: "demo"))
    #expect(named == .session(project: "atlas", name: "demo"))
    let unnamed = MicrophoneSubject.of(session("a", project: "atlas", label: "  "))
    #expect(unnamed == .session(project: "atlas", name: nil))
    #expect(MicrophoneSubject.of(nil) == .session(project: nil, name: nil))
  }

  // Catches a session name that carries a key shape reaching the Lock Screen as it is.
  @Test("a secret shape in a session's name is masked before the session is named")
  func subjectMasksSecrets() {
    let key = "sk-" + String(repeating: "a", count: 24)
    let subject = MicrophoneSubject.of(session("a", project: "atlas", label: "deploy with \(key)"))
    #expect(subject == .session(project: "atlas", name: "deploy with \(RealtimeSecretMask.mask)"))
  }

  // Catches an end from outside the screens that leaves the conversation running, ends it without saying so in its
  // end line, or puts the conversation's content into a line.
  @Test("the end from outside the screens ends a ready conversation, says live-activity, and returns its kind")
  func endsReadyConversation() async throws {
    let rig = Conversation()
    await rig.ready()
    rig.device.utterance("in-r1")
    rig.device.socket.reply(RealtimeSample.created("r1"))
    rig.device.say("r1", item: "m-r1", pcm: Data(count: 9600))
    rig.device.socket.reply(RealtimeSample.done("r1"))
    #expect(rig.device.streamOf["m-r1"] != nil, "the answer went to speech")
    let calls = Calls()
    rig.center.observe { [calls] in calls.count += 1 }
    #expect(rig.center.endFromLockScreen() == .conversation)
    #expect(!rig.voice.isActive && rig.device.socket.closed && rig.device.audio.stops >= 1)
    #expect(rig.center.use == nil && calls.count > 0)
    let end = try #require(rig.backend.traces.last { $0.hasPrefix("voice-agent: ended") })
    #expect(end.hasPrefix("voice-agent: ended closed (live-activity) after "), "\(end)")
    #expect(rig.voice.indicator == nil, "no end sentence, as after the end button")
    #expect(!rig.backend.traces.contains { $0.contains("Spoken answer") }, "the answer's text stays out of the lines")
  }

  // Catches an end from outside the screens that cuts a start the user just made, or calls a host that reports no
  // use (a project note's recording, a start that prepares).
  @Test("with nothing running the end from outside the screens returns nil and ends nothing")
  func endsNothingWithoutUse() {
    let empty = DictationCenter()
    #expect(empty.endFromLockScreen() == nil)

    let center = DictationCenter()
    let place = Place()
    center.claim(place)
    #expect(center.endFromLockScreen() == nil)
    #expect(place.ends == 0)

    let rig = Conversation()
    rig.start()
    #expect(rig.center.endFromLockScreen() == nil)
    #expect(rig.voice.phase == .connecting)
    #expect(!rig.backend.traces.contains { $0.hasPrefix("voice-agent: ended") })
  }
}
