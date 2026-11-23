import Foundation

// When the shortcut sheet stands: Cmd held alone for 1.5 s shows it, releasing Cmd or pressing any other key hides it.
// Pure logic without UIKit; time is seconds of any monotonic clock that the caller passes in, so tests drive it with
// their own numbers. The caller feeds the key events (`receive`), asks the hold at `nextCheck` (`tick`, with the
// keyboard's own word on whether a Cmd is down and the conditions of the moment) and reports the app or the window
// going away (`reset`). Owner: shortcuts.

public struct CommandHold: Sendable, Equatable {
  /// How long Cmd must be held alone before the sheet shows.
  public static let threshold: TimeInterval = 1.5
  /// While the sheet stands, the keyboard is asked this often whether a Cmd is still down: a key-up can get lost.
  public static let checkInterval: TimeInterval = 0.25

  /// What else must hold for the sheet to show at the threshold and to stay.
  public struct Conditions: Sendable, Equatable {
    /// The app's window is the key window.
    public var keyWindow: Bool
    public var loggedIn: Bool
    /// The session switcher window is open (also when a tap opened it).
    public var switcherOpen: Bool
    /// The iOS app runs on a Mac (`isiOSAppOnMac`): the menu bar always lists the shortcuts there.
    public var onMac: Bool

    public init(keyWindow: Bool = true, loggedIn: Bool = true, switcherOpen: Bool = false, onMac: Bool = false) {
      self.keyWindow = keyWindow
      self.loggedIn = loggedIn
      self.switcherOpen = switcherOpen
      self.onMac = onMac
    }

    var allowSheet: Bool { keyWindow && loggedIn && !switcherOpen && !onMac }
  }

  /// The app or its window went away; after the return a new Cmd press is needed.
  public enum ResetReason: Sendable, Equatable {
    case appInactive
    case windowResigned
    case keyboardDisconnected
  }

  /// Why the sheet hid, or why a countdown ended without it (for the trace).
  public enum Reason: Sendable, Equatable {
    case commandReleased
    case otherKey
    /// The keyboard says neither Cmd is down: a key-up was lost.
    case notPressed
    /// No keyboard to ask.
    case noKeyboard
    /// The conditions do not allow the sheet (``Conditions``).
    case blocked
    case reset(ResetReason)
  }

  /// What a call changed.
  public enum Change: Sendable, Equatable {
    /// Cmd went down alone; the sheet shows at `due` unless something stops it.
    case started(due: TimeInterval)
    case shown
    case hidden(Reason)
    /// The countdown reached the threshold, but the sheet did not show.
    case dropped(Reason)
  }

  public private(set) var shown = false
  /// The Cmd keys held now.
  private var held: Set<CommandSide> = []
  /// Other keys held now, by HID usage: one held before Cmd means Cmd is not alone. A set, not a count, so the
  /// release of a key pressed before a reset cannot free a key pressed after it.
  private var othersDown: Set<Int> = []
  /// Start of the countdown of this hold; `nil` = none runs (shown, spoiled, or no Cmd).
  private var startedAt: TimeInterval?

  public init() {}

  /// When the countdown ends; `nil` = no countdown runs.
  public var due: TimeInterval? { startedAt.map { $0 + Self.threshold } }

  /// When to call ``tick(at:pressed:conditions:)`` next: the end of the countdown, or every ``checkInterval`` while
  /// the sheet stands; `nil` = nothing to ask.
  public func nextCheck(after now: TimeInterval) -> TimeInterval? {
    shown ? now + Self.checkInterval : due
  }

  public mutating func receive(_ event: CommandKeyEvent, at now: TimeInterval) -> Change? {
    switch event {
    case let .commandDown(side):
      // A repeat of a held Cmd, or the second Cmd: the hold goes on unchanged.
      guard held.isEmpty else {
        held.insert(side)
        return nil
      }
      held.insert(side)
      // A key held before Cmd (Shift, a letter): this hold never shows the sheet.
      guard othersDown.isEmpty else { return nil }
      startedAt = now
      return .started(due: now + Self.threshold)
    case let .commandUp(side):
      // A release the hold never saw go down (held across a reset) changes nothing.
      guard held.remove(side) != nil, held.isEmpty else { return nil }
      startedAt = nil
      return hide(.commandReleased)
    case let .otherKeyDown(usage):
      othersDown.insert(usage)
      // Any key with Cmd held ends this hold until Cmd is released (⌘S, ⌘1 and the rest work as before).
      startedAt = nil
      return hide(.otherKey)
    case let .otherKeyUp(usage):
      // A release the hold never saw go down (held across a reset) changes nothing.
      othersDown.remove(usage)
      return nil
    }
  }

  /// The timer at ``nextCheck(after:)``. `pressed`: whether the keyboard reports a Cmd down (`nil` = no keyboard).
  /// A timer of a countdown that has since ended, or that a newer one replaced, finds nothing due and does nothing.
  public mutating func tick(at now: TimeInterval, pressed: Bool?, conditions: Conditions) -> Change? {
    if shown {
      if let reason = Self.stop(pressed: pressed) {
        forget()
        return .hidden(reason)
      }
      guard conditions.allowSheet else { return hide(.blocked) }
      return nil
    }
    guard let due, now >= due else { return nil }
    startedAt = nil
    if let reason = Self.stop(pressed: pressed) {
      forget()
      return .dropped(reason)
    }
    guard conditions.allowSheet else { return .dropped(.blocked) }
    shown = true
    return .shown
  }

  /// The app went inactive, the window stopped being the key window or the keyboard went away: everything about the
  /// keys is forgotten, so a Cmd still held after the return does not count.
  public mutating func reset(_ reason: ResetReason) -> Change? {
    let wasShown = shown
    forget()
    return wasShown ? .hidden(.reset(reason)) : nil
  }

  private static func stop(pressed: Bool?) -> Reason? {
    switch pressed {
    case nil: .noKeyboard
    case false?: .notPressed
    case true?: nil
    }
  }

  /// Hides a standing sheet; the hold stays spoiled until every Cmd is released.
  private mutating func hide(_ reason: Reason) -> Change? {
    guard shown else { return nil }
    shown = false
    return .hidden(reason)
  }

  /// The keyboard state is no longer known: forget the held keys, a new Cmd press starts over.
  private mutating func forget() {
    shown = false
    held = []
    othersDown = []
    startedAt = nil
  }
}
