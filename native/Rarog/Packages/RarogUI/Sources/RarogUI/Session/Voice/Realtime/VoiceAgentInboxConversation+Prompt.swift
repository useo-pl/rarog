import Foundation
import RarogContract
import RarogCore

// The prompt block of a card's voice conversation in its owner (`VoiceAgentInboxConversation`): the card's prompt
// pair, the block's actions for the view, the send with its recovery, and the hand-back of the text. Owner: voice
// agent. The block's states and its voice lock are the pure type `InboxPromptBlock`; every sentence for the model
// stands in `RealtimeInstructions+InboxHost.swift`.
//
// - `show_prompt(text)`: an empty text, a card that takes no reply (a decision card says so) and the block's own
//   refusals (too long, editing, sending) show nothing. Otherwise the block takes the next version with the card's
//   turn of this moment (`AppState.inboxReplyTarget`, the selector `replyFromInbox` checks), and the app reads exactly
//   the text (`RealtimeToolResult.read`). The read-along's progress of this version feeds ``readProgress``, and its
//   end, which comes once and before the result, tells the block how the reading ended: whole, cut or not read.
// - Edit and Send during the reading stop its audio (`VoiceAgentSession.stopReading`): the conversation cuts it as
//   speech over it would, so the version stays not heard whole and `show_prompt` gives the model no result.
// - `send_prompt` asks the block's voice lock with the call's moment (`RealtimeToolTurn`) and the login of the
//   conversation's start (`VoiceAgentSession.loginUnchanged`); the Send button sends from every phase but sending,
//   and a blank edited text sends nothing. Either send is one task that awaits `replyFromInbox` with the turn of the
//   show; `send_prompt` returns its outcome.
// - The outcome counts for the block only while that send is in flight (its ticket). `SendRecovery.plan` decides,
//   with the block in sight as the field in sight: accepted or queued drops the block and shows "Sent to the session"
//   for an accepted send; a text back stands again in the block with the reason and the refused outbox entry is
//   deleted; an entry kept in the transcript drops the block; a draft drops the block and hands its text back. A card
//   that changed before the send drops the block and hands its text back with the reason: the card's field answers
//   the card's turn of now, while the block would meet the same change at each Send. An outcome whose block is gone
//   (the conversation ended, the screen left) goes to the reply field's rule, as after ↑, so nothing lands twice.
// - The hand-back is one operation: on top of the card's reply field while the Inbox stands in sight and the card's
//   field is on screen, otherwise into the session's draft (`ComposerDrafts.save`).
// - `client.log`: `voice-agent: prompt shown`, `prompt read whole`, `prompt not read`, `prompt refused (<code>)`,
//   `send refused (<code>)` and `send ended (<code>)`, never the text.

extension VoiceAgentInboxConversation {
  // MARK: - Actions of the view

  /// The block's Send button may send now: a block that is not sending, with a text that is not blank.
  var blockSendable: Bool {
    guard let block, block.phase != .sending else { return false }
    return !(block.edited ?? block.text).allSatisfy(\.isWhitespace)
  }

  /// Edit: the block becomes its own text field with the agent's text.
  func edit() {
    guard let phase = block?.phase, phase == .reading || phase == .ready else { return }
    let stopsReading = block?.edit() == true
    readProgress = nil
    if stopsReading { session?.stopReading() }
  }

  /// The person's text in the block's field.
  func editText(_ text: String) {
    block?.editText(text)
  }

  /// Cancel: back to the agent's text.
  func cancelEdit() {
    block?.cancelEdit()
  }

  /// The block's Send button: the agent's text, or the person's while editing; a blank text sends nothing.
  func sendBlock() {
    guard let sessionId = target, blockSendable, let started = block?.send(id: UUID()) else { return }
    if started.stopsReading {
      readProgress = nil
      session?.stopReading()
    }
    _ = deliver(started.send, sessionId: sessionId)
  }

  // MARK: - The prompt pair

