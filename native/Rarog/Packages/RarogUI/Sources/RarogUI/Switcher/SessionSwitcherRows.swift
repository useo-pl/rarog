import Foundation
import RarogContract
import RarogCore

// The session switcher window: which tabs are in the window, in which order, and what a row shows. The rows are the
// tabs of the current project in the order of the tab bar (sessions, then terminals), read live from the same list
// the bar draws (`RarogNavigation.stripTabs`); a tab without a target (the terminal invite, a terminal being opened)
// is no row. A session row is `SessionRowModel` without the project (the heading names it once), a terminal row its
// tab label and a quiet line. Owner: shortcuts.

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

  /// The title the row shows: a session's name with `#n` (`SessionRowModel.treeTitle`), a terminal's tab label.
  public var title: String {
    switch content {
    case let .session(row): row.treeTitle
    case let .terminal(label, _, _): label
    }
  }

  /// The row in one sentence for VoiceOver, without the project like the row itself, with "you're here" on the
  /// current tab.
  public func spoken(now: Date) -> String {
    let base: String =
      switch content {
      case let .session(row): row.spoken(now: now, withProject: false)
      case let .terminal(_, _, spoken): spoken
      }
    return isCurrent ? "\(base), \(UICopy.switcherHere)" : base
  }
}

/// The heading of the window: the project once, then "Zakładki projektu · N" (small caps come from the `Eyebrow`
/// style). The view draws the parts apart, so a long project name truncates and the count stays.
public struct SwitcherHeading: Sendable, Equatable {
  /// The project's name; `nil` without a current project.
  public let project: String?
  /// "Zakładki projektu · N".
  public let tabs: String

  /// The whole heading in one line.
  public var text: String { UICopy.list([project, tabs].compactMap(\.self), .dot) }
  /// The window's name for VoiceOver: the project (the rows no longer say it), then "Zakładki projektu".
  public var label: String { UICopy.list([project, UICopy.switcherLabel].compactMap(\.self), .comma) }
}

public enum SwitcherRows {
  /// The heading for the current project's directory (`RarogNavigation.currentProjectCwd`) and the number of rows.
  public static func heading(cwd: String?, count: Int) -> SwitcherHeading {
    SwitcherHeading(project: cwd.map(ProjectPath.name), tabs: UICopy.switcherHeading(count))
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
          session, ordinal: ordinals[id], listStale: state.listStale, turnStage: state.turnStage[id],
          showsProject: false)
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
