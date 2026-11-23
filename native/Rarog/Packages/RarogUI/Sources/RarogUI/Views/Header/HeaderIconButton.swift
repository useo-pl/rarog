#if os(iOS)
import SwiftUI

// Przyciski-ikony w pasku nagłówka sesji („Terminal w oknie", zegar „Ostatnie sesje", „⋯" i „×" terminala, „×"),
// „Nowa sesja" w pasku listy i „×" banera powiadomień. Właściciel: nagłówek.

/// Cichy glif jak `.head-close` w PWA (`--muted-2`, pod palcem `--text`), cel dotyku 44 pt. Pasek narzędzi
/// iOS 26/27 rysuje `Label` i `Image` z `ToolbarItem` sam i pomija ich `.font` (zmierzone na iOS 27:
/// glify 17–25 pt mimo `.font(.body)`, a z `.footnote` bez zmian), dlatego przycisk ma własny styl: pasek
/// dostaje gotowy widok i nie przerysowuje glifu. Glif idzie za Dynamic Type do sufitu xxxLarge — jak systemowe
/// przyciski paska, które nie rosną bez końca; dalej przytrzymanie pokazuje podgląd dużej treści.
/// Skala glifu średnia: większa ikona bez powiększania przycisku — cel dotyku stoi bez zmian. Wskaźnik nad celem
/// 44 pt: glif w pełnym tekście, jak
/// `.icon-btn:hover` w PWA — bez systemowej szklanej plamy.
struct HeaderIconButtonStyle: ButtonStyle {
  /// Przełącznik włączony (prawy panel otwarty): glif w pełnym tekście na wypełnieniu `surface2`, jak wciśnięty
  /// przycisk paska.
  var selected = false
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .labelStyle(.iconOnly)
      // Jedno pismo i skala dla wszystkich: SF Symbols wyrównują wtedy optycznie wielkość glifów.
      .appFont(.subheadline)
      .imageScale(.medium)
      .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
      .frame(minWidth: HeaderMetrics.iconTarget, minHeight: HeaderMetrics.iconTarget)
      .background {
        if selected { RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)) }
      }
      .contentShape(Rectangle())
      .rarogHover(.ink(rest: configuration.isPressed || selected ? Palette.text : Palette.muted2), enabled: enabled)
      .accessibilityShowsLargeContentViewer()
  }
}
#endif
