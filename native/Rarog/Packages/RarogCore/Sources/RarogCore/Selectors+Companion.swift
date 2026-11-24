import Foundation
import RarogContract

// Whether the app offers the voice agent and its mode across sessions: one definition for RarogCore and RarogUI
// (`VoiceAgentAvailability` there calls ``AppState/voiceAgentOffered(sonioxAllowed:)``). Owner: voice agent.
extension AppState {
  /// The voice agent is offered: the server announces it (`companionEnabled` in `/api/version`) with Soniox speech
  /// (`companionSpeech`), and the build has Soniox (`sonioxAllowed`, `RAROG_VOICE_SONIOX`). Soniox speaks every answer
  /// and there is no OpenAI voice, so without Soniox there is no voice agent. A missing field, or no answer from the
  /// server yet, reads as false.
  public func voiceAgentOffered(sonioxAllowed: Bool) -> Bool {
    guard let capabilities else { return false }
    return sonioxAllowed && capabilities.companion && capabilities.companionSpeech
  }

  /// The mode across sessions is offered: the voice agent itself is offered (``voiceAgentOffered(sonioxAllowed:)``)
  /// and the server's version answer has `companionSessions` and the capability `companion-sessions`
  /// (``Capabilities/companionSessions``). Any part missing, or no answer from the server yet, reads as false.
  public func companionSessionsOffered(sonioxAllowed: Bool) -> Bool {
    voiceAgentOffered(sonioxAllowed: sonioxAllowed) && capabilities?.companionSessions == true
  }
}
