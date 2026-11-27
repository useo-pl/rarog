import Foundation

// What the voice conversation tells its host about the answers it speaks (`Handlers.answer`). Owner: voice agent. The
// host of the conversation across sessions picks up a session's result only after the answer about it was heard to its
// end (`VoiceAgentSessionsHost`); the session screen's host ignores these events.
//
// Rules:
// - `playedWhole` once per response that spoke, called no tool, was not cut, and whose every item played out: its
//   synthesis ended and the playback queue drained after it, and its `response.done` came. A response that calls a tool
//   is a preamble ("I am checking"), not the answer that follows the tool's result. An item whose synthesis the stream
//   limit cut, and an item that gave no audio, keep the response from counting. A tool's reading is no answer: it
//   never tells `playedWhole` (`RealtimeConversation+Reading.swift`).
// - `cut` at every barge-in (speech over the answer after the noise window, or speech while nothing plays: tool results
//   in flight are dropped then too) and at a lost playback (the engine restarted). Noise over the answer is not a cut:
//   the answer goes on and can still play out whole.
// - The end of the conversation gives no event; the host learns the end from its owner.

extension RealtimeConversation {
  /// What the host learns about the answers (`Handlers.answer`).
  enum AnswerEvent: Sendable, Equatable {
    /// A spoken answer without a tool call played out whole.
    case playedWhole
    /// Speech over the answer or a lost playback cut what was in flight.
    case cut
  }

  /// Per run: which responses called a tool, played audio, lost an item to an error that ends one stream (the stream
  /// limit, a request timeout) or had an item that ended without audio, and which were reported.
  struct AnswerLog {
    var calledTool: Set<String> = []
    var audible: Set<String> = []
    var limited: Set<String> = []
    var silent: Set<String> = []
    var reported: Set<String> = []
  }

  /// A response may be over: `playedWhole` when it qualifies (the rules above), once.
  func answerMayBeOver(_ response: String) {
    guard doneResponses.contains(response), !tts.items.values.contains(where: { $0.response == response }),
      answers.audible.contains(response), !answers.calledTool.contains(response),
      !answers.limited.contains(response), !answers.silent.contains(response), !interrupted.contains(response),
      answers.reported.insert(response).inserted
    else { return }
    handlers.answer(.playedWhole)
  }

  /// Speech or a lost playback cut what was in flight.
  func answerCut() {
    handlers.answer(.cut)
  }
}
