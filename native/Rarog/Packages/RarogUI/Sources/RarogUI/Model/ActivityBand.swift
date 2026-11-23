import Foundation
import RarogContract
import RarogCore

// The activity band of the message field card: the card's first line, where the
// activity row stands while the field shows. Owner: transcript.

/// Whether the field card holds the activity row's band. The band opens at the start of a turn and closes at its end:
/// it stands while the session is in a turn (starting, working, or waiting on a decision inside it) or while the row has
/// something to say (interrupting, the agent starting, "connecting…"). The row's text goes out and comes back many
/// times in a turn (a streaming answer has its own cursor); the band does not follow it, so the card does not
/// pulse. An idle session (waiting for input, done, interrupted) with an empty row has no band: the card is only as
/// tall as the field.
public enum ActivityBand {
  /// Session states inside a turn (the core's `turnStates`).
  static let turnStates: Set<SessionState> = [.starting, .running, .waitingPermission, .waitingQuestion]

  /// - Parameters:
  ///   - rowHasContent: the activity row shows a line now (the held ``ActivityRowLine`` is not `nil`).
  ///   - session: the session's state; `nil` = not known yet.
  public static func isOpen(rowHasContent: Bool, session: SessionState?) -> Bool {
    if rowHasContent { return true }
    guard let session else { return false }
    return turnStates.contains(session)
  }
}
