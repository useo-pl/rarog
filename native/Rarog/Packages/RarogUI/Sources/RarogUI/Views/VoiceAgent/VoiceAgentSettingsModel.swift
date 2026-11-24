import Foundation
import Observation
import RarogContract
import RarogCore

// Model strony „Agent głosowy” w Ustawieniach. Właściciel: agent głosowy. Bez UIKit:
// kompiluje się na macOS, więc `swift test` sprawdza go bez symulatora (`VoiceAgentSettingsModelTests`). Reguły
// (zgoda, tempo czytania) są w `VoiceAgentSettings` (RarogCore); model trzyma tylko stan strony zgody i składa teksty. Widoki:
// `VoiceAgentSettingsPage.swift`, `VoiceAgentConsentPage.swift`; the list's row: `Views/Settings/SettingsSheet.swift`.
//
// Przełącznik: włączenie nie włącza, tylko otwiera stronę zgody; bez „Zgadzam się” przełącznik wraca do „wyłączone”.
// Wyłączenie kasuje zgodę. The switch of the conversation across sessions works the same way with the mode's own
// consent (`VoiceAgentSettingsModel+Sessions.swift`). A server that answered without the voice agent gets the setup
// steps instead of the switch; the app never takes the OpenAI key, it only says where to get one and which server command saves it.

/// The Settings row of the voice agent and what its page shows. Only Settings uses the middle state: the session
/// button, ⌥⌘V and `VoiceAgentWatch` follow `VoiceAgentAvailability.offered` alone.
enum VoiceAgentSettingsAvailability: Equatable, Sendable {
  /// No row: a build without Soniox, or the server has not answered yet.
  case hidden
  /// The server answered and does not offer the voice agent: the row says so and the page shows the setup steps.
  case notSetUp
  /// The page with the switch, the consent and the voice settings.
  case offered
}

/// The page of a server without the voice agent: what the agent is, the setup steps and the OpenAI keys link.
struct VoiceAgentSetupContent: Equatable, Sendable {
  let lead: String
  let steps: ServerSetupSteps
}

/// Wiersz Ustawień: etykieta i stan.
struct VoiceAgentSettingsSummary: Equatable, Sendable {
  let label: String
  let value: String
}

/// Treść strony zgody w jednym języku.
struct VoiceAgentConsentContent: Equatable, Sendable {
  let title: String
  let paragraphs: [String]
  let accept: String
  let cancel: String
}

/// The Voice row: Soniox speaks the answers in the voice the server sets, so the page shows no voice list.
struct VoiceAgentSonioxVoice: Equatable, Sendable {
  let value: String
  let hint: String
}

/// One option of the Soniox reading speed picker: the value of `VoiceAgentSettings.speechSpeeds` and its label.
struct VoiceAgentSpeechSpeedChoice: Equatable, Sendable {
  let value: Double
  let label: String
}

@MainActor
@Observable
final class VoiceAgentSettingsModel {
  @ObservationIgnored let settings: VoiceAgentSettings
  /// Strona zgody na ekranie (po przełączeniu na „włączone” bez zgody).
  var consentShown = false
  /// The consent page of the conversation across sessions on screen (its switch turned on without that consent).
  var sessionsConsentShown = false

  init(settings: VoiceAgentSettings) {
    self.settings = settings
  }

  /// The Settings row: hidden in a build without Soniox and before the server's first answer; offered where
  /// `VoiceAgentAvailability` offers the agent (the server announces it with Soniox speech); otherwise not set up,
  /// so a server without the keys still has a page that says how to add them. The voice agent is off by default.
  static func availability(state: AppState, sonioxAllowed: Bool) -> VoiceAgentSettingsAvailability {
    guard sonioxAllowed, state.capabilities != nil else { return .hidden }
    return VoiceAgentAvailability.offered(state: state, sonioxAllowed: sonioxAllowed) ? .offered : .notSetUp
  }

