#if os(iOS)
import CoreText
import Synchronization
import UIKit

// Text style sizes, metrics and UIKit fonts for both paths of the app's text size. The standard path (iPad, iPhone)
// is exactly the system's: `preferredFont`, `UIFontMetrics` and the scene's content size category do the scaling.
// The flat path is for a system that gives every text style one size at every category (the iPad app on a Mac):
// there the app scales by `TextStyleTable` and the category it is given (`TextScale.effective`). Owner: text size.

/// The two paths of text style scaling. Every function takes `flat` (default ``isFlat``) and a category, which only
/// the flat path reads; the standard path makes today's call with `traits` (`nil` = the call without traits).
///
/// UIKit callers pass `TextScale.shared.effective` as the category and the view's `traitCollection` as traits, and
/// set the font again when the model's `effective` changes (the flat path gets no trait change from the system):
///
///     label.font = TextStyleScaling.font(.footnote, category: TextScale.shared.effective, weight: .semibold,
///                                        traits: traitCollection)
///
/// A size derived from a style's base size (`preferredFont(…, compatibleWith: .large).pointSize + 1`, a heading at
/// 1.25 em) goes through ``font(_:relativeTo:category:traits:flat:)`` or ``scale(_:relativeTo:category:traits:flat:)``.
public enum TextStyleScaling {
  /// The system gives body text one size at Extra Small and at Extra Extra Extra Large. Measured once per process;
  /// it is `false` on an iPad and an iPhone. It does not check for a Mac, so the standard path comes back by itself
  /// if the system scales text styles there.
  public static let measuredFlat: Bool = {
    let small = UIFont.preferredFont(
      forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: .extraSmall))
    let large = UIFont.preferredFont(
      forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: .extraExtraExtraLarge))
    return small.pointSize == large.pointSize
  }()

  private static let injected = Mutex<Bool?>(nil)

  /// The path in use: ``measuredFlat`` or the value of a ``withFlat(_:_:)`` running now.
  public static var isFlat: Bool { injected.withLock { $0 } ?? measuredFlat }

  /// Runs `body` with ``isFlat`` forced to `flat`, for tests of live UIKit views on the simulator. The value is
  /// global for the scope, so only serial tests (XCTest) may use it; a test that suspends passes `flat:` instead.
  public static func withFlat<T>(_ flat: Bool, _ body: () throws -> T) rethrows -> T {
    let previous = injected.withLock { value in
      let previous = value
      value = flat
      return previous
    }
    defer { injected.withLock { $0 = previous } }
    return try body()
  }

  /// The traits of the size every table ratio starts from.
  static var largeTraits: UITraitCollection { UITraitCollection(preferredContentSizeCategory: .large) }

  /// `value` given at the default size (Large), at the text size: `UIFontMetrics.scaledValue(for:)` on the standard
  /// path; on the flat path the ratio of the style's size at `category` to its size at Large.
  public static func scale(
    _ value: CGFloat, relativeTo style: UIFont.TextStyle, category: TextSizeCategory,
    traits: UITraitCollection? = nil, flat: Bool = isFlat
  ) -> CGFloat {
    guard flat else {
      let metrics = UIFontMetrics(forTextStyle: style)
      guard let traits else { return metrics.scaledValue(for: value) }
      return metrics.scaledValue(for: value, compatibleWith: traits)
    }
    return value * TextStyleTable.size(style, category) / TextStyleTable.size(style, .large)
  }

  /// The font of `style`. Standard path: `preferredFont` without a weight or design, otherwise the style's size at
  /// Large with the weight (`monospacedSystemFont` for a monospaced design) scaled by `UIFontMetrics`, as `Fonts`
  /// does. Flat path: the style's descriptor (it keeps the style's leading, `systemFont(ofSize:)` does not) with the
  /// weight and design, at the table size. Tabular digits are a font feature on both paths.
  public static func font(
    _ style: UIFont.TextStyle, category: TextSizeCategory, weight: UIFont.Weight? = nil,
    design: UIFontDescriptor.SystemDesign = .default, monospacedDigit: Bool = false,
    traits: UITraitCollection? = nil, flat: Bool = isFlat
  ) -> UIFont {
    let font =
      flat
      ? flatFont(style, category: category, weight: weight, design: design)
      : standardFont(style, weight: weight, design: design, traits: traits)
    guard monospacedDigit else { return font }
    return UIFont(descriptor: font.fontDescriptor.addingAttributes(tabularDigits), size: font.pointSize)
  }

  /// `base`, a font given at the default size (Large), at the text size: `UIFontMetrics.scaledFont(for:)` on the
  /// standard path; on the flat path the same font at the size ``scale(_:relativeTo:category:traits:flat:)`` gives.
  public static func font(
    _ base: UIFont, relativeTo style: UIFont.TextStyle, category: TextSizeCategory,
    traits: UITraitCollection? = nil, flat: Bool = isFlat
  ) -> UIFont {
    guard flat else {
      let metrics = UIFontMetrics(forTextStyle: style)
      guard let traits else { return metrics.scaledFont(for: base) }
      return metrics.scaledFont(for: base, compatibleWith: traits)
    }
    let size = scale(base.pointSize, relativeTo: style, category: category, flat: true)
    return UIFont(descriptor: base.fontDescriptor, size: size)
  }

  private static func standardFont(
    _ style: UIFont.TextStyle, weight: UIFont.Weight?, design: UIFontDescriptor.SystemDesign,
    traits: UITraitCollection?
  ) -> UIFont {
    if weight == nil, design == .default {
      return UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
    }
    let reference = UIFont.preferredFont(forTextStyle: style, compatibleWith: largeTraits)
    let base: UIFont
    switch design {
    case .monospaced:
      base = UIFont.monospacedSystemFont(ofSize: reference.pointSize, weight: weight ?? .regular)
    default:
      var descriptor = reference.fontDescriptor
      if design != .default, let designed = descriptor.withDesign(design) { descriptor = designed }
      if let weight { descriptor = descriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]]) }
      base = UIFont(descriptor: descriptor, size: reference.pointSize)
    }
    let metrics = UIFontMetrics(forTextStyle: style)
    guard let traits else { return metrics.scaledFont(for: base) }
    return metrics.scaledFont(for: base, compatibleWith: traits)
  }

  private static func flatFont(
    _ style: UIFont.TextStyle, category: TextSizeCategory, weight: UIFont.Weight?,
    design: UIFontDescriptor.SystemDesign
  ) -> UIFont {
    var descriptor = UIFontDescriptor.preferredFontDescriptor(withTextStyle: style, compatibleWith: largeTraits)
    if design != .default, let designed = descriptor.withDesign(design) { descriptor = designed }
    if let weight { descriptor = descriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]]) }
    return UIFont(descriptor: descriptor, size: TextStyleTable.size(style, category))
  }

  private static var tabularDigits: [UIFontDescriptor.AttributeName: Any] {
    let feature: [UIFontDescriptor.FeatureKey: Int] = [.type: kNumberSpacingType, .selector: kMonospacedNumbersSelector]
    return [.featureSettings: [feature]]
  }
}
#endif
