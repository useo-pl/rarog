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
      .dictating: LiveActivityPalette.newPair.dark,
    ]
    for phase in State.Phase.allCases {
      let kind: State.Kind = phase == .dictating ? .dictation : .conversation
      #expect(VoiceActivityPresentation(Self.state(kind, phase)).tint == tones[phase], "\(phase)")
    }
    let listening = VoiceActivityPresentation(Self.state(.conversation, .listening)).symbol
    #expect(VoiceActivityPresentation(Self.state(.dictation, .dictating)).symbol != listening)
    #expect(VoiceActivityPresentation(Self.state(.conversation, .muted)).symbol != listening)
  }
}
