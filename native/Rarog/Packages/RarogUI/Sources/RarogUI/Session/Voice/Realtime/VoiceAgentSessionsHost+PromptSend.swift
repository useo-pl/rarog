import Foundation
import RarogContract
import RarogCore

// `send_prompt` of the voice conversation across sessions: the send of the prompt `show_prompt` bound
// (`VoiceAgentSessionsHost+Prompt.swift`) through `RarogStore.sendCompanionPrompt`. Owner: voice agent.
//
// - Checks in this order: a send in flight is joined and its result returned (one request); no prompt gives the
//   measured sentence, or the kept outcome of the last send while it stands; a `show_prompt` of the same response
//   (bound or shown) gives "not confirmed"; a prompt not read whole (its reading cut, not read or still running) tells
//   the model to call `show_prompt` again; no utterance after the reading (`RealtimeToolTurn.utteranceAfterReading`)
//   gives "not confirmed"; a repeat after an outcome that does not say whether the prompt arrived needs a kept
//   utterance since that attempt (`RealtimeToolTurn.utterances`). The same response comes before the reading: a send
//   in its show's response always meets the reading still running, and the model must hear "ask", not "show again".
// - Then the send is a task of the host's own, so a second call joins it: the catalog read and the end rules, then the
//   target as captured. A refused catalog read or end rule, a session that left the list, another `conversation`
//   token in the catalog, a dialog, or a session that did not work at the show and works now drops the prompt with a
//   refusal, and nothing is sent; the server's gates decide the rest. The send carries only the captured session id,
//   text, token and id.
// - Outcomes: `sent` and `queued` drop the prompt; `conversationChanged` drops it and ends the conversation by the
//   rule of a read session's new conversation; `refused` drops it and passes the server's or the app's sentence on;
//   `loggedOut` drops it and asks the core to check the end rules; `timedOut`, `failed` and `cancelled` keep the
//   prompt with the same `clientMessageId`, so a confirmed repeat is the same message for the store and the server.
//   Every outcome becomes the kept outcome (`VoiceAgentPromptLock.sent`).
// - Speech since the call stops the send until the host hands the prompt to the store's outbox: a cut during the
//   catalog read sends nothing, and the prompt stays read and waits for a clear word. So does a sound over a playing
//   answer since the user's last kept utterance, whatever the app makes of it (`RealtimeConversation+Noise.swift`):
//   a short no counts as noise there and never reaches the model. The check stands at the call and again before the
//   hand-off, and a repeat needs a new kept utterance. Once the outbox took it, nothing in the host cancels it:
//   the store answers `cancelled` for a cancelled caller before it looks at the echo, so a cut would turn an arrived
//   prompt into "cancelled". A cut and the end leave a send in flight to the outbox.
// - `client.log`: `voice-agent: send refused (<code>)`, `send joined`, `send reported (<code>)` and
//   `send ended (<code>)`, never the text, a name or an id.

extension VoiceAgentSessionsHost {
  /// `send_prompt` at `turn`.
  func sendPrompt(at turn: RealtimeToolTurn) async -> String {
    if let run = sendRun {
      trace("voice-agent: send joined")
      // When the run sent, this call returns its outcome too: the kept outcome goes by the cuts since the last call
      // that returned it. A run refused before the outbox took it settles nothing and leaves an older outcome.
      let start = discussion.cuts
      let id = prompts.prompt?.clientMessageId
      let output = await run.value
      if let kept = prompts.sent, kept.clientMessageId == id, kept.output == output { prompts.reported(since: start) }
      return output
    }
    guard let prompt = prompts.prompt else {
      if let pending = prompts.pending {
        return pending.response == turn.response
          ? refusedSend(VoiceAgentPromptText.notConfirmed, "same-response")
          : refusedSend(VoiceAgentPromptText.notRead, "not-read")
      }
      if let sent = prompts.sent {
        prompts.reported(since: discussion.cuts)
        trace("voice-agent: send reported (\(sent.end.rawValue))")
        return sent.output
      }
      return refusedSend(VoiceAgentPromptText.noPrompt, "no-prompt")
    }
    guard prompt.response != turn.response else {
      return refusedSend(VoiceAgentPromptText.notConfirmed, "same-response")
    }
    guard prompt.read else { return refusedSend(VoiceAgentPromptText.notRead, "not-read") }
    guard turn.utteranceAfterReading else { return refusedSend(VoiceAgentPromptText.notConfirmed, "not-confirmed") }
    if let attempt = prompt.attempt, turn.utterances <= attempt {
      return refusedSend(VoiceAgentPromptText.notConfirmed, "no-new-utterance")
    }
    guard soundAt != turn.utterances else { return refusedSend(VoiceAgentPromptText.soundAfterWord, "sound") }
    let start = discussion.cuts
    let run = Task { await self.deliverPrompt(prompt, utterances: turn.utterances, since: start) }
    sendRun = run
    return await run.value
  }

