import Foundation
import RarogCore
import RarogTransport

// The rows of the Settings index: a title, a muted subtitle or value, the relay attention words on the server row,
// and whether the row responds. Plain values in, rows out, without SwiftUI, so `swift test` checks every row on macOS
// (`SettingsHubTests`); the index view draws from them. The caller passes what it reads from the store: the binding,
// the relay status, the paired-device count (nil before the list is read), the dictation engine name, the voice agent's
// Settings state and whether it is on, the text size value and the shortcut settings. Owner: settings.

/// One row of the index.
struct SettingsHubRow: Equatable, Sendable {
  /// What the row leads to. The raw value names the page in the row's identifier.
  enum Item: String, Equatable, Sendable {
    case server, pairing, dictation, voiceAgent, textSize, language, about
  }

  let item: Item
  let title: String
  let subtitle: String?
  /// A short value at the trailing edge (text size, language) instead of a subtitle.
  let value: String?
  /// The server row's words while the relay needs the person; nil otherwise.
  let attention: String?
  /// False only for the server row without a server: muted and not tappable.
  let enabled: Bool
  /// VoiceOver's hint: only the language row, which leaves the app.
  let hint: String?

  init(item: Item, title: String, subtitle: String? = nil, value: String? = nil, attention: String? = nil,
       enabled: Bool = true, hint: String? = nil) {
    self.item = item
    self.title = title
    self.subtitle = subtitle
    self.value = value
    self.attention = attention
    self.enabled = enabled
    self.hint = hint
  }

  /// `settings.row.<item>`; the language row keeps `settings.language`, because it opens the system's Settings, not
  /// a page.
  var identifier: String {
    item == .language ? "settings.language" : "settings.row.\(item.rawValue)"
  }

  /// The page the row pushes; `nil` for the language row, which opens the system's Settings.
  var page: SettingsPage? { SettingsPage(rawValue: item.rawValue) }

  /// What VoiceOver reads after the title: the relay attention words while they show, else the trailing value, else
  /// the subtitle.
  var spokenValue: String? { attention ?? value ?? subtitle }
}

enum SettingsHubRows {
  /// The rows in display order. Without a server the server row is muted and inert and the pairing row is hidden;
  /// the voice agent row is hidden only in a build without Soniox and before the server answers, and says "Not set up"
  /// where the server does not offer the agent (a consent stored earlier changes nothing there).
  static func rows(
    binding: ServerBinding, relay: RelayAccessStatus, pairedDevices: Int?, dictationEngine: String,
    voiceAgent: VoiceAgentSettingsAvailability, voiceAgentEnabled: Bool, textSize: String, shortcuts: AppShortcutSettings,
    about: AboutInfo, language: AppLanguageRow = AppLanguageRow()
  ) -> [SettingsHubRow] {
    var rows: [SettingsHubRow] = []
    switch binding {
    case .none:
      rows.append(SettingsHubRow(item: .server, title: UICopy.serverNone, enabled: false))
    case let .device(server):
      rows.append(SettingsHubRow(
        item: .server, title: UICopy.settingsServerTitle(name(server)), subtitle: UICopy.settingsServerSubtitle,
        attention: RelayRegistryContent.needsAttention(relay) ? UICopy.settingsRelayAttention : nil))
      rows.append(SettingsHubRow(
        item: .pairing, title: UICopy.pairIssueSection,
        subtitle: pairedDevices.map(UICopy.settingsPairingSubtitle) ?? UICopy.pairNewDevice))
    }
    rows.append(SettingsHubRow(
      item: .dictation, title: UICopy.dictationTitle(),
      subtitle: UICopy.settingsWithShortcut(dictationEngine, shortcuts.combination(for: .dictation).glyphs)))
    let voiceAgentSubtitle: String? =
      switch voiceAgent {
      case .hidden: nil
      case .notSetUp: UICopy.voiceAgentStateNotSetUp()
      case .offered:
        voiceAgentEnabled
          ? UICopy.settingsWithShortcut(UICopy.voiceAgentStateOn(), shortcuts.combination(for: .voiceAgent).glyphs)
          : UICopy.voiceAgentStateOff()
      }
    if let voiceAgentSubtitle {
      rows.append(SettingsHubRow(item: .voiceAgent, title: UICopy.voiceAgentTitle(), subtitle: voiceAgentSubtitle))
    }
    rows.append(SettingsHubRow(item: .textSize, title: UICopy.textSizeLabel, value: textSize))
    rows.append(SettingsHubRow(item: .language, title: language.label, value: language.value, hint: language.hint))
    rows.append(SettingsHubRow(
      item: .about, title: UICopy.aboutSection,
      subtitle: UICopy.settingsAboutSubtitle(about.version ?? AboutInfo.missing)))
    return rows
  }

  /// The rows in their cards, without section headers (the tiles carry the meaning): the server and pairing, dictation
  /// and the voice agent, text size and language, about.
  static func groups(_ rows: [SettingsHubRow]) -> [[SettingsHubRow]] {
    func card(_ item: SettingsHubRow.Item) -> Int {
      switch item {
      case .server, .pairing: 0
      case .dictation, .voiceAgent: 1
      case .textSize, .language: 2
      case .about: 3
      }
    }
    return Dictionary(grouping: rows) { card($0.item) }.sorted { $0.key < $1.key }.map(\.value)
  }

  /// The machine's name from pairing; a server paired without one shows its address host, else its iroh short name.
  private static func name(_ server: PairedServer) -> String {
    if !server.serverName.isEmpty { return server.serverName }
    if let url = server.url { return url.host(percentEncoded: false) ?? url.absoluteString }
    return server.iroh.map { UICopy.serverIroh($0.endpointId) } ?? ""
  }
}
