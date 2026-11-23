import Foundation

// What the voice conversation shows in the session screen, without a view: the state of the status row and the
// voice agent button (`VoiceAgentIndicator`) and who owns the status row (`VoiceStatusOwner`). Owner: voice agent.
// Sentences: `UICopy.voiceAgentStatus`; tests: `VoiceAgentIndicatorTests`.

/// State of the conversation for the status row and the button. Sentences stand in the view, colors in `Palette`.
enum VoiceAgentIndicator: Sendable, Equatable {
  case connecting
  /// Listening, no speech detected.
  case listening
  /// Speech detected (`speech_started` → `speech_stopped`).
  case hearing
  case thinking
  /// `ask_session` runs; seconds since it started.
  case checkingSession(seconds: Int)
  case answering
  /// `show_prompt` just wrote a prompt into the field.
  case promptInField
  /// The field was sent to the session (3 s).
  case sent
  /// The composer mic muted the conversation where it would listen or hear (`VoiceAgentSession.toggleMute`).
  case muted
  /// The conversation ended by itself with a reason (no row for `.closed`).
  case ended(RealtimeConversation.End)
  /// A change in the app closed the conversation.
  case closed(VoiceAgentWatch.Reason)

  /// `Palette` color of the dot and the filled button.
  enum Tone: Sendable, Equatable {
    case wait, run, new, err
  }

  /// Which level moves the bars of the button and the dot.
  enum Motion: Sendable, Equatable {
    case none, microphone, output
  }

  var tone: Tone {
    switch self {
    case .connecting, .thinking, .checkingSession: .wait
    case .listening, .hearing, .promptInField, .sent: .run
    case .answering: .new
    // Muted: the color of the lit composer mic (`VoiceButtons`), like dictation's recording.
    case .muted, .ended, .closed: .err
    }
  }

  var motion: Motion {
    switch self {
    case .listening, .hearing, .promptInField, .sent: .microphone
    case .answering: .output
    case .connecting, .thinking, .checkingSession, .muted, .ended, .closed: .none
    }
  }

  /// The conversation runs (the button is filled and ends it); otherwise only the end sentence stands.
  var isActive: Bool {
    switch self {
    case .ended, .closed: false
    default: true
    }
  }

  /// The end sentence asks for the system settings (microphone permission denied).
  var opensSettings: Bool { self == .ended(.microphone(.denied)) }

  /// The same sentence for the screen reader: the seconds counter does not count as a change.
  func sameSentence(as other: VoiceAgentIndicator?) -> Bool {
    switch (self, other) {
    case (.checkingSession, .checkingSession?): true
    default: self == other
    }
  }

  /// The indicator for the conversation state. `transient`: a short state over listening (prompt in the field,
  /// sent); `closedBy`: a change in the app ended the conversation; `muted`: the composer mic muted the
  /// conversation, which shows where it would listen or hear; `nil` = no row.
  static func make(
    phase: RealtimeConversation.Phase, hearing: Bool, muted: Bool = false, transient: Transient?,
    closedBy: VoiceAgentWatch.Reason?, checkingSeconds: Int
  ) -> VoiceAgentIndicator? {
    switch phase {
    case .idle: return closedBy.map(VoiceAgentIndicator.closed)
    case let .ended(end):
      if let closedBy { return .closed(closedBy) }
      return end == .closed ? nil : .ended(end)
    case .connecting: return .connecting
    case .thinking: return .thinking
    case .checkingSession: return .checkingSession(seconds: checkingSeconds)
    case .speaking: return .answering
    case .listening:
      if hearing, !muted { return .hearing }
      switch transient {
      case .sent?: return .sent
      case .promptInField?: return .promptInField
      case nil: return muted ? .muted : .listening
      }
    }
  }

  /// Short states over listening; each one has its own number in `VoiceAgentSession`, so an old timer does not
  /// clear a newer state.
  enum Transient: Sendable, Equatable {
    case promptInField
    case sent
  }
}

/// One owner of the status row of the message field. Dictation and the conversation exclude each other (one
/// microphone, `DictationCenter`), but an end sentence of either can stand while the other starts.
enum VoiceStatusOwner: Sendable, Equatable {
  case dictation
  case voiceAgent(VoiceAgentIndicator)
  case none

  /// A running conversation owns the row; an end sentence of the conversation gives way to dictation's own text.
  static func pick(dictationText: String, agent: VoiceAgentIndicator?) -> VoiceStatusOwner {
    if let agent, agent.isActive { return .voiceAgent(agent) }
    if !dictationText.isEmpty { return .dictation }
    if let agent { return .voiceAgent(agent) }
    return .none
  }

  /// A field edit clears notices (`ComposerDictation.noticeEdit`): the end sentence of the conversation goes, the
  /// state of a running conversation stays.
  static func afterEdit(_ agent: VoiceAgentIndicator?) -> VoiceAgentIndicator? {
    guard let agent, agent.isActive else { return nil }
    return agent
  }
}

/// Five bars of the voice agent button during a conversation (`SessionViewController+VoiceAgent.swift`): heights in
/// points from the level, fast up and slowly down like the dictation dot (the fall comes with the levels,
/// `RealtimeLevels.next`). With reduced motion they stand still and the color and the sentence carry the state.
enum VoiceAgentBars {
  static let shape: [Double] = [0.45, 0.8, 1, 0.8, 0.45]
  /// Bars of a state without motion (connecting, thinking, checking the session).
  static let rest: [Double] = [4, 8, 12, 8, 4]
  /// Bars of a state with motion when the system reduces motion.
  static let still: [Double] = [6, 10, 14, 10, 6]
  static let maxHeight = 16.0
  static let minHeight = 3.0
  /// Peaks of speech rarely pass 0.4, so the gain makes ordinary speech fill the bars.
  static let gain = 2.5

  static func heights(level: Double, motion: VoiceAgentIndicator.Motion, reduceMotion: Bool) -> [Double] {
    if motion == .none { return rest }
    if reduceMotion { return still }
    let level = min(1, max(0, level))
    return shape.map { minHeight + (maxHeight - minHeight) * level * $0 }
  }

  /// The level of the moving side with the gain, 0…1: the microphone while listening, the playing output while
  /// answering.
  static func level(_ levels: RealtimeLevels, motion: VoiceAgentIndicator.Motion) -> Double {
    let side: Float =
      switch motion {
      case .microphone: levels.input
      case .output: levels.output
      case .none: 0
      }
    return min(1, Double(side) * gain)
  }
}
