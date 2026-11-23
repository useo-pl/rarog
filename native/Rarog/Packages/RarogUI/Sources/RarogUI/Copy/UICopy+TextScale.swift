import Foundation
import RarogContract

// The app's text size: the Settings row, the Text Size page, its steps, transcript width and spacing, and the menu
// commands of ⌘+, ⌘- and ⌘0. Owner: text size.
extension UICopy {
  public static var textSizeLabel: String { L("textSize.label") }
  public static var textSizeUseSystem: String { L("textSize.useSystem") }
  public static var textSizeBigger: String { L("textSize.bigger") }
  public static var textSizeSmaller: String { L("textSize.smaller") }
  public static var textSizeActualSize: String { L("textSize.actualSize") }
  /// The footer under the steps of the Text Size page.
  public static var textSizeStepsFooter: String { L("textSize.stepsFooter") }
  /// The header above the steps of the Text Size page.
  public static var textSizeStepsHeader: String { L("textSize.stepsHeader") }
  /// The footer under Use System Size on the Text Size page.
  public static var textSizeUseSystemFooter: String { L("textSize.useSystemFooter") }
  /// The transcript width section of the Text Size page: header, the two options and the footer.
  public static var textSizeWidthHeader: String { L("textSize.widthHeader") }
  public static var textSizeWidthFooter: String { L("textSize.widthFooter") }
  public static func textSizeWidth(_ mode: TranscriptWidthMode) -> String {
    switch mode {
    case .readable: L("textSize.widthReadable")
    case .full: L("textSize.widthFull")
    }
  }
  /// The transcript spacing section of the Text Size page: header, the two options and the footer.
  public static var textSizeSpacingHeader: String { L("textSize.spacingHeader") }
  public static var textSizeSpacingFooter: String { L("textSize.spacingFooter") }
  public static func textSizeSpacing(_ mode: TranscriptDensityMode) -> String {
    switch mode {
    case .standard: L("textSize.spacingStandard")
    case .relaxed: L("textSize.spacingRelaxed")
    }
  }

  /// The value of the Settings row when nothing is stored.
  public static func textSizeSystem(language: CopyLanguage = .current) -> String {
    L("textSize.system", language: language)
  }

  /// The name of a step in the Settings row. An accessibility size is never stored, so it shares the largest name.
  public static func textSizeStep(_ step: TextSizeCategory, language: CopyLanguage = .current) -> String {
    switch step {
    case .extraSmall: L("textSize.step.extraSmall", language: language)
    case .small: L("textSize.step.small", language: language)
    case .medium: L("textSize.step.medium", language: language)
    case .large: L("textSize.step.large", language: language)
    case .extraLarge: L("textSize.step.extraLarge", language: language)
    case .extraExtraLarge: L("textSize.step.extraExtraLarge", language: language)
    case .extraExtraExtraLarge, .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
      .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge:
      L("textSize.step.extraExtraExtraLarge", language: language)
    }
  }
}
