import Foundation
@testable import RarogUI
import Testing

// The discussed session of the voice conversation across sessions and its pick-up, without the conversation
// (`VoiceAgentDiscussion`): a pointing armed only by a call that no cut overtook, one pick-up per read, a cut that uses
// the pointing up, a new read that gives a session its pick-up again. The host's use of it:
// `VoiceAgentSessionsHostTests+Discussion.swift`. All data is synthetic. Owner: voice agent.

private let alpha = VoiceAgentDiscussed(sessionId: "id-a", handle: "s1", project: "orbit", name: "Alpha")
private let birch = VoiceAgentDiscussed(sessionId: "id-b", handle: "s2", project: "willow", name: "Birch")

@Suite("voice conversation across sessions: the discussed session and its pick-up")
struct VoiceAgentDiscussionTests {
  // Catches: a pointing that never arms, or a whole answer that names no session.
  @Test("a pointing, then an answer played whole: that session is picked up, once")
  func pointThenWhole() {
    var discussion = VoiceAgentDiscussion()
    discussion.read(["id-a"])
    discussion.point(alpha, since: discussion.cuts)
    #expect(discussion.session == alpha)
    #expect(discussion.playedWhole() == alpha)
    #expect(discussion.playedWhole() == nil, "the pointing is used")
    #expect(discussion.session == alpha, "the session stays the discussed one")
  }

  // Catches: a cleared pointing that still picks up the session read before.
  @Test("a read that points at no session clears the discussed one: an answer played whole picks up nothing")
  func clearedPicksUpNothing() {
    var discussion = VoiceAgentDiscussion()
    discussion.point(alpha, since: discussion.cuts)
    discussion.read(["id-a", "id-b"])
    discussion.point(nil, since: discussion.cuts)
    #expect(discussion.session == nil)
    #expect(discussion.playedWhole() == nil)
  }

  // Catches: a cut that leaves the pointing armed, so the next whole answer picks up a result nobody heard about.
  @Test("a cut uses the pointing up: the next answer played whole picks up nothing until the session is pointed at")
  func cutUsesThePointingUp() {
    var discussion = VoiceAgentDiscussion()
    discussion.read(["id-a"])
    discussion.point(alpha, since: discussion.cuts)
    discussion.cut()
    #expect(discussion.playedWhole() == nil)
    #expect(discussion.session == alpha, "the bar still names the session")
    discussion.point(alpha, since: discussion.cuts)
    #expect(discussion.playedWhole() == alpha, "pointed at again, the read is still not picked up")
  }

  // Catches: a call overtaken by speech that names its session, or that returns late and replaces the pointing of a
  // call made after the speech, so the answer about that one picks up nothing.
  @Test("a cut between the start and the return of the pointing call: the call points at nothing")
  func cutDuringTheCall() {
    var discussion = VoiceAgentDiscussion()
    let start = discussion.cuts
    discussion.cut()
    discussion.point(alpha, since: start)
    #expect(discussion.session == nil)
    discussion.read(["id-b"])
    discussion.point(birch, since: discussion.cuts)
    discussion.point(alpha, since: start)
    #expect(discussion.session == birch)
    #expect(discussion.playedWhole() == birch)
  }

  // Catches: a second pick-up of the same read, and a newer read that never gets one.
  @Test("one pick-up per read: pointed at again without a new read nothing; after a new read again")
  func onePickUpPerRead() {
    var discussion = VoiceAgentDiscussion()
    discussion.read(["id-a"])
    discussion.point(alpha, since: discussion.cuts)
    #expect(discussion.playedWhole() == alpha)
    discussion.point(alpha, since: discussion.cuts)
    #expect(discussion.playedWhole() == nil, "the same read")
    discussion.read(["id-a", "id-b"])
    discussion.point(nil, since: discussion.cuts)
    discussion.point(alpha, since: discussion.cuts)
    #expect(discussion.playedWhole() == alpha, "a read of several sessions is a new read of each")
  }

  // Catches: the pick-up of the session pointed at before, after the pointing moved on.
  @Test("a pointing that moves on picks up the newer session only")
  func movesOn() {
    var discussion = VoiceAgentDiscussion()
    discussion.read(["id-a", "id-b"])
    discussion.point(alpha, since: discussion.cuts)
    discussion.point(birch, since: discussion.cuts)
    #expect(discussion.playedWhole() == birch)
    #expect(discussion.playedWhole() == nil)
  }
}
