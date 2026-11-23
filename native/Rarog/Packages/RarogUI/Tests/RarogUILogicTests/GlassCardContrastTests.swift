import Foundation
@testable import RarogUI
import Testing

// Contrast of the floating glass card's material: every ink on the list footer card keeps 4.5:1 on
// the solid card (Reduce Transparency) and on the dark card over the brightest glass measured under it.
// Owner: list.

@Suite("glass card: contrast of its inks")
struct GlassCardContrastTests {
  private typealias RGB = TranscriptDim.RGB

  /// Every ink the footer card uses (`FooterInk`): values, labels, quiet lines and the two threshold colors.
  private let inks: [(String, PaletteTokens.Pair)] = [
    ("text2", PaletteTokens.text2), ("muted", PaletteTokens.muted), ("muted2", PaletteTokens.muted2),
    ("muted2High", PaletteTokens.muted2High), ("wait", PaletteTokens.wait), ("err", PaletteTokens.err),
  ]

  /// The brightest untinted glass measured under the dark message field card, prose and a code block passing beneath
  /// (iPhone screenshots): card interior `#222222` at the layer's 0.9, worked back to the glass.
  private let brightestGlassUnderField: UInt32 = 0x3D3D3D
  /// The inks on the message field card (`ComposerView`): text, placeholder and labels, the error line.
  private let fieldInks: [(String, PaletteTokens.Pair)] = [
    ("text", PaletteTokens.text), ("muted", PaletteTokens.muted), ("muted2", PaletteTokens.muted2),
    ("err", PaletteTokens.err),
  ]

  private func ratio(_ ink: UInt32, on background: UInt32) -> Double {
    TranscriptDim.contrast(RGB(hex: ink), RGB(hex: background))
  }

  @Test("Reduce Transparency: every ink ≥ 4.5:1 on the solid card in both themes")
  func solidCard() {
    for (name, ink) in inks {
      #expect(ratio(ink.dark, on: PaletteTokens.glassCard.dark) >= 4.5, "\(name) dark")
      #expect(ratio(ink.light, on: PaletteTokens.glassCard.light) >= 4.5, "\(name) light")
    }
  }

  @Test("dark theme: the layer over the brightest glass measured under the field keeps every field ink ≥ 4.5:1")
  func darkLayerOverBrightGlass() {
    let card = PaletteTokens.over(
      PaletteTokens.glassCard.dark, alpha: PaletteTokens.glassCardLayerDark, on: brightestGlassUnderField)
    for (name, ink) in fieldInks {
      #expect(ratio(ink.dark, on: card) >= 4.5, "\(name) on #\(String(card, radix: 16))")
    }
  }

  @Test("quiet footer card: every ink ≥ 4.5:1 on its solid color in both themes")
  func quietFooterCard() throws {
    for (name, ink) in inks {
      #expect(ratio(ink.dark, on: PaletteTokens.footerCardSolid.dark) >= 4.5, "\(name) dark")
      #expect(ratio(ink.light, on: PaletteTokens.footerCardSolid.light) >= 4.5, "\(name) light")
      // Translucent card over list text: the measured worst backgrounds (iPad screenshots, rows under the card).
      #expect(ratio(ink.dark, on: PaletteTokens.footerCardWorstDark) >= 4.5, "\(name) dark over the list")
      #expect(ratio(ink.light, on: PaletteTokens.footerCardWorstLight) >= 4.5, "\(name) light over the list")
    }
    // Light: the layer at 0.6 or more; lower drops muted2 under 4.5:1 over the list (4.32 at 0.3).
    #expect(PaletteTokens.footerCardLayerLight >= 0.6)
    // No Liquid Glass: its rim read as a frame; a system blur instead.
    let footer = try SessionListSourceTests.code("Views/List/Footer/ListFooter.swift")
    #expect(footer.contains(".ultraThinMaterial") && !footer.contains("glassEffect"))
    // Quieter than the field card, still not the column itself.
    #expect(PaletteTokens.footerCardSolid.dark < PaletteTokens.glassCard.dark)
    #expect(PaletteTokens.footerCardSolid.dark != PaletteTokens.background.dark)
    #expect(PaletteTokens.footerCardSolid.light != PaletteTokens.background.light)
  }

  @Test("the field card casts a delicate shadow, only outside the card")
  func cardShadow() throws {
    #expect(PaletteTokens.cardShadowLight <= 0.2, "delicate in the light theme")
    #expect(PaletteTokens.cardShadowDark > PaletteTokens.cardShadowLight, "the near-black column needs more")
    // Outside only: under a translucent card a shadow would darken what shows through.
    let surface = try SessionListSourceTests.code("Views/Common/GlassSurfaceView.swift")
    #expect(surface.contains("fillRule = .evenOdd") && surface.contains("shadow.mask = shadowMask"))
    for file in ["Session/ComposerView.swift", "Session/FootActivityCard.swift"] {
      #expect(try SessionListSourceTests.code(file).contains("castsShadow: true"), "\(file)")
    }
  }

  @Test("the footer card is not a control: no button, popover or pointer effect on it; the update row keeps its sheet")
  func footerIsNotAControl() throws {
    let footer = try SessionListSourceTests.code("Views/List/Footer/ListFooter.swift")
    #expect(!footer.contains("RarogHoverReader") && !footer.contains("hovered"), "no pointer effect on the card")
    #expect(!footer.contains(".rarogHover("), "no wash plate on the card's rows")
    // A docked bar: edge to edge, no corners, no shadow, one hairline on top.
    #expect(footer.contains(".background { FooterBarSurface() }") && !footer.contains("RoundedRectangle"))
    #expect(!footer.contains("shadow") && footer.contains("Palette.border"))
    #expect(!footer.contains("accessibilityHint"), "no hint: nothing to activate")
    #expect(footer.contains(".accessibilityElement(children: .ignore)") && footer.contains(".isStaticText"))
    // The one button left is the server update row: the only place that shows the update command.
    #expect(footer.components(separatedBy: "Button {").count == 2, "one button: the update row")
    #expect(footer.contains("\"list.serverUpdate\""))
    #expect(footer.contains(".popover(isPresented: $sheetOpen"))
    let card = try SessionListSourceTests.code("Views/Common/GlassCard.swift")
    #expect(!card.contains("hover"), "the glass card has no pointer state")
  }

  @Test("the card stands out from the column background: lighter in the dark theme, white on the light one")
  func cardIsNotTheBackground() {
    #expect(PaletteTokens.glassCard.dark > PaletteTokens.background.dark)
    #expect(PaletteTokens.glassCard.light == 0xFFFFFF && PaletteTokens.background.light != 0xFFFFFF)
  }
}
