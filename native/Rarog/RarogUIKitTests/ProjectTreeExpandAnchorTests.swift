import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Ręczne zwinięcie albo rozwinięcie jednego projektu zostawia jego nagłówek w miejscu, a wiersze rosną albo znikają
/// pod nim; lista nie skacze.
///
/// Scenariusz: prawdziwy `SessionListView` z drzewem (`ProjectTreeListTests.store()`: 12 projektów, p7 z jedną sesją
/// `p7-a`), okno 1024×768 w `NavigationSplitView`, `besideDetail`. Lista przejechana „palcem” przez całą treść (komórki
/// zmierzone, nie szacowane), nagłówek P w zadanym miejscu widocznej części, zaznaczona sesja cała na ekranie i NIE
/// na środku; gest drogą strzałki (`ProjectTreeRows.toggle`, `TreeToggleGesture.project`). Stuknięcie w treść
/// nagłówka idzie przez zaznaczenie listy, którego ten układ nie odpali (delegat kolekcji nie woła settera SwiftUI) —
/// tę drogę sprawdza `ProjectTreeExpandUITests`.
///
/// `scrollTo(id, anchor: UnitPoint(y: f))` in a `List` centres the row for every 0 < f < 1
/// (`testListScrollToUnitPointCentersRow`; iPad Pro 11-inch simulator, iOS 27.0), so an anchor built on it moves the
/// list in one jump with a session selected: selected under P, the header moves −310 pt; above P, +53.5 pt.
@MainActor
final class ProjectTreeExpandAnchorTests: XCTestCase {
  // MARK: - Zaznaczona sesja pod projektem (P = p6, p7-a dwa wiersze pod nagłówkiem p6 zwiniętego)

