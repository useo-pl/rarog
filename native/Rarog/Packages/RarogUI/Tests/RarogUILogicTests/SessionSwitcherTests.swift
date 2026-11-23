import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The session switcher under Cmd+S: the window machine. The window stays
// until Return, a digit, a tap or a close; with a hardware keyboard it takes it. The selection starts on the first row. Times are counted from the constants in
// `SwitcherTiming`, not from numbers. Owner: shortcuts.

private typealias Effect = SwitcherMachine.Effect

@Suite("session switcher: window machine")
struct SessionSwitcherMachineTests {
  private let gap = SwitcherTiming.moveInterval

  /// The window opened at moment 0 on cur, a, b with the hardware keyboard (by default).
  private func opened(
    current: String? = "cur", keyboard: Bool = true, backward: Bool = false, order: [String] = ["cur", "a", "b"]
  ) -> SwitcherMachine {
    var machine = SwitcherMachine()
    _ = machine.command(backward: backward, keyboard: keyboard, snapshot: order, current: current, at: 0)
    return machine
  }

  @Test("Cmd+S opens the window and takes the keyboard; the selection is the first row, the current session")
  func opening() {
    var machine = SwitcherMachine()
    let effects = machine.command(backward: false, keyboard: true, snapshot: ["cur", "a", "b"], current: "cur", at: 5)
    #expect(effects == [.watch(true), .takeKeyboard])
    #expect(machine.phase == .open(keyboard: true) && machine.opening == 1 && machine.holdsKeyboard)
    #expect(machine.order == ["cur", "a", "b"] && machine.selected == "cur" && machine.current == "cur")
    #expect(opened(current: nil, order: ["a", "b"]).selected == "a", "nothing on screen: the first row")
    #expect(opened(backward: true).selected == "cur", "Shift+Cmd+S from idle: the first row too")

    var touch = SwitcherMachine()
    #expect(touch.command(backward: false, keyboard: false, snapshot: ["a"], current: nil, at: 0) == [.watch(true)])
    #expect(touch.phase == .open(keyboard: false) && !touch.holdsKeyboard, "without a keyboard no focus")
  }

  @Test("the window stays: no clock closes it, only a key, a tap or an event")
  func stays() {
    var machine = opened()
    _ = machine.key(.down, at: 60)
    #expect(machine.isOpen && machine.selected == "a")
  }

  @Test("second Cmd+S moves down, Shift+Cmd+S up, with wrapping; the snapshot stays")
  func commandsMove() {
    var machine = opened()
    #expect(machine.command(backward: false, keyboard: true, snapshot: ["x"], current: "x", at: gap) == [])
    #expect(machine.selected == "a" && machine.order == ["cur", "a", "b"])
    _ = machine.command(backward: true, keyboard: true, snapshot: [], current: nil, at: 2 * gap)
    #expect(machine.selected == "cur")
    _ = machine.command(backward: true, keyboard: true, snapshot: [], current: nil, at: 3 * gap)
    #expect(machine.selected == "b", "wrapping")
  }

  @Test("the window's keys: down and up move, Return jumps to the selection")
  func keys() {
    var machine = opened()
    #expect(machine.key(.down, at: gap) == [] && machine.selected == "a")
    #expect(machine.key(.down, at: 2 * gap) == [] && machine.selected == "b")
    #expect(machine.key(.up, at: 3 * gap) == [] && machine.selected == "a")
    #expect(machine.key(.confirm, at: 4 * gap) == [.releaseKeyboard(restore: false), .watch(false), .open("a")])
    #expect(machine.phase == .idle)
    #expect(machine.key(.down, at: 5 * gap) == [], "keys after the close do nothing")
  }

  @Test("a move 50 ms after a move changes nothing; the held key repeat moves at most once per 100 ms")
  func moveThrottle() {
    var machine = opened()
    _ = machine.key(.down, at: gap)
    #expect(machine.selected == "a" && machine.selectionSerial == 1)
    _ = machine.key(.down, at: gap + 0.05)
    #expect(machine.selected == "a" && machine.selectionSerial == 1)
    _ = machine.key(.down, at: 0.05)
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
    #expect(fresh.selected == "cur", "50 ms after the opening: no move either")
  }

