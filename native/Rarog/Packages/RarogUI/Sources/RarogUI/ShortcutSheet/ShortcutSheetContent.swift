import Foundation
import RarogContract

// What the shortcut sheet lists: groups of rows (a label and one or two key combinations), the group that works where
// the focus is ("You're here") and three columns for the rest. Pure logic without UIKit; the view only draws it.
// Combinations come from `AppShortcut`; the only literal combinations (the tab digits, Copy and Paste) stand in
// `ShortcutSheetCombo`. Owner: shortcuts.

/// Where the focus is when the sheet shows (``RarogNavigation/shortcutSheetPlace(_:)``).
public enum ShortcutSheetPlace: Sendable, Hashable {
  /// A session screen: the prompt field or the transcript.
  case session
  /// A terminal screen or the terminal window.
  case terminal
  /// A sheet or a form over the screen.
  case window
}

/// What the app offers now. A row whose feature is missing drops; a row that is only silent for a moment (under a
/// sheet, without a project) stays.
public struct ShortcutSheetCapabilities: Sendable, Equatable {
  /// The server has project notes (⌘J).
  public var notes: Bool
  /// The server has the terminal (⇧⌘N, ⌘F, ⌘G and the terminal group).
  public var terminal: Bool
  /// The voice agent is on and offered (⌥⌘V).
  public var voiceAgent: Bool
  /// An iPad in regular width: the session list and the inspector can be toggled (⌘B, ⌘I).
  public var wideIPad: Bool

  public init(notes: Bool = false, terminal: Bool = false, voiceAgent: Bool = false, wideIPad: Bool = false) {
    self.notes = notes
    self.terminal = terminal
    self.voiceAgent = voiceAgent
    self.wideIPad = wideIPad
  }
}

/// A key combination of a row.
public enum ShortcutSheetCombo: Sendable, Hashable {
  case app(AppShortcut)
  /// ⌘1–8: the tab at that position (`RarogCommands`).
  case tabs
  /// ⌘9: the last tab.
  case lastTab
  /// ⌘C and ⌘V in the terminal (system Copy and Paste).
  case copy
  case paste

  /// Glyphs as on the key caps; the same in every language.
  public var glyphs: String {
    switch self {
    case let .app(shortcut): shortcut.glyphs
    case .tabs: "⌘1–8"
    case .lastTab: "⌘9"
    case .copy: "⌘C"
    case .paste: "⌘V"
    }
  }
}

public struct ShortcutSheetContent: Sendable, Equatable {
  public enum GroupKind: Sendable, Hashable, CaseIterable {
    case sessionsAndProject, tabsAndView, messageAndVoice, terminal, windows

    /// The rows of the group in order.
    var items: [Item] {
      switch self {
      case .sessionsAndProject:
        [.newSession, .newTerminal, .nextSession, .previousSession, .previousProject, .toggleRead, .note]
      case .tabsAndView:
        [.tabs, .lastTab, .closeTab, .toggleList, .toggleInspector, .popupShell, .popupLazygit, .textBigger,
         .textSmaller, .textActualSize]
      case .messageAndVoice: [.send, .stop, .dictation, .voiceAgent]
      case .terminal: [.terminalHistory, .closeTerminal, .copy, .paste]
      case .windows: [.launchSession, .closeWindow]
      }
    }
  }

  /// One row of the sheet.
  public enum Item: Sendable, Hashable, CaseIterable {
    case newSession, newTerminal, nextSession, previousSession, previousProject, toggleRead, note
    case tabs, lastTab, closeTab, toggleList, toggleInspector, popupShell, popupLazygit
    case textBigger, textSmaller, textActualSize
    case send, stop, dictation, voiceAgent
    case terminalHistory, closeTerminal, copy, paste
    case launchSession, closeWindow

