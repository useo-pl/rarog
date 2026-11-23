import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Podpowiedź skrótu po najechaniu kursorem: własny dymek „Nazwa (⌘B)” nad oknem
/// przycisku, po chwili spoczynku, schowany przy naciśnięciu i wyjściu kursora. Symulator nie daje wskaźnika: zdarzenie
/// kursora podawane wprost (`ShortcutTipTracker.pointer`, kontroler kotwicy SwiftUI). Jeden przycisk UIKit („Wyślij”)
/// i jeden SwiftUI. Właściciel: skróty.
@MainActor
final class ShortcutTipUIKitTests: XCTestCase {
  private var window: UIWindow?

  override func tearDown() async throws {
    window?.isHidden = true
    window = nil
    try await super.tearDown()
  }

  private func show(_ controller: UIViewController) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    window.rootViewController = controller
    window.isHidden = false
    controller.view.layoutIfNeeded()
    self.window = window
    return window
  }

  /// Czeka na warunek najwyżej `limit` sekund (dymek staje po `ShortcutTipState.rest`).
  private func waitUntil(_ limit: TimeInterval = 3, _ condition: () -> Bool) async throws {
    let end = Date().addingTimeInterval(limit)
    while !condition(), Date() < end {
      try await Task.sleep(for: .milliseconds(50))
    }
  }

  func testUIKitSendButtonShowsTipAfterRestAndHidesOnPress() async throws {
    let root = UIViewController()
    let send = SendButton(type: .system)
    send.frame = CGRect(x: 100, y: 100, width: 40, height: 40)
    root.view.addSubview(send)
    let window = show(root)
    let tip = try XCTUnwrap(send.tip)

    tip.pointer(.began)
    XCTAssertNil(ShortcutTipBubble.visible, "dymek nie od razu: chwila spoczynku")
    try await waitUntil { ShortcutTipBubble.visible != nil }
    let bubble = try XCTUnwrap(ShortcutTipBubble.visible, "dymek po spoczynku kursora")
    XCTAssertEqual(bubble.label.text, "\(UICopy.send) (↩)")
    XCTAssertTrue(bubble.superview === window, "na wierzchu okna przycisku")
    XCTAssertGreaterThan(bubble.frame.minY, send.convert(send.bounds, to: window).maxY, "pod przyciskiem")
    XCTAssertTrue(bubble.accessibilityElementsHidden, "czytnik dymka nie widzi")
    XCTAssertFalse(bubble.isUserInteractionEnabled, "dymek nie łapie dotyku")
    XCTAssertNil(send.accessibilityHint, "podpowiedź czytnika bez glifu")

    // Tryb przycisku zmienia podpowiedź w dymku, który stoi.
    send.setMode(.stop(enabled: true))
    XCTAssertEqual(ShortcutTipBubble.visible?.label.text, "\(UICopy.stop) (Esc)")
    XCTAssertFalse(send.accessibilityHint?.contains("Esc") ?? false)

    send.sendActions(for: .touchDown)
    XCTAssertNil(ShortcutTipBubble.visible, "naciśnięcie chowa dymek")
    tip.pointer(.changed)
    try await Task.sleep(for: .seconds(ShortcutTipState.rest + 0.3))
    XCTAssertNil(ShortcutTipBubble.visible, "po kliknięciu bez dymka, dopóki kursor nie wyjdzie")
    tip.pointer(.ended)
  }

  func testSwiftUIButtonShowsTipAfterRestAndHidesOnExit() async throws {
    let host = UIHostingController(
      rootView: Button("N") {}
        .frame(width: 44, height: 44)
        .shortcutTip(UICopy.newSessionTitle, .newSession)
        .accessibilityIdentifier("tip.button"))
    let window = show(host)
    try await waitUntil { Self.anchor(in: host.view) != nil }
    let anchor = try XCTUnwrap(Self.anchor(in: host.view), "kotwica UIKit w tle przycisku SwiftUI")
    let controller = try XCTUnwrap(anchor.controller)
    XCTAssertFalse(anchor.isUserInteractionEnabled, "kotwica nie łapie dotyku")
    XCTAssertNil(anchor.accessibilityIdentifier, "identyfikator przycisku nie staje na kotwicy (drugi element w XCUITest)")

    controller.pointerMoved()
    XCTAssertNil(ShortcutTipBubble.visible)
    try await waitUntil { ShortcutTipBubble.visible != nil }
    let bubble = try XCTUnwrap(ShortcutTipBubble.visible, "dymek po spoczynku kursora")
    XCTAssertEqual(bubble.label.text, "\(UICopy.newSessionTitle) (⌘N)")
    XCTAssertTrue(bubble.superview === window)

    controller.pointerExited()
    XCTAssertNil(ShortcutTipBubble.visible, "wyjście kursora chowa dymek")
  }

  private static func anchor(in view: UIView) -> ShortcutTipAnchorView? {
    if let anchor = view as? ShortcutTipAnchorView { return anchor }
    for child in view.subviews {
      if let found = anchor(in: child) { return found }
    }
    return nil
  }
}
