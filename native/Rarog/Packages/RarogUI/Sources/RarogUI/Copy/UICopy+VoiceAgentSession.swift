import Foundation
import RarogContract
import RarogCore

// Copy of the voice conversation at a session: the button in the message field's control row, the status row of
// the field (`VoiceAgentIndicator`) and the end sentences. Settings and consent: `UICopy+VoiceAgent.swift`.

extension UICopy {
  static var voiceAgentButton: String { L("voiceAgent.call.button") }
  static var voiceAgentEndButton: String { L("voiceAgent.call.button.end") }
  static var voiceAgentDictating: String { L("voiceAgent.call.dictating") }
  /// The composer mic during a conversation: mute it, or turn it back on.
  static var voiceAgentMute: String { L("voiceAgent.call.mute") }
  static var voiceAgentUnmute: String { L("voiceAgent.call.unmute") }

  // MARK: Status row

  /// The sentence of the status row; ended states give the end sentence (``voiceAgentEnd(_:)``,
  /// ``voiceAgentClosed(_:)``).
  static func voiceAgentStatus(_ indicator: VoiceAgentIndicator) -> String {
    switch indicator {
    case .connecting: L("voiceAgent.call.phase.connecting")
    case .listening: L("voiceAgent.call.phase.listening")
    case .hearing: L("voiceAgent.call.status.hearing")
    case .thinking: L("voiceAgent.call.phase.thinking")
    case let .checkingSession(seconds): L("voiceAgent.call.status.checking", seconds)
    case .answering: L("voiceAgent.call.status.answering")
    case .promptInField: L("voiceAgent.call.status.prompt")
    case .sent: L("voiceAgent.call.status.sent")
    case .muted: L("voiceAgent.call.status.muted")
    case let .ended(end): voiceAgentEnd(end)
    case let .closed(reason): voiceAgentClosed(reason)
    }
  }

  /// Why the conversation ended or did not start. A wrong or missing key points to the command on the Mac.
  static func voiceAgentEnd(_ end: RealtimeConversation.End) -> String {
    switch end {
    case .closed: L("voiceAgent.call.end.closed")
    case .keyMissing: L("voiceAgent.call.end.keyMissing")
    case .keyRejected: L("voiceAgent.call.end.keyRejected")
    case .openAILimit: L("voiceAgent.call.end.openAILimit")
    case .throttled: L("voiceAgent.call.end.throttled")
    case .unavailable: L("voiceAgent.call.end.unavailable")
    case .instructionsTooLong: L("voiceAgent.call.end.tooLong")
    case .failed: L("voiceAgent.call.end.failed")
    case .dropped: L("voiceAgent.call.end.dropped")
    case let .microphone(error): microphoneError(error)
    case .audioInterrupted: L("voiceAgent.call.end.audioInterrupted")
    case .speechOff: L("voiceAgent.call.end.speechOff")
    case .speechUnavailable: L("voiceAgent.call.end.speechUnavailable")
    case .speechFailed: L("voiceAgent.call.end.speechFailed")
    case .sessionLimit: L("voiceAgent.call.end.sessionLimit")
    }
  }

  /// The end of the conversation through a change in the app.
  static func voiceAgentClosed(_ reason: VoiceAgentWatch.Reason) -> String {
    switch reason {
    case .loggedOut: L("voiceAgent.call.closed.loggedOut")
    case .serverChanged: L("voiceAgent.call.closed.serverChanged")
    case .sessionChanged: L("voiceAgent.call.closed.sessionChanged")
    case .sessionCleared: L("voiceAgent.call.closed.sessionCleared")
    case .disabled: L("voiceAgent.call.closed.disabled")
    case .background: L("voiceAgent.call.closed.background")
    case .fieldHidden: L("voiceAgent.call.closed.fieldHidden")
    case .connectionLost: L("voiceAgent.call.closed.connectionLost")
    case .cardGone: L("voiceAgent.call.closed.cardGone")
    case .cardChanged: L("voiceAgent.call.closed.cardChanged")
    case .inboxLeft: L("voiceAgent.call.closed.inboxLeft")
    }
  }
}
