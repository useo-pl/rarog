import RarogContract
@testable import RarogCore
@testable import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Ekran „Serwer” (`SettingsSheet`) i karta „Sparować z …?” (`PairingFlowCard`) z trasą iroh:
/// serwer tylko przez iroh ma wiersz „iroh” z 8 znakami EndpointId zamiast adresu, serwer z adresem i parą iroh —
/// adres i wiersz iroh; para iroh, która dochodzi w miejscu (`routesUpdated`), dokłada wiersz bez zerowania kodu
/// parowania i listy urządzeń; link `k`+`r` ma tytuł ze skrótem iroh. Prawdziwy magazyn i formularz SwiftUI w oknie;
/// asercje czytają wiersze i tytuł z tych samych funkcji, z których rysuje widok (`ServerRouteRows`,
/// `PairingFlowCard.title`), bo drzewo dostępności SwiftUI w tym procesie testów jest puste (zmierzone: bez klienta
/// dostępności formularz nie wystawia węzłów). Zrzutu ten test nie robi:
/// render w procesie i ekran symulatora dają pustą klatkę (host testów nie jest na wierzchu, zmierzone). Sieć: adres
/// `rarog.invalid` nie odpowiada.
@MainActor
final class SettingsSheetServerTests: XCTestCase {
  static let endpointId = "1a2b3c4d" + String(repeating: "5e6f7a8b", count: 7)
  static let relay = URL(string: "https://euc1-1.relay.n0.iroh.link./")!
  static let address = URL(string: "https://rarog.example.ts.net")!
  static let code = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"

