import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The owner of the voice conversation across sessions (`VoiceAgentSessionsConversation`): the entry rule of the list
// button with the mode's own consent, one host per start prepared before the conversation, the ends with their
// sentences and the host told of each, one microphone with the conversation at a session and with dictation. Fakes:
// the route to Rarog `FakeVoiceAgentBackend`, `VoiceAgentFakeDevice` and the samples of
// `VoiceAgentSessionsHostTests.swift`, a microphone center of its own per test. All session data is synthetic.
// Owner: voice agent.

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<1000 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return condition()
}

/// Dictation as the microphone center sees it: a place that records takes the microphone.
@MainActor
private final class Dictation: DictationHost {
  private(set) var handedOff = false
  func handOff() { handedOff = true }
}

/// Calls of a microphone center's observer; the observer captures only this box.
@MainActor
private final class Told {
  var count = 0
}

/// An owner over the fakes: two sessions in the catalog, with `voiceAgent` the voice agent's consent given and,
/// with `consented`, the mode's consent too.
@MainActor
private final class Rig {
  let backend = FakeVoiceAgentBackend()
  let settings = VoiceAgentSettings.memory()
  let center = DictationCenter()
  let device = VoiceAgentFakeDevice()
  private(set) var owner: VoiceAgentSessionsConversation!

  init(consented: Bool = true, sessionsMode: Bool = true, voiceAgent: Bool = true) {
    backend.state = appState(
      [session("id-a", label: "Alpha"), session("id-b", label: "Birch")], sessionsMode: sessionsMode)
    backend.catalog = .sessions([catalogRow("id-a"), catalogRow("id-b")])
    backend.turns["id-a"] = turnsAnswer([("user", "Alpha prompt"), ("assistant", "Alpha answer")])
    backend.turns["id-b"] = turnsAnswer([("user", "Birch prompt")])
    if voiceAgent { settings.acceptConsent() }
    if consented { settings.acceptSessionsConsent() }
    owner = VoiceAgentSessionsConversation(
      backend: backend, settings: settings, sonioxAllowed: true, microphone: center, now: { Sample.now },
      dependencies: { [unowned self] in self.device.dependencies($0) })
  }

  /// Starts the conversation across sessions and brings it to listening.
  func ready() async throws {
    let before = device.sockets.count
    #expect(await owner.start() == .started)
    await device.ready(try #require(owner.session), socketsBefore: before)
  }

  /// A conversation at session `id-a` on its own device, started as the session screen starts it: the microphone
  /// first, then the start.
  func conversationAtSession(on device: VoiceAgentFakeDevice = VoiceAgentFakeDevice()) -> VoiceAgentSession {
    let host = VoiceAgentSessionHost(sessionId: "id-a", backend: backend)
    host.watchInput = { [unowned self] in
      VoiceAgentWatch.Input(
        state: self.backend.state, sessionId: "id-a", login: self.backend.loginEpoch, enabled: self.settings.enabled,
        sonioxAllowed: true, selected: "id-a", background: false)
    }
    let session = VoiceAgentSession(host: host, backend: backend, dependencies: { device.dependencies($0) })
    center.claim(session)
    session.start()
    return session
  }

  func dropOwner() { owner = nil }
}

/// A refusal of the opening list.
enum OpeningRefusal: String, CaseIterable, Sendable {
  case loggedOut = "logged out"
  case off = "mode off on the server"
  case unavailable = "catalog failed"
}

/// Ways the conversation across sessions ends.
enum SessionsConversationEnd: String, CaseIterable, Sendable {
  case endAction = "end action"
  case background
  case logout
  case newLogin = "another login"
  case connectionLost = "lost server connection"
  case modeGone = "mode not offered"
  case consentWithdrawn = "consent withdrawn"
  case voiceAgentOff = "the voice agent turned off"
  case audioInterrupted = "audio interruption"
  case sonioxFailed = "Soniox failure"
  case newConversation = "a read session's new conversation"
  case conversationAtSession = "a conversation at a session starts"
  case dictation = "dictation takes the microphone"

  /// What the bar shows after this end (`nil`: no sentence, as after the end button at a session).
  var shown: VoiceAgentIndicator? {
    switch self {
    case .endAction, .conversationAtSession, .dictation: nil
    case .background: .closed(.background)
    case .logout: .closed(.loggedOut)
    case .newLogin: .closed(.serverChanged)
    case .connectionLost: .closed(.connectionLost)
    case .modeGone, .consentWithdrawn, .voiceAgentOff: .closed(.disabled)
    case .audioInterrupted: .ended(.audioInterrupted)
    case .sonioxFailed: .ended(.speechFailed)
    case .newConversation: .closed(.sessionCleared)
    }
  }
}

@MainActor
@Suite("voice conversation across sessions: the owner, the entry, the consent, the ends, one microphone")
struct VoiceAgentSessionsConversationTests {
  @Test("the list button is hidden where the mode is not offered and asks for consent where one of the two is missing")
  func entry() async {
    let notOffered = Rig(sessionsMode: false)
    #expect(notOffered.owner.entry == .hidden)
    #expect(await notOffered.owner.start() == .notOffered)
    let noConsent = Rig(consented: false)
    #expect(noConsent.owner.entry == .consent)
    #expect(await noConsent.owner.start() == .consentNeeded)
    // The mode's consent adds to the voice agent's: alone it starts nothing.
    let voiceAgentOff = Rig(voiceAgent: false)
    #expect(voiceAgentOff.owner.entry == .consent)
    #expect(await voiceAgentOff.owner.start() == .consentNeeded)
    for rig in [notOffered, noConsent, voiceAgentOff] {
      #expect(rig.owner.host == nil && rig.owner.session == nil && !rig.owner.isActive && rig.backend.reads.isEmpty)
    }
    #expect(Rig().owner.entry == .start)
  }

