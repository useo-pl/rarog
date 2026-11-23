import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The Settings list and its pages in a real store and sheet (`SettingsSheet`): a page asked for from code replaces a
/// deeper page above another page and `nil` returns to the list (the stack of the sheet's navigation controller is
/// read, since the SwiftUI accessibility tree of this process is empty), and leaving the Pairing page revokes the code
/// while it is issuing and once it is shown, without breaking the next code; closing the sheet still revokes it and
/// cancels the pairing card, without a second revoke.
@MainActor
final class SettingsSheetNavigationTests: XCTestCase {
  /// Counts the pairing code calls; the first issue waits in `hold` until the test releases it.
  actor CodeCalls {
    private(set) var issues = 0
    private(set) var cancels = 0

    func issue() -> Int {
      issues += 1
      return issues
    }

    func cancel() { cancels += 1 }
  }

  func testCodeReplacesADeeperPageAndNilReturnsToTheList() async throws {
    let rig = try SettingsSheetServerTests.Rig(page: .about)
    defer { rig.close() }
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia", "O apce"])
    try await openLicenses(rig)
    XCTAssertEqual(rig.stack.count, 3, "Licenses above About: \(rig.stack)")
    rig.navigation.openSettings(page: .server)
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia", "Serwer"], "the asked page, not About under Licenses")
    XCTAssertEqual(rig.navigation.settingsPage, .server)
    try await openLicensesFromAbout(rig)
    rig.navigation.openSettings(page: nil)
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia"], "nil pops every page")
    XCTAssertNil(rig.navigation.settingsPage)
  }

  func testLeavingThePairingPageRevokesTheCodeWhileIssuingAndWhenShown() async throws {
    let (store, calls, hold) = try Self.pairedStore()
    let rig = try SettingsSheetServerTests.Rig(store: store, page: .pairing)
    defer { rig.close() }
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia", "Parowanie"])

    store.issuePairingCode()
    XCTAssertEqual(store.state.pairing.issue, .issuing)
    await until("the first POST waits") { await hold.requested == ["issue"] }
    rig.navigation.openSettings(page: nil)
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia"])
    XCTAssertEqual(store.state.pairing.issue, .idle, "leaving while issuing clears the code")
    await hold.release("issue")
    await until("the revoke after the POST answer") { await calls.cancels == 1 }

    rig.navigation.openSettings(page: .pairing)
    try await rig.settle()
    store.issuePairingCode()
    await until("a new code on screen") { if case .issued = store.state.pairing.issue { true } else { false } }
    rig.navigation.openSettings(page: nil)
    try await rig.settle()
    XCTAssertEqual(store.state.pairing.issue, .idle, "leaving with the code shown clears it")
    await until("the shown code revoked") { await calls.cancels == 2 }
    let issues = await calls.issues
    XCTAssertEqual(issues, 2)
  }

  func testClosingTheSheetOnThePairingPageRevokesOnceAndCancelsTheCard() async throws {
    let (store, calls, _) = try Self.pairedStore(holdFirst: false)
    let rig = try SettingsSheetServerTests.Rig(store: store, page: .pairing)
    defer { rig.close() }
    try await rig.settle()
    store.issuePairingCode()
    await until("a code on screen") { if case .issued = store.state.pairing.issue { true } else { false } }
    let link = PairingLink(target: .https(SettingsSheetServerTests.address), code: SettingsSheetServerTests.code)
    store.dispatch(.pairing(.offered(link)))
    XCTAssertTrue(store.state.pairing.flow.isActive)
    rig.host.rootView = AnyView(EmptyView())
    try await rig.settle()
    XCTAssertEqual(store.state.pairing.issue, .idle)
    XCTAssertEqual(store.state.pairing.flow, .idle, "closed Settings cancel the card")
    await until("the code revoked") { await calls.cancels >= 1 }
    try await Task.sleep(for: .milliseconds(300))
    let cancels = await calls.cancels
    XCTAssertEqual(cancels, 1, "the page and the sheet revoke once together")
  }

