#if os(iOS)
import UIKit

// The terminal's font at the app's text size (⌘+, ⌘-, ⌘0; `Model/TextScale`). Owner: terminal.

extension TerminalFontSize {
  /// `base` at the app's text size: scaled like body text from the system's category to the effective one, in whole
  /// points, so the system's own category keeps `base` exactly. Neighbouring steps may round to the same point.
  /// `flat`: body text has one size at every category (a Mac), so the ratio comes from `TextStyleTable`.
  public static func points(
    _ base: CGFloat, effective: TextSizeCategory, system: TextSizeCategory, flat: Bool = TextStyleScaling.isFlat
  ) -> CGFloat {
    guard effective != system else { return base }
    return (base * body(effective, flat: flat) / body(system, flat: flat)).rounded()
  }

  /// Body text size at `category`. The category goes in explicitly: without traits `preferredFont` answers for the
  /// system's category, whatever the scene carries.
  private static func body(_ category: TextSizeCategory, flat: Bool) -> CGFloat {
    guard !flat else { return TextStyleTable.size(.body, category) }
    let traits = UITraitCollection(preferredContentSizeCategory: category.contentSizeCategory)
    return UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
  }

  /// `base` at the text size `scale` gives now; `nil` = `base`.
  @MainActor
  public static func points(_ base: CGFloat, scale: TextScale?, flat: Bool = TextStyleScaling.isFlat) -> CGFloat {
    guard let scale else { return base }
    return points(base, effective: scale.effective, system: scale.system, flat: flat)
  }
}
#endif
