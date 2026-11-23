#if os(iOS)
import SwiftUI

// The app's text size for SwiftUI views on the flat path (a Mac, where every text style has one size): the views'
// category comes from the model (`TextScale.effective`), not from the scene, and text without a font gets the body
// font of that category. On the standard path (iPad, iPhone) the scene's override already moves every view, and
// the modifier adds nothing. Owner: text size.

private struct TextScaleHost: ViewModifier {
  let scale: TextScale
  @Environment(\.textStyleFlat) private var flat

  func body(content: Content) -> some View {
    if flat {
      content
        .appDefaultFont()
        .dynamicTypeSize(scale.effective.dynamicTypeSize)
    } else {
      content
    }
  }
}

private struct AppDefaultFont: ViewModifier {
  @Environment(\.dynamicTypeSize) private var size
  @Environment(\.textStyleFlat) private var flat

  func body(content: Content) -> some View {
    if flat {
      content.environment(\.font, AppFont.body.resolve(typeSize: size, flat: true))
    } else {
      content
    }
  }
}

extension View {
  /// Puts the model's text size on the views below: on the flat path `.dynamicTypeSize(scale.effective)` and the
  /// body font as the default font, on the standard path nothing. Every root of SwiftUI views needs it: the app's
  /// root (`RarogRootView`), the app's sheet (`SheetHost`) and the root view of each `UIHostingController` or
  /// `UIHostingConfiguration` inside UIKit; a root view whose type must stay the controller's root type
  /// (`UsageSheet`) puts it in its own body. A local `.dynamicTypeSize(...)` ceiling below it holds for
  /// `.appFont(_:)` and `@AppScaledMetric`; text without a font under such a ceiling needs ``appDefaultFont()``
  /// after the ceiling.
  public func textScaleHost(_ scale: TextScale = .shared) -> some View {
    modifier(TextScaleHost(scale: scale))
  }

  /// On the flat path, the body font of the view's category as the default font of the views below; on the
  /// standard path nothing.
  public func appDefaultFont() -> some View {
    modifier(AppDefaultFont())
  }
}
#endif
