#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Settings → Server page: "Connection" (the machine, the address and the iroh row, `ServerRouteRows`), "This Device"
// (name, ID, paired, access), "Relay registry" (`RelayRegistrySection`) and Forget Server with its confirmation and
// the failure footer. While forgetting, Back is hidden as × is disabled (`FormSheet.locked`), so the page cannot be
// left half way; a finished forget closes the whole sheet. Values stand in muted ink, long machine identifiers under
// their label. Owner: settings.

struct SettingsServerPage: View {
  let store: RarogStore
  /// Closes the Settings sheet after a finished forget.
  let close: () -> Void
  @State private var confirmForget = false

  var body: some View {
    let pairing = store.state.pairing
    Form {
      switch pairing.binding {
      case .none:
        Section {
          Text(UICopy.serverNone).foregroundStyle(Color(uiColor: Palette.muted))
        }
      case let .device(server):
        Section(UICopy.settingsConnectionSection) {
          field(UICopy.serverName(store.state.serverMachine), server.serverName, identifier: "settings.serverName")
          // The iroh row arrives in place (`routesUpdated`) without clearing the pairing code or the device list.
          ForEach(ServerRouteRows.rows(pairing.binding), id: \.identifier) { row in
            if row.identifier == "settings.address" {
              stacked(row.label, row.value, identifier: row.identifier)
            } else {
              field(row.label, row.value, mono: true, identifier: row.identifier)
            }
          }
        }
        Section(UICopy.serverThisDevice) {
          field(UICopy.settingsDeviceName, server.label, identifier: "settings.label")
          stacked(UICopy.serverDeviceId, server.deviceId, identifier: "settings.deviceId")
          field(UICopy.serverPairedAt, "\(ServerTime.day(server.pairedAt)) \(ServerTime.clock(server.pairedAt))",
                identifier: "settings.pairedAt")
          field(UICopy.serverAuth, UICopy.serverAuthKey, identifier: "settings.auth")
        }
        RelayRegistrySection(store: store)
        forgetSection(pairing)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .navigationBarBackButtonHidden(pairing.forgetting)
  }

  /// A short value beside its label.
  private func field(_ label: String, _ value: String, mono: Bool = false, identifier: String) -> some View {
    LabeledContent(label) {
      Text(verbatim: value)
        .appFont(mono ? .callout.monospaced() : .callout)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .multilineTextAlignment(.trailing)
        .textSelection(.enabled)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier)
  }

  /// A long machine identifier (address, device ID) on a full line under its label, never truncated.
  private func stacked(_ label: String, _ value: String, identifier: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
      Text(verbatim: value)
        .appFont(.callout.monospaced())
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier)
  }

  private func forgetSection(_ pairing: PairingState) -> some View {
    Section {
      Button(pairing.forgetting ? UICopy.forgetBusy : UICopy.forgetServer, role: .destructive) { confirmForget = true }
        .disabled(pairing.forgetting)
        .accessibilityIdentifier("settings.forget")
        .confirmationDialog(UICopy.forgetConfirmTitle, isPresented: $confirmForget, titleVisibility: .visible) {
          Button(UICopy.forgetServer, role: .destructive) {
            Task {
              // Interrupted (the disk did not let the data go): the page stays with the reason under the button.
              if await store.forgetServer() { close() }
            }
          }
          .accessibilityIdentifier("settings.forget.confirm")
          Button(UICopy.pairCancel, role: .cancel) {}
        } message: {
          Text(UICopy.forgetConfirmBody)
        }
    } footer: {
      if pairing.forgetFailed {
        Text(UICopy.forgetFailed)
          .foregroundStyle(Color(uiColor: Palette.err))
          .accessibilityIdentifier("settings.forget.failed")
      }
    }
  }
}
#endif
