#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Ślad własnej decyzji w transkrypcie. Właściciel: karty.

/// Cichy wiersz po decyzji z tego urządzenia: ikona wyniku i zdanie („Zatwierdzono: Bash · npm test”) wyciszonym
/// atramentem, krojem notki harnessu (`NoticeRowView`), bez przycisków i bez dymka — to nie wiadomość. Kolor nie
/// niesie wyniku (słowo go niesie), więc ikona stoi w `--muted-2` także przy odmowie: czerwień należy się porażce.
struct DecisionTraceRowView: View {
  let model: DecisionTraceRowModel

  var body: some View {
    RowFrame(voice: nil, gap: model.turn.gap) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: symbol)
          .imageScale(.small)
          .foregroundStyle(Color(uiColor: Palette.muted2))
          .accessibilityHidden(true)
        Text(verbatim: model.text)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
      }
      .appFont(.subheadline)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(model.text)
      .accessibilityIdentifier("transcript.\(model.id)")
    }
  }

  private var symbol: String {
    switch model.outcome {
    case .allowed: "checkmark"
    case .denied: "xmark"
    case .answered: "arrowshape.turn.up.left"
    }
  }
}
#endif
