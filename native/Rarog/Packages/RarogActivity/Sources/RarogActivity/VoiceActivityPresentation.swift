import Foundation

// Copy, colour and glyph of the voice Live Activity from its state, outside `#if os(iOS)` so the macOS tests run it
// (`VoiceActivityPresentationTests`). The views stand in `VoiceActivityViews.swift`. Owner: voice agent.

/// What the voice Live Activity shows for one state.
public struct VoiceActivityPresentation: Sendable, Equatable {
  public typealias State = VoiceActivityAttributes.ContentState

  /// The buttons the tile and the expanded Dynamic Island offer.
  public enum Controls: Sendable, Equatable {
    /// One End capsule: a voice conversation.
    case end
    /// Stop and Send, two round icon buttons: a dictation that records.
    case stopAndSend
    /// None: a dictation that is being sent or whose send failed.
    case none
  }

  public let state: State
  /// The phase the activity shows: the state's, except a stale ``State/Phase/sending``, which shows
  /// ``State/Phase/unconfirmed``. The state of a send carries a stale date, and the system marks it stale also when
  /// the app's process stopped before the outcome, so the tile does not keep saying "Sending…".
  public let phase: State.Phase
  /// What records: "Voice agent" or "Dictation" (the small line before the timer).
  public let kindWord: String
  /// The kind word with the tile's separator, before the timer: "Voice agent · ".
  public let lead: String
  /// What the recording does (the large word).
  public let phaseWord: String
  /// What the recording is about, one muted line: "All sessions", the session's project and name joined by the
  /// tile's dot, or "One session" for a session the app cannot name; a waiting prompt puts "Say yes or no" first, so
  /// a long name is what the line cuts. A failed or unconfirmed send says "Check the app" alone.
  public let subjectLine: String
  /// The button that ends the recording, also its VoiceOver label: End for a conversation, Stop for a dictation (its
  /// text stays in the field).
  public let endWord: String
  /// VoiceOver label of a dictation's Send button.
  public let sendWord: String
  /// The buttons this phase offers.
  public let controls: Controls
  /// VoiceOver label of the text part: the kind, the phase and the subject in words.
  public let spoken: String
  /// SF Symbol of the glyph in the tinted circle.
  public let symbol: String
  /// Colour of the phase in the dark theme the activity is pinned to, the tones of the app's voice agent status:
  /// green while it listens (`runPair`), blue while it answers and for a dictation (`newPair`), amber while it works,
  /// reads a session, a prompt waits for the user's word or a dictation is being sent (`waitPair`), red while muted
  /// and when a send failed or was not confirmed (`errPair`).
  public let tint: UInt32

  /// `isStale` is the system's flag of the shown content (`context.isStale` in the widget extension).
  public init(_ state: State, isStale: Bool = false) {
    self.state = state
    let phase: State.Phase = isStale && state.phase == .sending ? .unconfirmed : state.phase
    self.phase = phase
    sendWord = L("voiceActivity.send")
    switch state.kind {
    case .conversation:
      kindWord = L("voiceActivity.kind.conversation")
      endWord = L("voiceActivity.end")
    case .dictation:
      kindWord = L("voiceActivity.kind.dictation")
      endWord = L("voiceActivity.stop")
    }
    switch (phase, state.kind) {
    case (.sending, _), (.notSent, _), (.unconfirmed, _): controls = .none
    case (_, .conversation): controls = .end
    case (_, .dictation): controls = .stopAndSend
    }
    switch phase {
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
    case .sending:
      phaseWord = L("voiceActivity.phase.sending")
      symbol = "arrow.up"
      tint = LiveActivityPalette.waitPair.dark
    case .notSent:
      phaseWord = L("voiceActivity.phase.notSent")
      symbol = "exclamationmark"
      tint = LiveActivityPalette.errPair.dark
    case .unconfirmed:
      phaseWord = L("voiceActivity.phase.unconfirmed")
      symbol = "questionmark"
      tint = LiveActivityPalette.errPair.dark
    }
    let subject = Self.subjectParts(state, phase: phase)
    subjectLine = LiveActivityPresentation.list(subject, .dot)
    lead = kindWord + L("liveActivity.list.dot")
    spoken = LiveActivityPresentation.list([kindWord, phaseWord] + subject, .comma)
  }

  /// The parts of the subject line: the answer a waiting prompt asks for, then what the recording is about. A failed
  /// send points to the app instead: its text may stand in the message field, a draft or the send queue.
  private static func subjectParts(_ state: State, phase: State.Phase) -> [String] {
    if phase == .notSent || phase == .unconfirmed { return [L("voiceActivity.subject.checkTheApp")] }
    var parts: [String]
    switch state.scope {
    case .allSessions:
      parts = [L("voiceActivity.subject.allSessions")]
    case .session:
      parts = [state.project, state.name].compactMap { $0 }
      if parts.isEmpty { parts = [L("voiceActivity.subject.oneSession")] }
    }
    if phase == .prompt { parts.insert(L("voiceActivity.subject.sayYesOrNo"), at: 0) }
    return parts
  }
}