  @Test("Return on the current session (the selection at the opening): no jump, the window closes")
  func returnOnCurrent() {
    var machine = opened()
    #expect(machine.selected == "cur")
    #expect(machine.key(.confirm, at: 0) == [.releaseKeyboard(restore: true), .watch(false)])
    var alone = opened(order: ["cur"])
    #expect(alone.selected == "cur")
    #expect(alone.key(.confirm, at: 1) == [.releaseKeyboard(restore: true), .watch(false)])
    var empty = opened(current: nil, order: [])
    #expect(empty.selected == nil && empty.isOpen)
    #expect(empty.key(.confirm, at: 1) == [.releaseKeyboard(restore: true), .watch(false)], "empty: Return closes")
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

  @Test("the repeats of a held Cmd+S after a close do not open the window again; a fresh press after silence does")
  func repeatAfterClose() {
    var machine = opened()
    _ = machine.cancel(.escapeKey, at: 0.26)
    var at = 0.276
    while at < 1.2 {
      #expect(machine.command(backward: false, keyboard: true, snapshot: ["cur", "a"], current: "cur", at: at) == [])
      at += 0.031
    }
    #expect(machine.phase == .idle && machine.opening == 1)
    _ = machine.command(backward: false, keyboard: true, snapshot: ["cur", "a"], current: "cur", at: at + 0.4)
    #expect(machine.isOpen && machine.opening == 2)
  }

  @Test("a tap on a row jumps at once, on the current one it only closes; a tap on the current tab opens like Cmd+S")
  func taps() {
    var machine = opened()
    #expect(machine.tapRow("zzz", at: 1) == [])
    #expect(machine.tapRow("b", at: 1) == [.releaseKeyboard(restore: false), .watch(false), .open("b")])
    var current = opened()
    #expect(current.tapRow("cur", at: 1) == [.releaseKeyboard(restore: true), .watch(false)], "caret back")
    var here = opened(keyboard: false)
    #expect(here.tapRow("cur", at: 1) == [.watch(false)])

    var tab = SwitcherMachine()
    #expect(tab.openByTap(keyboard: false, snapshot: ["cur", "a"], current: "cur", at: 0) == [.watch(true)])
    #expect(tab.phase == .open(keyboard: false) && tab.selected == "cur")
    #expect(tab.openByTap(keyboard: true, snapshot: ["x"], current: nil, at: 1) == [], "the window already stands")
    var withKeyboard = SwitcherMachine()
    #expect(withKeyboard.openByTap(keyboard: true, snapshot: ["a"], current: nil, at: 0) == [.watch(true), .takeKeyboard])
  }

  @Test("Cmd+S at a window opened by touch takes the keyboard once it is connected")
  func commandTakesKeyboardLater() {
    var machine = opened(keyboard: false)
    #expect(machine.command(backward: false, keyboard: false, snapshot: [], current: nil, at: gap) == [])
    #expect(!machine.holdsKeyboard && machine.selected == "a")
    #expect(machine.command(backward: false, keyboard: true, snapshot: [], current: nil, at: 2 * gap) == [.takeKeyboard])
    #expect(machine.holdsKeyboard && machine.selected == "b")
    #expect(machine.command(backward: false, keyboard: true, snapshot: [], current: nil, at: 3 * gap) == [],
            "the keyboard is taken once")
    machine.keyboardRefused()
    #expect(machine.phase == .open(keyboard: false), "UIKit refused: the window stays without it")
  }

  @Test("a removed session leaves the snapshot: the selection goes to the next row, from the last one up")
  func removedSessions() {
    var middle = opened()
    _ = middle.key(.down, at: gap)
    middle.sessionsChanged(existing: ["cur", "b"])
    #expect(middle.order == ["cur", "b"] && middle.selected == "b" && middle.selectionSerial == 2)
    var last = opened()
    _ = last.key(.down, at: gap)
    _ = last.key(.down, at: 2 * gap)
    last.sessionsChanged(existing: ["cur", "a"])
    #expect(last.order == ["cur", "a"] && last.selected == "a")
    var all = opened()
    all.sessionsChanged(existing: [])
    #expect(all.order.isEmpty && all.selected == nil)
    #expect(all.key(.confirm, at: 1) == [.releaseKeyboard(restore: true), .watch(false)])
  }

