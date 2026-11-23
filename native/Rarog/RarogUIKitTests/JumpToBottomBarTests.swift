@testable import RarogUI
import UIKit
import XCTest

/// Kółko „Przewiń na dół".
/// Właściciel: transkrypt.
@MainActor
final class JumpToBottomBarTests: XCTestCase {
  /// Strzałka w kółku bez napisu: rama kwadratowa 36 pt, cel dotyku 44 × 44 pt, nazwę niosą czytnik i duży
  /// podgląd.
  func testJumpBarIsArrowInCircleWithoutTitle() {
    let bar = JumpToBottomBar(frame: .zero, reduceTransparency: { false })
    XCTAssertNil(bar.configuration?.title, "bez napisu")
    XCTAssertNotNil(bar.configuration?.image, "strzałka")
    XCTAssertEqual(bar.intrinsicContentSize, CGSize(width: 36, height: 36), "rama kwadratowa 36 pt")
    XCTAssertEqual(bar.configuration?.cornerStyle, .capsule, "kwadrat z rogami kapsuły = kółko")
    XCTAssertEqual(bar.accessibilityLabel, "Przewiń na dół")
    XCTAssertEqual(bar.largeContentTitle, "Przewiń na dół")
    XCTAssertTrue(bar.showsLargeContentViewer)
    XCTAssertTrue(bar.interactions.contains { $0 is UILargeContentViewerInteraction }, "duży podgląd przy dużym piśmie")

    // Cel dotyku: 4 pt wokół kółka w obu osiach, dalej już nie.
    bar.frame = CGRect(x: 0, y: 0, width: 36, height: 36)
    for inside in [CGPoint(x: -3.5, y: 18), CGPoint(x: 39.5, y: 18), CGPoint(x: 18, y: -3.5), CGPoint(x: 18, y: 39.5)] {
      XCTAssertTrue(bar.point(inside: inside, with: nil), "cel 44 × 44: \(inside)")
    }
    for outside in [CGPoint(x: -4.5, y: 18), CGPoint(x: 40.5, y: 18), CGPoint(x: 18, y: -4.5), CGPoint(x: 18, y: 40.5)] {
      XCTAssertFalse(bar.point(inside: outside, with: nil), "poza celem: \(outside)")
    }

    // Decyzja poza dokiem: inna nazwa, a oko widzi tylko kolor glifu i obrysu.
    bar.setDecision(true)
    XCTAssertNil(bar.configuration?.title, "przy decyzji też bez napisu")
    XCTAssertEqual(bar.accessibilityLabel, "Przewiń do decyzji")
    XCTAssertEqual(bar.largeContentTitle, "Przewiń do decyzji")
    XCTAssertEqual(bar.intrinsicContentSize, CGSize(width: 36, height: 36), "decyzja nie zmienia ramy")
    for style in [UIUserInterfaceStyle.dark, .light] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      let wait = Palette.wait.resolvedColor(with: traits)
      XCTAssertEqual(bar.configuration?.baseForegroundColor?.resolvedColor(with: traits), wait, "glif w `wait`")
      XCTAssertEqual(bar.configuration?.background.strokeColor?.resolvedColor(with: traits), wait, "obrys w `wait`")
    }
    bar.setDecision(false)
    XCTAssertEqual(bar.accessibilityLabel, "Przewiń na dół")
    for style in [UIUserInterfaceStyle.dark, .light] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      XCTAssertEqual(
        bar.configuration?.baseForegroundColor?.resolvedColor(with: traits), Palette.text.resolvedColor(with: traits))
      XCTAssertEqual(
        bar.configuration?.background.strokeColor?.resolvedColor(with: traits), Palette.border.resolvedColor(with: traits))
    }
  }

  /// Tło kapsuły nigdy nie jest odcieniem widoku. `nil` w tle konfiguracji przycisku znaczy „kolor
  /// odcienia" (`resolvedBackgroundColor(for:)`), a korzeń apki ustawia odcień na kolor tekstu
  /// — z odcieniem w tle pasek na iPhonie w ciemnym motywie byłby całkiem biały.
  func testJumpBarBackgroundIsNeverTheTint() {
    for reduced in [false, true] {
      for decision in [false, true] {
        let bar = JumpToBottomBar(frame: .zero, reduceTransparency: { reduced })
        bar.setDecision(decision)
        for style in [UIUserInterfaceStyle.dark, .light] {
          let traits = UITraitCollection(userInterfaceStyle: style)
          let tint = Palette.text.resolvedColor(with: traits)
          let background = bar.configuration?.background.resolvedBackgroundColor(for: tint).resolvedColor(with: traits)
          XCTAssertNotEqual(background, tint, "reduced=\(reduced) decision=\(decision) \(style): tło kapsuły = odcień")
          XCTAssertNotEqual(background, Palette.text.resolvedColor(with: traits), "tło w kolorze napisu")
        }
      }
    }
  }

  /// Strzałka czytelna na kółku w obu motywach (grafika, ≥ 3:1): przy zmniejszonej przezroczystości tło pełne
  /// (`surface`), w szkle półprzezroczyste `surface2` jak `--snack-bg` w PWA. Kontrast liczony
  /// do samego wypełnienia — rozmycie pod nim w ciemnym motywie przyciemnia, w jasnym rozjaśnia.
  func testJumpBarInkReadsOnItsCapsuleInBothThemes() {
    for reduced in [false, true] {
      for decision in [false, true] {
        let bar = JumpToBottomBar(frame: .zero, reduceTransparency: { reduced })
        bar.setDecision(decision)
        XCTAssertEqual(bar.configuration?.background.visualEffect == nil, reduced, "szkło tylko bez zmniejszonej przezroczystości")
        for style in [UIUserInterfaceStyle.dark, .light] {
          let traits = UITraitCollection(userInterfaceStyle: style)
          let ink = (bar.configuration?.baseForegroundColor ?? .clear).resolvedColor(with: traits)
          let fill = (bar.configuration?.background.backgroundColor ?? .clear).resolvedColor(with: traits)
          let base = Palette.background.resolvedColor(with: traits)
          let ratio = Self.contrast(ink, Self.composite(fill, over: base))
          XCTAssertGreaterThanOrEqual(ratio, 3, "reduced=\(reduced) decision=\(decision) \(style): \(ratio)")
        }
      }
    }
  }

  /// Pigułka „N nowych wiadomości" (wariant F) stoi na materiale kółka „na dół": to samo wypełnienie, szkło
  /// i kreska, w spoczynku i pod palcem, także przy zmniejszonej przezroczystości; napis i strzałka w błękicie `new`
  /// czytelne (≥ 4,5:1) do wypełnienia w obu motywach. Wysokość zostaje ta sprzed kółka: własne stałe pigułki, nie
  /// odstępy kółka.
  func testNewPillWearsJumpBarMaterialWithBlueInk() {
    for reduced in [false, true] {
      let bar = JumpToBottomBar(frame: .zero, reduceTransparency: { reduced })
      let pill = NewMessagesPill(frame: .zero, reduceTransparency: { reduced })
      pill.setCount(7)
      XCTAssertEqual(pill.configuration?.title, "7 nowych wiadomości")
      XCTAssertEqual(pill.configuration?.background.visualEffect == nil, reduced, "szkło tylko bez zmniejszonej przezroczystości")
      XCTAssertEqual(pill.configuration?.background.strokeWidth, bar.configuration?.background.strokeWidth)
      let insets = pill.configuration?.contentInsets
      XCTAssertEqual(insets?.top, 7, "wysokość sprzed kółka")
      XCTAssertEqual(insets?.bottom, 7, "wysokość sprzed kółka")
      XCTAssertEqual(insets?.leading, 14)
      // Z prawej miejsce na kreskę i „×”.
      XCTAssertEqual(insets?.trailing, 8 + 1 + NewMessagesPill.closeWidth)
      XCTAssertEqual(pill.layer.shadowRadius, bar.layer.shadowRadius)
      for pressed in [false, true] {
        pill.isHighlighted = pressed
        bar.isHighlighted = pressed
        pill.updateConfiguration()
        bar.updateConfiguration()
        for style in [UIUserInterfaceStyle.dark, .light] {
          let traits = UITraitCollection(userInterfaceStyle: style)
          let fill = (pill.configuration?.background.backgroundColor ?? .clear).resolvedColor(with: traits)
          XCTAssertEqual(fill, bar.configuration?.background.backgroundColor?.resolvedColor(with: traits),
            "reduced=\(reduced) pressed=\(pressed) \(style): wypełnienie jak pasek")
          let ink = (pill.configuration?.baseForegroundColor ?? .clear).resolvedColor(with: traits)
          XCTAssertEqual(ink, Palette.new.resolvedColor(with: traits))
          let ratio = Self.contrast(ink, Self.composite(fill, over: Palette.background.resolvedColor(with: traits)))
          XCTAssertGreaterThanOrEqual(ratio, 4.5, "reduced=\(reduced) pressed=\(pressed) \(style): \(ratio)")
        }
      }
    }
  }

  static func composite(_ top: UIColor, over bottom: UIColor) -> UIColor {
    var (tr, tg, tb, ta): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    var (br, bg, bb, ba): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    top.getRed(&tr, green: &tg, blue: &tb, alpha: &ta)
    bottom.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
    return UIColor(red: tr * ta + br * (1 - ta), green: tg * ta + bg * (1 - ta), blue: tb * ta + bb * (1 - ta), alpha: 1)
  }

  static func contrast(_ a: UIColor, _ b: UIColor) -> Double {
    func luminance(_ color: UIColor) -> Double {
      var (r, g, b, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
      color.getRed(&r, green: &g, blue: &b, alpha: &alpha)
      func channel(_ value: CGFloat) -> Double {
        let v = Double(value)
        return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }
}
