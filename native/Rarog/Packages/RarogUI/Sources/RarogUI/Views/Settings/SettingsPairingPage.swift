#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Settings → Pairing page: Pair New Device with the code's states in place (issuing, the QR code with its server
// deadline and Share Link, expired, failed) and the server's read-only device list with the footer that says where a
// device is revoked. The page title is the middle step of the path the server's `rarog pair` refusal gives ("Settings
// → Pairing → Pair New Device"). Leaving the page revokes a shown code, like closing the sheet. Owner: settings.

struct SettingsPairingPage: View {
  let store: RarogStore

  var body: some View {
    let pairing = store.state.pairing
    Form {
      switch pairing.binding {
      case .none:
        Section {
          Text(UICopy.serverNone).foregroundStyle(Color(uiColor: Palette.muted))
        }
      case .device:
        issueSection(pairing)
        devicesSection(pairing)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .onDisappear {
      // Back, a push route or the sheet closing: the code is revoked on the server too. The state is read now, so the
      // sheet's own cleanup after this one sends no second revoke; a code still being issued is revoked after the POST
      // answer, and a failed attempt may still have left one there.
      if store.state.pairing.issue != .idle { store.clearPairingCode() }
    }
  }

  @ViewBuilder
  private func issueSection(_ pairing: PairingState) -> some View {
    Section {
      switch pairing.issue {
      case .idle:
        Button(UICopy.pairNewDevice, systemImage: "qrcode") { store.issuePairingCode() }
          .accessibilityIdentifier("settings.issue")
      case .issuing:
        HStack(spacing: 8) {
          ProgressView()
          Text(UICopy.pairCodeIssuing).foregroundStyle(Color(uiColor: Palette.muted))
        }
      case let .issued(code):
        IssuedCodeView(store: store, code: code)
      case let .failed(failure):
        Text(UICopy.pairCodeFailure(failure))
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("settings.issue.failure")
        Button(UICopy.pairCodeAgain) { store.issuePairingCode() }
          .accessibilityIdentifier("settings.issue")
      }
    }
  }

  @ViewBuilder
  private func devicesSection(_ pairing: PairingState) -> some View {
    let machine = store.state.serverMachine
    Section {
      if let devices = pairing.devices {
        let labels = Dictionary(devices.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        ForEach(devices, id: \.id) { device in
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text(verbatim: device.label).foregroundStyle(Color(uiColor: Palette.text))
              if device.current {
                Text(UICopy.deviceCurrent).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted))
              }
            }
            Text(UICopy.deviceDetail(device, labels: labels, machine))
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted))
              .fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("settings.device.\(device.id)")
        }
      } else {
        Text(UICopy.devicesLoading).foregroundStyle(Color(uiColor: Palette.muted))
      }
    } header: {
      Text(UICopy.devicesSection)
    } footer: {
      Text(UICopy.settingsDevicesFooter(machine))
    }
  }
}

/// An issued code: the QR code, the countdown to the server's deadline (an app back from sleep sees the truth), Share
/// Link, New Code and Hide Code. The three buttons share one row on an iPad; on a phone Share Link takes the full
/// width with the other two below it.
private struct IssuedCodeView: View {
  let store: RarogStore
  let code: IssuedPairingCode

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(UICopy.pairNewLead)
        .appFont(.callout)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let expired = code.isExpired(now: context.date)
        VStack(alignment: .center, spacing: 12) {
          if expired {
            Text(UICopy.pairCodeExpired)
              .foregroundStyle(Color(uiColor: Palette.wait))
              .accessibilityIdentifier("settings.code.expired")
          } else {
            PairingQRCode(text: code.link.url.absoluteString)
            Text(UICopy.pairCodeRemaining(code.remaining(now: context.date)))
              .appFont(.callout.monospacedDigit())
              .foregroundStyle(Color(uiColor: Palette.muted))
              .accessibilityIdentifier("settings.code.remaining")
          }
        }
        .frame(maxWidth: .infinity)
      }
      // A list row measures its content without a width first, so `ViewThatFits` always took the single row; the
      // phone's row is too narrow for three labels (they wrapped letter by letter).
      if UIDevice.current.userInterfaceIdiom != .phone {
        HStack(spacing: 8) {
          share
          again
          hide
        }
      } else {
        VStack(spacing: 8) {
          share.frame(maxWidth: .infinity)
          HStack(spacing: 8) {
            again.frame(maxWidth: .infinity)
            hide.frame(maxWidth: .infinity)
          }
        }
      }
      // The link as text for UI tests and for a person who copies it by hand (over mosh on an iPad).
      Text(verbatim: code.link.url.absoluteString)
        .appFont(.footnote.monospaced())
        .foregroundStyle(Color(uiColor: Palette.muted))
        .textSelection(.enabled)
        .lineLimit(3)
        .accessibilityIdentifier("settings.code.link")
    }
    .padding(.vertical, 4)
  }

  private var share: some View {
    ShareLink(item: code.link.url) {
      Label(UICopy.pairCodeShare, systemImage: "square.and.arrow.up")
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(NeutralButtonStyle())
    .accessibilityIdentifier("settings.code.share")
  }

  private var again: some View {
    Button {
      store.issuePairingCode()
    } label: {
      Text(UICopy.pairCodeAgain).frame(maxWidth: .infinity)
    }
    .buttonStyle(NeutralButtonStyle())
    .accessibilityIdentifier("settings.code.again")
  }

  private var hide: some View {
    Button {
      store.clearPairingCode()
    } label: {
      Text(UICopy.pairCodeHide).frame(maxWidth: .infinity)
    }
    .buttonStyle(NeutralButtonStyle())
    .accessibilityIdentifier("settings.code.hide")
  }
}
#endif
