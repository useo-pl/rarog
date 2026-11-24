import Foundation
import RarogContract
import RarogCore

// The discussed session of the voice conversation across sessions and the voice agent's pick-up of its result.
// Owner: voice agent. The rule of the pointing stands in `VoiceAgentDiscussion.swift`; here the host feeds it and sends
// the pick-up (`RarogStore.pickUpCompanionResult`, `POST /api/sessions/<id>/seen` with `by: voice-agent`).
//
// - Pointing: `discuss_session` of a session read in this conversation, and a `read_sessions` call with exactly one
//   handle that read one session, point at that session; every other successful read clears the discussed session
//   (several handles, a filter, also a filter that picked one session). `discuss_session` of an unknown handle or of a
//   session not read in this conversation is refused and changes nothing. A call that a cut overtook changes nothing
//   either: no read record, no pointing (the conversation drops its result).
// - Pick-up: when the answer that follows an armed pointing plays out whole, the host sends the pick-up of that session
//   with the `conversation` and `readMark` of its newest read in this conversation, as the server sent them. None for a
//   read without messages (its mark names no read), after the end of the conversation or while ``blocked()`` refuses,
//   and none twice for one read.
// - The pick-up's outcome changes nothing in the app and says nothing to the model; the conversation goes on. The
//   server's session frame brings `seenBy` when it accepted the pick-up.
// - `client.log`: `voice-agent: pick-up accepted` or `voice-agent: pick-up refused (<code>)`, without the session.

extension VoiceAgentSessionsHost {
  /// The discussed session; `nil` = none.
  var discussed: VoiceAgentDiscussed? { discussion.session }

  /// What the conversation is about for the app's microphone: the waiting prompt's session, else the discussed
  /// session, by the project and name the bar shows; with neither, all sessions.
  var microphoneSubject: MicrophoneSubject {
    if let shown = prompts.shown { return .session(project: shown.project, name: shown.name) }
    if let discussed { return .session(project: discussed.project, name: discussed.name) }
    return .allSessions
  }

  /// The prompt of `show_prompt` waits for the user's word (the bar's prompt card stands).
  var promptWaits: Bool { prompts.shown != nil }

  func answer(_ event: RealtimeConversation.AnswerEvent) {
    switch event {
    case .cut:
      discussion.cut()
      // Speech before the user heard the check's announcement whole drops it.
      if check.cut() { trace("voice-agent: check ended (cut)") }
      // Speech stops the check: the question in flight is cancelled with its request, and none follows.
      checkRun?.cancel()
    case .playedWhole:
      check.playedWhole()
      // The model got the last send's outcome unless a cut came since the call that returned it.
      prompts.playedWhole(cuts: discussion.cuts)
      guard let target = discussion.playedWhole(), blocked() == nil, let read = reads[target.sessionId],
        read.hadMessages
      else { return }
      pickUp(read)
    }
  }

  /// A tool call that started at cut count `since` returned: `row` becomes the discussed session (`nil`: none).
  func point(at row: VoiceAgentSessionRow?, since: Int) {
    let session = row.map {
      VoiceAgentDiscussed(sessionId: $0.sessionId, handle: $0.handle, project: $0.project, name: $0.name)
    }
    discussion.point(session, since: since)
  }

  private func pickUp(_ read: VoiceAgentSessionRead) {
    Task { [weak self] in
      // The conversation may end before the task starts: the end drops the reads, and no pick-up goes out after it.
      guard let self, blocked() == nil else { return }
      let outcome = await backend.pickUpCompanionResult(
        sessionId: read.sessionId, conversation: read.conversation, readMark: read.readMark)
      switch outcome {
      case .pickedUp: trace("voice-agent: pick-up accepted")
      default: trace("voice-agent: pick-up refused (\(Self.pickUpCode(outcome)))")
      }
    }
  }

  /// The `client.log` code of a refused pick-up.
  private static func pickUpCode(_ outcome: CompanionPickUpOutcome) -> String {
    switch outcome {
    case .pickedUp: "accepted"
    case .resultChanged: "result-changed"
    case .disabled: "off"
    case .outsideCatalog: "unknown-session"
    case .loggedOut: "logged-out"
    case .cancelled: "cancelled"
    case .timedOut: "timeout"
    case .refused, .failed: "failed"
    }
  }
}
