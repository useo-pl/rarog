@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Rama wiersza SwiftUI bez etykiet ról i ikona kopiowania bloku kodu pod wskaźnikiem.
/// Stopki „Kopiuj” pod odpowiedzią agenta nie ma. Właściciel: transkrypt.
@MainActor
final class RowFrameCopyTests: XCTestCase {
  /// Rama wiersza SwiftUI nie rysuje etykiety roli: wiersz z głosem i bez ma ten sam obraz treści, różni się tylko odstęp.
  func testRowFrameHasNoRoleLabel() throws {
    let plain = try XCTUnwrap(Self.render(RowFrame(voice: nil) { Color.white.frame(width: 50, height: 10) }.frame(width: 200)))
    let voiced = try XCTUnwrap(Self.render(RowFrame(voice: .assistant) { Color.white.frame(width: 50, height: 10) }.frame(width: 200)))
    // Zmiana głosu daje 12 pt nad wierszem zamiast 2 — i nic więcej: żadnego napisu nad treścią.
    XCTAssertEqual(voiced.height - plain.height, 10)
    let voicedInk = try XCTUnwrap(Self.difference(Self.blank(voiced), voiced))
    XCTAssertEqual(voicedInk.minY, 12, accuracy: 0.5, "pierwszy atrament to treść 12 pt niżej: \(voicedInk)")
  }

  /// Wskaźnik nad ikoną kopiowania bloku kodu w UIKit: ikona w pełnym tekście zamiast
  /// systemowej plamy wskaźnika; po zejściu wraca do `muted`, a ptaszek po skopiowaniu zostaje ptaszkiem.
  /// Symulator nie daje wskaźnika: stan podawany wprost (`RarogHoverTracker.set`).
  func testCopyIconLightsUnderPointerWithoutSystemEffect() throws {
    let traits = UITraitCollection(userInterfaceStyle: .dark)
    func ink(_ button: CopyIconButton) -> UIColor? { button.configuration?.baseForegroundColor?.resolvedColor(with: traits) }
    let button = CopyIconButton(textStyle: .caption1, hitSize: CGSize(width: 44, height: 30))
    XCTAssertFalse(button.isPointerInteractionEnabled, "bez systemowej plamy wskaźnika")
    XCTAssertEqual(ink(button), Palette.muted.resolvedColor(with: traits), "spoczynek")
    let hover = try XCTUnwrap(button.hover)
    hover.set(true)
    XCTAssertEqual(ink(button), Palette.text.resolvedColor(with: traits), "pod wskaźnikiem pełny tekst")
    hover.set(false)
    XCTAssertEqual(ink(button), Palette.muted.resolvedColor(with: traits), "po zejściu wraca")
    XCTAssertTrue(button.gestureRecognizers?.contains { $0 is UIHoverGestureRecognizer } ?? false, "gest wskaźnika")
  }

  // MARK: - Pomocnicze

  private typealias Bitmap = (width: Int, height: Int, bytes: [UInt8])

  private static func blank(_ like: Bitmap) -> Bitmap {
    var bytes = [UInt8](repeating: 0, count: like.width * like.height * 4)
    for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
    return (like.width, like.height, bytes)
  }

  /// Render SwiftUI w skali 1 (piksel = punkt) do bitmapy RGBA na czarnym tle.
  private static func render(_ view: some View) -> Bitmap? {
    let renderer = ImageRenderer(content: view.background(Color.black))
    renderer.scale = 1
    guard let image = renderer.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    return drawn ? (image.width, image.height, bytes) : nil
  }

  /// Prostokąt pikseli, którymi różnią się dwa rendery tej samej wielkości (`nil` = brak różnicy).
  private static func difference(_ a: Bitmap, _ b: Bitmap) -> CGRect? {
    guard a.width == b.width, a.height == b.height else { return nil }
    var box = CGRect.null
    for y in 0..<a.height {
      for x in 0..<a.width {
        let i = (y * a.width + x) * 4
        let delta = (0..<3).map { abs(Int(a.bytes[i + $0]) - Int(b.bytes[i + $0])) }.max() ?? 0
        if delta > 24 { box = box.union(CGRect(x: x, y: y, width: 1, height: 1)) }
      }
    }
    return box.isNull ? nil : box
  }
}
