import Foundation
import RarogContract
import RarogCore

// The session switcher window: which tabs are in the window, in which order, and what a row shows. The rows are the
// tabs of the current project in the order of the tab bar (sessions, then terminals), read live from the same list
// the bar draws (`RarogNavigation.stripTabs`); a tab without a target (the terminal invite, a terminal being opened)
// is no row. A session row is `SessionRowModel`, a terminal row its tab label and a quiet line. Owner: shortcuts.

/// A row of the switcher window.
public struct SwitcherRow: Sendable, Equatable, Identifiable {
  public enum Content: Sendable, Equatable {
    case session(SessionRowModel)
    /// A project terminal: the tab label (the foreground process), the quiet line under it (slot, running) and the
    /// sentence for VoiceOver.
    case terminal(label: String, detail: String?, spoken: String)
  }

  /// The tab the row stands for: its identity, the selection and the jump.
  public let tab: ProjectTabRef
  /// The tab's identity on the bar (`ProjectTabModel.id`): the session id, `term.<id>` for a terminal.
  public let key: String
  public let content: Content
  /// The tab on screen — the "you're here" pill.
  public let isCurrent: Bool

  public var id: ProjectTabRef { tab }

  /// The session row model; `nil` for a terminal.
  public var session: SessionRowModel? {
    if case let .session(row) = content { return row }
    return nil
  }

  /// The row in one sentence for VoiceOver, with "you're here" on the current tab.
  public func spoken(now: Date) -> String {
    let base: String =
      switch content {
      case let .session(row): row.spoken(now: now)
      case let .terminal(_, _, spoken): spoken
      }
    return isCurrent ? "\(base), \(UICopy.switcherHere)" : base
  }
}

/// What stands at the start of a row before the dot (`SwitcherRows.digitKey(for:digits:keyboard:)`).
public enum SwitcherDigitKey: Sendable, Equatable {
  case none
  case blank
  case digit(Int)
}

public enum SwitcherRows {
  /// The tab a digit key picks among `order` (the tabs of the bar): the digit the bar draws on it
  /// (`ShortcutMenu.tabDigits`: 1–8 by position, 9 on the last tab past the eighth), and 9 also picks the last tab
  /// when no tab carries 9, like Cmd+9 on the bar. `nil`: no tab has that digit.
  public static func tab(forDigit digit: Int, in order: [ProjectTabRef]) -> ProjectTabRef? {
    if digit == 9 { return order.last }
    guard (1...8).contains(digit), digit <= order.count else { return nil }
    return order[digit - 1]
  }

  /// The digit key at the start of a row: the digit of its tab on the bar. A row without a digit (the middle tabs
  /// past the eighth) keeps an empty room of the same width, so the dots stay in a column. Only in a window that holds
  /// the hardware keyboard; without it the row has no key.
  public static func digitKey(for tab: ProjectTabRef, digits: [ProjectTabRef: Int], keyboard: Bool) -> SwitcherDigitKey {
    guard keyboard else { return .none }
    return digits[tab].map(SwitcherDigitKey.digit) ?? .blank
  }

  /// Rows of the window from the tabs of the bar (`RarogNavigation.stripTabs`), live: the order of the bar, the words
  /// and dots of the sessions. A tab without a target is no row.
  public static func rows(tabs: [ProjectTabModel], state: AppState) -> [SwitcherRow] {
    let ordinals = state.duplicateOrdinals
    return tabs.compactMap { tab -> SwitcherRow? in
      guard let target = tab.target else { return nil }
      switch target {
      case let .session(id):
        guard let session = state.sessions[id] else { return nil }
        let row = SessionRowModel(
          session, ordinal: ordinals[id], listStale: state.listStale, turnStage: state.turnStage[id])
        return SwitcherRow(tab: target, key: tab.id, content: .session(row), isCurrent: tab.current)
      case let .terminal(id):
        let entry = state.terminals.entries.first { $0.id == id }
        let content = SwitcherRow.Content.terminal(
          label: tab.label, detail: entry.flatMap(terminalDetail),
          spoken: UICopy.terminalTabSpoken(entry, current: true))
        return SwitcherRow(tab: target, key: tab.id, content: content, isCurrent: tab.current)
      }
    }
  }

  /// The quiet line of a terminal row: the slot number and "running", when known.
  private static func terminalDetail(_ entry: TerminalListEntry) -> String? {
    var parts: [String] = []
    if entry.slot > 0 { parts.append(UICopy.terminalSlotName(entry.slot)) }
    if entry.live { parts.append(UICopy.terminalRunning) }
    return parts.isEmpty ? nil : UICopy.list(parts, .comma)
  }
}
