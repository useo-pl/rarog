import Foundation
import RarogContract

// Reducer branches of the activity row: the session event counter behind the data-driven glyph tick. Called from
// the frame branches in `Reducer.swift` in one line. Owner: transcript (activity row).
extension AppState {
  /// One event of a session's stream: an `activity` other than `idle` (the end of movement), or a message that
  /// changed the transcript. Counts only on the session's own channel, because the server sends each activity on both
  /// channels (the global copy would count it twice), and only inside a turn. Snapshots never come here.
  mutating func noteTurnEvent(_ sessionId: String, source: FrameSource) {
    guard case let .session(channel) = source, channel == sessionId, transcripts[sessionId] != nil,
      let state = sessions[sessionId]?.state, Self.turnStates.contains(state)
    else { return }
    transcripts[sessionId]?.turnEvents += 1
  }
}
