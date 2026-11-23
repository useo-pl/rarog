import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Kafel „zawsze” na karcie zgody (decyzja użytkownika z makiety): para „Zatwierdź”/„Odrzuć”
/// w jednym wierszu także przy długiej etykiecie na iPhonie, kafel `inner` w osobnym wierszu pod parą, od lewej,
/// szeroki na treść. Render prawdziwego `PermissionCardView` w ciemnym motywie, 390 pt z marginesem komórki
/// transkryptu (16 pt); położenie czytane z pikseli w kolorach tokenów. Przy `RAROG_CARD_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG. Właściciel: karty.
@MainActor
final class PermissionCardTileTests: XCTestCase {
  /// Ścieżka w postaci po skróceniu przez `AlwaysLabelParts`: kafel pokazuje ten sam tekst co przy pełnym
  /// katalogu tymczasowym macOS.
  static let readGrant =
    "Yes, allow reading from $TMPDIR/rarog-telefon-probe.NnFcpp from this project"
  static let short = "Yes, and don’t ask again for: cd *"
  static let margin: CGFloat = 16

  func testAlwaysTileSitsUnderThePairFromTheLeft() async throws {
    for (label, name) in [(Self.readGrant, "karta-zawsze-odczyt-ciemny"), (Self.short, "karta-zawsze-krotka-ciemny")] {
      let bitmap = try await Self.render(Self.card(always: label), name: name)
      let size = bitmap.size
      let allow = try XCTUnwrap(bitmap.box(of: PaletteTokens.run.dark), "\(name): „Zatwierdź” na zieleni pracy")
      // „Odrzuć” w wierszu „Zatwierdź”, na prawo od niego; pod parą czerwieni nie ma (eyebrow stoi nad parą).
      let row = CGRect(x: allow.maxX, y: allow.minY, width: size.width - allow.maxX, height: allow.height)
      XCTAssertNotNil(bitmap.box(of: PaletteTokens.err.dark, in: row), "\(name): „Odrzuć” w wierszu „Zatwierdź”")
      let below = CGRect(x: 0, y: allow.maxY + 1, width: size.width, height: size.height - allow.maxY - 1)
      XCTAssertNil(bitmap.box(of: PaletteTokens.err.dark, in: below), "\(name): „Odrzuć” nie spada pod parę")
      // Kafel: wypełnienie `surface2` pod parą. Bez pasa przy krawędzi karty: jej kreska na łuku rogu przechodzi
      // przez ten sam odcień, a pod kartą stoi 8 pt odstępu komórki.
      let inset = Self.margin + 6
      let inside = CGRect(
        x: inset, y: allow.maxY + 1, width: size.width - 2 * inset, height: size.height - allow.maxY - 1 - 8 - 6)
      let tile = try XCTUnwrap(
        bitmap.box(of: PaletteTokens.surface2.dark, in: inside, tolerance: 2), "\(name): kafel pod parą")
      XCTAssertGreaterThan(tile.minY, allow.maxY + 4, "\(name): kafel w osobnym wierszu")
      XCTAssertEqual(tile.minX, allow.minX, accuracy: 2, "\(name): kafel od lewej, jak „Zatwierdź”")
      if label == Self.short {
        XCTAssertLessThan(tile.maxX, size.width * 0.75, "\(name): kafel szeroki na treść, nie na całą kartę")
      }
    }
  }

  /// Ryzykowna karta z poleceniem i opcją „zawsze”, bez zegara (render bez upływu czasu). Nazwa narzędzia spoza
  /// listy strażnika źródeł (`SourceGuardTests`); przy `risky` i tak nie trafia do eyebrow.
  static let toolName = "Edit"

  static func card(always: String) -> PermissionCardModel {
    PermissionCardModel(
      permId: "p1", sessionId: "s1",
      eyebrow: UICopy.permissionEyebrow(toolName: toolName, risky: true, plan: false),
      toolName: toolName, risky: true, plan: false, cwd: "~/Projects/ACME/rarog",
      command: "ls -la /private/tmp/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/rarog-telefon-probe.NnFcpp",
      commandSyntax: [], createdAt: nil, canAllow: true, screen: nil, cliDialog: nil, phase: .idle, error: nil,
      lockedReason: nil, alwaysLabel: always, note: nil)
  }

  /// Karta w oknie sceny apki o szerokości iPhone'a, bez safe area, w ciemnym motywie — jak
  /// `PendingMediaRowTests.render`: rysuje warstwa, a gdy wyjdzie pusta, hierarchia widoków.
  static func render(_ card: PermissionCardModel, name: String) async throws -> PendingMediaRowTests.Bitmap {
    let width: CGFloat = 390
    let host = UIHostingController(
      rootView: PermissionCardView(card: card, decide: { _ in }).padding(.horizontal, margin))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    // Apka-gospodarz testów bywa bez podłączonej sceny (zmierzone na świeżym symulatorze): wtedy okno
    // bez sceny — warstwa rysuje się i tak, jak w `PendingMediaRowTests.render`.
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 1000)
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    // Blok komendy dostaje wysokość w drugim przebiegu (`onGeometryChange`); do tego czasu przewijanie bierze całe
    // okno, więc wysokość karty mierzy się dopiero po nim.
    try await Task.sleep(for: .milliseconds(150))
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
    if let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return try XCTUnwrap(PendingMediaRowTests.Bitmap(image), "\(name): bitmapa")
  }
}

extension PendingMediaRowTests.Bitmap {
  /// Prostokąt (w punktach) obejmujący piksele w kolorze `hex` (± `tolerance` na kanał) w kadrze; `nil` = żadnego.
  func box(of hex: UInt32, in frame: CGRect? = nil, tolerance: Int = 12) -> CGRect? {
    let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
    let scale = Double(width) / size.width
    let area = frame ?? CGRect(origin: .zero, size: size)
    let x0 = max(0, Int(area.minX * scale)), x1 = min(width, Int(area.maxX * scale))
    let y0 = max(0, Int(area.minY * scale)), y1 = min(height, Int(area.maxY * scale))
    guard x1 > x0, y1 > y0 else { return nil }
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in y0..<y1 {
      for x in x0..<x1 {
        let index = (y * width + x) * 4
        guard (0..<3).allSatisfy({ abs(Int(bytes[index + $0]) - target[$0]) <= tolerance }) else { continue }
        minX = min(minX, x)
        maxX = max(maxX, x)
        minY = min(minY, y)
        maxY = max(maxY, y)
      }
    }
    guard maxX >= 0 else { return nil }
    return CGRect(
      x: Double(minX) / scale, y: Double(minY) / scale,
      width: Double(maxX - minX + 1) / scale, height: Double(maxY - minY + 1) / scale)
  }
}
