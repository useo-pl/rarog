import Foundation
import Observation
import RarogCore

// The session switcher window: its state machine. No UIKit — keys, the clock and the jump come from outside, so the
// tests run on macOS. Owner: shortcuts.
//
// Only a tap on the current tab opens the window; it has no keyboard shortcut. Its rows are the tabs of the current
// project in the order of the bar (`ProjectTabRef`: a session or a terminal), kept live by the host
// (`tabsChanged`). It opens with the selection on the current tab and STAYS until a human picks a row (Return, a digit, a tap), closes it (Esc,
// Cmd+., a tap outside, a menu shortcut) or something takes the screen away (a screen change, a presentation, the
// scene going inactive, logout, another responder taking the keyboard). With a hardware keyboard, connected at the
// opening or while the window stands, the window takes it (`SwitcherKeyResponder`): the arrows, the digits, Return
// and Esc belong to the window, with or without Cmd held, and nothing reaches the screen underneath.

/// Timing of the window.
public enum SwitcherTiming {
  /// The smallest gap between two moves of the selection. The system repeats a held key every 31 ms (32 times a
  /// second); the fastest presses by hand were 159 ms apart (measured on the iPad).
  public static let moveInterval: TimeInterval = 0.1
  /// After a digit closes the window, the same Cmd+digit coming through the menu this close to it is the same press
  /// (or its repeat), not a new tab shortcut.
  public static let repeatQuiet: TimeInterval = 0.3
}

/// A key of the window that holds the keyboard (`SwitcherKeyResponder`).
public enum SwitcherKey: Sendable, Equatable {
  /// Down arrow, Cmd+down arrow.
  case down
  /// Up arrow, Cmd+up arrow.
  case up
  /// Return, Cmd+Return.
  case confirm
  /// Esc, Cmd+period.
  case close
  /// 1–9 with or without Cmd: the row whose tab carries that digit on the bar; 9 is the last row
  /// (`SwitcherRows.tab(forDigit:in:)`).
  case digit(Int)

  /// The inputs of the digit keys, "1" to "9". No 0: Cmd+0 is the app's text size reset.
  public static let digits = (1...9).map(String.init)
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
    /// Go to the tab.
    case open(ProjectTabRef)
  }

  public private(set) var phase: Phase = .idle
  /// Opening number; grows with every opening.
  public private(set) var opening = 0
  /// The tabs of the bar, live (`tabsChanged`).
  public private(set) var order: [ProjectTabRef] = []
  public private(set) var selected: ProjectTabRef?
  /// The tab on screen at the opening; a screen change closes the window, so it holds while the window stands.
  public private(set) var current: ProjectTabRef?
  /// Number of the selection change in this opening — with the opening number it gives VoiceOver a separate event
  /// for every change.
  public private(set) var selectionSerial = 0
  private var lastMoveAt: TimeInterval = 0
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

  /// A tap on the current tab: the window opens; when it already stands, nothing happens. `keyboard`: a hardware
  /// keyboard is connected, so the window takes it. `tabs`: the tabs of the bar (`RarogNavigation.tabRefs`);
  /// `current`: the tab on screen (`RarogNavigation.currentTab`). Without a current tab (a terminal being opened has
  /// no id yet, the project screen has no tab) the window does not open.
  public mutating func openByTap(
    keyboard: Bool, tabs: [ProjectTabRef], current: ProjectTabRef?, at now: TimeInterval
  ) -> [Effect] {
    guard !isOpen, let current else { return [] }
    return start(tabs: tabs, current: current, keyboard: keyboard, at: now)
  }

  /// A new opening: the selection on the current tab (Return there only closes), the first row if the bar lacks it.
  private mutating func start(
    tabs: [ProjectTabRef], current: ProjectTabRef, keyboard: Bool, at now: TimeInterval
  ) -> [Effect] {
    opening += 1
    phase = .open(keyboard: keyboard)
    order = tabs
    self.current = current
    selected = tabs.contains(current) ? current : tabs.first
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
      // No jump (the current tab, nothing selected): the keyboard goes back where it was, like after Esc.
      guard let target = openTarget else { return finish(restore: true, at: now) }
      return finish(restore: false, at: now) + [.open(target)]
    case .close:
      return cancel(.escapeKey, at: now)
    case let .digit(number):
      // A digit without a row does nothing; the window stays.
      guard let target = SwitcherRows.tab(forDigit: number, in: order) else { return [] }
      digitQuietUntil = now + SwitcherTiming.repeatQuiet
      digitQuietNumber = number
      return go(target, at: now)
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
    let next: ProjectTabRef
    if let selected, let index = order.firstIndex(of: selected) {
      next = order[(index + delta + order.count) % order.count]
    } else {
      next = delta > 0 ? order[0] : order[order.count - 1]
    }
    guard next != selected else { return }
    selected = next
    selectionSerial += 1
  }

  /// A hardware keyboard connected while the window stands without it: the window takes it, once.
  public mutating func keyboardConnected() -> [Effect] {
    guard isOpen, !holdsKeyboard else { return [] }
    phase = .open(keyboard: true)
    return [.takeKeyboard]
  }

  /// UIKit refused the keyboard (the view has no window): the window stays without it.
  public mutating func keyboardRefused() {
    if holdsKeyboard { phase = .open(keyboard: false) }
  }

  // MARK: - Tap, cancel, list changes

  /// A tap or click on a row: the jump at once (the current tab — only the close).
  public mutating func tapRow(_ tab: ProjectTabRef, at now: TimeInterval) -> [Effect] {
    guard isOpen, order.contains(tab) else { return [] }
    return go(tab, at: now)
  }

  /// The close with the jump to `tab`; the current row only closes, so the keyboard goes back where it was.
  private mutating func go(_ tab: ProjectTabRef, at now: TimeInterval) -> [Effect] {
    tab == current ? finish(restore: true, at: now) : finish(restore: false, at: now) + [.open(tab)]
  }

  /// The close without a jump.
  public mutating func cancel(_ reason: Cancel, at now: TimeInterval) -> [Effect] {
    guard isOpen else { return [] }
    return finish(restore: reason.restoresFocus, at: now)
  }

  /// The tabs of the bar changed while the window stands: the rows follow the bar (a new tab comes in at its place).
  /// The selection stays on its tab; when its tab is gone it goes to the next row that is still there, from the last
  /// one to the previous one.
  public mutating func tabsChanged(_ tabs: [ProjectTabRef]) {
    guard isOpen, tabs != order else { return }
    if let gone = selected, !tabs.contains(gone) {
      var neighbour: ProjectTabRef?
      if let index = order.firstIndex(of: gone) {
        neighbour = order[(index + 1)...].first(where: tabs.contains) ?? order[..<index].last(where: tabs.contains)
      }
      selected = neighbour ?? tabs.first
      selectionSerial += 1
    }
    order = tabs
  }

  /// Where Return leads: the selected tab, if it is still a row and not the one on screen.
  private var openTarget: ProjectTabRef? {
    guard let selected, selected != current, order.contains(selected) else { return nil }
    return selected
  }

  /// The close. The rows and the selection stay until the next opening.
  private mutating func finish(restore: Bool, at now: TimeInterval) -> [Effect] {
    let held = holdsKeyboard
    phase = .idle
    return (held ? [.releaseKeyboard(restore: restore)] : []) + [.watch(false)]
  }
}

