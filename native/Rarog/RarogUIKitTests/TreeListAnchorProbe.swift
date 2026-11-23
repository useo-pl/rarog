import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import QuartzCore
import SwiftUI
import UIKit
import XCTest

/// Uprząż pomiaru kotwicy drzewa: prawdziwy
/// `SessionListView` w `NavigationSplitView` (okno 1024×768 jak iPad Pro 11 w poziomie), dane o różnej wysokości
/// wierszy i próbki położenia zaznaczonej sesji (1) po każdym zatwierdzeniu transakcji Core Animation — model, i
/// (2) co klatkę `CADisplayLink` — warstwa prezentacji (to widzi człowiek, także w trakcie animacji). Lista NIE jest
/// przejeżdżana przed pomiarem: komórki spoza ekranu mają wysokości szacowane, jak w apce po starcie.
@MainActor
final class TreeAnchorHarness {
  let store: RarogStore
  let navigation: RarogNavigation
  let anchor: TreeListAnchor
  let window: UIWindow
  let list: UICollectionView
  var fixture: TreeAnchorFixture
  /// Zdarzenia kotwicy od zbudowania okna (`TreeListAnchor.trace`).
  var events: [TreeListAnchor.Event] = []
  /// Chwila każdego zdarzenia (`CACurrentMediaTime`), w tej samej kolejności co `events`.
  var stamps: [CFTimeInterval] = []
  /// Reakcja testu na zdarzenie kotwicy (np. zmiana zaznaczenia zaraz po odczycie).
  var onEvent: ((TreeListAnchor.Event) -> Void)?

