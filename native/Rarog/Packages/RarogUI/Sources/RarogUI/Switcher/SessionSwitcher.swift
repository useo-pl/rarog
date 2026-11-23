import Foundation
import Observation
import RarogCore

// The session switcher under Cmd+S: the state machine of the window. No
// UIKit — keys, the clock and the jump come from outside, so the tests run on macOS. Owner: shortcuts.
//
// Cmd+S (or a tap on the current tab) opens the window with the selection on the first row (the session on screen)
// and the window STAYS until a human picks a row (Return, a digit, a tap), closes it (Esc, Cmd+., a tap outside,
// another menu shortcut) or something takes the screen away (a screen change, a presentation, the scene going
// inactive, logout, another responder taking the keyboard). With a hardware keyboard the window takes it
// (`SwitcherKeyResponder`): the arrows, S and Shift+S, the digits, Return and Esc belong to the window, with or
// without Cmd held, and nothing reaches the screen underneath.

/// Timing of the window.
public enum SwitcherTiming {
  /// The smallest gap between two moves of the selection. The system repeats a held key every 31 ms (32 times a
  /// second); the fastest presses by hand were 159 ms apart (measured on the iPad). Also eats a double
  /// command (the menu shortcut and the window's own one for the same press).
  public static let moveInterval: TimeInterval = 0.1
  /// After the window closes, Cmd+S commands that keep coming this close to each other are the repeats of a held
  /// key, not a new press: they do not open the window again.
  public static let repeatQuiet: TimeInterval = 0.3
}

/// A key of the window that holds the keyboard (`SwitcherKeyResponder`).
public enum SwitcherKey: Sendable, Equatable {
  /// Down arrow, S, Cmd+S, Cmd+down arrow.
  case down
  /// Up arrow, Shift+S, Shift+Cmd+S, Cmd+up arrow.
  case up
  /// Return, Cmd+Return.
  case confirm
  /// Esc, Cmd+period.
  case close
  /// 0–9 with or without Cmd: the row with that number (row 0 is the first one, the session on screen).
  case digit(Int)

  /// The inputs of the digit keys, "0" to "9".
  public static let digits = (0...9).map(String.init)
}

