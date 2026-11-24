import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Drzewo projektów na prawdziwej liście: zaznaczony wiersz zostaje na miejscu, gdy nad nim
/// znikają albo pojawiają się wiersze („Zwiń wszystkie”, zwolnienie trzymanych, nowy projekt). Kotwica co do punktu
/// i jej pozostałe scenariusze: `TreeListAnchorTests`.
@MainActor
final class ProjectTreeListTests: XCTestCase {
  /// Sześć projektów po cztery odebrane (ciche) sesje nad zaznaczoną `p7-a` i pięć pod nią — lista dłuższa od ekranu
  /// także po zwinięciu tych nad. Sesje znają gałąź, więc nagłówki mają linię gałęzi jak w zwykłym repo.
  static let projects = (1...6).map { "p\($0)" }
  static let below = (8...12).map { "p\($0)" }

  /// Nad zaznaczoną `p7-a` znikają i wracają wiersze sześciu projektów (zostają nagłówki i agenci z rangą: czekający na
  /// zgodę, praca w tle) drogą stanu, bez animacji — jak zmiana ze stanu serwera. Zaznaczona stoi na 3/4 widocznej
  /// części (ustawiona przesunięciem, nie centrowaniem), lista nieprzejechana (wysokości spoza ekranu szacowane), dane
  /// o różnej wysokości wierszy (`TreeAnchorFixture`): ≤ 1 pt w każdej próbce (model po commicie i prezentacja co
  /// klatkę). Bez kotwicy (`TreeListAnchor.enabled = false`) ten sam przebieg przesuwa wiersz.
  func testSelectedRowStaysWhenRowsAboveVanishAndReturn() throws {
    try vanishAndReturn(byToggle: false)
  }

  /// To samo gestem „Zwiń wszystkie”/„Rozwiń wszystkie” (`ProjectTreeRows.toggle`, `.allProjects`), który dziś idzie
  /// z animacją: stan końcowy ≤ 1 pt.
  func testSelectedRowStaysWhenRowsAboveVanishAndReturnByToggle() throws {
    try vanishAndReturn(byToggle: true)
  }

