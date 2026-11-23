import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// The terminal screen while the on-screen keyboard slides (iPhone: "the keyboard just pops in"). The keyboard is
/// simulated: the window shrinks or grows inside `UIView.animate` the way the keyboard layout guide moves the stack,
/// the keyboard's state comes from the screen's seam (`keyboardIsUp`) and the end of the slide is the system's
/// `keyboardDidShowNotification`. The screen harness of `TerminalScreenTests` (fake surface: cell 10×20 pt, by default
/// every dropped row leaves the top). Owner: terminal.
@MainActor
final class TerminalKeyboardSlideScreenTests: XCTestCase {
  private final class Keyboard {
    var up = false
  }

  private func harness(hardware: Bool = false) throws -> (TerminalScreenTests.Harness, Keyboard) {
    let h = try TerminalScreenTests.harness(in: self, hardware: hardware)
    let keyboard = Keyboard()
    h.screen.keyboardIsUp = { keyboard.up }
    h.window.layoutIfNeeded()
    return (h, keyboard)
  }

  /// The keyboard (or a plain resize) moves the bottom of the stack to `height`, animated like the keyboard.
  private func slide(_ h: TerminalScreenTests.Harness, to height: CGFloat) {
    UIView.animate(withDuration: 0.3) {
      h.window.frame = CGRect(x: 0, y: 0, width: h.window.frame.width, height: height)
      h.window.layoutIfNeeded()
    }
  }

  private func keyboardArrived() {
    NotificationCenter.default.post(name: UIResponder.keyboardDidShowNotification, object: nil)
  }