  @Test("each selection change has its own number: a quick a → b → a is two events for VoiceOver")
  func selectionSerial() {
    var machine = opened()
    let start = machine.selectionSerial
    _ = machine.key(.down, at: gap)
    let there = (machine.selected, machine.selectionSerial)
    _ = machine.key(.up, at: 2 * gap)
    let back = (machine.selected, machine.selectionSerial)
    #expect(there.0 == "a" && back.0 == "cur")
    #expect(Set([start, there.1, back.1]).count == 3)
  }

  // MARK: - Digits

  /// Five rows: the current session and four visited ones.
  private let five = ["cur", "a", "b", "c", "d"]

  @Test("digit 3 at five rows: the jump to row 3 and the close, like Return on it")
  func digitJumps() {
    var machine = opened(order: five)
    #expect(machine.key(.digit(3), at: 0) == [.releaseKeyboard(restore: false), .watch(false), .open("c")])
    #expect(machine.phase == .idle)
    var touch = opened(keyboard: false, order: five)
    #expect(touch.key(.digit(1), at: 0) == [.watch(false), .open("a")], "a window without the keyboard")
  }

  @Test("digit 7 at five rows: nothing, the window stays open with the same selection")
  func digitWithoutRow() {
    var machine = opened(order: five)
    #expect(machine.key(.digit(7), at: 0) == [])
    #expect(machine.isOpen && machine.holdsKeyboard && machine.selected == "cur" && machine.selectionSerial == 0)
    var empty = opened(current: nil, order: [])
    #expect(empty.key(.digit(0), at: 0) == [] && empty.isOpen, "an empty window: no row 0 either")
  }

  @Test("0 closes like Return on the current session: the caret back, no jump; without a current session it jumps")
  func digitZero() {
    var machine = opened(order: five)
    #expect(machine.key(.digit(0), at: 0) == [.releaseKeyboard(restore: true), .watch(false)])
    var nothingOnScreen = opened(current: nil, order: ["a", "b"])
    #expect(nothingOnScreen.key(.digit(0), at: 0) == [.releaseKeyboard(restore: false), .watch(false), .open("a")])
  }

  @Test("a digit works right after the opening and after a move: no move throttle, the row by its number")
  func digitIgnoresSelection() {
    var machine = opened(order: five)
    _ = machine.key(.down, at: gap)
    _ = machine.key(.down, at: 2 * gap)
    #expect(machine.selected == "b")
    #expect(machine.key(.digit(4), at: 2 * gap + 0.01) == [.releaseKeyboard(restore: false), .watch(false), .open("d")])
  }

  @Test("Cmd+digit from the menu: the open window takes it, a digit close swallows the same press, else the tab runs")
  func menuDigit() {
    var idle = SwitcherMachine()
    #expect(idle.menuDigit(3, at: 0) == nil, "no window: the tab shortcut does its own thing")

    var open = opened(order: five)
    #expect(open.menuDigit(3, at: 0) == [.releaseKeyboard(restore: false), .watch(false), .open("c")])
    #expect(open.menuDigit(3, at: 0.01) == [], "the window's own key command for the same press")
    #expect(open.menuDigit(3, at: 0.01 + SwitcherTiming.repeatQuiet + 0.01) == nil, "a fresh press after silence")

    var keyFirst = opened(order: five)
    _ = keyFirst.key(.digit(2), at: 0)
    #expect(keyFirst.menuDigit(2, at: 0.01) == [], "the window's key command closed it first; the menu is swallowed")

    var stays = opened(order: five)
    #expect(stays.menuDigit(8, at: 0) == [] && stays.isOpen, "no row 8: nothing, and no tab switch")

    var escaped = opened(order: five)
    _ = escaped.cancel(.escapeKey, at: 0)
    #expect(escaped.menuDigit(1, at: 0.01) == nil, "only a digit close swallows the next Cmd+digit")
    // Only the closing digit's second delivery is swallowed: another Cmd+digit right after is a tab shortcut, and it
    // does not stretch the quiet window either.
    var jumped = opened(order: five)
    _ = jumped.key(.digit(0), at: 1)
    #expect(jumped.menuDigit(2, at: 1.2) == nil, "Cmd+2 after a 0 close switches the tab")
    #expect(jumped.menuDigit(0, at: 1.25) == [], "the 0 itself through the second route is still swallowed")
    #expect(jumped.menuDigit(0, at: 1.25 + SwitcherTiming.repeatQuiet + 0.01) == nil)
  }
}

