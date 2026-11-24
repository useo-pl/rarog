import Foundation

// The seam between the voice conversation core (`VoiceAgentSession` with its `RealtimeConversation`) and what the
// conversation is about. Owner: voice agent. A host gives the content, the tools and the end rules, and may follow
// the answers (a spoken answer heard to its end, a cut); the core keeps
// the keys, the audio, the socket, the prompt confirmation lock, the login check, the indicator and the `client.log`
// lines. The session screen's host is `VoiceAgentSessionHost`.

@MainActor
protocol VoiceAgentHost: AnyObject {
  /// The instructions, the later content and the tools of the conversation; read once, when the core is built.
  func content() -> RealtimeConversation.Content
  /// Why the conversation must not start now (`nil`: it starts). The end rules count from this moment.
  func startRefusal() -> VoiceAgentWatch.Reason?
  /// Why a running conversation ends now (`nil`: it goes on). The core asks only while the conversation runs.
  func endReason() -> VoiceAgentWatch.Reason?
  /// A spoken answer without a tool call played out whole, or speech cut what was in flight
  /// (`RealtimeConversation+Answer.swift`). A host that does not need it keeps the default, which does nothing.
  func answer(_ event: RealtimeConversation.AnswerEvent)
  /// A sound over an answer that plays opened the noise window at `utterances` kept utterances of the user
  /// (`RealtimeConversation+Noise.swift`). The default does nothing.
  func soundOverAnswer(utterances: Int)
  /// What the conversation is about, for the app's microphone (`MicrophoneUse.subject`): all sessions, or one session
  /// by its project and name as the app shows them. The default names no session. An owner whose host changes it
  /// tells the core (`VoiceAgentSession.reportUse()`).
  var microphoneSubject: MicrophoneSubject { get }
  /// A prompt the host showed waits for the user's spoken word (`MicrophonePhase.prompt`); the default: none. The
  /// core's own prompt in the message field counts without it.
  var promptWaits: Bool { get }
}

extension VoiceAgentHost {
  func answer(_ event: RealtimeConversation.AnswerEvent) {}
  func soundOverAnswer(utterances: Int) {}
  var microphoneSubject: MicrophoneSubject { .session(project: nil, name: nil) }
  var promptWaits: Bool { false }
}
