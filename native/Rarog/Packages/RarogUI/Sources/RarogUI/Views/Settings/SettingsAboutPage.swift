#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Settings → About page: the three product links (the same as on the pairing screen), Report a Problem (a mail to
// support with the version, build and system), Licenses (the notices page from the app bundle) and the version row.
// Settings open only once paired, so this page does too. Owner: settings.

struct SettingsAboutPage: View {
  @Environment(\.openURL) private var openURL
  private let info = AboutInfo(info: Bundle.main.infoDictionary)

  var body: some View {
    Form {
      Section {
        ForEach(AboutLink.allCases) { link in
          Link(destination: link.url) {
            row(UICopy.aboutLink(link), systemImage: "arrow.up.right")
          }
          .accessibilityIdentifier("settings.about.\(link.id)")
        }
        Button {
          // Where no app takes `mailto:` (Mail removed, say), the support page with the address. Mail without an
          // account takes the address and leads to adding one itself.
          let mail = AboutReport.mailURL(info: info, system: UIDevice.current.systemVersion, device: Self.device)
          openURL(mail) { accepted in
            if !accepted { openURL(ProductLinks.support) }
          }
        } label: {
          row(UICopy.aboutReportProblem, systemImage: "envelope")
        }
        .accessibilityIdentifier("settings.about.report")
        NavigationLink {
          LicensesView(page: LicensesPage.inApp())
            // The page above takes the keyboard from the About page's anchor, which leaves the window.
            .background { SheetKeyboardAnchor() }
        } label: {
          Text(UICopy.aboutLicenses).foregroundStyle(Color(uiColor: Palette.text))
        }
        .accessibilityIdentifier("settings.about.licenses")
        Text(UICopy.aboutVersion(info))
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .textSelection(.enabled)
          .accessibilityIdentifier("settings.about.version")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
  }

  /// An action row: the name on the left, a quiet glyph on the right (an address outside the app, a mail).
  private func row(_ title: String, systemImage: String) -> some View {
    HStack {
      Text(title).foregroundStyle(Color(uiColor: Palette.text))
      Spacer(minLength: 8)
      Image(systemName: systemImage)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityHidden(true)
    }
    .contentShape(Rectangle())
  }

  /// The device kind in the mail's technical line; the app on a Mac (Designed for iPad) says Mac.
  private static var device: ProblemReport.Device {
    if ProcessInfo.processInfo.isiOSAppOnMac { return .mac }
    return UIDevice.current.userInterfaceIdiom == .pad ? .iPad : .iPhone
  }
}
#endif
