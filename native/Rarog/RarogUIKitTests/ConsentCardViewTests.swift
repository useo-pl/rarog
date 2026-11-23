import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Karta kanału zgód w widoku i w kontrolerze sesji: „Odrzuć” tylko, póki hook czeka na decyzję, plan kanału
/// z zielonym „Zatwierdź plan” bez opcji auto, bez neutralnego przycisku (ani „Odpowiedz w terminalu”, ani „Pokaż
/// w herdr”). Render prawdziwego `PermissionCardView` jak
/// w `PermissionCardTileTests` (kolory tokenów w pikselach).
/// Właściciel: karty.
@MainActor
final class ConsentCardViewTests: XCTestCase {
  static func card(
    permId: String = "k1", plan: Bool = false, canAllow: Bool, awaitingDecision: Bool, status: String? = nil,
    phase: CardPhase = .idle, hookChannel: Bool = true, always: String? = nil, fullInput: ConsentFullInput? = nil
  ) -> PermissionCardModel {
    var model = PermissionCardModel(
      permId: permId, sessionId: "s1",
      eyebrow: UICopy.permissionEyebrow(toolName: "Write", risky: false, plan: plan),
      toolName: "Write", risky: false, plan: plan, cwd: "~/Projects/ACME/rarog",
      command: plan ? "Plan: dopisać testy" : "npm test",
      commandSyntax: [], createdAt: nil, canAllow: canAllow, screen: nil, cliDialog: nil, phase: phase, error: nil,
      lockedReason: nil, alwaysLabel: always, note: nil)
    model.hookChannel = hookChannel
    model.awaitingDecision = awaitingDecision
    model.consentStatus = status
    model.fullInput = fullInput
    return model
  }

  /// A long request: "Allow" and the "always" tile stay greyed, without their fill,
  /// until the window with the whole input was open for the card; "Deny" keeps its red outline. The same for the
  /// plan approval.
  func testLongRequestGreysConsentUntilWindowOpened() async throws {
    let full = ConsentFullInput(text: "npm test", lines: 1)
    var locked = Self.card(canAllow: true, awaitingDecision: true, always: "Bash(npm test)", fullInput: full)
    let lockedBitmap = try await PermissionCardTileTests.render(locked, name: "karta-kanalu-dluga-zablokowana-ciemny")
    XCTAssertNil(lockedBitmap.box(of: PaletteTokens.run.dark), "„Zatwierdź” bez zieleni pracy")
    XCTAssertNil(Self.neutralBox(lockedBitmap), "kafel „Zawsze” bez wypełnienia")
    XCTAssertNotNil(lockedBitmap.box(of: PaletteTokens.err.dark), "„Odrzuć” w obrysie czerwieni")
    locked.fullInputRead = true
    let opened = try await PermissionCardTileTests.render(locked, name: "karta-kanalu-dluga-otwarta-ciemny")
    XCTAssertNotNil(opened.box(of: PaletteTokens.run.dark), "po oknie „Zatwierdź” na zieleni pracy")
    XCTAssertNotNil(Self.neutralBox(opened), "po oknie kafel „Zawsze” z wypełnieniem")
    let plan = try await PermissionCardTileTests.render(
      Self.card(plan: true, canAllow: true, awaitingDecision: true, fullInput: full),
      name: "karta-kanalu-plan-dlugi-zablokowany-ciemny")
    XCTAssertNil(plan.box(of: PaletteTokens.run.dark), "„Zatwierdź plan” bez zieleni pracy")
  }

