import Foundation
import RarogContract

// Selectors of the activity row: the three time bases of the line and the session event counter. The line model
// in RarogUI builds on them; the reducer (`Reducer+ActivityRow`) moves the counter. Owner: transcript (activity row).

/// The three moments the activity row counts from. `nil` = no such moment (no session, no tool, nothing heard yet).
public struct ActivityClocks: Sendable, Equatable {
  /// Start of the turn clock: the server's `turnSince`, without it `stateSince`. A permission or a question inside
  /// the turn moves `stateSince`, not `turnSince`.
  public var turn: Date?
  /// Start of the running tool: the arrival of a `tool` activity minus its `elapsedSeconds` (the age the server
  /// gives in summaries and transcript snapshots, so a reconnect keeps the clock).
  public var tool: Date?
  /// Start of the silence: the later of the latest message time and the start of the latest activity (its arrival
  /// minus `elapsedSeconds`).
  public var silence: Date?

  public init(turn: Date? = nil, tool: Date? = nil, silence: Date? = nil) {
    self.turn = turn
    self.tool = tool
    self.silence = silence
  }

  /// The bases of one session from its summary and its transcript (either may be unknown).
  public init(session: SessionSummary?, view: TranscriptState?) {
    turn = session.flatMap { $0.turnSince.flatMap(ISOTime.parse) ?? ISOTime.parse($0.stateSince) }
    let activityStart = view.flatMap { view -> Date? in
      guard let activity = view.activity, let at = view.activityAt else { return nil }
      return at.addingTimeInterval(-Double(activity.elapsedSeconds ?? 0))
    }
    tool = view?.activity?.kind == .tool ? activityStart : nil
    // The latest message TIME, not the highest seq: an imported prompt can carry an older `at` than the answer
    // before it (the same rule as `echoBoundary(for:)`).
    let lastMessage = view?.messages.compactMap { ISOTime.parse($0.at) }.max()
    silence = [lastMessage, activityStart].compactMap { $0 }.max()
  }
}

extension AppState {
  /// The activity row's time bases for a session.
  public func activityClocks(_ sessionId: String) -> ActivityClocks {
    ActivityClocks(session: sessions[sessionId], view: transcripts[sessionId])
  }

  /// Events of the session's own stream inside a turn (``TranscriptState/turnEvents``): the row ticks its glyph when
  /// this grows. `0` without a transcript; a transcript evicted and loaded again starts over from `0`.
  public func turnEvents(_ sessionId: String) -> Int {
    transcripts[sessionId]?.turnEvents ?? 0
  }
}
