import Foundation
import RarogCore

// Usage and events of one voice agent conversation for `client.log`: tokens and price of every response, the
// end with its reason, time and total, and the counts that tell "it heard nothing" apart (speech events,
// microphone peak, tool calls). Owner: voice agent. Never the conversation text. Prices: `RealtimePricing.swift`;
// the hooks stand in `RealtimeConversation.swift`, the log line cases in `RealtimeConversation+Types.swift`.

extension RealtimeConversation {
  /// Log line of one `response.done`.
  struct UsageLine: Sendable, Equatable {
    /// Order of the response in the conversation, from 1.
    var number: Int
    var status: String
    /// `nil`: the event carried no `usage`.
    var usage: RealtimeUsage?
    /// `nil`: no usage or a model outside the price table.
    var cost: Double?

    var traceLine: String {
      let name = Diagnostic.name(status)
      let head = "voice-agent: response \(number) \(name.isEmpty ? "unknown" : name)"
      guard let usage else { return head + ": no usage" }
      var line = head
        + ": text in \(usage.textIn) (cached \(usage.cachedTextIn)), audio in \(usage.audioIn) (cached \(usage.cachedAudioIn)),"
        + " out text \(usage.textOut)"
      if let cost { line += ", " + RealtimePricing.dollars(cost) }
      return line
    }
  }

  /// Log line of the conversation end.
  struct EndSummary: Sendable, Equatable {
    var reason: End
    var seconds: Double
    var responses: Int
    var withoutUsage: Int
    var speech: Int
    /// Loudest microphone sample sent to OpenAI, 0–1.
    var micPeak: Double
    var asks: Int
    var sends: Int
    /// `nil`: a model outside the price table.
    var cost: Double?
    /// A response without `usage`, or a response still open when the conversation ended: the total is a floor.
    var partial: Bool
    /// What in the app closed the conversation (`VoiceAgentWatch.Reason.traceName`), e.g. `field-hidden`.
    var detail: String? = nil
    /// Soniox speech of the whole conversation.
    var spoken = SpeechCount()

    var traceLine: String {
      let cause = detail.map { " (\($0))" } ?? ""
      var line = "voice-agent: ended \(reason.traceName)\(cause) after \(String(format: "%.1f", seconds)) s: "
        + "\(responses) responses (\(withoutUsage) without usage), speech \(speech), "
        + "mic peak \(String(format: "%.2f", micPeak)), ask \(asks), send \(sends)"
      if let cost { line += ", " + RealtimePricing.dollars(cost) }
      if partial { line += " partial" }
      line += ", " + spoken.traceText
      return line
    }
  }

  /// Soniox speech of one response or of the conversation: characters sent, audio GENERATED (every PCM Soniox
  /// returned, played or not) and the price. `cut`: a stream ended before its synthesis did, so the audio is a floor.
  struct SpeechCount: Sendable, Equatable {
    var characters = 0
    var samples = 0
    var cut = false

    var milliseconds: Int { RealtimeAudioFormat.milliseconds(samples: samples) }
    var cost: Double { RealtimePricing.speechCost(characters: characters, audioMilliseconds: milliseconds) }

    mutating func add(_ other: SpeechCount) {
      characters += other.characters
      samples += other.samples
      cut = cut || other.cut
    }

    var traceText: String {
      "tts chars \(characters) audio \(cut ? "~" : "")\(milliseconds) ms \(RealtimePricing.dollars(cost))"
    }
  }

  /// Counters of one conversation; a new start begins a new one.
  struct UsageLog {
    /// Model for the price: the key model, replaced by the one `session.created` names.
    var model: String?
    private let startedAt: TimeInterval
    private var counted: Set<String> = []
    /// Order of each counted response, for the speech line that comes after its `response.done`.
    private(set) var numbers: [String: Int] = [:]
    private var open: Set<String> = []
    private var responses = 0
    private var withoutUsage = 0
    private var cost = 0.0
    private var speech = 0
    private var peak = 0
    private var asks = 0
    private var sends = 0

    init(startedAt: TimeInterval) {
      self.startedAt = startedAt
    }

    mutating func created(_ id: String) {
      if !counted.contains(id) { open.insert(id) }
    }

    /// The line of the first `response.done` of a response; a repeated one counts nothing and returns `nil`.
    mutating func done(id: String, status: String, usage: RealtimeUsage?) -> Diagnostic? {
      guard counted.insert(id).inserted else { return nil }
      open.remove(id)
      responses += 1
      numbers[id] = responses
      let price = usage.flatMap { RealtimePricing.cost($0, model: model) }
      if usage == nil { withoutUsage += 1 }
      cost += price ?? 0
      return .response(UsageLine(number: responses, status: status, usage: usage, cost: price))
    }

    mutating func speechStarted() { speech += 1 }

    /// Microphone PCM s16le on its way to OpenAI: only the peak stays.
    mutating func input(_ pcm: Data) {
      var loudest = peak
      pcm.withUnsafeBytes { raw in
        for index in 0..<(raw.count / 2) {
          let value = Int(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)))
          loudest = max(loudest, abs(value))
        }
      }
      peak = loudest
    }

    /// A tool call, counted by the host's tally of its tool (`nil`: no counter, or a tool the host does not have).
    mutating func toolCall(_ tally: RealtimeToolSpec.Tally?) {
      switch tally {
      case .ask?: asks += 1
      case .send?: sends += 1
      case nil: break
      }
    }

    /// `ordered`: a `response.create` still waits for its `response.created`.
    func ended(_ reason: End, now: TimeInterval, ordered: Bool) -> Diagnostic {
      let priced = model.map { RealtimePricing.rates[$0] != nil } ?? false
      return .ended(
        EndSummary(
          reason: reason, seconds: max(0, now - startedAt), responses: responses, withoutUsage: withoutUsage,
          speech: speech, micPeak: min(1, Double(peak) / 32768), asks: asks, sends: sends,
          cost: priced ? cost : nil, partial: withoutUsage > 0 || !open.isEmpty || ordered))
    }
  }
}

extension RealtimeConversation.End {
  /// Name of the reason in a log line.
  var traceName: String {
    switch self {
    case .closed: "closed"
    case .keyMissing: "key-missing"
    case .keyRejected: "key-rejected"
    case .openAILimit: "openai-limit"
    case .throttled: "throttled"
    case .unavailable: "unavailable"
    case .instructionsTooLong: "instructions-too-long"
    case .failed: "failed"
    case .dropped: "dropped"
    case let .microphone(error):
      switch error {
      case .denied: "microphone-denied"
      case .unavailable: "microphone-unavailable"
      case .busy: "microphone-busy"
      case .failed: "microphone-failed"
      }
    case .audioInterrupted: "audio-interrupted"
    case .speechOff: "speech-off"
    case .speechUnavailable: "speech-unavailable"
    case .speechFailed: "speech-failed"
    }
  }
}

extension RealtimeConversation.Diagnostic {
  /// Conversation lines ride the voice agent budget of `client.log`; the end line, one per conversation, passes
  /// outside it so the total is never lost.
  var traceBudget: TraceBudget {
    if case .ended = self { return .voiceAgentEnd }
    return .voiceAgent
  }
}
