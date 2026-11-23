import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Fokus klawiatury na liście sesji. SwiftUI daje komórkom listy `.sidebar` systemowe halo fokusu w odcieniu akcentu;
/// wiersz listy ma je zdjęte, a fokus wskazuje sam: tłem zaznaczenia albo achromatycznym pierścieniem.
@MainActor
final class SessionListFocusTests: XCTestCase {
  private struct Rows: View {
    @Binding var selection: String?

    var body: some View {
      NavigationSplitView {
        List(selection: $selection) {
          ForEach(["a", "b", "c"], id: \.self) { id in
            Text(id).tag(id).modifier(PlainListRow(highlighted: id == selection))
          }
        }
        .listStyle(.sidebar)
      } detail: {
        Text("szczegół")
      }
    }
  }

  /// Bez systemowego halo na każdej komórce — także po zmianie zaznaczenia (komórki konfigurują się od nowa).
  /// Bez mostka komórka ma `UIFocusHaloEffect` (zmierzone na iOS 27; `.focusEffectDisabled()` go nie zdejmuje).
  func testListCellsHaveNoSystemFocusHalo() throws {
    var selection: String? = "b"
    let binding = Binding(get: { selection }, set: { selection = $0 })
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    let host = UIHostingController(rootView: Rows(selection: binding))
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    Self.spin()
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first, "lista w oknie")
    XCTAssertTrue(list.allowsFocus, "lista dalej przyjmuje fokus klawiatury (pierścień, Return otwiera)")
    // Zaznaczenie nie idzie za fokusem: po Cmd+L aktualizacja fokusu na starym wierszu otworzyłaby starą sesję
    // z powrotem.
    XCTAssertFalse(list.selectionFollowsFocus, "zaznaczenie nie idzie za fokusem klawiatury")
    XCTAssertEqual(list.visibleCells.count, 3)
    for cell in list.visibleCells {
      XCTAssertNil(cell.focusEffect, "komórka bez systemowego halo: \(cell)")
    }
    // Wskaźnik: bez systemowego efektu kolekcji, gest wskaźnika w każdej komórce.
    XCTAssertFalse(list.interactions.contains { ($0 as? UIPointerInteraction)?.isEnabled == true },
                   "lista bez systemowego efektu wskaźnika — tło pod kursorem rysuje wiersz")
    let bridges = Self.views(ListCellFocusView.self, in: list)
    XCTAssertEqual(bridges.count, 3)
    for bridge in bridges {
      let recognizer = try XCTUnwrap(bridge.hoverRecognizer, "gest wskaźnika")
      XCTAssertTrue(recognizer.view === bridge.cell, "gest w komórce (cała plama), nie w treści wiersza")
    }

    selection = "c"
    host.rootView = Rows(selection: binding)
    Self.spin()
    for cell in list.visibleCells {
      XCTAssertNil(cell.focusEffect, "po zmianie zaznaczenia dalej bez halo: \(cell)")
    }
    XCTAssertFalse(list.selectionFollowsFocus, "po zmianie zaznaczenia dalej bez zaznaczenia za fokusem")

