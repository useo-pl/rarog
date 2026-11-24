import Foundation
@testable import RarogUI
import Testing

// The voice conversation across sessions as its views show it, without a view (`VoiceAgentSessionsBarContent`):
// whether anything stands, a tap that removes only the end sentence, the waiting prompt's card. The content over a
// real owner: `VoiceAgentSessionsConversationTests`. Owner: voice agent.

@Suite("voice conversation across sessions: the content its views show")
struct VoiceAgentSessionsBarContentTests {
  @Test("nothing without a conversation and without an end sentence")
  func hidden() {
    #expect(VoiceAgentSessionsBarContent.make(isActive: false, indicator: nil) == nil)
  }

  @Test("a running conversation: its state",
    arguments: [VoiceAgentIndicator.connecting, .listening, .thinking, .answering, .muted])
  func running(indicator: VoiceAgentIndicator) throws {
    let content = try #require(VoiceAgentSessionsBarContent.make(isActive: true, indicator: indicator))
    #expect(content.indicator == indicator && content.running)
  }

  @Test("a running conversation without a state yet shows connecting")
  func runningWithoutState() {
    #expect(
      VoiceAgentSessionsBarContent.make(isActive: true, indicator: nil)
        == VoiceAgentSessionsBarContent(indicator: .connecting, running: true))
  }

  // Catches: a card that names the wrong place or swaps project and session, a text that is trimmed or changed
  // before the person confirms it, and a prompt card left on an end sentence.
  @Test("a waiting prompt: the card's caption and VoiceOver label name its place; an end sentence shows none")
  func waitingPrompt() throws {
    let text = "  Run the **tests** again\nthen report\n\n`only` the failures  "
    let prompt = VoiceAgentShownPrompt(project: "orbit", name: "Alpha", text: text)
    let running = try #require(VoiceAgentSessionsBarContent.make(isActive: true, indicator: .listening, prompt: prompt))
    #expect(running.prompt?.text == text)
    #expect(running.stripPromptCaption?.tail == UICopy.list(["", "orbit", "Alpha"], .dot))
    #expect(running.promptSpokenLabel == UICopy.voiceAgentSessionsBarPromptSpoken(project: "orbit", name: "Alpha"))
    let plain = try #require(VoiceAgentSessionsBarContent.make(isActive: true, indicator: .listening))
    #expect(plain.prompt == nil && plain.stripPromptCaption == nil && plain.promptSpokenLabel == nil)
    let ended = try #require(
      VoiceAgentSessionsBarContent.make(isActive: false, indicator: .closed(.background), prompt: prompt))
    #expect(ended.prompt == nil && ended.stripPromptCaption == nil)
  }

  @Test("an end sentence: its state, not running",
    arguments: [VoiceAgentIndicator.closed(.background), .closed(.disabled), .ended(.speechFailed)])
  func ended(indicator: VoiceAgentIndicator) throws {
    let content = try #require(VoiceAgentSessionsBarContent.make(isActive: false, indicator: indicator))
    #expect(content.indicator == indicator && !content.running)
  }
}