  /// `show_prompt` of `text` (`nil`: empty) on `sessionId`'s card at `turn`.
  func showPrompt(_ text: String?, at turn: RealtimeToolTurn, sessionId: String) -> RealtimeToolResult {
    guard sessionId == target else {
      return refusedShow(RealtimeInstructions.inboxPromptRefused("the card's conversation ended"), "ended")
    }
    guard let text else { return refusedShow(RealtimeInstructions.inboxPromptEmpty, "empty") }
    guard let head = backend.state.inboxReplyTarget(sessionId) else {
      let decision = backend.state.inboxVoiceTarget(sessionId)?.kind == .decision
      let reason = decision ? "the card waits for a decision and takes no reply" : "the card takes no reply now"
      return refusedShow(RealtimeInstructions.inboxPromptRefused(reason), decision ? "decision" : "no-reply")
    }
    if let refusal = InboxPromptBlock.show(text, turnId: head.turnId, response: turn.response, on: &block) {
      return refusedShow(RealtimeInstructions.inboxShowRefused(refusal), refusal.rawValue)
    }
    guard let version = block?.version else { return refusedShow(RealtimeInstructions.inboxPromptGone, "gone") }
    readProgress = ReadingProgress(spokenPrefix: 0, end: nil)
    trace("voice-agent: prompt shown")
    return .read(
      text,
      then: { [weak self] outcome in
        self?.promptRead(version, outcome) ?? RealtimeConversation.toolError(RealtimeInstructions.inboxPromptGone)
      },
      progress: { [weak self] progress in self?.readingProgress(version, progress) })
  }

  /// `send_prompt` on `sessionId`'s card at `turn` → the result for the model.
  func sendPrompt(at turn: RealtimeToolTurn, sessionId: String) async -> String {
    guard sessionId == target, block != nil else {
      return refusedSend(RealtimeInstructions.inboxNoPrompt, "no-prompt")
    }
    let loggedIn = session?.loginUnchanged == true
    let asked = block?.sendByVoice(
      id: UUID(), response: turn.response, utteranceAfterReading: turn.utteranceAfterReading, loggedIn: loggedIn)
    switch asked {
    case let .success(send)?:
      return await deliver(send, sessionId: sessionId).value
    case let .failure(refusal)?:
      return refusedSend(RealtimeInstructions.inboxSendRefused(refusal), refusal.rawValue)
    case nil:
      return refusedSend(RealtimeInstructions.inboxNoPrompt, "no-prompt")
    }
  }

  // MARK: - The reading

  /// The read-along of `version`: the highlight while it reads, and its end for the block.
  private func readingProgress(_ version: Int, _ progress: ReadingProgress) {
    guard block?.version == version, block?.phase == .reading else { return }
    readProgress = progress
    guard let end = progress.end else { return }
    block?.readingEnded(version: version, Self.readEnd(end))
  }

  /// The reading of `version` ended (whole or not read; a cut, also by Edit or Send, never gets here) → the result
  /// for the model.
  private func promptRead(_ version: Int, _ outcome: RealtimeReadingOutcome) -> String {
    guard let current = block, current.version == version, current.phase == .reading || current.phase == .ready
    else {
      trace("voice-agent: prompt refused (gone)")
      return RealtimeConversation.toolError(RealtimeInstructions.inboxPromptGone)
    }
    // The progress's end comes first; a reading whose end did not reach it ends here.
    if current.phase == .reading { block?.readingEnded(version: version, outcome == .whole ? .whole : .notRead) }
    if block?.heardWhole == true {
      trace("voice-agent: prompt read whole")
      return RealtimeConversation.toolResult(RealtimeInstructions.inboxPromptHeard)
    }
    trace("voice-agent: prompt not read")
    return RealtimeConversation.toolError(RealtimeInstructions.inboxPromptNotHeard)
  }

  private static func readEnd(_ end: ReadingProgress.End) -> InboxPromptBlock.ReadEnd {
    switch end {
    case .whole: .whole
    case .cut: .cut
    case .notRead: .notRead
    }
  }

  // MARK: - The send