  @Test("without the mode's consent the conversation at a session is offered and starts")
  func atSessionWithoutModeConsent() {
    let rig = Rig(consented: false)
    let entry = VoiceAgentEntry.make(
      state: rig.backend.state, sessionId: "id-a", enabled: rig.settings.enabled, sonioxAllowed: true,
      dictating: false)
    #expect(entry == .enabled)
    #expect(rig.conversationAtSession().isActive)
  }

  @Test("a start reads the opening list with a new host before the conversation asks for its keys")
  func preparedBeforeStart() async throws {
    let rig = Rig()
    var duringCatalog: (mints: Int, session: Bool, indicator: VoiceAgentIndicator?, active: Bool)?
    rig.backend.onCatalog = { [unowned rig] in
      duringCatalog = (rig.backend.tokenCalls, rig.owner.session != nil, rig.owner.indicator, rig.owner.isActive)
    }
    #expect(await rig.owner.start() == .started)
    #expect(duringCatalog?.mints == 0 && duringCatalog?.session == false)
    #expect(duringCatalog?.indicator == .connecting && duringCatalog?.active == true)
    let session = try #require(rig.owner.session)
    #expect(session.host === rig.owner.host)
    #expect(await eventually { rig.backend.tokenCalls == 1 })
    #expect(await rig.owner.start() == .running, "a start while it runs builds nothing")
    #expect(rig.owner.session === session && rig.backend.reads == ["catalog"])
  }

  @Test("a refused opening list is the start's outcome with its sentence, and no conversation is built",
    arguments: OpeningRefusal.allCases)
  func openingRefused(refusal: OpeningRefusal) async {
    let rig = Rig()
    let shown: VoiceAgentIndicator
    switch refusal {
    case .loggedOut:
      rig.backend.state.auth = .loggedOut(.notLoggedIn)
      shown = .closed(.loggedOut)
    case .off:
      rig.backend.catalog = .disabled(message: nil)
      shown = .closed(.disabled)
    case .unavailable:
      rig.backend.catalog = .failed(code: "internal", message: nil)
      shown = .ended(.unavailable)
    }
    #expect(await rig.owner.start() == .refused(shown))
    #expect(rig.owner.session == nil && !rig.owner.isActive && rig.owner.indicator == shown)
    #expect(rig.backend.tokenCalls == 0 && rig.device.sockets.isEmpty)
  }

  @Test("the end action while the opening list is read: no conversation is built and nothing of the list stays")
  func endWhilePreparing() async throws {
    let rig = Rig()
    rig.backend.onCatalog = { [unowned rig] in rig.owner.end() }
    #expect(await rig.owner.start() == .cancelled)
    #expect(rig.owner.session == nil && !rig.owner.isActive && rig.owner.indicator == nil)
    #expect(rig.backend.tokenCalls == 0 && rig.device.sockets.isEmpty)
    #expect(try #require(rig.owner.host).handles == VoiceAgentHandles())
  }

  @Test("an end reason that comes and goes while the opening list is read stops the start with its sentence")
  func reasonWhilePreparing() async {
    let rig = Rig()
    rig.backend.onCatalog = { [unowned rig] in
      rig.owner.scene(.background)
      rig.owner.scene(.active)
    }
    #expect(await rig.owner.start() == .refused(.closed(.background)))
    #expect(rig.owner.session == nil && !rig.owner.isActive && rig.owner.indicator == .closed(.background))
    #expect(rig.backend.tokenCalls == 0 && rig.device.sockets.isEmpty)
  }

  @Test("dictation that takes the microphone while the opening list is read keeps it: the start is given up")
  func dictationWhilePreparing() async {
    let rig = Rig()
    let dictation = Dictation()
    rig.backend.onCatalog = { [unowned rig] in rig.center.claim(dictation) }
    #expect(await rig.owner.start() == .cancelled)
    #expect(!dictation.handedOff, "the newer recording goes on")
    #expect(rig.owner.session == nil && !rig.owner.isActive && rig.owner.indicator == nil)
    #expect(rig.backend.tokenCalls == 0 && rig.device.sockets.isEmpty)
  }

  @Test("in the background no start begins: the outcome has the background sentence and nothing is read")
  func noStartInBackground() async {
    let rig = Rig()
    rig.owner.scene(.background)
    #expect(await rig.owner.start() == .refused(.closed(.background)))
    #expect(rig.backend.reads.isEmpty && rig.owner.session == nil)
    rig.owner.scene(.active)
    #expect(await rig.owner.start() == .started)
  }

  // Catches a conversation across sessions that the background still ends with the locked-phone trial on: the trial
  // would do nothing for this mode.
  @Test("with the trial on the background keeps a ready conversation across sessions")
  func backgroundKeepsWithTrial() async throws {
    let rig = Rig()
    rig.settings.lockedPhoneTrial.set(true)
    try await rig.ready()
    let session = try #require(rig.owner.session)
    rig.owner.scene(.background)
    #expect(rig.owner.isActive && session.isActive && rig.owner.indicator?.isActive == true)
    #expect(!rig.device.socket.closed && rig.device.audio.stops == 0)
    rig.owner.scene(.active)
    #expect(rig.owner.isActive && rig.owner.session === session)
  }

