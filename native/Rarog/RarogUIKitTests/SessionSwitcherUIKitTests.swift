import GameController
import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The session switcher window (opened by a tap on the current tab): the window's key receiver
/// (`SwitcherKeyResponder`) over the message field, the presentation gate, the watch of the open window and the
/// scrolling list keeping the selection in view while the rows change. The machine
/// is tested by the package (`SessionSwitcherTests`), the terminal by `TerminalScreenTests`. Key presses go through the
/// modelled UIKit lookup (``keyTarget(_:_:in:)``): the simulator does not deliver Esc, and Return does not reach a screen
/// without a text field (`native/Rarog/docs/tests.md`, "What the simulator cannot test").
@MainActor
final class SessionSwitcherUIKitTests: XCTestCase {
  // MARK: - Key lookup

  /// The first responder of a window (the test process has no `UIApplication`, so `FirstResponder.current()` does
  /// not work here).
  static func firstResponder(in view: UIView) -> UIResponder? {
    if view.isFirstResponder { return view }
    for subview in view.subviews {
      if let found = firstResponder(in: subview) { return found }
    }
    return nil
  }

  /// UIKit's key command lookup, modelled: from the first responder up the responder chain, the first responder that
  /// lists the key in `keyCommands` and can perform its action now. `nil` = no key command takes the key (it would go
  /// to `pressesBegan` of the first responder).
  static func keyTarget(
    _ input: String, _ modifiers: UIKeyModifierFlags = [], in window: UIWindow
  ) -> (responder: UIResponder, command: UIKeyCommand)? {
    var responder = firstResponder(in: window)
    while let current = responder {
      if let command = current.keyCommands?.first(where: { $0.input == input && $0.modifierFlags == modifiers }),
         let action = command.action, current.canPerformAction(action, withSender: command) {
        return (current, command)
      }
      responder = current.next
    }
    return nil
  }

  /// A key press as UIKit would deliver it to a key command; returns who took it.
  @discardableResult
  static func press(_ input: String, _ modifiers: UIKeyModifierFlags = [], in window: UIWindow) -> UIResponder? {
    guard let target = keyTarget(input, modifiers, in: window), let action = target.command.action else { return nil }
    target.responder.perform(action, with: target.command)
    return target.responder
  }

  /// The main queue ran the deferred blocks (the caret given back after a close).
  private func settle() async {
    try? await Task.sleep(for: .milliseconds(80))
  }

  // MARK: - Over the message field

  private struct Field {
    let session: SessionLayoutTests.Fixture
    let field: ComposerTextView
    let responder: SwitcherKeyResponder
    let switcher: SessionSwitcher
    let clock: Clock
    var window: UIWindow { session.window }
  }

  @MainActor
  final class Clock {
    var time: TimeInterval = 10
    var opened: [ProjectTabRef] = []
    var sent = 0
  }

  /// The session screen with a draft in the field and the caret in it; the switcher wired to its key receiver.
  private func field() throws -> Field {
    let session = try SessionLayoutTests.makeSession(safeBottom: 0)
    addTeardownBlock { @MainActor in session.window.isHidden = true }
    let field = session.controller.composer.textView
    field.insertText("szkic")
    XCTAssertTrue(field.becomeFirstResponder(), "caret in the field")
    let clock = Clock()
    field.onHardwareReturn = { clock.sent += 1 }
    let switcher = SessionSwitcher()
    switcher.now = { clock.time }
    switcher.onOpen = { clock.opened.append($0) }
    session.controller.switcher = switcher
    let responder = SwitcherKeyResponder()
    responder.currentResponder = { [weak window = session.window] in window.flatMap(Self.firstResponder) }
    session.window.rootViewController?.view.addSubview(responder)
    responder.attach(to: switcher)
    return Field(session: session, field: field, responder: responder, switcher: switcher, clock: clock)
  }

  /// Opens the window as a tap on the current tab does at session `cur` with rows cur, a, b.
  private func open(_ f: Field, keyboard: Bool = true) {
    f.clock.time += 1
    f.switcher.openByTap(keyboard: keyboard, tabs: [.session("cur"), .session("a"), .session("b")], current: .session("cur"))
  }

