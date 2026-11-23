import Foundation
@testable import RarogUI
import Testing

// The "States" table of the voice conversation without a view: sentence, color and motion of each state, the
// owner of the status row and the bars of the button. The prompt in the field: `VoiceAgentDraftTests`. Owner: voice
// agent.

@Suite("voice conversation: states of the status row and the button")
struct VoiceAgentIndicatorTests {
  typealias Indicator = VoiceAgentIndicator

  @Test(
    "every state: color and motion from the table",
    arguments: [
      (Indicator.connecting, Indicator.Tone.wait, Indicator.Motion.none),
      (.listening, .run, .microphone),
      (.hearing, .run, .microphone),
      (.thinking, .wait, .none),
      (.checkingSession(seconds: 7), .wait, .none),
      (.answering, .new, .output),
      (.promptInField, .run, .microphone),
      (.sent, .run, .microphone),
      (.muted, .err, .none),
      (.ended(.dropped), .err, .none),
      (.closed(.background), .err, .none),
    ])
  func toneAndMotion(indicator: Indicator, tone: Indicator.Tone, motion: Indicator.Motion) {
    #expect(indicator.tone == tone)
    #expect(indicator.motion == motion)
    #expect(!UICopy.voiceAgentStatus(indicator).isEmpty)
  }

  @Test("the sentence of each state; checking the session carries the seconds")
  func sentences() {
    #expect(UICopy.voiceAgentStatus(.checkingSession(seconds: 7)).contains("7"))
    #expect(UICopy.voiceAgentStatus(.ended(.dropped)) == UICopy.voiceAgentEnd(.dropped))
    #expect(UICopy.voiceAgentStatus(.closed(.fieldHidden)) == UICopy.voiceAgentClosed(.fieldHidden))
    let running: [Indicator] = [
      .connecting, .listening, .hearing, .thinking, .checkingSession(seconds: 1), .answering, .promptInField, .sent,
      .muted,
    ]
    #expect(Set(running.map(UICopy.voiceAgentStatus)).count == running.count)
  }

  @Test("muted: “Wyciszony” in Polish, “Muted” in English; a running state")
  func mutedSentence() {
    #expect(UICopy.voiceAgentStatus(.muted) == "Wyciszony")
    #expect(L("voiceAgent.call.status.muted", language: .en) == "Muted")
    #expect(Indicator.muted.isActive)
  }