  /// One send of the block: the request, then its outcome. The task holds the field strongly, so an outcome that
  /// comes after this owner went still finds the field's way back. → the result for the model.
  private func deliver(_ send: InboxPromptBlock.Send, sessionId: String) -> Task<String, Never> {
    let backend = self.backend
    let field = self.field
    // The conversation that sent, with its mark: a late outcome shows "sent" only while it is still the current one.
    weak let sending = session
    let mark = session?.sendMark
    return Task { [weak self] in
      let outcome = await backend.replyFromInbox(send.text, to: sessionId, turnId: send.turnId)
      guard let self else {
        field?.voiceReplyFinished(outcome, text: send.text, sessionId: sessionId)
        return RealtimeConversation.toolError(RealtimeInstructions.inboxPromptGone)
      }
      let output = self.settle(send, outcome, sessionId: sessionId, field: field)
      if case .sent(.accepted) = outcome, self.block == nil, let sending, sending === self.session {
        sending.fieldSent(mark)
      }
      return output
    }
  }

  /// The outcome of `send` → what the block makes of it, and the result for the model.
  private func settle(
    _ send: InboxPromptBlock.Send, _ outcome: InboxReplyOutcome, sessionId: String,
    field: (any VoiceAgentInboxField)?
  ) -> String {
    guard let current = block, current.phase == .sending, current.inFlight == send else {
      // The block is gone or another send is its own: the text goes the field's way.
      (field ?? self.field)?.voiceReplyFinished(outcome, text: send.text, sessionId: sessionId)
      trace("voice-agent: send ended (not-mine)")
      return RealtimeInstructions.inboxSendResult(outcome, settlement: .notMine, queued: false)
    }
    let inSight = fieldInSight
    let recovery: SendRecovery
    let reason: (text: String, isError: Bool)?
    var queued = false
    switch outcome {
    case .cardChanged:
      // The block would meet the same changed card at each Send; the card's field answers its turn of now.
      recovery = .saveDraft
      reason = (UICopy.inboxReplyCardChanged, false)
    case let .sent(sent):
      if case let .notPersisted(detail) = sent {
        backend.reportUnhandled("send queue: the disk write failed (\(detail.prefix(80)))")
      }
      if case let .accepted(id) = sent { queued = backend.state.outbox.first { $0.id == id }?.isQueued == true }
      recovery = SendRecovery.plan(sent, screenAttached: inSight)
      let result = UICopy.sendResult(sent, session: backend.state.sessions[sessionId])
      reason = result.text.map { ($0, result.isError) }
    }
    let settlement = InboxPromptBlock.settle(&block, send: send, recovery, reason: reason?.text)
    switch settlement {
    case .restored:
      if case let .restoreToField(discard?) = recovery { backend.discard(discard) }
    case let .handOver(text):
      handBack(text, note: reason, sessionId: sessionId)
    case .sent, .keptInTranscript, .notMine:
      break
    }
    if block == nil { readProgress = nil }
    trace("voice-agent: send ended (\(Self.code(settlement)))")
    return RealtimeInstructions.inboxSendResult(outcome, settlement: settlement, queued: queued)
  }

  private static func code(_ settlement: InboxPromptBlock.Settlement) -> String {
    switch settlement {
    case .notMine: "not-mine"
    case .sent: "sent"
    case .restored: "restored"
    case .keptInTranscript: "kept"
    case .handOver: "handed-over"
    }
  }

  // MARK: - The hand-back

  /// The end of the conversation: the block goes, and the person's text, or else the agent's, is handed back; a send
  /// in flight keeps its text to its own recovery.
  func releaseBlock() {
    let sessionId = target
    readProgress = nil
    guard let text = InboxPromptBlock.end(&block), let sessionId else { return }
    handBack(text, note: nil, sessionId: sessionId)
  }

  /// The block's text goes on top of the card's reply field while the Inbox stands in sight and that field is on
  /// screen, otherwise into the session's draft; never both.
  private func handBack(_ text: String, note: (text: String, isError: Bool)?, sessionId: String) {
    if fieldInSight,
      field?.handBack(text, note: note?.text, noteIsError: note?.isError ?? false, into: sessionId) == true
    {
      return
    }
    drafts.save(text, note: note?.text, for: sessionId)
  }

  // MARK: - Refusals

  private func refusedShow(_ sentence: String, _ code: String) -> RealtimeToolResult {
    trace("voice-agent: prompt refused (\(code))")
    return .output(RealtimeConversation.toolError(sentence))
  }

  private func refusedSend(_ sentence: String, _ code: String) -> String {
    trace("voice-agent: send refused (\(code))")
    return RealtimeConversation.toolError(sentence)
  }
}
