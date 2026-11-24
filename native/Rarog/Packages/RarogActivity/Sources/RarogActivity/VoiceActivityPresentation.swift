import Foundation

// Copy, colour and glyph of the voice Live Activity from its state, outside `#if os(iOS)` so the macOS tests run it
// (`VoiceActivityPresentationTests`). The views stand in `VoiceActivityViews.swift`. Owner: voice agent.

/// What the voice Live Activity shows for one state.
public struct VoiceActivityPresentation: Sendable, Equatable {
  public typealias State = VoiceActivityAttributes.ContentState

  public let state: State
  /// What records: "Voice agent" or "Dictation" (the small line before the timer).
  public let kindWord: String
  /// The kind word with the tile's separator, before the timer: "Voice agent · ".
  public let lead: String
  /// What the recording does (the large word).
  public let phaseWord: String
  /// What the recording is about, one muted line: "All sessions", the session's project and name joined by the
  /// tile's dot, or "One session" for a session the app cannot name; a waiting prompt puts "Say yes or no" first, so
  /// a long name is what the line cuts.
  public let subjectLine: String
  /// The button: End for a conversation, Stop for a dictation (its text stays in the field).
  public let endWord: String
  /// VoiceOver label of the text part: the kind, the phase and the subject in words.
  public let spoken: String
  /// SF Symbol of the glyph in the tinted circle.
  public let symbol: String
  /// Colour of the phase in the dark theme the activity is pinned to, the tones of the app's voice agent status:
  /// green while it listens (`runPair`), blue while it answers and for a dictation (`newPair`), amber while it works,
  /// reads a session or a prompt waits for the user's word (`waitPair`), red while muted (`errPair`).
  public let tint: UInt32

  public init(_ state: State) {
    self.state = state
    switch state.kind {
    case .conversation:
      kindWord = L("voiceActivity.kind.conversation")
      endWord = L("voiceActivity.end")
    case .dictation:
      kindWord = L("voiceActivity.kind.dictation")
      endWord = L("voiceActivity.stop")
    }
    switch state.phase {
    case .listening:
      phaseWord = L("voiceActivity.phase.listening")
      symbol = "waveform"
      tint = LiveActivityPalette.runPair.dark
    case .answering:
      phaseWord = L("voiceActivity.phase.answering")
      symbol = "waveform"
      tint = LiveActivityPalette.newPair.dark
    case .working:
      phaseWord = L("voiceActivity.phase.working")
      symbol = "ellipsis"
      tint = LiveActivityPalette.waitPair.dark
    case .reading:
      phaseWord = L("voiceActivity.phase.reading")
      symbol = "ellipsis"
      tint = LiveActivityPalette.waitPair.dark
    case .prompt:
      phaseWord = L("voiceActivity.phase.prompt")
      symbol = "waveform"
      tint = LiveActivityPalette.waitPair.dark
    case .muted:
      phaseWord = L("voiceActivity.phase.muted")
      symbol = "mic.slash.fill"
      tint = LiveActivityPalette.errPair.dark
    case .dictating:
      phaseWord = L("voiceActivity.phase.dictating")
      symbol = "mic.fill"
      tint = LiveActivityPalette.newPair.dark
    }
    let subject = Self.subjectParts(state)
    subjectLine = LiveActivityPresentation.list(subject, .dot)
    lead = kindWord + L("liveActivity.list.dot")
    spoken = LiveActivityPresentation.list([kindWord, phaseWord] + subject, .comma)
  }

  /// The parts of the subject line: the answer a waiting prompt asks for, then what the recording is about.
  private static func subjectParts(_ state: State) -> [String] {
    var parts: [String]
    switch state.scope {
    case .allSessions:
      parts = [L("voiceActivity.subject.allSessions")]
    case .session:
      parts = [state.project, state.name].compactMap { $0 }
      if parts.isEmpty { parts = [L("voiceActivity.subject.oneSession")] }
    }
    if state.phase == .prompt { parts.insert(L("voiceActivity.subject.sayYesOrNo"), at: 0) }
    return parts
  }
}
