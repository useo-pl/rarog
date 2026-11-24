import Foundation
import RarogContract
import RarogCore

// `check_open_requests` of the voice conversation across sessions: the thorough check whether sessions the user has
// looked at still wait for the user. Owner: voice agent. The rule of the user's word stands in ``VoiceAgentCheck``;
// the host (`VoiceAgentSessionsHost`) reads the catalog, announces and keeps the announcement.
//
// - Two steps. A call with no announcement waiting announces: the sessions of the list in the state `seen`, newest
//   state change first, at most ``VoiceAgentCheck/sessionsMax``. No such session is a tool error and announces
//   nothing. The check runs only at the next call, when the user heard the announcement and spoke after it: an
//   answer played out whole since the announcement (`answer(.playedWhole)`), another reply of the model and at least
//   one kept utterance of the user since (the moment the conversation core gives, `RealtimeToolTurn`); any other
//   call is refused with a sentence that tells the model to ask and wait. After a run or a refusal the next call
//   announces again.
// - One consent waits at a time: an announcement drops a waiting prompt of `show_prompt`, a `show_prompt` drops the
//   announcement (`VoiceAgentSessionsHost+Prompt.swift`), and while a send is in flight a call is refused and
//   announces nothing.
// - Speech before that whole answer drops the announcement (`answer(.cut)`): the conversation dropped its result
//   before the model got it, or the user spoke over the answer with it, and the utterance that cut must not count as
//   the user's word. An announcement that a cut overtook during the call is not kept either.
// - The announcement ends when the reply to the user's answer plays out whole without the check: a later call
//   announces again and reads the list again.
// - At the ceiling of questions (``VoiceAgentSessionsHost/questionCeiling``) the call is refused with the sentence of
//   `ask_session` and announces nothing.
// - The run reads the catalog, skips an announced session that left the list or the state `seen`, and asks the rest
//   through the question route one at a time with ``VoiceAgentSessionsHost/checkQuestion``: the next question goes
//   out only after the answer to the one before. Each question counts toward the ceiling, so a run asks at most what
//   the ceiling leaves. The result is plain text: per session a header with the handle, project and name, then the
//   answer's text through the secret mask with block tags neutralized; a note on skipped sessions and one on the
//   cause of a stop close it. A refusal of the route (subscription limit, busy, timeout, failure, the mode off, a lost
//   session) ends the run with what is there and the cause; with nothing there, the cause alone as a tool error.
// - The run is a task of the host's own: a cut (`answer(.cut)`) and the end of the conversation cancel it, so the
//   question in flight is cancelled with its request and none follows. The end rules (``blocked()``) count before
//   each question and after each answer. A run that returns answers clears the discussed session, like a read of
//   several sessions, and leaves no read records. While a run is in flight a call is refused.
// - `client.log`: `voice-agent: check announced (<n>)`, `voice-agent: check <k> of <n>` per question and
//   `voice-agent: check ended (<code>)`, without sessions.

/// The announcement of `check_open_requests` that waits for the user's word, and the sessions it names.
struct VoiceAgentCheck: Sendable, Equatable {
  /// Sessions one check asks at most.
  static let sessionsMax = 10

  /// What a call does.
  enum Step: Sendable, Equatable {
    /// No announcement waits: announce.
    case announce
    /// An announcement waited, but this call came in the reply that announced or with no kept utterance since.
    case notAgreed
    /// The user's word came: run over these server session ids, in the announced order.
    case run([String])
  }

  private struct Announcement: Sendable, Equatable {
    let turn: RealtimeToolTurn
    let sessionIds: [String]
    /// An answer played out whole since the announcement: the user heard about the check.
    var heard = false
  }

  private var announcement: Announcement?

  /// The step of a call at `turn`. A waiting announcement is used up either way.
  mutating func step(at turn: RealtimeToolTurn) -> Step {
    guard let announced = announcement else { return .announce }
    announcement = nil
    guard announced.heard, turn.response != announced.turn.response,
      turn.utterances > announced.turn.utterances
    else { return .notAgreed }
    return .run(announced.sessionIds)
  }

