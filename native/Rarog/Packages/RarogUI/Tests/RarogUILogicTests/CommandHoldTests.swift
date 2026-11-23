import Foundation
@testable import RarogUI
import Testing
#if canImport(GameController)
import GameController
#endif

// The shortcut sheet under a held Cmd: key events and the hold machine (`ShortcutSheet/`). One test per transition of the
// hold machine. Times are seconds of a test clock that starts at 0. Owner: shortcuts.

private let free = CommandHold.Conditions()
/// The test times follow the threshold, so a new value of it needs no new numbers here.
private let threshold = CommandHold.threshold
/// HID usages of the keyboard page: left Shift and A.
private let shift = 0xE1
private let keyA = 0x04

/// A hold with the left Cmd pressed at `start`.
private func holding(at start: TimeInterval = 0) -> CommandHold {
  var hold = CommandHold()
  _ = hold.receive(.commandDown(.left), at: start)
  return hold
}

/// A hold whose sheet stands (left Cmd since 0, shown at the threshold).
private func shown() -> CommandHold {
  var hold = holding()
  _ = hold.tick(at: CommandHold.threshold, pressed: true, conditions: free)
  return hold
}

@Suite("shortcut sheet: key events of a held Cmd")
struct CommandHoldEventTests {
  @Test("left and right Cmd are Cmd events with their side; any other key, also a modifier, is another key")
  func mapping() {
    #expect(CommandKeyEvent(usage: CommandKeyEvent.leftCommandUsage, pressed: true) == .commandDown(.left))
    #expect(CommandKeyEvent(usage: CommandKeyEvent.leftCommandUsage, pressed: false) == .commandUp(.left))
    #expect(CommandKeyEvent(usage: CommandKeyEvent.rightCommandUsage, pressed: true) == .commandDown(.right))
    #expect(CommandKeyEvent(usage: CommandKeyEvent.rightCommandUsage, pressed: false) == .commandUp(.right))
    // HID usages of the keyboard page: S, left Shift, left Option, left Control, right Shift.
    for usage in [0x16, 0xE1, 0xE2, 0xE0, 0xE5] {
      #expect(CommandKeyEvent(usage: usage, pressed: true) == .otherKeyDown(usage))
      #expect(CommandKeyEvent(usage: usage, pressed: false) == .otherKeyUp(usage))
    }
  }

  #if canImport(GameController)
  /// The app passes `GCKeyCode.rawValue`; a wrong usage constant would read Cmd as another key and never show.
  @Test("the Cmd usages are the raw values of GameController's key codes")
  func gameControllerCodes() {
    #expect(CommandKeyEvent(usage: GCKeyCode.leftGUI.rawValue, pressed: true) == .commandDown(.left))
    #expect(CommandKeyEvent(usage: GCKeyCode.rightGUI.rawValue, pressed: true) == .commandDown(.right))
    #expect(CommandKeyEvent(usage: GCKeyCode.leftShift.rawValue, pressed: true) == .otherKeyDown(GCKeyCode.leftShift.rawValue))
    #expect(CommandKeyEvent(usage: GCKeyCode.keyS.rawValue, pressed: true) == .otherKeyDown(GCKeyCode.keyS.rawValue))
  }
  #endif
}

@Suite("shortcut sheet: Cmd held alone for the threshold shows it (CommandHold)")
struct CommandHoldTests {
  @Test("Cmd alone for the threshold, key window, logged in, switcher closed: shown; 0.1 s earlier not yet")
  func showsAtThreshold() {
    var hold = CommandHold()
    #expect(hold.receive(.commandDown(.left), at: 0) == .started(due: threshold))
    #expect(hold.tick(at: threshold - 0.1, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == .shown)
    #expect(hold.shown)
  }

  @Test("Cmd released 0.1 s before the threshold: nothing, also when the countdown's timer fires")
  func releasedEarly() {
    var hold = holding()
    #expect(hold.receive(.commandUp(.left), at: threshold - 0.1) == nil)
    #expect(hold.due == nil)
    #expect(hold.tick(at: threshold, pressed: false, conditions: free) == nil)
    #expect(!hold.shown)
  }