  @Test(
    "muted: listening and hearing show “Muted”; answering, thinking, checking, prompt and sent show as today",
    arguments: [
      (RealtimeConversation.Phase.listening, false, Indicator.Transient?.none, Indicator?.some(.muted)),
      (.listening, true, nil, .muted),
      (.speaking, false, nil, .answering),
      (.thinking, true, nil, .thinking),
      (.checkingSession, false, nil, .checkingSession(seconds: 4)),
      (.listening, false, .promptInField, .promptInField),
      (.listening, true, .sent, .sent),
      (.connecting, false, nil, .connecting),
      (.ended(.dropped), false, nil, .ended(.dropped)),
    ])
  func makeMuted(
    phase: RealtimeConversation.Phase, hearing: Bool, transient: Indicator.Transient?, expected: Indicator?
  ) {
    #expect(
      Indicator.make(
        phase: phase, hearing: hearing, muted: true, transient: transient, closedBy: nil, checkingSeconds: 4)
        == expected)
  }

  @Test(
    "phase, speech, transient state and close reason → the state; a plain end leaves no row",
    arguments: [
      (RealtimeConversation.Phase.connecting, false, Indicator.Transient?.none, VoiceAgentWatch.Reason?.none,
       Indicator?.some(.connecting)),
      (.listening, false, nil, nil, .listening),
      (.listening, true, .promptInField, nil, .hearing),
      (.listening, false, .promptInField, nil, .promptInField),
      (.listening, false, .sent, nil, .sent),
      (.thinking, false, .promptInField, nil, .thinking),
      (.checkingSession, false, nil, nil, .checkingSession(seconds: 4)),
      (.speaking, false, .sent, nil, .answering),
      (.ended(.closed), false, nil, nil, nil),
      (.ended(.dropped), false, nil, nil, .ended(.dropped)),
      (.ended(.closed), false, nil, .sessionChanged, .closed(.sessionChanged)),
      (.idle, false, nil, .fieldHidden, .closed(.fieldHidden)),
      (.idle, false, nil, nil, nil),
    ])
  func make(
    phase: RealtimeConversation.Phase, hearing: Bool, transient: Indicator.Transient?,
    closedBy: VoiceAgentWatch.Reason?, expected: Indicator?
  ) {
    #expect(
      Indicator.make(phase: phase, hearing: hearing, transient: transient, closedBy: closedBy, checkingSeconds: 4)
        == expected)
  }

  @Test("the screen reader hears a change of sentence, not a tick of the counter")
  func sameSentence() {
    #expect(Indicator.checkingSession(seconds: 1).sameSentence(as: .checkingSession(seconds: 2)))
    #expect(!Indicator.listening.sameSentence(as: .hearing))
    #expect(!Indicator.listening.sameSentence(as: nil))
  }

  @Test("only a microphone refusal offers the Settings button")
  func settings() {
    #expect(Indicator.ended(.microphone(.denied)).opensSettings)
    #expect(!Indicator.ended(.microphone(.busy)).opensSettings)
    #expect(!Indicator.listening.opensSettings)
  }

  // MARK: Owner of the status row

  @Test("a running conversation owns the row; its end sentence gives way to dictation's text")
  func owner() {
    #expect(VoiceStatusOwner.pick(dictationText: "", agent: .listening) == .voiceAgent(.listening))
    #expect(VoiceStatusOwner.pick(dictationText: "Recording", agent: .listening) == .voiceAgent(.listening))
    #expect(VoiceStatusOwner.pick(dictationText: "Recording", agent: .ended(.dropped)) == .dictation)
    #expect(VoiceStatusOwner.pick(dictationText: "", agent: .ended(.dropped)) == .voiceAgent(.ended(.dropped)))
    #expect(VoiceStatusOwner.pick(dictationText: "Recording", agent: nil) == .dictation)
    #expect(VoiceStatusOwner.pick(dictationText: "", agent: nil) == .none)
  }

  @Test("a field edit keeps the row of a running conversation and clears its end sentence")
  func edit() {
    #expect(VoiceStatusOwner.afterEdit(.hearing) == .hearing)
    #expect(VoiceStatusOwner.afterEdit(.checkingSession(seconds: 3)) == .checkingSession(seconds: 3))
    #expect(VoiceStatusOwner.afterEdit(.ended(.dropped)) == nil)
    #expect(VoiceStatusOwner.afterEdit(.closed(.background)) == nil)
    #expect(VoiceStatusOwner.afterEdit(nil) == nil)
  }

  // MARK: Bars of the button

  @Test("bars: rest without motion, still with reduced motion, otherwise height from the level")
  func bars() {
    #expect(VoiceAgentBars.heights(level: 1, motion: .none, reduceMotion: false) == VoiceAgentBars.rest)
    #expect(VoiceAgentBars.heights(level: 1, motion: .microphone, reduceMotion: true) == VoiceAgentBars.still)
    #expect(VoiceAgentBars.heights(level: 0, motion: .output, reduceMotion: false).allSatisfy { $0 == 3 })
    let full = VoiceAgentBars.heights(level: 1, motion: .microphone, reduceMotion: false)
    #expect(full[2] == VoiceAgentBars.maxHeight)
    #expect(full[0] < full[1] && full[1] < full[2] && full[3] == full[1] && full[4] == full[0])
  }

  @Test("bars: fast up, slowly down to rest; the side that speaks drives them, with the gain")
  func smoothing() {
    #expect(RealtimeLevels.fall(0, peak: 0.4) == 0.4)
    #expect(RealtimeLevels.fall(0.5, peak: 0) == 0.4)
    #expect(RealtimeLevels.fall(0.5, peak: 0.45) == 0.45)
    #expect(RealtimeLevels.fall(0.011, peak: 0) == 0, "the tail below rest drops to zero")
    #expect(RealtimeLevels.zero.next(.zero) == .zero)
    let levels = RealtimeLevels(input: 0.125, output: 0.25)
    #expect(VoiceAgentBars.level(levels, motion: .microphone) == 0.3125)
    #expect(VoiceAgentBars.level(levels, motion: .output) == 0.625)
    #expect(VoiceAgentBars.level(RealtimeLevels(input: 0.5, output: 0), motion: .microphone) == 1)
    #expect(VoiceAgentBars.level(levels, motion: .none) == 0)
  }
}