  /// The caret in the message field with a draft: the switcher window takes
  /// the keyboard, and Return belongs to the WINDOW — the field's own Return shortcut (send) does not fire and the
  /// draft stays. Esc gives the keyboard back to the field.
  func testWindowReturnWinsOverComposerReturn() async throws {
    let session = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { session.window.isHidden = true }
    let field = session.controller.composer.textView
    field.insertText("szkic")
    XCTAssertTrue(field.becomeFirstResponder(), "caret in the field")
    var sent = 0
    field.onHardwareReturn = { sent += 1 }
    XCTAssertTrue(Self.keyTarget("\r", in: session.window)?.responder === field, "without the window Return sends")

    let responder = SwitcherKeyResponder()
    responder.currentResponder = { [weak window = session.window] in window.flatMap(Self.firstResponder) }
    var keys: [SwitcherKey] = []
    responder.onKey = { keys.append($0) }
    session.window.rootViewController?.view.addSubview(responder)
    XCTAssertTrue(responder.take(), "the window takes the keyboard")
    XCTAssertTrue(responder.isFirstResponder)
    XCTAssertFalse(field.isFirstResponder)

    XCTAssertTrue(Self.press("\r", in: session.window) === responder, "Return goes to the window")
    XCTAssertEqual(keys, [.confirm])
    XCTAssertEqual(sent, 0, "the field did not send")
    XCTAssertEqual(field.text, "szkic", "the draft stays")

    responder.release(restore: true)
    await settle()
    XCTAssertTrue(field.isFirstResponder, "the caret goes back to the field")
    XCTAssertEqual(field.text, "szkic")
  }

  /// With the window holding the keyboard, the arrows (with and without Cmd) and Tab belong to the window: the
  /// selection moves, nothing reaches the field (no send, the draft stays, no suggestion key). S, Shift+S, Cmd+S and
  /// Shift+Cmd+S are no keys of the window: no key command takes them and the selection stays.
  func testMoveKeysAndTabStayInWindow() throws {
    let f = try field()
    open(f)
    XCTAssertTrue(f.responder.isFirstResponder && f.switcher.holdsKeyboard)
    for modifiers in [UIKeyModifierFlags(), .shift, .command, [.command, .shift]] {
      f.clock.time += 0.2
      XCTAssertNil(Self.keyTarget("s", modifiers, in: f.window), "S \(modifiers): no key command")
      XCTAssertEqual(f.switcher.machine.selected, .session("cur"), "S \(modifiers): the selection stays")
    }
    let steps: [(String, UIKeyModifierFlags, ProjectTabRef?)] = [
      (UIKeyCommand.inputDownArrow, [], .session("a")), (UIKeyCommand.inputDownArrow, .command, .session("b")),
      (UIKeyCommand.inputUpArrow, [], .session("a")), (UIKeyCommand.inputUpArrow, .command, .session("cur")),
      ("\t", [], .session("cur")), ("\t", .shift, .session("cur")),
    ]
    for (input, modifiers, selected) in steps {
      f.clock.time += 0.2
      XCTAssertTrue(Self.press(input, modifiers, in: f.window) === f.responder, "\(input) \(modifiers) to the window")
      XCTAssertEqual(f.switcher.machine.selected, selected, "\(input) \(modifiers)")
    }
    XCTAssertTrue(f.switcher.windowShown, "the window stays")
    XCTAssertEqual(f.clock.sent, 0)
    XCTAssertEqual(f.field.text, "szkic")
    // Return and Esc do not repeat: a held key that closed the window is not a second press, and the field's own
    // Return (send) does not repeat either.
    let commands = try XCTUnwrap(f.responder.keyCommands)
    let once: [(String, UIKeyModifierFlags)] = [
      ("\r", []), ("\r", .command), (UIKeyCommand.inputEscape, []), (UIKeyCommand.inputEscape, .command),
      (".", .command),
    ]
    for (input, modifiers) in once {
      let command = try XCTUnwrap(commands.first { $0.input == input && $0.modifierFlags == modifiers })
      XCTAssertEqual(command.repeatBehavior, .nonRepeatable, "\(input) \(modifiers)")
      XCTAssertTrue(command.wantsPriorityOverSystemBehavior)
    }
    let send = try XCTUnwrap(f.field.keyCommands?.first { $0.input == "\r" && $0.modifierFlags.isEmpty })
    XCTAssertEqual(send.repeatBehavior, .nonRepeatable, "the field's send")
  }

