import Foundation

// The OpenAI Realtime (GA) session of the voice conversation: the body of `session.update` with the host's
// instructions and tools, and the server VAD. Owner: voice agent. The instructions and tools of the conversation at a
// session: `RealtimeInstructions+SessionHost.swift`.
//
// Event, field and value names measured on the live API (`gpt-realtime-2.1`): GA events
// (`session.update` with `type: realtime`), input `audio/pcm` 24 kHz, `server_vad` with 500 ms of silence. The
// session answers with text only; Soniox reads the answers aloud.

enum RealtimeInstructions {
  /// Wykrywanie końca mowy po stronie serwera. `create_response: false`: odpowiedź zamawia apka po
  /// `input_audio_buffer.committed`, bo przed nią wstawia nowe tury sesji (`conversation.item.create`).
  /// `interrupt_response: false`: speech during an answer does not cancel it at OpenAI; the app decides the cut and
  /// sends `response.cancel` itself (`RealtimeConversation+Noise.swift`).
  static let silenceMs = 500
  /// Audio the VAD keeps before the detected start of speech; `speech_started` reports its time with it
  /// (`RealtimeBargeIn.speechLength`).
  static let prefixPaddingMs = 300

  /// Ciało `session` zdarzenia `session.update`. Modelu tu nie ma: wiąże go klucz krótki od serwera.
  /// Text output only and no output audio, because Soniox speaks the answers (`RealtimeConversation+Speech.swift`).
  /// `tools`: the host's function schemas (`RealtimeToolSpec.schema`).
  static func session(instructions: String, tools: [[String: Any]]) -> [String: Any] {
    let pcm: [String: Any] = ["type": "audio/pcm", "rate": RealtimeAudioFormat.sampleRate]
    let audio: [String: Any] = [
      "input": [
        "format": pcm,
        // OpenAI filters the microphone before the VAD. `far_field`: the user mostly talks to the phone or iPad
        // speaker, without headphones.
        "noise_reduction": ["type": "far_field"],
        // No `transcription`: the app shows no captions, so it pays for no transcription model.
        "turn_detection": [
          "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": prefixPaddingMs,
          "silence_duration_ms": silenceMs, "create_response": false, "interrupt_response": false,
        ] as [String: Any],
      ] as [String: Any]
    ]
    return [
      "type": "realtime",
      "output_modalities": ["text"],
      "instructions": instructions,
      "tools": tools,
      "tool_choice": "auto",
      "audio": audio,
    ]
  }
}
