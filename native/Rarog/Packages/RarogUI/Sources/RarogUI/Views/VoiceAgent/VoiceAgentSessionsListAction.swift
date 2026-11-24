import Foundation
import RarogCore

// What the session list button of the voice conversation across sessions does. Owner: voice agent. Without UIKit, so
// `swift test` checks it on macOS (`VoiceAgentSessionsConversationTests`); the button: `NewSessionListButton.swift`.
// The owner's entry rule (`VoiceAgentSessionsEntry`) decides between no button, the consent and a start; while a
// conversation runs (or its opening list is read) the button is the lit circle that ends it, also where the mode
// stopped being offered and the conversation has not ended yet (`VoiceAgentSessionsListHeader`).

/// The list button now.
enum VoiceAgentSessionsListAction: Sendable, Equatable {
  /// No button: the mode is not offered.
  case hidden
  /// A tap opens the consent sheet (`AppSheet.voiceAgentSessionsConsent`).
  case consent
  /// A tap starts the conversation.
  case start
  /// A conversation runs: the button is the lit circle, and a tap ends the conversation.
  case running

  static func make(entry: VoiceAgentSessionsEntry, isActive: Bool) -> VoiceAgentSessionsListAction {
    if isActive { return .running }
    return switch entry {
    case .hidden: .hidden
    case .consent: .consent
    case .start: .start
    }
  }

  /// The button of `owner` now.
  @MainActor
  static func of(_ owner: VoiceAgentSessionsConversation) -> VoiceAgentSessionsListAction {
    make(entry: owner.entry, isActive: owner.isActive)
  }

  /// Whether the list bar shows the button of `owner`, the glyph or the lit circle (no owner: neither). The list
  /// header keeps room for it and New Session spaces its glyph by it.
  @MainActor
  static func shows(_ owner: VoiceAgentSessionsConversation?) -> Bool {
    owner.map { of($0) != .hidden } ?? false
  }

  /// A tap on the button: the consent sheet, a start, or the end of the running conversation.
  @MainActor
  static func tap(_ owner: VoiceAgentSessionsConversation, navigation: RarogNavigation) {
    switch of(owner) {
    case .hidden:
      return
    case .consent:
      navigation.openVoiceAgentSessionsConsent()
    case .start:
      Task { await owner.start() }
    case .running:
      owner.end()
    }
  }
}
