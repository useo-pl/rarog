#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Notka harnessu w transkrypcie: jedno ciche zdanie systemowe zamiast surowego wpisu,
// który CLI wstrzyknął do rozmowy jako wiadomość roli `user`. Właściciel: notki i miniatury.

/// Linia notki: ikona (zębatka; trójkąt przy sierocie i niepowodzeniu, czerwony tylko przy
/// niepowodzeniu) i zdanie wyciszonym atramentem, krojem wiadomości systemowej. Bez dymka „ty" —
/// nikt tego nie napisał.
struct NoticeRowView: View {
  let model: HarnessNoticeModel

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: model.tone == .quiet ? "gearshape" : "exclamationmark.triangle")
          .imageScale(.small)
          // Kolor = stan: czerwień należy się wyłącznie niepowodzeniu.
          .foregroundStyle(Color(uiColor: model.tone == .failure ? Palette.err : Palette.muted2))
          .accessibilityHidden(true)
        Text(verbatim: model.text)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
      }
      .appFont(.subheadline)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(UICopy.harnessNoticeSpoken(model.text, tone: model.tone))
      .accessibilityIdentifier("harness.\(model.id)")
    }
  }
}
#endif
