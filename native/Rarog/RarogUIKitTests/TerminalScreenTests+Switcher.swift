import RarogCore
@testable import RarogUI
import UIKit
import XCTest

// The session switcher over the terminal screen. A file of its own beside
// `TerminalScreenTests.swift`, which stays under the file size threshold; the harness is shared. Owner: terminal.

/// A focusable stand-in for the SwiftTerm view: a subview of the container, like the real surface, so the container's
/// key commands are on the responder chain of the first responder.
private final class FocusProxy: UIView {
  override var canBecomeFirstResponder: Bool { true }
}

/// Up to 3 s for the condition, like the main file's private `waitUntil`.
@MainActor
private func eventually(_ condition: () -> Bool) async {
  for _ in 0..<300 {
    if condition() { return }
    try? await Task.sleep(for: .milliseconds(10))
  }
}

extension TerminalScreenTests {
  /// The switcher window over the terminal takes the keyboard: the arrows, Tab, Return, Esc and Cmd+period go to the
  /// window, not a byte to the program; Esc gives the keyboard back to the terminal. While the window is open without
  /// the keyboard, the screen's Esc guard (`handleKey` and Esc from the surface) still keeps Esc from the program;
  /// after the close Esc goes to the program at once.
  func testSwitcherWindowKeepsKeysFromProgram() async throws {
    let h = try harness(hardware: true)
    let socket = try await connect(h)
    let proxy = FocusProxy(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    h.screen.container.addSubview(proxy)
    XCTAssertTrue(proxy.becomeFirstResponder(), "the terminal holds the keyboard")
    // Plain arrows go to SwiftTerm as presses; Cmd+Down is a key command of the container (page down).
    XCTAssertTrue(
      SessionSwitcherUIKitTests.keyTarget(UIKeyCommand.inputDownArrow, .command, in: h.window)?.responder
        === h.screen.container,
      "without the window Cmd+Down is the terminal's key")
    var time: TimeInterval = 10
    var opened: [ProjectTabRef] = []
    let switcher = SessionSwitcher()
    switcher.now = { time }
    switcher.onOpen = { opened.append($0) }
    h.screen.switcher = switcher
    let responder = SwitcherKeyResponder()
    responder.currentResponder = { [weak window = h.window] in
      window.flatMap(SessionSwitcherUIKitTests.firstResponder)
    }
    h.window.rootViewController?.view.addSubview(responder)
    responder.attach(to: switcher)
    func open() {
      time += 1
      switcher.openByTap(keyboard: true, tabs: [.session("cur"), .session("a")], current: .session("cur"))
      XCTAssertTrue(responder.isFirstResponder, "the window holds the keyboard")
    }

    open()
    let keys: [(String, UIKeyModifierFlags)] = [
      (UIKeyCommand.inputDownArrow, []), (UIKeyCommand.inputDownArrow, .command), (UIKeyCommand.inputUpArrow, []),
      ("\t", []), ("\t", .shift),
    ]
    for (input, modifiers) in keys {
      time += 0.2
      XCTAssertTrue(
        SessionSwitcherUIKitTests.press(input, modifiers, in: h.window) === responder,
        "\(input) \(modifiers) to the window")
    }
    XCTAssertTrue(SessionSwitcherUIKitTests.press(UIKeyCommand.inputEscape, in: h.window) === responder)
    XCTAssertFalse(switcher.windowShown)
    await eventually { proxy.isFirstResponder }
    XCTAssertTrue(proxy.isFirstResponder, "Esc gives the keyboard back to the terminal")
    for (input, modifiers) in [(".", UIKeyModifierFlags.command), ("\r", []), ("\r", .command)] {
      open()
      if input == "\r" {
        // The selection starts on the current session; Return jumps from the next row.
        time += 0.2
        SessionSwitcherUIKitTests.press(UIKeyCommand.inputDownArrow, in: h.window)
      }
      XCTAssertTrue(
        SessionSwitcherUIKitTests.press(input, modifiers, in: h.window) === responder, "\(input) \(modifiers)")
      XCTAssertFalse(switcher.windowShown)
      XCTAssertFalse(responder.isFirstResponder)
      _ = proxy.becomeFirstResponder()
    }
    XCTAssertEqual(opened, [.session("a"), .session("a")], "Return and Cmd+Return jump")

    // The safety net: a window without the keyboard over the terminal. A lone Esc byte from the surface (also a key
    // SwiftTerm handled itself), the kitty keyboard protocol's Cmd+Esc and its release (Claude Code: sequences, not a
    // byte), Cmd+. and the Esc key through `handleKey` each close the window and send nothing.
    let escapes: [(String, () -> Void)] = [
      ("lone Esc byte", { h.surface.onInput?("\u{1B}") }),
      ("kitty Cmd+Esc", { h.surface.onInput?("\u{1B}[27;9u") }),
      ("kitty Cmd+Esc release", { h.surface.onInput?("\u{1B}[27;9:3u") }),
      ("Cmd+.", { h.screen.handleKey(TerminalHardwareKey(".", command: true)) }),
      ("Esc key", { h.screen.handleKey(TerminalHardwareKey(TerminalKeyMap.escape)) }),
    ]
    for (name, send) in escapes {
      time += 1
      switcher.openByTap(keyboard: false, tabs: [.session("cur"), .session("a")], current: .session("cur"))
      XCTAssertTrue(proxy.isFirstResponder && switcher.windowShown, name)
      send()
      XCTAssertFalse(switcher.windowShown, "\(name) closes the window")
    }
    h.surface.onInput?("x")
    await eventually { self.inputs(socket).count == 1 }
    XCTAssertEqual(inputs(socket), ["x"], "not a byte of the switcher's keys reached the program")
    // Right after the close Esc goes to the program again (no grace window).
    h.screen.handleKey(TerminalHardwareKey(".", command: true))
    await eventually { self.inputs(socket).count == 2 }
    XCTAssertEqual(inputs(socket), ["x", "\u{1B}"])
    XCTAssertEqual(opened, [.session("a"), .session("a")])
  }
}
