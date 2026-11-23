import Foundation

// What the shortcut sheet writes to `client.log` (`RarogStore.trace`, the shared budget of 20 lines per hour) and how
// a combination splits into key caps. Pure logic without UIKit. A trace line names the place, the change and its
// reason, never a key code: the only keys it knows are the Cmd keys. Owner: shortcuts.

public enum ShortcutSheetTrace {
  /// Where the key events come from. The plan's open question is whether they reach the app with the focus in the
  /// prompt field and in the terminal; the first countdown at each place answers it.
  public static let source = "GCKeyboard key handler"

  /// The line of one change of the hold.
  public static func line(
    _ change: CommandHold.Change, place: ShortcutSheetPlace?, conditions: CommandHold.Conditions
  ) -> String {
    switch change {
    case .started: "shortcut sheet: countdown started at \(name(place)) (events: \(source))"
    case .shown: "shortcut sheet: shown at \(name(place))"
    case let .hidden(reason): "shortcut sheet: hidden at \(name(place)), \(phrase(reason, conditions))"
    case let .dropped(reason): "shortcut sheet: dropped at \(name(place)), \(phrase(reason, conditions))"
    }
  }

  /// The place as the trace names it.
  public static func name(_ place: ShortcutSheetPlace?) -> String {
    switch place {
    case .session?: "session"
    case .terminal?: "terminal"
    case .window?: "window"
    case nil: "no place"
    }
  }

  static func phrase(_ reason: CommandHold.Reason, _ conditions: CommandHold.Conditions) -> String {
    switch reason {
    case .commandReleased: "Cmd released"
    case .otherKey: "another key"
    case .notPressed: "the keyboard reports no Cmd down"
    case .noKeyboard: "no keyboard"
    case .blocked: "blocked: " + blockers(conditions).joined(separator: ", ")
    case .reset(.appInactive): "app inactive"
    case .reset(.windowResigned): "window not key"
    case .reset(.keyboardDisconnected): "keyboard disconnected"
    }
  }

  /// The conditions that stop the sheet now.
  static func blockers(_ conditions: CommandHold.Conditions) -> [String] {
    var found: [String] = []
    if !conditions.keyWindow { found.append("window not key") }
    if !conditions.loggedIn { found.append("logged out") }
    if conditions.switcherOpen { found.append("switcher open") }
    if conditions.onMac { found.append("Mac") }
    return found
  }
}

/// A combination as key caps: each modifier glyph its own cap, the rest one cap (`⇧⌘N` → ⇧ ⌘ N, `⌘1–8` → ⌘ 1–8,
/// `Esc` → Esc).
public enum ShortcutSheetKeycaps {
  static let modifiers: Set<Character> = ["⌃", "⌥", "⇧", "⌘"]

  public static func split(_ glyphs: String) -> [String] {
    var caps: [String] = []
    var rest = ""
    for glyph in glyphs {
      if rest.isEmpty, modifiers.contains(glyph) {
        caps.append(String(glyph))
      } else {
        rest.append(glyph)
      }
    }
    if !rest.isEmpty { caps.append(rest) }
    return caps
  }
}
