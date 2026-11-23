#if os(iOS)
import RarogCore
import SwiftUI

// Notka „Nowe urządzenie: …”: trwały ślad parowania obok pushu `device-paired`, który
// jest best-effort. Stoi w pasie banerów listy, aż człowiek ją zamknie (przeżywa restart apki). Stan i odczyt listy
// urządzeń po każdym `hello`: `RarogStore+Pairing`.

/// Informacja o bezpieczeństwie, nie alarm: bursztynowa kropka (ktoś czeka na Twoją uwagę), zdanie i „×”.
struct NewDeviceBanner: View {
  let store: RarogStore
  let notice: NewDeviceNotice

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      Circle().fill(Color(uiColor: Palette.wait)).frame(width: 8, height: 8).accessibilityHidden(true)
      Text(UICopy.newDeviceNotice(notice, store.state.serverMachine))
        .appFont(.callout)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button {
        store.dismissDeviceNotice(notice.id)
      } label: {
        Label(UICopy.newDeviceDismiss, systemImage: "xmark")
      }
      .buttonStyle(HeaderIconButtonStyle())
      .accessibilityIdentifier("device.notice.dismiss")
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .padding(.vertical, 4)
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("device.notice")
  }
}
#endif
