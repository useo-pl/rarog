import Foundation

// The seam between the voice conversation core (`VoiceAgentSession` with its `RealtimeConversation`) and what the
// conversation is about. Owner: voice agent. A host gives the content, the tools and the end rules; the core keeps
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
}
