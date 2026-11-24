import Foundation
import RarogCore

// The prompt rules, the prompt tools' descriptions and every sentence the prompt pair gives the model in the voice
// conversation at an Inbox card (`VoiceAgentInboxHost`, `RealtimePromptField.inboxReply`); the rest of the
// instructions and tools is the session screen's (`RealtimeInstructions+SessionHost.swift`). Owner: voice agent.
// The prompt stands in its own block on the card (`InboxPromptBlock`), the app reads it aloud exactly as written,
// and a voice send takes only a version the user heard whole (`VoiceAgentInboxConversation+Prompt.swift`). English,
// like every tool result; the model answers in the user's language. No sentence carries the prompt or server text.

extension RealtimeInstructions {
  private static var show: String { RealtimeTool.showPrompt.rawValue }
  private static var send: String { RealtimeTool.sendPrompt.rawValue }

  /// The prompt rules of an Inbox card.
  static func inboxReplyPrompts() -> String {
    """
    You never pretend that something is done. When the user wants the agent to do or check something, write a \
    concrete prompt for the agent without widening the scope and call \(show) with it: the prompt stands in its own \
    block on the Inbox card, and the app reads it aloud to the user exactly as written. Do not read the prompt \
    yourself and do not repeat it. A new \(show) replaces your prompt while the app reads it or it waits; while the \
    user edits it or a send is in flight, \(show) is refused. The result of \(show) comes after the reading: when \
    the user heard the prompt whole, ask whether to send it. When the user edits or sends the prompt by hand during \
    the reading, the reading stops and no result comes; wait for the user. Call \(send) only after the user \
    confirms in a new utterance, never in the same answer as \(show); it sends only a prompt the user heard whole, \
    once. \
    \(RealtimePromptField.inboxReply.editRule) When nothing is sent, tell the user why.
    """
  }

  static var inboxShowDescription: String {
    "Puts a prompt for the coding agent in its own block on the Inbox card, and the app reads it aloud to the user "
      + "exactly as written; the result comes after the reading. Nothing is sent. Do not read the prompt yourself. "
      + "A new call replaces your prompt, except while the user edits it or a send is in flight."
  }

  static var inboxSendDescription: String {
    "Sends your prompt from \(show) as the card's reply, exactly as the app read it. Works only after the user heard "
      + "it whole and confirmed in a new utterance; never in the same answer as \(show); once per prompt. "
      + RealtimePromptField.inboxReply.editRule
  }

  /// The `send_prompt` result when no prompt of this conversation stands in the card's block.
  static var inboxNoPrompt: String {
    "No prompt of yours stands in the card's block, so nothing was sent. Call \(show) first."
  }

  /// The `show_prompt` result when the card takes no prompt: `reason` says why.
  static func inboxPromptRefused(_ reason: String) -> String {
    "The prompt was not shown: \(reason). Tell the user."
  }

  // MARK: show_prompt

  static let inboxPromptEmpty = "The prompt is empty."
  static var inboxPromptTooLong: String {
    "The prompt is longer than \(InboxPromptBlock.maxCharacters) characters, so nothing was shown, and your earlier "
      + "prompt no longer goes by voice. Write a shorter prompt and call \(show) again."
  }
  static var inboxPromptWhileEditing: String {
    "The user is editing your earlier prompt in its block, so nothing was shown. The user sends the edited prompt "
      + "with the block's Send button or cancels the edit."
  }
  static var inboxPromptWhileSending: String {
    "A send of your earlier prompt is in flight, so nothing was shown. Wait for its result, then call \(show) again "
      + "only if the user still wants it."
  }
  /// The reading played out whole.
  static let inboxPromptHeard =
    "The app read the prompt aloud to the user whole; it stands in its block. Ask only whether to send it."
  static var inboxPromptNotHeard: String {
    "The user did not hear the prompt to its end, so it does not go by voice. It stands in its block: call \(show) "
      + "again to read it, or the user sends it with the block's Send button."
  }
  static var inboxPromptEdited: String {
    "The user is editing the prompt in its block. An edited prompt goes only with the block's Send button, never "
      + "with \(send)."
  }
  static var inboxPromptGone: String {
    "This prompt no longer stands in its block: the user sent it or a newer prompt replaced it. Do not call \(send) "
      + "for it."
  }

