import Foundation
import RarogContract
import RarogCore

// Keyboard shortcuts in Settings: the shortcut section on the Dictation and Voice Agent pages, the page that records
// a new shortcut and its refusals. The glyphs of a combination come from `AppShortcut.Combination`, outside the
// catalog. Owner: shortcuts.
extension UICopy {
  public static var shortcutSettingsLead: String { L("shortcutSettings.lead") }
  public static var shortcutSettingsNoKeyboard: String { L("shortcutSettings.noKeyboard") }
  public static var shortcutSettingsCurrent: String { L("shortcutSettings.current") }
  public static var shortcutSettingsNew: String { L("shortcutSettings.new") }
  public static var shortcutSettingsSave: String { L("shortcutSettings.save") }
  public static var shortcutSettingsRestoreDefault: String { L("shortcutSettings.restoreDefault") }

  /// Header of the shortcut section on the Dictation and Voice Agent pages.
  static func shortcutSettingsHeader(language: CopyLanguage = .current) -> String {
    L("shortcutSettings.header", language: language)
  }

  /// Footer of the shortcut section on the Dictation and Voice Agent pages.
  static func shortcutSettingsFooter(language: CopyLanguage = .current) -> String {
    L("shortcutSettings.footer", language: language)
  }

  /// The label of a shortcut row on its page: the action the shortcut starts and ends, so it does not repeat the
  /// page title.
  static func shortcutSettingsAction(_ shortcut: AppShortcut, language: CopyLanguage = .current) -> String {
    shortcut == .voiceAgent
      ? L("shortcutSettings.action.voiceAgent", language: language)
      : L("shortcutSettings.action.dictation", language: language)
  }

  /// The name of a changeable shortcut: the title of the page that records it.
  public static func shortcutSettingsName(_ shortcut: AppShortcut) -> String {
    shortcut == .voiceAgent ? voiceAgentTitle() : dictationTitle()
  }

  /// One sentence under the field. The page offers only changeable shortcuts, so `notConfigurable` does not reach it
  /// and shares the sentence of a taken combination.
  public static func shortcutSettingsRefusal(_ refusal: AppShortcutSettings.Refusal) -> String {
    switch refusal {
    case .needsModifier: L("shortcutSettings.refusal.needsModifier")
    case .needsLetterOrDigit: L("shortcutSettings.refusal.needsLetterOrDigit")
    case .system: L("shortcutSettings.refusal.system")
    case .taken, .notConfigurable: L("shortcutSettings.refusal.taken")
    }
  }
}
