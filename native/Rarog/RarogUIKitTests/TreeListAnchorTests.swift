import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Kotwica zaznaczonej sesji w drzewie projektów: zmiana drzewa inna niż ręczne zwinięcie
/// jednego projektu zostawia zaznaczoną sesję, która stała cała na ekranie, co do punktu w tym samym miejscu. Każdy
/// przebieg idzie dwa razy — z kotwicą i z `TreeListAnchor.enabled = false` — więc test pokazuje też, że scenariusz
/// bez kotwicy przesuwa wiersz (inaczej nie sprawdzałby niczego). Uprząż i dane: `TreeListAnchorProbe.swift`.
@MainActor
final class TreeListAnchorTests: XCTestCase {
  /// Bramka (`scripts/ios-check.sh`) daje każdemu testowi 300 s. Zdrowy `testSelectedRowStaysOnSnapshotChanges` trwa
  /// 149 s, a pętle pomiarowe tej klasy wolnieją pod obciążeniem Maca, więc klasa dostaje 600 s.
  override func setUp() {
    super.setUp()
    executionTimeAllowance = 600
  }

  // MARK: - Zmiany ze stanu serwera

  enum Snapshot: String, CaseIterable {
    case newJustAbove = "nowa sesja tuż nad"
    case closedAbove = "zamknięta nad"
    case newProjectAbove = "nowy projekt nad"
    case newBelow = "nowa pod"
    case closedAboveNewBelow = "zamknięta nad + nowa pod (ta sama liczba)"
    case reorderedByDay = "przestawienie projektów po dobie (ta sama liczba)"
    case twoInOneTurn = "dwa snapshoty w jednej turze (A→B→C)"
    case tallerAboveSameIndex = "zamknięta nad i nowa w jej miejscu w dwóch liniach (ta sama liczba i indeks)"

    /// Zmiana sięga nad zaznaczoną — bez kotwicy wiersz odjeżdża.
    var movesWithoutAnchor: Bool { self != .newBelow }

    @MainActor
    func apply(_ h: TreeAnchorHarness) throws {
      let base = h.fixture
      switch self {
      case .newJustAbove: try h.snapshot(base.adding("p6-e", in: "p6"))
      case .closedAbove: try h.snapshot(base.removing(["p3-a"]))
      case .newProjectAbove: try h.snapshot(base.adding("p6x-a", in: "p6x"))
      case .newBelow: try h.snapshot(base.adding("p9-c", in: "p9"))
      case .closedAboveNewBelow: try h.snapshot(base.removing(["p3-a"]).adding("p9-c", in: "p9"))
      case .reorderedByDay: try h.snapshot(base.active("p9", at: "2026-10-08T10:00:00.000Z"))
      case .twoInOneTurn:
        try h.snapshot(base.adding("p6-e", in: "p6"))
        try h.snapshot(base.adding("p6-e", in: "p6").adding("p2-d", in: "p2"))
      case .tallerAboveSameIndex:
        // p6-e (najmłodsza w p6) staje tam, gdzie stała p6-d: liczba wierszy i indeks zaznaczonej bez zmian, a wiersz
        // nad nią rośnie o drugą linię tytułu — kolekcję od celu odróżnia tylko wysokość.
        try h.snapshot(base.removing(["p6-d"]).adding("p6-e", in: "p6", label: "p6 e \(TreeAnchorFixture.long)"))
      }
    }
  }

  func testSelectedRowStaysOnSnapshotChanges() throws {
    var failures: [String] = []
    for scenario in Snapshot.allCases {
      for fraction in [0.25, 0.75] as [CGFloat] {
        let anchored = try snapshotRun(scenario, fraction: fraction, enabled: true)
        let control = try snapshotRun(scenario, fraction: fraction, enabled: false)
        let label = "\(scenario.rawValue), f \(fraction)"
        check(anchored, label: label)
        if anchored.worst > 1 || abs(anchored.final) > 1 { failures.append("\(label): \(anchored.summary)") }
        if scenario.movesWithoutAnchor {
          XCTAssertGreaterThan(control.worst, 1, "\(label): bez kotwicy wiersz odjeżdża — \(control.summary)")
        } else {
          XCTAssertLessThanOrEqual(control.worst, 1, "\(label): zmiana pod nie rusza wiersza — \(control.summary)")
        }
        print("KOTWICA|snapshot|\(label)|z kotwicą \(anchored.f(anchored.worst))|bez \(control.f(control.worst))")
      }
    }
    XCTAssertTrue(failures.isEmpty, "kotwica ≤ 1 pt w każdej próbce:\n" + failures.joined(separator: "\n"))
  }

