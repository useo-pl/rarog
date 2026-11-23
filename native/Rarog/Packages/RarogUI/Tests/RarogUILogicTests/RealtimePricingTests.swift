import Foundation
@testable import RarogUI
import Testing

// Token usage of an OpenAI Realtime response and its price: reading `response.usage` from `response.done` and the
// price table (`RealtimePricing`). Owner: voice agent.

// MARK: - Measured usage

/// `response.usage` of measured `gpt-realtime-2.1` responses, copied verbatim from the measurement output (the
/// conversation text left out), with the price at the table's rates. The measurement ran with the OpenAI voice, so
/// its responses carry output audio tokens; the text session of today has none, and the table prices no output
/// audio: these costs are the measured ones minus the output audio ($64 per 1M tokens then).
enum MeasuredUsage {
  /// Answer from the session text, mostly cached text in.
  static let answer = #"""
    {"total_tokens":42276,"input_tokens":41589,"output_tokens":687,"input_token_details":{"text_tokens":41452,"audio_tokens":137,"image_tokens":0,"cached_tokens":41344,"cached_tokens_details":{"text_tokens":41344,"audio_tokens":0,"image_tokens":0}},"output_token_details":{"text_tokens":183,"audio_tokens":504,"reasoning_tokens":29}}
    """#
  static let answerCost = 0.0257456

  /// First of two responses of one exchange: cached text and cached audio in.
  static let first = #"""
    {"total_tokens":42628,"input_tokens":42412,"output_tokens":216,"input_token_details":{"text_tokens":42000,"audio_tokens":412,"image_tokens":0,"cached_tokens":42240,"cached_tokens_details":{"text_tokens":41920,"audio_tokens":320,"image_tokens":0}},"output_token_details":{"text_tokens":173,"audio_tokens":43,"reasoning_tokens":70}}
    """#
  static let firstCost = 0.024312

  static let second = #"""
    {"total_tokens":43516,"input_tokens":42645,"output_tokens":871,"input_token_details":{"text_tokens":42233,"audio_tokens":412,"image_tokens":0,"cached_tokens":42368,"cached_tokens_details":{"text_tokens":41984,"audio_tokens":384,"image_tokens":0}},"output_token_details":{"text_tokens":178,"audio_tokens":693}}
    """#
  static let secondCost = 0.0231112
  /// Both responses of the exchange together.
  static let exchangeCost = 0.0474232

  /// `response.done` as the server sends it, with `usage` (JSON) or without.
  static func done(_ id: String, status: String = "completed", usage: String? = nil) -> String {
    let field = usage.map { #","usage":\#($0)"# } ?? ""
    return #"{"type":"response.done","response":{"id":"\#(id)","status":"\#(status)","output":[]\#(field)}}"#
  }

  static func object(_ json: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
  }
}

// MARK: - Tests

@Suite("Realtime usage and price: response.usage, price table, log line")
struct RealtimePricingTests {
  @Test(
    "measured gpt-realtime-2.1 usage → the cost the measurement computed",
    arguments: [
      (MeasuredUsage.answer, MeasuredUsage.answerCost),
      (MeasuredUsage.first, MeasuredUsage.firstCost),
      (MeasuredUsage.second, MeasuredUsage.secondCost),
    ])
  func measuredCost(usage: String, expected: Double) throws {
    let parsed = try #require(RealtimeUsage(MeasuredUsage.object(usage)))
    let cost = try #require(RealtimePricing.cost(parsed, model: "gpt-realtime-2.1"))
    #expect(abs(cost - expected) < 1e-12)
  }

  @Test("response.done with usage → token counts by kind, cached as a subset of the input")
  func parsesResponseDone() throws {
    let event = RealtimeServerEvent.parse(MeasuredUsage.done("r1", usage: MeasuredUsage.first))
    let usage = RealtimeUsage(textIn: 42000, cachedTextIn: 41920, audioIn: 412, cachedAudioIn: 320, textOut: 173)
    #expect(event == .responseDone(id: "r1", status: "completed", error: nil, usage: usage))
  }

  @Test("response.done without usage → no usage")
  func responseDoneWithoutUsage() {
    #expect(RealtimeServerEvent.parse(MeasuredUsage.done("r1")) == .responseDone(id: "r1", status: "completed", error: nil, usage: nil))
  }

  @Test("usage without cache details → nothing cached, full input price; output audio is not counted")
  func usageWithoutCacheDetails() throws {
    let json = #"""
      {"input_token_details":{"text_tokens":1000,"audio_tokens":100,"cached_tokens":800},"output_token_details":{"text_tokens":10,"audio_tokens":50}}
      """#
    let usage = try #require(RealtimeUsage(MeasuredUsage.object(json)))
    #expect(usage == RealtimeUsage(textIn: 1000, audioIn: 100, textOut: 10))
    let cost = try #require(RealtimePricing.cost(usage, model: "gpt-realtime-2.1"))
    #expect(abs(cost - 0.00744) < 1e-12)
  }

  @Test("totals without details → unknown usage; zero totals or details present → counted")
  func totalsWithoutDetails() throws {
    #expect(RealtimeUsage(MeasuredUsage.object(#"{"total_tokens":100,"input_tokens":80,"output_tokens":20}"#)) == nil)
    #expect(RealtimeUsage(MeasuredUsage.object(#"{"input_tokens":0,"output_tokens":5}"#)) == nil)
    #expect(RealtimeUsage(MeasuredUsage.object(#"{"total_tokens":0,"input_tokens":0,"output_tokens":0}"#)) == RealtimeUsage())
    let inputOnly = #"{"input_tokens":80,"output_tokens":0,"input_token_details":{"text_tokens":80}}"#
    #expect(RealtimeUsage(MeasuredUsage.object(inputOnly)) == RealtimeUsage(textIn: 80))
  }

  @Test("cached count above the input of its kind → capped at the input, never counted twice")
  func cachedCapped() {
    let usage = RealtimeUsage(textIn: 10, cachedTextIn: 50, audioIn: 0, cachedAudioIn: 5)
    #expect(usage.cachedTextIn == 10 && usage.cachedAudioIn == 0)
    #expect(RealtimePricing.cost(usage, model: "gpt-realtime-2.1") == 10 * 0.4 / 1_000_000)
  }

  @Test("mini prices; a model outside the table has no price")
  func modelsInTable() throws {
    let usage = RealtimeUsage(textIn: 1_000_000, cachedTextIn: 500_000, audioIn: 1_000_000, cachedAudioIn: 0, textOut: 1_000_000)
    let mini = try #require(RealtimePricing.cost(usage, model: "gpt-realtime-2.1-mini"))
    #expect(abs(mini - (0.3 + 0.03 + 10 + 2.4)) < 1e-9)
    #expect(RealtimePricing.cost(usage, model: "gpt-realtime-9") == nil)
    #expect(RealtimePricing.cost(usage, model: nil) == nil)
  }

  @Test("dollars in a log line: four decimals, a dot whatever the locale")
  func dollars() {
    #expect(RealtimePricing.dollars(0.0580016) == "$0.0580")
    #expect(RealtimePricing.dollars(0) == "$0.0000")
  }
}
