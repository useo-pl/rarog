#if os(iOS)
import SwiftUI

/// Trzy linki produktu pod kontrolkami parowania: polityka prywatności, instrukcja serwera, wsparcie. Przed
/// sparowaniem Ustawień nie ma, więc to jedyne miejsce, w którym recenzent bez serwera je widzi. Stuknięcie otwiera
/// adres systemem (`Link` → `openURL`), czyli w przeglądarce domyślnej. Jeden pod drugim w każdym rozmiarze pisma,
/// każdy z celem dotyku 44 × 44 pt. Bez `ViewThatFits` (rząd, a gdy się nie mieści — kolumna): audyt
/// dostępności zgłaszał przy nim każdemu linkowi „Dynamic Type font sizes are partially unsupported”, a sam rząd
/// w powiększonym piśmie obcina tekst (pomiar wariantów: `AboutTests`, `productLinksRowLayout`).
struct ProductLinksRow: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(AboutLink.allCases) { link in
        Link(destination: link.url) {
          Text(UICopy.aboutLink(link))
            .underline()
            .fixedSize(horizontal: false, vertical: true)
            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityIdentifier("pairing.link.\(link.id)")
      }
    }
  }
}
#endif
