import Foundation
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Skrót klawiszowy apki w JEDNYM miejscu: klawisz, modyfikatory i glify, z których
/// czytają rejestracje (menu poleceń `RarogCommands`, skróty arkuszy, dyktowanie) i podpowiedź przycisku „Nazwa (⌘B)”
/// (`ShortcutTipLine`, dymek `ShortcutTip`). Podpowiedź skrótu nie rejestruje: klawisz obsługuje dalej jego własna
/// rejestracja (polecenie menu, `UIKeyCommand` ekranu sesji, niewidoczny przycisk arkusza). Literały, które zostały
/// w plikach ekranu sesji (⌘X, Return, Esc), pilnuje zgodności `AppShortcutTests`.
///
/// Glify nie wchodzą do katalogu tekstów (`docs/localization.md`): „⌘N” czyta się tak samo w każdym języku.
/// Dictation and the voice agent take the combination chosen in Settings (``AppShortcutSettings``); the others keep
/// their default. Właściciel: skróty.
public enum AppShortcut: String, CaseIterable, Sendable {
  // Menu poleceń sceny (działa wszędzie, także nad arkuszem).
  case newSession, newTerminal, toggleList, toggleInspector, previousProject, nextSession, previousSession, toggleRead
  case popupShell, popupLazygit, note
  /// The app's text size (`TextScale`): ⌘+ (registered as ⌘= and ⇧⌘=), ⌘- and ⌘0.
  case textBigger, textSmaller, textActualSize
  // Ekran sesji i terminal.
  case closeTab, dictation, voiceAgent, send, stop, terminalHistory
  // Arkusze.
  case dismissSheet, closeSheet, launchSession

  /// Klawisz bez modyfikatorów.
  public enum Key: Hashable, Sendable {
    case character(Character)
    case returnKey
    case escape
  }

  /// Modyfikatory w kolejności glifów Apple: ⌃⌥⇧⌘.
  public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let control = Modifiers(rawValue: 1 << 0)
    public static let option = Modifiers(rawValue: 1 << 1)
    public static let shift = Modifiers(rawValue: 1 << 2)
    public static let command = Modifiers(rawValue: 1 << 3)
  }

  /// Gdzie skrót działa. Menu apki (`app`) działa wszędzie, więc nie może dzielić kombinacji z nikim; pozostałe
  /// miejsca nie działają naraz (Esc ekranu sesji i Esc arkusza to dwa różne skróty).
  public enum Scope: Hashable, Sendable {
    case app, session, terminal, sheet
  }

  /// A key and its modifiers.
  public struct Combination: Hashable, Sendable {
    public let key: Key
    public let modifiers: Modifiers

    /// A letter key is stored lowercased, so a key captured with Shift (“D”) is the same combination as “d”.
    public init(key: Key, modifiers: Modifiers) {
      if case let .character(letter) = key, let lower = letter.lowercased().first {
        self.key = .character(lower)
      } else {
        self.key = key
      }
      self.modifiers = modifiers
    }

    /// “⇧⌘N”, “⌥⌘M”, “⌘↩”, “Esc”.
    public var glyphs: String { AppShortcut.glyphs(key: key, modifiers: modifiers) }

    /// The SwiftUI registration of the combination.
    public var keyboardShortcut: KeyboardShortcut {
      var events: EventModifiers = []
      if modifiers.contains(.control) { events.insert(.control) }
      if modifiers.contains(.option) { events.insert(.option) }
      if modifiers.contains(.shift) { events.insert(.shift) }
      if modifiers.contains(.command) { events.insert(.command) }
      switch key {
      case let .character(letter): return KeyboardShortcut(KeyEquivalent(letter), modifiers: events)
      case .returnKey: return KeyboardShortcut(.return, modifiers: events)
      case .escape: return events.isEmpty ? .cancelAction : KeyboardShortcut(.escape, modifiers: events)
      }
    }

    /// Key input for `UIKeyCommand` (“x”, “\r”, Escape).
    public var input: String {
      switch key {
      case let .character(letter): String(letter)
      case .returnKey: "\r"
      case .escape: "\u{1B}"
      }
    }
  }

  /// The combination in force: the one chosen in Settings for a changeable shortcut (``AppShortcutSettings``),
  /// otherwise the default.
  public var combination: Combination { AppShortcutSettings.shared.combination(for: self) }

  public var key: Key { combination.key }

  public var modifiers: Modifiers { combination.modifiers }

  /// The combination the app ships with.
  public var defaultCombination: Combination { Combination(key: defaultKey, modifiers: defaultModifiers) }

  private var defaultKey: Key {
    switch self {
    case .newSession, .newTerminal: .character("n")
    case .toggleList: .character("b")
    case .toggleInspector: .character("i")
    case .previousProject: .character("l")
    case .nextSession, .previousSession: .character("s")
    case .toggleRead: .character("u")
    case .popupShell: .character("f")
    case .popupLazygit: .character("g")
    case .note: .character("j")
    case .textBigger: .character("=")
    case .textSmaller: .character("-")
    case .textActualSize: .character("0")
    case .closeTab: .character("x")
    case .dictation: .character("m")
    case .voiceAgent: .character("v")
    case .terminalHistory: .character("y")
    case .closeSheet: .character("w")
    case .send, .launchSession: .returnKey
    case .stop, .dismissSheet: .escape
    }
  }

  private var defaultModifiers: Modifiers {
    switch self {
    case .newTerminal, .previousSession, .toggleRead: [.shift, .command]
    // ⌥⌘M, nie ⌘M: gołe ⌘M od iPadOS 26 to systemowe „Zminimalizuj okno” i wygrywa ze skrótem apki mimo
    // `wantsPriorityOverSystemBehavior` (zmierzone w symulatorze).
    case .dictation: [.option, .command]
    // ⌥⌘V next to ⌥⌘M: V for voice; no app or iPadOS shortcut uses it (⇧⌥⌘V is the Mac's paste and match style).
    case .voiceAgent: [.option, .command]
    case .send, .stop, .dismissSheet: []
    default: .command
    }
  }

  public var scopes: Set<Scope> {
    switch self {
    case .newSession, .newTerminal, .toggleList, .toggleInspector, .previousProject, .nextSession, .previousSession,
      .toggleRead, .popupShell, .popupLazygit, .note, .textBigger, .textSmaller, .textActualSize:
      [.app]
    // ⌘X zamyka zakładkę sesji (`SessionViewController+KeysTabs`) i terminal (`TerminalKeyMap`).
    case .closeTab: [.session, .terminal]
    // Dictation also works in the note form (`NoteSheet`), a sheet with ⌘W, Esc and Return of its own.
    case .dictation: [.session, .sheet]
    case .voiceAgent, .send, .stop: [.session]
    case .terminalHistory: [.terminal]
    case .dismissSheet, .closeSheet, .launchSession: [.sheet]
    }
  }

  /// Dwa skróty mogą działać w tej samej chwili: wspólne miejsce albo któryś z menu apki.
  public func overlaps(_ other: AppShortcut) -> Bool {
    scopes.contains(.app) || other.scopes.contains(.app) || !scopes.isDisjoint(with: other.scopes)
  }

  /// „⇧⌘N”, „⌥⌘M”, „⌘↩”, „Esc”. Make Text Bigger shows “⌘+”, as on the key cap and in other apps, though it is
  /// registered as ⌘= (``alternateCombinations`` adds ⇧⌘=).
  public var glyphs: String { self == .textBigger ? "⌘+" : combination.glyphs }

  /// Further combinations registered for the same command: ⇧⌘= (the “+” key with Shift) for Make Text Bigger, which
  /// UIKit does not match against the ⌘= command.
  public var alternateCombinations: [Combination] {
    self == .textBigger ? [Combination(key: .character("="), modifiers: [.shift, .command])] : []
  }

  public static func glyphs(key: Key, modifiers: Modifiers) -> String {
    let marks: [(Modifiers, String)] = [(.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")]
    let prefix = marks.filter { modifiers.contains($0.0) }.map(\.1).joined()
    let name =
      switch key {
      case let .character(letter): letter.uppercased()
      case .returnKey: "↩"
      case .escape: "Esc"
      }
    return prefix + name
  }

  /// Wejście klawisza dla `UIKeyCommand` („x”, „\r”, Escape).
  public var input: String { combination.input }

  /// Rejestracja SwiftUI (`.keyboardShortcut(AppShortcut.x.keyboardShortcut)`). Esc bez modyfikatorów to systemowa
  /// akcja anulowania (`.cancelAction`), jak w arkuszach.
  public var keyboardShortcut: KeyboardShortcut { combination.keyboardShortcut }

  #if os(iOS)
  /// Modyfikatory dla `UIKeyCommand`.
  public var keyModifierFlags: UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    if modifiers.contains(.control) { flags.insert(.control) }
    if modifiers.contains(.option) { flags.insert(.alternate) }
    if modifiers.contains(.shift) { flags.insert(.shift) }
    if modifiers.contains(.command) { flags.insert(.command) }
    return flags
  }
  #endif
}

