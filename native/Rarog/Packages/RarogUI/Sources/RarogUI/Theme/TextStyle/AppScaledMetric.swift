#if os(iOS)
import SwiftUI
import UIKit

// A length that grows with the text size on both paths of `TextStyleScaling`: `ScaledMetric` on the standard path,
// the table ratio of its text style on the flat path (a Mac, where `ScaledMetric` stays put). Owner: text size.

/// `@ScaledMetric` for both paths, with the same spellings:
///
///     @ScaledMetric(relativeTo: .footnote) private var gap: CGFloat = 6
///         →  @AppScaledMetric(relativeTo: .footnote) private var gap: CGFloat = 6
///     _size = ScaledMetric(wrappedValue: size, relativeTo: .caption)
///         →  _size = AppScaledMetric(wrappedValue: size, relativeTo: .caption)
///
/// The category comes from the view's environment, so it follows a step on an open view and a local
/// `.dynamicTypeSize(...)` ceiling holds.
@propertyWrapper
public struct AppScaledMetric<Value: BinaryFloatingPoint>: DynamicProperty {
  @ScaledMetric private var system: Value
  @Environment(\.dynamicTypeSize) private var size
  @Environment(\.textStyleFlat) private var flat
  private let base: Value
  private let style: Font.TextStyle

  public init(wrappedValue: Value, relativeTo style: Font.TextStyle = .body) {
    base = wrappedValue
    self.style = style
    _system = ScaledMetric(wrappedValue: wrappedValue, relativeTo: style)
  }

  public var wrappedValue: Value {
    guard flat else { return system }
    let scaled = TextStyleScaling.scale(
      CGFloat(base), relativeTo: UIFont.TextStyle(style), category: TextSizeCategory(size), flat: true)
    return Value(scaled)
  }
}
#endif
