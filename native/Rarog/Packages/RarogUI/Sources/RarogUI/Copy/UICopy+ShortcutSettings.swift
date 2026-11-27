import Foundation
import RarogContract
import RarogCore

// Keyboard shortcuts in Settings: the shortcut section on the Dictation and Voice Agent pages, its row that listens
// for a new shortcut, and the refusals. The glyphs of a combination come from `AppShortcut.Combination`, outside the
// catalog. Owner: shortcuts.
extension UICopy {
  /// Footer without a hardware keyboard: the shortcut is only shown.
  public static var shortcutSettingsNoKeyboard: String { L("shortcutSettings.noKeyboard") }
  /// The shortcut's capsule while the row waits for a key press.
  public static var shortcutSettingsListening: String { L("shortcutSettings.listening") }
  /// VoiceOver hint of the shortcut's capsule.
  public static var shortcutSettingsChangeHint: String { L("shortcutSettings.changeHint") }
  /// The label of the button that gives the default back (an arrow in a circle next to the shortcut).
  public static var shortcutSettingsRestoreDefault: String { L("shortcutSettings.restoreDefault") }

  /// Header of the shortcut section on the Dictation and Voice Agent pages.
  static func shortcutSettingsHeader(language: CopyLanguage = .current) -> String {
    L("shortcutSettings.header", language: language)
  }

  /// Footer of the shortcut section on the Dictation and Voice Agent pages, with a hardware keyboard.
  static func shortcutSettingsHint(language: CopyLanguage = .current) -> String {
    L("shortcutSettings.hint", language: language)
  }

  /// The label of a shortcut row on its page: the action the shortcut starts and ends, so it does not repeat the
  /// page title.
  static func shortcutSettingsAction(_ shortcut: AppShortcut, language: CopyLanguage = .current) -> String {
    shortcut == .voiceAgent
      ? L("shortcutSettings.action.voiceAgent", language: language)
      : L("shortcutSettings.action.dictation", language: language)
  }

  /// One sentence under the shortcut row. The pages offer only changeable shortcuts, so `notConfigurable` does not
  /// reach it and shares the sentence of a taken combination.
  public static func shortcutSettingsRefusal(_ refusal: AppShortcutSettings.Refusal) -> String {
    switch refusal {
    case .needsModifier: L("shortcutSettings.refusal.needsModifier")
    case .needsLetterOrDigit: L("shortcutSettings.refusal.needsLetterOrDigit")
    case .system: L("shortcutSettings.refusal.system")
    case .taken, .notConfigurable: L("shortcutSettings.refusal.taken")
    }
  }
}
