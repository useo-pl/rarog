import Foundation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import Testing

// The rows of the Settings index (`SettingsHubRows`): order and identifiers, the server row with its contents
// subtitle and the relay attention words, the pairing row with the paired-device count (Polish plural forms), the
// dictation and voice agent rows with the shortcut the person chose, the about row with the version, and the state
// without a server. The process language is pinned to Polish (`RAROG_COPY_LANGUAGE=pl`); English goes by an explicit
// language.

@Suite("Settings index: rows, subtitles and the relay attention")
struct SettingsHubTests {
  /// The test's own `UserDefaults` domain for the shortcuts, removed after the test.
  final class Scratch {
    let name = "rarog-test-settings-hub-\(UUID().uuidString)"
    let defaults: UserDefaults

    init() {
      // swiftlint:disable:next force_unwrapping
      defaults = UserDefaults(suiteName: name)!
    }

    deinit {
      defaults.removePersistentDomain(forName: name)
    }
  }

  static let appId = "9f8e7d6c" + String(repeating: "0a1b2c3d", count: 7)
  static let engine = "Dyktowanie systemowe"

  static func server(name: String = "mac-studio", url: URL? = URL(string: "https://rarog.example.ts.net"))
    -> ServerBinding
  {
    .device(PairedServer(DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "secret", serverURL: url, serverId: "server-1",
      serverName: name, label: "iPhone·Rarog", kid: "kid-1", pairedAt: Date(timeIntervalSince1970: 0))))
  }

  static func rows(
    binding: ServerBinding = server(), relay: RelayAccessStatus = .inactive, pairedDevices: Int? = 2,
    voiceAgent: VoiceAgentSettingsAvailability = .offered, voiceAgentEnabled: Bool = false,
    shortcuts: AppShortcutSettings? = nil,
    about: AboutInfo = AboutInfo(info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "142"])
  ) -> [SettingsHubRow] {
    let scratch = Scratch()
    return SettingsHubRows.rows(
      binding: binding, relay: relay, pairedDevices: pairedDevices, dictationEngine: engine,
      voiceAgent: voiceAgent, voiceAgentEnabled: voiceAgentEnabled, textSize: "Duży",
      shortcuts: shortcuts ?? AppShortcutSettings(defaults: scratch.defaults), about: about)
  }

  static func row(_ item: SettingsHubRow.Item, in rows: [SettingsHubRow]) -> SettingsHubRow? {
    rows.first { $0.item == item }
  }

  @Test("paired server: rows in order, identifiers `settings.row.<item>`, the language row keeps its own")
  func orderAndIdentifiers() {
    let rows = Self.rows()
    #expect(rows.map(\.item) == [.server, .pairing, .dictation, .voiceAgent, .textSize, .language, .about])
    #expect(rows.map(\.identifier) == [
      "settings.row.server", "settings.row.pairing", "settings.row.dictation", "settings.row.voiceAgent",
      "settings.row.textSize", "settings.language", "settings.row.about",
    ])
    #expect(rows.allSatisfy { $0.enabled })
    #expect(Self.row(.textSize, in: rows)?.title == "Rozmiar pisma")
    #expect(Self.row(.textSize, in: rows)?.value == "Duży")
    #expect(Self.row(.language, in: rows)?.title == "Język")
    #expect(Self.row(.language, in: rows)?.value == "Polski")
    #expect(Self.row(.language, in: rows)?.hint == AppLanguageRow().hint)
    #expect(rows.filter { $0.hint != nil }.map(\.item) == [.language], "only the row that leaves the app")
  }

  @Test("server row: the machine name in the title, the page contents in the subtitle")
  func serverRow() throws {
    let row = try #require(Self.row(.server, in: Self.rows()))
    #expect(row.title == "Serwer: mac-studio")
    #expect(row.subtitle == "Połączenie, to urządzenie, relay, zapomnij serwer")
    #expect(row.attention == nil)
    #expect(L("settings.serverTitle", language: .en, "mac-studio") == "Server: mac-studio")
    #expect(L("settings.serverSubtitle", language: .en) == "Connection, this device, relay, forget server")
  }

  @Test("server row without a name from pairing: the address host, else the iroh short name")
  func serverRowNameFallback() throws {
    let host = try #require(Self.row(.server, in: Self.rows(binding: Self.server(name: ""))))
    #expect(host.title == "Serwer: rarog.example.ts.net")
    let link = "rarog://pair#v=1&k=\(Self.appId)&r=https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"
      + "&c=BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
    let iroh = try #require(try PairingLink.parse(link).get().iroh)
    let irohOnly = ServerBinding.device(PairedServer(DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "secret", serverURL: nil, serverId: "server-1",
      serverName: "", label: "iPhone·Rarog", kid: "kid-1", pairedAt: Date(timeIntervalSince1970: 0), iroh: iroh)))
    #expect(Self.row(.server, in: Self.rows(binding: irohOnly))?.title == "Serwer: iroh · 9f8e7d6c")
  }

  @Test("relay attention words on the server row only for states that do not heal by themselves")
  func relayAttention() {
    let blocked = Self.rows(relay: .problem(.clock, appId: Self.appId, retryAt: nil))
    #expect(Self.row(.server, in: blocked)?.attention == "Relay wymaga uwagi")
    #expect(L("settings.relayAttention", language: .en) == "Relay needs attention")
    let healing = Self.rows(relay: .problem(.unreachable, appId: Self.appId, retryAt: nil))
    #expect(Self.row(.server, in: healing)?.attention == nil)
  }

  @Test(
    "pairing row: the count of paired devices with Polish plural forms; before the list is read only the action",
    arguments: [
      (nil, "Sparuj nowe urządzenie"),
      (1, "Sparuj nowe urządzenie · 1 sparowane"),
      (2, "Sparuj nowe urządzenie · 2 sparowane"),
      (5, "Sparuj nowe urządzenie · 5 sparowanych"),
      (12, "Sparuj nowe urządzenie · 12 sparowanych"),
      (22, "Sparuj nowe urządzenie · 22 sparowane"),
    ] as [(Int?, String)])
  func pairingRow(count: Int?, subtitle: String) throws {
    let row = try #require(Self.row(.pairing, in: Self.rows(pairedDevices: count)))
    #expect(row.title == "Parowanie")
    #expect(row.subtitle == subtitle)
  }

  @Test("pairing row in English: one form for every count")
  func pairingRowEnglish() {
    #expect(L("settings.pairingSubtitle", language: .en, 1) == "Pair New Device · 1 paired")
    #expect(L("settings.pairingSubtitle", language: .en, 5) == "Pair New Device · 5 paired")
  }

  @Test("dictation and voice agent rows show the shortcut the person saved, not the default")
  func changedShortcuts() throws {
    let scratch = Scratch()
    let shortcuts = AppShortcutSettings(defaults: scratch.defaults)
    let defaults = Self.rows(voiceAgentEnabled: true, shortcuts: shortcuts)
    #expect(Self.row(.dictation, in: defaults)?.subtitle == "Dyktowanie systemowe · skrót ⌥⌘M")
    #expect(Self.row(.voiceAgent, in: defaults)?.subtitle == "Włączony · skrót ⌥⌘V")
    let dictation = AppShortcut.Combination(key: .character("d"), modifiers: [.control, .option])
    let voice = AppShortcut.Combination(key: .character("g"), modifiers: [.control, .option])
    #expect(shortcuts.save(dictation, for: .dictation) == nil)
    #expect(shortcuts.save(voice, for: .voiceAgent) == nil)
    let changed = Self.rows(voiceAgentEnabled: true, shortcuts: shortcuts)
    #expect(Self.row(.dictation, in: changed)?.title == "Dyktowanie")
    #expect(Self.row(.dictation, in: changed)?.subtitle == "Dyktowanie systemowe · skrót ⌃⌥D")
    #expect(Self.row(.voiceAgent, in: changed)?.title == "Agent głosowy")
    #expect(Self.row(.voiceAgent, in: changed)?.subtitle == "Włączony · skrót ⌃⌥G")
    #expect(L("settings.withShortcut", language: .en, "On", "⌃⌥G") == "On · shortcut ⌃⌥G")
  }

  @Test("voice agent row: “Off” when off; “Not set up” without the agent, consent or not; no row while hidden")
  func voiceAgentOffNotSetUpAndHidden() {
    #expect(Self.row(.voiceAgent, in: Self.rows(voiceAgentEnabled: false))?.subtitle == "Wyłączony")
    for enabled in [false, true] {
      let row = Self.row(.voiceAgent, in: Self.rows(voiceAgent: .notSetUp, voiceAgentEnabled: enabled))
      #expect(row?.subtitle == UICopy.voiceAgentStateNotSetUp(), "consent stored: \(enabled)")
      #expect(row?.page == .voiceAgent, "the row still opens the page with the setup steps")
    }
    #expect(Self.row(.voiceAgent, in: Self.rows(voiceAgent: .hidden, voiceAgentEnabled: true)) == nil)
  }

  @Test("about row: the version in the subtitle; a missing version shows the dash")
  func aboutRow() throws {
    let row = try #require(Self.row(.about, in: Self.rows()))
    #expect(row.title == "O apce")
    #expect(row.subtitle == "Wersja 1.0 · wsparcie, licencje")
    #expect(Self.row(.about, in: Self.rows(about: AboutInfo(info: nil)))?.subtitle == "Wersja — · wsparcie, licencje")
    #expect(L("settings.aboutSubtitle", language: .en, "1.0") == "Version 1.0 · support, licenses")
  }

  @Test("no server: a muted server row that does not respond, without attention, and no pairing row")
  func noServer() throws {
    let rows = Self.rows(binding: .none, relay: .problem(.clock, appId: Self.appId, retryAt: nil), pairedDevices: 3)
    #expect(rows.map(\.item) == [.server, .dictation, .voiceAgent, .textSize, .language, .about])
    let server = try #require(Self.row(.server, in: rows))
    #expect(server.title == "Brak serwera — sparuj to urządzenie.")
    #expect(server.subtitle == nil)
    #expect(server.attention == nil)
    #expect(!server.enabled)
  }

  @Test("rows open their pages; the language row opens the system's Settings instead")
  func pages() {
    let rows = Self.rows()
    #expect(rows.map(\.page) == [.server, .pairing, .dictation, .voiceAgent, .textSize, nil, .about])
    #expect(SettingsPage.allCases.map(\.identifier) == [
      "settings.page.server", "settings.page.pairing", "settings.page.dictation", "settings.page.voiceAgent",
      "settings.page.textSize", "settings.page.about",
    ])
    #expect(SettingsPage.allCases.map(\.title) == [
      "Serwer", "Parowanie", "Dyktowanie", "Agent głosowy", "Rozmiar pisma", "O apce",
    ])
  }

  @Test("cards: server with pairing, dictation with the voice agent, text size with language, about alone")
  func groups() {
    #expect(SettingsHubRows.groups(Self.rows()).map { $0.map(\.item) } == [
      [.server, .pairing], [.dictation, .voiceAgent], [.textSize, .language], [.about],
    ])
    let bare = Self.rows(binding: .none, voiceAgent: .hidden)
    #expect(SettingsHubRows.groups(bare).map { $0.map(\.item) } == [
      [.server], [.dictation], [.textSize, .language], [.about],
    ])
  }

  @Test("VoiceOver value: the relay attention first, else the trailing value, else the subtitle")
  func spokenValue() throws {
    let attention = Self.rows(relay: .problem(.clock, appId: Self.appId, retryAt: nil))
    #expect(Self.row(.server, in: attention)?.spokenValue == "Relay wymaga uwagi")
    #expect(Self.row(.server, in: Self.rows())?.spokenValue == "Połączenie, to urządzenie, relay, zapomnij serwer")
    #expect(Self.row(.textSize, in: Self.rows())?.spokenValue == "Duży")
    #expect(Self.row(.server, in: Self.rows(binding: .none))?.spokenValue == nil)
  }
}
