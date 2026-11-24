import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The session switcher window opened by a tap on the current tab: the window machine. Its rows are the tabs of the
// project (`ProjectTabRef`), kept live by the host. The window stays until Return, a tap or a close; with a
// hardware keyboard it takes it. The selection starts on the current tab. Times are counted from the constants in
// `SwitcherTiming`, not from numbers. Owner: shortcuts.

private typealias Effect = SwitcherMachine.Effect

/// A session tab.
private func s(_ id: String) -> ProjectTabRef { .session(id) }

@Suite("session switcher: window machine")
struct SessionSwitcherMachineTests {
  private let gap = SwitcherTiming.moveInterval

  /// The window opened at moment 0 on tabs cur, a, b with the hardware keyboard (by default), the current one first.
  private func opened(
    current: ProjectTabRef? = s("cur"), keyboard: Bool = true, tabs: [ProjectTabRef] = [s("cur"), s("a"), s("b")]
  ) -> SwitcherMachine {
    var machine = SwitcherMachine()
    _ = machine.openByTap(keyboard: keyboard, tabs: tabs, current: current, at: 0)
    return machine
  }

  @Test("a tap opens the window and takes the keyboard; the selection is the current tab, wherever it stands")
  func opening() {
    var machine = SwitcherMachine()
    let effects = machine.openByTap(keyboard: true, tabs: [s("cur"), s("a"), s("b")], current: s("cur"), at: 5)
    #expect(effects == [.watch(true), .takeKeyboard])
    #expect(machine.phase == .open(keyboard: true) && machine.opening == 1 && machine.holdsKeyboard)
    #expect(machine.order == [s("cur"), s("a"), s("b")] && machine.selected == s("cur") && machine.current == s("cur"))
    #expect(opened(current: s("b")).selected == s("b"), "the current tab in the middle of the bar")
    #expect(opened(current: .terminal("t1"), tabs: [s("a"), .terminal("t1")]).selected == .terminal("t1"))

    var touch = SwitcherMachine()
    #expect(touch.openByTap(keyboard: false, tabs: [s("a")], current: s("a"), at: 0) == [.watch(true)])
    #expect(touch.phase == .open(keyboard: false) && !touch.holdsKeyboard, "without a keyboard no focus")
    var noTab = SwitcherMachine()
    #expect(noTab.openByTap(keyboard: true, tabs: [s("a")], current: nil, at: 0) == [] && !noTab.isOpen,
            "no tab on screen (a terminal being opened): no window")
  }

  @Test("the window stays: no clock closes it, only a key, a tap or an event")
  func stays() {
    var machine = opened()
    _ = machine.key(.down, at: 60)
    #expect(machine.isOpen && machine.selected == s("a"))
  }

  @Test("down and up wrap around the ends")
  func keysWrap() {
    var machine = opened()
    _ = machine.key(.up, at: gap)
    #expect(machine.selected == s("b") && machine.order == [s("cur"), s("a"), s("b")], "up from the first row: the last")
    _ = machine.key(.down, at: 2 * gap)
    #expect(machine.selected == s("cur"), "down from the last row: the first one")
  }

  @Test("the window's keys: down and up move, Return jumps to the selection")
  func keys() {
    var machine = opened()
    #expect(machine.key(.down, at: gap) == [] && machine.selected == s("a"))
    #expect(machine.key(.down, at: 2 * gap) == [] && machine.selected == s("b"))
    #expect(machine.key(.up, at: 3 * gap) == [] && machine.selected == s("a"))
    #expect(machine.key(.confirm, at: 4 * gap) == [.releaseKeyboard(restore: false), .watch(false), .open(s("a"))])
    #expect(machine.phase == .idle)
    #expect(machine.key(.down, at: 5 * gap) == [], "keys after the close do nothing")
  }

  @Test("a move 50 ms after a move changes nothing; the held key repeat moves at most once per 100 ms")
  func moveThrottle() {
    var machine = opened()
    _ = machine.key(.down, at: gap)
    #expect(machine.selected == s("a") && machine.selectionSerial == 1)
    _ = machine.key(.down, at: gap + 0.05)
    #expect(machine.selected == s("a") && machine.selectionSerial == 1)
    var moves = 0
    var last = machine.selected
    for step in 1...32 {
      _ = machine.key(.down, at: gap + Double(step) * 0.031)
      if machine.selected != last { moves += 1 }
      last = machine.selected
    }
    #expect(moves == 8, "a second of 31 ms repeats: eight moves instead of thirty-two")
    var fresh = opened()
    _ = fresh.key(.down, at: 0.05)
    #expect(fresh.selected == s("cur"), "50 ms after the opening: no move either")
  }

  @Test("Return on the current tab (the selection at the opening): no jump, the window closes")
  func returnOnCurrent() {
    var machine = opened()
    #expect(machine.key(.confirm, at: 0) == [.releaseKeyboard(restore: true), .watch(false)])
    var alone = opened(tabs: [s("cur")])
    #expect(alone.selected == s("cur"))
    #expect(alone.key(.confirm, at: 1) == [.releaseKeyboard(restore: true), .watch(false)])
  }

  @Test(
    "Esc, Cmd+period, a tap outside and another menu shortcut close without a jump and give the caret back",
    arguments: [SwitcherMachine.Cancel.escapeKey, .outside, .otherCommand])
  func humanClose(reason: SwitcherMachine.Cancel) {
    var machine = opened()
    #expect(machine.cancel(reason, at: 1) == [.releaseKeyboard(restore: true), .watch(false)])
    #expect(machine.phase == .idle)
    var key = opened()
    #expect(key.key(.close, at: 1) == [.releaseKeyboard(restore: true), .watch(false)], "Esc key of the window")
  }

  @Test(
    "a screen change, a presentation, the scene, logout and a lost responder close without giving the caret back",
    arguments: [SwitcherMachine.Cancel.screenChange, .presentation, .sceneInactive, .loggedOut, .responderLost])
  func eventClose(reason: SwitcherMachine.Cancel) {
    var machine = opened()
    #expect(machine.cancel(reason, at: 1) == [.releaseKeyboard(restore: false), .watch(false)])
    var touch = opened(keyboard: false)
    #expect(touch.cancel(reason, at: 1) == [.watch(false)], "a window without the keyboard has none to give up")
    var idle = SwitcherMachine()
    #expect(idle.cancel(reason, at: 0) == [], "nothing to close")
  }

  @Test("Esc belongs to the switcher while the window is open — not after it")
  func absorbsEscape() {
    #expect(!SwitcherMachine().absorbsEscape)
    var machine = opened()
    #expect(machine.absorbsEscape)
    _ = machine.cancel(.escapeKey, at: 1)
    #expect(!machine.absorbsEscape, "no 300 ms window after the close")
    #expect(opened(keyboard: false).absorbsEscape, "also a window without the keyboard")
  }

  @Test("a tap on a row jumps at once, on the current one it only closes; a second tap on the tab does nothing")
  func taps() {
    var machine = opened()
    #expect(machine.tapRow(s("zzz"), at: 1) == [])
    #expect(machine.tapRow(s("b"), at: 1) == [.releaseKeyboard(restore: false), .watch(false), .open(s("b"))])
    var current = opened()
    #expect(current.tapRow(s("cur"), at: 1) == [.releaseKeyboard(restore: true), .watch(false)], "caret back")
    var here = opened(keyboard: false)
    #expect(here.tapRow(s("cur"), at: 1) == [.watch(false)])
    var terminal = opened(current: s("a"), tabs: [s("a"), .terminal("zsh")])
    #expect(terminal.tapRow(.terminal("zsh"), at: 1) == [.releaseKeyboard(restore: false), .watch(false),
                                                         .open(.terminal("zsh"))], "a terminal row")
    var standing = opened()
    #expect(standing.openByTap(keyboard: true, tabs: [s("x")], current: s("x"), at: 1) == [], "the window stands")
    #expect(standing.order == [s("cur"), s("a"), s("b")])
  }

  @Test("a keyboard connected at a window opened without one goes to the window, once; the selection stays")
  func keyboardConnectedLater() {
    var idle = SwitcherMachine()
    #expect(idle.keyboardConnected().isEmpty, "no window: nothing to take it")
    var machine = opened(keyboard: false)
    _ = machine.key(.down, at: gap)
    #expect(!machine.holdsKeyboard && machine.selected == s("a"))
    #expect(machine.keyboardConnected() == [.takeKeyboard])
    #expect(machine.holdsKeyboard && machine.selected == s("a"))
    #expect(machine.keyboardConnected().isEmpty, "the keyboard is taken once")
    machine.keyboardRefused()
    #expect(machine.phase == .open(keyboard: false), "UIKit refused: the window stays without it")
    var closed = opened(keyboard: false)
    _ = closed.cancel(.outside, at: 1)
    #expect(closed.keyboardConnected().isEmpty, "a closed window does not take it")
  }

  @Test("a new tab while the window stands comes in at its place on the bar; the selection stays on its tab")
  func tabAdded() {
    var machine = opened(current: s("b"), tabs: [s("a"), s("b"), s("c"), .terminal("zsh")])
    _ = machine.key(.down, at: gap)
    #expect(machine.selected == s("c"))
    let serial = machine.selectionSerial
    machine.tabsChanged([s("a"), s("b"), s("c"), s("d"), .terminal("zsh")])
    #expect(machine.order == [s("a"), s("b"), s("c"), s("d"), .terminal("zsh")], "d after c, before the terminals")
    #expect(machine.selected == s("c") && machine.selectionSerial == serial, "the selection did not move")
    _ = machine.key(.down, at: 2 * gap)
    #expect(machine.selected == s("d"), "the new row is a row of the window")
  }

  @Test("a closed tab leaves the window: the selection goes to the next row, from the last one to the previous one")
  func tabClosed() {
    var middle = opened()
    _ = middle.key(.down, at: gap)
    middle.tabsChanged([s("cur"), s("b")])
    #expect(middle.order == [s("cur"), s("b")] && middle.selected == s("b") && middle.selectionSerial == 2)
    var last = opened()
    _ = last.key(.down, at: gap)
    _ = last.key(.down, at: 2 * gap)
    last.tabsChanged([s("cur"), s("a")])
    #expect(last.order == [s("cur"), s("a")] && last.selected == s("a"))
    var other = opened()
    other.tabsChanged([s("cur"), s("b")])
    #expect(other.selected == s("cur") && other.selectionSerial == 0, "another tab closed: the selection stays")
    var idle = SwitcherMachine()
    idle.tabsChanged([s("a")])
    #expect(idle.order.isEmpty, "a closed window does not follow the bar")
  }

  @Test("each selection change has its own number: a quick a → b → a is two events for VoiceOver")
  func selectionSerial() {
    var machine = opened()
    let start = machine.selectionSerial
    _ = machine.key(.down, at: gap)
    let there = (machine.selected, machine.selectionSerial)
    _ = machine.key(.up, at: 2 * gap)
    let back = (machine.selected, machine.selectionSerial)
    #expect(there.0 == s("a") && back.0 == s("cur"))
    #expect(Set([start, there.1, back.1]).count == 3)
  }
}