  /// - Parameter phone: okno telefonu (393×852) z listą w stosie, bez szczegółu obok (`besideDetail: false`).
  init(
    selected: String?, enabled: Bool = true, fixture: TreeAnchorFixture = TreeAnchorFixture(), phone: Bool = false,
    transport: (any RarogTransporting)? = nil, prepare: (RarogStore, RarogNavigation) -> Void = { _, _ in }
  ) throws {
    let store = try fixture.store(transport: transport)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    if let selected {
      navigation.detail = .session(selected)
      store.selectListRow(selected)
    }
    prepare(store, navigation)
    let anchor = TreeListAnchor()
    anchor.enabled = enabled
    let window = UIWindow(
      frame: phone ? CGRect(x: 0, y: 0, width: 393, height: 852) : CGRect(x: 0, y: 0, width: 1024, height: 768))
    if phone {
      window.rootViewController = UIHostingController(rootView: NavigationStack {
        SessionListView(
          store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: false, treeAnchor: anchor)
      })
    } else {
      window.rootViewController = UIHostingController(
        rootView: TreeAnchorHost(store: store, navigation: navigation, anchor: anchor))
    }
    window.makeKeyAndVisible()
    self.store = store
    self.navigation = navigation
    self.anchor = anchor
    self.window = window
    self.fixture = fixture
    ProjectTreeListTests.spin()
    let count = store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil).count
    list = try XCTUnwrap(
      ProjectTreeListTests.views(UICollectionView.self, in: window).first {
        $0.numberOfSections > 0 && $0.numberOfItems(inSection: 0) == count
      }, "lista drzewa w oknie (\(count) wierszy)")
    anchor.trace = { [weak self] event in
      self?.events.append(event)
      self?.stamps.append(CACurrentMediaTime())
      self?.onEvent?(event)
    }
  }

  func close() {
    anchor.trace = nil
    onEvent = nil
    window.isHidden = true
  }

  func rows() -> [ProjectTreeRow] {
    store.state.projectTreeRows(collapsed: navigation.collapsedProjects, openCwd: nil, jumpCwd: nil)
  }

  func ids() -> [ProjectTreeID] { rows().map(\.id) }

  func index(_ id: ProjectTreeID) -> Int? { ids().firstIndex(of: id) }

  /// Pełny stan listy z serwera (bez animacji) ze sesjami `fixture`.
  func snapshot(_ fixture: TreeAnchorFixture) throws {
    self.fixture = fixture
    try TreeAnchorFixture.frame(store, fixture.snapshotJSON())
  }

  /// Projekty zwinięte albo rozwinięte drogą stanu, bez animacji (gest „Zwiń wszystkie”
  /// idzie z animacją).
  func setCollapsed(_ projects: [String], _ collapsed: Bool) {
    let cwds = projects.map(TreeAnchorFixture.cwd)
    navigation.setProjectsCollapsed(cwds, collapsed: collapsed)
    store.projectsToggled(cwds)
  }

  /// Gest drogą strzałki albo menu (`ProjectTreeRows.toggle`, z animacją jak w apce).
  func toggle(_ projects: [String], collapse: Bool, gesture: TreeToggleGesture) {
    ProjectTreeRows.toggle(
      projects.map(TreeAnchorFixture.cwd), collapse: collapse, gesture: gesture, navigation: navigation,
      store: store, anchor: anchor, reduceMotion: false)
  }

  // MARK: - Geometria

  var insets: UIEdgeInsets { list.adjustedContentInset }
  var visibleHeight: CGFloat { list.bounds.height - insets.top - insets.bottom }
  var maxOffset: CGFloat { max(-insets.top, list.contentSize.height + insets.bottom - list.bounds.height) }
  var listTop: CGFloat { (list.superview ?? window).convert(list.frame, to: window).minY }

  /// Zaznaczona (`item`) w ułamku `fraction` widocznej części (0 — górna krawędź u góry, 1 — dolna u dołu) samym
  /// `contentOffset`, bez centrowania i bez przejazdu: po skoku kolekcja mierzy komórki, które weszły na ekran, więc
  /// ustawienie powtarza się, aż wiersz stanie (najwyżej 5 razy).
  func place(item: Int, at fraction: CGFloat) {
    let path = IndexPath(item: item, section: 0)
    for _ in 0..<5 {
      guard let frame = list.layoutAttributesForItem(at: path)?.frame else { break }
      let wanted = frame.minY - insets.top - fraction * (visibleHeight - frame.height)
      let clamped = min(max(wanted, -insets.top), maxOffset)
      if abs(clamped - list.contentOffset.y) < 0.25 { break }
      list.contentOffset.y = clamped
      list.layoutIfNeeded()
    }
    ProjectTreeListTests.spin()
    stopStuckScroll()
  }

  /// Lista na samym dole treści (po skoku kolekcja mierzy komórki, więc koniec treści się przesuwa — do 5 razy).
  func scrollToEnd() {
    for _ in 0..<5 {
      guard abs(list.contentOffset.y - maxOffset) > 0.25 else { break }
      list.contentOffset.y = maxOffset
      list.layoutIfNeeded()
    }
    ProjectTreeListTests.spin()
    stopStuckScroll()
  }

  /// Skok przesunięcia, po którym kolekcja mierzy komórki i przycina przesunięcie do końca treści, uruchamia jej własne
  /// przewinięcie animowane (`performWhileAnimatingAutomaticContentOffsetAdjustments:`). W tym procesie testów (bez
  /// `UIApplication`) ono się nie kończy i `isScrollAnimating` zostaje `true` na zawsze — na urządzeniu kończy się samo
  /// po ułamku sekundy. Ustawienie listy przed pomiarem kończy je więc jawnie, inaczej kotwica uznałaby listę za
  /// dobiegającą w każdym następnym kroku.
  func stopStuckScroll() {
    guard list.isScrollAnimating else { return }
    list.setContentOffset(list.contentOffset, animated: false)
    ProjectTreeListTests.spin()
  }

  /// Ramka komórki `item` w oknie (model); `nil` — komórki nie ma na ekranie.
  func cellFrame(_ item: Int?) -> CGRect? {
    guard let item, let cell = list.cellForItem(at: IndexPath(item: item, section: 0)) else { return nil }
    return cell.convert(cell.bounds, to: window)
  }

  /// Ramka komórki względem widocznej części listy (pod paskiem, nad stopką).
  func visibleFrame(_ item: Int) -> CGRect? {
    guard let cell = list.cellForItem(at: IndexPath(item: item, section: 0)) else { return nil }
    return cell.frame.offsetBy(dx: 0, dy: -(list.contentOffset.y + insets.top))
  }

  /// Zaznaczona sesja cała w widocznej części listy.
  func wholeOnScreen(_ item: Int) -> Bool {
    guard let frame = visibleFrame(item) else { return false }
    return frame.minY >= -0.5 && frame.maxY <= visibleHeight + 0.5
  }

  /// Górna krawędź komórki w oknie z warstwy prezentacji (klatka w trakcie animacji).
  func shownTop(_ cell: UICollectionViewCell) -> CGFloat {
    let listShown = list.layer.presentation()?.bounds.minY ?? list.bounds.minY
    let cellShown = cell.layer.presentation()?.frame.minY ?? cell.frame.minY
    let parent = cell.superview === list ? 0 : (cell.superview.map { $0.convert($0.bounds, to: list).minY } ?? 0)
    return listTop + parent + cellShown - listShown
  }
}