  private func vanishAndReturn(byToggle: Bool) throws {
    let above = Self.projects
    let way = byToggle ? "gestem „wszystkie”" : "drogą stanu"
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.75)
      let spot = try XCTUnwrap(h.visibleFrame(item), "p7-a na ekranie")
      XCTAssertTrue(h.wholeOnScreen(item), "p7-a cała na ekranie: \(spot)")
      XCTAssertGreaterThan(abs(spot.midY - h.visibleHeight / 2), 50, "p7-a nie na środku: \(spot)")
      let rowsBefore = h.ids().count
      func change(_ collapse: Bool) {
        if byToggle {
          h.toggle(above, collapse: collapse, gesture: .allProjects)
        } else {
          h.setCollapsed(above, collapse)
        }
      }
      let suffix = enabled ? "" : " bez kotwicy"
      let collapsed = try h.measure("zwinięcie p1–p6 \(way)\(suffix)", session: "p7-a") { change(true) }
      XCTAssertLessThan(h.list.numberOfItems(inSection: 0), rowsBefore, "nad zaznaczoną zniknęły wiersze")
      if !enabled {
        XCTAssertGreaterThan(collapsed.worst, 1, "bez kotwicy wiersz odjeżdża — \(collapsed.summary)")
        print("KOTWICA|znikają i wracają \(way)|bez kotwicy zwinięcie \(collapsed.f(collapsed.worst))")
        continue
      }
      let expanded = try h.measure("rozwinięcie p1–p6 \(way)", session: "p7-a") { change(false) }
      XCTAssertEqual(h.list.numberOfItems(inSection: 0), rowsBefore, "wiersze wróciły")
      for run in [collapsed, expanded] {
        XCTAssertGreaterThan(run.commits.count, 0, run.name)
        XCTAssertGreaterThan(run.frames.count, 0, run.name)
        XCTAssertEqual(run.foreign, 0, "\(run.name): mierzona komórka to zaznaczona sesja")
        XCTAssertEqual(run.idleLayouts, 0, "\(run.name): bez pętli układu")
        XCTAssertEqual(run.idleOffsetChanges, 0, "\(run.name): bez pętli przesunięcia")
        XCTAssertLessThanOrEqual(abs(run.final), 1, "\(run.name): stan końcowy — \(run.summary)")
        // Drogą stanu każda próbka ma komórkę zaznaczonej i stoi ≤ 1 pt. Gestem „wszystkie” w trakcie animacji
        // zaznaczona odjeżdża (prywatna kotwica UIKit) i bywa chwilę poza ekranem — próbki bez komórki są wtedy
        // dopuszczone, liczy się stan końcowy.
        if !byToggle {
          XCTAssertEqual(run.missing, 0, "\(run.name): każda próbka ma komórkę zaznaczonej — \(run.summary)")
          XCTAssertLessThanOrEqual(run.worst, 1, "\(run.name): każda próbka — \(run.summary)")
        }
        print("KOTWICA|znikają i wracają \(way)|\(run.name)|w trakcie \(run.f(run.worst))|końcowe \(run.f(run.final))")
      }
    }
  }

  /// Wcięcia drzewa trafiają do komórek (postawione w gałęzi `switch` lista gubi je dla wierszy agentów): nagłówek
  /// od krawędzi komórki (cel strzałki), agent 45 pt — kropka od tuszu nazwy projektu. Nad nagłówkiem po agencie oddech
  /// 10 pt; komórki stykają się bez szczeliny, więc prowadnica (nakładka treści rozciągnięta na całą komórkę) jest
  /// jedną kreską.
  func testTreeRowInsetsReachCells() throws {
    let store = try Self.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    window.rootViewController = UIHostingController(rootView: NavigationSplitView {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: true)
    } detail: {
      Text("szczegół")
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    Self.spin()
    let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
    let list = try XCTUnwrap(
      Self.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count },
      "lista drzewa w oknie")
    // Most fokusu (`ListCellFocusBridge`) to tło treści wiersza: jego ramka w komórce to treść po wcięciach.
    func content(_ item: Int) throws -> CGRect {
      let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: item, section: 0)), "komórka \(item)")
      let bridge = try XCTUnwrap(Self.views(ListCellFocusView.self, in: cell).first, "most fokusu w komórce \(item)")
      return bridge.convert(bridge.bounds, to: cell)
    }
    func cellFrame(_ item: Int) throws -> CGRect {
      try XCTUnwrap(list.cellForItem(at: IndexPath(item: item, section: 0)), "komórka \(item)").frame
    }
    XCTAssertEqual(try content(0).minX, 0, accuracy: 0.5, "nagłówek od krawędzi komórki")
    XCTAssertEqual(try content(1).minX, ProjectTreeHeaderRow.chevronTarget + ProjectTreeRows.nameInkInset,
                   accuracy: 0.5, "kropka agenta od tuszu nazwy projektu")
    XCTAssertEqual(SessionListMetrics.rowSideInset + ProjectTreeRows.agentIndent, 45)

    // Pierwszy projekt (z gałęzią): nagłówek (0) i cztery ciche sesje (1–4), potem nagłówek następnego (5).
    let layout = ProjectTreeRowLayout.layout(rows)
    XCTAssertTrue(rows[0].isHeader && rows[5].isHeader && !rows[1].isHeader && !rows[2].isHeader, "układ danych")
    let gap = SessionListMetrics.projectGap
    XCTAssertEqual(layout[5], ProjectTreeRowLayout(guide: .start, gapAbove: gap))
    XCTAssertEqual(try content(0).minY, 0, accuracy: 0.5, "pierwszy nagłówek bez oddechu")
    XCTAssertEqual(try content(5).minY, gap, accuracy: 0.5, "oddech nad nagłówkiem po agencie")
    XCTAssertEqual(try cellFrame(5).height - cellFrame(0).height, gap, accuracy: 0.5,
                   "nagłówek z oddechem wyższy dokładnie o oddech")
    XCTAssertEqual(try content(1).minY, SessionListMetrics.rowVerticalInset, accuracy: 0.5, "agent pod nagłówkiem")
    XCTAssertEqual(try content(2).minY, SessionListMetrics.rowVerticalInset, accuracy: 0.5, "agent ↔ agent bez zmian")
    XCTAssertGreaterThanOrEqual(try cellFrame(2).height, 44, "agent w dwóch liniach ≥ 44 pt")
    let heights = try (0...5).map { try cellFrame($0).height }
    print("drzewo: wysokości komórek 0–5 \(heights)")
    for item in 0..<5 {
      XCTAssertEqual(try cellFrame(item).maxY, try cellFrame(item + 1).minY, accuracy: 0.01,
                     "komórki \(item) i \(item + 1) stykają się (prowadnica bez przerwy)")
    }
  }

  /// Prowadnica nagłówka pojawia się razem z rozwinięciem projektu, a nie po animacji (rysowana
  /// w tle komórki dochodzi 0,47 s później w tym teście i 0,7–4 s na nagraniu — kreska rwie się na kawałki).
  /// Rozwinięcie pod tą samą animacją co w apce, po 0,12 s zrzut okna: w kolumnie osi strzałki pod glifem są już
  /// piksele kreski (w trakcie zanikania — ciemniejsze od tła kolumny).
  func testHeaderGuideAppearsWithExpandAnimation() throws {
    let store = try Self.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: NavigationSplitView {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: true)
    } detail: {
      Text("szczegół")
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let cwd = "/Users/demo/p1"
    navigation.setProjectsCollapsed([cwd], collapsed: true)
    store.projectsToggled([cwd])
    Self.spin()
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 })
    func guidePixels() throws -> Int {
      let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 0, section: 0)), "komórka nagłówka p1")
      // The list alone, on the column's white: the window's layer render leaves the list transparent under the
      // footer's `safeAreaBar`, and a transparent pixel would count as the guide.
      let origin = list.bounds.origin
      let frame = cell.frame.offsetBy(dx: -origin.x, dy: -origin.y)
      let image = UIGraphicsImageRenderer(size: list.bounds.size).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: list.bounds.size))
        context.cgContext.translateBy(x: -origin.x, y: -origin.y)
        list.layer.render(in: context.cgContext)
      }
      let cg = try XCTUnwrap(image.cgImage)
      let data = try XCTUnwrap(cg.dataProvider?.data)
      let bytes = try XCTUnwrap(CFDataGetBytePtr(data))
      let scale = image.scale
      // Oś strzałki: 22 pt od krawędzi komórki (kreska 1 px tuż na lewo od osi); pas od 34 pt komórki do jej dołu.
      let x = Int(((frame.minX + ProjectTreeHeaderRow.chevronTarget / 2) * scale).rounded()) - 1
      var count = 0
      for y in Int((frame.minY + 34) * scale)..<Int(frame.maxY * scale) {
        let offset = y * cg.bytesPerRow + x * 4
        if bytes[offset + 1] < 238 { count += 1 }
      }
      return count
    }
    XCTAssertEqual(try guidePixels(), 0, "zwinięty projekt bez kreski")
    withAnimation(.snappy(duration: 0.22)) {
      navigation.setProjectsCollapsed([cwd], collapsed: false)
      store.projectsToggled([cwd])
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.12))
    let during = try guidePixels()
    Self.spin()
    let after = try guidePixels()
    print("prowadnica nagłówka: w trakcie animacji \(during) px, po \(after) px")
    XCTAssertGreaterThan(during, 10, "kreska nagłówka już w trakcie animacji rozwinięcia")
    XCTAssertGreaterThan(after, 10, "i po niej")
  }

  /// A swipe moves the whole cell: the list sets the cell's `layer.position` (measured on iOS 27). The
  /// guide stays in its column: right after the move the rendered list has the guide at the cell's resting place (the
  /// line in the cell hides, a stand-in in the collection view takes over), and once the cell is back and its
  /// presentation settled, the stand-in is gone and the line in the cell shows again.
  func testGuideStaysWhenCellIsSwipedAside() throws {
    let store = try Self.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: NavigationSplitView {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: true)
    } detail: {
      Text("szczegół")
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    Self.spin()
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 })
    // Item 1: the first agent of the first project, a guide over the whole cell height.
    let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 1, section: 0)), "agent cell")
    let guide = try XCTUnwrap(Self.views(TreeGuideLineView.self, in: cell).first, "guide in the agent cell")
    let place = cell.frame
    func guidePixels() throws -> Int {
      let origin = list.bounds.origin
      let frame = place.offsetBy(dx: -origin.x, dy: -origin.y)
      let image = UIGraphicsImageRenderer(size: list.bounds.size).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: list.bounds.size))
        context.cgContext.translateBy(x: -origin.x, y: -origin.y)
        list.layer.render(in: context.cgContext)
      }
      let cg = try XCTUnwrap(image.cgImage)
      let data = try XCTUnwrap(cg.dataProvider?.data)
      let bytes = try XCTUnwrap(CFDataGetBytePtr(data))
      let scale = image.scale
      let x = Int(((frame.minX + ProjectTreeHeaderRow.chevronTarget / 2) * scale).rounded()) - 1
      var count = 0
      for y in Int((frame.minY + 2) * scale)..<Int((frame.maxY - 2) * scale) {
        if bytes[y * cg.bytesPerRow + x * 4 + 1] < 238 { count += 1 }
      }
      return count
    }
    let atRest = try guidePixels()
    XCTAssertGreaterThan(atRest, 20, "guide in the agent cell at rest")
    XCTAssertNil(guide.standIn, "no stand-in at rest")
    // A cell moved along the list (layout) is not swiped: no stand-in.
    cell.layer.position.y += 1
    cell.layer.position.y -= 1
    XCTAssertNil(guide.standIn, "no stand-in for a move along the list")
    cell.layer.position.x += 10
    XCTAssertNil(guide.standIn, "no stand-in for a sideways move of a cell the list has not swiped")
    cell.layer.position.x -= 10
    // The list marks the cell swiped from the first move (`configurationState.isSwiped`); a test has no touch.
    guide.readSwiped = { _ in true }
    // The list's swipe actions view: a reusable view beside the cell, at the cell's resting frame (measured on
    // iOS 27). A leftover shift from an earlier swipe must not survive the next one.
    let actions = UICollectionReusableView(frame: place)
    list.insertSubview(actions, belowSubview: cell)
    actions.transform = CGAffineTransform(translationX: 5, y: 0)
    defer { actions.removeFromSuperview() }

    for shift in [-150, 80] as [CGFloat] {
      cell.layer.position.x += shift
      // Leading actions (the cell moved toward its trailing edge) stand next to the card, not at the column edge.
      let expected = shift > 0 ? ProjectTreeRows.agentPlateInset : 0
      XCTAssertEqual(actions.transform, CGAffineTransform(translationX: expected, y: 0), "actions view, \(shift) pt")
      XCTAssertEqual(actions.center, CGPoint(x: place.midX, y: place.midY), "actions view's place untouched")
      XCTAssertEqual(try guidePixels(), atRest, "guide in its column with the cell moved \(shift) pt")
      XCTAssertTrue(guide.line.isHidden, "line in the cell hidden while it is moved")
      let standIn = try XCTUnwrap(guide.standIn, "stand-in while the cell is moved")
      XCTAssertEqual(standIn.superview, list)
      XCTAssertEqual(standIn.frame, guide.convert(guide.line.frame, to: cell).offsetBy(dx: place.minX, dy: place.minY))
      cell.layer.position.x -= shift
      Self.spin()
      XCTAssertNil(guide.standIn, "stand-in gone once the cell is back (\(shift) pt)")
      XCTAssertEqual(actions.transform, .identity, "actions view back in place after the swipe (\(shift) pt)")
      XCTAssertFalse(guide.line.isHidden, "line in the cell back")
      XCTAssertEqual(try guidePixels(), atRest, "guide in its column after the move")
    }

    // One drag from the leading actions across the resting place to the trailing ones: the shift follows the side.
    cell.layer.position.x += 80
    XCTAssertEqual(actions.transform, CGAffineTransform(translationX: ProjectTreeRows.agentPlateInset, y: 0))
    cell.layer.position.x -= 230
    XCTAssertEqual(actions.transform, .identity, "trailing actions in the same drag")
    cell.layer.position.x += 150
    Self.spin()
    XCTAssertNil(guide.standIn, "stand-in gone after the crossing drag")

    // A new width while the row is swiped (rotation, resized window): the list resizes the row from its leading edge,
    // so the stand-in stays in the column and goes once the cell is back at its new place.
    cell.layer.position.x -= 150
    XCTAssertNotNil(guide.standIn, "stand-in before the width change")
    cell.frame.size.width -= 40
    XCTAssertEqual(try guidePixels(), atRest, "guide in its column after the width change")
    cell.layer.position.x += 150
    Self.spin()
    XCTAssertNil(guide.standIn, "stand-in gone once the narrower cell is back")
    XCTAssertFalse(guide.line.isHidden, "line in the cell back after the width change")
    guide.readSwiped = { _ in false }
    cell.frame.size.width += 40
    XCTAssertNil(guide.standIn, "no stand-in for a resize at rest")
    guide.readSwiped = { _ in true }

    // The cell leaves the window with a stand-in and its settle watch on: no view and no display link stay behind.
    cell.layer.position.x -= 150
    let leftBehind = try XCTUnwrap(guide.standIn, "stand-in while the cell is moved")
    cell.layer.position.x += 150
    XCTAssertTrue(guide.isWatchingSettle, "settle watch while the presentation catches up")
    cell.removeFromSuperview()
    XCTAssertNil(guide.standIn, "stand-in dropped when the cell leaves the window")
    XCTAssertNil(leftBehind.superview, "stand-in view removed from the list")
    XCTAssertFalse(guide.isWatchingSettle, "display link stopped")
  }

  /// Pinning on a live list, with no frame from the server: the collection follows the navigation's pins alone. Pinning
  /// the last project makes its header the first row: the collection gets the new rows and its first cell shows
  /// another header. Pinning and unpinning the first project keeps the order of the rows, and the header still
  /// redraws: the pin glyph appears and goes (the cell's pixels change and come back), and the header the list gets
  /// says "pinned" to the reader and stops saying it. SwiftUI builds no accessibility tree in this hostless test
  /// process, so the cell's identity and the reader's value are read from the rows the list shows
  /// (`RarogNavigation.treeRows`). With `RAROG_LIST_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR` for
  /// `xcodebuild`) the test also writes `list-tree-pinned.png`.
  func testPinRedrawsLiveListWithoutFrame() throws {
    let h = try TreeAnchorHarness(selected: nil)
    defer { h.close() }
    let first = TreeAnchorFixture.cwd("p1"), last = TreeAnchorFixture.cwd("p12")
    XCTAssertEqual(h.ids().first, .project(first), "p1 first in the alphabet")
    XCTAssertEqual(h.ids().last(where: { if case .project = $0 { true } else { false } }), .project(last))

    let before = try Self.image(of: h.list, item: 0)
    h.pin("p12", true)
    Self.spin()
    XCTAssertEqual(h.ids().first, .project(last), "the pinned project's header is the first row")
    XCTAssertEqual(h.list.numberOfItems(inSection: 0), h.ids().count, "the collection has the new rows")
    XCTAssertNotEqual(try Self.image(of: h.list, item: 0), before, "the first cell shows another header")
    try Self.snapshot(h.window, "list-tree-pinned")
    h.pin("p12", false)
    Self.spin()

    let order = h.ids()
    XCTAssertEqual(order.first, .project(first))
    let plain = try Self.image(of: h.list, item: 0)
    XCTAssertFalse(try XCTUnwrap(h.rows().header(first)).spokenValue.contains(UICopy.treePinnedValue))

    h.pin("p1", true)
    Self.spin()
    XCTAssertEqual(h.ids(), order, "pinning the first project keeps the order of the rows")
    XCTAssertEqual(h.list.numberOfItems(inSection: 0), order.count)
    let header = try XCTUnwrap(h.rows().header(first))
    XCTAssertTrue(header.pinned && header.spokenValue.contains(UICopy.treePinnedValue), header.spokenValue)
    XCTAssertNotEqual(try Self.image(of: h.list, item: 0), plain, "the pin glyph appears")

    h.pin("p1", false)
    Self.spin()
    XCTAssertEqual(h.ids(), order)
    XCTAssertFalse(try XCTUnwrap(h.rows().header(first)).spokenValue.contains(UICopy.treePinnedValue))
    XCTAssertEqual(try Self.image(of: h.list, item: 0), plain, "the pin glyph goes")
  }

  /// A session with an armed cron shows the quiet clock at the end of its row, and the row loses it when the cron
  /// goes: the first agent row's pixels change with the server's list and come back. With `RAROG_LIST_SNAPSHOT_DIR`
  /// the test also writes `list-row-scheduled.png`.
  func testScheduledClockFollowsSessionCrons() throws {
    let h = try TreeAnchorHarness(selected: nil)
    defer { h.close() }
    let base = TreeAnchorFixture()
    let row = try XCTUnwrap(h.index(.session("p1-a")), "p1-a row")
    let plain = try Self.image(of: h.list, item: row)

    var armed = base
    let index = try XCTUnwrap(armed.specs.firstIndex { $0.id == "p1-a" })
    armed.specs[index].extra =
      #","scheduledTasks":[{"id":"c1","cron":"*/5 * * * *","recurring":true,"prompt":"Check CI"}]"#
    try h.snapshot(armed)
    Self.spin()
    XCTAssertNotEqual(try Self.image(of: h.list, item: row), plain, "the clock appears")
    try Self.snapshot(h.window, "list-row-scheduled")

    try h.snapshot(base)
    Self.spin()
    XCTAssertEqual(try Self.image(of: h.list, item: row), plain, "the clock goes with the cron")
  }

  /// The cell `item` drawn from its layer tree (the test target has no app host, so a screen capture comes out empty).
  static func image(of list: UICollectionView, item: Int) throws -> Data {
    let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: item, section: 0)), "cell \(item)")
    let image = UIGraphicsImageRenderer(bounds: cell.bounds).image { cell.layer.render(in: $0.cgContext) }
    return try XCTUnwrap(image.pngData(), "cell \(item): PNG")
  }

  static func snapshot(_ window: UIWindow, _ name: String) throws {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_LIST_SNAPSHOT_DIR"], !dir.isEmpty else { return }
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { window.layer.render(in: $0.cgContext) }
    try XCTUnwrap(image.pngData(), "\(name): PNG").write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }

  /// Powód kotwicy (`TreeListAnchor`): goła lista SwiftUI w stylu `.sidebar` NIE trzyma zaznaczonego wiersza, gdy
  /// nad nim znikają wiersze — kolekcja zostawia przesunięcie treści i wiersz odjeżdża w górę. Gdy system zacznie
  /// kotwiczyć sam, ten test się przewróci i kotwicę w `SessionListView` można zdjąć.
  func testPlainSidebarListDoesNotHoldSelectedRow() throws {
    final class Rows: ObservableObject {
      @Published var ids = (0..<40).map { "r\($0)" }
    }
    struct Plain: View {
      @ObservedObject var rows: Rows
      @State var selection: String? = "r30"
      var body: some View {
        List(selection: $selection) {
          ForEach(rows.ids, id: \.self) { id in Text(id).frame(height: 40).tag(id) }
        }
        .listStyle(.sidebar)
      }
    }
    let rows = Rows()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 700))
    window.rootViewController = UIHostingController(rootView: Plain(rows: rows))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    Self.spin()
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first)
    list.scrollToItem(at: IndexPath(item: 30, section: 0), at: .centeredVertically, animated: false)
    Self.spin()
    let before = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 30, section: 0))).convert(.zero, to: window).y
    rows.ids.removeFirst(10)
    Self.spin()
    let after = try XCTUnwrap(list.cellForItem(at: IndexPath(item: 20, section: 0))).convert(.zero, to: window).y
    print("goła lista: wiersz r30 \(before) → \(after)")
    XCTAssertLessThan(after, before - 100, "bez kotwicy wiersz odjeżdża o wysokość zniknięcia (\(before) → \(after))")
  }

  // MARK: - Pomocnicze

  /// The store logged in with the projects' sessions; `transport` (default: a client of a closed local port) answers
  /// the routes.
  static func store(transport: UIKitTransport? = nil) throws -> RarogStore {
    let outbox = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let store =
      if let transport {
        RarogStore(transport: transport, rules: MutationRules(), outboxDirectory: outbox, clientBuild: 1)
      } else {
        RarogStore.live(
          config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
          outboxDirectory: outbox)
      }
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
    var sessions = (projects + below).flatMap { project in
      ["a", "b", "c", "d"].enumerated().map { index, suffix in summary("\(project)-\(suffix)", project, minute: index) }
    }
    sessions.append(summary("p7-a", "p7", minute: 0))
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(sessions.joined(separator: ","))]}"#)
    return store
  }

  static func summary(_ id: String, _ project: String, minute: Int) -> String {
    #"""
      {"id":"\#(id)","cwd":"/Users/demo/\#(project)","title":"\#(project)","label":"sesja \#(id)","branch":"main",
       "state":"waiting-input","seen":true,"stateSince":"2026-10-06T10:00:00.000Z",
       "createdAt":"2026-10-06T09:0\#(minute):00.000Z","lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
  }

  private static func frame(_ store: RarogStore, _ json: String) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: .global, cursor: nil))
  }

  static func spin() {
    for _ in 0..<6 { RunLoop.main.run(until: Date().addingTimeInterval(0.15)) }
  }

  static func views<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
    ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
  }
}