  func testIrohOnlyCredentialShowsIrohRowInsteadOfAddress() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.store.dispatch(.pairing(.bound(.device(PairedServer(Self.credential(url: nil, iroh: true))))))
    try await rig.settle()
    XCTAssertEqual(rig.routes, [ServerRouteRow(label: "iroh", value: "1a2b3c4d", identifier: "settings.iroh")])
  }

  func testOriginWithPairShowsAddressAndIrohRow() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.store.dispatch(.pairing(.bound(.device(PairedServer(Self.credential(url: Self.address, iroh: true))))))
    try await rig.settle()
    XCTAssertEqual(rig.routes.map(\.value), ["https://rarog.example.ts.net", "1a2b3c4d"])
    XCTAssertEqual(rig.routes.map(\.identifier), ["settings.address", "settings.iroh"])
  }

  /// The Pairing page open with a pairing code and the device list; the version probe adds the iroh pair in place.
  func testIrohPairArrivingInPlaceKeepsCodeAndDevices() async throws {
    let rig = try Rig(page: .pairing)
    defer { rig.close() }
    rig.store.dispatch(.pairing(.bound(.device(PairedServer(Self.credential(url: Self.address, iroh: false))))))
    let link = PairingLink(target: .https(Self.address), code: Self.code)
    let code = IssuedPairingCode(link: link, expiresAt: Date().addingTimeInterval(300))
    rig.store.dispatch(.pairing(.issued(code)))
    let devices = [try Self.device()]
    rig.store.dispatch(.pairing(.devices(devices)))
    try await rig.settle()
    XCTAssertEqual(rig.routes.map(\.identifier), ["settings.address"], "bez pary iroh nie ma wiersza iroh")
    rig.store.dispatch(.pairing(.routesUpdated(PairedServer(Self.credential(url: Self.address, iroh: true)))))
    try await rig.settle()
    XCTAssertEqual(rig.routes.map(\.value), ["https://rarog.example.ts.net", "1a2b3c4d"], "wiersz iroh dochodzi")
    XCTAssertEqual(rig.store.state.pairing.issue, .issued(code), "kod parowania zostaje na ekranie")
    XCTAssertEqual(rig.store.state.pairing.devices, devices, "lista urządzeń zostaje")
  }

  func testIrohLinkCardTitleNamesIrohShort() async throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.store.dispatch(.pairing(.bound(.device(PairedServer(Self.credential(url: Self.address, iroh: false))))))
    let iroh = try XCTUnwrap(ServerIrohConfig(validating: Self.endpointId, relay: Self.relay.absoluteString))
    rig.store.dispatch(.pairing(.offered(PairingLink(target: .iroh(iroh), code: Self.code))))
    try await rig.settle()
    XCTAssertEqual(PairingFlowCard.title(rig.store.state.pairing.flow), "Sparować z iroh · 1a2b3c4d?")
  }

  // MARK: - Pomocnicze

  static func credential(url: URL?, iroh: Bool) -> DeviceCredential {
    DeviceCredential(
      deviceId: "dev-1", secret: "s", serverURL: url, serverId: "srv-1", serverName: "studio", label: "iPhone·Rarog",
      kid: "k1", pairedAt: Date(timeIntervalSince1970: 1_762_000_000),
      iroh: iroh ? ServerIrohConfig(validating: endpointId, relay: relay.absoluteString) : nil)
  }

  static func device() throws -> DeviceInfo {
    let json = #"""
      {"id":"dev-1","label":"iPhone·Rarog","createdAt":"2026-11-01T10:00:00.000Z","lastSeenAt":null,
       "creator":"admin","build":null,"current":true}
      """#
    return try JSONDecoder().decode(DeviceInfo.self, from: Data(json.utf8))
  }

  /// The Settings sheet in an iPhone-sized window with a real store, opened through the navigation as the app opens
  /// it, on `page` (`nil` = the list). A test that needs routes passes its own store.
  @MainActor
  final class Rig {
    let store: RarogStore
    let navigation: RarogNavigation
    let host: UIHostingController<AnyView>
    let window: UIWindow

    init(store: RarogStore? = nil, page: SettingsPage? = .server) throws {
      let config = RarogConfig(baseURL: URL(string: "https://rarog.invalid")!, clientLabel: "test·Rarog", build: 1)
      self.store = store ?? RarogStore.live(
        config: config, outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
      let prefs = try XCTUnwrap(UserDefaults(suiteName: "settings-sheet-\(UUID().uuidString)"))
      navigation = RarogNavigation(prefs: prefs)
      navigation.openSettings(page: page)
      let request = try XCTUnwrap(navigation.settingsSheet)
      host = UIHostingController(
        rootView: AnyView(SettingsSheet(store: self.store, navigation: navigation, request: request)))
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
      window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
      window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
      window.rootViewController = host
      window.makeKeyAndVisible()
      host.view.layoutIfNeeded()
    }

    func close() { window.isHidden = true }

    /// The window as an image. The layer renders first (`drawHierarchy` gives a blank frame without a foreground app,
    /// see `DecisionDockTests.snapshot`).
    func image() -> UIImage {
      window.layoutIfNeeded()
      let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
      return renderer.image { context in window.layer.render(in: context.cgContext) }
    }

    /// The titles of the sheet's navigation stack, the list first.
    var stack: [String] {
      guard let controller = Self.navigationController(in: host) else { return [] }
      return controller.viewControllers.map { $0.navigationItem.title ?? "" }
    }

    static func navigationController(in controller: UIViewController) -> UINavigationController? {
      if let navigation = controller as? UINavigationController { return navigation }
      for child in controller.children {
        if let found = navigationController(in: child) { return found }
      }
      return nil
    }

    /// Wiersze tras, które ekran rysuje dla bieżącego stanu (ta sama funkcja co `SettingsSheet`).
    var routes: [ServerRouteRow] { ServerRouteRows.rows(store.state.pairing.binding) }

    /// Daje SwiftUI przerysować formularz po zmianie stanu (render biegnie na głównym aktorze).
    func settle() async throws {
      host.view.setNeedsLayout()
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(800))
      host.view.layoutIfNeeded()
    }
  }
}