    // SwiftUI może przywrócić właściwość przy przebudowie listy: most zdejmuje ją przy każdym układzie.
    list.selectionFollowsFocus = true
    list.visibleCells.first?.setNeedsLayout()
    for view in Self.views(ListCellFocusView.self, in: list) { view.setNeedsLayout() }
    Self.spin()
    XCTAssertFalse(list.selectionFollowsFocus, "przywrócone przez system — zdjęte przy następnym układzie")
  }

  /// Wskaźnik nad komórką dochodzi do wiersza, a wiersz odpięty z komórki (komórka z puli pod innym wierszem)
  /// zdejmuje z niej swój gest i gaśnie. Symulator nie daje wskaźnika: stan podawany wprost (`reportHover`).
  /// Drzewo projektów: nagłówek projektu ma ten sam most co wiersz agenta — bez systemowego halo, z gestem
  /// wskaźnika w swojej komórce i bez zaznaczenia za fokusem; prawdziwy `SessionListView` z drzewem.
  func testTreeHeaderCellsShareFocusBridge() throws {
    let store = try ProjectTreeListTests.store()
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
    XCTAssertFalse(list.selectionFollowsFocus, "zaznaczenie nie idzie za fokusem")
    let header = try XCTUnwrap(rows.firstIndex { if case .header = $0 { true } else { false } }, "nagłówek w drzewie")
    let cell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: header, section: 0)), "komórka nagłówka")
    XCTAssertNil(cell.focusEffect, "nagłówek bez systemowego halo")
    let bridge = try XCTUnwrap(Self.views(ListCellFocusView.self, in: cell).first, "most fokusu w nagłówku")
    XCTAssertTrue(bridge.hoverRecognizer?.view === cell, "gest wskaźnika w komórce nagłówka (plama na całą komórkę)")
  }

  /// Stacked list (iPhone): the finger state of an agent row is the UIKit cell's highlight, which the collection sets
  /// after its touch delay and clears when a scroll starts. If SwiftUI's cell stopped reporting `isHighlighted`
  /// through key-value observation, or the collection refused to highlight agent rows, a tap would light nothing.
  /// Headers and the list beside the detail observe nothing (the iPad stays as it is).
  func testStackedAgentRowReportsFingerFromCellHighlight() throws {
    for besideDetail in [false, true] {
      let store = try ProjectTreeListTests.store()
      let navigation = RarogNavigation(prefs: MemoryPreferences())
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
      window.overrideUserInterfaceStyle = .light
      window.rootViewController = UIHostingController(rootView: NavigationStack {
        SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: besideDetail)
      })
      window.makeKeyAndVisible()
      defer { window.isHidden = true }
      Self.spin()
      let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
      let list = try XCTUnwrap(
        Self.views(UICollectionView.self, in: window).first {
          $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
        }, "tree list in the window")
      let agent = try XCTUnwrap(rows.firstIndex { $0.sessionId != nil }, "agent row")
      let header = try XCTUnwrap(rows.firstIndex(where: \.isHeader), "header row")
      let agentPath = IndexPath(item: agent, section: 0)
      let cell = try XCTUnwrap(list.cellForItem(at: agentPath), "agent cell")
      let bridge = try XCTUnwrap(Self.views(ListCellFocusView.self, in: cell).first, "bridge in the agent cell")
      let headerCell = try XCTUnwrap(list.cellForItem(at: IndexPath(item: header, section: 0)), "header cell")
      let headerBridge = try XCTUnwrap(Self.views(ListCellFocusView.self, in: headerCell).first, "bridge in the header")
      XCTAssertNil(headerBridge.pressedCell, "a header observes no finger")
      guard !besideDetail else {
        XCTAssertNil(bridge.pressedCell, "beside the detail the agent row observes no finger")
        continue
      }
      XCTAssertTrue(bridge.pressedCell === cell, "the agent row observes its own cell")
      XCTAssertNotEqual(
        list.delegate?.collectionView?(list, shouldHighlightItemAt: agentPath), false,
        "the collection highlights agent rows under a finger")
      cell.isHighlighted = true
      Self.spin()
      XCTAssertTrue(bridge.reportedPress, "finger down: the row is told")
      cell.isHighlighted = false
      Self.spin()
      XCTAssertFalse(bridge.reportedPress, "finger up or scroll: the row goes out")
    }
  }

  /// Stacked list in the light theme, drawn: back from a session, its row carries the white plate on the
  /// `background` column and another agent row does not; a finger on that other row lights the same plate.
  /// The plate reaches the cell's trailing edge, past the row's content, so the probe reads it there.
  func testStackedListDrawsLastOpenedAndFingerPlate() throws {
    let store = try ProjectTreeListTests.store()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let rows = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
    let agents = rows.enumerated().compactMap { index, row in row.sessionId.map { (index, $0) } }
    XCTAssertGreaterThan(agents.count, 1, "two agent rows")
    let (visitedIndex, visitedId) = agents[0]
    let otherIndex = agents[1].0
    navigation.detail = .session(visitedId)
    navigation.noteSessionVisit(store.state)
    navigation.detail = nil
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: NavigationStack {
      SessionListView(store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    Self.spin()
    let list = try XCTUnwrap(
      Self.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == rows.count
      }, "tree list in the window")
    let visited = try XCTUnwrap(list.cellForItem(at: IndexPath(item: visitedIndex, section: 0)), "visited cell")
    let other = try XCTUnwrap(list.cellForItem(at: IndexPath(item: otherIndex, section: 0)), "other cell")
    let traits = UITraitCollection(userInterfaceStyle: .light)
    let plate = Self.rgb(Palette.stackedPlate.resolvedColor(with: traits))
    let column = Self.rgb(Palette.background.resolvedColor(with: traits))
    XCTAssertNotEqual(plate.b, column.b, "plate and column differ in light")

    let rest = try Self.snapshot(window)
    XCTAssertEqual(try Self.probe(rest, cell: visited, in: window).b, plate.b, accuracy: 2, "last opened row: the plate")
    XCTAssertEqual(try Self.probe(rest, cell: other, in: window).b, column.b, accuracy: 2, "another row: the column")
    let shot = XCTAttachment(image: UIImage(cgImage: rest))
    shot.name = "stacked-list-last-opened-light"
    shot.lifetime = .keepAlways
    add(shot)

    other.isHighlighted = true
    Self.spin()
    let pressed = try Self.snapshot(window)
    XCTAssertEqual(try Self.probe(pressed, cell: other, in: window).b, plate.b, accuracy: 2, "finger down: the plate")
    other.isHighlighted = false
    Self.spin()
    let released = try Self.snapshot(window)
    XCTAssertEqual(try Self.probe(released, cell: other, in: window).b, column.b, accuracy: 2, "finger up: the column")
  }

  private static func snapshot(_ window: UIWindow) throws -> CGImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    // `drawHierarchy` gives a blank frame without a foreground app; the layer tree renders.
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
      window.layer.render(in: context.cgContext)
    }
    return try XCTUnwrap(image.cgImage, "window snapshot")
  }

  /// Pixel 3 pt inside the cell's trailing edge, at its vertical middle (window points at scale 1).
  private static func probe(_ image: CGImage, cell: UICollectionViewCell, in window: UIWindow) throws -> (r: Int, g: Int, b: Int) {
    let frame = cell.convert(cell.bounds, to: window)
    let pixel = try XCTUnwrap(Self.pixel(image, x: Int(frame.maxX) - 3, y: Int(frame.midY)), "pixel")
    return (Int(pixel.r), Int(pixel.g), Int(pixel.b))
  }

  private static func rgb(_ color: UIColor) -> (r: Int, g: Int, b: Int) {
    var (r, g, b): (CGFloat, CGFloat, CGFloat) = (0, 0, 0)
    color.getRed(&r, green: &g, blue: &b, alpha: nil)
    return (Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
  }

  /// The finger callback goes away mid-press (a long press opens Rename and the row becomes a field; the window
  /// width flips the column) and comes back after the finger is up. The row must end up not pressed: a skipped
  /// "unchanged" report left the plate lit with no finger until the next press.
  func testPressCallbackRestoredAfterReleaseDeliversNotPressed() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let cell = UICollectionViewCell(frame: CGRect(x: 0, y: 0, width: 300, height: 50))
    window.addSubview(cell)
    let view = ListCellFocusView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    var reports: [Bool] = []
    view.onPressChange = { reports.append($0) }
    cell.contentView.addSubview(view)
    Self.spin()
    XCTAssertTrue(view.pressedCell === cell, "the cell is observed")

    cell.isHighlighted = true
    Self.spin()
    XCTAssertEqual(reports.last, true, "finger down reaches the row")

    view.onPressChange = nil
    view.attachPress()
    cell.isHighlighted = false
    Self.spin()
    XCTAssertNil(view.pressedCell, "without a callback the cell is not observed")

    view.onPressChange = { reports.append($0) }
    view.attachPress()
    Self.spin()
    XCTAssertEqual(reports.last, false, "the restored callback hears that no finger is down")
  }

  func testHoverFollowsCellAndDetach() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let cell = UICollectionViewCell(frame: CGRect(x: 0, y: 0, width: 300, height: 50))
    window.addSubview(cell)
    let view = ListCellFocusView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    var reports: [Bool] = []
    view.onHoverChange = { reports.append($0) }
    cell.contentView.addSubview(view)
    Self.spin()
    let recognizer = try XCTUnwrap(view.hoverRecognizer)
    XCTAssertTrue(recognizer.view === cell, "gest w komórce")
    XCTAssertEqual(cell.gestureRecognizers?.filter { $0 is UIHoverGestureRecognizer }.count, 1)

    view.reportHover(true)
    Self.spin()
    XCTAssertEqual(reports, [true], "kursor nad komórką")
    view.syncHover(redeliver: true)
    Self.spin()
    XCTAssertEqual(reports, [true, true], "nowe wywołanie zna stan wskaźnika")

    view.removeFromSuperview()
    Self.spin()
    XCTAssertEqual(reports.last, false, "odpięty wiersz gaśnie")
    XCTAssertNil(view.hoverRecognizer)
    XCTAssertEqual(cell.gestureRecognizers?.filter { $0 is UIHoverGestureRecognizer }.count ?? 0, 0, "gest zdjęty")
  }

  /// Tło wiersza pod wskaźnikiem: plama zaznaczenia w połowie krycia; zaznaczenie pełne (`HoverTokens.agentRow`).
  func testHoveredRowIsHalfOfSelection() throws {
    let traits = UITraitCollection(userInterfaceStyle: .dark)
    var (r, g, b): (CGFloat, CGFloat, CGFloat) = (0, 0, 0)
    Palette.surface2.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: nil)
    for (hovered, highlighted, alpha) in [(true, false, 128), (false, true, 255), (true, true, 255), (false, false, 0)] {
      let renderer = ImageRenderer(
        content: ListRowBackground(highlighted: highlighted, hovered: hovered, focusRing: false)
          .frame(width: 200, height: 60)
          .environment(\.colorScheme, .dark))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage?.cgImage)
      let center = try XCTUnwrap(Self.pixel(image, x: 200, y: 60))
      XCTAssertEqual(Double(center.a), Double(alpha), accuracy: 3, "wskaźnik \(hovered), zaznaczenie \(highlighted)")
      if alpha == 255 {
        XCTAssertEqual(Double(center.g), Double(g * 255), accuracy: 3, "zaznaczenie w `surface2`")
      }
    }
  }

  /// Plama wiersza zostawia po 1 pt u góry i u dołu: plamy sąsiednich wierszy (zaznaczony i pod wskaźnikiem) dzielą
  /// 2 pt przerwy zamiast się stykać.
  func testRowPlateLeavesGapAtTopAndBottom() throws {
    let renderer = ImageRenderer(
      content: ListRowBackground(highlighted: true, focusRing: false)
        .frame(width: 200, height: 60)
        .environment(\.colorScheme, .dark))
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.uiImage?.cgImage)
    XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: 200, y: 0)).a, 0, "górny pas 1 pt pusty")
    XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: 200, y: 119)).a, 0, "dolny pas 1 pt pusty")
    XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: 200, y: 3)).a, 255, "plama zaczyna się po 1 pt")
    XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: 200, y: 116)).a, 255, "i kończy 1 pt przed dołem")
  }

  /// Wiersz agenta w drzewie: plama zaznaczenia, plama wskaźnika i pierścień fokusu
  /// zaczynają się za prowadnicą — pas z lewej (z kreską w osi 22 pt) zostaje pusty.
  func testAgentPlateStartsAfterGuide() throws {
    let inset = ProjectTreeRows.agentPlateInset
    XCTAssertEqual(inset, 33)
    XCTAssertGreaterThanOrEqual(inset - ProjectTreeHeaderRow.chevronTarget / 2, 10, "czyste tło między kreską a plamą")
    for (highlighted, hovered, ring) in [(true, false, false), (false, true, false), (false, false, true)] {
      let renderer = ImageRenderer(
        content: ListRowBackground(highlighted: highlighted, hovered: hovered, focusRing: ring, leadingInset: inset)
          .frame(width: 200, height: 60)
          .environment(\.colorScheme, .dark))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage?.cgImage)
      let state = highlighted ? "zaznaczenie" : hovered ? "wskaźnik" : "fokus"
      for x in [0, 44, 64] {
        XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: x, y: 60)).a, 0,
                       "\(state): pas przed plamą pusty (x = \(x) px)")
      }
      let edge = ring ? Int(inset * 2) + 1 : Int(inset * 2) + 24
      XCTAssertGreaterThan(try XCTUnwrap(Self.pixel(image, x: edge, y: 60)).a, 0, "\(state): plama od \(inset) pt")
    }
  }

  /// Plama nagłówka (wskaźnik, fokus) stoi 8 pt od lewej krawędzi kolumny, choć komórka zaczyna się od 4 pt: pas
  /// 0–4 pt komórki pusty.
  func testHeaderPlateStartsAtPlateEdge() throws {
    let inset = SessionListMetrics.rowPlateInset
    XCTAssertEqual(inset, 4)
    XCTAssertEqual(SessionListMetrics.listLeadingMargin + inset, SessionListMetrics.plateEdge)
    XCTAssertEqual(SessionListMetrics.plateEdge, 8)
    for (hovered, ring) in [(true, false), (false, true)] {
      let renderer = ImageRenderer(
        content: ListRowBackground(highlighted: false, hovered: hovered, focusRing: ring, leadingInset: inset)
          .frame(width: 200, height: 60)
          .environment(\.colorScheme, .dark))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage?.cgImage)
      let state = hovered ? "wskaźnik" : "fokus"
      for x in [0, 4, 7] {
        XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: x, y: 60)).a, 0, "\(state): pas 0–4 pt pusty (x = \(x) px)")
      }
      let edge = ring ? Int(inset * 2) + 1 : Int(inset * 2) + 24
      XCTAssertGreaterThan(try XCTUnwrap(Self.pixel(image, x: edge, y: 60)).a, 0, "\(state): plama od \(inset) pt")
    }
  }

  /// Strzałka zwijania bez własnego hovera (cały nagłówek zwija i rozwija, pod wskaźnikiem świeci plama
  /// nagłówka): cel 44 pt bez tła, glif cichy (`treeChevron`), nie w atramencie tekstu.
  func testTreeChevronLook() throws {
    let renderer = ImageRenderer(content: TreeChevron(collapsed: false).environment(\.colorScheme, .dark))
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.uiImage?.cgImage)
    XCTAssertEqual(image.width, 88, "cel 44 pt")
    // Dawny kwadrat 28 pt stał na 8…36 pt; 10 pt od lewej to jego obszar, ale nie glif.
    XCTAssertEqual(try XCTUnwrap(Self.pixel(image, x: 20, y: 44)).a, 0, "bez tła")
    var brightest = 0
    for y in 30...58 {
      for x in 30...58 { brightest = max(brightest, Int(try XCTUnwrap(Self.pixel(image, x: x, y: y)).r)) }
    }
    XCTAssertGreaterThan(brightest, 0, "glif jest")
    XCTAssertLessThan(brightest, 170, "glif cichy")
  }

  /// Pierścień fokusu w atramencie tekstu (achromatyczny, nigdy akcent) w obu motywach, wnętrze puste.
  func testFocusRingIsAchromaticInk() throws {
    for scheme in [ColorScheme.dark, .light] {
      let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
      let ink = Palette.text.resolvedColor(with: traits)
      let renderer = ImageRenderer(
        content: ListRowBackground(highlighted: false, focusRing: true)
          .frame(width: 200, height: 60)
          .environment(\.colorScheme, scheme))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage?.cgImage, "render tła wiersza")
      let edge = try XCTUnwrap(Self.pixel(image, x: 2, y: 60), "lewa krawędź w połowie wysokości")
      let inside = try XCTUnwrap(Self.pixel(image, x: 200, y: 60), "środek")
      var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
      ink.getRed(&r, green: &g, blue: &b, alpha: &a)
      XCTAssertEqual(edge.a, 255, "\(scheme): pierścień kryjący")
      XCTAssertEqual(Double(edge.r), Double(r * 255), accuracy: 3, "\(scheme): pierścień w atramencie tekstu")
      XCTAssertEqual(Double(edge.g), Double(g * 255), accuracy: 3)
      XCTAssertEqual(Double(edge.b), Double(b * 255), accuracy: 3)
      XCTAssertLessThanOrEqual(max(abs(Int(edge.r) - Int(edge.b)), abs(Int(edge.g) - Int(edge.b))), 6, "\(scheme): bez błękitu")
      XCTAssertEqual(inside.a, 0, "\(scheme): wiersz bez zaznaczenia ma puste wnętrze")
    }
  }

  /// Fokus zgłoszony wierszowi idzie za komórką także przez odpięcie z okna: poza oknem widok nie
  /// słyszy systemu fokusu, więc odpięty zgłasza „bez fokusu”, a po powrocie czyta stan od nowa. Nowe wywołanie
  /// (komórka z puli pod innym wierszem) dostaje bieżący fokus. Symulator nie ma systemu fokusu: odczyt podmieniony.
  func testReportedFocusFollowsCellThroughDetachAndReuse() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let view = ListCellFocusView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    var focused = false
    view.readFocus = { _ in focused }
    var reports: [Bool] = []
    view.onFocusChange = { reports.append($0) }

    window.addSubview(view)
    focused = true
    NotificationCenter.default.post(name: UIFocusSystem.didUpdateNotification, object: nil)
    Self.spin()
    XCTAssertEqual(reports, [true], "fokus komórki dochodzi do wiersza")

    view.removeFromSuperview()
    Self.spin()
    XCTAssertEqual(reports, [true, false], "odpięty wiersz bez pierścienia")

    window.addSubview(view)
    Self.spin()
    XCTAssertEqual(reports, [true, false, true], "po powrocie stan czytany od nowa, bez czekania na powiadomienie")

    var reused: [Bool] = []
    view.onFocusChange = { reused.append($0) }
    view.syncFocus(redeliver: true)
    Self.spin()
    XCTAssertEqual(reused, [true], "nowe wywołanie zna bieżący fokus")
  }

  private static func spin() {
    for _ in 0..<5 { RunLoop.main.run(until: Date().addingTimeInterval(0.15)) }
  }

  private static func views<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
    ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
  }

  private static func pixel(_ image: CGImage, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8)? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      // Jeden piksel obrazu na płótnie 1×1 (układ CG: y od dołu).
      context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
      return true
    }
    return drawn ? (bytes[0], bytes[1], bytes[2], bytes[3]) : nil
  }
}
