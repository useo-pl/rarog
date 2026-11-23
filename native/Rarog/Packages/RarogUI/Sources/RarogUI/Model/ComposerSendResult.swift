import Foundation
import RarogCore

// The typed result of one send of the message field. ↑ and the voice conversation's `send_prompt` call the same
// operation (`SessionViewController.sendField`, `SessionViewController+Send.swift`); ↑ ignores the result, the voice
// conversation tells the model (`VoiceAgentToolText.send`). Owner: send.

/// How one send of the message field ended.
enum ComposerSendResult: Sendable, Equatable {
  /// The server took the message; `queued` = it waits in the CLI queue for the end of the running turn.
  case accepted(queued: Bool)
  /// Not known whether it arrived (time-out, no network): the entry stays in the send queue for "Retry".
  case unconfirmed
  /// The server refused it; the text is back in the field.
  case refused(code: String?, message: String?)
  /// The user stopped the send in the progress ring before the request: nothing went out, the entry stays in the
  /// send queue for "Retry", the text does not go back to the field.
  case stopped
  /// The session does not take messages now; the text is back in the field.
  case blocked(SendBlock)
  /// Nothing went out: empty field, the queue could not be saved, or the send was ignored.
  case notSent
  /// Refused before the field was taken: the field is read-only, or the agent is still starting.
  case readOnly(reason: String)
  /// The whole field is an app command: the app ran it itself, nothing went to the session.
  case appCommand
  /// Refused before the field was taken: attachments are still loading.
  case attachmentsLoading
  /// Refused before the field was taken: more attachments than one message takes.
  case attachmentsOverLimit

  /// The result of the store's send; `queued` = the accepted entry waits in the CLI queue.
  init(_ outcome: SendOutcome, queued: Bool) {
    switch outcome {
    case .accepted: self = .accepted(queued: queued)
    case .unconfirmed: self = .unconfirmed
    case .refused(_, OutboxEntry.RefusalCode.cancelled?, _): self = .stopped
    case let .refused(_, code, message): self = .refused(code: code, message: message)
    case let .blocked(block): self = .blocked(block)
    case .empty, .notPersisted, .ignored: self = .notSent
    }
  }
}
