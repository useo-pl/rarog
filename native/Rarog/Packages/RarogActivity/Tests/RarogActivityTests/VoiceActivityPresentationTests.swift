import Foundation
@testable import RarogActivity
import Testing

// What the voice Live Activity shows for each state: the words come from the catalog, the choice of word, colour,
// glyph and subject from the state's kind, phase and scope.
@Suite("voice Live Activity presentation: words, colour, glyph and subject by kind, phase and scope")
struct VoiceActivityPresentationTests {
  typealias State = VoiceActivityAttributes.ContentState

  static func state(
    _ kind: State.Kind, _ phase: State.Phase, _ scope: State.Scope = .session, project: String? = nil,
    name: String? = nil
  ) -> State {
    State(
      kind: kind, phase: phase, scope: scope, project: project, name: name, startedAt: Date(timeIntervalSince1970: 0))
  }

  /// The kind that records in `phase`: the dictation's phases belong to a dictation, the rest to a conversation.
  static func kind(of phase: State.Phase) -> State.Kind {
    ([.dictating, .sending, .notSent, .unconfirmed] as [State.Phase]).contains(phase) ? .dictation : .conversation
  }

  /// Catches a swapped button: a dictation's button stops it (its text stays in the field), a conversation's ends it.
  @Test("a conversation's button says End, a dictation's says Stop")
  func buttonWord() {
    #expect(VoiceActivityPresentation(Self.state(.conversation, .working)).endWord == L("voiceActivity.end"))
    #expect(VoiceActivityPresentation(Self.state(.dictation, .dictating)).endWord == L("voiceActivity.stop"))
  }

  /// Catches two phases mapped to one word, and a kind word that ignores the kind.
  @Test("each phase and each kind has its own word")
  func distinctWords() {
    let phases = State.Phase.allCases.map { VoiceActivityPresentation(Self.state(.conversation, $0)).phaseWord }
    #expect(Set(phases).count == State.Phase.allCases.count, "\(phases)")
    let kinds = State.Kind.allCases.map { VoiceActivityPresentation(Self.state($0, .working)).kindWord }
    #expect(Set(kinds).count == State.Kind.allCases.count, "\(kinds)")
  }