/// The switcher for views and shortcuts: holds the machine, gives it the time and performs its effects.
@MainActor
@Observable
public final class SessionSwitcher {
  public private(set) var machine = SwitcherMachine()

  /// The jump to a tab (the presentation gate and `RarogNavigation.openTab` on the caller's side).
  @ObservationIgnored public var onOpen: ((ProjectTabRef) -> Void)?
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

  /// A tap on the current tab. `keyboard`: a hardware keyboard is connected; `tabs`: the tabs of the bar.
  public func openByTap(keyboard: Bool, tabs: [ProjectTabRef], current: ProjectTabRef?) {
    run(machine.openByTap(keyboard: keyboard, tabs: tabs, current: current, at: now()))
  }

  public func key(_ key: SwitcherKey) { run(machine.key(key, at: now())) }

  /// A hardware keyboard connected while the window stands (`SwitcherWatch`).
  public func keyboardConnected() { run(machine.keyboardConnected()) }

  /// Cmd+1 to Cmd+9 from the app menu; `true`: the window took the digit and the tab shortcut stays silent.
  @discardableResult
  public func menuDigit(_ number: Int) -> Bool {
    guard let effects = machine.menuDigit(number, at: now()) else { return false }
    run(effects)
    return true
  }
  public func tapRow(_ tab: ProjectTabRef) { run(machine.tapRow(tab, at: now())) }
  public func cancel(_ reason: SwitcherMachine.Cancel) { run(machine.cancel(reason, at: now())) }
  public func tabsChanged(_ tabs: [ProjectTabRef]) { machine.tabsChanged(tabs) }

  private func run(_ effects: [SwitcherMachine.Effect]) {
    for effect in effects {
      switch effect {
      case let .watch(on):
        onWatch?(on)
      case .takeKeyboard:
        if onTakeKeyboard?() != true { machine.keyboardRefused() }
      case let .releaseKeyboard(restore):
        onReleaseKeyboard?(restore)
      case let .open(tab):
        onOpen?(tab)
      }
    }
  }
}