  private func snapshotRun(_ scenario: Snapshot, fraction: CGFloat, enabled: Bool) throws -> TreeAnchorRun {
    let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
    defer { h.close() }
    let item = try XCTUnwrap(h.index(.session("p7-a")))
    h.place(item: item, at: fraction)
    XCTAssertTrue(h.wholeOnScreen(item), "p7-a cała na ekranie (f \(fraction))")
    return try h.measure(
      "\(scenario.rawValue) f \(fraction)\(enabled ? "" : " bez kotwicy")", session: "p7-a"
    ) { try scenario.apply(h) }
  }

  /// Dym na telefonie (393×852, lista w stosie, `besideDetail: false`): bez awarii i bez ruchu ponad bez-kotwicy.
  func testSelectedRowStaysOnSnapshotChangesPhone() throws {
    for scenario in [Snapshot.newJustAbove, .closedAboveNewBelow] {
      var worst: [Bool: CGFloat] = [:]
      for enabled in [true, false] {
        let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled, phone: true)
        defer { h.close() }
        let item = try XCTUnwrap(h.index(.session("p7-a")))
        h.place(item: item, at: 0.75)
        let run = try h.measure("telefon: \(scenario.rawValue)\(enabled ? "" : " bez kotwicy")", session: "p7-a") {
          try scenario.apply(h)
        }
        worst[enabled] = run.worst
      }
      let anchored = try XCTUnwrap(worst[true]), control = try XCTUnwrap(worst[false])
      XCTAssertLessThanOrEqual(anchored, control + 1, "telefon, \(scenario.rawValue): kotwica nie dokłada ruchu")
      print("KOTWICA|telefon|\(scenario.rawValue)|z kotwicą \(anchored)|bez \(control)")
    }
  }

  // MARK: - Kiedy kotwica milczy

  /// Jeden skok przewinięcia (zaznaczona schodzi z ekranu), potem zmiana drzewa: lista przesuwa się tak samo jak bez
  /// kotwicy, a sesja zostaje poza ekranem (dawna pamięć miejsca bywała po takim skoku nieświeża i ściągała listę do
  /// sesji spoza ekranu: −1708, −668, −468, +569,5 pt).
  func testOffscreenSelectedDoesNotPullList() throws {
    enum Change: String { case newAbove = "nowa sesja nad", collapseAbove = "zwinięcie p1–p6 nad" }
    for (jump, change) in [(520, Change.newAbove), (-520, .newAbove), (520, .collapseAbove)] as [(CGFloat, Change)] {
      var deltas: [Bool: CGFloat] = [:]
      for enabled in [true, false] {
        let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
        defer { h.close() }
        let item = try XCTUnwrap(h.index(.session("p7-a")))
        h.place(item: item, at: 0.5)
        h.list.contentOffset.y += jump
        h.list.layoutIfNeeded()
        ProjectTreeListTests.spin()
        h.stopStuckScroll()
        XCTAssertFalse(h.wholeOnScreen(item), "skok \(jump): p7-a poza ekranem przed zmianą")
        let offset0 = h.list.contentOffset.y
        let eventsBefore = h.events.count
        switch change {
        case .newAbove: try h.snapshot(h.fixture.adding("p3-e", in: "p3"))
        case .collapseAbove: h.setCollapsed((1...6).map { "p\($0)" }, true)
        }
        ProjectTreeListTests.spin()
        deltas[enabled] = h.list.contentOffset.y - offset0
        let after = try XCTUnwrap(h.index(.session("p7-a")))
        XCTAssertFalse(h.wholeOnScreen(after), "skok \(jump), \(change.rawValue): sesja zostaje poza ekranem")
        if enabled {
          XCTAssertFalse(h.events[eventsBefore...].contains { if case .corrected = $0 { true } else { false } },
                         "skok \(jump), \(change.rawValue): bez korekty")
        }
      }
      let anchored = try XCTUnwrap(deltas[true]), control = try XCTUnwrap(deltas[false])
      XCTAssertEqual(anchored, control, accuracy: 0.5, "skok \(jump), \(change.rawValue): Δ offset jak bez kotwicy")
      print("KOTWICA|poza ekranem|skok \(jump), \(change.rawValue)|Δ offset z kotwicą \(anchored)|bez \(control)")
    }
  }

  /// Zmiana drzewa w trakcie przewinięcia animowanego z kodu (`setContentOffset(animated: true)`): kotwica nie rusza
  /// przesunięcia — lista dobiega tam, dokąd jechała, jak bez kotwicy.
  func testAnchorIdleWhileScrolling() throws {
    var finals: [Bool: CGFloat] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.5)
      let target = h.list.contentOffset.y + 200
      let eventsBefore = h.events.count
      h.list.setContentOffset(CGPoint(x: h.list.contentOffset.x, y: target), animated: true)
      RunLoop.main.run(until: Date().addingTimeInterval(0.08))
      let animating = h.list.isScrollAnimating, decelerating = h.list.isDecelerating
      try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
      ProjectTreeListTests.spin()
      finals[enabled] = h.list.contentOffset.y - target
      let events = h.events[eventsBefore...]
      print("KOTWICA|w ruchu|\(enabled ? "z kotwicą" : "bez")|isScrollAnimating \(animating) isDecelerating "
        + "\(decelerating)|koniec − cel \(h.list.contentOffset.y - target)|zdarzenia "
        + events.map(TreeAnchorRun.describe).joined(separator: " → "))
      if enabled {
        XCTAssertTrue(animating, "przewinięcie animowane trwa w chwili zmiany")
        XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } }, "bez korekty")
        XCTAssertFalse(events.contains { if case .measured = $0 { true } else { false } }, "bez odczytu")
      }
    }
    let anchored = try XCTUnwrap(finals[true]), control = try XCTUnwrap(finals[false])
    XCTAssertEqual(anchored, control, accuracy: 0.5, "koniec przewinięcia jak bez kotwicy")
  }

  /// Zaznaczenie zmienia się między odczytem a korektą, wiersze nie: lista się nie rusza, odczyt przepada.
  func testPendingDroppedOnSelectionChange() throws {
    var deltas: [Bool: CGFloat] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.5)
      let offset0 = h.list.contentOffset.y
      let eventsBefore = h.events.count
      func reselect() {
        h.navigation.detail = .session("p6-a")
        h.store.selectListRow("p6-a")
      }
      // Z kotwicą — zaraz po odczycie w ciele listy; bez kotwicy (odczytu nie ma) — razem ze zmianą wierszy.
      h.onEvent = { event in
        guard case .measured = event else { return }
        h.onEvent = nil
        reselect()
      }
      try h.snapshot(h.fixture.adding("p3-e", in: "p3"))
      if !enabled { reselect() }
      ProjectTreeListTests.spin()
      deltas[enabled] = h.list.contentOffset.y - offset0
      let events = h.events[eventsBefore...]
      print("KOTWICA|zmiana zaznaczenia|\(enabled ? "z kotwicą" : "bez")|Δ offset \(h.list.contentOffset.y - offset0)|"
        + events.map(TreeAnchorRun.describe).joined(separator: " → "))
      XCTAssertEqual(h.navigation.listSelection(h.store.state), "p6-a")
      if enabled {
        XCTAssertTrue(events.contains { if case .measured = $0 { true } else { false } }, "odczyt był")
        XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } }, "bez korekty")
      }
    }
    let anchored = try XCTUnwrap(deltas[true]), control = try XCTUnwrap(deltas[false])
    XCTAssertEqual(anchored, control, accuracy: 0.5, "lista się nie rusza ponad to, co robi bez kotwicy")
    XCTAssertEqual(anchored, 0, accuracy: 0.5, "przesunięcie bez zmian")
  }

  /// Ręczne rozwinięcie projektu POD zaznaczoną (animacja 0,22 s, kotwica milczy), a po 0,1 s snapshot dodaje
  /// sesję NAD zaznaczoną: zaznaczona stoi ≤ 1 pt w modelu i w warstwie prezentacji przez cały przebieg.
  func testSnapshotDuringSingleToggleAnimation() throws {
    var runs: [Bool: TreeAnchorRun] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled) { _, navigation in
        navigation.setProjectsCollapsed([TreeAnchorFixture.cwd("p8")], collapsed: true)
      }
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.25)
      runs[enabled] = try h.measure(
        "rozwinięcie p8 pod + po 0,1 s nowa sesja nad\(enabled ? "" : " bez kotwicy")", session: "p7-a",
        duration: 0.9
      ) {
        h.toggle(["p8"], collapse: false, gesture: .project)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
      }
    }
    let anchored = try XCTUnwrap(runs[true]), control = try XCTUnwrap(runs[false])
    check(anchored, label: "snapshot w trakcie animacji rozwinięcia")
    print("KOTWICA|snapshot w trakcie animacji rozwinięcia|z kotwicą model \(anchored.f(anchored.worstModel)) widać "
      + "\(anchored.f(anchored.worstShown))|bez \(control.f(control.worst))")
    XCTAssertLessThanOrEqual(anchored.worstModel, 1, anchored.summary)
    XCTAssertLessThanOrEqual(anchored.worstShown, 1, anchored.summary)
    XCTAssertGreaterThan(control.worst, 1, "bez kotwicy wiersz odjeżdża — \(control.summary)")
  }

  /// Lista na samym dole, ręczne zwinięcie ostatniego projektu: treść się skraca, UIKit przycina przesunięcie,
  /// a nagłówek zjeżdża o tyle, ile trzeba, żeby lista dalej kończyła się przy dolnej krawędzi — o wysokość zwiniętych
  /// wierszy pod nim; kotwica się nie odzywa. Bez przejazdu listy wiersze, które wchodzą wtedy na ekran od góry, mają
  /// wysokości szacowane i rosną przy pomiarze (zmierzone: przesunięcie −159,5 pt, nagłówek +198 pt = cztery
  /// zwinięte sesje) — dlatego miarą są zwinięte wiersze, nie samo przesunięcie, i ten sam przebieg bez kotwicy.
  func testCollapseLastProjectAtBottom() throws {
    var moves: [Bool: CGFloat] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p11-c", enabled: enabled)
      defer { h.close() }
      h.scrollToEnd()
      let header = try XCTUnwrap(h.index(.project(TreeAnchorFixture.cwd("p12"))))
      let selected = try XCTUnwrap(h.index(.session("p11-c")))
      XCTAssertTrue(h.wholeOnScreen(selected), "p11-c cała na ekranie (kotwica miałaby co trzymać)")
      let header0 = try XCTUnwrap(h.cellFrame(header)?.minY)
      let offset0 = h.list.contentOffset.y
      // Wysokość wierszy, które zwinięcie zabierze spod nagłówka (wszystkie na ekranie, zmierzone).
      let vanishing = try ["a", "b", "c", "d"].map { suffix in
        try XCTUnwrap(h.cellFrame(h.index(.session("p12-\(suffix)")))?.height, "p12-\(suffix) na ekranie")
      }.reduce(0, +)
      let eventsBefore = h.events.count
      h.toggle(["p12"], collapse: true, gesture: .project)
      ProjectTreeListTests.spin()
      let headerItem = try XCTUnwrap(h.index(.project(TreeAnchorFixture.cwd("p12"))))
      XCTAssertEqual(headerItem, h.ids().count - 1, "zwinięty p12 bez widocznych agentów — ostatni wiersz")
      let header1 = try XCTUnwrap(h.cellFrame(headerItem)?.minY)
      let clip = offset0 - h.list.contentOffset.y
      XCTAssertGreaterThan(clip, 1, "UIKit przyciął przesunięcie (lista była na dole)")
      XCTAssertEqual(h.list.contentOffset.y, h.maxOffset, accuracy: 0.5, "lista dalej na samym dole")
      XCTAssertEqual(header1 - header0, vanishing, accuracy: 1, "nagłówek zjeżdża o wysokość zwiniętych wierszy")
      let events = h.events[eventsBefore...]
      XCTAssertFalse(events.contains { if case .measured = $0 { true } else { false } }, "kotwica bez odczytu")
      XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } }, "kotwica bez korekty")
      moves[enabled] = header1 - header0
      print("KOTWICA|zwinięcie ostatniego na dole|\(enabled ? "z kotwicą" : "bez")|nagłówek Δ \(header1 - header0)|"
        + "przycięcie przesunięcia \(clip)|zwinięte wiersze \(vanishing)")
    }
    XCTAssertEqual(try XCTUnwrap(moves[true]), try XCTUnwrap(moves[false]), accuracy: 0.5)
  }

  /// Zaznaczenie zdjęte razem ze zmianą wierszy i przejście przez pustą listę (szkielet po ponownym logowaniu)
  /// z powrotem: bez ruchu ponad to, co robi lista bez kotwicy, i bez awarii.
  func testSelectionRemovedOrReset() throws {
    var deltas: [String: CGFloat] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.5)
      var offset0 = h.list.contentOffset.y
      var eventsBefore = h.events.count
      h.navigation.detail = nil
      h.store.selectListRow(nil)
      try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
      ProjectTreeListTests.spin()
      deltas["zdjęte \(enabled)"] = h.list.contentOffset.y - offset0
      XCTAssertFalse(h.events[eventsBefore...].contains { if case .corrected = $0 { true } else { false } })

      h.navigation.detail = .session("p7-a")
      h.store.selectListRow("p7-a")
      ProjectTreeListTests.spin()
      h.place(item: try XCTUnwrap(h.index(.session("p7-a"))), at: 0.5)
      offset0 = h.list.contentOffset.y
      eventsBefore = h.events.count
      h.store.dispatch(.loggedIn)
      ProjectTreeListTests.spin()
      XCTAssertEqual(h.list.numberOfItems(inSection: 0), 5, "szkielet")
      try TreeAnchorFixture.connect(h.store)
      try h.snapshot(h.fixture)
      ProjectTreeListTests.spin()
      XCTAssertEqual(h.list.numberOfItems(inSection: 0), h.ids().count, "drzewo wróciło")
      deltas["szkielet \(enabled)"] = h.list.contentOffset.y - offset0
      let events = h.events[eventsBefore...]
      XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } }, "bez korekty")
      print("KOTWICA|szkielet|\(enabled ? "z kotwicą" : "bez")|Δ offset \(h.list.contentOffset.y - offset0)|"
        + events.map(TreeAnchorRun.describe).joined(separator: " → "))
    }
    for key in ["zdjęte", "szkielet"] {
      let anchored = try XCTUnwrap(deltas["\(key) true"]), control = try XCTUnwrap(deltas["\(key) false"])
      XCTAssertEqual(anchored, control, accuracy: 0.5, "\(key): Δ offset jak bez kotwicy")
      print("KOTWICA|\(key)|Δ offset z kotwicą \(anchored)|bez \(control)")
    }
  }

  /// Kolumna listy schowana (Cmd+B), snapshot, odkrycie: bez przewinięcia wywołanego kotwicą.
  func testColumnHiddenNoAnchor() throws {
    var results: [Bool: (offset: CGFloat, row: CGFloat)] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p7-a", enabled: enabled)
      defer { h.close() }
      let item = try XCTUnwrap(h.index(.session("p7-a")))
      h.place(item: item, at: 0.75)
      let offset0 = h.list.contentOffset.y
      let row0 = try XCTUnwrap(h.cellFrame(item)?.minY)
      let eventsBefore = h.events.count
      h.navigation.setListCollapsed(true)
      ProjectTreeListTests.spin()
      XCTAssertTrue(h.navigation.listHidden, "kolumna schowana")
      let inWindow = h.list.window != nil
      try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
      ProjectTreeListTests.spin()
      h.navigation.setListCollapsed(false)
      ProjectTreeListTests.spin()
      let row1 = try XCTUnwrap(h.cellFrame(h.index(.session("p7-a")))?.minY)
      results[enabled] = (h.list.contentOffset.y - offset0, row1 - row0)
      let events = h.events[eventsBefore...]
      XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } }, "bez korekty")
      print("KOTWICA|Cmd+B|\(enabled ? "z kotwicą" : "bez")|kolekcja w oknie po schowaniu \(inWindow)|Δ offset "
        + "\(h.list.contentOffset.y - offset0)|wiersz Δ \(row1 - row0)|"
        + events.map(TreeAnchorRun.describe).joined(separator: " → "))
    }
    let anchored = try XCTUnwrap(results[true]), control = try XCTUnwrap(results[false])
    XCTAssertEqual(anchored.offset, control.offset, accuracy: 0.5, "Δ offset jak bez kotwicy")
    XCTAssertEqual(anchored.row, control.row, accuracy: 0.5, "wiersz jak bez kotwicy")
  }

  // MARK: - Strażnicy założeń

  /// Kolejność zdarzeń, na której stoją trzy stany (`TreeListAnchorState`): ciało listy liczy się, gdy kolekcja ma
  /// jeszcze stare wiersze, a `onChange` przychodzi, gdy kolekcja ma już nowe. Gdy nowy iOS to zmieni, kotwica
  /// przestaje mierzyć (lista jak bez kotwicy) — ten test pada pierwszy.
  func testBodySeesCollectionInOldState() throws {
    let h = try TreeAnchorHarness(selected: "p7-a")
    defer { h.close() }
    let item = try XCTUnwrap(h.index(.session("p7-a")))
    h.place(item: item, at: 0.5)
    let before = h.ids().count
    let eventsBefore = h.events.count
    try h.snapshot(h.fixture.adding("p6-e", in: "p6").adding("p5-e", in: "p5"))
    ProjectTreeListTests.spin()
    let events = Array(h.events[eventsBefore...])
    print("KOTWICA|kolejność|" + events.map(TreeAnchorRun.describe).joined(separator: " → "))
    let body = try XCTUnwrap(events.firstIndex { if case .body = $0 { true } else { false } }, "ciało z nowym celem")
    XCTAssertEqual(events[body], .body(collection: before, applied: before, target: before + 2),
                   "ciało widzi kolekcję ze starymi wierszami")
    let applied = try XCTUnwrap(events.firstIndex { if case .applied = $0 { true } else { false } }, "onChange")
    XCTAssertEqual(events[applied], .applied(collection: before + 2, target: before + 2),
                   "onChange po aktualizacji kolekcji")
    XCTAssertLessThan(body, applied)
    let measured = try XCTUnwrap(events.firstIndex { if case .measured = $0 { true } else { false } }, "odczyt")
    let corrected = try XCTUnwrap(events.firstIndex { if case .corrected = $0 { true } else { false } }, "korekta")
    XCTAssertLessThan(measured, corrected)
  }

  /// Bez pętli układu: na jedną zmianę ograniczona liczba przebiegów widoku pomocniczego, a po 1 s bezczynności zero
  /// układów i zero zmian przesunięcia.
  func testNoLayoutLoop() throws {
    let h = try TreeAnchorHarness(selected: "p7-a")
    defer { h.close() }
    let item = try XCTUnwrap(h.index(.session("p7-a")))
    h.place(item: item, at: 0.75)
    let above = (1...6).map { "p\($0)" }
    let collapse = try h.measure("pętla: zwinięcie p1–p6", session: "p7-a") { h.setCollapsed(above, true) }
    let expand = try h.measure("pętla: rozwinięcie p1–p6", session: "p7-a") { h.setCollapsed(above, false) }
    let snapshot = try h.measure("pętla: nowy projekt nad", session: "p7-a") {
      try h.snapshot(h.fixture.adding("p6x-a", in: "p6x"))
    }
    for run in [collapse, expand, snapshot] {
      check(run, label: run.name)
      XCTAssertGreaterThan(run.layouts, 0, "\(run.name): widok pomocniczy dostał układ")
    }
  }

  // MARK: - Dogrywka po korekcie

  /// Dwie osobne zmiany w odstępie krótszym niż okno dogrywki: pierwsza zabiera wiersze POD zaznaczoną przy liście
  /// na samym dole (korekta przycięta do końca treści — sesja zjeżdża), druga dokłada wiersz pod nią. Druga zmiana
  /// nie rusza sesji: nowy odczyt bierze miejsce sesji po przyciętej korekcie, nie sprzed pierwszej zmiany.
  func testSecondChangeAfterClampedCorrectionKeepsRow() throws {
    var worst: [Bool: CGFloat] = [:]
    for enabled in [true, false] {
      let h = try TreeAnchorHarness(selected: "p11-c", enabled: enabled)
      defer { h.close() }
      h.scrollToEnd()
      let item = try XCTUnwrap(h.index(.session("p11-c")))
      XCTAssertTrue(h.wholeOnScreen(item), "p11-c cała na ekranie przy liście na dole")
      let offset0 = h.list.contentOffset.y
      let firstFrom = h.events.count
      try h.snapshot(h.fixture.removing(["p12-a", "p12-b", "p12-c", "p12-d"]))
      RunLoop.main.run(until: Date().addingTimeInterval(0.3))
      let clip = offset0 - h.list.contentOffset.y
      print("KOTWICA|pierwsza zmiana (przycięta)|\(enabled ? "z kotwicą" : "bez")|isScrollAnimating "
        + "\(h.list.isScrollAnimating)|" + h.events[firstFrom...].map(TreeAnchorRun.describe).joined(separator: " → "))
      XCTAssertGreaterThan(clip, 1, "pierwsza zmiana przycięła przesunięcie do końca treści")
      let run = try h.measure(
        "druga zmiana pod po przyciętej korekcie\(enabled ? "" : " bez kotwicy")", session: "p11-c", duration: 0.5
      ) { try h.snapshot(h.fixture.adding("p11-e", in: "p11")) }
      if enabled {
        check(run, label: run.name)
        XCTAssertLessThanOrEqual(run.worst, 1, run.summary)
      }
      worst[enabled] = run.worst
      print("KOTWICA|druga zmiana po przyciętej|\(enabled ? "z kotwicą" : "bez")|przycięcie \(clip)|"
        + run.f(run.worst))
    }
  }

  /// Po pierwszej korekcie, w oknie dogrywki, zaczyna się niezależne przewinięcie animowane (z kodu albo fokus
  /// klawiatury), a snapshot zmienia drzewo: kotwica go nie przerywa — bez korekty po starcie przewinięcia,
  /// a `isScrollAnimating` zostaje `true` (w tym procesie testów przewinięcie się nie kończy, więc to widać).
  func testSettleWindowLeavesAnimatedScrollAlone() throws {
    let h = try TreeAnchorHarness(selected: "p7-a")
    defer { h.close() }
    let item = try XCTUnwrap(h.index(.session("p7-a")))
    h.place(item: item, at: 0.5)
    try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
    RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    XCTAssertTrue(h.events.contains { if case .corrected = $0 { true } else { false } }, "pierwsza zmiana z korektą")
    let eventsBefore = h.events.count
    h.list.setContentOffset(CGPoint(x: h.list.contentOffset.x, y: h.list.contentOffset.y + 200), animated: true)
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    XCTAssertTrue(h.list.isScrollAnimating, "przewinięcie animowane trwa")
    try h.snapshot(h.fixture.adding("p5-e", in: "p5"))
    ProjectTreeListTests.spin()
    let events = h.events[eventsBefore...]
    print("KOTWICA|dogrywka a przewinięcie|isScrollAnimating po \(h.list.isScrollAnimating)|"
      + events.map(TreeAnchorRun.describe).joined(separator: " → "))
    let trail = events.map(TreeAnchorRun.describe).joined(separator: " → ")
    XCTAssertFalse(events.contains { if case .corrected = $0 { true } else { false } },
                   "bez korekty po starcie przewinięcia: \(trail)")
    XCTAssertTrue(h.list.isScrollAnimating, "kotwica nie przerwała przewinięcia")
  }

  /// Rozmiar kolekcji zmienia się w tej samej turze co snapshot (okno niższe o 68 pt, jak obrót albo klawiatura).
  /// Zmiany rozmiaru MIĘDZY odczytem a korektą w jednym obrocie pętli nie da się wywołać bez wymuszania układu
  /// w trakcie aktualizacji SwiftUI: kolekcja dostaje nowy rozmiar dopiero w przebiegu układu okna, już po korekcie
  /// (zmierzone: odczyt → układ → korekta → układ → unieważniony). Test pilnuje tego, co z tej drogi zostaje: nowy
  /// rozmiar kończy dogrywkę („inny rozmiar kolekcji”), po nim kotwica już nie koryguje, a zaznaczona stoi tam, gdzie
  /// postawiła ją korekta (okno zmniejsza się od dołu).
  func testSizeChangeEndsSettleWindow() throws {
    let h = try TreeAnchorHarness(selected: "p7-a")
    defer { h.close() }
    let item = try XCTUnwrap(h.index(.session("p7-a")))
    h.place(item: item, at: 0.25)
    let row0 = try XCTUnwrap(h.cellFrame(item)?.minY)
    let size0 = h.list.bounds.size
    let eventsBefore = h.events.count
    h.window.frame.size.height -= 68
    try h.snapshot(h.fixture.adding("p6-e", in: "p6"))
    ProjectTreeListTests.spin()
    XCTAssertNotEqual(h.list.bounds.size, size0, "kolekcja zmieniła rozmiar")
    let events = Array(h.events[eventsBefore...])
    print("KOTWICA|zmiana rozmiaru|" + events.map(TreeAnchorRun.describe).joined(separator: " → "))
    let dropped = try XCTUnwrap(events.firstIndex(of: .dropped("inny rozmiar kolekcji")), "dogrywka unieważniona")
    XCTAssertFalse(events[dropped...].contains { if case .corrected = $0 { true } else { false } },
                   "po zmianie rozmiaru bez korekty")
    let row1 = try XCTUnwrap(h.cellFrame(h.index(.session("p7-a")))?.minY)
    XCTAssertEqual(row1, row0, accuracy: 1, "zaznaczona stoi tam, gdzie postawiła ją korekta")
  }

  /// Wspólne asercje przebiegu z kotwicą: próbki są, każda z nich to zaznaczona sesja na ekranie (bez dziur — dziura
  /// „0 pt → brak komórki → 0 pt” ukrywałaby skok), bez pętli układu.
  func check(_ run: TreeAnchorRun, label: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertGreaterThan(run.commits.count, 0, "\(label): próbki po commicie", file: file, line: line)
    XCTAssertGreaterThan(run.frames.count, 0, "\(label): próbki klatek", file: file, line: line)
    XCTAssertEqual(run.foreign, 0, "\(label): mierzona komórka to zaznaczona sesja", file: file, line: line)
    XCTAssertEqual(run.missing, 0, "\(label): każda próbka ma komórkę zaznaczonej", file: file, line: line)
    XCTAssertEqual(run.idleLayouts, 0, "\(label): 1 s bezczynności bez układu widoku pomocniczego", file: file,
                   line: line)
    XCTAssertEqual(run.idleOffsetChanges, 0, "\(label): 1 s bezczynności bez zmian przesunięcia", file: file,
                   line: line)
    XCTAssertLessThanOrEqual(run.layouts, Self.layoutLimit, "\(label): przebiegi układu na jedną zmianę", file: file,
                             line: line)
  }

  /// Limit przebiegów układu widoku pomocniczego na jedną zmianę (pętla układu dałaby setki).
  static let layoutLimit = 12
}
