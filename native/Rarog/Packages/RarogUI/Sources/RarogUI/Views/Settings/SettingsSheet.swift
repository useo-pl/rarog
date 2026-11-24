#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Settings: a list of rows (`SettingsHubRows`, drawn by `SettingsHubRowView`), each leading to its page pushed in the
// same sheet: Server (`SettingsServerPage`), Pairing (`SettingsPairingPage`), Dictation (`DictationChoiceView`),
// Voice Agent (`VoiceAgentSettingsPage`), Text Size (`TextSizeSettingsPage`) and About (`SettingsAboutPage`); the
// language row opens the app's page in the system's Settings. A pairing link opened while logged in puts the
// "Pair with …?" card on top of the list. The page is navigation state (`RarogNavigation.settingsPage`), so a push tap
// opens its page and a pairing link pops to the list (`Model/SettingsPage.swift`). The list shares one dictation model
// and one voice agent model with their pages, so its subtitles show a new choice as soon as it is saved. The sheet goes
// through `SheetHost` like every sheet. Owner: settings.

struct SettingsSheet: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let request: SettingsRequest
  @State private var dictation: DictationChoiceModel
  @State private var voiceAgent: VoiceAgentSettingsModel
  private let about = AboutInfo(info: Bundle.main.infoDictionary)
  var shortcuts = AppShortcutSettings.shared
  var textScale = TextScale.shared

  init(store: RarogStore, navigation: RarogNavigation, request: SettingsRequest) {
    self.store = store
    self.navigation = navigation
    self.request = request
    _dictation = State(initialValue: DictationChoiceModel(store: store))
    _voiceAgent = State(initialValue: VoiceAgentSettingsModel(settings: store.voiceAgent))
  }

  var body: some View {
    let pairing = store.state.pairing
    FormSheet(
      title: UICopy.settingsTitle,
      close: SheetClose(label: UICopy.settingsClose, identifier: "settings.close") {
        navigation.closeSheet(id: request.id)
      },
      locked: pairing.forgetting
    ) {
      Form {
        if pairing.flow.isActive {
          Section {
            PairingFlowCard(store: store)
              .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
          }
        }
        ForEach(SettingsHubRows.groups(rows), id: \.first?.item) { group in
          Section {
            ForEach(group, id: \.item) { row in
              SettingsHubRowView(row: row, machine: store.state.serverMachine) { open(row) }
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Color(uiColor: Palette.background))
      .accessibilityIdentifier("settings.form")
      .navigationDestination(item: page) { page in
        pageView(page)
          .navigationTitle(page.title)
          .navigationBarTitleDisplayMode(.inline)
          // After a push the list's anchor leaves the window: without one on the page the keyboard would go to the
          // field under the sheet, and Esc and Cmd+W would miss the sheet's shortcuts.
          .background { SheetKeyboardAnchor() }
          .accessibilityIdentifier(page.identifier)
      }
    }
    .onAppear { store.refreshDevices() }
    .onDisappear {
      // Closing the sheet revokes the code on the server too (also from a page: the root content's own disappearance
      // fires on every push, so the cleanup stays here); a code still being issued is revoked after the POST answer,
      // and a failed attempt may still have left one there.
      if store.state.pairing.issue != .idle { store.clearPairingCode() }
      // The "Pair with …?" card belongs to this presentation: closed Settings = Cancel (a request in flight stays).
      store.cancelPairing()
    }
  }

  /// The list's rows from the store, the shared models, the text size and the shortcuts; reading the shortcuts'
  /// revision redraws the subtitles after a save on a deeper page.
  private var rows: [SettingsHubRow] {
    _ = shortcuts.revision
    let state = store.state
    return SettingsHubRows.rows(
      binding: state.pairing.binding, relay: state.relayAccess, pairedDevices: state.pairing.devices?.count,
      dictationEngine: dictation.settings().value,
      voiceAgent: voiceAgentAvailability,
      voiceAgentEnabled: store.voiceAgent.enabled, textSize: TextScaleSettingsRow(scale: textScale).value,
      shortcuts: shortcuts, about: about)
  }

  /// The voice agent's Settings state from the store: the list's row and its page read the same value.
  private var voiceAgentAvailability: VoiceAgentSettingsAvailability {
    VoiceAgentSettingsModel.availability(state: store.state, sonioxAllowed: store.dictation.sonioxAllowed)
  }

  /// The page standing over the list; the system's Back sets it to `nil`.
  private var page: Binding<SettingsPage?> {
    Binding(get: { navigation.settingsPage }, set: { navigation.settingsPage = $0 })
  }

  private func open(_ row: SettingsHubRow) {
    if let page = row.page {
      navigation.openSettings(page: page)
    } else {
      // Language: the app does not switch its language itself; iOS restarts the app after a change there.
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    }
  }

  @ViewBuilder
  private func pageView(_ page: SettingsPage) -> some View {
    switch page {
    case .server:
      SettingsServerPage(store: store) { navigation.closeSheet(id: request.id) }
    case .pairing:
      SettingsPairingPage(store: store)
    case .dictation:
      DictationChoiceView(model: dictation, presentation: .settingsPage)
    case .voiceAgent:
      VoiceAgentSettingsPage(
        model: voiceAgent, availability: { voiceAgentAvailability }, sonioxOnServer: { store.state.sonioxOnServer },
        sessionsOffered: { store.state.companionSessionsOffered(sonioxAllowed: store.dictation.sonioxAllowed) })
    case .textSize:
      TextSizeSettingsPage(scale: textScale)
    case .about:
      SettingsAboutPage()
    }
  }
}

/// Settings in the list bar, in one group with New Session (`NewSessionListButton`), the same quiet glyph. The path
/// "Settings → Pairing → Pair New Device" is the one the `rarog pair` refusal on the Mac gives.
struct SettingsListButton: View {
  let navigation: RarogNavigation

  /// The gear glyph stands this far below the centre of its target.
  /// Measured on an iPad with iOS 27: unshifted, the gear's ink centre stood 0.5 pt above the ink of
  /// "square.and.pencil", so with this drop the two inks stand level (`NewSessionListButton.glyphLift` is 0,
  /// `SplitChromeUITests.testListBarIconsTogether`). Moves only the drawing; the 44 pt target stays in place.
  static let glyphDrop: CGFloat = 0.5

  var body: some View {
    Button {
      navigation.openSettings()
    } label: {
      Label(UICopy.settingsTitle, systemImage: "gearshape")
        .offset(y: Self.glyphDrop)
    }
    .buttonStyle(HeaderIconButtonStyle())
    .pointerTip(UICopy.settingsTitle)
    .accessibilityIdentifier("list.settings")
  }
}
#endif