  /// Return and Cmd+Return jump to the selection; the field does not send and does not get the caret back (a held
  /// Return goes nowhere). Return on the current session (the selection at the opening) only closes and gives the
  /// caret back.
  func testReturnJumpsAndNeverSends() async throws {
    for modifiers in [UIKeyModifierFlags(), .command] {
      let f = try field()
      open(f)
      f.clock.time += 0.2
      Self.press(UIKeyCommand.inputDownArrow, in: f.window)
      XCTAssertTrue(Self.press("\r", modifiers, in: f.window) === f.responder)
      XCTAssertEqual(f.clock.opened, [.session("a")], "\(modifiers)")
      XCTAssertFalse(f.switcher.windowShown)
      await settle()
      XCTAssertFalse(f.field.isFirstResponder, "no caret back after a jump")
      XCTAssertEqual(f.clock.sent, 0)
      XCTAssertEqual(f.field.text, "szkic")
    }
    let f = try field()
    open(f)
    XCTAssertEqual(f.switcher.machine.selected, .session("cur"), "the selection starts on the current session")
    Self.press("\r", in: f.window)
    XCTAssertTrue(f.clock.opened.isEmpty, "Return on the current session: no jump")
    XCTAssertFalse(f.switcher.windowShown)
    await settle()
    XCTAssertTrue(f.field.isFirstResponder, "no jump: the caret back in the field")
    XCTAssertEqual(f.clock.sent, 0, "the closing Return did not send")
    XCTAssertEqual(f.field.text, "szkic")
  }

  /// The digits 1–9 with and without Cmd, from the top row and the keypad, belong to the window: the digit of a tab
  /// jumps at once, the current tab's digit closes and gives the caret back, a digit without a tab does nothing and
  /// the window stays. 0 is no key of the window: Cmd+0 goes on to the menu (the text size reset). Nothing reaches
  /// the field. They do not repeat.
  func testDigitsPickRows() async throws {
    let digitModifiers: [UIKeyModifierFlags] = [[], .command, .numericPad, [.numericPad, .command]]
    for modifiers in digitModifiers {
      let f = try field()
      open(f)
      XCTAssertTrue(Self.press("3", modifiers, in: f.window) === f.responder, "\(modifiers) to the window")
      XCTAssertEqual(f.clock.opened, [.session("b")], "\(modifiers): the third tab")
      XCTAssertFalse(f.switcher.windowShown)
      await settle()
      XCTAssertFalse(f.field.isFirstResponder, "no caret back after a jump")
      XCTAssertEqual(f.field.text, "szkic")
    }
    let f = try field()
    open(f)
    XCTAssertTrue(Self.press("7", .command, in: f.window) === f.responder)
    XCTAssertTrue(f.switcher.windowShown && f.clock.opened.isEmpty, "no tab 7: the window stays")
    for modifiers in digitModifiers {
      XCTAssertFalse(Self.keyTarget("0", modifiers, in: f.window)?.responder === f.responder, "0 \(modifiers)")
    }
    XCTAssertTrue(f.switcher.windowShown, "0 picks nothing")
    XCTAssertTrue(Self.press("1", in: f.window) === f.responder)
    XCTAssertFalse(f.switcher.windowShown)
    XCTAssertTrue(f.clock.opened.isEmpty, "1 is the current tab: no jump")
    await settle()
    XCTAssertTrue(f.field.isFirstResponder, "the caret back in the field")
    XCTAssertEqual(f.field.text, "szkic", "no digit reached the field")
    XCTAssertEqual(f.clock.sent, 0)

    let commands = try XCTUnwrap(f.responder.keyCommands)
    for digit in SwitcherKey.digits {
      for modifiers in digitModifiers {
        let command = try XCTUnwrap(
          commands.first { $0.input == digit && $0.modifierFlags == modifiers }, "\(digit) \(modifiers)")
        XCTAssertEqual(command.repeatBehavior, .nonRepeatable, "\(digit) \(modifiers)")
        XCTAssertTrue(command.wantsPriorityOverSystemBehavior, "\(digit) \(modifiers)")
      }
    }
  }