  private func eventually(_ condition: () -> Bool) async {
    for _ in 0..<300 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  private func resizes(_ socket: RecordingSocket) -> [TerminalGrid] {
    socket.sent.compactMap { if case let .resize(grid) = $0 { grid } else { nil } }
  }

  /// Keyboard up: the surface keeps its height and moves up with the bottom of the container, which clips it; the
  /// grid does not change until the keyboard has arrived, then the surface takes the container's height.
  func testKeyboardUpHoldsSurfaceUntilItArrives() throws {
    let (h, keyboard) = try harness()
    let before = h.surface.frame
    let rows = h.surface.gridSize.rows
    let calls = h.surface.resizeCalls
    keyboard.up = true
    slide(h, to: 400)
    let container = h.screen.container.bounds
    XCTAssertLessThan(container.height, before.height, "control: the keyboard shrank the container")
    XCTAssertTrue(h.screen.container.clipsToBounds, "the container clips the surface")
    XCTAssertEqual(h.surface.frame.height, before.height, "the surface keeps its height: \(h.surface.frame)")
    XCTAssertEqual(h.surface.resizeCalls, calls, "no grid change while the keyboard slides")
    XCTAssertEqual(h.surface.gridSize.rows, rows)
    // Every dropped row leaves the top: the top goes up by them, so the bottom row stays above the key bar.
    let newRows = Int(container.height / 20)
    XCTAssertEqual(h.surface.frame.minY, -CGFloat((rows - newRows) * 20), accuracy: 0.5)
    XCTAssertEqual(h.surface.frame.minX, TerminalScreenViewController.sideInset, accuracy: 0.5)

    keyboardArrived()
    XCTAssertEqual(h.surface.frame.minY, 0, accuracy: 0.5)
    XCTAssertEqual(h.surface.frame.height, h.screen.container.bounds.height, accuracy: 0.5)
    XCTAssertEqual(h.surface.resizeCalls, calls + 1, "one grid change, at the end of the slide")
    XCTAssertEqual(h.surface.gridSize.rows, newRows)
    XCTAssertTrue(
      (h.surface.layer.animationKeys() ?? []).filter { $0.hasPrefix("bounds") || $0 == "position" }.isEmpty,
      "the final frame stands at once: \(h.surface.layer.animationKeys() ?? [])")
  }

  /// Keyboard down: the surface takes the final height at once (its frame is not animated), so the grid grows in
  /// the first frame and the container uncovers the new rows as the key bar slides away.
  func testKeyboardDownGrowsGridAtOnce() throws {
    let (h, keyboard) = try harness()
    keyboard.up = true
    h.window.frame = CGRect(x: 0, y: 0, width: 800, height: 400)
    h.window.layoutIfNeeded()
    let rows = h.surface.gridSize.rows
    let calls = h.surface.resizeCalls
    keyboard.up = false
    slide(h, to: 600)
    XCTAssertEqual(h.surface.frame.minY, 0, accuracy: 0.5)
    XCTAssertEqual(h.surface.frame.height, h.screen.container.bounds.height, accuracy: 0.5)
    XCTAssertEqual(h.surface.resizeCalls, calls + 1, "the grid grows at once")
    XCTAssertGreaterThan(h.surface.gridSize.rows, rows)
    let keys = h.surface.layer.animationKeys() ?? []
    XCTAssertTrue(keys.filter { $0.hasPrefix("bounds") || $0 == "position" }.isEmpty, "frame not animated: \(keys)")
  }

  /// With a hardware keyboard the on-screen keyboard's layout (the shortcut bar on an iPad) resizes as before: the
  /// surface follows the container in the same pass.
  func testHardwareKeyboardFollowsContainer() throws {
    let (h, keyboard) = try harness(hardware: true)
    let calls = h.surface.resizeCalls
    keyboard.up = true
    slide(h, to: 400)
    XCTAssertEqual(h.surface.frame.minY, 0, accuracy: 0.5)
    XCTAssertEqual(h.surface.frame.height, h.screen.container.bounds.height, accuracy: 0.5)
    XCTAssertEqual(h.surface.resizeCalls, calls + 1)
  }

  /// A plain animated resize (rotation, split view) without a keyboard change follows the container at once; so does
  /// a resize while the keyboard stays up (rotation with the keyboard up).
  func testResizeWithoutKeyboardChangeFollowsContainer() throws {
    let (h, keyboard) = try harness()
    var calls = h.surface.resizeCalls
    slide(h, to: 450)
    XCTAssertEqual(h.surface.frame.height, h.screen.container.bounds.height, accuracy: 0.5)
    XCTAssertEqual(h.surface.resizeCalls, calls + 1)
    // The keyboard is up (it came in a layout of its own), then the window turns.
    keyboard.up = true
    h.window.frame = CGRect(x: 0, y: 0, width: 800, height: 400)
    h.window.layoutIfNeeded()
    calls = h.surface.resizeCalls
    UIView.animate(withDuration: 0.3) {
      h.window.frame = CGRect(x: 0, y: 0, width: 600, height: 380)
      h.window.layoutIfNeeded()
    }
    XCTAssertEqual(h.surface.frame.height, h.screen.container.bounds.height, accuracy: 0.5)
    XCTAssertEqual(h.surface.resizeCalls, calls + 1)
  }

  /// Tap, then the keyboard: the focus `rs` waits through the whole slide (longer than the quiet window) and goes out
  /// ONCE, with the grid after the keyboard — not with the grid from before it.
  func testFocusDuringSlideSendsOneRsAfterIt() async throws {
    let (h, keyboard) = try harness()
    h.screen.settleDelay = ResizeSettler.quiet
    await eventually { h.wire.sockets.count > 0 }
    let socket = try XCTUnwrap(h.wire.sockets.last)
    socket.emit(.opened)
    await eventually { h.session.phase == .live && !self.resizes(socket).isEmpty }
    try await Task.sleep(for: .milliseconds(400))
    let before = resizes(socket).count
    h.surface.onFocus?()
    keyboard.up = true
    slide(h, to: 400)
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(resizes(socket).count, before, "nothing while the keyboard slides")
    keyboardArrived()
    let grid = try XCTUnwrap(TerminalGrid(cols: h.surface.gridSize.cols, rows: h.surface.gridSize.rows))
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(Array(resizes(socket).dropFirst(before)), [grid], "one `rs`, after the keyboard")
  }

  /// Tap, the keyboard starts up and turns back before it arrives (the quiet window has already ended): the hold
  /// ends in a layout pass, the grid never changed, and the focus `rs` still goes out ONCE, with that grid.
  func testInterruptedSlideStillSendsFocusRs() async throws {
    let (h, keyboard) = try harness()
    h.screen.settleDelay = ResizeSettler.quiet
    await eventually { h.wire.sockets.count > 0 }
    let socket = try XCTUnwrap(h.wire.sockets.last)
    socket.emit(.opened)
    await eventually { h.session.phase == .live && !self.resizes(socket).isEmpty }
    try await Task.sleep(for: .milliseconds(400))
    let before = resizes(socket).count
    let height = h.window.frame.height
    let grid = try XCTUnwrap(TerminalGrid(cols: h.surface.gridSize.cols, rows: h.surface.gridSize.rows))
    h.surface.onFocus?()
    keyboard.up = true
    slide(h, to: 400)
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertEqual(resizes(socket).count, before, "nothing while the keyboard slides")
    keyboard.up = false
    slide(h, to: height)
    NotificationCenter.default.post(name: UIResponder.keyboardDidHideNotification, object: nil)
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(Array(resizes(socket).dropFirst(before)), [grid], "the focus `rs` is not lost")
  }
}
