@testable import RarogUI
import UIKit
import XCTest

/// The text style table and the UIKit half of the text scaling contract (`Theme/TextStyle/`). The bugs caught here:
/// a table cell that drifts from what iOS gives the style at that step (the Mac would draw other sizes than the
/// iPad), a standard path (`flat == false`) that is not exactly today's font or metric (the iPad would change), and
/// a flat path that loses the weight, the design, the tabular digits or the style's leading.
@MainActor
final class TextStyleTableTests: XCTestCase {
  static let styles: [UIFont.TextStyle] = [
    .largeTitle, .title1, .title2, .title3, .headline, .body, .callout, .subheadline, .footnote, .caption1, .caption2,
  ]
  static let weights: [UIFont.Weight] = [.regular, .medium, .semibold, .bold]

  static func traits(_ category: TextSizeCategory) -> UITraitCollection {
    UITraitCollection(preferredContentSizeCategory: category.contentSizeCategory)
  }

  static func preferred(_ style: UIFont.TextStyle, _ category: TextSizeCategory) -> UIFont {
    UIFont.preferredFont(forTextStyle: style, compatibleWith: traits(category))
  }

  // MARK: - Table

  func testEveryStandardCellEqualsTheSystemSize() {
    XCTAssertEqual(TextStyleTable.styles.count, Self.styles.count)
    for style in Self.styles {
      for category in TextSizeCategory.steps {
        XCTAssertEqual(
          TextStyleTable.size(style, category), Self.preferred(style, category).pointSize,
          "\(style.rawValue) at \(category)")
      }
    }
  }

  func testAccessibilitySizesGiveTheLargestStandardStep() {
    for style in Self.styles {
      for category in TextSizeCategory.allCases where category.isAccessibility {
        XCTAssertEqual(
          TextStyleTable.size(style, category), TextStyleTable.size(style, .extraExtraExtraLarge),
          "\(style.rawValue) at \(category)")
      }
    }
  }

  // MARK: - Flatness

  func testTheSimulatorIsNotFlatAndAnInjectionEndsWithItsScope() {
    XCTAssertFalse(TextStyleScaling.measuredFlat, "iOS gives body a size per category")
    XCTAssertFalse(TextStyleScaling.isFlat)
    let inside = TextStyleScaling.withFlat(true) { TextStyleScaling.isFlat }
    XCTAssertTrue(inside)
    XCTAssertFalse(TextStyleScaling.isFlat, "the injection ends with its scope")
  }

  // MARK: - Scale

  func testScaleOnTheStandardPathIsTodaysMetric() {
    for style in Self.styles {
      let metrics = UIFontMetrics(forTextStyle: style)
      for category in TextSizeCategory.allCases {
        for value in [CGFloat(1), 10, 14.5, 44] {
          XCTAssertEqual(
            TextStyleScaling.scale(value, relativeTo: style, category: .extraSmall, traits: Self.traits(category), flat: false),
            metrics.scaledValue(for: value, compatibleWith: Self.traits(category)),
            "\(style.rawValue), \(value) at \(category)")
        }
      }
      XCTAssertEqual(
        TextStyleScaling.scale(10, relativeTo: style, category: .extraSmall, flat: false), metrics.scaledValue(for: 10),
        "\(style.rawValue) without traits: the category is not used")
    }
  }

  func testScaleOnTheFlatPathTakesTheStyleFromItsLargeSizeToTheStep() {
    for style in Self.styles {
      let large = TextStyleTable.size(style, .large)
      for category in TextSizeCategory.allCases {
        XCTAssertEqual(
          TextStyleScaling.scale(large, relativeTo: style, category: category, flat: true),
          TextStyleTable.size(style, category), accuracy: 0.0001, "\(style.rawValue) at \(category)")
      }
      XCTAssertEqual(TextStyleScaling.scale(10, relativeTo: style, category: .large, flat: true), 10)
    }
    XCTAssertEqual(
      TextStyleScaling.scale(10, relativeTo: .body, category: .extraExtraExtraLarge, traits: Self.traits(.extraSmall), flat: true),
      10 * TextStyleTable.size(.body, .extraExtraExtraLarge) / TextStyleTable.size(.body, .large), accuracy: 0.0001, "traits do not matter on the flat path")
  }

  // MARK: - UIKit font, standard path