  /// An answer played out whole. The first one since the announcement told the user about the check. A further one
  /// answered the user's reply without the check, and the announcement ends.
  mutating func playedWhole() {
    guard let announced = announcement else { return }
    if announced.heard { announcement = nil } else { announcement?.heard = true }
  }

  /// Speech cut what was in flight. True when it dropped an announcement the user had not heard whole; the reply to
  /// an announcement heard whole also arrives as a cut and keeps it.
  mutating func cut() -> Bool {
    guard let announced = announcement, !announced.heard else { return false }
    announcement = nil
    return true
  }

  /// The announcement the model got at `turn`.
  mutating func announced(_ sessionIds: [String], at turn: RealtimeToolTurn) {
    announcement = Announcement(turn: turn, sessionIds: sessionIds)
  }

  /// The sessions a check asks: rows in the state `seen`, newest state change first, at most ``sessionsMax``.
  static func pick(from rows: [VoiceAgentSessionRow]) -> [VoiceAgentSessionRow] {
    let seen = rows.filter { $0.state == .seen }
    return Array(seen.sorted { ($0.since ?? .distantPast) > ($1.since ?? .distantPast) }.prefix(sessionsMax))
  }
}

extension VoiceAgentSessionsHost {
  /// The question the check asks each session through the question route.
  static let checkQuestion =
    "Is anything in this session still waiting for the user: a question asked of them, a decision or an approval "
    + "that was never answered? Answer in at most two sentences. If nothing waits, answer exactly: "
    + "Nothing waits for the user."

  /// `check_open_requests` at `turn`.
  func checkOpenRequests(at turn: RealtimeToolTurn) async -> String {
    guard checkRun == nil else {
      trace("voice-agent: check ended (running)")
      return RealtimeConversation.toolError("The check is still running. Wait for its result.")
    }
    switch check.step(at: turn) {
    case .announce:
      return await announceCheck(at: turn)
    case .notAgreed:
      trace("voice-agent: check ended (not-agreed)")
      return RealtimeConversation.toolError(
        "The user has not agreed to the check. Tell the user what the check would do, ask whether to start "
          + "and wait for the answer.")
    case let .run(sessionIds):
      // The run is a task of the host's own, so a cut and the end can cancel it with its request in flight.
      let run = Task { await self.runCheck(sessionIds) }
      checkRun = run
      let output = await run.value
      checkRun = nil
      return output
    }
  }

  /// The plain cause in the stop note of a run that the question route refused with `outcome`.
  static func checkStopSentence(_ outcome: CompanionAskOutcome) -> String { CheckStop.route(outcome).sentence }

  /// Why a run stopped before its last session.
  @MainActor
  private enum CheckStop {
    case route(CompanionAskOutcome)
    case ceiling

    var code: String {
      switch self {
      case .ceiling: "ceiling"
      case let .route(outcome):
        switch outcome {
        case .limit: "limit"
        case .busy: "busy"
        case let .failed(code, _): VoiceAgentToolText.timedOut(code) ? "timeout" : "failed"
        case .disabled: "off"
        case .answer, .refused, .loggedOut, .cancelled: "unreachable"
        }
      }
    }

    var sentence: String {
      switch self {
      case .ceiling: VoiceAgentSessionsHost.ceilingSentence
      case .route(.busy):
        "Another question about a session is still being checked on the server, so the check stopped. Tell the "
          + "user it can be tried again in a moment."
      case let .route(outcome): VoiceAgentToolText.refusal(outcome)
      }
    }
  }

