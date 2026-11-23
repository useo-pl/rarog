#if os(iOS)
import SwiftUI

// Label of a system `Menu` that picks one value. Used by: the Start section of the "New Session" sheet (model and
// effort).

/// Krótka wartość i znak menu na delikatnym wypełnieniu, rysunek 34 pt, cel dotyku 44 pt. Etykietę i wartość dla
/// czytnika daje `Menu`, które ją nosi.
struct MenuPill: View {
  let text: String

  var body: some View {
    HStack(spacing: 6) {
      Text(text).lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .appFont(.caption.weight(.semibold))
        .foregroundStyle(Color(uiColor: Palette.muted2))
    }
    .appFont(.subheadline)
    .foregroundStyle(Color(uiColor: Palette.text))
    .padding(.horizontal, 12)
    .frame(minHeight: 34)
    .background(Capsule().fill(Color(uiColor: Palette.text).opacity(HoverTokens.wash)))
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }
}
#endif
