import Foundation

// Setup steps for a feature the server does not offer yet: numbered steps for the person who runs the server, the
// server commands as plain constants and a link to the provider's page. The app never takes a key: the permanent key
// stays on the server, so these pages only say where to get one and which command saves it. Used by the Dictation
// page (Soniox unavailable) and the Voice Agent page (not set up); drawn by `ServerSetupStepsView`. Plain values,
// without SwiftUI, so `swift test` checks them on macOS. Owner: settings.

/// Commands the person who runs the server types there. Commands, not copy: the same in every language.
enum ServerCommand {
  static let dictationSetKey = "rarog dictation set-key"
  static let voiceAgentSetKey = "rarog voice-agent set-key"
  static let restart = "rarog restart"
}

/// One step: a sentence and, for the step on the server, the commands to run in order.
struct ServerSetupStep: Equatable, Sendable {
  let text: String
  var commands: [String] = []
}

/// The steps in order and the link to the provider's page where the key comes from.
struct ServerSetupSteps: Equatable, Sendable {
  let steps: [ServerSetupStep]
  let linkLabel: String
  let linkURL: URL

  /// Every text on screen, commands included.
  var texts: [String] { steps.flatMap { [$0.text] + $0.commands } + [linkLabel] }
}
