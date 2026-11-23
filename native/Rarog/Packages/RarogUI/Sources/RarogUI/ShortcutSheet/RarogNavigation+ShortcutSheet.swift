import Foundation
import RarogCore

// The inputs of the shortcut sheet that navigation and the app state know: where the focus is and what the app
// offers (`ShortcutSheetContent`). Owner: shortcuts.

extension RarogNavigation {
  /// Where the focus is: a form → window; the terminal window → terminal; another sheet → window (also the history
  /// over a terminal tab: the sheet owns the keys); a terminal on screen → terminal; a session on screen → session;
  /// otherwise no place (a project screen, nothing selected).
  public func shortcutSheetPlace(_ state: AppState) -> ShortcutSheetPlace? {
    if sheet?.isForm == true { return .window }
    if popup != nil { return .terminal }
    if sheet != nil { return .window }
    if terminalRoute(state) != nil { return .terminal }
    if selectedSessionId != nil { return .session }
    return nil
  }

  /// What the app offers now. `voiceAgentEnabled`: the voice agent setting of the app; `sonioxAllowed`: the build
  /// has Soniox (``VoiceAgentAvailability``).
  public func shortcutSheetCapabilities(
    _ state: AppState, voiceAgentEnabled: Bool, sonioxAllowed: Bool
  ) -> ShortcutSheetCapabilities {
    ShortcutSheetCapabilities(
      notes: state.notesAvailable,
      terminal: state.terminalFeature == .on,
      voiceAgent: voiceAgentEnabled && VoiceAgentAvailability.offered(state: state, sonioxAllowed: sonioxAllowed),
      wideIPad: inspector.eligible)
  }
}