  // Catches a trial that keeps what has no open microphone yet: a start, the opening list, or a conversation still
  // connecting would go on in the background and open the microphone there.
  @Test("with the trial on the background refuses a start and ends the opening list and a connecting conversation")
  func backgroundEndsStartWithTrial() async throws {
    let rig = Rig()
    rig.settings.lockedPhoneTrial.set(true)
    rig.owner.scene(.background)
    #expect(await rig.owner.start() == .refused(.closed(.background)))
    #expect(rig.backend.reads.isEmpty && rig.device.audio.starts == 0)
    rig.owner.scene(.active)
    rig.backend.onCatalog = { [unowned rig] in rig.owner.scene(.background) }
    #expect(await rig.owner.start() == .refused(.closed(.background)))
    #expect(rig.device.audio.starts == 0 && rig.device.sockets.isEmpty)
    rig.backend.onCatalog = nil
    rig.owner.scene(.active)
    #expect(await rig.owner.start() == .started)
    let session = try #require(rig.owner.session)
    #expect(session.phase == .connecting, "OpenAI has not taken the session yet")
    rig.owner.scene(.background)
    #expect(!rig.owner.isActive && !session.isActive && rig.owner.indicator == .closed(.background))
  }

  @Test("going from the list to a session and back keeps the same conversation")
  func navigationKeepsConversation() async throws {
    let rig = Rig()
    try await rig.ready()
    let session = try #require(rig.owner.session)
    for viewed in ["id-a", nil, "id-b", nil] as [String?] {
      rig.backend.state.viewedSessionId = viewed
      rig.owner.observe()
    }
    #expect(rig.owner.isActive && rig.owner.session === session && rig.device.sockets.count == 1)
  }

  @Test("one microphone: a conversation at a session that starts ends the one across sessions, and the other way round")
  func oneMicrophone() async throws {
    let rig = Rig()
    try await rig.ready()
    let atSession = rig.conversationAtSession()
    #expect(atSession.isActive && !rig.owner.isActive)
    #expect(await rig.owner.start() == .started)
    #expect(!atSession.isActive, "the start across sessions takes the microphone")
  }

  @Test(
    "dictation that takes the microphone ends the conversation across sessions as it ends one at a session",
    arguments: [true, false])
  func dictationEnds(acrossSessions: Bool) async throws {
    let rig = Rig()
    let running: () -> Bool
    if acrossSessions {
      try await rig.ready()
      running = { rig.owner.isActive }
    } else {
      let atSession = rig.conversationAtSession()
      running = { atSession.isActive }
    }
    #expect(running())
    rig.center.claim(Dictation())
    #expect(!running())
  }

  // The microphone's use catches an end that leaves the conversation reported as recording (an observer outside the
  // app's screens would show a microphone that no longer runs), or an end its observers never learn.
  @Test(
    "every end ends the conversation with its sentence and its microphone use; then no tool asks, no reads, no handles",
    arguments: SessionsConversationEnd.allCases)
  func everyEnd(end: SessionsConversationEnd) async throws {
    let rig = Rig()
    try await rig.ready()
    let host = try #require(rig.owner.host)
    #expect(!isError(await call(host, .readSessions, #"{"handles":["s1","s2"]}"#)))
    #expect(host.reads.count == 2)
    #expect(
      rig.center.use
        == MicrophoneUse(
          kind: .conversation, audio: false, openAI: true, soniox: true, phase: .listening, subject: .allSessions))
    let told = Told()
    rig.center.observe { [told] in told.count += 1 }
    switch end {
    case .endAction: rig.owner.end()
    case .background: rig.owner.scene(.background)
    case .logout:
      rig.backend.state.auth = .loggedOut(.notLoggedIn)
      rig.owner.observe()
    case .newLogin:
      rig.backend.loginEpoch += 1
      rig.owner.observe()
    case .connectionLost:
      rig.backend.state.global = .offline(since: Sample.now)
      rig.owner.observe()
    case .modeGone:
      rig.backend.state = appState([session("id-a", label: "Alpha")], sessionsMode: false)
      rig.owner.observe()
    case .consentWithdrawn:
      // No call from outside: the owner follows the consent itself.
      rig.settings.withdrawSessionsConsent()
    case .voiceAgentOff: rig.settings.disable()
    case .audioInterrupted: try #require(rig.device.audio.handlers).interrupted("test interruption")
    case .sonioxFailed: try #require(rig.device.speechSockets.last).drop()
    case .newConversation:
      rig.backend.turns["id-a"] = turnsAnswer([("user", "After clear")], conversation: "conv-2")
      _ = await call(host, .readSessions, #"{"handles":["s1"]}"#)
    case .conversationAtSession: _ = rig.conversationAtSession()
    case .dictation: rig.center.claim(Dictation())
    }
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.indicator == end.shown)
    #expect(rig.center.use == nil && told.count > 0)
    #expect(host.reads.isEmpty && host.handles == VoiceAgentHandles())
    let asked = rig.backend.reads
    #expect(isError(await call(host, .listSessions)))
    #expect(rig.backend.reads == asked)
  }