/// Lista obok szczegółu jak w apce (`RarogRootView`): widoczność kolumn za `RarogNavigation.listHidden` (Cmd+B).
struct TreeAnchorHost: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let anchor: TreeListAnchor

  var body: some View {
    NavigationSplitView(columnVisibility: Binding(
      get: { navigation.listHidden ? .detailOnly : .all },
      set: { visibility in
        guard navigation.canToggleList else { return }
        navigation.setListCollapsed(visibility == .detailOnly)
      })
    ) {
      SessionListView(
        store: store, navigation: navigation, memory: ConnectionMemory(), besideDetail: true, treeAnchor: anchor)
    } detail: {
      Text("szczegół")
    }
    .navigationSplitViewStyle(.balanced)
  }
}

/// Dane o różnej wysokości wierszy: projekty z gałęzią i bez (nagłówek bez linii gałęzi), tytuły w dwóch liniach,
/// linia „na co czeka” i linia etapu (zadanie w tle), projekt z samej historii CLI, który nagłówka nie ma.
/// Zaznaczona `p7-a` stoi w środku: sześć projektów nad nią, pięć projektów pod nią.
@MainActor
struct TreeAnchorFixture {
  struct Spec: Equatable {
    var id: String
    var project: String
    var minute: Int
    var label: String?
    var state = "waiting-input"
    var git = true
    var extra = ""
    var activity = "2026-10-06T10:00:00.000Z"
    var since = "2026-10-06T10:00:00.000Z"
  }

  var specs: [Spec]
  /// Projekty z historii CLI bez sesji: są w katalogu, ale nie w drzewie.
  var recent = ["p4x"]

  static let long = "długi opis zadania, który na pewno zawinie się do drugiej linii w kolumnie listy"

  init() {
    var specs: [Spec] = []
    func add(_ project: String, _ count: Int, git: Bool = true, label: (Int) -> String? = { _ in nil }) {
      for index in 0..<count {
        let suffix = ["a", "b", "c", "d"][index]
        specs.append(Spec(id: "\(project)-\(suffix)", project: project, minute: index, label: label(index), git: git))
      }
    }
    add("p1", 4)
    add("p2", 3, git: false)
    add("p3", 4) { "p3 \($0) \(Self.long)" }
    add("p4", 4)
    add("p5", 4)
    add("p6", 4)
    add("p7", 1)
    add("p8", 4)
    add("p9", 2) { "p9 \($0) \(Self.long)" }
    add("p10", 3, git: false)
    add("p11", 4)
    add("p12", 4)
    // p4: czeka na zgodę (linia „na co czeka”) i pracuje w tle po turze (linia etapu z kropką).
    if let ask = specs.firstIndex(where: { $0.id == "p4-a" }) { specs[ask].state = "waiting-permission" }
    if let task = specs.firstIndex(where: { $0.id == "p4-b" }) {
      specs[task].extra = #","backgroundTasks":[{"id":"t","kind":"command","command":"pnpm test"}]"#
    }
    self.specs = specs
  }

  static func cwd(_ project: String) -> String { "/Users/demo/\(project)" }

  func adding(_ id: String, in project: String, minute: Int = 5, label: String? = nil) -> TreeAnchorFixture {
    var copy = self
    copy.specs.append(Spec(id: id, project: project, minute: minute, label: label))
    return copy
  }

  func removing(_ ids: Set<String>) -> TreeAnchorFixture {
    var copy = self
    copy.specs.removeAll { ids.contains($0.id) }
    return copy
  }

  /// Projekt z aktywnością innej doby: przestawia się w kolejności drzewa (doba aktywności malejąco).
  func active(_ project: String, at iso: String) -> TreeAnchorFixture {
    var copy = self
    for index in copy.specs.indices where copy.specs[index].project == project { copy.specs[index].activity = iso }
    return copy
  }

  /// Session `id` in a new state since `since` (a `session-changed` frame, `changedJSON`).
  func changing(_ id: String, state: String, since: String) -> TreeAnchorFixture {
    var copy = self
    for index in copy.specs.indices where copy.specs[index].id == id {
      copy.specs[index].state = state
      copy.specs[index].since = since
    }
    return copy
  }

  func snapshotJSON() -> String {
    #"{"type":"sessions-snapshot","sessions":[\#(specs.map(Self.sessionJSON).joined(separator: ","))]}"#
  }

