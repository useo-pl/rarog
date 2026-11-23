import Foundation

/// The material of the glass surfaces: the floating field card and the list footer bar. Pure numbers, tested on
/// macOS (`GlassCardContrastTests`); the colors are in `Views/Common/GlassCard.swift`.
/// Owner: list.
extension PaletteTokens {
  /// The card's color: the layer over the glass and the full background with Reduce Transparency.
  public static let glassCard = Pair(dark: 0x1F1F1F, light: 0xFFFFFF)

  /// Opacity of the `glassCard` layer over the untinted glass in the dark theme. A Liquid Glass tint darkens the
  /// glass in the dark theme instead of lightening it, so the card gets its tone from a layer of color
  /// over untinted glass. 0.75: over prose and code under the
  /// field `muted2` keeps 4.5:1 (`GlassCardContrastTests`).
  public static let glassCardLayerDark: Double = 0.75

  /// Opacity of the `glassCard` tint of the glass in the light theme (no layer).
  public static let glassCardTintLight: Double = 0.4

  /// The glass card's light edge (in place of the `border` line): white at these
  /// opacities, a rim of light like the system glass. Increase Contrast keeps the `border` line.
  public static let glassCardEdgeAlpha: (dark: Double, light: Double) = (0.22, 0.9)

  /// The list footer card is quieter than the message field card: the column `background` mixed over `glassCard` at
  /// these opacities, most of the way to the column (#111111 dark,
  /// #F7F7FA light). The footer only reads; the field is the one thing to act on. The card is this solid color, with
  /// no glass and no edge (the glass's rim would read as a frame).
  public static let footerShadeDark: Double = 0.69
  public static let footerShadeLight: Double = 0.65

  /// The layer over the footer card's blur (`ultraThinMaterial`, no rim): the list shows faintly under the card.
  /// Dark theme: black at 0.4, a darker card that lets the
  /// list show a little more. Light theme: `footerCardSolid` at 0.6; lower drops
  /// `muted2` under 4.5:1 over the list. Measured worst case under the card, list text beneath: `footerCardWorstDark`
  /// (measured at the dark layer's 0.5) / `footerCardWorstLight`.
  public static let footerCardLayer = Pair(dark: 0x000000, light: footerCardSolid.light)
  public static let footerCardLayerDark: Double = 0.4
  public static let footerCardLayerLight: Double = 0.6
  public static let footerCardWorstDark: UInt32 = 0x191919
  public static let footerCardWorstLight: UInt32 = 0xEFEFF1

  /// The floating cards' shadow, the list footer card and the message field card: delicate, black,
  /// drawn only outside the card so it never darkens what shows through the card. The dark theme needs a stronger
  /// opacity: the column is near black, so the shadow can only take it from `#0A0A0A` towards `#000000`.
  public static let cardShadowRadius: Double = 16
  public static let cardShadowY: Double = 4
  public static let cardShadowDark: Double = 0.9
  public static let cardShadowLight: Double = 0.16

  /// The quiet footer card's solid color: the layer's color, and the whole card with Reduce Transparency.
  public static let footerCardSolid = Pair(
    dark: over(background.dark, alpha: footerShadeDark, on: glassCard.dark),
    light: over(background.light, alpha: footerShadeLight, on: glassCard.light))
}