  @Test("Cmd, then any other key with Cmd still held: nothing until Cmd is released")
  func otherKeySpoilsHold() {
    var hold = holding()
    #expect(hold.receive(.otherKeyDown(shift), at: threshold / 2) == nil)
    #expect(hold.receive(.otherKeyUp(shift), at: threshold / 2 + 0.1) == nil)
    #expect(hold.due == nil)
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == nil)
    #expect(hold.tick(at: 10, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
    // A new press after the release counts again.
    _ = hold.receive(.commandUp(.left), at: 11)
    #expect(hold.receive(.commandDown(.left), at: 12) == .started(due: 12 + threshold))
    #expect(hold.tick(at: 12 + threshold, pressed: true, conditions: free) == .shown)
  }

  @Test("Shift held before Cmd: nothing, Cmd is not alone")
  func modifierBeforeCommand() {
    var hold = CommandHold()
    _ = hold.receive(.otherKeyDown(shift), at: 0)
    #expect(hold.receive(.commandDown(.left), at: 0.5) == nil)
    _ = hold.receive(.otherKeyUp(shift), at: 1)
    #expect(hold.tick(at: 0.5 + threshold, pressed: true, conditions: free) == nil)
    #expect(hold.tick(at: 5, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
  }

  @Test("sheet shown, another key: hides, and stays hidden while Cmd is held")
  func otherKeyHides() {
    var hold = shown()
    #expect(hold.receive(.otherKeyDown(shift), at: threshold + 1) == .hidden(.otherKey))
    #expect(!hold.shown)
    _ = hold.receive(.otherKeyUp(shift), at: threshold + 1.1)
    #expect(hold.tick(at: 8, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
  }

  @Test("sheet shown, Cmd released: hides")
  func releaseHides() {
    var hold = shown()
    #expect(hold.receive(.commandUp(.left), at: threshold + 1) == .hidden(.commandReleased))
    #expect(!hold.shown)
  }

  @Test("both Cmd held, one released: no change, in the countdown and while shown")
  func bothCommands() {
    var hold = holding()
    #expect(hold.receive(.commandDown(.right), at: threshold * 0.3) == nil)
    #expect(hold.receive(.commandUp(.left), at: threshold * 0.6) == nil)
    #expect(hold.due == threshold, "the countdown runs from the first Cmd")
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == .shown)
    #expect(hold.receive(.commandDown(.left), at: threshold + 0.5) == nil)
    #expect(hold.receive(.commandUp(.right), at: threshold + 1) == nil)
    #expect(hold.shown)
    #expect(hold.receive(.commandUp(.left), at: threshold + 2) == .hidden(.commandReleased))
  }

  @Test("repeated Cmd down of the same key: the countdown does not restart")
  func repeatedDown() {
    var hold = holding()
    #expect(hold.receive(.commandDown(.left), at: threshold * 0.3) == nil)
    #expect(hold.receive(.commandDown(.left), at: threshold * 0.8) == nil)
    #expect(hold.due == threshold)
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == .shown)
  }

  @Test("isPressed of both Cmd false at the threshold: not shown, and a new Cmd is needed")
  func notPressedAtThreshold() {
    var hold = holding()
    #expect(hold.tick(at: threshold, pressed: false, conditions: free) == .dropped(.notPressed))
    #expect(!hold.shown)
    #expect(hold.tick(at: 6, pressed: true, conditions: free) == nil)
    #expect(hold.receive(.commandDown(.left), at: 7) == .started(due: 7 + threshold))
  }

  @Test("isPressed of both Cmd false in a check while shown: hides")
  func notPressedWhileShown() {
    var hold = shown()
    #expect(hold.tick(at: threshold + 0.25, pressed: true, conditions: free) == nil)
    #expect(hold.tick(at: threshold + 0.5, pressed: false, conditions: free) == .hidden(.notPressed))
    #expect(!hold.shown)
    #expect(hold.nextCheck(after: threshold + 0.5) == nil)
  }

  @Test("isPressed nil (no keyboard): hides, and does not show at the threshold")
  func noKeyboard() {
    var standing = shown()
    #expect(standing.tick(at: threshold + 0.25, pressed: nil, conditions: free) == .hidden(.noKeyboard))
    #expect(!standing.shown)
    var counting = holding()
    #expect(counting.tick(at: threshold, pressed: nil, conditions: free) == .dropped(.noKeyboard))
    #expect(!counting.shown)
  }

  @Test(
    "app inactive, window no longer key, keyboard disconnected: reset; after the return a new Cmd is needed",
    arguments: [CommandHold.ResetReason.appInactive, .windowResigned, .keyboardDisconnected])
  func reset(reason: CommandHold.ResetReason) {
    var standing = shown()
    #expect(standing.reset(reason) == .hidden(.reset(reason)))
    #expect(!standing.shown)
    // Cmd still held through Cmd+Tab and back: no new down event, so nothing shows.
    #expect(standing.tick(at: 10, pressed: true, conditions: free) == nil)
    #expect(!standing.shown)

    var counting = holding()
    #expect(counting.reset(reason) == nil)
    #expect(counting.due == nil)
    #expect(counting.tick(at: threshold, pressed: true, conditions: free) == nil)
    // The release of the old hold after the return is ignored, a new press counts.
    #expect(counting.receive(.commandUp(.left), at: threshold + 1) == nil)
    #expect(counting.receive(.commandDown(.left), at: threshold + 2) == .started(due: 2 * threshold + 2))
  }

  @Test("a reset forgets keys held before it: Shift down, reset, Cmd alone shows")
  func resetForgetsOtherKeys() {
    var hold = CommandHold()
    _ = hold.receive(.otherKeyDown(shift), at: 0)
    _ = hold.reset(.appInactive)
    #expect(hold.receive(.commandDown(.left), at: 1) == .started(due: 1 + threshold))
  }

  @Test("the release of a key held across a reset does not free a key pressed after it: Cmd is not alone")
  func releaseFromBeforeReset() {
    var hold = CommandHold()
    _ = hold.receive(.otherKeyDown(shift), at: 0)
    _ = hold.reset(.appInactive)
    _ = hold.receive(.otherKeyDown(keyA), at: 1)
    _ = hold.receive(.otherKeyUp(shift), at: 1.5)
    #expect(hold.receive(.commandDown(.left), at: 2) == nil)
    #expect(hold.tick(at: 5, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
  }

  @Test("switcher window open (also by touch): nothing at the threshold; opened while shown: hides")
  func switcherOpen() {
    let switcher = CommandHold.Conditions(switcherOpen: true)
    var counting = holding()
    #expect(counting.tick(at: threshold, pressed: true, conditions: switcher) == .dropped(.blocked))
    #expect(!counting.shown)
    #expect(counting.tick(at: threshold + 2, pressed: true, conditions: free) == nil, "the same hold does not try again")

    var standing = shown()
    #expect(standing.tick(at: threshold + 0.25, pressed: true, conditions: switcher) == .hidden(.blocked))
    #expect(!standing.shown)
  }

  @Test(
    "not the key window, logged out, app on a Mac: nothing at the threshold",
    arguments: [
      CommandHold.Conditions(keyWindow: false), CommandHold.Conditions(loggedIn: false),
      CommandHold.Conditions(onMac: true),
    ])
  func blocked(conditions: CommandHold.Conditions) {
    var hold = holding()
    #expect(hold.tick(at: threshold, pressed: true, conditions: conditions) == .dropped(.blocked))
    #expect(!hold.shown)
  }

  @Test("late callback of a cancelled countdown: nothing, also when a newer countdown runs")
  func lateCallback() {
    var hold = holding()
    _ = hold.receive(.commandUp(.left), at: threshold / 3)
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == nil)
    _ = hold.receive(.commandDown(.left), at: threshold / 2)
    // The timer of the first countdown fires at the threshold, the new one is due half a threshold later.
    #expect(hold.tick(at: threshold, pressed: true, conditions: free) == nil)
    #expect(!hold.shown)
    #expect(hold.tick(at: threshold / 2 + threshold, pressed: true, conditions: free) == .shown)
  }

  @Test("next check: the countdown's end while counting, every 250 ms while shown, none otherwise")
  func nextCheck() {
    #expect(CommandHold().nextCheck(after: 1) == nil)
    #expect(holding(at: 1).nextCheck(after: 1.1) == 1 + threshold)
    #expect(shown().nextCheck(after: 5) == 5 + CommandHold.checkInterval)
  }
}
