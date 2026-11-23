#if os(iOS)
import SwiftUI
import UIKit

// The point size of each text style at each standard text size step, as iOS gives it. The iPad app on a Mac gets one
// size per style at every content size category, so the app computes the size itself from this table there
// (`TextStyleScaling`). `TextStyleTableTests` compares every cell with `UIFont.preferredFont(forTextStyle:
// compatibleWith:)` on the simulator. Owner: text size.

/// Eleven text styles × seven standard steps. The accessibility sizes give the largest standard step: the app's own
/// text size never sets one, and the flat path does not grow past Extra Extra Extra Large.
public enum TextStyleTable {
  /// The styles the table knows, largest first.
  public static let styles: [UIFont.TextStyle] = [
    .largeTitle, .title1, .title2, .title3, .headline, .body, .callout, .subheadline, .footnote, .caption1, .caption2,
  ]

  /// Sizes from Extra Small to Extra Extra Extra Large (`TextSizeCategory.steps`).
  private static let sizes: [UIFont.TextStyle: [CGFloat]] = [
    .largeTitle: [31, 32, 33, 34, 36, 38, 40],
    .title1: [25, 26, 27, 28, 30, 32, 34],
    .title2: [19, 20, 21, 22, 24, 26, 28],
    .title3: [17, 18, 19, 20, 22, 24, 26],
    .headline: [14, 15, 16, 17, 19, 21, 23],
    .body: [14, 15, 16, 17, 19, 21, 23],
    .callout: [13, 14, 15, 16, 18, 20, 22],
    .subheadline: [12, 13, 14, 15, 17, 19, 21],
    .footnote: [12, 12, 12, 13, 15, 17, 19],
    .caption1: [11, 11, 11, 12, 14, 16, 18],
    .caption2: [11, 11, 11, 11, 13, 15, 17],
  ]

  /// The point size of `style` at `category`; a style outside the table reads as body.
  public static func size(_ style: UIFont.TextStyle, _ category: TextSizeCategory) -> CGFloat {
    let row = sizes[style] ?? sizes[.body] ?? []
    let step = TextSizeCategory.steps.firstIndex(of: category) ?? TextSizeCategory.steps.count - 1
    return row[step]
  }
}

extension UIFont.TextStyle {
  /// The UIKit style of a SwiftUI text style (`Font.TextStyle.caption` is `caption1`).
  public init(_ style: Font.TextStyle) {
    switch style {
    case .largeTitle: self = .largeTitle
    case .title: self = .title1
    case .title2: self = .title2
    case .title3: self = .title3
    case .headline: self = .headline
    case .subheadline: self = .subheadline
    case .body: self = .body
    case .callout: self = .callout
    case .footnote: self = .footnote
    case .caption: self = .caption1
    case .caption2: self = .caption2
    @unknown default: self = .body
    }
  }
}

extension TextSizeCategory {
  /// The SwiftUI size of this category, for `.dynamicTypeSize(_:)`.
  public var dynamicTypeSize: DynamicTypeSize {
    switch self {
    case .extraSmall: .xSmall
    case .small: .small
    case .medium: .medium
    case .large: .large
    case .extraLarge: .xLarge
    case .extraExtraLarge: .xxLarge
    case .extraExtraExtraLarge: .xxxLarge
    case .accessibilityMedium: .accessibility1
    case .accessibilityLarge: .accessibility2
    case .accessibilityExtraLarge: .accessibility3
    case .accessibilityExtraExtraLarge: .accessibility4
    case .accessibilityExtraExtraExtraLarge: .accessibility5
    }
  }

  /// The category of a SwiftUI size, as views read it from `@Environment(\.dynamicTypeSize)`; an unknown one reads as
  /// Large.
  public init(_ size: DynamicTypeSize) {
    self = Self.allCases.first { $0.dynamicTypeSize == size } ?? .large
  }
}
#endif
