#if os(iOS)
import SwiftUI
import UIKit

// The app's SwiftUI font: a text style with a weight, a monospaced design and tabular digits, resolved for a text
// size category on either path of `TextStyleScaling`. On the standard path it is exactly the `Font` expression the
// views wrote before (`.caption.monospaced().weight(.medium)`), so the iPad draws the same text; on the flat path
// (a Mac) it is a font from the style's descriptor at the table size. Owner: text size.

/// A text style with its modifiers, written like the `Font` it replaces:
///
///     .font(.caption.monospaced().weight(.medium))   →   .appFont(.caption.monospaced().weight(.medium))
///     .font(mono ? .callout.monospaced() : .callout) →   .appFont(mono ? .callout.monospaced() : .callout)
///     static let glyphFont: Font = .footnote         →   static let glyphFont: AppFont = .footnote
///
/// `.appFont(_:)` reads the category and the path from the view's environment, so a local
/// `.dynamicTypeSize(...)` ceiling holds. Where no environment is at hand (a `Text` fragment joined into another
/// `Text`, an `AttributedString` built in a static function) the view reads `@Environment(\.dynamicTypeSize)` and
/// passes it down: `Text(x).appFont(.caption, typeSize)`, `piece.setAppFont(.caption, typeSize)`. View-level
/// `.fontWeight(_:)` and `.monospacedDigit()` keep working over a resolved font. A fixed size
/// (`.system(size: 15, weight: .medium)`) or a size from `@ScaledMetric` stays a `Font`; its size goes through
/// `@AppScaledMetric` or ``TextStyleScaling/scale(_:relativeTo:category:traits:flat:)``.
public struct AppFont: Hashable, Sendable {
  public let style: Font.TextStyle
  public private(set) var weight: Font.Weight?
  public private(set) var isMonospaced: Bool
  public private(set) var hasMonospacedDigits: Bool

  public init(
    _ style: Font.TextStyle, weight: Font.Weight? = nil, monospaced: Bool = false, monospacedDigit: Bool = false
  ) {
    self.style = style
    self.weight = weight
    isMonospaced = monospaced
    hasMonospacedDigits = monospacedDigit
  }

  public static let largeTitle = AppFont(.largeTitle)
  public static let title = AppFont(.title)
  public static let title2 = AppFont(.title2)
  public static let title3 = AppFont(.title3)
  public static let headline = AppFont(.headline)
  public static let subheadline = AppFont(.subheadline)
  public static let body = AppFont(.body)
  public static let callout = AppFont(.callout)
  public static let footnote = AppFont(.footnote)
  public static let caption = AppFont(.caption)
  public static let caption2 = AppFont(.caption2)

  /// The monospaced design (`Font.monospaced()`).
  public func monospaced() -> AppFont {
    var copy = self
    copy.isMonospaced = true
    return copy
  }

  /// Tabular digits (`Font.monospacedDigit()`).
  public func monospacedDigit() -> AppFont {
    var copy = self
    copy.hasMonospacedDigits = true
    return copy
  }

  /// A weight (`Font.weight(_:)`); an explicit `.regular` stays explicit, as it does in a `Font`.
  public func weight(_ weight: Font.Weight) -> AppFont {
    var copy = self
    copy.weight = weight
    return copy
  }

  /// The UIKit style of ``style``.
  public var uiStyle: UIFont.TextStyle { UIFont.TextStyle(style) }

  /// The font at `category`. Standard path: the `Font` expression, modifiers in the order the views write them
  /// (style, `monospaced()`, `monospacedDigit()`, `weight(_:)`), and the category is not used. Flat path:
  /// `Font(uiFont(category))`.
  public func resolve(_ category: TextSizeCategory, flat: Bool = TextStyleScaling.isFlat) -> Font {
    guard flat else { return standardFont }
    return Font(uiFont(category, flat: true) as CTFont)
  }

  /// The font at a SwiftUI size, as views read it from `@Environment(\.dynamicTypeSize)`.
  public func resolve(typeSize size: DynamicTypeSize, flat: Bool = TextStyleScaling.isFlat) -> Font {
    resolve(TextSizeCategory(size), flat: flat)
  }

  /// The UIKit font of the same style and modifiers (``TextStyleScaling/font(_:category:weight:design:monospacedDigit:traits:flat:)``).
  public func uiFont(
    _ category: TextSizeCategory, traits: UITraitCollection? = nil, flat: Bool = TextStyleScaling.isFlat
  ) -> UIFont {
    TextStyleScaling.font(
      uiStyle, category: category, weight: weight.map { UIFont.Weight($0) }, design: isMonospaced ? .monospaced : .default,
      monospacedDigit: hasMonospacedDigits, traits: traits, flat: flat)
  }

  private var standardFont: Font {
    var font = Self.font(style)
    if isMonospaced { font = font.monospaced() }
    if hasMonospacedDigits { font = font.monospacedDigit() }
    if let weight { font = font.weight(weight) }
    return font
  }

  private static func font(_ style: Font.TextStyle) -> Font {
    switch style {
    case .largeTitle: .largeTitle
    case .title: .title
    case .title2: .title2
    case .title3: .title3
    case .headline: .headline
    case .subheadline: .subheadline
    case .body: .body
    case .callout: .callout
    case .footnote: .footnote
    case .caption: .caption
    case .caption2: .caption2
    @unknown default: .body
    }
  }
}

extension UIFont.Weight {
  /// The UIKit weight of a SwiftUI weight; an unknown one reads as regular.
  public init(_ weight: Font.Weight) {
    switch weight {
    case .ultraLight: self = .ultraLight
    case .thin: self = .thin
    case .light: self = .light
    case .medium: self = .medium
    case .semibold: self = .semibold
    case .bold: self = .bold
    case .heavy: self = .heavy
    case .black: self = .black
    default: self = .regular
    }
  }
}

extension EnvironmentValues {
  /// The path of text style scaling the views below use; ``TextStyleScaling/isFlat`` unless a test sets it.
  public var textStyleFlat: Bool {
    get { self[TextStyleFlatKey.self] }
    set { self[TextStyleFlatKey.self] = newValue }
  }
}

private struct TextStyleFlatKey: EnvironmentKey {
  static var defaultValue: Bool { TextStyleScaling.isFlat }
}

private struct AppFontModifier: ViewModifier {
  let font: AppFont
  @Environment(\.dynamicTypeSize) private var size
  @Environment(\.textStyleFlat) private var flat

  func body(content: Content) -> some View {
    content.font(font.resolve(typeSize: size, flat: flat))
  }
}

extension View {
  /// `.font(_:)` with an ``AppFont`` resolved for the view's category and path.
  public func appFont(_ font: AppFont) -> some View {
    modifier(AppFontModifier(font: font))
  }
}

extension Text {
  /// A `Text` that stays a `Text` (for joining and interpolation), with the font resolved for `size`, the
  /// `@Environment(\.dynamicTypeSize)` of the view that builds it.
  public func appFont(_ font: AppFont, _ size: DynamicTypeSize, flat: Bool = TextStyleScaling.isFlat) -> Text {
    self.font(font.resolve(typeSize: size, flat: flat))
  }
}

extension AttributedString {
  /// Sets the SwiftUI font of the whole string, resolved for `size`, the `@Environment(\.dynamicTypeSize)` of the
  /// view that shows it.
  public mutating func setAppFont(_ font: AppFont, _ size: DynamicTypeSize, flat: Bool = TextStyleScaling.isFlat) {
    self.swiftUI.font = font.resolve(typeSize: size, flat: flat)
  }
}
#endif
