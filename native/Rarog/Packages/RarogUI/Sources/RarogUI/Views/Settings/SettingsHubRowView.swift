#if os(iOS)
import RarogContract
import SwiftUI

// One row of the Settings list, drawn from `SettingsHubRow`: an icon tile, the title, a muted subtitle and the amber
// relay attention line, or a muted value at the trailing edge, then a chevron (a page) or the exit glyph (language,
// which opens the system's Settings). The server row has the larger tile and a headline title; without a server it is
// muted and does not respond. Owner: settings.

struct SettingsHubRowView: View {
  let row: SettingsHubRow
  let machine: ServerMachine
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        SettingsTile(systemImage: symbol, large: row.item == .server)
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: row.title)
            .appFont(row.item == .server ? .headline : .body)
            .foregroundStyle(Color(uiColor: row.enabled ? Palette.text : Palette.muted))
            .fixedSize(horizontal: false, vertical: true)
          if let subtitle = row.subtitle {
            Text(verbatim: subtitle)
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted))
              .fixedSize(horizontal: false, vertical: true)
          }
          if let attention = row.attention {
            HStack(spacing: 5) {
              Circle()
                .fill(Color(uiColor: Palette.wait))
                .frame(width: 8, height: 8)
              Text(verbatim: attention)
                .appFont(.footnote)
                .foregroundStyle(Color(uiColor: Palette.wait))
            }
            .accessibilityIdentifier("settings.relay.attention")
          }
        }
        Spacer(minLength: 8)
        if let value = row.value {
          Text(verbatim: value)
            .appFont(.callout)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if row.enabled {
          Image(systemName: row.page == nil ? "arrow.up.right" : "chevron.forward")
            .appFont(.footnote.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.muted))
            .accessibilityHidden(true)
        }
      }
      .padding(.vertical, row.subtitle == nil ? 0 : 4)
      .contentShape(Rectangle())
    }
    .disabled(!row.enabled)
    .accessibilityLabel(row.title)
    .accessibilityValue(row.spokenValue ?? "")
    .accessibilityHint(row.hint ?? "")
    .accessibilityIdentifier(row.identifier)
  }

  private var symbol: String {
    switch row.item {
    case .server: machine == .vps ? "server.rack" : "desktopcomputer"
    case .pairing: "qrcode"
    case .dictation: "mic"
    case .voiceAgent: "waveform"
    case .textSize: "textformat.size"
    case .language: "globe"
    case .about: "info.circle"
    }
  }
}

/// The monochrome icon tile of a list row: text ink at 10 % on the card, the glyph in text ink, no hue.
private struct SettingsTile: View {
  let systemImage: String
  let large: Bool

  var body: some View {
    let side: CGFloat = large ? 40 : 29
    Image(systemName: systemImage)
      .font(.system(size: large ? 20 : 15, weight: .medium))
      .foregroundStyle(Color(uiColor: Palette.text))
      .frame(width: side, height: side)
      .background(
        RoundedRectangle(cornerRadius: large ? 9 : 7, style: .continuous)
          .fill(Color(uiColor: Palette.text).opacity(0.1)))
      .accessibilityHidden(true)
  }
}
#endif