  /// The run over the announced sessions: each one still in the list in the state `seen`, one question at a time,
  /// within what the ceiling leaves.
  private func runCheck(_ sessionIds: [String]) async -> String {
    let start = discussion.cuts
    if case let .refused(output, code) = await refresh() {
      trace("voice-agent: check ended (\(code))")
      return output
    }
    if let refusal = blocked() {
      trace("voice-agent: check ended (\(refusal.code))")
      return refusal.output
    }
    let targets = sessionIds.compactMap { id in rows.first { $0.sessionId == id && $0.state == .seen } }
    guard !targets.isEmpty else {
      trace("voice-agent: check ended (none)")
      return RealtimeConversation.toolError(
        "None of the announced sessions is still in the state seen, so nothing was asked. Tell the user.")
    }
    let room = Self.questionCeiling - questions
    guard room > 0 else {
      trace("voice-agent: check ended (ceiling)")
      return Self.ceilingRefusal
    }
    let asked = Array(targets.prefix(room))
    var blocks: [String] = []
    var stop: CheckStop? = asked.count < targets.count ? .ceiling : nil
    for (index, row) in asked.enumerated() {
      if let refusal = blocked() {
        trace("voice-agent: check ended (\(refusal.code))")
        return refusal.output
      }
      if Task.isCancelled || discussion.overtaken(since: start) { return checkCut(blocks) }
      // `ask_session` shares the ceiling and may have used the room while this run waited for an answer.
      guard questions < Self.questionCeiling else {
        stop = .ceiling
        break
      }
      questions += 1
      trace("voice-agent: check \(index + 1) of \(asked.count)")
      let outcome = await backend.ask(sessionId: row.sessionId, question: Self.checkQuestion)
      if let refusal = blocked() {
        trace("voice-agent: check ended (\(refusal.code))")
        return refusal.output
      }
      if Task.isCancelled || discussion.overtaken(since: start) { return checkCut(blocks) }
      guard case let .answer(answer) = outcome else {
        stop = .route(outcome)
        break
      }
      blocks.append(
        "## \(row.handle) · \(row.project) · \(row.name)\n\(VoiceAgentSessionsText.prepare(answer.answer))")
    }
    trace("voice-agent: check ended (\(stop?.code ?? "done"))")
    guard !blocks.isEmpty else { return RealtimeConversation.toolError(stop?.sentence ?? "") }
    // A run is about many sessions: like a read of several, it clears the discussed session.
    point(at: nil, since: start)
    var parts = blocks
    if targets.count < sessionIds.count {
      parts.append("[\(sessionIds.count - targets.count) of the announced sessions left the state seen; not asked.]")
    }
    if let stop { parts.append("[The check stopped: \(stop.sentence)]") }
    return parts.joined(separator: "\n\n")
  }

  /// Speech or the end cut the run: no further question. The conversation drops this result.
  private func checkCut(_ blocks: [String]) -> String {
    trace("voice-agent: check ended (cut)")
    return blocks.joined(separator: "\n\n")
  }

  private func announceCheck(at turn: RealtimeToolTurn) async -> String {
    let start = discussion.cuts
    if case let .refused(output, code) = await refresh() {
      trace("voice-agent: check ended (\(code))")
      return output
    }
    guard questions < Self.questionCeiling else {
      trace("voice-agent: check ended (ceiling)")
      return Self.ceilingRefusal
    }
    if let refusal = blocked() {
      trace("voice-agent: check ended (\(refusal.code))")
      return refusal.output
    }
    let picked = VoiceAgentCheck.pick(from: rows)
    guard !picked.isEmpty else {
      trace("voice-agent: check ended (none)")
      return RealtimeConversation.toolError(
        "No session in the list is in the state seen, so there is nothing to check. Tell the user.")
    }
    let output = RealtimeConversation.toolResult(
      "The check would ask \(picked.count) sessions the user has looked at, one by one, about 20 seconds each. "
        + "Ask the user whether to start.")
    guard !discussion.overtaken(since: start) else {
      trace("voice-agent: check ended (cut)")
      return output
    }
    // One consent waits at a time: the user's next word must not confirm a prompt and the check at once. A send in
    // flight may end without saying whether the prompt arrived and keep its prompt, so nothing is announced beside it.
    guard sendRun == nil else {
      trace("voice-agent: check ended (sending)")
      return RealtimeConversation.toolError(VoiceAgentPromptText.checkWhileSending)
    }
    check.announced(picked.map(\.sessionId), at: turn)
    trace("voice-agent: check announced (\(picked.count))")
    if prompts.prompt != nil || prompts.pending != nil {
      prompts.drop()
      trace("voice-agent: prompt dropped (check)")
    }
    return output
  }
}