  /// Esc and Cmd+period close the window without a jump and give the caret back to the field; the turn is not
  /// interrupted (the field's Esc never ran).
  func testEscapeClosesAndGivesCaretBack() async throws {
    for (input, modifiers) in [
      (UIKeyCommand.inputEscape, UIKeyModifierFlags()), (UIKeyCommand.inputEscape, .command), (".", .command),
    ] {
      let f = try field()
      var escapes = 0
      f.field.canEscape = { true }
      f.field.onEscape = { escapes += 1 }
      open(f)
      XCTAssertTrue(Self.press(input, modifiers, in: f.window) === f.responder, "\(input) to the window")
      XCTAssertFalse(f.switcher.windowShown)
      XCTAssertTrue(f.clock.opened.isEmpty)
      await settle()
      XCTAssertTrue(f.field.isFirstResponder, "the caret back in the field")
      XCTAssertEqual(escapes, 0, "the field's Esc did not run")
    }
  }

  /// A sheet taking the keyboard over the window closes it and keeps the keyboard; the field becoming the first
  /// responder under the window closes it too. A closed window's receiver does not take the keyboard back from a
  /// sheet anchor that returns it.
  func testAnotherResponderClosesWindow() async throws {
    let f = try field()
    open(f)
    let anchor = SheetKeyboardAnchor.AnchorView()
    anchor.currentResponder = { [weak window = f.window] in window.flatMap(Self.firstResponder) }
    f.window.rootViewController?.view.addSubview(anchor)
    await settle()
    XCTAssertTrue(anchor.isFirstResponder, "the sheet holds the keyboard")
    XCTAssertFalse(f.switcher.windowShown, "the window closed")
    anchor.removeFromSuperview()
    await settle()
    XCTAssertFalse(f.responder.isFirstResponder, "the closed window does not take the keyboard back")

    let g = try field()
    open(g)
    XCTAssertTrue(g.responder.isFirstResponder)
    XCTAssertTrue(g.field.becomeFirstResponder(), "code under the window calls becomeFirstResponder")
    XCTAssertFalse(g.switcher.windowShown, "the window closed")
    XCTAssertTrue(g.field.isFirstResponder)
  }

  /// Without a hardware keyboard the window does not take the keyboard: the caret stays in the field. A keyboard
  /// connected while the window stands (the watch sees `GCKeyboardDidConnect`) gives it to the window, and the
  /// window's keys work from then on.
  func testWithoutKeyboardWindowLeavesCaret() throws {
    let f = try field()
    let watch = SwitcherWatch(switcher: f.switcher) { false }
    f.switcher.onWatch = { [weak watch] on in
      if on { watch?.start() } else { watch?.stop() }
    }
    defer { watch.stop() }
    open(f, keyboard: false)
    XCTAssertTrue(f.switcher.windowShown && !f.switcher.holdsKeyboard)
    XCTAssertTrue(f.field.isFirstResponder)
    XCTAssertFalse(f.responder.isFirstResponder)
    XCTAssertFalse(f.responder.becomeFirstResponder(), "the receiver refuses outside a take")
    NotificationCenter.default.post(name: .GCKeyboardDidConnect, object: nil)
    XCTAssertTrue(f.responder.isFirstResponder && f.switcher.holdsKeyboard, "the connected keyboard goes to the window")
    f.clock.time += 0.2
    XCTAssertTrue(Self.press(UIKeyCommand.inputDownArrow, in: f.window) === f.responder)
    XCTAssertEqual(f.switcher.machine.selected, .session("a"), "the window's keys work")
    XCTAssertEqual(f.field.text, "szkic")
  }

