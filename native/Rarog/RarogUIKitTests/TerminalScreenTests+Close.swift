import RarogCore
@testable import RarogUI
import UIKit
import XCTest

// The terminal's "×" as the current tab runs it: two presses through `TerminalChrome`, one announcement per arming.
// A file of its own beside `TerminalScreenTests.swift`, which stays under the file size threshold; the harness is
// shared. Owner: terminal.

/// Up to 3 s for the condition, like the main file's private `waitUntil`.
@MainActor
private func eventually(_ condition: () -> Bool) async {
  for _ in 0..<300 {
    if condition() { return }
    try? await Task.sleep(for: .milliseconds(10))
  }
}

/// The sentences the screen gives the screen reader.
@MainActor
private final class Spoken {
  var lines: [String] = []
}

extension TerminalScreenTests {
  /// The tab's "×" runs the screen's close: the first press arms and the arming itself tells the screen reader what
  /// the next press does, once; Cmd+X as the second press closes the shell and says nothing more. The caller (the
  /// tab's button, the corner button, the key) never speaks on its own.
  func testTabCloseArmsWithOneAnnouncementAndCommandXCloses() async throws {
    let h = try harness(hardware: true)
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let spoken = Spoken()
    h.screen.announcer = Announcer(sink: { spoken.lines.append($0.text) }, now: Date.init)
    let chrome = TerminalChrome()
    h.screen.chrome = chrome
    h.screen.sheetAbove = { _ in .nothing }

    chrome.tapClose()
    XCTAssertEqual(chrome.close, .armed, "the first press arms")
    XCTAssertEqual(spoken.lines, [UICopy.terminalCloseConfirmSpoken(.mac)], "the arming speaks once")
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertTrue(h.wire.closed.isEmpty, "the first press closes nothing")

    h.screen.handleKey(TerminalHardwareKey("x", command: true))
    await eventually { closed == 1 }
    XCTAssertEqual(h.wire.closed, [FakeWire.id], "Cmd+X as the second press closes the shell")
    XCTAssertEqual(spoken.lines.count, 1, "confirming says nothing more: \(spoken.lines)")
  }

  /// Cmd+X first and the tab's "×" second: the same arming, one announcement, and the "×" closes.
  func testCommandXArmsOnceAndTabCloseCloses() async throws {
    let h = try harness(hardware: true)
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let spoken = Spoken()
    h.screen.announcer = Announcer(sink: { spoken.lines.append($0.text) }, now: Date.init)
    let chrome = TerminalChrome()
    h.screen.chrome = chrome
    h.screen.sheetAbove = { _ in .nothing }

    h.screen.handleKey(TerminalHardwareKey("x", command: true))
    XCTAssertEqual(chrome.close, .armed, "Cmd+X arms the tab's “×”")
    XCTAssertEqual(spoken.lines, [UICopy.terminalCloseConfirmSpoken(.mac)], "one announcement")
    chrome.tapClose()
    await eventually { closed == 1 }
    XCTAssertEqual(h.wire.closed, [FakeWire.id])
    XCTAssertEqual(spoken.lines.count, 1, "\(spoken.lines)")
  }

  /// Terminal A's close is on its way when the human moves to terminal B (A goes to the parking, B attaches to the
  /// same chrome) and arms B. A's late result, whatever it is, leaves B's arming as it was: the same state and the
  /// same deadline, so the card under the bar stays B's.
  func testLateCloseResultOfPreviousTerminalLeavesNewArming() async throws {
    for outcome in [TerminalCloseOutcome.closed, .failed("Nie wolno.")] {
      let a = try harness(closeOutcome: outcome)
      _ = try await connect(a)
      let b = try harness()
      _ = try await connect(b)
      let chrome = TerminalChrome()
      a.screen.chrome = chrome
      a.wire.holdClose = true
      chrome.tapClose()
      chrome.tapClose()
      await eventually { !a.wire.closed.isEmpty }
      XCTAssertEqual(chrome.close, .closing, "\(outcome): A's close on its way")

      b.screen.chrome = chrome
      a.screen.park()
      chrome.tapClose()
      XCTAssertEqual(chrome.close, .armed, "\(outcome): B armed")
      let armed = chrome.closeState
      guard case .armed = armed else { return XCTFail("\(outcome): \(armed)") }

      a.wire.release()
      try await Task.sleep(for: .milliseconds(150))
      XCTAssertTrue(chrome.isAttached, "\(outcome): B stays attached")
      XCTAssertEqual(chrome.close, .armed, "\(outcome): B's arming untouched")
      XCTAssertEqual(chrome.closeState, armed, "\(outcome): the same arming, so the same card")
      XCTAssertTrue(b.wire.closed.isEmpty, "\(outcome): B not closed")
    }
  }
}