@MainActor
@Suite("session switcher: clock and effects")
struct SessionSwitcherTests {
  /// A manual clock: the test moves the time itself.
  @MainActor
  final class Bench {
    var time: TimeInterval = 100
    var opened: [String] = []
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
    bench.switcher.command(backward: false, keyboard: true, snapshot: ["tu", "a", "b"], current: "tu")
    #expect(bench.watching == [true] && bench.keyboard == ["take"] && bench.switcher.holdsKeyboard)
    #expect(bench.switcher.windowShown && bench.switcher.absorbsEscape)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.down)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.down)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.key(.confirm)
    #expect(bench.opened == ["b"] && bench.watching == [true, false] && bench.keyboard == ["take", "release"])
    #expect(!bench.switcher.windowShown && !bench.switcher.absorbsEscape)
  }

  @Test("the snapshot is read only at the opening")
  func snapshotOnce() {
    let bench = Bench()
    var reads = 0
    func rows() -> [String] {
      reads += 1
      return ["a", "b"]
    }
    bench.switcher.command(backward: false, keyboard: false, snapshot: rows(), current: nil)
    bench.time += SwitcherTiming.moveInterval
    bench.switcher.command(backward: false, keyboard: false, snapshot: rows(), current: nil)
    #expect(reads == 1)
  }

  @Test("Esc gives the caret back; a refused keyboard leaves the window open without it")
  func escapeAndRefusal() {
    let bench = Bench()
    bench.switcher.command(backward: false, keyboard: true, snapshot: ["a"], current: nil)
    bench.switcher.key(.close)
    #expect(bench.keyboard == ["take", "release+restore"] && bench.opened.isEmpty)

    let refused = Bench()
    refused.refuse = true
    refused.switcher.command(backward: false, keyboard: true, snapshot: ["a"], current: nil)
    #expect(refused.switcher.windowShown && !refused.switcher.holdsKeyboard)
    refused.switcher.cancel(.outside)
    #expect(refused.keyboard == ["take"], "nothing to give up")
  }

  @Test("a digit and Cmd+digit from the menu go through the machine: the jump once, the tab shortcut swallowed")
  func digits() {
    let bench = Bench()
    bench.switcher.command(backward: false, keyboard: true, snapshot: ["tu", "a", "b", "c", "d"], current: "tu")
    #expect(bench.switcher.menuDigit(3) == true)
    #expect(bench.opened == ["c"] && !bench.switcher.windowShown && bench.keyboard == ["take", "release"])
    bench.switcher.key(.digit(3))
    #expect(bench.switcher.menuDigit(3) == true && bench.opened == ["c"], "the second route of the same press")
    bench.time += 1
    #expect(bench.switcher.menuDigit(3) == false, "later the tab shortcut works again")
    bench.switcher.command(backward: false, keyboard: true, snapshot: ["tu", "a"], current: "tu")
    bench.switcher.key(.digit(0))
    #expect(bench.opened == ["c"] && bench.keyboard.last == "release+restore", "0: back where the caret was")
  }

  @Test("a tap on a row and a list change go through the machine")
  func tapAndSync() {
    let bench = Bench()
    bench.switcher.openByTap(keyboard: false, snapshot: ["tu", "a", "b"], current: "tu")
    bench.switcher.sessionsChanged(existing: ["tu", "b"])
    #expect(bench.switcher.machine.order == ["tu", "b"] && bench.switcher.machine.selected == "tu")
    bench.switcher.tapRow("b")
    #expect(bench.opened == ["b"] && bench.watching == [true, false] && bench.keyboard.isEmpty)
  }
}