  /// The page shows the setup steps unless the agent is offered. `hidden` counts too: a page already open when the
  /// server's answer goes away (logout, reconnect) keeps the steps instead of going blank; only the row hides. The
  /// stored consent stays untouched and applies again once the server offers the agent.
  static func showsSetup(_ availability: VoiceAgentSettingsAvailability) -> Bool {
    availability != .offered
  }

  /// The setup steps. The Soniox step stands only while dictation with Soniox does not work on the server, because
  /// the agent speaks only with the Soniox voice.
  func setup(sonioxOnServer: SonioxServerState, language: CopyLanguage = .current) -> VoiceAgentSetupContent {
    var steps: [ServerSetupStep] = []
    if sonioxOnServer != .available {
      steps.append(ServerSetupStep(text: UICopy.voiceAgentSetupSoniox(language: language)))
    }
    steps.append(ServerSetupStep(text: UICopy.voiceAgentSetupKey(language: language)))
    steps.append(ServerSetupStep(
      text: UICopy.voiceAgentSetupRun(language: language),
      commands: [ServerCommand.voiceAgentSetKey, ServerCommand.restart]))
    return VoiceAgentSetupContent(
      lead: UICopy.voiceAgentSetupLead(language: language),
      steps: ServerSetupSteps(
        steps: steps, linkLabel: UICopy.voiceAgentSetupLink(language: language), linkURL: ProviderLinks.openAIKeys))
  }

  /// The Voice row: Soniox, with the note that the Rarog server sets the voice.
  func sonioxVoice(language: CopyLanguage = .current) -> VoiceAgentSonioxVoice {
    VoiceAgentSonioxVoice(
      value: UICopy.voiceAgentVoiceSoniox(language: language),
      hint: UICopy.voiceAgentVoiceSonioxHint(language: language))
  }

  /// The Soniox reading speed options. A change applies from the next conversation.
  func speechSpeeds(language: CopyLanguage = .current) -> [VoiceAgentSpeechSpeedChoice] {
    VoiceAgentSettings.speechSpeeds.map { value in
      VoiceAgentSpeechSpeedChoice(
        value: value,
        label: UICopy.voiceAgentSpeechSpeedOption(
          value, normal: value == VoiceAgentSettings.defaultSpeechSpeed, language: language))
    }
  }

  var speechSpeed: Double { settings.speechSpeed }

  /// A picker choice; a value outside the list changes nothing (`VoiceAgentSettings.choose(speechSpeed:)`).
  func chooseSpeechSpeed(_ value: Double) {
    settings.choose(speechSpeed: value)
  }

  /// Stan przełącznika: włączone tylko po zgodzie.
  var isOn: Bool { settings.enabled }

  /// The keyboard shortcut section stands on the page only while the voice agent is on.
  var showsShortcut: Bool { isOn }

  /// Ruch przełącznika. Włączenie bez zgody pokazuje stronę zgody i niczego nie zapisuje; wyłączenie kasuje zgodę.
  func toggle(_ on: Bool) {
    if on {
      if !settings.enabled { consentShown = true }
    } else if settings.enabled {
      settings.disable()
    }
  }

  func acceptConsent() {
    settings.acceptConsent()
    consentShown = false
  }

  /// Powrót ze strony zgody bez zgody: przełącznik zostaje wyłączony.
  func cancelConsent() {
    consentShown = false
  }

  func summary(language: CopyLanguage = .current) -> VoiceAgentSettingsSummary {
    let value =
      settings.enabled ? UICopy.voiceAgentStateOn(language: language) : UICopy.voiceAgentStateOff(language: language)
    return VoiceAgentSettingsSummary(label: UICopy.voiceAgentTitle(language: language), value: value)
  }

  func consent(language: CopyLanguage = .current) -> VoiceAgentConsentContent {
    VoiceAgentConsentContent(
      title: UICopy.voiceAgentConsentTitle(language: language),
      paragraphs: UICopy.voiceAgentConsentParagraphs(language: language),
      accept: UICopy.voiceAgentConsentAccept(language: language),
      cancel: UICopy.voiceAgentConsentCancel(language: language))
  }
}
