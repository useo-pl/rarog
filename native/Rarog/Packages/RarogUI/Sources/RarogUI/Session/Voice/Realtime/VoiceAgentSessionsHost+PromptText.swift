import Foundation
import RarogCore

// Every sentence the prompt pair of the voice conversation across sessions (`show_prompt`, `send_prompt`,
// `VoiceAgentSessionsHost+Prompt.swift`) gives the model, in one place. Owner: voice agent.
//
// - The sentences marked "measured" are the ones a measurement of the model passed its thresholds with, word for
//   word, next to the instructions (`RealtimeInstructions+SessionsHost.swift`); they change only together with it.
// - Every other sentence tells the model what happened and what to say or do next. One for an outcome that does not
//   say whether the prompt arrived says that it may have arrived and must not be prepared again unless the user asks.
// - English, like every tool result; the model answers in the user's language. A refusal of the server is passed on
//   with its own sentence; every other text here is fixed and names no session.

enum VoiceAgentPromptText {
  private static var show: String { VoiceAgentSessionsTool.showPrompt.rawValue }
  private static var send: String { VoiceAgentSessionsTool.sendPrompt.rawValue }

  // MARK: show_prompt

  /// Measured.
  static let unknownHandle = "Unknown handle. Use handles from the session list."
  /// Measured.
  static let empty = "The prompt is empty."
  /// Measured.
  static var tooLong: String { "The prompt is longer than \(VoiceAgentSessionsHost.promptMaxCharacters) characters." }
  /// Measured: the reading played out whole.
  static let shown =
    "The app showed the project, the session and the exact prompt and read them aloud to the user. Ask only whether "
    + "to send it."
  static let ambiguous =
    "Another session in this project has the same name, so the user could not tell which one the prompt is for. "
    + "Nothing was shown. Tell the user."
  static let dialog =
    "This session waits for a permission or an answer to a question, so it cannot take a prompt now. Nothing was "
    + "shown. Tell the user."
  static var sending: String { "A prompt is still being sent. Wait for its result, then call \(show) again." }
  /// `check_open_requests` while a send is in flight: nothing is announced.
  static var checkWhileSending: String {
    "A prompt is still being sent, so the check was not announced. Wait for the send's result; call "
      + "\(VoiceAgentSessionsTool.checkOpenRequests.rawValue) again only if the user still wants the check."
  }
  static var notReadAloud: String {
    "The app could not read the prompt aloud, so it cannot be sent. Call \(show) again."
  }
  static var replaced: String {
    "A newer \(show) or \(VoiceAgentSessionsTool.checkOpenRequests.rawValue) replaced this prompt, so it cannot be "
      + "sent. Ask the user what they want."
  }
  static var spokenOver: String {
    "The user spoke over this call, so nothing was shown. Call \(show) again only if the user still wants it."
  }

  /// The note after the result of a `show_prompt` whose session, conversation and text are those of the last send:
  /// the prompt keeps that send's id, so a confirmed send does not deliver it a second time.
  static func sameAsLastSend(_ end: VoiceAgentPromptLock.SendEnd) -> String {
    switch end {
    case .sent, .queued:
      "Note: the app already sent this exact prompt to this session, and a confirmed send does not deliver it a "
        + "second time. Tell the user it already went out."
    default:
      "Note: an earlier send of this exact prompt to this session may have arrived, and a confirmed send delivers it "
        + "at most once. Tell the user."
    }
  }

  /// The note after the result of a `show_prompt` for other content: how the last send ended.
  static func lastSend(_ sentence: String) -> String { "Note: your last \(send) ended like this: \(sentence)" }

  // MARK: send_prompt

  /// Measured.
  static var noPrompt: String { "No prompt waits. Call \(show) first." }
  /// Measured.
  static let notConfirmed = "The user has not confirmed yet. Ask whether to send it and wait for the answer."
  /// Speech cut the call before the outbox took the prompt: nothing was sent, and the prompt still waits.
  static var spokenOverSend: String {
    "The user spoke before the prompt went out, so nothing was sent. Do what the user said; call \(send) again "
      + "only if they clearly confirm."
  }
  /// A sound came over a playing answer after the user's last kept utterance: nothing is sent on that word.
  static var soundAfterWord: String {
    "A sound came over your answer after the user's last words, and the app cannot tell whether the user spoke. "
      + "Nothing was sent. Ask the user again whether to send the prompt; call \(send) only after a clear yes."
  }
  static var notRead: String {
    "The prompt was not read aloud to the end, so it cannot be sent. Call \(show) again."
  }
  static let left = "The session left the session list, so nothing was sent. Tell the user."
  static var tokenChanged: String {
    "The session started a new conversation after the prompt was read, so nothing was sent. Tell the user, and "
      + "call \(show) again only if the user asks."
  }
  static let dialogNow =
    "The session now waits for a permission or an answer to a question, so nothing was sent. Tell the user."
  static var startedWorking: String {
    "The session started working after the prompt was read, so nothing was sent. Tell the user, and call \(show) "
      + "again only if the user asks."
  }
  /// The repeat after an outcome that does not say whether the prompt arrived meets a working session.
  static let workingAgain =
    "The session is working now, so nothing was sent again: the earlier send may have arrived and started it. Do "
    + "not prepare the prompt again unless the user asks. Tell the user."

  /// Measured.
  static let sent = "Sent."
  static let queued =
    "Sent: the session is working, so the prompt waits in the queue and runs after its current turn. Tell the user."
  static let conversationChanged =
    "The session started a new conversation, so the prompt was not sent and this conversation ends. Tell the user."
  /// The server's or the app's refusal; `message`: the server's sentence, passed on as it is.
  static func refused(message: String) -> String { "The prompt was not sent: \(message) Tell the user." }
  static func refused(code: String) -> String {
    "The session refused the prompt (\(code)), so nothing was sent. Tell the user."
  }
  static let loggedOut =
    "The app lost its login to the server, so it is not known whether the prompt arrived; it may have arrived. This "
    + "conversation ends. Tell the user."
  static func blocked(_ reason: String) -> String {
    "The session does not take messages now (\(reason)), so nothing was sent. Tell the user."
  }
  /// No answer, a failure or a stop: the prompt may have arrived.
  static func uncertain(_ cause: String) -> String {
    "\(cause), so it is not known whether the prompt arrived. It may have arrived: do not prepare it again unless "
      + "the user asks. Tell the user; if they want to try again, call \(send) after they confirm, and the session "
      + "gets it at most once."
  }
  static let noAnswer = "The server did not answer in time"
  static let failed = "The connection failed"
  static let stopped = "The send was stopped"
}
