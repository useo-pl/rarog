import Foundation

// The state of the voice conversation across sessions as its views show it, without a view. Owner: voice agent. The
// list header, the session screen's header, the Inbox's header and what stands above the screen
// (`VoiceAgentSessionsPlacement`) read it; this rule decides whether there is anything to show, whether it is a
// running state or an end sentence, and what the card of the waiting prompt says, so `swift test` checks it on macOS
// (`VoiceAgentSessionsBarContentTests`).

/// The conversation's content: the state of the running conversation, or its end sentence that a tap removes.
struct VoiceAgentSessionsBarContent: Sendable, Equatable {
  /// The state; its sentence comes from the same source as the status row of the conversation at a session
  /// (`UICopy.voiceAgentStatus`).
  let indicator: VoiceAgentIndicator
  /// A conversation runs or its opening list is read: the lit circle stands and ends it.
  let running: Bool
  /// The prompt `show_prompt` bound that waits for the user's spoken word: its card shows where it goes and its
  /// exact text.
  var prompt: VoiceAgentShownPrompt? = nil

  /// The VoiceOver label of the prompt card; the whole text is its value.
  var promptSpokenLabel: String? {
    prompt.map { UICopy.voiceAgentSessionsBarPromptSpoken(project: $0.project, name: $0.name) }
  }

  /// `nil` = nothing to show: no conversation and no end sentence. A running conversation without a state yet shows
  /// connecting; only a running conversation shows a waiting prompt.
  static func make(
    isActive: Bool, indicator: VoiceAgentIndicator?, prompt: VoiceAgentShownPrompt? = nil
  ) -> VoiceAgentSessionsBarContent? {
    if isActive {
      return VoiceAgentSessionsBarContent(indicator: indicator ?? .connecting, running: true, prompt: prompt)
    }
    guard let indicator else { return nil }
    return VoiceAgentSessionsBarContent(indicator: indicator, running: false)
  }

  /// The content of `owner` now.
  @MainActor
  static func of(_ owner: VoiceAgentSessionsConversation) -> VoiceAgentSessionsBarContent? {
    make(isActive: owner.isActive, indicator: owner.indicator, prompt: owner.prompt)
  }
}
