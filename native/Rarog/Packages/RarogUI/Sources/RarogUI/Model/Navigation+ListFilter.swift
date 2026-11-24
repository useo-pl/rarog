import Foundation
import RarogCore

// The list filter's state on this device: the chosen segment and its held rows, and the one function that turns
// them into tree rows for the list and for the anchor's announcement on collapse. Owner: list.

extension RarogNavigation {
  /// The tree rows the list shows (`SessionListView`), and the same rows `ProjectTreeRows.toggle` announces to the
  /// anchor: one function, so the announcement always matches the list under a filter.
  public func treeRows(_ state: AppState, openCwd: String?, jumpCwd: String?) -> [ProjectTreeRow] {
    state.projectTreeRows(
      collapsed: collapsedProjects, pinned: pinnedProjects, openCwd: openCwd, jumpCwd: jumpCwd, filter: listFilter,
      held: listFilterHeld)
  }

  /// A tap on a segment. Another segment is chosen; a tap on the active one refreshes it. Either way the held rows
  /// start again from the segment's current sessions, so rows that left it go away now, at the human's gesture.
  public func selectListFilter(_ filter: ListFilter, state: AppState) {
    if listFilter != filter { listFilter = filter }
    releaseListFilterHeld(state)
  }

  /// The segment's current sessions as the held rows: a new segment choice, a refresh, the app going to the
  /// background. All holds nothing.
  public func releaseListFilterHeld(_ state: AppState) {
    let next = listFilter == .all ? [] : state.listFilterMembers(listFilter)
    if next != listFilterHeld { listFilterHeld = next }
  }

  /// Sessions of the segment the list just showed: they stay when they leave it (an agent finishes its work,
  /// a permission gets its answer) until the next release. Writes only on a change, so the list is not redrawn.
  public func noteListFilterShown(_ members: Set<String>) {
    guard listFilter != .all, !members.isSubset(of: listFilterHeld) else { return }
    listFilterHeld.formUnion(members)
  }
}