  /// The send's own task: the catalog and the end rules, the captured target, the request, the outcome.
  private func deliverPrompt(_ prompt: VoiceAgentPromptLock.Prompt, utterances: Int, since start: Int) async -> String {
    defer { sendRun = nil }
    if case let .refused(output, code) = await refresh() { return droppedSend(output: output, code) }
    if let refusal = blocked() { return droppedSend(output: refusal.output, refusal.code) }
    guard prompts.prompt?.number == prompt.number else { return refusedSend(VoiceAgentPromptText.noPrompt, "dropped") }
    guard let row = rows.first(where: { $0.sessionId == prompt.sessionId }) else {
      return droppedSend(VoiceAgentPromptText.left, "left")
    }
    guard conversations[row.sessionId] == prompt.conversation else {
      return droppedSend(VoiceAgentPromptText.tokenChanged, "token-changed")
    }
    guard !onDialog(row) else { return droppedSend(VoiceAgentPromptText.dialogNow, "dialog") }
    guard prompt.working || row.state != .working else {
      // After an outcome that does not say whether the prompt arrived, the turn may be this prompt's own.
      let sentence = prompt.attempt == nil ? VoiceAgentPromptText.startedWorking : VoiceAgentPromptText.workingAgain
      return droppedSend(sentence, "working")
    }
    // The last moment a word of the user can stop it: speech since the call keeps the prompt and sends nothing, and
    // so does a sound over the answer since the user's last kept utterance, which may be a no the app took for noise.
    guard !discussion.overtaken(since: start) else {
      return refusedSend(VoiceAgentPromptText.spokenOverSend, "cut")
    }
    guard soundAt != utterances else { return refusedSend(VoiceAgentPromptText.soundAfterWord, "sound") }
    let outcome = await backend.sendCompanionPrompt(
      sessionId: prompt.sessionId, text: prompt.text, conversation: prompt.conversation,
      clientMessageId: prompt.clientMessageId)
    return settle(outcome, prompt, utterances: utterances, since: start)
  }

  /// The outcome of the send of `prompt`, called at `utterances` kept utterances and cut count `since`.
  private func settle(
    _ outcome: CompanionSendOutcome, _ prompt: VoiceAgentPromptLock.Prompt, utterances: Int, since: Int
  ) -> String {
    let (end, sentence) = Self.sendEnd(outcome)
    let output =
      end == .sent || end == .queued
      ? RealtimeConversation.toolResult(sentence) : RealtimeConversation.toolError(sentence)
    prompts.keep(
      VoiceAgentPromptLock.Sent(
        sessionId: prompt.sessionId, conversation: prompt.conversation, text: prompt.text,
        clientMessageId: prompt.clientMessageId, end: end, sentence: sentence, output: output, since: since))
    if end.uncertain {
      prompts.attempted(prompt.number, utterances: utterances)
    } else if prompts.prompt?.number == prompt.number {
      prompts.drop()
    }
    trace("voice-agent: send ended (\(end.rawValue))")
    switch end {
    case .conversationChanged: endForNewConversation()
    case .loggedOut: requestEndCheck?()
    default: break
    }
    return output
  }

  /// How a send ended and the sentence for the model.
  private static func sendEnd(_ outcome: CompanionSendOutcome) -> (VoiceAgentPromptLock.SendEnd, String) {
    switch outcome {
    case .sent: (.sent, VoiceAgentPromptText.sent)
    case .queued: (.queued, VoiceAgentPromptText.queued)
    case .conversationChanged: (.conversationChanged, VoiceAgentPromptText.conversationChanged)
    case let .refused(.sendBlock(block)): (.refused, VoiceAgentPromptText.blocked(VoiceAgentToolText.blockName(block)))
    case let .refused(.refusal(code, message)):
      if let message = message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
        (.refused, VoiceAgentPromptText.refused(message: message))
      } else {
        (.refused, VoiceAgentPromptText.refused(code: VoiceAgentToolText.refusalName(code)))
      }
    case .loggedOut: (.loggedOut, VoiceAgentPromptText.loggedOut)
    case .timedOut: (.timedOut, VoiceAgentPromptText.uncertain(VoiceAgentPromptText.noAnswer))
    case .failed: (.failed, VoiceAgentPromptText.uncertain(VoiceAgentPromptText.failed))
    case .cancelled: (.cancelled, VoiceAgentPromptText.uncertain(VoiceAgentPromptText.stopped))
    }
  }

  func soundOverAnswer(utterances: Int) {
    soundAt = utterances
  }

  private func refusedSend(_ sentence: String, _ code: String) -> String {
    trace("voice-agent: send refused (\(code))")
    return RealtimeConversation.toolError(sentence)
  }

  /// A refusal after the checks of the call: the prompt goes, and nothing is sent.
  private func droppedSend(_ sentence: String, _ code: String) -> String {
    droppedSend(output: RealtimeConversation.toolError(sentence), code)
  }

  private func droppedSend(output: String, _ code: String) -> String {
    prompts.drop()
    trace("voice-agent: send refused (\(code))")
    return output
  }
}
