import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The "Relay registry" section of the "Server" screen (`SettingsSheet`) in a real store and
/// form: the section follows `AppState.relayAccess`, and the confirmed removal reaches the registry client once
/// through `RarogStore.forgetRelayRegistration()` (`ServerConnector.relayForget`). The rows come from the same function
/// the view draws from (`RelayRegistryContent.make`); the SwiftUI accessibility tree of this process is empty
/// (`SettingsSheetServerTests`). With `RAROG_RELAY_SNAPSHOT_DIR` (from the runner:
/// `TEST_RUNNER_RAROG_RELAY_SNAPSHOT_DIR`) the form is saved as `settings-relay.png` for visual review.
@MainActor
final class SettingsSheetRelayTests: XCTestCase {
  static let appId = "9f8e7d6c" + String(repeating: "0a1b2c3d", count: 7)

  /// Counts calls of the registry client's removal.
  @MainActor final class Calls { var count = 0 }

  func testSectionFollowsRelayAccess() async throws {
    let rig = try SettingsSheetServerTests.Rig()
    defer { rig.close() }
    rig.store.dispatch(.pairing(.bound(.device(PairedServer(
      SettingsSheetServerTests.credential(url: SettingsSheetServerTests.address, iroh: true))))))
    try await rig.settle()
    XCTAssertNil(RelayRegistryContent.make(rig.store.state.relayAccess), "inactive: no section")
    rig.store.relayAccessChanged(.registered(appId: Self.appId, until: Date().addingTimeInterval(86_400)))
    try await rig.settle()
    let content = try XCTUnwrap(RelayRegistryContent.make(rig.store.state.relayAccess))
    XCTAssertEqual(content.rows.map(\.text), ["To urządzenie: 9f8e7d6c", "Zarejestrowane"])
    XCTAssertEqual(content.rows.map(\.accessibilityLabel), ["To urządzenie: 9f8e7d6c", "Zarejestrowane"])
    XCTAssertTrue(content.canRemove)
    snapshot(rig, name: "settings-relay")
  }

  func testConfirmedRemovalCallsRegistryOnceAndKeepsItsStatus() async throws {
    let rig = try SettingsSheetServerTests.Rig()
    defer { rig.close() }
    rig.store.relayAccessChanged(.registered(appId: Self.appId, until: Date().addingTimeInterval(86_400)))
    let calls = Calls()
    // The rig's store has no connector (no server factories); the registry client's removal is the only route here.
    rig.store.serverRuntime.connector = ServerConnector(
      keychain: MemoryKeychain(), label: "test·Rarog", build: 1,
      transport: { _, _ in UIKitTransport() }, pairing: { _ in UIKitTransport() },
      relayForget: {
        calls.count += 1
        return .optedOut(appId: Self.appId, removal: .confirmed)
      })
    let removal = RelayRegistryRemoval()
    removal.ask()
    removal.cancel()
    XCTAssertEqual(calls.count, 0, "“Cancel” calls nothing")
    removal.ask()
    await removal.confirm { await rig.store.forgetRelayRegistration() }
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(rig.store.state.relayAccess, .optedOut(appId: Self.appId, removal: .confirmed))
    try await rig.settle()
    XCTAssertEqual(RelayRegistryContent.make(rig.store.state.relayAccess)?.canRemove, false,
                   "after the removal the button is gone")
  }

  // MARK: - Snapshot

  /// The form as an image, attached to the result and saved under `RAROG_RELAY_SNAPSHOT_DIR` when set. The layer
  /// renders first (`drawHierarchy` gives a blank frame without a foreground app, see `DecisionDockTests.snapshot`).
  private func snapshot(_ rig: SettingsSheetServerTests.Rig, name: String) {
    let view: UIView = rig.window
    view.layoutIfNeeded()
    let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
    let image = renderer.image { context in view.layer.render(in: context.cgContext) }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let dir = ProcessInfo.processInfo.environment["RAROG_RELAY_SNAPSHOT_DIR"], !dir.isEmpty,
      let data = image.pngData()
    else { return }
    try? data.write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }
}