@MainActor
@Suite("session switcher: clock and effects")
struct SessionSwitcherTests {
  /// A manual clock: the test moves the time itself.
  @MainActor
  final class Bench {
    var time: TimeInterval = 100
    var opened: [ProjectTabRef] = []
    var watching: [Bool] = []
    var keyboard: [String] = []
    var refuse = false
    let switcher = SessionSwitcher()

    init() {
      switcher.now = { [unowned self] in self.time }
      switcher.onOpen = { [unowned self] in self.opened.append($0) }
      switcher.onWatch = { [unowned self] in self.watching.append($0) }
      switcher.onTakeKeyboard = { [unowned self] in
        self.keyboard.append("take")
        return !self.refuse
      }
      switcher.onReleaseKeyboard = { [unowned self] in self.keyboard.append($0 ? "release+restore" : "release") }
    }
  }

  @Test("open, keys and Return go through the machine: watch, keyboard, jump")
  func flow() {
    let bench = Bench()
    bench.switcher.openByTap(keyboard: true, tabs: [s("tu"), s("a"), s("b")], current: s("tu"))
    #expect(bench.watching == [true] && bench.keyboard == ["take"] && bench.switcher.holdsKeyboard)
    #expect(bench.switcher.windowShown && bench.switcher.absorbsEscape)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.down)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.down)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.confirm)
    #expect(bench.opened == [s("b")] && bench.watching == [true, false] && bench.keyboard == ["take", "release"])
    #expect(!bench.switcher.windowShown && !bench.switcher.absorbsEscape)
  }

