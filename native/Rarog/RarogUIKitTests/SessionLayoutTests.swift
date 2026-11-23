import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Stopa ekranu sesji na prawdziwym `SessionViewController` w oknie (odbiór na iPhonie Air, build 1154).
/// The field card stands 10 pt from the column's edges and, with the keyboard down, its bottom edge stands
/// `ListFooterMetrics.bottomGap` from the bottom of the screen — the gap of the list footer card, so on the iPad both
/// glass cards end on one line. Nad klawiaturą odstęp się nie
/// zmienia (XCUITest `TranscriptLookUITests`).
@MainActor
final class SessionLayoutTests: XCTestCase {
  func testComposerFieldStandsOnScreenEdgeRule() throws {
    // iPhone Air (34 pt), iPad z paskiem home (20 pt), telefon w poziomie (21 pt), okno bez safe area.
    // Okno testu ma safe area ekranu symulatora (iPhone Air: 34 pt, iPad poza sceną: 0 pt) i da się ją
    // tylko powiększyć (`additionalSafeAreaInsets`): mniejsze przypadki sprawdza przebieg na iPadzie.
    var checked: [CGFloat] = []
    for (safeBottom, gap) in [(34.0, 18.0), (20, 14), (21, 14), (0, 14), (48, 32)] as [(CGFloat, CGFloat)] {
      let fixture = try Self.makeSession(safeBottom: safeBottom)
      defer { fixture.window.isHidden = true }
      guard fixture.window.safeAreaInsets.bottom <= safeBottom else { continue }
      checked.append(safeBottom)
      let view = try XCTUnwrap(fixture.controller.view)
      XCTAssertEqual(view.safeAreaInsets.bottom, safeBottom, "safe area okna testu")
      let field = try XCTUnwrap(Self.fieldFrame(fixture.controller))
      let screen = fixture.window.bounds
      XCTAssertEqual(screen.maxY - field.maxY, gap, accuracy: 0.5, "safe area \(safeBottom): dolna krawędź pola \(field)")
      XCTAssertEqual(field.minX, 10, accuracy: 0.5, "safe area \(safeBottom): lewy margines pola")
      XCTAssertEqual(screen.maxX - field.maxX, 10, accuracy: 0.5, "safe area \(safeBottom): prawy margines pola")
    }
    XCTAssertTrue(checked.contains(34), "przypadek iPhone'a Air sprawdzony: \(checked)")
    let attachment = XCTAttachment(string: "safe area sprawdzone: \(checked)")
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Ekran sesji tak, jak stoi w apce: `SessionScreen` w hoście SwiftUI. Ekran sięga krawędzi okna, a pole stoi
  /// `FootRest.gap` nad nią; z safe area kontenera widok UIKit kończyłby się nad wskaźnikiem home, a pole stałoby
  /// 34 + 10 pt nad krawędzią ekranu iPhone'a Air.
  func testSwiftUIHostedComposerStandsOnScreenEdgeRule() throws {
    let store = try Self.makeStore()
    let screen = SessionScreen(store: store, sessionId: "s1", drafts: ComposerDrafts())
      .environment(RarogNavigation(prefs: MemoryPreferences()))
      .ignoresSafeArea(.keyboard)
    let host = UIHostingController(rootView: screen)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 420, height: 912))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    for _ in 0..<3 {
      host.view.setNeedsLayout()
      host.view.layoutIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    func session(_ controller: UIViewController) -> SessionViewController? {
      (controller as? SessionViewController) ?? controller.children.lazy.compactMap(session).first
    }
    let controller = try XCTUnwrap(session(host), "ekran sesji w hoście SwiftUI")
    let field = try XCTUnwrap(Self.fieldFrame(controller))
    let safe = window.safeAreaInsets.bottom
    let gap = ListFooterMetrics.bottomGap(safeBottom: safe)
    XCTAssertEqual(window.bounds.maxY - field.maxY, gap, accuracy: 0.5, "safe area okna \(safe): dolna krawędź pola \(field)")
    XCTAssertEqual(field.minX, 10, accuracy: 0.5, "lewy margines pola")
  }

  /// Karta pola (kontener tekstu i rzędu kontrolek) w układzie okna.
  private static func fieldFrame(_ controller: SessionViewController) -> CGRect? {
    guard let container = controller.composer.textView.superview else { return nil }
    return container.convert(container.bounds, to: nil)
  }

  struct Fixture {
    let controller: SessionViewController
    let store: RarogStore
    let window: UIWindow
  }

  /// Sesja czekająca na wiadomość (pole przyjmuje tekst), jedna odpowiedź agenta, okno iPhone'a Air.
  static func makeSession(safeBottom: CGFloat, decisionMode: DecisionDock.Mode = DecisionDock.mode) throws -> Fixture {
    let store = try makeStore()
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.decisionMode = decisionMode
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 420, height: 912))
    window.rootViewController = controller
    window.isHidden = false
    controller.additionalSafeAreaInsets.bottom = max(0, safeBottom - window.safeAreaInsets.bottom)
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    controller.view.layoutIfNeeded()
    return Fixture(controller: controller, store: store, window: window)
  }

  /// Magazyn z sesją `s1` czekającą na wiadomość i jedną odpowiedzią agenta (bez sieci).
  private static func makeStore() throws -> RarogStore {
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    let session = #"""
      {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-input",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    let message = #"""
      {"seq":1,"role":"assistant","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"Gotowe."}]}
      """#
    try frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(message)],
       "pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }

  private static func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: source, cursor: nil))
  }
}
