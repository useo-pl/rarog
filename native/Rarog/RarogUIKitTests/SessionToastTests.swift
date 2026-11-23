import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Dymek o innej sesji NAD PROMPTEM ekranu sesji na prawdziwym `SessionViewController` w oknie.
/// Dymek stoi 8 pt nad dolną krawędzią transkryptu (nad polem, nie na nim), a przy pasku „Przewiń na dół" 8 pt nad
/// paskiem; gaśnie sam zegarem centrum, nowszy podmienia treść, stuknięcie gasi go bez animacji i otwiera sesję
/// w NASTĘPNEJ klatce, więc animacja znikania się nie haczy.
/// Dymek i pasek „na dół” stoją na osi kolumny treści (safe area, karta pola), także przy niesymetrycznej safe area.
/// Właściciel: łączność.
@MainActor
final class SessionToastTests: XCTestCase {
  /// Sterowane odliczanie dymka.
  final class Waits: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [CheckedContinuation<Void, Never>] = []
    var wait: @Sendable (Duration) async -> Void {
      { [self] _ in await withCheckedContinuation { continuation in lock.withLock { pending.append(continuation) } } }
    }
    var count: Int { lock.withLock { pending.count } }
    func release(_ index: Int) { lock.withLock { pending[index] }.resume() }
  }

  struct Fixture {
    let controller: SessionViewController
    let store: RarogStore
    let toasts: ToastCenter
    let navigation: RarogNavigation
    let waits: Waits
    let window: UIWindow
  }

  func testToastStandsAboveTranscriptAndPrompt() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let host = try XCTUnwrap(fixture.controller.toastChrome.host?.view)
    XCTAssertFalse(host.isHidden, "dymek na ekranie sesji")
    let view = try XCTUnwrap(fixture.controller.view)
    let toast = host.convert(host.bounds, to: view)
    let transcript = fixture.controller.collectionView.convert(fixture.controller.collectionView.bounds, to: view)
    let field = try XCTUnwrap(fixture.controller.composer.textView.superview)
    let card = field.convert(field.bounds, to: view)
    // The transcript runs under the foot, so the toast hangs 8 pt over the top of the foot.
    let footTop = fixture.controller.footTop
    XCTAssertEqual(toast.maxY, footTop - 8, accuracy: 0.5, "8 pt over the top of the foot: \(toast)")
    XCTAssertLessThan(toast.maxY, card.minY, "dymek nad polem, nie na nim: \(toast), pole \(card)")
    XCTAssertEqual(toast.midX, card.midX, accuracy: 1, "na osi karty pola: \(toast), karta \(card)")
    XCTAssertGreaterThan(toast.height, 20, "dymek ma wysokość z treści: \(toast)")
    XCTAssertLessThanOrEqual(toast.width, transcript.width - 32 + 0.5, "najwyżej szerokość transkryptu bez marginesów")
  }

  func testToastRisesAboveJumpBarAndBack() throws {
    let fixture = try Self.make(messages: 40)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let controller = fixture.controller
    // Odpięcie gestem: lista u góry, pasek „Przewiń na dół" stoi.
    controller.collectionView.setContentOffset(.zero, animated: false)
    controller.pinned = false
    controller.updateJumpBar()
    Self.layout(fixture)
    let bar = controller.readingChrome.jumpBar
    XCTAssertTrue(bar.isShown, "pasek „na dół” po odjechaniu od dna")
    let view = try XCTUnwrap(controller.view)
    let host = try XCTUnwrap(controller.toastChrome.host?.view)
    let barFrame = bar.convert(bar.bounds, to: view)
    XCTAssertEqual(host.frame.maxY, barFrame.minY - 8, accuracy: 0.5, "dymek nad paskiem: \(host.frame), pasek \(barFrame)")

    controller.jumpToBottom()
    Self.layout(fixture)
    XCTAssertEqual(host.frame.maxY, controller.footTop - 8, accuracy: 0.5, "after the jump the toast goes back over the foot")
  }

  func testToastExpiresAndNewerReplacesInPlace() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let chrome = fixture.controller.toastChrome
    let first = try XCTUnwrap(chrome.host?.rootView.toast)
    fixture.toasts.notice("Powiadomienia działają")
    Self.spin(0.1)
    let second = try XCTUnwrap(chrome.host?.rootView.toast, "nowszy dymek na ekranie")
    XCTAssertNotEqual(first.id, second.id)
    XCTAssertEqual(second.text, "Powiadomienia działają")
    XCTAssertEqual(chrome.host?.view.alpha ?? 0, 1, accuracy: 0.01, "podmiana w miejscu, bez gaśnięcia")

    Self.until { fixture.waits.count == 2 }
    fixture.waits.release(1)
    Self.until { fixture.toasts.current == nil }
    Self.spin(0.4)
    XCTAssertNil(fixture.toasts.current, "zegar centrum zdjął dymek")
    XCTAssertEqual(chrome.host?.view.isHidden, true, "po zgaśnięciu host schowany (bez celu dotyku)")
  }

  func testTapHidesToastAtOnceAndOpensSessionNextFrame() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let chrome = fixture.controller.toastChrome
    let toast = try XCTUnwrap(chrome.host?.rootView.toast)
    fixture.controller.openToast(toast)
    XCTAssertEqual(chrome.host?.view.isHidden, true, "stuknięcie gasi dymek od razu, bez animacji")
    XCTAssertEqual(chrome.host?.view.layer.animationKeys() ?? [], [], "bez animacji znikania")
    XCTAssertNil(fixture.toasts.current)
    XCTAssertEqual(fixture.navigation.selectedSessionId, "s1", "nowy ekran dopiero po klatce bez dymka")
    Self.until { fixture.navigation.selectedSessionId == "s2" }
    XCTAssertEqual(fixture.navigation.selectedSessionId, "s2", "dymek prowadzi do swojej sesji")
  }

  /// Stuknięcie w trakcie pojawiania (krycie i wjazd w toku): dymek gaśnie od razu, bez resztek animacji.
  func testTapDuringAppearanceHidesAtOnce() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    fixture.toasts.offer(
      SessionSignal(sessionId: "s2", kind: .permission, serial: 1), state: fixture.store.state, viewing: "s1")
    Self.until { fixture.controller.toastChrome.host?.view.isHidden == false }
    let host = try XCTUnwrap(fixture.controller.toastChrome.host?.view)
    XCTAssertFalse(host.layer.animationKeys()?.isEmpty ?? true, "pojawianie w toku")
    let toast = try XCTUnwrap(fixture.controller.toastChrome.host?.rootView.toast)
    fixture.controller.openToast(toast)
    XCTAssertTrue(host.isHidden)
    XCTAssertEqual(host.layer.animationKeys() ?? [], [], "wjazd przerwany")
    XCTAssertEqual(host.transform, .identity)
    Self.until { fixture.navigation.selectedSessionId == "s2" }
    XCTAssertEqual(fixture.navigation.selectedSessionId, "s2")
  }

  /// Nowszy dymek przyszedł między stuknięciem a następną klatką: stuknięty prowadzi do swojej sesji, a nowszy
  /// (komunikat apki) zostaje na ekranie.
  func testNewerToastAfterTapStaysAndTappedOneOpens() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let chrome = fixture.controller.toastChrome
    let toast = try XCTUnwrap(chrome.host?.rootView.toast)
    fixture.controller.openToast(toast)
    fixture.toasts.notice("Powiadomienia działają")
    Self.until { fixture.navigation.selectedSessionId == "s2" }
    XCTAssertEqual(fixture.navigation.selectedSessionId, "s2", "stuknięty dymek otwiera swoją sesję")
    XCTAssertEqual(fixture.toasts.current?.text, "Powiadomienia działają", "nowszy dymek nie zgasł")
  }

  /// Człowiek przeszedł gdzie indziej między stuknięciem a następną klatką: odłożone otwarcie nie zabiera go
  /// z miejsca, które sam wybrał.
  func testNavigationBeforeDeferredOpenWins() throws {
    let fixture = try Self.make(messages: 2)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let toast = try XCTUnwrap(fixture.controller.toastChrome.host?.rootView.toast)
    fixture.controller.openToast(toast)
    fixture.navigation.detail = .project("/Users/demo/inny")
    Self.spin(0.2)
    XCTAssertEqual(fixture.navigation.detail, .project("/Users/demo/inny"), "odłożone otwarcie nie nadpisuje wyboru")
  }

  /// Strażnik wyśrodkowania: dymek
  /// i pasek „Przewiń na dół” stoją na osi karty pola, czyli kolumny w safe area, a nie na osi listy transkryptu,
  /// która sięga krawędzi widoku. Niesymetryczna safe area (wstawka 120 pt z lewej) rozjeżdża te osie o 60 pt.
  func testToastAndJumpBarCenterOnContentColumn() throws {
    let fixture = try Self.make(messages: 40, leftInset: 120)
    defer { fixture.window.isHidden = true }
    try Self.offer(fixture)
    let controller = fixture.controller
    let view = try XCTUnwrap(controller.view)
    let column = view.safeAreaLayoutGuide.layoutFrame
    XCTAssertEqual(column.minX, 120, accuracy: 0.5, "wstawka safe area działa")
    let field = try XCTUnwrap(controller.composer.textView.superview)
    let card = field.convert(field.bounds, to: view)
    XCTAssertEqual(card.midX, column.midX, accuracy: 1, "karta pola na osi kolumny: \(card), kolumna \(column)")
    let host = try XCTUnwrap(controller.toastChrome.host?.view)
    XCTAssertEqual(host.frame.midX, card.midX, accuracy: 1, "dymek na osi karty: \(host.frame), karta \(card)")
    XCTAssertLessThanOrEqual(host.frame.width, column.width - 32 + 0.5, "dymek najwyżej kolumna bez marginesów")
    // Tekst transkryptu też stoi w kolumnie (marginesy komórek liczą się od safe area), więc to jedna oś treści.
    let texts = controller.collectionView.visibleCells.flatMap { Self.textViews(in: $0) }
    XCTAssertFalse(texts.isEmpty, "tekst w komórkach")
    for text in texts {
      let frame = text.convert(text.bounds, to: view)
      XCTAssertGreaterThanOrEqual(frame.minX, column.minX + 16 - 0.5, "tekst w kolumnie: \(frame)")
      XCTAssertLessThanOrEqual(frame.maxX, column.maxX - 16 + 0.5, "tekst w kolumnie: \(frame)")
    }

    controller.collectionView.setContentOffset(.zero, animated: false)
    controller.pinned = false
    controller.updateJumpBar()
    Self.layout(fixture)
    let bar = controller.readingChrome.jumpBar
    XCTAssertTrue(bar.isShown, "pasek „na dół” po odjechaniu od dna")
    let barFrame = bar.convert(bar.bounds, to: view)
    XCTAssertEqual(barFrame.midX, card.midX, accuracy: 1, "pasek na osi karty: \(barFrame), karta \(card)")
    XCTAssertEqual(host.frame.midX, barFrame.midX, accuracy: 1, "dymek nad paskiem w jednej osi")
  }

  /// Stuknięcie w pasek „Przewiń na dół”: pasek znika od razu, bez krycia, a lista jedzie na dół.
  func testJumpBarTapHidesAtOnce() throws {
    let fixture = try Self.make(messages: 40)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    controller.collectionView.setContentOffset(.zero, animated: false)
    controller.pinned = false
    controller.updateJumpBar()
    Self.spin(0.3)
    let bar = controller.readingChrome.jumpBar
    XCTAssertTrue(bar.isShown)
    XCTAssertFalse(bar.isHidden)
    controller.jumpToBottom()
    XCTAssertFalse(bar.isShown)
    XCTAssertTrue(bar.isHidden, "pasek schowany od razu")
    XCTAssertEqual(bar.alpha, 0)
    XCTAssertEqual(bar.layer.animationKeys() ?? [], [], "bez krycia równolegle ze skokiem")
    XCTAssertTrue(controller.pinned, "skok przypina")
  }

  func testReduceMotionAppearsWithoutMovement() throws {
    let fixture = try Self.make(messages: 2, reduceMotion: true)
    defer { fixture.window.isHidden = true }
    fixture.toasts.offer(SessionSignal(sessionId: "s2", kind: .done, serial: 1), state: fixture.store.state, viewing: "s1")
    Self.spin(0.05)
    let host = try XCTUnwrap(fixture.controller.toastChrome.host?.view)
    XCTAssertFalse(host.isHidden)
    XCTAssertEqual(host.transform, .identity, "„Ogranicz ruch”: samo krycie, bez wjazdu")
  }

  // MARK: - Pomocnicze

  private static func offer(_ fixture: Fixture) throws {
    fixture.toasts.offer(
      SessionSignal(sessionId: "s2", kind: .permission, serial: 1), state: fixture.store.state, viewing: "s1")
    spin(0.35)
    layout(fixture)
    XCTAssertNotNil(fixture.toasts.current, "dymek o innej sesji")
  }

  static func make(messages: Int, reduceMotion: Bool = false, leftInset: CGFloat = 0) throws -> Fixture {
    let store = try makeStore(messages: messages)
    let waits = Waits()
    let toasts = ToastCenter(announcer: Announcer(sink: { _ in }, now: Date.init), wait: waits.wait)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.selectSession("s1")
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.toastChrome.reduceMotion = { reduceMotion }
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: leftInset, bottom: 0, right: 0)
    controller.installToast(center: toasts, navigation: navigation)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 834, height: 1194))
    window.rootViewController = controller
    window.isHidden = false
    let fixture = Fixture(
      controller: controller, store: store, toasts: toasts, navigation: navigation, waits: waits, window: window)
    spin(0.2)
    layout(fixture)
    return fixture
  }

  static func textViews(in view: UIView) -> [UITextView] {
    view.subviews.flatMap { subview in
      (subview as? UITextView).map { [$0] } ?? textViews(in: subview)
    }
  }

  static func layout(_ fixture: Fixture) {
    for _ in 0..<3 {
      fixture.controller.view.setNeedsLayout()
      fixture.controller.view.layoutIfNeeded()
    }
  }

  static func spin(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  static func until(_ condition: () -> Bool) {
    for _ in 0..<100 where !condition() { spin(0.02) }
  }

  /// Dwie sesje: `s1` (ekran) czeka na wiadomość i ma `messages` odpowiedzi agenta, `s2` pracuje w innym projekcie.
  static func makeStore(messages: Int) throws -> RarogStore {
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    let sessions = #"""
      [{"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-input",
        "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
        "lastActivityAt":"2026-10-06T10:00:00.000Z"},
       {"id":"s2","cwd":"/Users/demo/inny","title":"inny","state":"running",
        "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T09:00:00.000Z",
        "lastActivityAt":"2026-10-06T10:00:00.000Z"}]
      """#
    try frame(store, #"{"type":"sessions-snapshot","sessions":\#(sessions)}"#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    let body = (1...messages).map { seq in
      let text = "Odpowiedź \(seq).\\n\\nDrugi akapit odpowiedzi, dość długi, żeby zawinął się na wąskim ekranie i dał komórce kilka linii."
      return #"{"seq":\#(seq),"role":"assistant","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"\#(text)"}]}"#
    }.joined(separator: ",")
    try frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(body)],"pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }

  static func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: source, cursor: nil))
  }
}