  /// The controller sends no consent of a long request before its window was open, whichever button or path
  /// calls it: "Allow", "Always" and the plan approval through `allowAlways`. The marker is per card, survives a
  /// render, and a window that a form kept from opening is no marker. "Deny" always goes. The window counts once its
  /// content appeared on screen (`ConsentInputSheet`), not when the navigation state took it.
  func testControllerSendsNoConsentBeforeWindowOpened() async throws {
    let sent = DecisionLog()
    let screen = try Self.longRequestScreen(sent)
    defer { screen.window.isHidden = true }
    let (controller, navigation, tool, screenPlan) = (screen.controller, screen.navigation, screen.tool, screen.plan)

    controller.decide(tool, .allow)
    controller.decide(tool, .allowAlways)
    controller.decide(screenPlan, .allow)
    controller.decide(screenPlan, .allowAlways)
    for _ in 0..<50 { await Task.yield() }
    var log = await sent.decisions
    XCTAssertEqual(log, [], "zgoda bez okna nie wychodzi")

    // A form holds the screen: the window does not open, so the plan stays locked.
    navigation.openSheet(.newSession(NewSessionRequest(cwd: nil)))
    controller.openFullInput(screenPlan)
    XCTAssertFalse(controller.ui.fullInputRead.contains("p1"), "okno, którego formularz nie wpuścił, nie liczy się")
    navigation.sheet = nil

    controller.openFullInput(tool)
    guard case let .consentInput(request)? = navigation.sheet else { return XCTFail("okno całej prośby stoi") }
    let content = Self.show(ConsentInputSheet(request: request, windowWidth: 420))
    defer { content.isHidden = true }
    let marked = await Self.waitUntil { controller.ui.fullInputRead.contains("k1") }
    XCTAssertTrue(marked, "treść okna na ekranie odblokowuje kartę")
    // Another card's window does not unlock this one.
    controller.decide(screenPlan, .allow)
    for _ in 0..<50 { await Task.yield() }
    log = await sent.decisions
    XCTAssertEqual(log, [], "okno innej karty bez wpływu")

    // A render after the window keeps the marker; the card captured before the window counts too, because the
    // controller reads the marker from the screen state.
    let renders = controller.readingChrome.counters.renders
    controller.scheduleRender()
    let rendered = await Self.waitUntil { controller.readingChrome.counters.renders > renders }
    XCTAssertTrue(rendered)
    controller.decide(tool, .allowAlways)
    let always = await Self.waitUntil { await sent.decisions == [.allowAlways] }
    XCTAssertTrue(always, "po oknie „Zawsze” wychodzi")

    controller.decide(screenPlan, .deny)
    let denied = await Self.waitUntil { await sent.decisions == [.allowAlways, .deny] }
    XCTAssertTrue(denied, "„Odrzuć” bez okna wychodzi")
  }

  /// The marker comes from the window's content appearing, not from the navigation state:
  /// a window set and then closed, or replaced by another window, before its content appeared leaves "Allow",
  /// "Always" and the plan approval locked. The content of one card's window appearing unlocks that card only; the
  /// card whose window never appeared stays locked.
  func testWindowGoneBeforeItsContentAppearedUnlocksNothing() async throws {
    let sent = DecisionLog()
    let screen = try Self.longRequestScreen(sent)
    defer { screen.window.isHidden = true }
    let (controller, navigation, tool, screenPlan) = (screen.controller, screen.navigation, screen.tool, screen.plan)

    // Set and closed before its content appeared.
    controller.openFullInput(tool)
    guard case .consentInput? = navigation.sheet else { return XCTFail("okno karty narzędzia w stanie nawigacji") }
    navigation.sheet = nil
    // Replaced by another window before its content appeared.
    controller.openFullInput(screenPlan)
    guard case .consentInput? = navigation.sheet else { return XCTFail("okno karty planu w stanie nawigacji") }
    navigation.openDiff(sessionId: "s1", path: nil)
    guard case .diff? = navigation.sheet else { return XCTFail("okno diffa zastąpiło okno planu") }

    controller.decide(tool, .allow)
    controller.decide(tool, .allowAlways)
    controller.decide(screenPlan, .allow)
    for _ in 0..<50 { await Task.yield() }
    var log = await sent.decisions
    XCTAssertEqual(log, [], "okno, którego treść nie stanęła na ekranie, nie odblokowuje zgody")

    // The content of the tool card's window appears: that card's consent goes, the plan's does not.
    navigation.sheet = nil
    controller.openFullInput(tool)
    guard case let .consentInput(request)? = navigation.sheet else { return XCTFail("okno karty narzędzia stoi") }
    let content = Self.show(ConsentInputSheet(request: request, windowWidth: 420))
    defer { content.isHidden = true }
    let marked = await Self.waitUntil { controller.ui.fullInputRead.contains("k1") }
    XCTAssertTrue(marked, "treść okna na ekranie odblokowuje kartę")
    controller.decide(screenPlan, .allow)
    for _ in 0..<50 { await Task.yield() }
    log = await sent.decisions
    XCTAssertEqual(log, [], "plan, którego okno nie stanęło, zostaje zablokowany")
    controller.decide(tool, .allow)
    let allowed = await Self.waitUntil { await sent.decisions == [.allow] }
    XCTAssertTrue(allowed, "po treści okna „Zatwierdź” tej karty wychodzi")
  }