  /// The Esc guard on the session screen stays as a safety net while the window is open (a window without the
  /// keyboard): Esc closes the window and nothing else; after the close Esc goes back to the normal rules at once.
  func testEscapeOnSessionScreenBelongsToSwitcherWhileOpen() throws {
    let session = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { session.window.isHidden = true }
    let controller = session.controller
    let isEscape: (UIKeyCommand) -> Bool = { $0.input == UIKeyCommand.inputEscape && $0.modifierFlags.isEmpty }
    let cardEscape = try XCTUnwrap(controller.cardKeyCommands.first(where: isEscape))
    let turnEscape = try XCTUnwrap(controller.interruptKeyCommands.first(where: isEscape))
    XCTAssertFalse(controller.canPerformAction(cardEscape.action!, withSender: nil), "no window: no card focus")
    XCTAssertFalse(controller.canPerformAction(turnEscape.action!, withSender: nil), "no window: no turn")

    let switcher = SessionSwitcher()
    switcher.now = { 10 }
    controller.switcher = switcher
    switcher.openByTap(keyboard: false, tabs: [.session("a")], current: .session("a"))
    XCTAssertTrue(controller.switcherAbsorbsEscape)
    XCTAssertTrue(controller.canPerformAction(cardEscape.action!, withSender: nil))
    XCTAssertTrue(controller.canPerformAction(turnEscape.action!, withSender: nil))
    XCTAssertTrue(controller.takeEscapeForSwitcher(), "Esc taken")
    XCTAssertFalse(switcher.windowShown, "closed without a jump")
    XCTAssertFalse(controller.switcherAbsorbsEscape, "no grace window after the close")
    XCTAssertFalse(controller.takeEscapeForSwitcher())
    XCTAssertFalse(controller.canPerformAction(turnEscape.action!, withSender: nil), "normal rules again")
  }

  // MARK: - Gate and watch