  /// Why `show_prompt` showed nothing, for the model.
  static func inboxShowRefused(_ refusal: InboxPromptBlock.ShowRefusal) -> String {
    switch refusal {
    case .tooLong: inboxPromptTooLong
    case .editing: inboxPromptWhileEditing
    case .sending: inboxPromptWhileSending
    }
  }

  // MARK: send_prompt

  /// Why `send_prompt` sent nothing, for the model (the lost login answers `VoiceAgentToolText.unreachable`).
  static func inboxSendRefused(_ refusal: InboxPromptBlock.VoiceSendRefusal) -> String {
    switch refusal {
    case .loggedOut: "The app cannot reach the session now."
    case .sending: "A send of this prompt is already in flight, so nothing more was sent. Wait for its result."
    case .editing: inboxPromptEdited + " Nothing was sent."
    case .sameResponse, .notConfirmed:
      "Not confirmed yet: ask the user whether to send the prompt, and call \(send) only after the user confirms in "
        + "a new utterance. Nothing was sent."
    case .reading: "The app is still reading the prompt aloud, so nothing was sent. Wait for the reading's result."
    case .notHeardWhole: inboxPromptNotHeard + " Nothing was sent."
    case .withdrawn:
      "Your later \(show) was refused, so this prompt no longer goes by voice. Call \(show) again, or the user sends "
        + "it with the block's Send button. Nothing was sent."
    case .attempted:
      "This prompt was already sent once, so it does not go by voice again. Nothing was sent; tell the user."
    }
  }

  /// The result of a block's send for the model: `settlement` is what the block made of `outcome`; `queued`: the
  /// accepted entry waits in the CLI queue.
  @MainActor static func inboxSendResult(
    _ outcome: InboxReplyOutcome, settlement: InboxPromptBlock.Settlement, queued: Bool
  ) -> String {
    let reason: String
    switch outcome {
    case .cardChanged:
      reason = "the card in the Inbox changed before the send (another turn, or the session works)"
    case let .sent(sent):
      switch ComposerSendResult(sent, queued: queued) {
      case .accepted(queued: false):
        return RealtimeConversation.toolResult("sent: the session received your prompt as the card's reply")
      case .accepted(queued: true):
        return RealtimeConversation.toolResult("queued: the session takes your prompt after its current turn")
      case .unconfirmed:
        return RealtimeConversation.toolError(
          "The send is not confirmed: it is not known whether the prompt arrived. It stays in the session's queue "
            + "for the user to retry by hand.")
      case .stopped:
        return RealtimeConversation.toolError(
          "The user stopped the send before it went out, so nothing was sent. It stays in the session's queue for "
            + "the user to retry by hand.")
      case let .refused(code, _):
        reason = "the session refused it (\(VoiceAgentToolText.refusalName(code)))"
      case let .blocked(block):
        reason = "the session does not take messages now (\(VoiceAgentToolText.blockName(block)))"
      case .notSent, .readOnly, .appCommand, .attachmentsLoading, .attachmentsOverLimit:
        reason = "the app could not send it"
      }
    }
    let rest =
      switch settlement {
      case .restored: "Your prompt stands in its block again with the reason; tell the user."
      case .keptInTranscript: "It stays in the session's transcript for the user to retry by hand; tell the user."
      case .handOver: "Its text went to the card's reply field or the session's draft; tell the user."
      case .sent, .notMine: "Tell the user."
      }
    return RealtimeConversation.toolError("Nothing was sent: \(reason). \(rest)")
  }
}
