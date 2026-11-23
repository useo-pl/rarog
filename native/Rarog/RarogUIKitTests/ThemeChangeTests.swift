@testable import RarogUI
import UIKit
import XCTest

/// Kolory warstw po zmianie motywu, także po powrocie z tła. Właściciel: transkrypt, markdown.
@MainActor
final class ThemeChangeTests: XCTestCase {
  /// Kreski markdownu rysowane we fragmentach układu (kreska cytatu, linia pozioma) idą za motywem komórki
  /// także wtedy, gdy nikt nie poda jej nowej konfiguracji. Przy zejściu w tło iOS robi zrzuty przełącznika
  /// aplikacji w obu motywach; konfiguracja wpięta, gdy komórka miała jeszcze jasne cechy, zostawiałaby po
  /// powrocie kolory jasnego motywu (tło bloku kodu to widok pod tekstem — `CodeBlockTests`). Fragment układu trzyma
  /// kolory jako `CGColor`.
  func testQuoteBarFollowsThemeChange() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
    window.overrideUserInterfaceStyle = .light
    // Oczekiwania zakładają zwykły kontrast; symulator z „Zwiększ kontrast” dałby kolory wysokiego.
    window.traitOverrides.accessibilityContrast = .normal
    let root = UIViewController()
    window.rootViewController = root
    window.isHidden = false
    defer { window.isHidden = true }
    let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: root.traitCollection)
    let text = MarkdownCache().text("Akapit.\n\n> Cytat w odpowiedzi.\n", style: style)
    let config = MessageContentConfiguration(
      voice: "agent", text: text, plate: false, dimmed: false, accessibilityIdentifier: "message.m1.0",
      accessibilityPrefix: nil)
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    let light = Palette.border.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
    let dark = Palette.border.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
    XCTAssertEqual(try Self.quoteBars(in: view).map(Self.rgba), [Self.rgba(light.cgColor)], "jasny motyw")

    window.overrideUserInterfaceStyle = .dark
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    XCTAssertEqual(view.traitCollection.userInterfaceStyle, .dark, "komórka w ciemnym motywie")
    XCTAssertEqual(try Self.quoteBars(in: view).map(Self.rgba), [Self.rgba(dark.cgColor)], "po przełączeniu na ciemny")
  }

  /// „Zwiększ kontrast”: kreska, `muted2` i `done` rozwiązują się przy wysokim kontraście do innych,
  /// mocniejszych wartości; przy zwykłym — wartości zwykłe. Oczekiwane kolory to stałe (RGBA w sRGB).
  func testPaletteResolvesIncreasedContrast() {
    func resolved(_ color: UIColor, _ style: UIUserInterfaceStyle, _ contrast: UIAccessibilityContrast) -> String {
      let traits = UITraitCollection { traits in
        traits.userInterfaceStyle = style
        traits.accessibilityContrast = contrast
      }
      return Self.rgba(color.resolvedColor(with: traits).cgColor)
    }
    let cases: [(String, UIColor, normal: (dark: String, light: String), high: (dark: String, light: String))] = [
      ("border", Palette.border, ("FFFFFF14", "0000001A"), ("FFFFFF38", "00000040")),
      ("muted2", Palette.muted2, ("8E8E93FF", "6B6B73FF"), ("9E9EA3FF", "5A5A62FF")),
      ("done", Palette.done, ("71717AFF", "676770FF"), ("8E8E96FF", "55555DFF")),
    ]
    for (name, color, normal, high) in cases {
      XCTAssertEqual(resolved(color, .dark, .normal), normal.dark, "\(name), ciemny, zwykły kontrast")
      XCTAssertEqual(resolved(color, .light, .normal), normal.light, "\(name), jasny, zwykły kontrast")
      XCTAssertEqual(resolved(color, .dark, .high), high.dark, "\(name), ciemny, wysoki kontrast")
      XCTAssertEqual(resolved(color, .light, .high), high.light, "\(name), jasny, wysoki kontrast")
    }
  }

  /// Kreska cytatu (``MarkdownLayoutFragment``) i obrys listy podpowiedzi to `CGColor` warstwy: po włączeniu
  /// „Zwiększ kontrast” mają kolor wysokiego kontrastu bez nowej konfiguracji widoku.
  func testLayerColorsFollowContrastChange() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
    window.overrideUserInterfaceStyle = .dark
    // Start od zwykłego kontrastu niezależnie od ustawienia symulatora.
    window.traitOverrides.accessibilityContrast = .normal
    let root = UIViewController()
    window.rootViewController = root
    window.isHidden = false
    defer { window.isHidden = true }
    let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: root.traitCollection)
    let text = MarkdownCache().text("Akapit.\n\n> Cytat w odpowiedzi.\n", style: style)
    let config = MessageContentConfiguration(
      voice: "agent", text: text, plate: false, dimmed: false, accessibilityIdentifier: "message.m1.0",
      accessibilityPrefix: nil)
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
    root.view.addSubview(view)
    let suggestions = CommandSuggestionsView(frame: CGRect(x: 0, y: 300, width: 390, height: 80))
    root.view.addSubview(suggestions)
    window.layoutIfNeeded()
    XCTAssertEqual(try Self.quoteBars(in: view).map(Self.rgba), ["FFFFFF14"], "zwykły kontrast")
    XCTAssertEqual(suggestions.layer.borderColor.map(Self.rgba), "FFFFFF14", "obrys podpowiedzi, zwykły kontrast")

    window.traitOverrides.accessibilityContrast = .high
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    XCTAssertEqual(view.traitCollection.accessibilityContrast, .high, "komórka przy wysokim kontraście")
    XCTAssertEqual(try Self.quoteBars(in: view).map(Self.rgba), ["FFFFFF38"], "kreska cytatu po „Zwiększ kontrast”")
    XCTAssertEqual(suggestions.layer.borderColor.map(Self.rgba), "FFFFFF38", "obrys podpowiedzi po „Zwiększ kontrast”")
  }

  /// Kolory kreski cytatu we fragmentach układu tekstu komórki (bez powtórzeń).
  private static func quoteBars(in view: UIView) throws -> [CGColor] {
    func textView(_ view: UIView) -> UITextView? {
      if let text = view as? UITextView { return text }
      return view.subviews.lazy.compactMap(textView).first
    }
    let manager = try XCTUnwrap(textView(view)?.textLayoutManager)
    var bars: [CGColor] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      if let fragment = fragment as? MarkdownLayoutFragment, (fragment.decoration?.quoteDepth ?? 0) > 0,
        !bars.contains(where: { rgba($0) == rgba(fragment.colors.quoteBar) })
      {
        bars.append(fragment.colors.quoteBar)
      }
      return true
    }
    return bars
  }

  private static func rgba(_ color: CGColor) -> String {
    let srgb = color.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil) ?? color
    return (srgb.components ?? []).prefix(4).map { String(format: "%02X", Int(($0 * 255).rounded())) }.joined()
  }
}
