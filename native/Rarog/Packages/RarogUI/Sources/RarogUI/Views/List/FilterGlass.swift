#if os(iOS)
import SwiftUI

// The material of the floating glass row over the session list (the filter capsule and the Inbox circle). Owner: list.

/// A glass surface in `shape`: the list footer card's material (system blur under `footerCardLayer`, near black and
/// translucent in the dark theme), the field card's light rim in the light theme, and a lighter share of the floating
/// cards' shadow (`filterGlassShadowShare`) drawn only outside the shape, so it never darkens what shows through. Reduce Transparency: the footer's solid
/// color. Increase Contrast: the `border` line as the rim in both themes.
struct FilterGlass<S: InsettableShape>: View {
  let shape: S
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.colorSchemeContrast) private var contrast

  var body: some View {
    ZStack {
      shadow
      if reduceTransparency {
        shape.fill(Color(uiColor: Palette.footerCardSolid))
      } else {
        shape.fill(.ultraThinMaterial)
        shape.fill(Color(uiColor: Palette.footerCardLayer))
      }
      if contrast == .increased {
        shape.stroke(Color(uiColor: Palette.border), lineWidth: 1)
      } else if colorScheme == .light {
        shape.strokeBorder(Color(uiColor: Palette.glassCardEdge), lineWidth: 1)
      }
    }
    .accessibilityHidden(true)
  }

  private var shadow: some View {
    shape.fill(Color.black)
      .shadow(color: Color(uiColor: Palette.filterGlassShadow), radius: PaletteTokens.cardShadowRadius, x: 0,
              y: PaletteTokens.cardShadowY)
      .mask {
        Rectangle().padding(-2 * PaletteTokens.cardShadowRadius)
          .overlay { shape.fill(Color.black).blendMode(.destinationOut) }
          .compositingGroup()
      }
  }
}

extension Palette {
  /// The glass row's shadow: black at `filterGlassShadowShare` of the floating cards' shadow opacity.
  static let filterGlassShadow = Palette.dynamic(
    dark: 0x000000, light: 0x000000,
    darkAlpha: PaletteTokens.cardShadowDark * PaletteTokens.filterGlassShadowShare,
    lightAlpha: PaletteTokens.cardShadowLight * PaletteTokens.filterGlassShadowShare)

  /// The plate under the active segment and the open Inbox on the glass.
  static let filterGlassPlate = Palette.dynamic(
    dark: PaletteTokens.filterGlassPlate.dark, light: PaletteTokens.filterGlassPlate.light,
    darkAlpha: PaletteTokens.filterGlassPlateAlpha.dark, lightAlpha: PaletteTokens.filterGlassPlateAlpha.light)
}
#endif