  func testExpandWithSelectedBelowKeepsHeader() throws {
    let run = try toggle("p6", collapse: false, selected: "p7-a", headerAt: 0.05)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  func testCollapseWithSelectedBelowKeepsHeader() throws {
    let run = try toggle("p6", collapse: true, selected: "p7-a", headerAt: 0.1)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  // MARK: - Zaznaczona sesja nad projektem (P = p8, p7-a tuż nad nagłówkiem)

  func testExpandWithSelectedAboveKeepsHeader() throws {
    let run = try toggle("p8", collapse: false, selected: "p7-a", headerAt: 0.75)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  func testCollapseWithSelectedAboveKeepsHeader() throws {
    let run = try toggle("p8", collapse: true, selected: "p7-a", headerAt: 0.75)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  // MARK: - Bez zaznaczenia

  func testExpandWithoutSelectionKeepsHeader() throws {
    let run = try toggle("p8", collapse: false, selected: nil, headerAt: 0.5)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  func testCollapseWithoutSelectionKeepsHeader() throws {
    let run = try toggle("p8", collapse: true, selected: nil, headerAt: 0.5)
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  // MARK: - „Rozwiń wszystkie” zostaje przy kotwicy

  /// Gest „wszystkie” (`TreeToggleGesture.allProjects`) idzie tą samą funkcją i dalej trzyma zaznaczony wiersz:
  /// zaznaczona sesja na środku, nad nią rozwija się p6 — bez kotwicy wiersz zjechałby o cztery wiersze w dół.
  func testAllProjectsGestureStillHoldsSelectedRow() throws {
    let run = try toggle(
      "p6", collapse: false, selected: "p7-a", headerAt: nil, selectedAt: 0.5, gesture: .allProjects)
    let before = try XCTUnwrap(run.selectedBefore, run.summary)
    let after = try XCTUnwrap(run.selectedAfter, "zaznaczona na ekranie po zmianie — \(run.summary)")
    XCTAssertEqual(after, before, accuracy: 1, run.summary)
  }

  // MARK: - Under a filter segment

  /// The collapse gesture announces the rows the list shows under the filter. Working is active: every project's
  /// first agent works, p6-c worked when the segment was chosen and then finished (a held row), and p7-a, quiet,
  /// is selected under the next header. Collapsing p6 hides only the held p6-c; the header stays.
  /// Announcing the unfiltered rows would wake the anchor, which would hold p7-a and move the header.
  func testCollapseUnderFilterKeepsHeader() throws {
    let run = try toggle("p6", collapse: true, selected: "p7-a", headerAt: 0.4) { store, navigation in
      for project in ProjectTreeListTests.projects + ProjectTreeListTests.below {
        try ListFilterBarTests.change(store, "\(project)-a", project, state: "running")
      }
      try ListFilterBarTests.change(store, "p6-c", "p6", minute: 2, state: "running")
      navigation.selectListFilter(.working, state: store.state)
      // Read, so the finished turn is quiet.
      try ListFilterBarTests.change(store, "p6-c", "p6", minute: 2, state: "waiting-input")
      XCTAssertTrue(navigation.listFilterHeld.contains("p6-c"), "p6-c held after it left Working")
    }
    XCTAssertEqual(run.headerAfter, run.headerBefore, accuracy: 1, run.summary)
  }

  // MARK: - Mechanizm kotwicy

  /// Powód, dla którego kotwica (`TreeListAnchor`) nie wraca do `scrollTo`:
  /// `ScrollViewProxy.scrollTo(id, anchor: UnitPoint(y: f))` w gołej liście `.sidebar` stawia wiersz u góry dla
  /// f = 0, u dołu dla f = 1, a dla 0 < f < 1 na środku widocznej części — nie f · (widoczne − wysokość) od góry.
  /// Dawna kotwica zakładała ułamek i przez to centrowała zaznaczoną. Gdy system zacznie stawiać
  /// wiersz w ułamku, ten test się przewróci.
  func testListScrollToUnitPointCentersRow() throws {
    final class Holder {
      var proxy: ScrollViewProxy?
    }
    struct Plain: View {
      let holder: Holder
      var body: some View {
        ScrollViewReader { proxy in
          List {
            ForEach(0..<60, id: \.self) { index in Text("r\(index)").frame(height: 40) }
          }
          .listStyle(.sidebar)
          .onAppear { holder.proxy = proxy }
        }
      }
    }
    let holder = Holder()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 700))
    window.rootViewController = UIHostingController(rootView: Plain(holder: holder))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    let list = try XCTUnwrap(ProjectTreeListTests.views(UICollectionView.self, in: window).first)
    let proxy = try XCTUnwrap(holder.proxy, "ScrollViewProxy")
    warmUp(list)
    for (fraction, expected) in [(0.0, 0.0), (0.2, 0.5), (0.8, 0.5), (1.0, 1.0)] {
      list.scrollToItem(at: IndexPath(item: 5, section: 0), at: .top, animated: false)
      ProjectTreeListTests.spin()
      proxy.scrollTo(30, anchor: UnitPoint(x: 0.5, y: fraction))
      ProjectTreeListTests.spin()
      let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 30, section: 0)), "r30 na ekranie (f \(fraction))")
      let room = Self.visibleHeight(list) - cell.bounds.height
      let top = cell.frame.minY - Self.visibleTop(list)
      XCTAssertEqual(
        top, CGFloat(expected) * room, accuracy: 1, "f \(fraction): wiersz \(top) pt od góry, miejsce \(room)")
    }
  }

  // MARK: - Przebieg

  struct Run {
    var headerBefore: CGFloat
    var headerAfter: CGFloat
    /// Górna krawędź zaznaczonego wiersza w oknie; `nil` — bez zaznaczenia albo poza ekranem.
    var selectedBefore: CGFloat?
    var selectedAfter: CGFloat?
    var summary: String
  }

  /// Zwinięcie (`collapse`) albo rozwinięcie P tą samą funkcją co strzałka. Nagłówek P stawia `headerAt` (ułamek
  /// widocznej części: 0 góra, 1 dół), a bez niego zaznaczoną sesję `selectedAt`. Warunek scenariusza: zaznaczona
  /// sesja cała na ekranie i — przy `headerAt` — co najmniej 30 pt od środka, bo tylko wtedy dawna kotwica by
  /// przewinęła.
  func toggle(
    _ project: String, collapse: Bool, selected: String?, headerAt: CGFloat?, selectedAt: CGFloat? = nil,
    gesture: TreeToggleGesture = .project, prepare: ((RarogStore, RarogNavigation) throws -> Void)? = nil
  ) throws -> Run {
    let store = try ProjectTreeListTests.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let anchor = TreeListAnchor()
    if let selected {
      navigation.detail = .session(selected)
      store.selectListRow(selected)
    }
    try prepare?(store, navigation)
    let cwd = "/Users/demo/\(project)"
    if !collapse {
      navigation.setProjectsCollapsed([cwd], collapsed: true)
      store.projectsToggled([cwd])
    }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    window.rootViewController = UIHostingController(rootView: NavigationSplitView {
      SessionListView(
        store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: true, treeAnchor: anchor)
    } detail: {
      Text("szczegół")
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    ProjectTreeListTests.spin()
    // The list's rows, under the navigation's filter segment like the list itself.
    let rows = { navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil) }
    let list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows().count
      }, "lista drzewa w oknie (\(rows().count) wierszy)")
    warmUp(list)
    let header = try XCTUnwrap(rows().firstIndex { $0.id == .project(cwd) }, "nagłówek \(project) w drzewie")
    let selectedItem = selected.flatMap { id in rows().firstIndex { $0.id == .session(id) } }
    if let headerAt {
      try place(list, item: header, at: headerAt)
    } else {
      try place(list, item: try XCTUnwrap(selectedItem, "zaznaczona w drzewie"), at: try XCTUnwrap(selectedAt))
    }
    if let selectedItem {
      let spot = try XCTUnwrap(Self.visibleFrame(list, item: selectedItem), "zaznaczona cała na ekranie")
      XCTAssertTrue(spot.minY >= 0 && spot.maxY <= Self.visibleHeight(list), "zaznaczona cała na ekranie: \(spot)")
      if headerAt != nil {
        XCTAssertGreaterThan(abs(spot.midY - Self.visibleHeight(list) / 2), 30, "zaznaczona nie na środku: \(spot)")
      }
    }
    let rowsBefore = list.numberOfItems(inSection: 0)
    let headerBefore = try XCTUnwrap(edge(list, item: header, in: window), "nagłówek \(project) na ekranie")
    let selectedBefore = edge(list, item: selectedItem, in: window)

    ProjectTreeRows.toggle(
      [cwd], collapse: collapse, gesture: gesture, navigation: navigation, store: store, anchor: anchor,
      reduceMotion: false)
    ProjectTreeListTests.spin()

    let rowsAfter = list.numberOfItems(inSection: 0)
    XCTAssertNotEqual(rowsAfter, rowsBefore, "gest zmienił wiersze drzewa")
    let headerAfter = edge(list, item: rows().firstIndex { $0.id == .project(cwd) }, in: window) ?? .nan
    let selectedAfter = edge(
      list, item: selected.flatMap { id in rows().firstIndex { $0.id == .session(id) } }, in: window)
    let summary = "\(collapse ? "zwinięcie" : "rozwinięcie") \(project) (\(gesture), "
      + "zaznaczona \(selected ?? "brak")): "
      + "wiersze \(rowsBefore) → \(rowsAfter) | nagłówek \(f(headerBefore)) → \(f(headerAfter)) "
      + "Δ \(f(headerAfter - headerBefore)) | zaznaczona \(f(selectedBefore)) → \(f(selectedAfter))"
    print("drzewo: \(summary)")
    return Run(
      headerBefore: headerBefore, headerAfter: headerAfter, selectedBefore: selectedBefore,
      selectedAfter: selectedAfter, summary: summary)
  }

