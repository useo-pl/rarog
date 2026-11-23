import Foundation
import RarogContract

// Copy of the Settings index (`SettingsHubRows`) and of its pages: the "Server" page's iroh row (`ServerRouteRows`),
// section and name row, and the "Pairing" page's device list footer. Row titles
// reuse the titles of their pages; shortcut glyphs come from `AppShortcut.Combination`, outside the catalog.
extension UICopy {
  /// "Server: mac-studio": the server row of the index with the server machine's name.
  static func settingsServerTitle(_ name: String) -> String { L("settings.serverTitle", name) }
  /// What the server page holds, under the server row.
  static var settingsServerSubtitle: String { L("settings.serverSubtitle") }
  /// The server row's words while the relay needs the person.
  static var settingsRelayAttention: String { L("settings.relayAttention") }
  /// "Pair New Device · 3 paired": the pairing row with the count of devices on the server, this one included.
  static func settingsPairingSubtitle(_ count: Int) -> String { L("settings.pairingSubtitle", count) }
  /// "On · shortcut ⌥⌘V": a row's state or engine followed by its keyboard shortcut.
  static func settingsWithShortcut(_ state: String, _ glyphs: String) -> String {
    L("settings.withShortcut", state, glyphs)
  }
  /// "Version 1.0 · support, licenses": the about row.
  static func settingsAboutSubtitle(_ version: String) -> String { L("settings.aboutSubtitle", version) }
  /// The label of the iroh route row on the "Server" screen.
  static var settingsIrohLabel: String { L("settings.irohLabel") }
  /// The "Server" page's section with the machine, its address and its iroh route.
  static var settingsConnectionSection: String { L("settings.connectionSection") }
  /// The label of this device's name on the "Server" page, under the "This Device" header.
  static var settingsDeviceName: String { L("settings.deviceName") }
  /// The footer under the read-only device list: devices are revoked on the server machine.
  static func settingsDevicesFooter(_ machine: ServerMachine) -> String {
    machine == .mac ? L("settings.devicesFooter") : L("settings.devicesFooter.vps")
  }
}
