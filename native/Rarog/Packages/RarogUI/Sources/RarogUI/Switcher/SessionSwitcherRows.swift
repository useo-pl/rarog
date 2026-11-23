import Foundation
import RarogContract
import RarogCore

// The session switcher under Cmd+S: which sessions are in the window, in
// which order, and what a row shows. The list is the device history of visited sessions (`SessionHistory`, read through
// `RarogNavigation.recentSessions`), any state; the row is `SessionRowModel`. Owner: shortcuts.

/// A row of the switcher window.
public struct SwitcherRow: Sendable, Equatable, Identifiable {
  public let row: SessionRowModel
  /// The session on screen — the "you're here" pill.
  public let isCurrent: Bool

  public var id: String { row.id }
}

/// What stands at the start of a row before the dot (`SwitcherRows.digitKey(at:keyboard:)`).
public enum SwitcherDigitKey: Sendable, Equatable {
  case none
  case blank
  case digit(Int)
}

public enum SwitcherRows {
  /// Rows in the window, at most.
  public static let limit = 10

  /// The snapshot of the window at the opening: the session on screen on top (if the app knows it), then the recently
  /// visited ones, newest first, without a duplicate of the current one; only then the limit. `recent` comes from
  /// `RarogNavigation.recentSessions(_:limit:)` and holds only sessions the app knows; ask it for `limit + 1`, so the
  /// current one taken out of it does not leave a gap.
  public static func snapshot(current: String?, recent: [String], state: AppState) -> [String] {
    var ids: [String] = []
    if let current, state.sessions[current] != nil { ids.append(current) }
    ids += recent.filter { $0 != current }
    return Array(ids.prefix(limit))
  }

  /// The digit key at the start of row `index`: rows 0–9 show their number (the key that picks them), a row after
  /// them keeps an empty room of the same width, so the dots stay in a column. Only in a window that holds the
  /// hardware keyboard; without it the row is as before.
  public static func digitKey(at index: Int, keyboard: Bool) -> SwitcherDigitKey {
    guard keyboard else { return .none }
    return index < SwitcherKey.digits.count ? .digit(index) : .blank
  }

  /// Rows of the window: the order from the snapshot, the content LIVE. A session removed from the app is gone.
  public static func rows(order: [String], state: AppState, current: String?) -> [SwitcherRow] {
    let ordinals = state.duplicateOrdinals
    return order.compactMap { id in
      guard let session = state.sessions[id] else { return nil }
      let row = SessionRowModel(
        session, ordinal: ordinals[id], listStale: state.listStale, turnStage: state.turnStage[id])
      return SwitcherRow(row: row, isCurrent: id == current)
    }
  }
}
