#if os(iOS)
import SwiftUI

// Tło przyklejonej stopki. Właściciel: dostępność; używają stopka listy (limity planu)
// i stopka arkusza „Nowa sesja".

/// Stopka KRYJĄCA, nie szkło: treść przewijana pod materiałem `.bar` prześwitywała przez niego
/// i zbijała kontrast drobnego tekstu stopki poniżej AA — kolor
/// tekstu stopki zależał od tego, co akurat przejeżdżało pod spodem. Kreska u góry oddziela stopkę
/// od treści; przy zmniejszonej przezroczystości nie ma już czego zamieniać.
struct OpaqueBar: ViewModifier {
  /// Tło stopki: `surface` na ekranach apki; w formularzu systemowym — tło tego formularza (własny element
  /// bierze tło swojej prezentacji).
  var fill = Color(uiColor: Palette.surface)

  func body(content: Content) -> some View {
    content
      .background(fill)
      .overlay(alignment: .top) {
        Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1).accessibilityHidden(true)
      }
  }
}

extension View {
  func opaqueBar() -> some View { modifier(OpaqueBar()) }

  /// Stopka formularza systemowego: kryjące tło arkusza (szarość systemu) z kreską.
  func formFooterBar() -> some View { modifier(OpaqueBar(fill: Color(uiColor: .systemGroupedBackground))) }
}
#endif