  /// A `session-changed` frame with session `id` as the fixture has it.
  func changedJSON(_ id: String) -> String? {
    specs.first { $0.id == id }.map { #"{"type":"session-changed","session":\#(Self.sessionJSON($0))}"# }
  }

  static func sessionJSON(_ spec: Spec) -> String {
    let label = spec.label.map { #""label":"\#($0)","# } ?? #""label":"sesja \#(spec.id)","#
    let branch = spec.git ? #""branch":"main","# : ""
    let seen = spec.state == "waiting-input" ? #""seen":true,"# : ""
    return #"""
      {"id":"\#(spec.id)","cwd":"\#(cwd(spec.project))","title":"\#(spec.project)",\#(label)\#(branch)\#(seen)
       "state":"\#(spec.state)","stateSince":"\#(spec.since)",
       "createdAt":"2026-10-06T09:0\#(spec.minute):00.000Z","lastActivityAt":"\#(spec.activity)"\#(spec.extra)}
      """#
  }

  /// - Parameter transport: the store's transport (`UIKitTransport`); `nil` — a live client of an unreachable server.
  func store(transport: (any RarogTransporting)? = nil) throws -> RarogStore {
    let outbox = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let store = transport.map {
      RarogStore(transport: $0, rules: MutationRules(), outboxDirectory: outbox, clientBuild: 1)
    } ?? RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: outbox)
    store.dispatch(.loggedIn)
    try Self.connect(store)
    let projects = recent.map { #"{"cwd":"\#(Self.cwd($0))","mtime":"2026-10-06T10:00:00.000Z"}"# }
    let list = try JSONDecoder().decode(
      RecentProjectList.self, from: Data(#"{"projects":[\#(projects.joined(separator: ","))]}"#.utf8))
    store.dispatch(.catalog(.recentProjectsLoaded(list.projects, at: Date())))
    try Self.frame(store, snapshotJSON())
    return store
  }

  /// Strumień otwarty i `hello` (po `.loggedIn` także przy powrocie z pustej listy).
  static func connect(_ store: RarogStore) throws {
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
  }

  static func frame(_ store: RarogStore, _ json: String) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: .global, cursor: nil))
  }
}

/// Wynik jednego przebiegu: największe odchylenie zaznaczonej od miejsca przed zmianą.
struct TreeAnchorRun {
  var name: String
  /// Odchylenia po każdym commicie Core Animation (model) i co klatkę (prezentacja).
  var commits: [CGFloat] = []
  var frames: [CGFloat] = []
  /// Próbki, w których śledzona komórka nie była zaznaczoną sesją albo jej nie było.
  var foreign = 0
  var missing = 0
  var final: CGFloat = .nan
  var offsetDelta: CGFloat = .nan
  var events: [TreeListAnchor.Event] = []
  /// Chwila każdego zdarzenia (`CACurrentMediaTime`), w tej samej kolejności co `events`.
  var stamps: [CFTimeInterval] = []
  var layouts = 0
  var idleLayouts = 0
  var idleOffsetChanges = 0

  var worstModel: CGFloat { commits.max() ?? .nan }
  var worstShown: CGFloat { frames.max() ?? .nan }
  var worst: CGFloat { max(worstModel, worstShown) }
  var corrections: Int { events.filter { if case .corrected = $0 { true } else { false } }.count }
  var measured: Int { events.filter { if case .measured = $0 { true } else { false } }.count }

  var summary: String {
    "\(name): model \(f(worstModel)) widać \(f(worstShown)) końcowe \(f(final)) | Δ offset \(f(offsetDelta)) | "
      + "próbki \(commits.count)/\(frames.count), obce \(foreign), bez komórki \(missing) | odczyty \(measured), "
      + "korekty \(corrections), układy \(layouts) | bezczynność: układy \(idleLayouts), zmiany offsetu "
      + "\(idleOffsetChanges)"
  }

  func f(_ value: CGFloat) -> String {
    value.isFinite ? String(format: "%.1f", Double(value)) : "-"
  }

  static func describe(_ event: TreeListAnchor.Event) -> String {
    switch event {
    case let .body(collection, applied, target): "ciało(kolekcja \(collection), applied \(applied), cel \(target))"
    case let .measured(top): String(format: "odczyt(%.1f)", Double(top))
    case let .declined(reason): "bez odczytu(\(reason))"
    case .layout: "układ"
    case let .corrected(from, to): String(format: "korekta(%.1f→%.1f)", Double(from), Double(to))
    case let .dropped(reason): "unieważniony(\(reason))"
    case let .applied(collection, target): "onChange(kolekcja \(collection), cel \(target))"
    }
  }
}

/// Cel `CADisplayLink` (klasa NSObject z selektorem).
@MainActor
final class TreeAnchorTicker: NSObject {
  let body: @MainActor () -> Void
  init(_ body: @escaping @MainActor () -> Void) { self.body = body }
  @objc func tick() { body() }
}

/// Próbki przebiegu zbierane z obserwatora pętli i z `CADisplayLink`.
@MainActor
private final class TreeAnchorSamples {
  var run: TreeAnchorRun
  var newIds: [ProjectTreeID]
  init(run: TreeAnchorRun, ids: [ProjectTreeID]) {
    self.run = run
    newIds = ids
  }
}

extension TreeAnchorHarness {
  /// Przebieg: zaznaczona `session` musi stać na ekranie; `change` zmienia drzewo; próbki przez `duration` s, potem
  /// 1 s bezczynności (układy widoku pomocniczego i zmiany przesunięcia — pętla układu dałaby niezerowe).
  func measure(
    _ name: String, session: String, duration: TimeInterval = 0.8, change: () throws -> Void
  ) throws -> TreeAnchorRun {
    let oldIds = ids()
    let tracked = ProjectTreeID.session(session)
    let oldItem = try XCTUnwrap(oldIds.firstIndex(of: tracked), "\(name): \(session) w drzewie")
    let y0 = try XCTUnwrap(cellFrame(oldItem)?.minY, "\(name): \(session) na ekranie przed zmianą")
    let offset0 = list.contentOffset.y
    let samples = TreeAnchorSamples(run: TreeAnchorRun(name: name), ids: oldIds)
    let list = list

    // Komórka zaznaczona w kolekcji; musi to być `session` w drzewie, które kolekcja ma (stare albo nowe).
    func trackedCell() -> UICollectionViewCell? {
      guard list.numberOfSections > 0, let item = list.indexPathsForSelectedItems?.first?.item else {
        samples.run.missing += 1
        return nil
      }
      let count = list.numberOfItems(inSection: 0)
      // Stare wiersze, nowe po zmianie i bieżące ze stanu (zmiana w kilku krokach, np. gest i snapshot).
      let candidates = [oldIds, samples.newIds, self.ids()].filter { $0.count == count }
      guard candidates.contains(where: { $0.indices.contains(item) && $0[item] == tracked }) else {
        samples.run.foreign += 1
        return nil
      }
      guard let cell = list.cellForItem(at: IndexPath(item: item, section: 0)) else {
        samples.run.missing += 1
        return nil
      }
      return cell
    }

    let window = window
    let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 2_500_000) {
      _, _ in
      MainActor.assumeIsolated {
        guard let cell = trackedCell() else { return }
        samples.run.commits.append(abs(cell.convert(cell.bounds, to: window).minY - y0))
      }
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    let ticker = TreeAnchorTicker { [weak self] in
      guard let self, let cell = trackedCell() else { return }
      samples.run.frames.append(abs(self.shownTop(cell) - y0))
    }
    let link = CADisplayLink(target: ticker, selector: #selector(TreeAnchorTicker.tick))
    link.add(to: .main, forMode: .common)
    let eventsBefore = events.count
    let changedAt = CACurrentMediaTime()
    try change()
    samples.newIds = ids()
    let start = CACurrentMediaTime()
    while CACurrentMediaTime() - start < duration {
      RunLoop.main.run(until: Date().addingTimeInterval(0.004))
      samples.newIds = ids()
    }
    link.invalidate()
    CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
    ProjectTreeListTests.spin()
    var run = samples.run
    run.events = Array(events[eventsBefore...])
    run.layouts = run.events.filter { $0 == .layout }.count

    let changes = TreeAnchorCounter()
    let kvo = list.observe(\.contentOffset, options: [.new]) { _, _ in
      MainActor.assumeIsolated { changes.count += 1 }
    }
    let idleFrom = events.count
    RunLoop.main.run(until: Date().addingTimeInterval(1.0))
    kvo.invalidate()
    run.idleLayouts = events[idleFrom...].filter { $0 == .layout }.count
    run.idleOffsetChanges = changes.count
    if let item = ids().firstIndex(of: tracked), let frame = cellFrame(item) { run.final = frame.minY - y0 }
    run.offsetDelta = list.contentOffset.y - offset0
    print("kotwica drzewa: \(run.summary)")
    let timed = zip(run.events, stamps[eventsBefore...]).map { event, at in
      String(format: "%.0f ms ", (at - changedAt) * 1000) + TreeAnchorRun.describe(event)
    }
    print("kotwica drzewa: zdarzenia \(run.name): \(timed.joined(separator: " → "))")
    return run
  }
}

@MainActor
final class TreeAnchorCounter {
  var count = 0
}