public struct SwitcherMachine: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    case idle
    /// The window is on screen; `keyboard`: it holds the hardware keyboard.
    case open(keyboard: Bool)
  }

  /// Why the window closes WITHOUT a jump.
  public enum Cancel: Sendable, Equatable {
    /// Esc or Cmd+period.
    case escapeKey
    /// A tap outside the window.
    case outside
    /// Another menu shortcut: the window closes and the shortcut does its own thing.
    case otherCommand
    case presentation
    case screenChange
    case sceneInactive
    case loggedOut
    /// Another responder took the keyboard from the window.
    case responderLost

    /// A human closed the window without picking a row: the keyboard goes back where it was.
    var restoresFocus: Bool { self == .escapeKey || self == .outside || self == .otherCommand }
  }

  public enum Effect: Sendable, Equatable {
    /// The window appeared (`true`) or closed: start or stop watching the presentation gate and the scene.
    case watch(Bool)
    /// The window takes the hardware keyboard.
    case takeKeyboard
    /// The window gives the keyboard up; `restore`: back to the responder from before the window.
    case releaseKeyboard(restore: Bool)
    /// Go to the session.
    case open(String)
  }

  public private(set) var phase: Phase = .idle
  /// Opening number; grows with every opening.
  public private(set) var opening = 0
  /// The snapshot: the order frozen at the opening (the words and dots of the rows stay live).
  public private(set) var order: [String] = []
  public private(set) var selected: String?
  /// The session on screen at the opening.
  public private(set) var current: String?
  /// Number of the selection change in this opening — with the opening number it gives VoiceOver a separate event
  /// for every change.
  public private(set) var selectionSerial = 0
  private var lastMoveAt: TimeInterval = 0
  /// Until then a command does not open the window (the repeats of a held Cmd+S after a close).
  private var quietUntil: TimeInterval = 0
  /// Until then Cmd+digit from the menu is swallowed: a digit has just closed the window, and the same press may come
  /// a second time through the other route (the window's key command and the tab shortcut of the menu).
  private var digitQuietUntil: TimeInterval = 0
  /// The digit that closed the window: only its second delivery is swallowed, never another tab shortcut.
  private var digitQuietNumber = -1

  public init() {}

  public var isOpen: Bool { phase != .idle }

  /// The window holds the hardware keyboard.
  public var holdsKeyboard: Bool { phase == .open(keyboard: true) }

  /// Esc and Cmd+period belong to the switcher while the window is open. The Esc receivers underneath (turn
  /// interrupt, card, terminal) ask this as a safety net — the window with the keyboard gets Esc first.
  public var absorbsEscape: Bool { isOpen }

  // MARK: - Opening

  /// Cmd+S (`backward == false`) or Shift+Cmd+S. In `idle` it opens the window; in `open` it moves the selection and,
  /// with a hardware keyboard, takes it if the window does not hold it yet. `snapshot` counts only at the opening.
  public mutating func command(
    backward: Bool, keyboard: Bool, snapshot: @autoclosure () -> [String], current: String?, at now: TimeInterval
  ) -> [Effect] {
    guard isOpen else {
      // The repeats of a held Cmd+S after a close do not open the window again until they stop.
      if now < quietUntil {
        quietUntil = now + SwitcherTiming.repeatQuiet
        return []
      }
      return start(snapshot: snapshot(), current: current, keyboard: keyboard, at: now)
    }
    var effects: [Effect] = []
    if keyboard, !holdsKeyboard {
      phase = .open(keyboard: true)
      effects.append(.takeKeyboard)
    }
    move(backward ? -1 : 1, at: now)
    return effects
  }

  /// A tap on the current tab: the window opens like Cmd+S; when it already stands, nothing happens.
  public mutating func openByTap(
    keyboard: Bool, snapshot: @autoclosure () -> [String], current: String?, at now: TimeInterval
  ) -> [Effect] {
    guard !isOpen else { return [] }
    return start(snapshot: snapshot(), current: current, keyboard: keyboard, at: now)
  }

  /// A new opening: the frozen order and the selection on the first row — the session on screen when the app knows
  /// it (Return there only closes), otherwise the newest visit. Shift+Cmd+S opens the same way; its next press moves
  /// up.
  private mutating func start(
    snapshot: [String], current: String?, keyboard: Bool, at now: TimeInterval
  ) -> [Effect] {
    opening += 1
    phase = .open(keyboard: keyboard)
    order = snapshot
    self.current = current
    selected = order.first
    selectionSerial = 0
    lastMoveAt = now
    return [.watch(true)] + (keyboard ? [.takeKeyboard] : [])
  }

  // MARK: - Keys of the window

  public mutating func key(_ key: SwitcherKey, at now: TimeInterval) -> [Effect] {
    guard isOpen else { return [] }
    switch key {
    case .down:
      move(1, at: now)
      return []
    case .up:
      move(-1, at: now)
      return []
    case .confirm:
      // No jump (the current session, nothing selected): the keyboard goes back where it was, like after Esc.
      guard let target = openTarget else { return finish(restore: true, at: now) }
      return finish(restore: false, at: now) + [.open(target)]
    case .close:
      return cancel(.escapeKey, at: now)
    case let .digit(number):
      // A digit without a row does nothing; the window stays.
      guard order.indices.contains(number) else { return [] }
      digitQuietUntil = now + SwitcherTiming.repeatQuiet
      digitQuietNumber = number
      return go(order[number], at: now)
    }
  }

  /// Cmd+1 to Cmd+9 from the app menu (the tab shortcuts). `nil`: not the window's — the tab shortcut does
  /// its own thing. With the window open the digit belongs to the window; right after a digit closed it, the same
  /// press of THAT digit coming through the menu as well is swallowed (and so are its repeats); another digit is a new
  /// tab shortcut, so it does not switch the tab under
  /// the jump.
  public mutating func menuDigit(_ number: Int, at now: TimeInterval) -> [Effect]? {
    if isOpen { return key(.digit(number), at: now) }
    guard number == digitQuietNumber, now < digitQuietUntil else { return nil }
    digitQuietUntil = now + SwitcherTiming.repeatQuiet
    return []
  }

  /// The selection one row down or up, wrapping, at most once per `moveInterval`.
  private mutating func move(_ delta: Int, at now: TimeInterval) {
    guard now - lastMoveAt >= SwitcherTiming.moveInterval - 0.001 else { return }
    lastMoveAt = now
    guard !order.isEmpty else { return }
    let next: String
    if let selected, let index = order.firstIndex(of: selected) {
      next = order[(index + delta + order.count) % order.count]
    } else {
      next = delta > 0 ? order[0] : order[order.count - 1]
    }
    guard next != selected else { return }
    selected = next
    selectionSerial += 1
  }

  /// UIKit refused the keyboard (the view has no window): the window stays without it.
  public mutating func keyboardRefused() {
    if holdsKeyboard { phase = .open(keyboard: false) }
  }

  // MARK: - Tap, cancel, list changes

  /// A tap or click on a row: the jump at once (the current session — only the close).
  public mutating func tapRow(_ id: String, at now: TimeInterval) -> [Effect] {
    guard isOpen, order.contains(id) else { return [] }
    return go(id, at: now)
  }

  /// The close with the jump to `id`; the current row only closes, so the keyboard goes back where it was.
  private mutating func go(_ id: String, at now: TimeInterval) -> [Effect] {
    id == current ? finish(restore: true, at: now) : finish(restore: false, at: now) + [.open(id)]
  }

  /// The close without a jump.
  public mutating func cancel(_ reason: Cancel, at now: TimeInterval) -> [Effect] {
    guard isOpen else { return [] }
    return finish(restore: reason.restoresFocus, at: now)
  }

  /// Sessions removed from the app leave the snapshot: the selection goes to the next row, from the last one to the
  /// previous one. New sessions do not come in.
  public mutating func sessionsChanged(existing: Set<String>) {
    guard isOpen, order.contains(where: { !existing.contains($0) }) else { return }
    if let gone = selected, !existing.contains(gone), let index = order.firstIndex(of: gone) {
      selected = order[(index + 1)...].first(where: existing.contains)
        ?? order[..<index].last(where: existing.contains)
      selectionSerial += 1
    }
    order = order.filter(existing.contains)
  }

  /// Where Return leads: the selected session, if it exists and is not the one on screen.
  private var openTarget: String? {
    guard let selected, selected != current, order.contains(selected) else { return nil }
    return selected
  }

  /// The close. The snapshot and the selection stay until the next opening.
  private mutating func finish(restore: Bool, at now: TimeInterval) -> [Effect] {
    let held = holdsKeyboard
    phase = .idle
    quietUntil = now + SwitcherTiming.repeatQuiet
    return (held ? [.releaseKeyboard(restore: restore)] : []) + [.watch(false)]
  }
}

