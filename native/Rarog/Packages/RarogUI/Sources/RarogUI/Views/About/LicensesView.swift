#if os(iOS)
import SwiftUI

/// Ustawienia → O apce → Licencje: noty cudzych składników z `THIRD-PARTY-NOTICES` w paczce apki, po angielsku jak
/// plik (`docs/localization.md`), pismem o stałej szerokości, bo plik ma podkreślenia z `=` i wcięcia. Akapity
/// w leniwej liście: cały plik w jednym `Text` układałby się przy każdym otwarciu od nowa.
struct LicensesView: View {
  let page: LicensesPage

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        ForEach(Array(page.blocks.enumerated()), id: \.offset) { index, block in
          Text(verbatim: block)
            .appFont(page.missing ? .body : .footnote.monospaced())
            .foregroundStyle(Color(uiColor: page.missing ? Palette.muted : Palette.text))
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .accessibilityIdentifier(index == 0 ? "about.licenses.head" : "about.licenses.block")
        }
      }
      .padding(16)
    }
    .background(Color(uiColor: Palette.background))
    .navigationTitle(UICopy.aboutLicensesTitle)
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("about.licenses")
  }
}
#endif