  private func window(root: UIViewController) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    window.rootViewController = root
    window.makeKeyAndVisible()
    addTeardownBlock { @MainActor in window.isHidden = true }
    return window
  }

  /// Popover zaprezentowany przez kontroler-dziecko (tak staje lista promptów z ekranu sesji) zamyka bramkę od
  /// chwili `present`. Zejścia okna ten test nie sprawdza: bez hosta apki UIKit nie kończy przejść — otwarcie
  /// bramki po zamknięciu arkusza pilnuje `SwitcherUITests.testSilentUnderSheet`.
  func testPresentationByChildBlocksGate() {
    let root = UIViewController()
    let child = UIViewController()
    root.addChild(child)
    root.view.addSubview(child.view)
    child.didMove(toParent: root)
    let window = window(root: root)
    XCTAssertFalse(SwitcherPresentationGate.isBlocked(window))
    XCTAssertFalse(SwitcherPresentationGate.isBlocked(nil), "bez okna nie ma czego blokować")
    XCTAssertNil(SwitcherPresentationGate.presented(under: root))

    let popover = UIViewController()
    popover.modalPresentationStyle = .popover
    popover.popoverPresentationController?.sourceView = child.view
    popover.popoverPresentationController?.sourceRect = CGRect(x: 20, y: 20, width: 10, height: 10)
    child.present(popover, animated: false)
    XCTAssertTrue(SwitcherPresentationGate.isBlocked(window), "popover dziecka")
    XCTAssertTrue(SwitcherPresentationGate.presented(under: root) === popover)
    XCTAssertTrue(SwitcherPresentationGate.presented(under: child) === popover, "widzi go także samo dziecko")
  }

  /// Arkusz zaprezentowany przez korzeń (okno terminala, „Nowa sesja”, diff).
  func testSheetFromRootBlocksGate() {
    let root = UIViewController()
    let window = window(root: root)
    let sheet = UIViewController()
    root.present(sheet, animated: false)
    XCTAssertTrue(SwitcherPresentationGate.isBlocked(window))
    XCTAssertTrue(SwitcherPresentationGate.presented(under: root) === sheet)
  }

  /// The scene going inactive (Cmd+Tab, the app to the background) closes the open window at once, in the same turn
  /// of the main loop; a disconnected keyboard does not close it. A presentation found by the watch closes it too.
  func testWatchClosesOnSceneAndPresentationNotOnKeyboardLoss() async {
    let switcher = SessionSwitcher()
    var time: TimeInterval = 10
    switcher.now = { time }
    var blocked = false
    let watch = SwitcherWatch(switcher: switcher) { blocked }
    switcher.onWatch = { [weak watch] on in
      if on { watch?.start() } else { watch?.stop() }
    }
    defer { watch.stop() }
    switcher.openByTap(keyboard: false, tabs: [.session("a")], current: .session("a"))
    NotificationCenter.default.post(name: .GCKeyboardDidDisconnect, object: nil)
    XCTAssertTrue(switcher.windowShown, "a disconnected keyboard does not close the window")
    NotificationCenter.default.post(name: UIScene.willDeactivateNotification, object: nil)
    XCTAssertFalse(switcher.windowShown, "closed before `post` returns")

    time += 1
    switcher.openByTap(keyboard: false, tabs: [.session("a")], current: .session("a"))
    XCTAssertTrue(switcher.windowShown)
    blocked = true
    try? await Task.sleep(for: .milliseconds(400))
    XCTAssertFalse(switcher.windowShown, "a presentation closes the window")
  }

  // MARK: - Scrolling list

  /// The rows are live: tabs that come in before the selected row while a scrolling window stands push it down. The
  /// selection stays on its tab, and the list scrolls it back into view, so Return never confirms a row out of sight.
  /// The selection is the last row here, so "in view" is "scrolled to the bottom".
  func testNewTabsBeforeSelectionKeepItInView() throws {
    let store = try ProjectTreeListTests.store()
    let newest = "atlas-30"
    try sessions(store, (14..<30).map { "atlas-\($0)" } + [newest])
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session(newest)
    let switcher = SessionSwitcher()
    switcher.now = { 10 }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
    window.rootViewController = UIHostingController(
      rootView: SessionSwitcherOverlay(store: store, navigation: navigation, switcher: switcher))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    switcher.openByTap(
      keyboard: false, tabs: navigation.tabRefs(store.state), current: navigation.currentTab(store.state))
    ProjectTreeListTests.spin()
    XCTAssertEqual(switcher.machine.selected, .session(newest))
    let scroll = try XCTUnwrap(
      ProjectTreeListTests.views(UIScrollView.self, in: window).first { $0.contentSize.height > $0.bounds.height + 1 },
      "a scrolling list in the window")
    let gap = { scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
      - scroll.contentOffset.y }
    let before = scroll.contentSize.height
    XCTAssertLessThan(gap(), 1, "at the opening the selection (the last row) is in view: \(scroll.contentOffset)")

    // Older sessions come in: on the bar (oldest first) they stand before the selected one.
    try sessions(store, (0..<6).map { "atlas-0\($0)" })
    switcher.tabsChanged(navigation.tabRefs(store.state))
    ProjectTreeListTests.spin()
    XCTAssertEqual(switcher.machine.selected, .session(newest), "the selection stays on its tab")
    XCTAssertGreaterThan(scroll.contentSize.height, before + 100, "the new rows are in the list")
    XCTAssertLessThan(
      gap(), 1,
      "the selected row is in view after the new tabs: offset \(scroll.contentOffset.y), content "
        + "\(scroll.contentSize.height), height \(scroll.bounds.height)")
  }

  /// Sessions of the project `atlas` with `createdAt` from the minute in the id (`atlas-<minute>`).
  private func sessions(_ store: RarogStore, _ ids: [String]) throws {
    let summaries = ids.map { id in
      let minute = id.split(separator: "-").last.map(String.init) ?? "00"
      return #"""
        {"id":"\#(id)","cwd":"/Users/demo/atlas","title":"atlas","label":"sesja \#(id)","branch":"main",
         "state":"waiting-input","seen":true,"stateSince":"2026-10-06T10:00:00.000Z",
         "createdAt":"2026-10-06T09:\#(minute):00.000Z","lastActivityAt":"2026-10-06T10:00:00.000Z"}
        """#
    }
    for summary in summaries {
      let event = try EventDecoder.decode(Data(#"{"type":"session-changed","session":\#(summary)}"#.utf8)).get().event
      store.dispatch(.frame(event, source: .global, cursor: nil))
    }
  }
}
