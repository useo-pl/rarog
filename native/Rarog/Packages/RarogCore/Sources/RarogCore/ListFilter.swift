import Foundation
import RarogContract

// The filter segments over the session list: which sessions a segment holds and how many. The tree applies the
// filter (`AppState.projectTree(collapsed:pinned:filter:held:)`); the segment row and its copy live in RarogUI.
// Owner: list.

/// A segment of the list filter. The chosen segment and its held rows live in `RarogNavigation`, in memory only:
/// the app always starts on ``all``.
public enum ListFilter: String, Sendable, Hashable, CaseIterable {
  case all
  /// Waiting for a decision (permission, question, interrupted turn) or failed. An unread result is not here: it
  /// has its own segment, so the two never show the same rows.
  case needsYou
  /// The agent works, also a background task that works.
  case working
  /// A fresh unread result: the dot pulses (`AppState.freshResult`). A result marked unread by hand keeps a still
  /// blue dot and is not here.
  case unread
}

extension AppState {
  /// Whether the session belongs to the segment. Read from the dot (`SessionSummary.statusTone` and, for Unread, its
  /// pulse), never from the row's colour. Effects that follow and are intended: a result held on the list after it
  /// was read (`heldUnread`) has the quiet tone, so it is not unread; an unread result with a working background
  /// task has the working tone, so it counts under Working; a result marked unread by hand has a still dot, so it is
  /// in no segment but All.
  public func listFilterContains(_ filter: ListFilter, _ session: SessionSummary) -> Bool {
    switch filter {
    case .all: true
    case .needsYou: [.waiting, .failed].contains(session.statusTone)
    case .working: session.statusTone == .working
    case .unread: freshResult(session)
    }
  }

  /// How many sessions belong to the segment: all of them, also in collapsed projects.
  public func listFilterCount(_ filter: ListFilter) -> Int {
    sessions.values.count { listFilterContains(filter, $0) }
  }

  /// The sessions of the segment (their identifiers), for the held rows of the chosen segment.
  public func listFilterMembers(_ filter: ListFilter) -> Set<String> {
    Set(sessions.values.lazy.filter { self.listFilterContains(filter, $0) }.map(\.id))
  }
}