  /// The list with a relay that needs attention, then the Server page under it, at phone and iPad sheet widths in both
  /// themes. With `RAROG_SETTINGS_SNAPSHOT_DIR` (from the runner: `TEST_RUNNER_RAROG_SETTINGS_SNAPSHOT_DIR`) the eight
  /// images are saved there for visual review; they are attached to the result either way.
  func testListAndServerPageAtBothWidthsInBothThemes() async throws {
    let widths: [(name: String, size: CGSize, regular: Bool)] = [
      ("iphone", CGSize(width: 402, height: 874), false), ("ipad", CGSize(width: 580, height: 663), true),
    ]
    for width in widths {
      for style in [UIUserInterfaceStyle.light, .dark] {
        let rig = try SettingsSheetServerTests.Rig(page: nil)
        defer { rig.close() }
        rig.window.frame = CGRect(origin: .zero, size: width.size)
        rig.window.overrideUserInterfaceStyle = style
        if width.regular { rig.window.traitOverrides.horizontalSizeClass = .regular }
        rig.store.dispatch(.pairing(.bound(.device(PairedServer(
          SettingsSheetServerTests.credential(url: SettingsSheetServerTests.address, iroh: true))))))
        rig.store.relayAccessChanged(.problem(.clock, appId: SettingsSheetRelayTests.appId, retryAt: nil))
        try await rig.settle()
        rig.store.dispatch(.pairing(.devices([try SettingsSheetServerTests.device()])))
        try await rig.settle()
        XCTAssertEqual(rig.stack, ["Ustawienia"])
        let theme = style == .dark ? "dark" : "light"
        save(rig.image(), name: "settings-\(width.name)-\(theme)-list")
        rig.navigation.openSettings(page: .server)
        try await rig.settle()
        XCTAssertEqual(rig.stack, ["Ustawienia", "Serwer"])
        save(rig.image(), name: "settings-\(width.name)-\(theme)-server")
      }
    }
  }

  /// The Pairing page with an issued code, saved like the images above. The button layout follows the device (Share
  /// Link over New Code and Hide Code on a phone, one row on an iPad), so a run on a phone simulator shows the phone's.
  func testIssuedCodeOnThePairingPage() async throws {
    for (name, size) in [("iphone", CGSize(width: 402, height: 874))] {
      let (store, _, _) = try Self.pairedStore(holdFirst: false)
      let rig = try SettingsSheetServerTests.Rig(store: store, page: .pairing)
      defer { rig.close() }
      rig.window.frame = CGRect(origin: .zero, size: size)
      try await rig.settle()
      store.issuePairingCode()
      await until("a code on screen") { if case .issued = store.state.pairing.issue { true } else { false } }
      try await rig.settle()
      XCTAssertEqual(rig.stack, ["Ustawienia", "Parowanie"])
      save(rig.image(), name: "settings-\(name)-light-pairing")
    }
  }

  // MARK: - Helpers

  private func save(_ image: UIImage, name: String) {
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let dir = ProcessInfo.processInfo.environment["RAROG_SETTINGS_SNAPSHOT_DIR"], !dir.isEmpty,
      let data = image.pngData()
    else { return }
    try? data.write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }

  /// A logged-in store bound to a paired server whose transport issues and revokes codes; the first issue waits in the
  /// returned hold when `holdFirst`.
  static func pairedStore(holdFirst: Bool = true) throws -> (RarogStore, CodeCalls, CloseHold) {
    let calls = CodeCalls()
    let hold = CloseHold()
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let expires = format.string(from: Date().addingTimeInterval(300))
    let body = #"{"code":"BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ","expiresAt":"EXPIRES"}"#
    let issued = try JSONDecoder().decode(
      PairingIssued.self, from: Data(body.replacingOccurrences(of: "EXPIRES", with: expires).utf8))
    let transport = UIKitTransport(
      onIssuePairingCode: { () async throws(TransportError) -> PairingIssued in
        if await calls.issue() == 1, holdFirst { await hold.pause("issue") }
        return issued
      },
      onCancelPairingCode: { () async throws(TransportError) in await calls.cancel() })
    let store = RarogStore(
      transport: transport, rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    let credential = SettingsSheetServerTests.credential(url: SettingsSheetServerTests.address, iroh: false)
    store.serverRuntime.endpoint = .device(credential)
    store.dispatch(.pairing(.bound(.device(PairedServer(credential)))))
    return (store, calls, hold)
  }

  /// Pushes Licenses from the About page through the form's own selection (a tap the in-process tree cannot make).
  private func openLicenses(_ rig: SettingsSheetServerTests.Rig) async throws {
    let controller = try XCTUnwrap(SettingsSheetServerTests.Rig.navigationController(in: rig.host))
    let page = try XCTUnwrap(controller.topViewController)
    let list = try XCTUnwrap(DecisionDockTests.views(of: UICollectionView.self, in: page.view).first)
    let licenses = IndexPath(item: AboutLink.allCases.count + 1, section: 0)
    list.delegate?.collectionView?(list, didSelectItemAt: licenses)
    try await rig.settle()
  }

  /// About, then Licenses above it, from the Server page.
  private func openLicensesFromAbout(_ rig: SettingsSheetServerTests.Rig) async throws {
    rig.navigation.openSettings(page: .about)
    try await rig.settle()
    XCTAssertEqual(rig.stack, ["Ustawienia", "O apce"])
    try await openLicenses(rig)
    XCTAssertEqual(rig.stack.count, 3, "Licenses above About: \(rig.stack)")
  }

  private func until(_ what: String, _ condition: () async -> Bool) async {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("timed out: \(what)")
  }
}
