import Foundation
import RarogContract
import RarogCore

// The switch of the voice conversation across sessions on the Voice Agent page. Owner: voice agent. Without UIKit, so
// `swift test` checks it on macOS (`VoiceAgentSettingsModelTests`). The rules of the two consents live in
// `VoiceAgentSettings` (RarogCore); the owner of the conversation ends a running one when the mode's consent goes.
//
// The switch stands where the server offers the mode, also while the voice agent is off, so a mode's consent kept then
// can still be removed; the mode runs only with both consents (`VoiceAgentSettings.sessionsAllowed`). Turning it on
// opens the mode's consent page and stores nothing; "Agree and Turn On" stores the consent and does not start a conversation (that
// starts from the session list). Turning it off removes the mode's consent.

extension VoiceAgentSettingsModel {
  /// The switch of the conversation across sessions stands on the page: the server offers the mode (`offered`,
  /// `AppState.companionSessionsOffered`).
  func showsSessions(offered: Bool) -> Bool {
    offered
  }

  /// State of the switch: on only with the mode's consent.
  var sessionsIsOn: Bool { settings.sessionsEnabled }

  /// A move of the switch. On without the mode's consent shows its consent page and stores nothing; off removes the
  /// consent, so a running conversation across sessions ends by its owner's rule.
  func toggleSessions(_ on: Bool) {
    if on {
      if !settings.sessionsEnabled { sessionsConsentShown = true }
    } else if settings.sessionsEnabled {
      settings.withdrawSessionsConsent()
    }
  }

  func acceptSessionsConsent() {
    settings.acceptSessionsConsent()
    sessionsConsentShown = false
  }

  /// Back from the mode's consent page without consent: the switch stays off.
  func cancelSessionsConsent() {
    sessionsConsentShown = false
  }

  /// The mode's consent page as Settings shows it: accepting turns the switch on.
  func sessionsConsent(language: CopyLanguage = .current) -> VoiceAgentConsentContent {
    VoiceAgentConsentContent(
      title: UICopy.voiceAgentSessionsConsentTitle(language: language),
      paragraphs: UICopy.voiceAgentSessionsConsentParagraphs(language: language),
      accept: UICopy.voiceAgentConsentAccept(language: language),
      cancel: UICopy.voiceAgentConsentCancel(language: language))
  }
}
