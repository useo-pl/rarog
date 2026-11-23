@testable import RarogUI
import UIKit
import XCTest

/// `Fonts` on the standard path (iPad, iPhone) against a reference built here from raw UIKit calls, the way `Fonts`
/// built its fonts before it delegated to `TextStyleScaling`. The bug caught here: a font on iPad or iPhone that
/// differs from the one built before the text size contract (size, face or traits). The reference does not call
/// `Fonts` or `TextStyleScaling`, so a change in the shared helper cannot move both sides at once.
@MainActor
final class FontsStandardPathTests: XCTestCase {
  static let styles: [UIFont.TextStyle] = [
    .largeTitle, .title1, .title2, .title3, .headline, .body, .callout, .subheadline, .footnote, .caption1, .caption2,
  ]
  static let weights: [(name: String, weight: UIFont.Weight)] = [
    ("regular", .regular), ("medium", .medium), ("semibold", .semibold), ("bold", .bold),
  ]
  static let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityLarge]
  /// Every category above as traits, plus `nil`: the call without traits, which follows the process's category.
  static let traitCases: [(name: String, traits: UITraitCollection?)] =
    [("nil traits", nil)] + categories.map { ($0.rawValue, UITraitCollection(preferredContentSizeCategory: $0)) }
  static let values: [CGFloat] = [1, 10, 14.5, 44]

  // MARK: - Reference: the fonts as they were built from UIKit

  static let baseline = UITraitCollection(preferredContentSizeCategory: .large)

  static func referenceScaled(_ font: UIFont, style: UIFont.TextStyle, traits: UITraitCollection?) -> UIFont {
    let metrics = UIFontMetrics(forTextStyle: style)
    guard let traits else { return metrics.scaledFont(for: font) }
    return metrics.scaledFont(for: font, compatibleWith: traits)
  }

  static func referenceMono(_ style: UIFont.TextStyle, weight: UIFont.Weight, traits: UITraitCollection?) -> UIFont {
    let size = UIFont.preferredFont(forTextStyle: style, compatibleWith: baseline).pointSize
    return referenceScaled(UIFont.monospacedSystemFont(ofSize: size, weight: weight), style: style, traits: traits)
  }

  static func referenceText(_ style: UIFont.TextStyle, weight: UIFont.Weight?, traits: UITraitCollection?) -> UIFont {
    guard let weight else { return UIFont.preferredFont(forTextStyle: style, compatibleWith: traits) }
    let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: baseline)
    let descriptor = base.fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
    return referenceScaled(UIFont(descriptor: descriptor, size: base.pointSize), style: style, traits: traits)
  }

  static func referenceScaledValue(_ value: CGFloat, style: UIFont.TextStyle, traits: UITraitCollection?) -> CGFloat {
    let metrics = UIFontMetrics(forTextStyle: style)
    guard let traits else { return metrics.scaledValue(for: value) }
    return metrics.scaledValue(for: value, compatibleWith: traits)
  }

  // MARK: - Cases

  struct FontCase {
    let label: String
    let actual: UIFont
    let expected: UIFont
  }

  struct ValueCase {
    let label: String
    let actual: CGFloat
    let expected: CGFloat
  }

  static func fontCases() -> [FontCase] {
    var cases: [FontCase] = []
    for (name, traits) in traitCases {
      cases.append(
        FontCase(
          label: "eyebrow, \(name)", actual: Fonts.eyebrow(traits: traits),
          expected: referenceMono(.caption1, weight: .medium, traits: traits)))
      for style in styles {
        let at = "\(style.rawValue), \(name)"
        cases.append(
          FontCase(
            label: "text \(at)", actual: Fonts.text(style, traits: traits),
            expected: referenceText(style, weight: nil, traits: traits)))
        cases.append(
          FontCase(
            label: "mono \(at)", actual: Fonts.mono(style, traits: traits),
            expected: referenceMono(style, weight: .regular, traits: traits)))
        for (weightName, weight) in weights {
          cases.append(
            FontCase(
              label: "text \(weightName) \(at)", actual: Fonts.text(style, weight: weight, traits: traits),
              expected: referenceText(style, weight: weight, traits: traits)))
          cases.append(
            FontCase(
              label: "mono \(weightName) \(at)", actual: Fonts.mono(style, weight: weight, traits: traits),
              expected: referenceMono(style, weight: weight, traits: traits)))
        }
        // A face at the default size scaled by the style: what call sites did with `UIFontMetrics` directly.
        let face = UIFont.systemFont(ofSize: 15, weight: .medium)
        cases.append(
          FontCase(
            label: "scaled font \(at)", actual: Fonts.scaled(face, relativeTo: style, traits: traits),
            expected: referenceScaled(face, style: style, traits: traits)))
      }
    }
    return cases
  }

  static func valueCases() -> [ValueCase] {
    var cases: [ValueCase] = []
    for style in styles {
      // The style's size at Large, the base call sites read with `preferredFont(…, compatibleWith: .large)`.
      cases.append(
        ValueCase(
          label: "base \(style.rawValue)", actual: Fonts.base(style),
          expected: UIFont.preferredFont(forTextStyle: style, compatibleWith: baseline).pointSize))
      for (name, traits) in traitCases {
        for value in values {
          cases.append(
            ValueCase(
              label: "scaled value \(value) \(style.rawValue), \(name)",
              actual: Fonts.scaled(value, relativeTo: style, traits: traits),
              expected: referenceScaledValue(value, style: style, traits: traits)))
        }
      }
    }
    return cases
  }

  // MARK: - Tests

  func testEveryFontOnTheStandardPathIsTheFontUIKitBuiltBefore() {
    let cases = TextStyleScaling.withFlat(false) { Self.fontCases() }
    for item in cases {
      XCTAssertEqual(item.actual.pointSize, item.expected.pointSize, "pointSize: \(item.label)")
      XCTAssertEqual(item.actual.fontName, item.expected.fontName, "fontName: \(item.label)")
      XCTAssertEqual(
        item.actual.fontDescriptor.symbolicTraits, item.expected.fontDescriptor.symbolicTraits,
        "symbolicTraits: \(item.label)")
    }
  }

  func testEveryScaledValueOnTheStandardPathIsTheMetricUIKitGaveBefore() {
    let cases = TextStyleScaling.withFlat(false) { Self.valueCases() }
    for item in cases {
      XCTAssertEqual(item.actual, item.expected, item.label)
    }
  }
}
