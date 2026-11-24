import Foundation
import RarogContract
import RarogCore

// Wiersze drzewa projektów listy: nagłówek projektu i wiersz agenta bez członu projektu.
// Kolejność, skład i widoczność liczy rdzeń (`AppState.projectTree`); tu jest tylko prezentacja. Właściciel: lista
// i projekty.

/// Nagłówek projektu w drzewie: treść wiersza karty PROJEKTY (nazwa, licznik w kolorze najpilniejszego stanu, gałąź
/// z rozjazdem, ścieżka przy niejednoznacznej nazwie; „otwarty” i „cel Cmd+L” tylko dla czytnika) oraz zwinięcie.
public struct ProjectTreeHeaderModel: Sendable, Equatable, Identifiable {
  public let row: ProjectRowModel
  /// Zwinięty na tym urządzeniu (projekt bez sesji nigdy — nie ma czego zwijać).
  public let collapsed: Bool
  /// Ilu agentów widać pod nagłówkiem.
  public let shown: Int
  /// Pinned on this device (``PinnedProjects``): a pin glyph after the name and "pinned" in the reader's value.
  public var pinned = false

  public var id: String { row.cwd }

  /// Strzałka zwijania istnieje tylko przy projekcie z sesjami.
  public var collapsible: Bool { row.agents > 0 }

  /// Wartość dla czytnika: „zwinięty, widać 1 z 3”, „rozwinięty”; projekt bez sesji — pusto. A pinned project
  /// says "pinned" before that.
  public var spokenValue: String {
    var parts: [String] = []
    if pinned { parts.append(UICopy.treePinnedValue) }
    if collapsible {
      parts.append(collapsed ? UICopy.treeCollapsedValue(shown: shown, total: row.agents) : UICopy.treeExpandedValue)
    }
    return UICopy.list(parts, .comma)
  }

  /// Etykieta strzałki: co zrobi tap.
  public var toggleLabel: String {
    UICopy.treeToggleLabel(collapse: !collapsed, project: row.name)
  }

  /// Stuknięcie w treść nagłówka (i Return na nagłówku z fokusem): projekt z agentami zwija się albo rozwija jak pod
  /// strzałką, bez ruszania trasy. Projekt bez agentów nie ma czego zwijać, więc wchodzi w projekt.
  public var tap: ProjectTreeHeaderTap {
    collapsible ? .toggle(collapse: !collapsed) : .open
  }
}

/// Skutek stuknięcia w nagłówek projektu (`ProjectTreeHeaderModel.tap`).
public enum ProjectTreeHeaderTap: Sendable, Equatable {
  /// Zwinięcie (`true`) albo rozwinięcie projektu; trasa stoi.
  case toggle(collapse: Bool)
  /// Wejście w projekt (`RarogNavigation.openProject`): zapamiętana zakładka, ostatnio aktywna sesja albo ekran
  /// projektu.
  case open
}

/// Wiersz drzewa: nagłówek projektu albo agent. Tożsamość typowana jak w rdzeniu (`ProjectTreeID`): zaznaczenie
/// nagłówka to jego stuknięcie (`ProjectTreeHeaderModel.tap`), nigdy „sesja o identyfikatorze katalogu”.
public enum ProjectTreeRow: Sendable, Equatable, Identifiable {
  case header(ProjectTreeHeaderModel)
  case session(SessionRowModel)
  /// The sentence of a filter segment no session belongs to, first in the list (`ProjectTreeNode.Kind.emptyFilter`).
  case emptyFilter(ListFilter)

  public var id: ProjectTreeID {
    switch self {
    case let .header(header): .project(header.row.cwd)
    case let .session(row): .session(row.id)
    case .emptyFilter: .emptyFilter
    }
  }

  public var isHeader: Bool {
    if case .header = self { return true }
    return false
  }

  /// Sesja wiersza agenta; nagłówek — `nil`.
  public var sessionId: String? {
    if case let .session(row) = self { return row.id }
    return nil
  }
}

extension Array where Element == ProjectTreeRow {
  /// Nagłówek projektu o tym katalogu; `nil`, gdy drzewo go nie ma.
  public func header(_ cwd: String) -> ProjectTreeHeaderModel? {
    for row in self {
      if case let .header(header) = row, header.row.cwd == cwd { return header }
    }
    return nil
  }
}

/// Odcinek prowadnicy drzewa w komórce wiersza: pionowa kreska w osi strzałki, od nagłówka
/// do ostatniego widocznego agenta projektu — tylko w projekcie rozwiniętym („dla zwiniętych projektów możesz ukrywać
/// tę pionową linię”). Kształt odcinków rysuje `ProjectTreeGuide` (widok).
public enum TreeGuide: Sendable, Equatable {
  /// Bez kreski: nagłówek bez widocznych agentów pod sobą i każdy wiersz zwiniętego projektu, także agenci, którzy
  /// stoją pod jego nagłówkiem.
  case none
  /// Nagłówek rozwiniętego projektu z widocznym agentem pod sobą: od strzałki do dołu komórki.
  case start
  /// Agent, pod którym w tym samym projekcie stoi jeszcze agent: cała wysokość komórki.
  case middle
  /// Ostatni widoczny agent projektu: od góry komórki do dołu bloku tekstu.
  case end
}

