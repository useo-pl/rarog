import Foundation

// Microphone mute of the voice conversation: the composer mic during a conversation (`VoiceAgentSession.toggleMute`).
// Owner: voice agent.
//
// - Muted, the input handler of the audio engine drops every microphone chunk: no `input_audio_buffer.append`, no
//   input usage, no microphone level. The engine keeps running, so playback, echo cancellation and Soniox speech
//   stay as they are, and the agent finishes an answer in flight.
// - Mute sends `input_audio_buffer.clear` once, so a half-spoken utterance is dropped instead of left open in the
//   server's buffer, and the hearing state of the app resets. A response already ordered still comes.
// - VAD events of the cut utterance can be on their way when the user mutes: `speech_started` while muted is
//   ignored, and a late `committed` (also after a quick unmute) orders nothing and its item is deleted. The next
//   `speech_started` after the unmute starts a new utterance. Noise over the answer drops its utterance the same way
//   (`RealtimeConversation+Noise.swift`).
// - Mute during the window of speech over the answer closes it: no cut, the volume back, the answer goes on; the tool
//   calls the window held are dropped. Tool results that wait for a noise's `committed` go at once.
// - The mute lasts until unmute or the end of the conversation; every conversation starts unmuted (`reset`, `end`).

extension RealtimeConversation {
  /// Mutes (`true`) or unmutes the microphone of a running conversation. No conversation, or the same state: nothing.
  func setMuted(_ on: Bool) {
    switch phase {
    case .idle, .ended: return
    default: break
    }
    guard muted != on else { return }
    muted = on
    handlers.diagnostic(on ? .muted : .unmuted)
    guard on else { return }
    dropHeld(closeBargeInWindow())
    releaseResultsAfterNoise()
    // Before the readiness gate nothing was appended, so there is nothing to clear.
    if audioRunning {
      send(RealtimeClientEvent.clearAudio())
      droppingUtterance = true
    }
    zeroInputLevel()
    handlers.speech(false)
  }

  /// `speech_started` while muted belongs to no utterance; after the unmute it starts a new one.
  func speechStartCounts() -> Bool {
    guard !muted else { return false }
    droppingUtterance = false
    return true
  }

  /// A `committed` of the utterance cut by the mute, or of noise over the answer: no answer, and the item leaves the
  /// conversation.
  func commitCounts(_ itemId: String?) -> Bool {
    guard muted || droppingUtterance else { return true }
    droppingUtterance = false
    if let itemId { send(RealtimeClientEvent.deleteItem(itemId)) }
    return false
  }
}
