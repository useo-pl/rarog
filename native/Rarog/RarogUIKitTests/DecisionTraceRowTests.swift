import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Ślad własnej decyzji w transkrypcie: render prawdziwego `DecisionTraceRowView` w ciemnym motywie,
/// 390 pt z marginesem komórki transkryptu (16 pt). Cichy wiersz: ikona w `--muted-2` po lewej, zdanie w `--muted`,
/// bez czerwieni także przy odmowie, jedna linia przy krótkim zdaniu, zawinięcie przy długim. Przy
/// `RAROG_CARD_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG trzech wierszy.
/// Właściciel: karty.
@MainActor
final class DecisionTraceRowTests: XCTestCase {
  static let margin: CGFloat = 16

  static func row(_ outcome: DecisionTrace.Outcome, command: String = "npm test", answers: [[String]] = []) -> DecisionTraceRowModel {
    DecisionTraceRowModel(DecisionTrace(
      cardId: "c-\(outcome)", outcome: outcome, toolName: outcome == .answered ? nil : "Edit", plan: false,
      command: outcome == .answered ? nil : command, answers: answers, afterSeq: 1, at: Date()))
  }

  func testQuietRowIconLeftOfMutedTextWithoutRed() async throws {
    let rows = [
      Self.row(.allowed), Self.row(.denied), Self.row(.answered, answers: [["Postgres"], ["PWA", "Swift"]]),
    ]
    _ = try await Self.render(
      VStack(spacing: 0) { ForEach(rows, id: \.id) { DecisionTraceRowView(model: $0) } }, name: "slad-decyzji-ciemny")
    var single: CGFloat = 0
    for model in rows {
      let bitmap = try await Self.render(DecisionTraceRowView(model: model), name: nil)
      let text = try XCTUnwrap(bitmap.box(of: PaletteTokens.muted.dark, tolerance: 6), "\(model.text): zdanie w muted")
      let icon = try XCTUnwrap(
        bitmap.box(of: PaletteTokens.muted2.dark, in: CGRect(x: 0, y: 0, width: text.minX, height: bitmap.size.height),
          tolerance: 6),
        "\(model.text): ikona w muted-2 na lewo od zdania")
      XCTAssertGreaterThanOrEqual(icon.minX, Self.margin - 1, "\(model.text): ikona od marginesu komórki")
      XCTAssertNil(bitmap.box(of: PaletteTokens.err.dark), "\(model.text): bez czerwieni, wynik niesie słowo")
      XCTAssertLessThan(bitmap.size.height, 40, "\(model.text): jedna linia")
      single = max(single, bitmap.size.height)
    }
    // Długa własna odpowiedź jest skrócona w modelu, ale na wąskim ekranie i dużym piśmie zdanie się zawija.
    let long = Self.row(.answered, answers: [[String(repeating: "długa odpowiedź ", count: 3)], ["PWA", "Swift"]])
    let wrapped = try await Self.render(DecisionTraceRowView(model: long), name: nil)
    XCTAssertGreaterThan(wrapped.size.height, single + 8, "długie zdanie zawija się zamiast uciekać za krawędź")
    let text = try XCTUnwrap(wrapped.box(of: PaletteTokens.muted.dark, tolerance: 6))
    XCTAssertLessThanOrEqual(text.maxX, wrapped.size.width - Self.margin + 1, "zdanie w marginesie komórki")
  }

  /// Widok w oknie sceny apki o szerokości iPhone'a, bez safe area, w ciemnym motywie — jak
  /// `PermissionCardTileTests.render`.
  static func render(_ view: some View, name: String?) async throws -> PendingMediaRowTests.Bitmap {
    let width: CGFloat = 390
    let host = UIHostingController(rootView: view.padding(.horizontal, margin))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 1000)
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(100))
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 1000))
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
    if let name, let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return try XCTUnwrap(PendingMediaRowTests.Bitmap(image), "bitmapa")
  }
}
