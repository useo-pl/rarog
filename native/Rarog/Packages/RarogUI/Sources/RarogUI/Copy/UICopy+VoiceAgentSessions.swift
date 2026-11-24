import Foundation
import RarogContract
import RarogCore

// Copy of the voice conversation across sessions: its switch on the Voice Agent page, its consent page (App Store
// 5.1.2(i)) and the consent sheet from the session list. The voice agent's own consent: `UICopy+VoiceAgent.swift`;
// the states and end sentences shared with the conversation at a session: `UICopy+VoiceAgentSession.swift`.
// Owner: voice agent.

extension UICopy {
  /// The switch label in Settings and the VoiceOver label of the list button.
  static func voiceAgentSessionsTitle(language: CopyLanguage = .current) -> String {
    L("voiceAgent.sessions.title", language: language)
  }
  static func voiceAgentSessionsLead(language: CopyLanguage = .current) -> String {
    L("voiceAgent.sessions.lead", language: language)
  }

  // MARK: Consent

  static func voiceAgentSessionsConsentTitle(language: CopyLanguage = .current) -> String {
    L("voiceAgent.sessions.consent.title", language: language)
  }
  /// Paragraphs in order: what goes to OpenAI on top of the voice agent's consent, what goes to Soniox, and that a
  /// prompt goes to a session only on the user's word.
  static func voiceAgentSessionsConsentParagraphs(language: CopyLanguage = .current) -> [String] {
    [
      L("voiceAgent.sessions.consent.sent", language: language),
      L("voiceAgent.sessions.consent.speech", language: language),
      L("voiceAgent.sessions.consent.prompts", language: language),
    ]
  }
  /// The accept button of the consent sheet from the session list: the consent starts the conversation.
  static func voiceAgentSessionsConsentStart(language: CopyLanguage = .current) -> String {
    L("voiceAgent.sessions.consent.start", language: language)
  }
  static func voiceAgentSessionsConsentClose(language: CopyLanguage = .current) -> String {
    L("voiceAgent.sessions.consent.close", language: language)
  }

  // MARK: End sentence and prompt card

  /// VoiceOver label of the end sentence's line; the end sentence is its value.
  static var voiceAgentSessionsBarSpoken: String { L("voiceAgent.sessions.bar.spoken") }
  static var voiceAgentSessionsBarDismissHint: String { L("voiceAgent.sessions.bar.dismissHint") }
  /// VoiceOver label of the card of the waiting prompt; the prompt's whole text is its value.
  static func voiceAgentSessionsBarPromptSpoken(project: String, name: String) -> String {
    L("voiceAgent.sessions.bar.promptSpoken", project, name)
  }

  // MARK: Prompt

  /// The question that opens the caption of the waiting prompt's card under the list header; the prompt's project
  /// and session name follow it.
  static var voiceAgentSessionsPromptQuestion: String { L("voiceAgent.sessions.header.promptQuestion") }

  /// What the app reads aloud before a prompt can go to a session: the project and the session name as the list gave
  /// them to the model, then the exact text the send sends.
  static func voiceAgentSessionsPromptReading(project: String, name: String, text: String) -> String {
    L("voiceAgent.sessions.promptReading", project, name, text)
  }
}
