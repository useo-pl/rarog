import Foundation
import RarogContract
@testable import RarogUI
import Testing

// The session screen's host of the voice conversation: the transcript as content (`VoiceAgentTranscriptSource`).
// The conversation asks for the instructions again at each start on the same host and at the retry with half the
// budget; the session updates after that count from the newest projection. Owner: voice agent.

@MainActor
@Suite("voice conversation: the session host's transcript content")
struct VoiceAgentSessionHostTests {
  /// One turn: the user's prompt and the agent's answer.
  private static func turn(_ seq: Int, _ prompt: String) -> [TranscriptMessage] {
    [message(seq, "user", prompt), message(seq + 1, "assistant", "Done: \(prompt)")]
  }

  private static func message(_ seq: Int, _ role: String, _ text: String) -> TranscriptMessage {
    Sample.decode(
      TranscriptMessage.self,
      #"{"seq":\#(seq),"role":"\#(role)","blocks":[{"type":"text","text":"\#(text)"}],"at":"2026-11-10T10:00:00.000Z"}"#)
  }

  /// The instructions once with turn A, then (a turn B arrived in between, with no update asked) once more with
  /// `secondBudget`; then turn C arrives. Returns the update after C.
  private static func updateAfterSecondProjection(secondBudget: Int) -> String? {
    var messages = turn(1, "Prompt A")
    let source = VoiceAgentTranscriptSource(messages: { messages })
    _ = source.instructions(budget: RealtimeProjector.budget)
    messages += turn(3, "Prompt B")
    let second = source.instructions(budget: secondBudget)
    #expect(second.contains("USER: Prompt B"))
    messages += turn(5, "Prompt C")
    return source.update()
  }

  @Test("a new start on the same host: the update after it counts from the new projection, numbering goes on")
  func restartCountsFromNewProjection() throws {
    let update = try #require(Self.updateAfterSecondProjection(secondBudget: RealtimeProjector.budget))
    #expect(update.contains("### Turn 3 · 2026-11-10T10:00:00.000Z\nUSER: Prompt C"))
    #expect(!update.contains("Prompt B"))
    #expect(!update.contains("Turn 2"))
  }

  @Test("the retry with half the budget: the update after it counts from the half-budget projection")
  func halfBudgetRetryCountsFromItsProjection() throws {
    let update = try #require(Self.updateAfterSecondProjection(secondBudget: RealtimeProjector.budget / 2))
    #expect(update.contains("### Turn 3 · 2026-11-10T10:00:00.000Z\nUSER: Prompt C"))
    #expect(!update.contains("Prompt B"))
    #expect(!update.contains("Turn 2"))
  }
}
