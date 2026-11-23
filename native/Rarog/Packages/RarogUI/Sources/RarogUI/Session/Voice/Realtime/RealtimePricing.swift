import Foundation

// Token usage of one OpenAI Realtime response (`response.done` → `response.usage`) and its price in USD.
// Owner: voice agent. The conversation writes both to `client.log` (`RealtimeConversation+Usage.swift`).

/// Token counts of one response. Cached tokens are a subset of the input of the same kind, never extra tokens. The
/// session answers with text only (Soniox speaks), so there is no output audio to count.
struct RealtimeUsage: Sendable, Equatable {
  var textIn: Int
  var cachedTextIn: Int
  var audioIn: Int
  var cachedAudioIn: Int
  var textOut: Int

  init(textIn: Int = 0, cachedTextIn: Int = 0, audioIn: Int = 0, cachedAudioIn: Int = 0, textOut: Int = 0) {
    self.textIn = textIn
    self.cachedTextIn = min(cachedTextIn, textIn)
    self.audioIn = audioIn
    self.cachedAudioIn = min(cachedAudioIn, audioIn)
    self.textOut = textOut
  }

  /// `response.usage`: `input_token_details.{text_tokens,audio_tokens,cached_tokens_details.{text_tokens,audio_tokens}}`
  /// and `output_token_details.text_tokens`. Without `cached_tokens_details` nothing counts as cached
  /// (the bare `cached_tokens` total does not say which kind it is), so the price errs on the high side.
  /// The details are optional in the Realtime contract: a side without them but with a non-zero `input_tokens` or
  /// `output_tokens` total reads as unknown usage (`nil`), not as zero tokens.
  init?(_ object: [String: Any]?) {
    guard let object else { return nil }
    let count = { (dictionary: [String: Any], key: String) in max(0, dictionary[key] as? Int ?? 0) }
    let inputDetails = object["input_token_details"] as? [String: Any]
    let outputDetails = object["output_token_details"] as? [String: Any]
    if inputDetails == nil && count(object, "input_tokens") > 0 { return nil }
    if outputDetails == nil && count(object, "output_tokens") > 0 { return nil }
    let input = inputDetails ?? [:]
    let cached = input["cached_tokens_details"] as? [String: Any] ?? [:]
    let output = outputDetails ?? [:]
    self.init(
      textIn: count(input, "text_tokens"), cachedTextIn: count(cached, "text_tokens"),
      audioIn: count(input, "audio_tokens"), cachedAudioIn: count(cached, "audio_tokens"),
      textOut: count(output, "text_tokens"))
  }
}

/// The one price table of the voice agent, USD per 1M tokens, read from the OpenAI pricing page.
enum RealtimePricing {
  struct Rates: Sendable, Equatable {
    var textIn: Double
    var textCached: Double
    var textOut: Double
    var audioIn: Double
    var audioCached: Double
  }

  static let rates: [String: Rates] = [
    "gpt-realtime-2.1": Rates(textIn: 4, textCached: 0.4, textOut: 24, audioIn: 32, audioCached: 0.4),
    "gpt-realtime-2.1-mini": Rates(textIn: 0.6, textCached: 0.06, textOut: 2.4, audioIn: 10, audioCached: 0.3),
  ]

  /// Price of one response; `nil` for a model outside the table.
  static func cost(_ usage: RealtimeUsage, model: String?) -> Double? {
    guard let model, let rates = rates[model] else { return nil }
    let perMillion =
      Double(usage.textIn - usage.cachedTextIn) * rates.textIn + Double(usage.cachedTextIn) * rates.textCached
      + Double(usage.audioIn - usage.cachedAudioIn) * rates.audioIn + Double(usage.cachedAudioIn) * rates.audioCached
      + Double(usage.textOut) * rates.textOut
    return perMillion / 1_000_000
  }

  /// Soniox text-to-speech, read from the Soniox pricing page: input text $4 per 1M tokens at about
  /// 0.3 token per character, output audio $21.50 per 1M tokens at 30,000 tokens per hour of speech.
  static let speechTextPerMillion = 4.0
  static let speechTokensPerCharacter = 0.3
  static let speechAudioPerMillion = 21.5
  static let speechAudioTokensPerHour = 30_000.0

  /// Estimated price of Soniox speech: the characters sent and the audio generated.
  static func speechCost(characters: Int, audioMilliseconds: Int) -> Double {
    let textTokens = Double(characters) * speechTokensPerCharacter
    let audioTokens = Double(audioMilliseconds) / 3_600_000 * speechAudioTokensPerHour
    return (textTokens * speechTextPerMillion + audioTokens * speechAudioPerMillion) / 1_000_000
  }

  /// Dollars in a log line: `$0.0271`.
  static func dollars(_ value: Double) -> String { "$" + String(format: "%.4f", value) }
}
