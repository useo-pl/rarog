import Foundation

// Wire format of Soniox text-to-speech over a WebSocket (`tts-websocket`): the frames the client sends, the frames it
// reads, the text cut into frames, and the heard text from the character timestamps. Owner: voice agent. The client
// that drives them stands in `SonioxSpeech.swift`.
//
// Nothing here carries the key: it rides in the WebSocket protocol list (`SonioxKey`), never in a frame.

/// One key for Soniox speech, from the server. The description never prints the key.
struct SonioxSpeechConfig: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  let apiKey: String
  /// The key opens new streams until this moment; streams already open run on.
  let expiresAt: Date
  let webSocketURL: URL
  let model: String
  let voice: String
  /// Output sample rate of `pcm_s16le`, in Hz.
  let sampleRate: Int
  /// Language of the stream (`pl`, `en`).
  let language: String
  /// Reading speed of the stream, one of `VoiceAgentSettings.speechSpeeds` (Soniox takes 0.7–1.3, 1.0 normal): the
  /// device setting read when the conversation starts.
  var speed: Double = 1.0

  var description: String {
    "SonioxSpeechConfig(apiKey: <redacted>, url: \(webSocketURL.absoluteString), model: \(model), voice: \(voice), "
      + "sampleRate: \(sampleRate), language: \(language), speed: \(speed))"
  }
  var debugDescription: String { description }
  /// `dump` and nested diagnostics walk the mirror, so it leaves the key out too.
  var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "expiresAt": expiresAt, "webSocketURL": webSocketURL, "model": model, "voice": voice,
        "sampleRate": sampleRate, "language": language, "speed": speed,
      ])
  }
}

/// One spoken character with its place on the stream's audio axis, in seconds from the stream's first sample.
struct SonioxSpokenCharacter: Sendable, Equatable {
  let text: String
  let start: Double
  let end: Double
}

/// The characters Soniox returned for one utterance, in order. They follow the text after Soniox normalized it
/// (whitespace folded, emoji dropped), so they are what the voice said, not what the model wrote.
struct SonioxSpokenText: Sendable, Equatable {
  private(set) var characters: [SonioxSpokenCharacter] = []

  mutating func append(_ next: [SonioxSpokenCharacter]) {
    characters.append(contentsOf: next)
  }

  /// The characters whose end lies within the samples played so far, joined. Audio frames without timestamps add no
  /// characters, so the result never runs ahead of the timestamps Soniox sent.
  func heard(playedSamples: Int, sampleRate: Int) -> String {
    var heard = ""
    for character in characters {
      let endSample = Int((character.end * Double(sampleRate)).rounded())
      guard endSample <= playedSamples else { break }
      heard += character.text
    }
    return heard
  }
}

enum SonioxSpeechFrame {
  static let keepalive = #"{"keep_alive":true}"#
  /// Soniox takes at most 5000 characters in one text frame.
  static let maxTextCharacters = 5000

  private struct Start: Encodable {
    let streamId: String
    let model: String
    let language: String
    let voice: String
    let audioFormat = "pcm_s16le"
    let sampleRate: Int
    let speed: Double
    let returnTimestamps = true

    enum CodingKeys: String, CodingKey {
      case streamId = "stream_id", model, language, voice, audioFormat = "audio_format", sampleRate = "sample_rate"
      case speed, returnTimestamps = "return_timestamps"
    }
  }

  private struct Text: Encodable {
    let streamId: String
    let text: String
    let textEnd: Bool

    enum CodingKeys: String, CodingKey {
      case streamId = "stream_id", text, textEnd = "text_end"
    }
  }

  private struct Cancel: Encodable {
    let streamId: String
    let cancel = true

    enum CodingKeys: String, CodingKey {
      case streamId = "stream_id", cancel
    }
  }

  /// The start frame of a stream: model, voice, format and reading speed from the key's config, timestamps on.
  static func start(stream: String, config: SonioxSpeechConfig) -> String {
    json(
      Start(
        streamId: stream, model: config.model, language: config.language, voice: config.voice,
        sampleRate: config.sampleRate, speed: config.speed))
  }

  static func text(stream: String, _ text: String, end: Bool = false) -> String {
    json(Text(streamId: stream, text: text, textEnd: end))
  }

  static func cancel(stream: String) -> String {
    json(Cancel(streamId: stream))
  }

  /// Cuts text into pieces of at most `limit` UTF-16 units (an upper bound of code points) on character boundaries,
  /// in order. An empty text gives no pieces.
  static func pieces(_ text: String, limit: Int = maxTextCharacters) -> [String] {
    var pieces: [String] = []
    var current = ""
    var count = 0
    for character in text {
      let size = character.utf16.count
      if count + size > limit, !current.isEmpty {
        pieces.append(current)
        current = ""
        count = 0
      }
      current.append(character)
      count += size
    }
    if !current.isEmpty { pieces.append(current) }
    return pieces
  }

  private static func json(_ value: some Encodable) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}

/// One frame from Soniox speech. Unknown fields are ignored; the error message is not kept (it is free text from the
/// server and stays out of the log).
struct SonioxSpeechReply: Sendable, Equatable {
  var stream: String?
  var audio: Data?
  var characters: [SonioxSpokenCharacter] = []
  var terminated = false
  var errorCode: Int?
  var errorType: String?

  private struct Wire: Decodable {
    struct Timestamps: Decodable {
      let characters: [String]
      let starts: [Double]
      let ends: [Double]

      enum CodingKeys: String, CodingKey {
        case characters, starts = "character_start_times_seconds", ends = "character_end_times_seconds"
      }
    }

    let streamId: String?
    let audio: String?
    let timestamps: Timestamps?
    let terminated: Bool?
    let errorCode: Int?
    let errorType: String?

    enum CodingKeys: String, CodingKey {
      case streamId = "stream_id", audio, timestamps, terminated, errorCode = "error_code", errorType = "error_type"
    }
  }

  static func parse(_ text: String) -> SonioxSpeechReply? {
    guard let wire = try? JSONDecoder().decode(Wire.self, from: Data(text.utf8)) else { return nil }
    var reply = SonioxSpeechReply()
    reply.stream = wire.streamId
    if let audio = wire.audio, !audio.isEmpty, let data = Data(base64Encoded: audio), !data.isEmpty {
      reply.audio = data
    }
    if let stamps = wire.timestamps {
      let count = min(stamps.characters.count, stamps.starts.count, stamps.ends.count)
      reply.characters = (0..<count).map {
        SonioxSpokenCharacter(text: stamps.characters[$0], start: stamps.starts[$0], end: stamps.ends[$0])
      }
    }
    reply.terminated = wire.terminated ?? false
    reply.errorCode = wire.errorCode
    reply.errorType = wire.errorType
    return reply
  }
}