  // Catches a conversation that goes away without an end (its owner dropped it) while the microphone center still
  // reports it, or whose going its observers never learn.
  @Test("a ready conversation deallocated without an end leaves no microphone use, and the observers learn it")
  func deallocatedConversation() async throws {
    let rig = Rig()
    let device = VoiceAgentFakeDevice()
    var session: VoiceAgentSession? = rig.conversationAtSession(on: device)
    await device.ready(try #require(session))
    #expect(rig.center.use?.kind == .conversation)
    let told = Told()
    rig.center.observe { [told] in told.count += 1 }
    weak var gone = session
    session = nil
    #expect(await eventually { gone == nil })
    #expect(rig.center.use == nil && told.count == 1)
  }

  @Test("a second start after an end builds a new host: handles from s1, no reads, questions counted from 1")
  func secondStartNewHost() async throws {
    let rig = Rig()
    try await rig.ready()
    let first = try #require(rig.owner.host)
    #expect(!isError(await call(first, .readSessions, #"{"handles":["s1","s2"]}"#)))
    #expect(!isError(await call(first, .askSession, #"{"handle":"s2","question":"Why?"}"#)))
    rig.owner.end()
    rig.backend.catalog = .sessions([catalogRow("id-b")])
    try await rig.ready()
    let second = try #require(rig.owner.host)
    #expect(second !== first && second.reads.isEmpty)
    #expect(rows(await call(second, .listSessions)).map { $0["handle"] as? String } == ["s1"])
    #expect(!isError(await call(second, .askSession, #"{"handle":"s1","question":"Why?"}"#)))
    #expect(rig.backend.traces.filter { $0 == "voice-agent: question 1 of 30" }.count == 2)
  }

  @Test("the list button: none where the mode is not offered, the consent sheet without consent, else a start")
  func listButton() async {
    let notOffered = Rig(sessionsMode: false)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(VoiceAgentSessionsListAction.of(notOffered.owner) == .hidden)
    VoiceAgentSessionsListAction.tap(notOffered.owner, navigation: navigation)
    #expect(navigation.sheet == nil)
    for rig in [Rig(consented: false), Rig(voiceAgent: false)] {
      #expect(VoiceAgentSessionsListAction.of(rig.owner) == .consent)
      VoiceAgentSessionsListAction.tap(rig.owner, navigation: navigation)
      guard case .voiceAgentSessionsConsent? = navigation.sheet else {
        Issue.record("the consent sheet: \(String(describing: navigation.sheet))")
        return
      }
      navigation.dropSheet()
      try? await Task.sleep(for: .milliseconds(20))
      #expect(rig.backend.reads.isEmpty && !rig.owner.isActive, "the consent comes before any read")
    }
    let rig = Rig()
    #expect(VoiceAgentSessionsListAction.of(rig.owner) == .start)
    VoiceAgentSessionsListAction.tap(rig.owner, navigation: navigation)
    #expect(await eventually { rig.owner.session != nil })
    #expect(navigation.sheet == nil && rig.backend.reads == ["catalog"])
  }

  // Catches: a lit circle whose tap does nothing (the conversation could not be ended from the list header) or
  // starts a second conversation.
  @Test("the list button while a conversation runs: the lit circle, and a tap ends the conversation")
  func listButtonWhileRunning() async throws {
    let rig = Rig()
    try await rig.ready()
    let session = try #require(rig.owner.session)
    #expect(VoiceAgentSessionsListAction.of(rig.owner) == .running)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    VoiceAgentSessionsListAction.tap(rig.owner, navigation: navigation)
    #expect(await eventually { !rig.owner.isActive })
    #expect(!session.isActive && navigation.sheet == nil)
    #expect(VoiceAgentSessionsBarContent.of(rig.owner) == nil, "the end action leaves no sentence")
    #expect(rig.owner.session === session && rig.backend.reads == ["catalog"] && rig.device.sockets.count == 1)
  }

  // Catches: bars of the lit circle that stand still while the user speaks, and bars left raised after the end.
  @Test("the levels of the running conversation reach the owner and drop to zero at its end")
  func levels() async throws {
    let rig = Rig()
    #expect(rig.owner.levels == .zero)
    try await rig.ready()
    try #require(rig.device.audio.handlers).input(Data([0x00, 0x40]))
    rig.device.scheduler.advance(RealtimeLevelMeter.interval)
    #expect(rig.owner.levels.input == 0.5)
    rig.owner.end()
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.levels == .zero)
  }

  @Test("the bar over the owner: none before a start, the state with End while it runs, gone after End")
  func barWhileRunning() async throws {
    let rig = Rig()
    #expect(VoiceAgentSessionsBarContent.of(rig.owner) == nil)
    try await rig.ready()
    let running = try #require(VoiceAgentSessionsBarContent.of(rig.owner))
    #expect(running.running && running.indicator == .listening)
    rig.owner.end()
    #expect(await eventually { !rig.owner.isActive })
    #expect(VoiceAgentSessionsBarContent.of(rig.owner) == nil, "the end action leaves no sentence")
  }

  @Test("the bar's end sentence stays until a tap removes it; the next start shows the state again")
  func barEndSentence() async throws {
    let rig = Rig()
    try await rig.ready()
    rig.owner.scene(.background)
    #expect(await eventually { !rig.owner.isActive })
    let ended = try #require(VoiceAgentSessionsBarContent.of(rig.owner))
    #expect(ended == VoiceAgentSessionsBarContent(indicator: .closed(.background), running: false))
    rig.owner.scene(.active)
    #expect(VoiceAgentSessionsBarContent.of(rig.owner) == ended, "back in the foreground the sentence stays")
    rig.owner.dismissNotice()
    #expect(VoiceAgentSessionsBarContent.of(rig.owner) == nil)
    try await rig.ready()
    #expect(VoiceAgentSessionsBarContent.of(rig.owner)?.running == true)
  }