  func testFontOnTheStandardPathIsTodaysFont() {
    for style in Self.styles {
      for category in TextSizeCategory.allCases {
        let traits = Self.traits(category)
        XCTAssertEqual(
          TextStyleScaling.font(style, category: .extraSmall, traits: traits, flat: false),
          Self.preferred(style, category), "\(style.rawValue) at \(category)")
        for weight in Self.weights {
          XCTAssertEqual(
            TextStyleScaling.font(style, category: .extraSmall, weight: weight, traits: traits, flat: false),
            Fonts.text(style, weight: weight, traits: traits), "\(style.rawValue) \(weight) at \(category)")
          XCTAssertEqual(
            TextStyleScaling.font(style, category: .extraSmall, weight: weight, design: .monospaced, traits: traits, flat: false),
            Fonts.mono(style, weight: weight, traits: traits), "\(style.rawValue) mono \(weight) at \(category)")
        }
        XCTAssertEqual(
          TextStyleScaling.font(style, category: .extraSmall, design: .monospaced, traits: traits, flat: false),
          Fonts.mono(style, traits: traits), "\(style.rawValue) mono at \(category)")
        let base = UIFont.systemFont(ofSize: 15, weight: .medium)
        XCTAssertEqual(
          TextStyleScaling.font(base, relativeTo: style, category: .extraSmall, traits: traits, flat: false),
          UIFontMetrics(forTextStyle: style).scaledFont(for: base, compatibleWith: traits),
          "\(style.rawValue) from a base font at \(category)")
      }
      XCTAssertEqual(
        TextStyleScaling.font(style, category: .extraSmall, flat: false), UIFont.preferredFont(forTextStyle: style),
        "\(style.rawValue) without traits")
    }
  }

  // MARK: - UIKit font, flat path

  func testFontOnTheFlatPathHasTheTableSizeAtEveryStep() {
    for style in Self.styles {
      for category in TextSizeCategory.steps {
        let font = TextStyleScaling.font(style, category: category, traits: Self.traits(.extraSmall), flat: true)
        XCTAssertEqual(font.pointSize, TextStyleTable.size(style, category), "\(style.rawValue) at \(category)")
        let mono = TextStyleScaling.font(style, category: category, design: .monospaced, flat: true)
        XCTAssertEqual(mono.pointSize, TextStyleTable.size(style, category), "\(style.rawValue) mono at \(category)")
      }
    }
  }

  /// The style's descriptor keeps its line height; a font made from the size alone (`systemFont(ofSize:)`) does not.
  func testFontOnTheFlatPathKeepsTheStyleLineHeightAtLarge() {
    for style in Self.styles {
      let font = TextStyleScaling.font(style, category: .large, flat: true)
      XCTAssertEqual(font.lineHeight, Self.preferred(style, .large).lineHeight, accuracy: 0.01, style.rawValue)
      XCTAssertEqual(font.fontName, Self.preferred(style, .large).fontName, style.rawValue)
    }
  }

  func testFontOnTheFlatPathKeepsWeightDesignAndDigits() {
    for weight in Self.weights {
      let font = TextStyleScaling.font(.footnote, category: .extraLarge, weight: weight, flat: true)
      XCTAssertEqual(Self.weight(of: font), weight.rawValue, accuracy: 0.01, "\(weight)")
      let mono = TextStyleScaling.font(.footnote, category: .extraLarge, weight: weight, design: .monospaced, flat: true)
      XCTAssertTrue(Self.isMonospaced(mono), "mono \(weight): \(mono.fontName)")
      XCTAssertEqual(Self.weight(of: mono), weight.rawValue, accuracy: 0.01, "mono \(weight)")
    }
    let digits = TextStyleScaling.font(.caption1, category: .extraLarge, monospacedDigit: true, flat: true)
    XCTAssertEqual(Self.width("1111", digits), Self.width("8888", digits), accuracy: 0.01, "tabular digits")
    let proportional = TextStyleScaling.font(.caption1, category: .extraLarge, flat: true)
    XCTAssertLessThan(Self.width("1111", proportional), Self.width("8888", proportional), "the check can fail")
    XCTAssertFalse(Self.isMonospaced(proportional), "the check can fail")
  }

  func testFontFromABaseOnTheFlatPathScalesItsSize() {
    let base = UIFont.systemFont(ofSize: 14, weight: .semibold)
    let font = TextStyleScaling.font(base, relativeTo: .footnote, category: .extraExtraExtraLarge, flat: true)
    XCTAssertEqual(
      font.pointSize,
      14 * TextStyleTable.size(.footnote, .extraExtraExtraLarge) / TextStyleTable.size(.footnote, .large), accuracy: 0.0001)
    XCTAssertEqual(Self.weight(of: font), UIFont.Weight.semibold.rawValue, accuracy: 0.01)
  }

  // MARK: - Helpers

  static func weight(of font: UIFont) -> CGFloat {
    let traits = font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
    return (traits?[.weight] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0
  }

  static func width(_ text: String, _ font: UIFont) -> CGFloat {
    (text as NSString).size(withAttributes: [.font: font]).width
  }

  /// Every glyph has one advance (the `.monospaced` design does not set `traitMonoSpace`).
  static func isMonospaced(_ font: UIFont) -> Bool {
    abs(width("iiii", font) - width("MMMM", font)) < 0.01
  }
}