  /// Catches a subject line that is empty for a session without names, keeps a name for all sessions, drops one of
  /// the two names, or leaves out the answer a waiting prompt asks for.
  @Test("the subject line: all sessions, the project and name, one of them, none, and the prompt's answer")
  func subjectLine() {
    let all = VoiceActivityPresentation(Self.state(.conversation, .listening, .allSessions, project: "atlas"))
    #expect(all.subjectLine == L("voiceActivity.subject.allSessions"))
    let named = VoiceActivityPresentation(Self.state(.conversation, .answering, project: "atlas", name: "demo"))
    #expect(named.subjectLine == LiveActivityPresentation.list(["atlas", "demo"], .dot))
    let project = VoiceActivityPresentation(Self.state(.dictation, .dictating, project: "atlas"))
    #expect(project.subjectLine == "atlas")
    let unnamed = VoiceActivityPresentation(Self.state(.conversation, .answering))
    #expect(unnamed.subjectLine == L("voiceActivity.subject.oneSession"))
    let prompt = VoiceActivityPresentation(Self.state(.conversation, .prompt, project: "atlas", name: "demo"))
    #expect(
      prompt.subjectLine
        == LiveActivityPresentation.list([L("voiceActivity.subject.sayYesOrNo"), "atlas", "demo"], .dot))
  }

  /// Catches a VoiceOver label without the phase or the subject, or with the tile's middle dot in it: kind, phase and
  /// subject, read as words.
  @Test("the VoiceOver label is the kind, the phase and the subject's parts joined by a comma")
  func spokenLabel() {
    let presentation = VoiceActivityPresentation(Self.state(.conversation, .prompt, project: "atlas", name: "demo"))
    #expect(
      presentation.spoken
        == LiveActivityPresentation.list(
          [presentation.kindWord, presentation.phaseWord, L("voiceActivity.subject.sayYesOrNo"), "atlas", "demo"],
          .comma))
    #expect(!presentation.spoken.contains("·"))
  }

  /// Catches a phase drawn in another tone than the voice agent's status shows it, and a waiting prompt in the
  /// listening green instead of the waiting amber: each phase has the tone of its status, and the glyph tells a
  /// dictation's microphone and a muted microphone from the conversation's waveform.
  @Test("the tone of each phase follows the voice agent status; a waiting prompt is amber")
  func toneAndGlyph() {
    let tones: [State.Phase: UInt32] = [
      .listening: LiveActivityPalette.runPair.dark, .answering: LiveActivityPalette.newPair.dark,
      .working: LiveActivityPalette.waitPair.dark, .reading: LiveActivityPalette.waitPair.dark,
      .prompt: LiveActivityPalette.waitPair.dark, .muted: LiveActivityPalette.errPair.dark,
      .dictating: LiveActivityPalette.newPair.dark, .sending: LiveActivityPalette.waitPair.dark,
      .notSent: LiveActivityPalette.errPair.dark, .unconfirmed: LiveActivityPalette.errPair.dark,
    ]
    for phase in State.Phase.allCases {
      #expect(VoiceActivityPresentation(Self.state(Self.kind(of: phase), phase)).tint == tones[phase], "\(phase)")
    }
    let listening = VoiceActivityPresentation(Self.state(.conversation, .listening)).symbol
    #expect(VoiceActivityPresentation(Self.state(.dictation, .dictating)).symbol != listening)
    #expect(VoiceActivityPresentation(Self.state(.conversation, .muted)).symbol != listening)
  }

  /// Catches a dictation that offers only Stop (no way to send from the tile), a conversation that gains Send, and a
  /// tile that keeps a button while it sends or after it failed (a second press would send or stop nothing).
  @Test("controls: a conversation has End, a dictation Stop and Send, sending and its outcomes none")
  func controls() {
    #expect(VoiceActivityPresentation(Self.state(.conversation, .working)).controls == .end)
    let dictating = VoiceActivityPresentation(Self.state(.dictation, .dictating))
    #expect(dictating.controls == .stopAndSend)
    #expect(dictating.endWord == L("voiceActivity.stop"))
    #expect(dictating.sendWord == L("voiceActivity.send"))
    for phase in [State.Phase.sending, .notSent, .unconfirmed] {
      #expect(VoiceActivityPresentation(Self.state(.dictation, phase)).controls == .none, "\(phase)")
    }
  }

  /// Catches a send tile that loses the session it sends to, and an outcome tile that names the session instead of
  /// pointing to the app (the text may stand in the field, a draft or the send queue): sending keeps the dictation's
  /// subject, both failures say only "Check the app".
  @Test("sending keeps the session's names; not sent and not confirmed say Check the app")
  func sendWordsAndSubjects() {
    let sending = VoiceActivityPresentation(Self.state(.dictation, .sending, project: "atlas", name: "demo"))
    #expect(sending.phaseWord == L("voiceActivity.phase.sending"))
    #expect(sending.subjectLine == LiveActivityPresentation.list(["atlas", "demo"], .dot))
    let notSent = VoiceActivityPresentation(Self.state(.dictation, .notSent, project: "atlas", name: "demo"))
    #expect(notSent.phaseWord == L("voiceActivity.phase.notSent"))
    #expect(notSent.subjectLine == L("voiceActivity.subject.checkTheApp"))
    let unconfirmed = VoiceActivityPresentation(Self.state(.dictation, .unconfirmed, project: "atlas", name: "demo"))
    #expect(unconfirmed.phaseWord == L("voiceActivity.phase.unconfirmed"))
    #expect(unconfirmed.subjectLine == L("voiceActivity.subject.checkTheApp"))
    #expect(
      unconfirmed.spoken
        == LiveActivityPresentation.list(
          [unconfirmed.kindWord, unconfirmed.phaseWord, L("voiceActivity.subject.checkTheApp")], .comma))
  }

  /// Catches a send tile that still says "Sending…" after the app's process stopped before the outcome: once the
  /// state is stale, sending shows exactly what "Not confirmed" shows. Catches also a stale flag that changes a tile
  /// with nothing pending.
  @Test("a stale sending tile shows not confirmed; stale changes no other phase")
  func staleSending() {
    let stale = VoiceActivityPresentation(
      Self.state(.dictation, .sending, project: "atlas", name: "demo"), isStale: true)
    let unconfirmed = VoiceActivityPresentation(Self.state(.dictation, .unconfirmed, project: "atlas", name: "demo"))
    #expect(stale.phase == .unconfirmed)
    #expect(stale.phaseWord == unconfirmed.phaseWord)
    #expect(stale.subjectLine == unconfirmed.subjectLine)
    #expect(stale.tint == unconfirmed.tint)
    #expect(stale.symbol == unconfirmed.symbol)
    #expect(stale.spoken == unconfirmed.spoken)
    #expect(stale.controls == unconfirmed.controls)
    for phase in State.Phase.allCases where phase != .sending {
      let state = Self.state(Self.kind(of: phase), phase, project: "atlas", name: "demo")
      #expect(VoiceActivityPresentation(state, isStale: true) == VoiceActivityPresentation(state), "\(phase)")
    }
  }
}