/// Wiersz podpowiedzi przycisku: nazwa akcji i jej skróty („Zamknij (Esc, ⌘W)”). Menu „+” ma wiersz na pozycję.
public struct ShortcutTipLine: Equatable, Sendable {
  public let name: String
  public let shortcuts: [AppShortcut]

  public init(_ name: String, _ shortcuts: AppShortcut...) {
    self.name = name
    self.shortcuts = shortcuts
  }

  public var text: String { UICopy.shortcutHelp(name, shortcuts) }

  /// Tekst dymka: wiersz pod wierszem.
  public static func text(_ lines: [ShortcutTipLine]) -> String {
    lines.map(\.text).joined(separator: "\n")
  }
}

/// Stan dymka podpowiedzi bez UIKit (czas w sekundach dowolnego zegara monotonicznego). Dymek staje po chwili
/// spoczynku kursora nad przyciskiem, znika przy wyjściu kursora i przy naciśnięciu, a po naciśnięciu nie wraca, dopóki
/// kursor nie wyjdzie. Zdarzenia kursora daje wyłącznie wskaźnik (gładzik, mysz): palec ich nie wysyła, więc dotyk
/// dymka nie wywołuje.
public struct ShortcutTipState: Equatable, Sendable {
  /// Chwila spoczynku przed dymkiem.
  public static let rest: TimeInterval = 0.6

  public private(set) var shown = false
  /// Ostatni ruch kursora nad przyciskiem przed pokazaniem; `nil` = kursora nie ma albo dymek stoi.
  private var restingSince: TimeInterval?
  private var pressedInside = false

  public init() {}

  /// Chwila, w której dymek powinien stanąć, gdy kursor się nie ruszy; `nil` = nic do odliczania.
  public var due: TimeInterval? { restingSince.map { $0 + Self.rest } }

  public mutating func pointerMoved(at now: TimeInterval) {
    guard !pressedInside, !shown else { return }
    restingSince = now
  }

  public mutating func pointerExited() {
    restingSince = nil
    shown = false
    pressedInside = false
  }

  public mutating func pressed() {
    restingSince = nil
    shown = false
    pressedInside = true
  }

  /// Sprawdzenie zegara: stawia dymek po spoczynku, zwraca, czy stoi.
  @discardableResult
  public mutating func tick(at now: TimeInterval) -> Bool {
    if let due, now >= due {
      shown = true
      restingSince = nil
    }
    return shown
  }
}
