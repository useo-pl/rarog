import RarogContract
import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The connection card waits for its moment (`Banner.connecting(visibleFrom:)`) and enters by itself, with no other
/// change of the store: the strip's own clock repaints it. An empty strip takes no height, so the strip's height
/// says whether the card stands.
@MainActor
final class BannerStackTests: XCTestCase {
  /// A view that reads the clock only when SwiftUI evaluates its body: the control that the measurement reads the last
  /// render and does not evaluate the body again.
  private struct FrozenClock: View {
    let due: Date
    var body: some View {
      if Date() >= due { Color.red.frame(height: 40) }
    }
  }

  private struct Rig<Content: View> {
    let host: UIHostingController<Content>
    let window: UIWindow

    var height: CGFloat {
      host.view.setNeedsLayout()
      host.view.layoutIfNeeded()
      return host.view.intrinsicContentSize.height
    }
  }

  private func rig<Content: View>(_ view: Content) -> Rig<Content> {
    let host = UIHostingController(rootView: view)
    host.sizingOptions = [.intrinsicContentSize]
    // A window in the app's scene: only an on-screen strip runs its clock, as in the app.
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let container = UIViewController()
    window.rootViewController = container
    window.isHidden = false
    let root = container.view!
    container.addChild(host)
    root.addSubview(host.view)
    host.didMove(toParent: container)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: root.topAnchor),
      host.view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
    ])
    window.layoutIfNeeded()
    return Rig(host: host, window: window)
  }

  private func spin(until moment: Date) {
    while Date() < moment { RunLoop.main.run(until: min(moment, Date().addingTimeInterval(0.02))) }
  }

  /// Polls until the strip has height or the deadline passes, without touching the input.
  private func waitForCard<Content: View>(_ rig: Rig<Content>, until deadline: Date) -> Bool {
    while Date() < deadline {
      if rig.height > 1 { return true }
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    return rig.height > 1
  }

  func testMeasurementReadsTheLastRender() {
    let start = Date()
    let rig = rig(FrozenClock(due: start.addingTimeInterval(0.3)))
    defer { rig.window.isHidden = true }
    spin(until: start.addingTimeInterval(0.6))
    XCTAssertEqual(rig.height, 0, accuracy: 0.5, "measuring does not evaluate the body again")
  }

  func testDueCardStands() {
    let rig = rig(BannerStack(banners: [.connecting(visibleFrom: Date().addingTimeInterval(-1))]))
    defer { rig.window.isHidden = true }
    XCTAssertTrue(waitForCard(rig, until: Date().addingTimeInterval(1)), "a card past its moment stands at once")
  }

  func testConnectingCardEntersAtItsMomentWithoutStoreChanges() {
    let start = Date()
    let rig = rig(BannerStack(banners: [.connecting(visibleFrom: start.addingTimeInterval(1))]))
    defer { rig.window.isHidden = true }
    spin(until: start.addingTimeInterval(0.6))
    XCTAssertEqual(rig.height, 0, accuracy: 0.5, "before its moment the card does not stand")
    spin(until: start.addingTimeInterval(1.2))
    XCTAssertGreaterThan(rig.height, 1, "at 1.2 s the strip's clock has brought the card in")
  }

  func testConnectionBeforeTheMomentKeepsTheCardOut() {
    let start = Date()
    let rig = rig(BannerStack(banners: [.connecting(visibleFrom: start.addingTimeInterval(1))]))
    defer { rig.window.isHidden = true }
    spin(until: start.addingTimeInterval(0.5))
    rig.host.rootView = BannerStack(banners: [])
    spin(until: start.addingTimeInterval(1.4))
    XCTAssertEqual(rig.height, 0, accuracy: 0.5, "connected before the moment: no card")
  }

  /// The global stream comes online while the session stream connects: the card's moment moves later, and the clock
  /// arms again for the new moment.
  func testLaterMomentRearmsTheClock() {
    let start = Date()
    let rig = rig(BannerStack(banners: [.connecting(visibleFrom: start.addingTimeInterval(1))]))
    defer { rig.window.isHidden = true }
    spin(until: start.addingTimeInterval(0.5))
    rig.host.rootView = BannerStack(banners: [.connecting(visibleFrom: start.addingTimeInterval(1.8))])
    spin(until: start.addingTimeInterval(1.4))
    XCTAssertEqual(rig.height, 0, accuracy: 0.5, "the old moment no longer counts")
    spin(until: start.addingTimeInterval(2))
    XCTAssertGreaterThan(rig.height, 1, "the card enters at the new moment")
  }
}
