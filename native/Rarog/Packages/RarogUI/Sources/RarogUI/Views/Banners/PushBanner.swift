#if os(iOS)
import RarogCore
import SwiftUI

// Baner „Włącz powiadomienia na tym urządzeniu". Właściciel: push. Kiedy stoi:
// `pushPromptVisible(in:global:now:)` w `Model/BannerSlots`; akcje: `RarogStore+Push`.
// Degradacja tokenu APNs nie ma własnego widoku: to zwykły `Banner.pushDegraded` w pasie banerów awarii
// (jedna awaria = jeden baner, `AppState.banners`).

/// Zaproszenie, nie alarm: szara kropka, zdanie i dwa przyciski — „Włącz" (systemowe pytanie o zgodę,
/// potem push próbny) i „×" (tydzień ciszy). Stoi pod banerami awarii, nigdy nad nimi.
struct PushPromptBanner: View {
  let store: RarogStore

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      Circle().fill(Color(uiColor: Palette.done)).frame(width: 8, height: 8).accessibilityHidden(true)
      Text(UICopy.pushPrompt)
        .appFont(.callout)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button(store.state.push.enabling ? UICopy.pushEnabling : UICopy.pushEnable) {
        Task { await store.enablePush() }
      }
      .buttonStyle(NeutralButtonStyle())
      .disabled(store.state.push.enabling)
      .accessibilityIdentifier("push.enable")
      Button {
        store.snoozePushPrompt()
      } label: {
        Label(UICopy.pushSnooze, systemImage: "xmark")
      }
      .buttonStyle(HeaderIconButtonStyle())
      .accessibilityIdentifier("push.snooze")
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("push.prompt")
  }
}
#endif
