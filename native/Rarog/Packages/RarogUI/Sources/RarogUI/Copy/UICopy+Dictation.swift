import Foundation
import RarogContract
import RarogCore

// Copy of the Dictation screen: the choice between system dictation (Apple speech recognition) and Soniox through the
// user's server, each option's description with its consent, the Soniox option states with the server setup steps,
// the Settings row and the recorder sentences for each `DictationFailure` (`VoiceNotice.dictation`). The privacy
// policy (`ProductLinks.privacyDictation`) and Soniox console (`ProviderLinks.sonioxConsole`) addresses are not
// copy, and neither are the server commands (`ServerCommand`).

extension UICopy {
  // MARK: Ekran

  static func dictationTitle(language: CopyLanguage = .current) -> String { L("dictation.title", language: language) }
  static func dictationClose(language: CopyLanguage = .current) -> String { L("dictation.close", language: language) }
  static func dictationLead(language: CopyLanguage = .current) -> String { L("dictation.lead", language: language) }
  static func dictationSelected(language: CopyLanguage = .current) -> String {
    L("dictation.selected", language: language)
  }
  static func dictationPrivacy(language: CopyLanguage = .current) -> String {
    L("dictation.privacy", language: language)
  }

  // MARK: Opcja systemowa

  static func dictationSystemTitle(language: CopyLanguage = .current) -> String {
    L("dictation.system.title", language: language)
  }
  /// Description and consent: on the device when the language has a speech model, otherwise Apple's servers; nothing
  /// to the Rarog server. No Soniox name: it also stands in a build without Soniox (`RAROG_VOICE_SONIOX = NO`).
  static func dictationSystemSummary(language: CopyLanguage = .current) -> String {
    L("dictation.system.summary", language: language)
  }
  static func dictationSystemChoose(language: CopyLanguage = .current) -> String {
    L("dictation.system.choose", language: language)
  }

  // MARK: Opcja Soniox

  static func dictationSonioxTitle(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.title", language: language)
  }
  /// Description and consent: provider, EU region, only the microphone audio straight to Soniox, key on the server.
  static func dictationSonioxSummary(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.summary", language: language)
  }
  static func dictationSonioxChoose(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.choose", language: language)
  }
  /// Sonda wersji jeszcze nie odpowiedziała.
  static func dictationSonioxChecking(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.checking", language: language)
  }
  /// Neutralnie: stan obejmuje brak klucza, `RAROG_VOICE=0`, tryb recenzji i klucz odrzucony przez Soniox.
  static func dictationSonioxUnavailable(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.unavailable", language: language)
  }
  /// Step 1 under the "not available" state: a project in the EU region at console.soniox.com and its API key.
  static func dictationSonioxSetupKey(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.setup.key", language: language)
  }
  /// Step 2: the sentence over the server commands.
  static func dictationSonioxSetupRun(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.setup.run", language: language)
  }
  static func dictationSonioxSetupLink(language: CopyLanguage = .current) -> String {
    L("dictation.soniox.setup.link", language: language)
  }

  // MARK: Wiersz Ustawień

  static func dictationSettingsNone(language: CopyLanguage = .current) -> String {
    L("dictation.settingsNone", language: language)
  }

  // MARK: Błędy rozpoznawania mowy (nagrywarka)

  /// Zdanie w wierszu dyktowania, gdy rozpoznawanie mowy Apple nie ruszyło albo przerwało nagranie: co się stało
  /// i co zrobić. Przycisk „Ustawienia” dokłada gospodarz według `VoiceNotice.opensSettings`.
  static func dictationFailure(_ failure: DictationFailure, language: CopyLanguage = .current) -> String {
    switch failure {
    case .speechDenied: L("dictation.failure.speechDenied", language: language)
    case .speechRestricted: L("dictation.failure.speechRestricted", language: language)
    case .localeUnsupported: L("dictation.failure.localeUnsupported", language: language)
    case .assetsMissing: L("dictation.failure.assetsMissing", language: language)
    case .appleServerUnreachable: L("dictation.failure.appleServerUnreachable", language: language)
    case .dictationDisabled: L("dictation.failure.dictationDisabled", language: language)
    case .engineFailed: L("dictation.failure.engineFailed", language: language)
    }
  }
}