/// Rola wiersza w układzie drzewa: odcinek prowadnicy i oddech nad nagłówkiem. Liczy ją
/// `layout(_:)` z kolejności wierszy i z linii gałęzi nagłówków — reguła równych odstępów stoi przy stałych
/// (`SessionListMetrics`).
public struct ProjectTreeRowLayout: Sendable, Equatable {
  public var guide: TreeGuide
  /// Oddech nad nagłówkiem (plama i fokus zaczynają się pod nim); pierwszy wiersz listy i agent — 0.
  public var gapAbove: CGFloat
  /// The row belongs to the active project, the one on screen (`RarogNavigation.currentProjectCwd`): its guide is
  /// brighter (`PaletteTokens.treeGuideActive`).
  public var active: Bool

  public init(guide: TreeGuide = .none, gapAbove: CGFloat = 0, active: Bool = false) {
    self.guide = guide
    self.gapAbove = gapAbove
    self.active = active
  }

  /// Role wierszy w tej samej kolejności co `rows`. Projekt to nagłówek i agenci pod nim aż do następnego nagłówka;
  /// zwinięty projekt nie ma kreski w żadnym wierszu, oddech nad nagłówkiem od zwinięcia nie zależy. `activeCwd`
  /// (normalized, like `ProjectRowModel.cwd`) marks the header and the agents of the active project.
  public static func layout(_ rows: [ProjectTreeRow], activeCwd: String? = nil) -> [ProjectTreeRowLayout] {
    var layouts: [ProjectTreeRowLayout] = []
    var collapsed = false
    var active = false
    for index in rows.indices {
      let agentBelow = index + 1 < rows.count && !rows[index + 1].isHeader
      switch rows[index] {
      case let .header(header):
        collapsed = header.collapsed
        active = activeCwd != nil && header.row.cwd == activeCwd
        layouts.append(ProjectTreeRowLayout(
          guide: agentBelow && !collapsed ? .start : .none,
          gapAbove: index > 0 ? gapAbove(after: rows[index - 1]) : 0, active: active))
      case .emptyFilter:
        // The sentence belongs to no project: no guide, no breath.
        layouts.append(ProjectTreeRowLayout())
      case .session:
        layouts.append(ProjectTreeRowLayout(guide: collapsed ? .none : agentBelow ? .middle : .end, active: active))
      }
    }
    return layouts
  }

  /// Oddech nad nagłówkiem po wierszu `previous` (b): po agencie i po nagłówku z gałęzią (kończą się tak samo,
  /// `projectRowBottomPadding`) `projectGap`; po nagłówku bez linii gałęzi o `emptyHeaderBottomExtra` mniej (dziś 4),
  /// bo ten ma już tyle luzu pod nazwą. Linia gałęzi nie zależy od zwinięcia, a wiersz bezpośrednio nad nagłówkiem
  /// zmienia przy zwinięciu tylko rodzaj w obrębie tej samej pary (agent ↔ nagłówek z gałęzią) — wyjątek: zwinięty
  /// projekt z sesjami bez gita.
  static func gapAbove(after previous: ProjectTreeRow) -> CGFloat {
    if case let .header(header) = previous, !header.row.hasMeta {
      return max(0, SessionListMetrics.projectGap - SessionListMetrics.emptyHeaderBottomExtra)
    }
    return SessionListMetrics.projectGap
  }
}

/// Którym gestem człowiek zwinął albo rozwinął projekty drzewa — i czy zaznaczony wiersz ma przy tym stać (lista
/// zostaje w miejscu i tylko rozciąga się w dół, zamiast skakać).
public enum TreeToggleGesture: Sendable, Equatable {
  /// Jeden projekt: strzałka, stuknięcie w treść nagłówka, Return na nagłówku z fokusem, akcja czytnika. Nagłówek
  /// stoi, a wiersze rosną albo znikają pod nim — kotwica milczy, więc zaznaczony wiersz pod projektem jedzie razem
  /// z wierszami.
  case project
  /// „Zwiń wszystkie” albo „Rozwiń wszystkie” z menu nagłówka: zaznaczony wiersz stoi (kotwica).
  case allProjects

  public var holdsSelection: Bool { self == .allProjects }
}

extension AppState {
  /// Wiersze drzewa w kolejności rdzenia: nagłówki jak karta PROJEKTY, pod nimi widoczni agenci od najstarszego.
  /// `openCwd` i `jumpCwd` jak w `projectRows` („otwarty” i „cel Cmd+L” w etykiecie czytnika). `pinned`, `filter`
  /// and `held` as in `projectTree(collapsed:pinned:filter:held:)`; the list passes them through
  /// `RarogNavigation.treeRows`.
  public func projectTreeRows(
    collapsed: CollapsedProjects, pinned: PinnedProjects = PinnedProjects(), openCwd: String?, jumpCwd: String?,
    filter: ListFilter = .all, held: Set<String> = []
  ) -> [ProjectTreeRow] {
    let projects = Dictionary(
      projectRows(openCwd: openCwd, jumpCwd: jumpCwd).map { ($0.cwd, $0) },
      uniquingKeysWith: { first, _ in first })
    let ordinals = duplicateOrdinals
    return projectTree(collapsed: collapsed, pinned: pinned, filter: filter, held: held).compactMap { node in
      switch node.kind {
      case let .project(header):
        return projects[header.group.cwd].map {
          .header(ProjectTreeHeaderModel(
            row: $0, collapsed: header.collapsed, shown: header.shown, pinned: pinned.contains(header.group.cwd)))
        }
      case let .session(session):
        return .session(SessionRowModel(
          session, ordinal: ordinals[session.id], listStale: listStale, turnStage: turnStage[session.id],
          showsProject: false, freshResult: freshResult(session)))
      case let .emptyFilter(filter):
        return .emptyFilter(filter)
      }
    }
  }
}
