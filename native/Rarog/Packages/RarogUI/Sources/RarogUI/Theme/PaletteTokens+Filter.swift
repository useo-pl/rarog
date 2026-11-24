import Foundation

/// The floating glass row over the session list: the filter capsule and the Inbox circle beside it. Their material
/// is the list footer card's (`footerCardLayer` over the system blur, `PaletteTokens+Glass.swift`), read, not copied;
/// the light theme adds the field card's light rim. Contrast over the list scrolling beneath: `PaletteContrastTests`.
/// Owner: list.
extension PaletteTokens {
  /// The active segment's and the open Inbox's plate on the glass: white in both themes, faint over the dark glass
  /// and nearly opaque over the light one, like the selected segment of a system segmented control. A gray plate
  /// over the light glass put `wait` under 4.5:1.
  public static let filterGlassPlate = Pair(dark: 0xFFFFFF, light: 0xFFFFFF)
  /// The plate's opacity in each theme.
  public static let filterGlassPlateAlpha: (dark: Double, light: Double) = (0.10, 0.85)
  /// The glass row's shadow: the floating cards' shadow (`cardShadowDark`, `cardShadowLight`) at this share of its
  /// opacity. The full card shadow drew a heavy halo around the capsule on the near-black column.
  public static let filterGlassShadowShare: Double = 0.5
  /// The Inbox badge: amber like Needs You, because the Inbox counts the cards that wait for the human or carry
  /// an unread result.
  public static let inboxBadge = wait
  /// The digit on the badge: ≥ 4.5:1 on `inboxBadge` in both themes.
  public static let inboxBadgeInk = Pair(dark: 0x0A0A0A, light: 0xFFFFFF)
}
