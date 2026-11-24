import Foundation
import RarogContract

// Drzewo projektów listy: nagłówki projektów w kolejności karty PROJEKTY, pod nimi
// agenci od najstarszego. Czyste odczyty stanu — zwinięte i przypięte projekty podaje pamięć urządzenia
// (``CollapsedProjects``, ``PinnedProjects``), zaznaczenie i ostatnio otwarte wiersze trzyma reduktor
// (`Reducer+List`). Copy i wygląd składa RarogUI.
// Właściciel: lista i projekty.

/// Tożsamość węzła drzewa. Typowana, bo `List(selection:)` bierze DOWOLNY tag za zaznaczenie, a katalog
/// i identyfikator sesji to oba łańcuchy — nagłówek projektu nie może udawać sesji.
public enum ProjectTreeID: Sendable, Hashable {
  case project(String)
  case session(String)
  /// The notice of a filter segment no session belongs to (``ProjectTreeNode/Kind/emptyFilter(_:)``).
  case emptyFilter
}

/// Nagłówek projektu w drzewie: grupa (nazwa, ton licznika, git) i to, ilu jej agentów stoi pod nim.
public struct ProjectTreeHeader: Sendable, Equatable {
  public let group: ProjectGroup
  /// Zwinięty na tym urządzeniu. Projekt bez sesji nie ma czego zwijać — zawsze `false`, nawet gdy jego
  /// katalog został w pamięci zwiniętych.
  public let collapsed: Bool
  /// Ilu agentów widać pod nagłówkiem (czytnik: „zwinięty, widać N z M”).
  public let shown: Int

  /// Wszyscy agenci projektu, także schowani.
  public var total: Int { group.sessions.count }
}

/// Węzeł drzewa: nagłówek projektu albo wiersz agenta. Widok rysuje je jednym `ForEach` po ``id``.
public struct ProjectTreeNode: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    case project(ProjectTreeHeader)
    case session(SessionSummary)
    /// The first row under a filter segment no session belongs to: one sentence for the segment. It is a tree row,
    /// so the collection's items stay the tree's rows (the anchor and the return scroll count them).
    case emptyFilter(ListFilter)
  }

  public let kind: Kind

  public var id: ProjectTreeID {
    switch kind {
    case let .project(header): .project(header.group.cwd)
    case let .session(session): .session(session.id)
    case .emptyFilter: .emptyFilter
    }
  }
}

extension AppState {
  /// List tree: headers in ``projectGroups(pinned:)`` order (projects in `pinned` first, then the rest, each part by
  /// name alphabetically in `CopyLocale.current`, then path), so neither activity nor agent state ever moves a
  /// project; only the human's pin does. Under a header stand the project's agents from the
  /// oldest, all of the directory, Codex in a Rarog terminal included (the same set as ``projectSessions(_:)``, not
  /// ``projectTabs(_:)``). A project without sessions has no header. A collapsed project hides the agents that
  /// ``treeShows(_:collapsed:)`` does not show; a project outside `collapsed` is expanded.
  ///
  /// `filter` other than ``ListFilter/all`` hides rows the human did not choose, and never reorders anything: an
  /// agent row stands when the unfiltered tree shows it and the session belongs to the segment, is in `held` (it was
  /// shown under this segment choice and then left the segment; the navigation keeps the set until the segment
  /// changes, the active segment is tapped again or the app goes to the background), or is ``listSelection``. A
  /// header stands only over a project with a visible row, and its `shown` counts the filtered rows. When no visible
  /// row belongs to the segment, the tree starts with ``ProjectTreeNode/Kind/emptyFilter(_:)``.
  public func projectTree(
    collapsed: CollapsedProjects, pinned: PinnedProjects = PinnedProjects(), filter: ListFilter = .all,
    held: Set<String> = []
  ) -> [ProjectTreeNode] {
    var nodes: [ProjectTreeNode] = []
    var member = false
    for group in projectGroups(pinned: pinned) {
      let folded = !group.sessions.isEmpty && collapsed.contains(group.cwd)
      let shown = group.sessions.filter { session in
        guard treeShows(session, collapsed: folded) else { return false }
        if filter == .all { return true }
        if listFilterContains(filter, session) {
          member = true
          return true
        }
        return held.contains(session.id) || session.id == listSelection
      }
      if filter != .all, shown.isEmpty { continue }
      let header = ProjectTreeHeader(group: group, collapsed: folded, shown: shown.count)
      nodes.append(ProjectTreeNode(kind: .project(header)))
      nodes += shown.map { ProjectTreeNode(kind: .session($0)) }
    }
    if filter != .all, !member { nodes.insert(ProjectTreeNode(kind: .emptyFilter(filter)), at: 0) }
    return nodes
  }
  /// Czy wiersz agenta stoi pod nagłówkiem swojego projektu. Rozwinięty projekt pokazuje wszystkich.
  /// Zwinięty — agenta z rangą uwagi albo pracy w KOLEJNOŚCI listy (``listOrderRank(_:)`` ≤ 2: decyzja, nieodebrany
  /// wynik — także trzymany po odczycie —, awaria, praca, zadanie w tle), wiersz zaznaczony
  /// (``listSelection``) i ostatnio otwarty (``heldOpen``). Ranga, nie wyciszenie wiersza: przy danych nieświeżych
  /// (sesja `stale`, lista z pamięci podręcznej) wyciszenie znika, a zwinięte projekty rozwijałyby się same.
  public func treeShows(_ session: SessionSummary, collapsed: Bool) -> Bool {
    guard collapsed else { return true }
    return listOrderRank(session) <= 2 || session.id == listSelection || heldOpen[session.id] == session.stateSince
  }
}