    /// One or two combinations; the second one is joined by “or”.
    public var combos: [ShortcutSheetCombo] {
      switch self {
      case .newSession: [.app(.newSession)]
      case .newTerminal: [.app(.newTerminal)]
      case .nextSession: [.app(.nextSession)]
      case .previousSession: [.app(.previousSession)]
      case .previousProject: [.app(.previousProject)]
      case .toggleRead: [.app(.toggleRead)]
      case .note: [.app(.note)]
      case .tabs: [.tabs]
      case .lastTab: [.lastTab]
      case .closeTab, .closeTerminal: [.app(.closeTab)]
      case .toggleList: [.app(.toggleList)]
      case .toggleInspector: [.app(.toggleInspector)]
      case .popupShell: [.app(.popupShell)]
      case .popupLazygit: [.app(.popupLazygit)]
      case .textBigger: [.app(.textBigger)]
      case .textSmaller: [.app(.textSmaller)]
      case .textActualSize: [.app(.textActualSize)]
      case .send: [.app(.send)]
      case .stop: [.app(.stop)]
      case .dictation: [.app(.dictation)]
      case .voiceAgent: [.app(.voiceAgent)]
      case .terminalHistory: [.app(.terminalHistory)]
      case .copy: [.copy]
      case .paste: [.paste]
      case .launchSession: [.app(.launchSession)]
      case .closeWindow: [.app(.dismissSheet), .app(.closeSheet)]
      }
    }

    /// The app shortcuts of the row.
    public var shortcuts: [AppShortcut] {
      combos.compactMap { combo in
        if case let .app(shortcut) = combo { return shortcut }
        return nil
      }
    }

    /// Whether the feature behind the row exists now.
    func offered(_ capabilities: ShortcutSheetCapabilities) -> Bool {
      switch self {
      case .note: capabilities.notes
      case .newTerminal, .popupShell, .popupLazygit, .terminalHistory, .closeTerminal, .copy, .paste:
        capabilities.terminal
      case .voiceAgent: capabilities.voiceAgent
      case .toggleList, .toggleInspector: capabilities.wideIPad
      case .newSession, .nextSession, .previousSession, .previousProject, .toggleRead, .tabs, .lastTab, .closeTab,
        .send, .stop, .dictation, .launchSession, .closeWindow, .textBigger, .textSmaller, .textActualSize:
        true
      }
    }
  }

  public struct Row: Sendable, Equatable {
    public let item: Item
    public let label: String
    /// Glyphs of one or two combinations.
    public let combos: [String]
  }

  public struct Group: Sendable, Equatable {
    public let kind: GroupKind
    public let title: String
    public let rows: [Row]
  }

  public let title: String
  /// “Release ⌘ to close”.
  public let releaseHint: String
  /// The label over ``here``.
  public let hereTitle: String
  /// The word between two combinations of a row.
  public let or: String
  /// The group that works where the focus is; `nil` without a place or when the group is empty.
  public let here: Group?
  /// Column 1: sessions and project; column 2: tabs and view; column 3: message and voice, terminal and windows,
  /// without the ``here`` group. Empty groups are left out.
  public let columns: [[Group]]

  public init(place: ShortcutSheetPlace?, capabilities: ShortcutSheetCapabilities, language: CopyLanguage = .current) {
    func group(_ kind: GroupKind) -> Group? {
      let rows = kind.items.filter { $0.offered(capabilities) }.map { item in
        Row(item: item, label: UICopy.shortcutSheetLabel(item, language: language), combos: item.combos.map(\.glyphs))
      }
      guard !rows.isEmpty else { return nil }
      return Group(kind: kind, title: UICopy.shortcutSheetGroupTitle(kind, language: language), rows: rows)
    }
    let hereKind = place.map(Self.hereGroup)
    title = UICopy.shortcutSheetTitle(language: language)
    releaseHint = UICopy.shortcutSheetReleaseHint(language: language)
    hereTitle = UICopy.shortcutSheetHere(language: language)
    or = UICopy.shortcutSheetOr(language: language)
    here = hereKind.flatMap(group)
    columns = [
      [GroupKind.sessionsAndProject], [.tabsAndView],
      [GroupKind.messageAndVoice, .terminal, .windows].filter { $0 != hereKind },
    ].map { $0.compactMap(group) }
  }

  /// The group of the place: the prompt field and voice at a session, the terminal, or the window shortcuts.
  static func hereGroup(_ place: ShortcutSheetPlace) -> GroupKind {
    switch place {
    case .session: .messageAndVoice
    case .terminal: .terminal
    case .window: .windows
    }
  }
}
