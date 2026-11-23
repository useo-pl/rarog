import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Okres łaski przed kartą „dialog w terminalu” (`DecisionGraceTiming`): zastępnik bez przycisków
/// w widoku i render na terminie w kontrolerze sesji. Przy `RAROG_CARD_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG. Właściciel: karty.
@MainActor
final class DecisionPendingViewTests: XCTestCase {
  /// Zastępnik w ciemnym motywie, szerokość iPhone'a z marginesem komórki transkryptu: powierzchnia karty, bez
  /// przycisków (żadnej zieleni „Zatwierdź”, czerwieni „Odrzuć” ani wypełnienia neutralnego przycisku), wysokość
  /// karty w spoczynku.
  func testPlaceholderLooksLikeRestingCardWithoutButtons() async throws {
    let bitmap = try await Self.render(DecisionPendingView(), name: "zastepnik-karty-ciemny")
    XCTAssertNil(bitmap.box(of: PaletteTokens.run.dark), "bez „Zatwierdź”")
    XCTAssertNil(bitmap.box(of: PaletteTokens.err.dark), "bez „Odrzuć”")
    XCTAssertNil(ConsentCardViewTests.neutralBox(bitmap), "bez neutralnego przycisku")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.surface.dark, tolerance: 2), "powierzchnia karty")
    // Komórka = karta + 8 pt nad i pod nią.
    XCTAssertEqual(bitmap.size.height, DecisionPendingView.minHeight + 16, accuracy: 1)
  }

  /// Kontroler: przejście w „czeka” bez karty daje zastępnik, a kartę zapasową — sam termin, bez żadnej innej ramki.
  /// Z dokiem (tryb `.dock`) zastępnik stoi w doku w miejscu pola, a karta zapasowa staje w jego miejscu bez klatki
  /// z polem pomiędzy. W trybie domyślnym (`.transcript`, `DecisionDock.mode`) zastępnik i karta stoją w transkrypcie,
  /// a pola nie ma w żadnej klatce od „czeka” do karty. Test idzie w obu trybach.
  func testFallbackCardArrivesAtDeadlineWithoutAnotherFrame() async throws {
    for mode in [DecisionDock.Mode.transcript, .dock] {
      try await fallbackCardArrives(mode: mode)
    }
  }

  private func fallbackCardArrives(mode: DecisionDock.Mode) async throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0, decisionMode: mode)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    XCTAssertEqual(controller.decisionMode, mode)
    let since = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
    let json = #"{"type":"state","sessionId":"s1","state":"waiting-permission","since":"\#(since)"}"#
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    let entered = Date()
    let framesBefore = controller.footFrames.count
    fixture.store.dispatch(.frame(event, source: .global, cursor: nil))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertNil(controller.rows["dialog"], "\(mode): bez karty zapasowej w okresie łaski")
    XCTAssertTrue(controller.composer.isHidden, "\(mode): pole schowane pod zastępnikiem")
    if mode == .dock {
      XCTAssertEqual(controller.dockModel?.row, .decisionPending, "zastępnik w doku w okresie łaski")
      XCTAssertNil(controller.rows["decisionPending"], "zastępnika nie ma w transkrypcie")
      XCTAssertFalse(controller.decisionSlot.isHidden, "dok widoczny")
    } else {
      XCTAssertNotNil(controller.rows["decisionPending"], "zastępnik w transkrypcie w okresie łaski")
      XCTAssertNil(controller.dockModel, "bez doku")
      XCTAssertTrue(controller.decisionSlot.isHidden, "dok schowany")
    }
    let rendersBefore = controller.readingChrome.counters.renders

    let deadline = entered.addingTimeInterval(DecisionGraceTiming.window + 0.5)
    try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
    if mode == .dock {
      XCTAssertEqual(controller.dockModel?.row.id, "dialog", "karta zapasowa w doku na terminie")
      XCTAssertNil(controller.rows["dialog"])
    } else {
      XCTAssertNotNil(controller.rows["dialog"], "karta zapasowa w transkrypcie na terminie")
      XCTAssertNil(controller.dockModel)
    }
    let frames = controller.footFrames.suffix(from: min(framesBefore + 1, controller.footFrames.count))
    XCTAssertFalse(frames.isEmpty)
    XCTAssertFalse(frames.contains { $0.composer }, "\(mode): pole w żadnej klatce od „czeka” do karty: \(Array(frames))")
    XCTAssertNil(controller.rows["decisionPending"])
    XCTAssertNotEqual(controller.dockModel?.row, .decisionPending, "zastępnik zszedł z doku")
    XCTAssertGreaterThan(controller.readingChrome.counters.renders, rendersBefore, "\(mode): render z terminu")
  }

  /// Widok w oknie sceny apki o szerokości iPhone'a, bez safe area, w ciemnym motywie — jak
  /// `PermissionCardTileTests.render`.
  static func render(_ view: some View, name: String) async throws -> PendingMediaRowTests.Bitmap {
    let width: CGFloat = 390
    let host = UIHostingController(rootView: view.padding(.horizontal, 16))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 600)
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(150))
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 600))
    window.frame = CGRect(x: 0, y: 0, width: width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(100))
    host.view.layoutIfNeeded()
    let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
    var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
    }
    if let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return try XCTUnwrap(PendingMediaRowTests.Bitmap(image), "\(name): bitmapa")
  }
}
