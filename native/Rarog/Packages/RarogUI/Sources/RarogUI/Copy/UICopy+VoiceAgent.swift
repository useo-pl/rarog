import Foundation
import RarogContract
import RarogCore

// Copy of the voice agent: the Settings row and page, the setup steps of a server without the voice agent (the OpenAI
// keys address in `ProviderLinks`, the commands in `ServerCommand`) and the consent page (App Store 5.1.2(i)).

extension UICopy {
  static func voiceAgentTitle(language: CopyLanguage = .current) -> String { L("voiceAgent.title", language: language) }
  static func voiceAgentLead(language: CopyLanguage = .current) -> String { L("voiceAgent.lead", language: language) }
  /// The locked-phone trial switch on the same page and its footnote.
  static func voiceAgentLockedTrialTitle(language: CopyLanguage = .current) -> String {
    L("voiceAgent.lockedTrial.title", language: language)
  }
  static func voiceAgentLockedTrialLead(language: CopyLanguage = .current) -> String {
    L("voiceAgent.lockedTrial.lead", language: language)
  }

  // MARK: Wiersz Ustawień

  static func voiceAgentStateOff(language: CopyLanguage = .current) -> String {
    L("voiceAgent.state.off", language: language)
  }
  static func voiceAgentStateOn(language: CopyLanguage = .current) -> String {
    L("voiceAgent.state.on", language: language)
  }
  /// The server answered without the voice agent: the row leads to the setup steps.
  static func voiceAgentStateNotSetUp(language: CopyLanguage = .current) -> String {
    L("voiceAgent.state.notSetUp", language: language)
  }

  // MARK: Setup steps (server without the voice agent)

  static func voiceAgentSetupLead(language: CopyLanguage = .current) -> String {
    L("voiceAgent.setup.lead", language: language)
  }
  /// Only while dictation with Soniox does not work on the server: the agent speaks with the Soniox voice.
  static func voiceAgentSetupSoniox(language: CopyLanguage = .current) -> String {
    L("voiceAgent.setup.soniox", language: language)
  }
  static func voiceAgentSetupKey(language: CopyLanguage = .current) -> String {
    L("voiceAgent.setup.key", language: language)
  }
  /// The sentence over the server commands.
  static func voiceAgentSetupRun(language: CopyLanguage = .current) -> String {
    L("voiceAgent.setup.run", language: language)
  }
  static func voiceAgentSetupLink(language: CopyLanguage = .current) -> String {
    L("voiceAgent.setup.link", language: language)
  }

  // MARK: Zgoda

  static func voiceAgentConsentTitle(language: CopyLanguage = .current) -> String {
    L("voiceAgent.consent.title", language: language)
  }
  /// Akapity w kolejności: co idzie do OpenAI, dokąd, gdzie żyje klucz, koszt i limit konta.
  /// The Soniox paragraph stands after "where": the answer text goes to Soniox in the EU (consent version 3, 4).
  static func voiceAgentConsentParagraphs(language: CopyLanguage = .current) -> [String] {
    [
      L("voiceAgent.consent.sent", language: language), L("voiceAgent.consent.where", language: language),
      L("voiceAgent.consent.speech", language: language),
      L("voiceAgent.consent.key", language: language), L("voiceAgent.consent.cost", language: language),
    ]
  }
  static func voiceAgentConsentAccept(language: CopyLanguage = .current) -> String {
    L("voiceAgent.consent.accept", language: language)
  }
  static func voiceAgentConsentCancel(language: CopyLanguage = .current) -> String {
    L("voiceAgent.consent.cancel", language: language)
  }

  // MARK: Głos

  static func voiceAgentVoice(language: CopyLanguage = .current) -> String { L("voiceAgent.voice", language: language) }
  static func voiceAgentVoiceSoniox(language: CopyLanguage = .current) -> String {
    L("voiceAgent.voice.soniox", language: language)
  }
  static func voiceAgentVoiceSonioxHint(language: CopyLanguage = .current) -> String {
    L("voiceAgent.voice.sonioxHint", language: language)
  }

  // MARK: Reading speed (Soniox)

  static func voiceAgentSpeechSpeed(language: CopyLanguage = .current) -> String {
    L("voiceAgent.speechSpeed", language: language)
  }
  /// One option of the picker: the multiplier with one decimal in the app language ("1,2×", "1.2×"); the normal
  /// speed carries "(normal)".
  static func voiceAgentSpeechSpeedOption(_ speed: Double, normal: Bool, language: CopyLanguage = .current) -> String {
    let number = speed.formatted(.number.precision(.fractionLength(1)).locale(language.locale))
    return normal
      ? L("voiceAgent.speechSpeed.normal", language: language, number)
      : L("voiceAgent.speechSpeed.value", language: language, number)
  }
}
