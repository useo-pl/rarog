import Foundation

// Which session the voice conversation across sessions discusses, and when the voice agent picks up its result.
// Owner: voice agent. The host (`VoiceAgentSessionsHost+Discussion.swift`) keeps one value per conversation and feeds
// it its tool calls and the answer events of the conversation core (`RealtimeConversation+Answer.swift`); the rule
// stands here, apart from the conversation, so its tests need no conversation.
//
// Rules:
// - A tool call that returns points at a session or clears the discussed session (which calls do which: the host).
// - A call that a cut overtook (a cut between its start and its return) changes nothing: the conversation drops its
//   result, so the session it read or named is not the discussed one, and a pointing made after the cut stays.
// - The first answer that plays out whole after an armed pointing uses it: it names the session to pick up, unless
//   the newest read of that session already had its pick-up. A cut uses the pointing up without a pick-up; the session
//   stays the discussed one.
// - A new read of a session gives it a pick-up again.

/// The session the voice agent discusses: the masked project and name the list gave the model.
struct VoiceAgentDiscussed: Sendable, Equatable {
  let sessionId: String
  let handle: String
  let project: String
  let name: String
}

/// The discussed session and its pick-up in one conversation.
struct VoiceAgentDiscussion: Sendable, Equatable {
  /// The discussed session; `nil` = none.
  private(set) var session: VoiceAgentDiscussed?
  /// The next answer that plays out whole picks up ``session``.
  private(set) var armed = false
  /// Cuts so far: a call takes the count at its start and gives it back at its return (``point(_:since:)``).
  private(set) var cuts = 0
  /// Sessions whose newest read used its pick-up: it went out, or the host could not send it.
  private(set) var pickedUp: Set<String> = []

  /// Speech over the answer or a lost playback: the pointing is used up.
  mutating func cut() {
    cuts += 1
    armed = false
  }

  /// Sessions read again: each has a pick-up again.
  mutating func read(_ sessionIds: [String]) {
    pickedUp.subtract(sessionIds)
  }

  /// A cut came since the count `since`, taken at a call's start: the conversation drops that call's result.
  func overtaken(since: Int) -> Bool { since != cuts }

  /// A call that started at cut count `since` returned and points at `session`; `nil` clears the discussed session.
  /// A call a cut overtook changes nothing.
  mutating func point(_ session: VoiceAgentDiscussed?, since: Int) {
    guard !overtaken(since: since) else { return }
    self.session = session
    armed = session != nil
  }

  /// An answer played out whole: the session to pick up at this answer, at most once per read. The pointing is used.
  mutating func playedWhole() -> VoiceAgentDiscussed? {
    defer { armed = false }
    guard armed, let session, pickedUp.insert(session.sessionId).inserted else { return nil }
    return session
  }
}