  /// The session screen in a window over ``longRequestStore(_:)``, with the navigation that takes its sheets, and the
  /// two long cards as the screen renders them: the tool card `k1` and the screen plan `p1`.
  private struct LongRequestScreen {
    let controller: SessionViewController
    let navigation: RarogNavigation
    let window: UIWindow
    let tool: PermissionCardModel
    let plan: PermissionCardModel
  }

  private static func longRequestScreen(_ sent: DecisionLog) throws -> LongRequestScreen {
    let store = try longRequestStore(UIKitTransport(onDecidePermission: { body in await sent.add(body.decision) }))
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    controller.navigation = navigation
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 420, height: 912))
    window.rootViewController = controller
    window.isHidden = false
    controller.view.layoutIfNeeded()
    let cards = TranscriptRows.build(state: store.state, sessionId: "s1", ui: controller.ui).compactMap { row in
      if case let .permission(card) = row { card } else { nil }
    }
    let tool = try XCTUnwrap(cards.first { $0.permId == "k1" })
    let plan = try XCTUnwrap(cards.first { $0.permId == "p1" })
    XCTAssertNotNil(tool.fullInput)
    XCTAssertEqual(plan.primaryDecision, .allowAlways)
    return LongRequestScreen(controller: controller, navigation: navigation, window: window, tool: tool, plan: plan)
  }

  /// Shows a view in its own window, as the sheet shows the window content. A test without the app host does not
  /// finish a sheet transition, so the window's content (`ConsentInputSheet`, what `SheetHost` puts in the sheet)
  /// appears here instead.
  private static func show(_ view: some View) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 420, height: 912))
    window.rootViewController = UIHostingController(rootView: view)
    window.isHidden = false
    window.rootViewController?.view.layoutIfNeeded()
    return window
  }

  /// A store with session `s1` waiting on two long requests (over 32 KiB): a channel `Write` with an "always" entry
  /// (`k1`) and a screen plan with the auto option (`p1`).
  private static func longRequestStore(_ transport: UIKitTransport) throws -> RarogStore {
    let store = RarogStore(
      transport: transport, rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    let session = #"""
      {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-permission",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    let long = String(repeating: "x", count: 40 * 1024)
    let hook = PermissionChannel.hook.rawValue
    let tool = #"""
      {"permId":"k1","sessionId":"s1","toolName":"Write","displayText":"\#(long)","risk":"normal",
       "cwd":"/Users/demo/project","createdAt":"2026-10-06T10:00:00.000Z","canAllow":true,"channel":"\#(hook)",
       "state":"pending","always":[{"kind":"rule","value":"Write","destination":"session"}]}
      """#
    let plan = #"""
      {"permId":"p1","sessionId":"s1","subject":"plan","toolName":"Write","displayText":"\#(long)",
       "risk":"normal","cwd":"/Users/demo/project","createdAt":"2026-10-06T10:00:00.000Z",
       "alwaysLabel":"Yes, and use auto mode"}
      """#
    try frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[],
       "pendingPermissions":[\#(tool),\#(plan)],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }

  private static func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: source, cursor: nil))
  }

  private static func waitUntil(_ condition: @MainActor () async -> Bool) async -> Bool {
    for _ in 0..<200 {
      if await condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }

  func testDenyOnlyWhileHookAwaitsDecision() async throws {
    let awaiting = try await PermissionCardTileTests.render(
      Self.card(canAllow: true, awaitingDecision: true), name: "karta-kanalu-czeka-ciemny")
    XCTAssertNotNil(awaiting.box(of: PaletteTokens.run.dark), "„Zatwierdź” na zieleni pracy")
    XCTAssertNotNil(awaiting.box(of: PaletteTokens.err.dark), "„Odrzuć” w obrysie czerwieni")
    let running = try await PermissionCardTileTests.render(
      Self.card(canAllow: false, awaitingDecision: false, status: UICopy.consentState(.running)),
      name: "karta-kanalu-biegnie-ciemny")
    XCTAssertNil(running.box(of: PaletteTokens.err.dark), "bez „Odrzuć”, gdy hook już nie słucha")
    XCTAssertNil(running.box(of: PaletteTokens.run.dark), "bez „Zatwierdź”")
    XCTAssertNil(Self.neutralBox(running), "bez „Pokaż w herdr”, gdy hook już nie słucha")
    let screen = try await PermissionCardTileTests.render(
      Self.card(canAllow: false, awaitingDecision: false, hookChannel: false), name: "karta-ekranu-bez-zgody-ciemny")
    XCTAssertNotNil(screen.box(of: PaletteTokens.err.dark), "karta ekranowa bez zgody: „Odrzuć”")
    XCTAssertNil(screen.box(of: PaletteTokens.run.dark), "karta ekranowa bez zgody: bez „Zatwierdź”")
    XCTAssertNil(Self.neutralBox(screen), "karta ekranowa bez zgody: bez „Pokaż w herdr”")
  }

  /// Karta dialogu, którego Rarog nie zna (także zgoda CLI): samo „Odrzuć dialog” i zdanie, bez neutralnego
  /// przycisku.
  func testUnknownDialogCardHasOnlyDeny() async throws {
    let card = ScreenBlockAnchorTests.card(reason: .consentDialog, cliDialog: .permission, screen: "")
    XCTAssertNil(card.allowLabel)
    let bitmap = try await CardDockLayoutTests.render(
      HerdrDialogCardView(card: card, decide: { _ in }), ceiling: nil, name: "karta-dialogu-bez-zgody-ciemny")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.err.dark), "„Odrzuć dialog” w obrysie czerwieni")
    XCTAssertNil(bitmap.box(of: PaletteTokens.run.dark), "bez „Zatwierdź”")
    XCTAssertNil(Self.neutralBox(bitmap), "bez „Pokaż w herdr”")
  }

  func testHookPlanHasGreenApproveWithoutAutoOption() async throws {
    let model = Self.card(plan: true, canAllow: true, awaitingDecision: true)
    XCTAssertEqual(model.primaryDecision, .allow)
    let bitmap = try await PermissionCardTileTests.render(model, name: "karta-kanalu-plan-ciemny")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.run.dark), "„Zatwierdź plan” na zieleni pracy")
  }

  /// Kontroler: „Odrzuć” (także Esc) na karcie kanału, której hook już nie słucha, i `release` z apki nic nie wysyłają.
  func testControllerDenyGuardAndNoRelease() async throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let hook = PermissionChannel.hook.rawValue
    let request = #"""
      {"permId":"k1","sessionId":"s1","toolName":"Write","displayText":"{}","risk":"normal","cwd":"/Users/demo/project",
       "createdAt":"2026-10-06T10:00:00.000Z","canAllow":true,"channel":"\#(hook)","state":"pending"}
      """#
    let event = try EventDecoder.decode(Data(#"{"type":"permission-pending","request":\#(request)}"#.utf8)).get().event
    fixture.store.dispatch(.frame(event, source: .session("s1"), cursor: nil))
    XCTAssertNotNil(fixture.store.state.transcripts["s1"]?.pendingPermissions.first { $0.permId == "k1" })

    fixture.controller.decide(Self.card(canAllow: false, awaitingDecision: false), .deny)
    fixture.controller.decide(Self.card(canAllow: true, awaitingDecision: true), .release)
    XCTAssertEqual(fixture.store.state.transcripts["s1"]?.decisions.isEmpty, true, "nic nie poszło")
    XCTAssertEqual(fixture.store.state.transcripts["s1"]?.releases.isEmpty, true, "bez zwolnienia z apki")
  }

  /// Karta kanału, póki hook czeka, nie ma neutralnego przycisku (wypełnienie `surface2`): ze zgodą „Zatwierdź”
  /// i „Odrzuć”, bez zgody samo „Odrzuć”. Po własnej decyzji wiersz stanu zastępuje stopkę bez żadnego przycisku,
  /// a karta ma wysokość z chwili przed tapnięciem.
  func testAwaitingCardHasNoNeutralButton() async throws {
    let idle = try await PermissionCardTileTests.render(
      Self.card(canAllow: true, awaitingDecision: true), name: "karta-kanalu-czeka-ciemny")
    XCTAssertNil(Self.neutralBox(idle), "bez „Odpowiedz w terminalu”")
    let denyOnly = try await PermissionCardTileTests.render(
      Self.card(canAllow: false, awaitingDecision: true), name: "karta-kanalu-bez-zgody-ciemny")
    XCTAssertNotNil(denyOnly.box(of: PaletteTokens.err.dark), "„Odrzuć” w obrysie czerwieni")
    XCTAssertNil(denyOnly.box(of: PaletteTokens.run.dark), "bez „Zatwierdź”")
    XCTAssertNil(Self.neutralBox(denyOnly), "bez „Odpowiedz w terminalu” i bez „Pokaż w herdr”")
    let phases: [(CardPhase, String)] = [
      (.sending(.allow), "karta-kanalu-zgoda-w-drodze-ciemny"), (.sending(.deny), "karta-kanalu-odmowa-w-drodze-ciemny"),
      (.sent(.allow), "karta-kanalu-zgoda-wyslana-ciemny"), (.sent(.deny), "karta-kanalu-odmowa-wyslana-ciemny"),
    ]
    for (phase, name) in phases {
      let bitmap = try await PermissionCardTileTests.render(
        Self.card(canAllow: true, awaitingDecision: true, phase: phase), name: name)
      XCTAssertNil(Self.neutralBox(bitmap), "\(name): obok wiersza stanu bez przycisku")
      XCTAssertNil(bitmap.box(of: PaletteTokens.run.dark), "\(name): bez „Zatwierdź”")
      XCTAssertNil(bitmap.box(of: PaletteTokens.err.dark), "\(name): bez „Odrzuć”")
      XCTAssertEqual(bitmap.size.height, idle.size.height, accuracy: 0.5, "\(name): wysokość karty bez skoku")
    }
  }

  /// Wypełnienie neutralnego przycisku (`surface2`, tuż nad tłem karty `surface`): prostokąt rzędów, w których ten
  /// kolor ciągnie się co najmniej 60 pt bez przerwy. Wygładzone krawędzie liter i kreski karty przechodzą przez ten
  /// odcień tylko pojedynczymi pikselami, więc pole koloru ich nie łapie.
  static func neutralBox(_ bitmap: PendingMediaRowTests.Bitmap) -> CGRect? {
    let target = PaletteTokens.surface2.dark
    let rgb = [Int((target >> 16) & 0xFF), Int((target >> 8) & 0xFF), Int(target & 0xFF)]
    let scale = Double(bitmap.width) / bitmap.size.width
    let minimum = Int(60 * scale)
    var box: CGRect?
    for y in 0..<bitmap.height {
      var run = 0
      for x in 0..<bitmap.width {
        let index = (y * bitmap.width + x) * 4
        let match = (0..<3).allSatisfy { abs(Int(bitmap.bytes[index + $0]) - rgb[$0]) <= 2 }
        run = match ? run + 1 : 0
        if run == minimum {
          let row = CGRect(x: Double(x - run + 1) / scale, y: Double(y) / scale, width: Double(run) / scale, height: 1 / scale)
          box = box.map { $0.union(row) } ?? row
        }
      }
    }
    return box
  }
}

/// Decisions that reached the transport, in order.
private actor DecisionLog {
  var decisions: [PermissionDecision] = []
  func add(_ decision: PermissionDecision) { decisions.append(decision) }
}