  @Test("Esc gives the caret back; a refused keyboard leaves the window open without it")
  func escapeAndRefusal() {
    let bench = Bench()
    bench.switcher.openByTap(keyboard: true, tabs: [s("a")], current: s("a"))
    bench.switcher.key(.close)
    #expect(bench.keyboard == ["take", "release+restore"] && bench.opened.isEmpty)

    let refused = Bench()
    refused.refuse = true
    refused.switcher.openByTap(keyboard: true, tabs: [s("a")], current: s("a"))
    #expect(refused.switcher.windowShown && !refused.switcher.holdsKeyboard)
    refused.switcher.cancel(.outside)
    #expect(refused.keyboard == ["take"], "nothing to give up")
  }

  @Test("a tap on a row and a change of the bar go through the machine")
  func tapAndSync() {
    let bench = Bench()
    bench.switcher.openByTap(keyboard: false, tabs: [s("tu"), s("a"), s("b")], current: s("tu"))
    bench.switcher.tabsChanged([s("tu"), s("b")])
    #expect(bench.switcher.machine.order == [s("tu"), s("b")] && bench.switcher.machine.selected == s("tu"))
    bench.switcher.tapRow(s("b"))
    #expect(bench.opened == [s("b")] && bench.watching == [true, false] && bench.keyboard.isEmpty)
  }

  /// The jump goes the way of a tap on the tab: a terminal row opens the terminal screen.
  @Test("picking the zsh row opens the terminal screen through openTab")
  func pickTerminalRow() {
    let state = switcherProject()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.selectSession("b")
    let bench = Bench()
    bench.switcher.onOpen = { tab in navigation.openTab(tab, state: state) }
    bench.switcher.openByTap(keyboard: false, tabs: navigation.tabRefs(state), current: navigation.currentTab(state))
    let zsh = navigation.tabRefs(state)[3]
    #expect(zsh == .terminal("00000000000000a1"))
    bench.switcher.tapRow(zsh)
    #expect(navigation.detail == .terminal("00000000000000a1"))
  }
}
