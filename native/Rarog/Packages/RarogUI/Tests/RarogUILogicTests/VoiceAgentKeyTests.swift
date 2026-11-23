import Foundation
@testable import RarogUI
import Testing

// ⌥⌘V at a session (`VoiceAgentKey`): the same as a tap on the voice agent button, and not registered where the
// button does not stand, so the shortcut list does not name the voice agent there. Owner: voice agent.

@Suite("⌥⌘V starts and ends the voice conversation like the button")
struct VoiceAgentKeyTests {
  @Test(
    "the shortcut follows the button: hidden = not registered, dimmed = stands without action, a conversation = end",
    arguments: [
      (VoiceAgentEntry.hidden, false, VoiceAgentKey?.none),
      (.disabled, false, .unavailable),
      (.enabled, false, .start),
      (.hidden, true, .end),
      (.disabled, true, .end),
      (.enabled, true, .end),
    ])
  func followsButton(entry: VoiceAgentEntry, active: Bool, key: VoiceAgentKey?) {
    #expect(VoiceAgentKey.make(entry: entry, active: active, fieldShown: true) == key)
  }

  @Test("a decision card hides the field: no start by the shortcut, but a running conversation still ends")
  func hiddenField() {
    #expect(VoiceAgentKey.make(entry: .enabled, active: false, fieldShown: false) == nil)
    #expect(VoiceAgentKey.make(entry: .disabled, active: false, fieldShown: false) == nil)
    #expect(VoiceAgentKey.make(entry: .enabled, active: true, fieldShown: false) == .end)
  }

  @Test("⌥⌘V lives on the session screen next to ⌥⌘M and shares no combination there")
  func combination() {
    #expect(AppShortcut.voiceAgent.glyphs == "⌥⌘V")
    #expect(AppShortcut.voiceAgent.scopes == [.session])
    for other in AppShortcut.allCases where other != .voiceAgent && other.overlaps(.voiceAgent) {
      #expect(other.key != AppShortcut.voiceAgent.key || other.modifiers != AppShortcut.voiceAgent.modifiers)
    }
  }
}