  @Test("the consent flow from the list starts the owner's conversation once, with one opening read")
  func consentFlowStartsOnce() async {
    let rig = Rig(consented: false, voiceAgent: false)
    let flow = VoiceAgentSessionsConsentFlow(settings: rig.settings) { [unowned rig] in
      Task { await rig.owner.start() }
    }
    flow.acceptVoiceAgent()
    #expect(rig.backend.reads.isEmpty && !rig.owner.isActive, "the mode's consent is still missing")
    flow.acceptSessions()
    #expect(await eventually { rig.owner.session != nil })
    #expect(rig.owner.isActive && rig.backend.reads == ["catalog"])
  }

  @Test("the Settings switch across sessions turned off ends the running conversation as turned off")
  func settingsSwitchOffEnds() async throws {
    let rig = Rig()
    try await rig.ready()
    VoiceAgentSettingsModel(settings: rig.settings).toggleSessions(false)
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.indicator == .closed(.disabled))
  }

  @Test("the owner going away (a new root for another server) ends its conversation")
  func ownerGoneEnds() async throws {
    let rig = Rig()
    try await rig.ready()
    let socket = rig.device.socket
    rig.dropOwner()
    #expect(socket.closed && rig.device.audio.stops >= 1)
  }

  // Catches: a pick-up that the real answer events never reach (the host not told, a tool call taken as the answer,
  // speech over the answer not counted as a cut).
  // The owner's discussed session catches a pointing that names no session, the wrong one, or one after the end.
  @Test("the whole route: a filter read picks up nothing, discuss_session and an answer played out picks up that one")
  func discussedPickUpRoute() async throws {
    let rig = Rig()
    try await rig.ready()
    let pcm = Data(count: 9600)
    await rig.device.toolCall("r1", name: "read_sessions", arguments: #"{"handles":["s1"]}"#)
    #expect(rig.owner.discussed?.name == "Alpha")
    await rig.device.toolCall("r1b", name: "read_sessions", arguments: #"{"filter":"finished"}"#, spoken: pcm)
    #expect(rig.owner.discussed == nil, "a filter read clears the discussed session")
    try rig.device.playOut("m-r1b")
    await rig.device.toolCall("r2", name: "discuss_session", arguments: #"{"handle":"s2"}"#, spoken: pcm)
    #expect(rig.device.outputs.last?.contains("under discussion") == true)
    #expect(rig.owner.discussed == VoiceAgentDiscussed(sessionId: "id-b", handle: "s2", project: "orbit", name: "Birch"))
    try rig.device.playOut("m-r2")
    #expect(await eventually { rig.backend.pickUps.count == 1 })
    let first = rig.backend.pickUps.first.map { "\($0.sessionId) \($0.conversation) \($0.readMark)" }
    #expect(first == "id-b conv-1 mark-1")

    // Speech over the answer after the next pointing: no pick-up, and none at the next answer played out.
    let long = Data(count: 96_000)
    await rig.device.toolCall("r3", name: "discuss_session", arguments: #"{"handle":"s1"}"#, spoken: long)
    rig.device.audio.playedSamples = 12_000
    rig.device.speechOver("in-over")
    // Soniox ends the cancelled stream, so the next answer's stream can start.
    rig.device.speechSocket.reply(SpeechSample.terminated(try #require(rig.device.streamOf["m-r3"])))
    rig.device.socket.reply(RealtimeSample.created("r4"))
    rig.device.say("r4", item: "m-r4", pcm: pcm)
    rig.device.socket.reply(RealtimeSample.done("r4"))
    try rig.device.playOut("m-r4")
    for _ in 0..<50 { await Task.yield() }
    #expect(rig.backend.pickUps.count == 1, "the pointing the speech cut picks up nothing")
    await rig.device.toolCall("r5", name: "discuss_session", arguments: #"{"handle":"s1"}"#, spoken: pcm)
    try rig.device.playOut("m-r5")
    #expect(await eventually { rig.backend.pickUps.count == 2 })
    #expect(rig.backend.pickUps.map(\.sessionId) == ["id-b", "id-a"])
    rig.owner.end()
    #expect(await eventually { !rig.owner.isActive })
    #expect(rig.owner.discussed == nil, "the end clears the discussed session")
  }

  @Test("check_open_requests over the conversation: announced, refused in the reply after it, run after an utterance")
  func checkRoute() async throws {
    // Catches a lock that counts the model's own replies as the user's word: the check runs only after the user spoke.
    let rig = Rig()
    rig.backend.state = appState([
      session("id-a", label: "Alpha", extra: #""seen":true"#, stateAgo: 60),
      session("id-b", label: "Birch", extra: #""seen":true"#, stateAgo: 300),
    ])
    try await rig.ready()
    let device = rig.device
    device.utterance("in-r1")
    device.socket.reply(RealtimeSample.created("r1"))
    device.socket.reply(RealtimeSample.call("r1", id: "c-r1", name: "check_open_requests"))
    device.socket.reply(RealtimeSample.done("r1"))
    #expect(await eventually { device.outputs.count == 1 })
    #expect(device.outputs.last?.contains("would ask 2 sessions") == true)
    // The reply ordered after the tool result calls again: the user has said nothing since.
    device.socket.reply(RealtimeSample.created("r1f"))
    device.socket.reply(RealtimeSample.call("r1f", id: "c-r1f", name: "check_open_requests"))
    device.socket.reply(RealtimeSample.done("r1f"))
    #expect(await eventually { device.outputs.count == 2 })
    #expect(device.outputs.last?.contains("has not agreed") == true)
    device.socket.reply(RealtimeSample.created("r1ff"))
    device.socket.reply(RealtimeSample.done("r1ff"))
    #expect(rig.backend.questions.isEmpty)

    await device.toolCall("r2", name: "check_open_requests", arguments: "{}", spoken: Data(count: 9600))
    #expect(device.outputs.last?.contains("would ask 2 sessions") == true, "the refusal used the announcement")
    #expect(rig.backend.questions.isEmpty)
    try device.playOut("m-r2")
    await device.toolCall("r3", name: "check_open_requests", arguments: "{}")
    #expect(rig.backend.reads.filter { $0.hasPrefix("ask ") } == ["ask id-a", "ask id-b"])
    let result = try #require(device.outputs.last)
    #expect(result.contains("Alpha") && result.contains("Birch") && result.contains("It was fixed in turn 2."))
  }

  @Test("check_open_requests needs an announcement heard whole: a dropped result or a cut answer announces again")
  func checkNeedsHeardAnnouncement() async throws {
    // Catches a check that starts though its announcement never reached the user: the result dropped by speech before
    // it went to the model, or the answer with it spoken over.
    let rig = Rig()
    rig.backend.state = appState([
      session("id-a", label: "Alpha", extra: #""seen":true"#, stateAgo: 60),
      session("id-b", label: "Birch", extra: #""seen":true"#, stateAgo: 300),
    ])
    try await rig.ready()
    let device = rig.device
    // The response is not closed, so the announcement waits in the conversation when the user speaks.
    device.utterance("in-r1")
    device.socket.reply(RealtimeSample.created("r1"))
    device.socket.reply(RealtimeSample.call("r1", id: "c-r1", name: "check_open_requests"))
    #expect(await eventually { rig.backend.traces.contains("voice-agent: check announced (2)") })
    device.utterance("in-r2")
    device.socket.reply(RealtimeSample.created("r2"))
    device.socket.reply(RealtimeSample.call("r2", id: "c-r2", name: "check_open_requests"))
    device.socket.reply(RealtimeSample.done("r2"))
    #expect(await eventually { device.outputs.count == 1 })
    #expect(device.outputs.last?.contains("would ask 2 sessions") == true, "the dropped announcement does not count")
    #expect(rig.backend.questions.isEmpty)

    // The answer with the announcement plays, and the user speaks over it.
    device.socket.reply(RealtimeSample.created("r2f"))
    device.say("r2f", item: "m-r2", pcm: Data(count: 96_000))
    device.socket.reply(RealtimeSample.done("r2f"))
    device.audio.playedSamples = 12_000
    device.speechOver("in-r3")
    device.socket.reply(RealtimeSample.created("r3"))
    device.socket.reply(RealtimeSample.call("r3", id: "c-r3", name: "check_open_requests"))
    device.socket.reply(RealtimeSample.done("r3"))
    #expect(await eventually { device.outputs.count == 2 })
    #expect(device.outputs.last?.contains("would ask 2 sessions") == true, "the answer spoken over does not count")
    #expect(rig.backend.questions.isEmpty)
  }

  // MARK: - The prompt pair over the conversation

  /// The user asks, `response` calls `show_prompt` for Alpha, and its reading plays out whole with the microphone
  /// audio around it, so the reading's mark lies at 1000 ms more on the input axis; the model's question after the
  /// result is silent. Returns the reading's stream.
  @discardableResult
  private func promptRead(_ rig: Rig, _ response: String = "r1") async throws -> String {
    let device = rig.device
    let before = device.outputs.count
    device.utterance("in-\(response)")
    let stream = try await device.readingCall(
      response, name: "show_prompt", arguments: #"{"handle":"s1","text":"\#(promptText)"}"#)
    try device.input(milliseconds: 990)
    try device.playReading(stream)
    try device.input(milliseconds: 10)
    #expect(await eventually { device.outputs.count == before + 1 })
    device.socket.reply(RealtimeSample.created("\(response)f"))
    device.socket.reply(RealtimeSample.done("\(response)f"))
    return stream
  }

  /// `response` calls `send_prompt` and is over; returns its output.
  private func sendCall(_ rig: Rig, _ response: String) async -> String? {
    let device = rig.device
    let before = device.outputs.count
    device.socket.reply(RealtimeSample.created(response))
    device.socket.reply(RealtimeSample.call(response, id: "c-\(response)", name: "send_prompt"))
    device.socket.reply(RealtimeSample.done(response))
    guard await eventually({ device.outputs.count == before + 1 }) else { return nil }
    return device.outputs.last
  }

  private let promptText = "Run the login tests."

  @Test("the whole route: show_prompt, its reading played out, the user's word after it, one send with the token")
  func promptRoute() async throws {
    // Catches a send that the real conversation never opens, or one that sends another text, session or token.
    let rig = Rig()
    try await rig.ready()
    let stream = try await promptRead(rig)
    let sentence = UICopy.voiceAgentSessionsPromptReading(project: "orbit", name: "Alpha", text: promptText)
    #expect(rig.device.speechText(stream) == sentence)
    #expect(rig.device.outputs.last?.contains("Ask only whether to send it.") == true)
    #expect(rig.owner.prompt == VoiceAgentShownPrompt(project: "orbit", name: "Alpha", text: promptText))
    // The bar's card catches an owner prompt that never reaches the bar, or one that stays after the send.
    #expect(VoiceAgentSessionsBarContent.of(rig.owner)?.prompt == rig.owner.prompt)
    rig.device.utterance("in-r2", startMs: 5000)
    let output = await sendCall(rig, "r2")
    #expect(output == RealtimeConversation.toolResult("Sent."))
    let sent = rig.backend.sends.map { "\($0.sessionId) \($0.conversation) \($0.text)" }
    #expect(sent == ["id-a conv-1 \(promptText)"] && rig.backend.requests == 1)
    #expect(rig.owner.prompt == nil)
    #expect(VoiceAgentSessionsBarContent.of(rig.owner)?.prompt == nil)
  }

  // Catches a subject that names no session while one is discussed, a waiting prompt the Live Activity never shows,
  // and a host that passes the prompt's text (or anything but the session's project and name) to the microphone.
  @Test("the microphone names all sessions, then the discussed session, then the waiting prompt's, without its text")
  func microphoneSubject() async throws {
    let rig = Rig()
    try await rig.ready()
    expectNamesOnly(rig.center.use, .allSessions, phase: .listening, hiding: [])
    await rig.device.toolCall("r0", name: "read_sessions", arguments: #"{"handles":["s2"]}"#)
    let discussed = try #require(rig.owner.discussed)
    expectNamesOnly(
      rig.center.use, .session(project: discussed.project, name: discussed.name), phase: .listening, hiding: [])
    try await promptRead(rig)
    let prompt = try #require(rig.owner.prompt)
    let target = try #require(rig.backend.state.sessions["id-a"])
    #expect(prompt.project == target.title && prompt.name == target.label)
    expectNamesOnly(
      rig.center.use, .session(project: prompt.project, name: prompt.name), phase: .prompt, hiding: [promptText])
    rig.owner.end()
    #expect(await eventually { rig.center.use == nil })
  }

  // Catches a conversation at a session that names another session, or none, to the app's microphone.
  @Test("a conversation at a session names that session by its project and name")
  func microphoneSubjectAtSession() async throws {
    let rig = Rig()
    let device = VoiceAgentFakeDevice()
    let session = rig.conversationAtSession(on: device)
    await device.ready(session)
    let target = try #require(rig.backend.state.sessions["id-a"])
    expectNamesOnly(rig.center.use, .session(project: target.title, name: target.label), phase: .listening, hiding: [])
  }

  @Test(
    "no send without a word after the whole reading: speech over it, a start before its end, no time, no audio",
    arguments: ["speech over the reading", "captured before the end", "no start time", "no audio"])
  func promptNeedsWordAfterReading(_ case_: String) async throws {
    // Catches a word the user began while the reading still played, or one the app cannot date, opening the send.
    let rig = Rig()
    try await rig.ready()
    let device = rig.device
    var expected = "The user has not confirmed yet."
    switch case_ {
    case "speech over the reading":
      device.utterance("in-r1")
      let stream = try await device.readingCall(
        "r1", name: "show_prompt", arguments: #"{"handle":"s1","text":"\#(promptText)"}"#)
      device.speechSocket.reply(SpeechSample.audio(stream, Data(count: 96_000)))
      device.audio.playedSamples = 12_000
      device.speechOver("in-r2")
      #expect(device.cancelledReading(stream), "the reading stops")
      expected = "not read aloud to the end"
    case "captured before the end":
      device.utterance("in-r1")
      let stream = try await device.readingCall(
        "r1", name: "show_prompt", arguments: #"{"handle":"s1","text":"\#(promptText)"}"#)
      try device.input(milliseconds: 1000)
      device.scheduler.advance(1)
      try device.playReading(stream)
      // 1000 ms of input lie before the end on the host clock. Speech captured 0.2 s before the end and handed over
      // after it does not place the mark; the first buffer captured at the end does, after itself: 1300 ms.
      try device.input(milliseconds: 200, capturedAt: device.scheduler.now - 0.2)
      try device.input(milliseconds: 100)
      #expect(await eventually { device.outputs.count == 1 })
      device.socket.reply(RealtimeSample.created("r1f"))
      device.socket.reply(RealtimeSample.done("r1f"))
      // The utterance began inside the 200 ms handed over late: before the mark.
      device.utterance("in-r2", startMs: 1150)
      #expect(rig.backend.traces.contains("voice-agent: reading mark 1300 ms"))
      #expect(rig.backend.traces.contains("voice-agent: utterance start 1150 ms vs mark 1300 ms: not-after"))
    case "no start time":
      try await promptRead(rig)
      device.utterance("in-r2", startMs: nil)
    default:
      device.utterance("in-r1")
      let stream = try await device.readingCall(
        "r1", name: "show_prompt", arguments: #"{"handle":"s1","text":"\#(promptText)"}"#)
      device.speechSocket.reply(SpeechSample.terminated(stream))
      #expect(await eventually { device.outputs.count == 1 })
      #expect(device.outputs.last?.contains("could not read the prompt aloud") == true)
      device.socket.reply(RealtimeSample.created("r1f"))
      device.socket.reply(RealtimeSample.done("r1f"))
      device.utterance("in-r2", startMs: 50_000)
      expected = "not read aloud to the end"
    }
    let output = await sendCall(rig, "r2")
    #expect(output?.contains(expected) == true, "\(output ?? "no output")")
    #expect(rig.backend.sends.isEmpty)
  }

  @Test(
    "Sent. dropped by a cut after the host returned it, asked again: one request in all",
    arguments: ["send again", "show again"])
  func promptResultDroppedByCut(_ again: String) async throws {
    // Catches a second copy of a prompt whose result the model never got: the repeat keeps the first send's id.
    let rig = Rig()
    try await rig.ready()
    let device = rig.device
    try await promptRead(rig)
    device.utterance("in-r2", startMs: 5000)
    // The response that calls send_prompt is not over, so the host's result waits in the conversation.
    device.socket.reply(RealtimeSample.created("r2"))
    device.socket.reply(RealtimeSample.call("r2", id: "c-r2", name: "send_prompt"))
    #expect(await eventually { rig.backend.traces.contains("voice-agent: send ended (sent)") })
    // The user speaks while nothing plays: the conversation drops the results in flight.
    device.socket.reply(RealtimeSample.speechStarted)
    device.socket.reply(RealtimeSample.done("r2"))
    device.socket.reply(RealtimeSample.speechStopped)
    device.socket.reply(RealtimeSample.committed("in-r3"))
    #expect(device.outputs.count == 1, "Sent. never reached the model")
    // An answer played out whole after the cut does not count: the model never got the result.
    device.socket.reply(RealtimeSample.created("r3"))
    device.say("r3", item: "m-r3", pcm: Data(count: 9600))
    device.socket.reply(RealtimeSample.done("r3"))
    try device.playOut("m-r3")

    if again == "show again" {
      try await promptRead(rig, "r4")
      #expect(device.outputs.last?.contains("already sent this exact prompt") == true)
    }
    device.utterance("in-r5", startMs: 50_000)
    #expect(await sendCall(rig, "r5") == RealtimeConversation.toolResult("Sent."))
    #expect(rig.backend.requests == 1)
    #expect(Set(rig.backend.sends.map(\.id)).count == 1, "a repeat carries the first send's id")
  }

  @Test("the prompt route: speech while send_prompt reads the catalog stops the send before its request")
  func promptStoppedBySpeechBeforeTheRequest() async throws {
    // Catches a send that goes out although the user spoke after the model asked for it: the cut must reach the host.
    let rig = Rig()
    try await rig.ready()
    let device = rig.device
    try await promptRead(rig)
    device.utterance("in-r2", startMs: 5000)
    rig.backend.holdCatalog = true
    device.socket.reply(RealtimeSample.created("r2"))
    device.socket.reply(RealtimeSample.call("r2", id: "c-r2", name: "send_prompt"))
    #expect(await eventually { rig.backend.catalogPending })
    // The user speaks while nothing plays and the send still reads the catalog.
    device.socket.reply(RealtimeSample.speechStarted)
    rig.backend.holdCatalog = false
    rig.backend.releaseCatalog()
    #expect(await eventually { rig.backend.traces.contains("voice-agent: send refused (cut)") })
    #expect(rig.backend.requests == 0 && rig.backend.sends.isEmpty)
  }

  @Test(
    "the prompt route: a sound over a playing answer stops a send_prompt that reads the catalog",
    arguments: ["speech", "noise"])
  func promptStoppedBySoundDuringTheCatalogRead(_ verdict: String) async throws {
    // Catches a send that goes out although a sound followed the confirming word: a short no counts as noise.
    let rig = Rig()
    try await rig.ready()
    let device = rig.device
    try await promptRead(rig)
    device.utterance("in-r2", startMs: 5000)
    rig.backend.holdCatalog = true
    device.socket.reply(RealtimeSample.created("r2"))
    // The model says a word with the call, and it plays while the send reads the catalog.
    device.say("r2", item: "m-r2", pcm: Data(count: 96_000))
    device.socket.reply(RealtimeSample.call("r2", id: "c-r2", name: "send_prompt"))
    #expect(await eventually { rig.backend.catalogPending })
    device.socket.reply(RealtimeSample.speechStarted)
    rig.backend.holdCatalog = false
    rig.backend.releaseCatalog()
    #expect(await eventually { rig.backend.traces.contains("voice-agent: send refused (sound)") })
    if verdict == "speech" {
      device.scheduler.advance(RealtimeBargeIn.window)
    } else {
      device.scheduler.advance(0.2)
      device.socket.reply(RealtimeSample.speechStopped)
    }
    for _ in 0..<50 { await Task.yield() }
    #expect(rig.backend.requests == 0 && rig.backend.sends.isEmpty)
  }

  @Test("the prompt route: noise over the answer before the send_prompt call stops it; a new word sends")
  func promptStoppedByNoiseBeforeTheCall() async throws {
    // Catches a call the noise window held and ran afterwards as if no sound had come.
    let rig = Rig()
    try await rig.ready()
    let device = rig.device
    try await promptRead(rig)
    device.utterance("in-r2", startMs: 5000)
    device.socket.reply(RealtimeSample.created("r2"))
    device.say("r2", item: "m-r2", pcm: Data(count: 96_000))
    device.socket.reply(RealtimeSample.speechStarted)
    device.socket.reply(RealtimeSample.call("r2", id: "c-r2", name: "send_prompt"))
    device.scheduler.advance(0.2)
    device.socket.reply(RealtimeSample.speechStopped)
    #expect(await eventually { rig.backend.traces.contains("voice-agent: send refused (sound)") })
    #expect(rig.backend.requests == 0)
    // The noise's own utterance is dropped and counts as no word: the same call again is refused.
    let before = device.outputs.count
    device.socket.reply(RealtimeSample.committed("noise"))
    device.socket.reply(RealtimeSample.done("r2"))
    #expect(await eventually { device.outputs.count == before + 1 })
    try device.playOut("m-r2")
    let again = await sendCall(rig, "r3")
    #expect(again == RealtimeConversation.toolError(VoiceAgentPromptText.soundAfterWord))
    #expect(rig.backend.requests == 0)
    // The model asks again, and the user's new word lets the send go.
    device.socket.reply(RealtimeSample.created("r3f"))
    device.socket.reply(RealtimeSample.done("r3f"))
    device.utterance("in-r4", startMs: 9000)
    #expect(await sendCall(rig, "r4") == RealtimeConversation.toolResult("Sent."))
    #expect(rig.backend.sends.count == 1 && rig.backend.requests == 1)
  }
}
