import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// The shortcut sheet under a held Cmd in a window: the controller (`ShortcutSheetController`) with key events
/// passed in directly (the simulator has no hardware keyboard, so `GCKeyboard` gives nothing) and a clock the test
/// moves. The hold machine and the content are tested by the package (`CommandHoldTests`,
/// `ShortcutSheetContentTests`). Owner: shortcuts.
@MainActor
final class ShortcutSheetUIKitTests: XCTestCase {
  @MainActor
  final class Rig {
    var time: TimeInterval = 100
    var pressed: Bool? = true
    var conditions = CommandHold.Conditions()
    var place: ShortcutSheetPlace? = .window
    var lines: [String] = []
  }

  override func tearDown() async throws {
    ShortcutSheetPanel.hide()
    try await super.tearDown()
  }

  private func window(root: UIViewController, width: CGFloat = 1180, height: CGFloat = 820) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
    window.rootViewController = root
    window.makeKeyAndVisible()
    root.view.layoutIfNeeded()
    addTeardownBlock { @MainActor in window.isHidden = true }
    return window
  }

  private func controller(_ rig: Rig, window: UIWindow, conditions: (() -> CommandHold.Conditions)? = nil)
    -> ShortcutSheetController {
    ShortcutSheetController(environment: ShortcutSheetController.Environment(
      now: { rig.time },
      pressed: { rig.pressed },
      conditions: conditions ?? { rig.conditions },
      place: { rig.place },
      capabilities: { ShortcutSheetCapabilities(notes: true, terminal: true, voiceAgent: true, wideIPad: true) },
      window: { window },
      trace: { rig.lines.append($0) }))
  }

  /// Cmd held alone past the threshold: the check at the end of the countdown shows the panel.
  private func hold(_ controller: ShortcutSheetController, _ rig: Rig) {
    controller.receive(.commandDown(.left))
    rig.time += CommandHold.threshold
    controller.check()
  }

  /// The first responder of a window (the test process has no `UIApplication` for `FirstResponder.current()`).
  private static func firstResponder(in view: UIView) -> UIResponder? {
    if view.isFirstResponder { return view }
    for subview in view.subviews {
      if let found = firstResponder(in: subview) { return found }
    }
    return nil
  }

  /// The caret in a field and a sheet presented over the screen: the panel stands over the sheet, on top of the
  /// window, without a presentation and without taking the caret; a touch outside the card goes through, the reader
  /// does not see the panel, the key caps keep their own width. Releasing Cmd hides it. (A field inside the sheet
  /// does not take the caret in a test without a host app, so the caret stands in the field under the sheet.)
  func testPanelStandsOverSheetKeepsCaretAndHidesOnRelease() throws {
    let root = UIViewController()
    let field = UITextField(frame: CGRect(x: 20, y: 20, width: 200, height: 40))
    root.view.addSubview(field)
    let window = window(root: root)
    XCTAssertTrue(field.becomeFirstResponder(), "caret in the field")
    let sheet = UIViewController()
    root.present(sheet, animated: false)
    XCTAssertTrue(root.presentedViewController === sheet)
    let caret = Self.firstResponder(in: window)
    XCTAssertNotNil(caret)
    let rig = Rig()
    let controller = controller(rig, window: window)

    hold(controller, rig)
    let panel = try XCTUnwrap(ShortcutSheetPanel.visible, "the panel after the threshold")
    XCTAssertTrue(panel.superview === window, "on the window, not presented")
    XCTAssertTrue(window.subviews.last === panel, "over everything in the window, also the sheet")
    if let sheetView = sheet.view, sheetView.window === window {
      XCTAssertTrue(sheetView.isDescendant(of: window) && !sheetView.isDescendant(of: panel))
    }
    XCTAssertTrue(root.presentedViewController === sheet, "nothing new presented, the sheet stays")
    XCTAssertTrue(Self.firstResponder(in: window) === caret, "the caret stays where it was")
    XCTAssertFalse(panel.isFirstResponder)
    XCTAssertTrue(panel.accessibilityElementsHidden, "the reader does not see the panel")

    panel.layoutIfNeeded()
    let card = panel.card.frame
    XCTAssertGreaterThan(card.width, 900, "wide on an iPad in landscape")
    XCTAssertLessThanOrEqual(card.width, ShortcutSheetPanel.maxWidth)
    XCTAssertEqual(card.midX, window.bounds.midX, accuracy: 1, "in the middle")
    XCTAssertNil(panel.hitTest(CGPoint(x: 5, y: 5), with: nil), "a touch outside the card goes through")
    XCTAssertNotNil(panel.hitTest(CGPoint(x: card.midX, y: card.midY), with: nil), "the card keeps its touches")
    snapshot(window, name: "shortcut-sheet-window")

    // The caps were stretched to fill the row (seen on the first snapshot): each cap is as wide as its glyph needs.
    for chip in Self.chips(in: panel) {
      let needed = max(chip.isKeyCap ? chip.bounds.height : 0, chip.label.intrinsicContentSize.width + 2 * chip.side)
      XCTAssertLessThanOrEqual(chip.bounds.width, needed + 1, "\(chip.label.text ?? "")")
    }
    XCTAssertFalse(Self.chips(in: panel).isEmpty)

    controller.receive(.commandUp(.left))
    XCTAssertNil(ShortcutSheetPanel.visible, "releasing Cmd hides the panel")
    XCTAssertTrue(Self.firstResponder(in: window) === caret)
    XCTAssertEqual(rig.lines.filter { $0.contains("countdown started") }.count, 1)
    XCTAssertTrue(rig.lines.contains { $0.contains("shown at window") }, "\(rig.lines)")
    XCTAssertTrue(rig.lines.contains { $0.contains("hidden at window, Cmd released") }, "\(rig.lines)")
  }

  /// The open session switcher window (Cmd+S or a tap on the current tab) stops the sheet at the threshold, and
  /// stopping it while the sheet stands hides it at the next check.
  func testOpenSwitcherBlocks() throws {
    let window = window(root: UIViewController())
    let switcher = SessionSwitcher()
    switcher.now = { 10 }
    let rig = Rig()
    let controller = controller(rig, window: window) {
      ShortcutSheetController.conditions(window: window, loggedIn: true, switcherOpen: switcher.windowShown)
    }
    switcher.openByTap(keyboard: false, snapshot: ["a"], current: nil)
    XCTAssertTrue(switcher.windowShown)

    hold(controller, rig)
    XCTAssertNil(ShortcutSheetPanel.visible, "no sheet over the switcher window")
    XCTAssertTrue(rig.lines.contains { $0.contains("dropped at window, blocked: switcher open") }, "\(rig.lines)")

    switcher.cancel(.outside)
    controller.receive(.commandUp(.left))
    hold(controller, rig)
    XCTAssertNotNil(ShortcutSheetPanel.visible, "with the window closed a new hold shows the sheet")
    switcher.openByTap(keyboard: false, snapshot: ["a"], current: nil)
    rig.time += CommandHold.checkInterval
    controller.check()
    XCTAssertNil(ShortcutSheetPanel.visible, "the switcher opened over the sheet hides it")
  }

  /// Another key with Cmd (⌘S, ⌘1) hides a standing sheet; the app going inactive or the keyboard going away
  /// resets the hold, so a Cmd still held after the return does not show it again.
  func testOtherKeyAndResetHide() throws {
    let window = window(root: UIViewController())
    let rig = Rig()
    let controller = controller(rig, window: window)
    hold(controller, rig)
    XCTAssertNotNil(ShortcutSheetPanel.visible)
    controller.receive(.otherKeyDown(0x16))
    XCTAssertNil(ShortcutSheetPanel.visible, "another key hides it")
    XCTAssertFalse(rig.lines.contains { $0.contains("22") || $0.contains("0x16") }, "no other key codes in the trace")

    controller.receive(.otherKeyUp(0x16))
    controller.receive(.commandUp(.left))
    hold(controller, rig)
    XCTAssertNotNil(ShortcutSheetPanel.visible)
    controller.reset(.appInactive)
    XCTAssertNil(ShortcutSheetPanel.visible, "the app going inactive hides it")
    rig.time += CommandHold.threshold
    controller.check()
    XCTAssertNil(ShortcutSheetPanel.visible, "after the return a new Cmd press is needed")
  }

  /// A narrow window (iPhone, Slide Over): one column in a card no wider than the window, scrolled with a finger
  /// inside the card when the groups are taller than the window.
  func testNarrowWindowOneScrolledColumn() throws {
    let window = window(root: UIViewController(), width: 390, height: 600)
    let rig = Rig()
    rig.place = .session
    let controller = controller(rig, window: window)
    hold(controller, rig)
    let panel = try XCTUnwrap(ShortcutSheetPanel.visible)
    panel.layoutIfNeeded()
    XCTAssertTrue(panel.oneColumn)
    XCTAssertLessThanOrEqual(panel.card.frame.width, window.bounds.width)
    XCTAssertLessThanOrEqual(panel.card.frame.height, window.bounds.height)
    XCTAssertGreaterThan(panel.scroll.contentSize.height, panel.scroll.bounds.height, "the groups scroll")
    XCTAssertTrue(panel.scroll.isScrollEnabled)
    snapshot(window, name: "shortcut-sheet-narrow")
  }

  private static func chips(in view: UIView) -> [ShortcutSheetChip] {
    view.subviews.flatMap { subview -> [ShortcutSheetChip] in
      (subview as? ShortcutSheetChip).map { [$0] } ?? chips(in: subview)
    }
  }

  // MARK: - Snapshot

  /// The window as an image, saved under `RAROG_SHORTCUT_SHEET_SNAPSHOT_DIR` when set (`TEST_RUNNER_` prefix through
  /// `xcodebuild`). The layer renders first (`drawHierarchy` gives a blank frame without a foreground app).
  private func snapshot(_ window: UIWindow, name: String) {
    window.layoutIfNeeded()
    let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
    let image = renderer.image { context in window.layer.render(in: context.cgContext) }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    add(attachment)
    guard let dir = ProcessInfo.processInfo.environment["RAROG_SHORTCUT_SHEET_SNAPSHOT_DIR"], !dir.isEmpty,
      let data = image.pngData()
    else { return }
    try? data.write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }
}
