@testable import RarogUI
import UIKit
import XCTest

/// Pasek cytatu promptu nad transkryptem, w stylu dymku. Właściciel: sterowanie sesją.
@MainActor
final class PromptBarViewTests: XCTestCase {
  func testQuoteFontHeightAndTouchTarget() {
    let bar = PromptBarView(frame: .zero)
    bar.quote = "Krótki prompt"
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 200))
    window.addSubview(bar)
    window.isHidden = false
    defer { window.isHidden = true }
    bar.traitOverrides.preferredContentSizeCategory = .large
    let size = bar.systemLayoutSizeFitting(
      CGSize(width: 400, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    XCTAssertEqual(size.height, PromptBarView.visibleHeight, accuracy: 0.5, "pasek niższy o 2 × 3 pt")
    XCTAssertEqual(PromptBarView.quoteFont().pointSize, 14, accuracy: 0.01, "footnote + 1 pt")
    bar.frame = CGRect(origin: .zero, size: CGSize(width: 400, height: size.height))
    XCTAssertTrue(bar.point(inside: CGPoint(x: 100, y: -2), with: nil), "cel dotyku sięga 44 pt")
    XCTAssertTrue(bar.point(inside: CGPoint(x: 100, y: size.height + 2), with: nil))
    XCTAssertFalse(bar.point(inside: CGPoint(x: 100, y: -4), with: nil), "nie dalej niż 44 pt")
  }

  /// Wygląd dymku: pełne tło `userPlate` bez szkła i bez ramki, promień dymku; pod palcem `userPlatePressed`,
  /// też kryjące, i powrót po puszczeniu.
  func testPlateLookWithoutGlassOrBorder() {
    let bar = PromptBarView(frame: .zero)
    XCTAssertTrue(TranscriptLeadingTests.views(of: UIVisualEffectView.self, in: bar).isEmpty, "bez szkła")
    XCTAssertEqual(bar.layer.borderWidth, 0, "bez ramki")
    XCTAssertEqual(bar.layer.cornerRadius, Radius.block, "promień dymku")
    XCTAssertEqual(bar.backgroundColor, Palette.userPlate)
    bar.isHighlighted = true
    XCTAssertEqual(bar.backgroundColor, Palette.userPlatePressed, "pod palcem inne tło")
    bar.isHighlighted = false
    XCTAssertEqual(bar.backgroundColor, Palette.userPlate)
    for style in [UIUserInterfaceStyle.dark, .light] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      for color in [Palette.userPlate, Palette.userPlatePressed] {
        var alpha: CGFloat = 0
        color.resolvedColor(with: traits).getRed(nil, green: nil, blue: nil, alpha: &alpha)
        XCTAssertEqual(alpha, 1, "\(style.rawValue): tło kryjące")
      }
      XCTAssertNotEqual(
        TranscriptLeadingTests.hex(Palette.userPlate.resolvedColor(with: traits)),
        TranscriptLeadingTests.hex(Palette.userPlatePressed.resolvedColor(with: traits)), "\(style.rawValue): dotyk widać")
    }
  }

  /// Tekst cytatu na tle dymku ≥ 7:1 w obu motywach, także pod palcem; ikona (grafika) ≥ 4,5:1 w spoczynku i ≥ 3:1 pod
  /// palcem (WCAG 1.4.11).
  func testQuoteContrastOnPlate() throws {
    let bar = PromptBarView(frame: .zero)
    let label = try XCTUnwrap(TranscriptLeadingTests.views(of: UILabel.self, in: bar).first)
    let icon = try XCTUnwrap(TranscriptLeadingTests.views(of: UIImageView.self, in: bar).first)
    for style in [UIUserInterfaceStyle.dark, .light] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      for pressed in [false, true] {
        bar.isHighlighted = pressed
        let background = try XCTUnwrap(bar.backgroundColor).resolvedColor(with: traits)
        let text = Self.contrast(label.textColor.resolvedColor(with: traits), on: background)
        let mark = Self.contrast(icon.tintColor.resolvedColor(with: traits), on: background)
        XCTAssertGreaterThanOrEqual(text, 7, "\(style.rawValue) wciśnięty \(pressed): tekst \(text)")
        XCTAssertGreaterThanOrEqual(mark, pressed ? 3 : 4.5, "\(style.rawValue) wciśnięty \(pressed): ikona \(mark)")
      }
    }
  }

  /// Na ekranie sesji pasek stoi jak dymek: lewa krawędź 16 pt w linii z treścią transkryptu, szeroki jak cytat,
  /// a długi cytat najwyżej min(kolumna − 32 pt, 47,5 em) — z wielokropkiem; iPad w poziomie i wąskie okno, oba motywy
  /// (zrzuty w załącznikach i w katalogu `RAROG_SHOTS`).
  func testSessionBarSitsLikePlate() throws {
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    for (name, size) in [("ipad-poziomo", CGSize(width: 1_376, height: 1_032)), ("waskie", CGSize(width: 420, height: 912))] {
      for theme in [UIUserInterfaceStyle.dark, .light] {
        let (controller, window) = try TranscriptProseWidthTests.sessionScreen(size: size, theme: theme)
        defer { window.isHidden = true }
        let bar = try XCTUnwrap(controller.turnChrome.promptBar)
        XCTAssertFalse(bar.isHidden, "\(name): pasek po odjechaniu od dna")
        XCTAssertEqual(bar.backgroundColor, Palette.userPlate)
        let answer = try XCTUnwrap(TranscriptProseWidthTests.textViews(in: controller.collectionView).first {
          $0.accessibilityIdentifier == "message.m2.0"
        })
        let frame = bar.convert(bar.bounds, to: window)
        XCTAssertEqual(frame.minX, 16, accuracy: 0.5, "\(name): 16 pt od lewej")
        XCTAssertEqual(frame.minX, answer.convert(answer.bounds, to: window).minX, accuracy: 0.5, "\(name): w linii z treścią")
        let label = try XCTUnwrap(TranscriptLeadingTests.views(of: UILabel.self, in: bar).first)
        let icon = try XCTUnwrap(TranscriptLeadingTests.views(of: UIImageView.self, in: bar).first)
        let column = controller.view.safeAreaLayoutGuide.layoutFrame.width
        let cap = min(column - 32, MessageContentView.plateCap(bar.traitCollection, spacing: .standard))
        let content = icon.frame.width + 8 + label.intrinsicContentSize.width + 2 * PromptBarView.inset
        XCTAssertEqual(frame.width, min(content, cap), accuracy: 1, "\(name): szeroki jak cytat")
        TranscriptProseWidthTests.shoot(window, name: "pasek-\(name)-\(theme == .dark ? "ciemny" : "jasny")", test: self)

        bar.quote = String(repeating: "Bardzo długi prompt, który nie mieści się w jednej linii paska. ", count: 12)
        controller.view.layoutIfNeeded()
        let long = bar.convert(bar.bounds, to: window)
        XCTAssertEqual(long.width, cap, accuracy: 0.5, "\(name): długi cytat do sufitu \(cap)")
        XCTAssertEqual(long.minX, 16, accuracy: 0.5)
        XCTAssertLessThanOrEqual(long.maxX, controller.view.bounds.width - 16 + 0.5, "\(name): 16 pt od prawej")
        XCTAssertLessThan(label.bounds.width, label.intrinsicContentSize.width, "\(name): wielokropek")
      }
    }
  }

  /// Tap w pasek otwiera arkusz „Prompty w tej sesji” na pełnym tle `surface` — także pod strzałką popovera — zamiast
  /// systemowego szkła, które nad ciemnym transkryptem wychodzi szarą plamą. Zrzut daje tylko
  /// XCUITest (`FramesScreenshotUITests`, „prompty”): render warstwy okna testu popovera nie łapie.
  func testPromptListSheetIsSolid() throws {
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    for theme in [UIUserInterfaceStyle.dark, .light] {
      let (controller, window) = try TranscriptProseWidthTests.sessionScreen(size: CGSize(width: 1_376, height: 1_032), theme: theme)
      defer { window.isHidden = true }
      let bar = try XCTUnwrap(controller.turnChrome.promptBar)
      bar.sendActions(for: .touchUpInside)
      SessionToastTests.spin(0.8)
      let sheet = try XCTUnwrap(controller.presentedViewController, "arkusz otwarty")
      XCTAssertEqual(sheet.view.backgroundColor, PromptListView.background)
      XCTAssertEqual(sheet.popoverPresentationController?.backgroundColor, PromptListView.background, "tło pod strzałką")
      controller.dismiss(animated: false)
      SessionToastTests.spin(0.2)
    }
  }

  private static func contrast(_ ink: UIColor, on background: UIColor) -> Double {
    TranscriptDim.contrast(
      TranscriptDim.RGB(hex: TranscriptLeadingTests.hex(ink)), TranscriptDim.RGB(hex: TranscriptLeadingTests.hex(background)))
  }
}
