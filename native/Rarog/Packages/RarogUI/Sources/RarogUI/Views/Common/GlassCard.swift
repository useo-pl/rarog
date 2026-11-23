#if os(iOS)
import UIKit

// Colors of the glass surfaces: the floating field card's layer, tint, solid fallback and shadow
// (`GlassSurfaceView`), and the list footer bar's blur layer (`ListFooter`). Every text on them keeps 4.5:1 over the
// column background and over the list scrolling beneath (`PaletteTokens+Glass`). Owner: list.

extension Palette {
  /// The layer over the glass: `glassCard` at `glassCardLayerDark` in the dark theme, none in the light one. Used by the
  /// UIKit `GlassSurfaceView` (field card).
  static let glassCardLayer = Palette.dynamic(
    dark: PaletteTokens.glassCard.dark, light: PaletteTokens.glassCard.light,
    darkAlpha: PaletteTokens.glassCardLayerDark, lightAlpha: 0)

  /// The glass tint: none in the dark theme, `glassCard` at `glassCardTintLight` in the light one.
  static let glassCardTint = Palette.dynamic(
    dark: PaletteTokens.glassCard.dark, light: PaletteTokens.glassCard.light,
    darkAlpha: 0, lightAlpha: PaletteTokens.glassCardTintLight)

  /// The glass card's edge: white at `glassCardEdgeAlpha`, the `border` line with Increase Contrast.
  static let glassCardEdge = UIColor { traits in
    if traits.accessibilityContrast == .high { return Palette.border.resolvedColor(with: traits) }
    let alpha = PaletteTokens.glassCardEdgeAlpha
    return UIColor(hex: 0xFFFFFF, alpha: CGFloat(traits.userInterfaceStyle == .light ? alpha.light : alpha.dark))
  }

  /// The full card background with Reduce Transparency.
  static let glassCardSolid = Palette.dynamic(PaletteTokens.glassCard)

  /// The floating cards' shadow color: black at `cardShadowDark` / `cardShadowLight`. The SwiftUI modifier here and
  /// `GlassSurfaceView`.
  static let cardShadow = Palette.dynamic(
    dark: 0x000000, light: 0x000000, darkAlpha: PaletteTokens.cardShadowDark, lightAlpha: PaletteTokens.cardShadowLight)

  /// The list footer bar's color (`ListFooter`): solid with Reduce Transparency, the `footerCardLayer` over its blur
  /// otherwise.
  static let footerCardSolid = Palette.dynamic(PaletteTokens.footerCardSolid)
  static let footerCardLayer = Palette.dynamic(
    dark: PaletteTokens.footerCardLayer.dark, light: PaletteTokens.footerCardLayer.light,
    darkAlpha: PaletteTokens.footerCardLayerDark, lightAlpha: PaletteTokens.footerCardLayerLight)
}
#endif