  /// Przejazd „palcem” przez całą treść: każda komórka raz na ekranie, więc wysokości są zmierzone, nie szacowane.
  func warmUp(_ list: UICollectionView) {
    list.layoutIfNeeded()
    var y = -list.adjustedContentInset.top
    while y < Self.maxOffset(list) {
      list.contentOffset.y = y
      list.layoutIfNeeded()
      y += 120
    }
    list.contentOffset.y = -list.adjustedContentInset.top
    list.layoutIfNeeded()
    ProjectTreeListTests.spin()
  }

  /// Komórka `item` w ułamku `fraction` widocznej części (0 — górna krawędź u góry, 1 — dolna u dołu).
  func place(_ list: UICollectionView, item: Int, at fraction: CGFloat) throws {
    let frame = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.frame)
    let offset = frame.minY - list.adjustedContentInset.top - fraction * (Self.visibleHeight(list) - frame.height)
    list.contentOffset.y = min(max(offset, -list.adjustedContentInset.top), Self.maxOffset(list))
    list.layoutIfNeeded()
    ProjectTreeListTests.spin()
  }

  /// Górna krawędź komórki w oknie; `nil` — komórki nie ma na ekranie.
  func edge(_ list: UICollectionView, item: Int?, in window: UIWindow) -> CGFloat? {
    guard let item, let cell = list.cellForItem(at: IndexPath(item: item, section: 0)) else { return nil }
    return cell.convert(cell.bounds, to: window).minY
  }

  /// Ramka komórki względem widocznej części listy (pod paskiem, nad stopką); `nil` — komórki nie ma na ekranie.
  static func visibleFrame(_ list: UICollectionView, item: Int) -> CGRect? {
    guard let cell = list.cellForItem(at: IndexPath(item: item, section: 0)) else { return nil }
    return cell.frame.offsetBy(dx: 0, dy: -visibleTop(list))
  }

  static func visibleTop(_ list: UICollectionView) -> CGFloat {
    list.contentOffset.y + list.adjustedContentInset.top
  }

  static func visibleHeight(_ list: UICollectionView) -> CGFloat {
    list.bounds.height - list.adjustedContentInset.top - list.adjustedContentInset.bottom
  }

  static func maxOffset(_ list: UICollectionView) -> CGFloat {
    max(-list.adjustedContentInset.top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
  }

  func f(_ value: CGFloat?) -> String {
    guard let value, value.isFinite else { return "-" }
    return String(format: "%.1f", Double(value))
  }
}
