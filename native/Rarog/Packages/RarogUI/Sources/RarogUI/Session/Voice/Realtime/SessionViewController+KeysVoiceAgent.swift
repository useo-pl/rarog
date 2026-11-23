#if os(iOS)
import UIKit

// ⌥⌘V (`AppShortcut.voiceAgent`) starts and ends the voice conversation by the same path as the voice agent button
// (`toggleVoiceAgent`). It is registered only where the button stands or a conversation runs (`VoiceAgentKey`), so a
// server without the voice agent leaves it out of the iPadOS menu bar. Owner: voice agent.

extension SessionViewController {
  var voiceAgentKeyCommands: [UIKeyCommand] {
    guard let key = voiceAgentKey() else { return [] }
    let title = key == .end ? UICopy.voiceAgentEndButton : UICopy.voiceAgentButton
    let command = UIKeyCommand(
      title: title, action: #selector(toggleVoiceAgentShortcut), input: AppShortcut.voiceAgent.input,
      modifierFlags: AppShortcut.voiceAgent.keyModifierFlags)
    command.discoverabilityTitle = title
    command.wantsPriorityOverSystemBehavior = true
    // A held key is not a second toggle (start, end, start again).
    command.repeatBehavior = .nonRepeatable
    return [command]
  }

  /// `nil` = not the voice agent's action. List in the controller's `canPerformAction`.
  func voiceAgentKeyVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(toggleVoiceAgentShortcut) else { return nil }
    let key = voiceAgentKey()
    return key == .start || key == .end
  }

  private func voiceAgentKey() -> VoiceAgentKey? {
    VoiceAgentKey.make(
      entry: voiceAgentEntry(store.state), active: voiceAgentChrome.session?.isActive == true,
      fieldShown: !composer.isHidden)
  }

  @objc private func toggleVoiceAgentShortcut() {
    toggleVoiceAgent()
  }
}
#endif