/// The switcher for views and shortcuts: holds the machine, gives it the time and performs its effects.
@MainActor
@Observable
public final class SessionSwitcher {
  public private(set) var machine = SwitcherMachine()

  /// The jump to a session (the presentation gate and `selectSession` on the caller's side).
  @ObservationIgnored public var onOpen: ((String) -> Void)?
  /// Start and stop of watching the presentation gate and the scene.
  @ObservationIgnored public var onWatch: ((Bool) -> Void)?
  /// The window's key receiver takes the keyboard; `false` = UIKit refused.
  @ObservationIgnored public var onTakeKeyboard: (() -> Bool)?
  /// The window's key receiver gives the keyboard up; the flag: back to the responder from before the window.
  @ObservationIgnored public var onReleaseKeyboard: ((Bool) -> Void)?
  @ObservationIgnored var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

  public init() {}

  public var phase: SwitcherMachine.Phase { machine.phase }
  public var windowShown: Bool { machine.isOpen }
  public var holdsKeyboard: Bool { machine.holdsKeyboard }
  public var absorbsEscape: Bool { machine.absorbsEscape }

  /// Cmd+S or Shift+Cmd+S. `keyboard`: a hardware keyboard is connected; `snapshot` is read only at the opening.
  public func command(backward: Bool, keyboard: Bool, snapshot: @autoclosure () -> [String], current: String?) {
    run(machine.command(backward: backward, keyboard: keyboard, snapshot: snapshot(), current: current, at: now()))
  }

  /// A tap on the current tab.
  public func openByTap(keyboard: Bool, snapshot: @autoclosure () -> [String], current: String?) {
    run(machine.openByTap(keyboard: keyboard, snapshot: snapshot(), current: current, at: now()))
  }

  public func key(_ key: SwitcherKey) { run(machine.key(key, at: now())) }

  /// Cmd+1 to Cmd+9 from the app menu; `true`: the window took the digit and the tab shortcut stays silent.
  @discardableResult
  public func menuDigit(_ number: Int) -> Bool {
    guard let effects = machine.menuDigit(number, at: now()) else { return false }
    run(effects)
    return true
  }
  public func tapRow(_ id: String) { run(machine.tapRow(id, at: now())) }
  public func cancel(_ reason: SwitcherMachine.Cancel) { run(machine.cancel(reason, at: now())) }
  public func sessionsChanged(existing: Set<String>) { machine.sessionsChanged(existing: existing) }

  private func run(_ effects: [SwitcherMachine.Effect]) {
    for effect in effects {
      switch effect {
      case let .watch(on):
        onWatch?(on)
      case .takeKeyboard:
        if onTakeKeyboard?() != true { machine.keyboardRefused() }
      case let .releaseKeyboard(restore):
        onReleaseKeyboard?(restore)
      case let .open(id):
        onOpen?(id)
      }
    }
  }
}
