import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Focus on the terminal and the on-screen keyboard (iPhone, "the screen jumps"): the forced `rs` of a focus goes
/// through the same quiet window as a layout change, so the keyboard that comes up right after the tap does not get
/// an `rs` with the grid from before it, and herdr does not redraw the old screen into the smaller grid. The screen
/// harness of `TerminalScreenTests` (fake surface: cell 10×20 pt, `FakeWire`). Owner: terminal.
@MainActor
final class TerminalFocusResizeTests: XCTestCase {
  private func harness() throws -> TerminalScreenTests.Harness {
    let h = try TerminalScreenTests.harness(in: self)
    h.screen.settleDelay = ResizeSettler.quiet
    return h
  }

  /// Up to 3 s for the condition, like the main file's private `waitUntil`.
  private func eventually(_ condition: () -> Bool) async {
    for _ in 0..<300 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  private func resizes(_ socket: RecordingSocket) -> [TerminalGrid] {
    socket.sent.compactMap { if case let .resize(grid) = $0 { grid } else { nil } }
  }

  private func grid(_ h: TerminalScreenTests.Harness) throws -> TerminalGrid {
    try XCTUnwrap(TerminalGrid(cols: h.surface.gridSize.cols, rows: h.surface.gridSize.rows))
  }

  /// The screen opened its socket and the opening `rs` went out; the layout is quiet.
  private func live(_ h: TerminalScreenTests.Harness) async throws -> RecordingSocket {
    await eventually { h.wire.sockets.count > 0 }
    let socket = try XCTUnwrap(h.wire.sockets.last)
    socket.emit(.opened)
    await eventually { h.session.phase == .live && !self.resizes(socket).isEmpty }
    XCTAssertEqual(h.session.phase, .live)
    try await Task.sleep(for: .milliseconds(400))
    return socket
  }

  private func layout(_ h: TerminalScreenTests.Harness, height: CGFloat) {
    h.window.frame = CGRect(x: 0, y: 0, width: 800, height: height)
    h.window.layoutIfNeeded()
  }

  /// Tap, then the keyboard takes height within the quiet window: ONE `rs`, with the grid after the keyboard, and
  /// no `rs` with the old grid after the focus.
  func testFocusThenKeyboardSendsOneRsWithGridAfterKeyboard() async throws {
    let h = try harness()
    let socket = try await live(h)
    let before = resizes(socket).count
    let old = try grid(h)
    h.surface.onFocus?()
    try await Task.sleep(for: .milliseconds(50))
    layout(h, height: 400)
    let new = try grid(h)
    XCTAssertNotEqual(new, old, "the keyboard changes the grid")
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(Array(resizes(socket).dropFirst(before)), [new], "one `rs`, after the keyboard")
  }

  /// The layout moves and comes back to the grid already sent: the focus `rs` still goes out once (`force`), because
  /// after another client of the same terminal leaves, the pane keeps ITS size and the server does not say so.
  func testFocusThenLayoutBackToSentGridStillSendsOneRs() async throws {
    let h = try harness()
    let socket = try await live(h)
    let before = resizes(socket).count
    let old = try grid(h)
    h.surface.onFocus?()
    try await Task.sleep(for: .milliseconds(30))
    layout(h, height: 400)
    try await Task.sleep(for: .milliseconds(30))
    layout(h, height: 600)
    XCTAssertEqual(try grid(h), old)
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(Array(resizes(socket).dropFirst(before)), [old], "the same grid, sent once more")
  }

  /// A focus that ends the quiet on an inactive scene sends nothing.
  func testFocusOnInactiveSceneSendsNothing() async throws {
    let h = try harness()
    let socket = try await live(h)
    let before = resizes(socket).count
    var active = true
    h.screen.sceneIsActive = { active }
    h.surface.onFocus?()
    active = false
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(resizes(socket).count, before, "no `rs`")
  }

  /// The scene comes back without a trip to the background (Control Center): the socket stays, so the focus's forced
  /// `rs` goes out after the activation, once, with the unchanged grid.
  func testFocusEndingOnInactiveSceneSendsForcedRsAfterActivation() async throws {
    let h = try harness()
    let socket = try await live(h)
    let before = resizes(socket).count
    var active = true
    h.screen.sceneIsActive = { active }
    h.surface.onFocus?()
    active = false
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(resizes(socket).count, before, "no `rs` while inactive")
    active = true
    NotificationCenter.default.post(name: UIScene.didActivateNotification, object: nil)
    await eventually { self.resizes(socket).count > before }
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(resizes(socket).count, before + 1, "one forced `rs`")
    XCTAssertEqual(resizes(socket).last, try grid(h))
  }

  /// A focus before the socket is live adds nothing: the opening socket sends its own forced `rs`, so a delayed
  /// re-assert would only repeat it.
  func testFocusBeforeSocketOpensAddsNoSecondRs() async throws {
    let h = try harness()
    await eventually { h.wire.sockets.count > 0 }
    let socket = try XCTUnwrap(h.wire.sockets.last)
    XCTAssertNotEqual(h.session.phase, .live)
    h.surface.onFocus?()
    socket.emit(.opened)
    await eventually { h.session.phase == .live }
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(resizes(socket), [try grid(h)], "only the opening `rs`")
  }
}
