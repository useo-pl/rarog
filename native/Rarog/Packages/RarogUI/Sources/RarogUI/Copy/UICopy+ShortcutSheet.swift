import Foundation
import RarogContract

// The shortcut sheet under a held Cmd (`ShortcutSheet/`): title, hint, group titles and row labels. Every text takes
// the language, so tests read both. A row label reuses the key of the menu command or button when its text fits.
// Owner: shortcuts.
extension UICopy {
  static func shortcutSheetTitle(language: CopyLanguage = .current) -> String {
    L("shortcutSheet.title", language: language)
  }

  static func shortcutSheetReleaseHint(language: CopyLanguage = .current) -> String {
    L("shortcutSheet.releaseHint", language: language)
  }

  static func shortcutSheetHere(language: CopyLanguage = .current) -> String {
    L("shortcutSheet.here", language: language)
  }

  static func shortcutSheetOr(language: CopyLanguage = .current) -> String {
    L("shortcutSheet.or", language: language)
  }

  static func shortcutSheetGroupTitle(
    _ kind: ShortcutSheetContent.GroupKind, language: CopyLanguage = .current
  ) -> String {
    switch kind {
    case .sessionsAndProject: L("shortcutSheet.group.sessions", language: language)
    case .tabsAndView: L("shortcutSheet.group.tabs", language: language)
    case .messageAndVoice: L("shortcutSheet.group.message", language: language)
    case .terminal: L("terminal.title", language: language)
    case .windows: L("shortcutSheet.group.windows", language: language)
    }
  }

  static func shortcutSheetLabel(_ item: ShortcutSheetContent.Item, language: CopyLanguage = .current) -> String {
    switch item {
    case .newSession: L("shortcuts.newSession", language: language)
    case .newTerminal: L("terminal.newTerminal", language: language)
    case .previousProject: L("shortcuts.previousProject", language: language)
    case .toggleRead: L("shortcuts.readToggle", language: language)
    case .note: L("notes.shortcut", language: language)
    case .tabs: L("shortcutSheet.tabs", language: language)
    case .lastTab: L("shortcuts.lastTab", language: language)
    case .closeTab: L("shortcuts.closeTab", language: language)
    case .toggleList: L("shortcutSheet.toggleList", language: language)
    case .toggleInspector: L("shortcutSheet.toggleInspector", language: language)
    case .popupShell: L("terminal.shortcutPopupShell", language: language)
    case .popupLazygit: L("terminal.shortcutPopupLazygit", language: language)
    case .textBigger: L("textSize.bigger", language: language)
    case .textSmaller: L("textSize.smaller", language: language)
    case .textActualSize: L("textSize.actualSize", language: language)
    case .send: L("composer.send", language: language)
    case .stop: L("composer.shortcutInterrupt", language: language)
    case .dictation: L("composer.shortcutDictation", language: language)
    case .voiceAgent: L("shortcutSheet.voiceAgent", language: language)
    case .terminalHistory: L("terminal.history", language: language)
    case .closeTerminal: L("terminal.close", language: language)
    case .copy: L("terminal.copy", language: language)
    case .paste: L("terminal.paste", language: language)
    case .launchSession: L("shortcutSheet.launchSession", language: language)
    case .closeWindow: L("shortcutSheet.closeWindow", language: language)
    }
  }
}
