#if os(iOS)
import RarogCore
import SwiftUI

/// Strona „Agent głosowy” w Ustawieniach. Właściciel: agent głosowy. Przełącznik (włączenie
/// przez stronę zgody `VoiceAgentConsentPage`, wyłączenie kasuje zgodę). When it is on: the Voice row names Soniox
/// (the server sets that voice; there is no voice list), and a Reading Speed picker stands under it.
/// The keyboard shortcut section of the voice agent stands under them while the agent is on
/// (`VoiceAgentSettingsModel.showsShortcut`).
/// Klucz OpenAI i model ustawia serwer Raroga, nie ta strona. Strona zgody to strona w stosie Ustawień, nie arkusz
/// (jeden arkusz naraz). Where the server offers the mode across sessions, a second switch turns
/// that mode on through its own consent page and off by removing its consent
/// (`VoiceAgentSettingsModel.showsSessions`). A server that does not offer the agent gets the setup steps instead of
/// all of that (`VoiceAgentSettingsModel.showsSetup`): no switch, no consent, and the stored consent stays as it is.
struct VoiceAgentSettingsPage: View {
  @Bindable var model: VoiceAgentSettingsModel
  /// From `SettingsSheet`: read from the store inside this body, so the page follows the server live (a version
  /// probe while the page is open swaps the steps for the switch and back).
  let availability: @MainActor () -> VoiceAgentSettingsAvailability
  let sonioxOnServer: @MainActor () -> SonioxServerState
  /// The server offers the mode across sessions (`AppState.companionSessionsOffered`), read live like `availability`.
  let sessionsOffered: @MainActor () -> Bool

  var body: some View {
    if VoiceAgentSettingsModel.showsSetup(availability()) {
      setupForm(model.setup(sonioxOnServer: sonioxOnServer()))
    } else {
      offeredForm
    }
  }

  private func setupForm(_ setup: VoiceAgentSetupContent) -> some View {
    Form {
      Section {
        Text(setup.lead)
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("voiceAgent.setup.lead")
        ServerSetupStepsView(setup: setup.steps, identifier: "voiceAgent.setup")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
  }

  private var offeredForm: some View {
    let settings = model.settings
    return Form {
      Section {
        Toggle(UICopy.voiceAgentTitle(), isOn: Binding(get: { model.isOn }, set: { model.toggle($0) }))
          .accessibilityIdentifier("voiceAgent.toggle")
      } footer: {
        Text(UICopy.voiceAgentLead())
      }
      if model.showsSessions(offered: sessionsOffered()) {
        Section {
          Toggle(
            UICopy.voiceAgentSessionsTitle(),
            isOn: Binding(get: { model.sessionsIsOn }, set: { model.toggleSessions($0) }))
            .accessibilityIdentifier("voiceAgent.sessions.toggle")
        } footer: {
          Text(UICopy.voiceAgentSessionsLead())
        }
      }
      if settings.enabled {
        let soniox = model.sonioxVoice()
        Section {
          LabeledContent(UICopy.voiceAgentVoice(), value: soniox.value)
            .accessibilityIdentifier("voiceAgent.voice")
          let speed = Binding(get: { model.speechSpeed }, set: { model.chooseSpeechSpeed($0) })
          Picker(UICopy.voiceAgentSpeechSpeed(), selection: speed) {
            ForEach(model.speechSpeeds(), id: \.value) { choice in
              Text(choice.label).tag(choice.value)
            }
          }
          .accessibilityIdentifier("voiceAgent.speechSpeed")
        } footer: {
          Text(soniox.hint)
        }
      }
      if model.showsShortcut {
        ShortcutPageSection(shortcut: .voiceAgent)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: Palette.background))
    .navigationDestination(isPresented: $model.consentShown) {
      VoiceAgentConsentPage(
        content: model.consent(), identifier: "voiceAgent.consent", accept: { model.acceptConsent() },
        cancel: { model.cancelConsent() }
      )
      // The consent page takes the keyboard from this page's anchor, which leaves the window.
      .background { SheetKeyboardAnchor() }
    }
    .navigationDestination(isPresented: $model.sessionsConsentShown) {
      VoiceAgentConsentPage(
        content: model.sessionsConsent(), identifier: "voiceAgent.sessions.consent",
        accept: { model.acceptSessionsConsent() }, cancel: { model.cancelSessionsConsent() }
      )
      .background { SheetKeyboardAnchor() }
    }
  }
}
#endif
