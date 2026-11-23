#if os(iOS)
import SwiftUI
import UIKit

// The keys of the session switcher window (Cmd+S). The window takes the
// hardware keyboard like a command palette: a UIKit view in the overlay becomes the first responder, so Return, Esc,
// the arrows, the digits and Tab go through ITS responder chain and never reach the message field or the terminal under the window. Same
// pattern as the sheet anchor (`Views/Presentation/SheetKeyboardAnchor.swift`): the previous responder is kept
// weakly and gets the keyboard back after a close without a jump, if nobody else took it meanwhile. The machine
// (`SwitcherMachine`) decides when the window takes or releases the keyboard. Owner: shortcuts.

/// Places the key receiver in the switcher overlay. The view stays for the life of the overlay (zero size, no
/// touches) and takes the keyboard only on request.
struct SwitcherKeyAnchor: UIViewRepresentable {
  let switcher: SessionSwitcher

  func makeUIView(context: Context) -> SwitcherKeyResponder {
    let view = SwitcherKeyResponder()
    view.attach(to: switcher)
    return view
  }

  func updateUIView(_ view: SwitcherKeyResponder, context: Context) {
    view.attach(to: switcher)
  }
}

/// The first responder of the switcher window while it holds the keyboard.
final class SwitcherKeyResponder: UIView {
  /// A key of the window (``keyCommands``); Tab and Shift+Tab are swallowed without reaching ``onKey``.
  var onKey: @MainActor (SwitcherKey) -> Void = { _ in }
  /// Somebody else became the first responder while the window held the keyboard (code under the window called
  /// `becomeFirstResponder`, a sheet took it): the window closes.
  var onLost: @MainActor () -> Void = {}
  /// The current first responder — injected in tests (the test process has no `UIApplication`).
  var currentResponder: @MainActor () -> UIResponder? = { FirstResponder.current() }
  /// Who held the keyboard before the window (the message field, the terminal).
  private weak var previous: UIResponder?
  /// The window holds the keyboard: the key commands work and losing the first responder closes the window.
  private(set) var holding = false
  /// Only inside ``take()``: nobody else (a sheet anchor giving the keyboard back) makes this view the first
  /// responder of a closed window.
  private var accepting = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) unused") }

  /// Wires the view to the switcher: the machine's keyboard effects come here, the keys go to the machine.
  func attach(to switcher: SessionSwitcher) {
    onKey = { [weak switcher] key in switcher?.key(key) }
    onLost = { [weak switcher] in switcher?.cancel(.responderLost) }
    switcher.onTakeKeyboard = { [weak self] in self?.take() ?? false }
    switcher.onReleaseKeyboard = { [weak self] restore in self?.release(restore: restore) }
  }

  override var canBecomeFirstResponder: Bool { accepting || holding }

  /// Takes the keyboard; `false` = UIKit refused (no window).
  @discardableResult
  func take() -> Bool {
    if isFirstResponder {
      holding = true
      return true
    }
    let before = currentResponder()
    accepting = true
    defer { accepting = false }
    guard becomeFirstResponder() else { return false }
    holding = true
    previous = before === self ? nil : before
    return true
  }

  /// Gives the keyboard up. `restore`: back to the responder from before the window — read only on the next turn of
  /// the main loop, so the key that closed the window does not reach it, and only if nobody took the keyboard
  /// meanwhile and the previous responder is still in a window.
  func release(restore: Bool) {
    let previous = self.previous
    self.previous = nil
    guard holding else { return }
    holding = false
    if isFirstResponder { _ = resignFirstResponder() }
    guard restore, let previous else { return }
    let currentResponder = currentResponder
    DispatchQueue.main.async {
      guard currentResponder() == nil else { return }
      if let view = previous as? UIView, view.window == nil { return }
      previous.becomeFirstResponder()
    }
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned, holding {
      holding = false
      previous = nil
      onLost()
    }
    return resigned
  }

  // MARK: - Keys

  /// The window's keys, with and without Cmd (Cmd may still be held from Cmd+S). Return and Esc do not repeat: a held
  /// key that closed the window is not a second press.
  override var keyCommands: [UIKeyCommand]? { Self.commands }

  private static let commands: [UIKeyCommand] = {
    let down = #selector(SwitcherKeyResponder.switcherDown)
    let up = #selector(SwitcherKeyResponder.switcherUp)
    let confirm = #selector(SwitcherKeyResponder.switcherConfirm)
    let close = #selector(SwitcherKeyResponder.switcherClose)
    let swallow = #selector(SwitcherKeyResponder.switcherSwallow)
    let table: [(String, UIKeyModifierFlags, Selector, Bool)] = [
      (UIKeyCommand.inputDownArrow, [], down, true), (UIKeyCommand.inputDownArrow, .command, down, true),
      ("s", [], down, true), ("s", .command, down, true),
      (UIKeyCommand.inputUpArrow, [], up, true), (UIKeyCommand.inputUpArrow, .command, up, true),
      ("s", .shift, up, true), ("s", [.command, .shift], up, true),
      ("\r", [], confirm, false), ("\r", .command, confirm, false),
      (UIKeyCommand.inputEscape, [], close, false), (UIKeyCommand.inputEscape, .command, close, false),
      (".", .command, close, false),
      ("\t", [], swallow, true), ("\t", .shift, swallow, true),
    ]
    // The digits pick a row and close the window, so they do not repeat either. Cmd may still be held from Cmd+S;
    // a keypad digit comes with `.numericPad`. Cmd+1–9 are also the tab shortcuts of the menu: the menu asks the
    // window first (`SwitcherMachine.menuDigit`), so the window wins in whichever order UIKit delivers the press.
    var digits: [(String, UIKeyModifierFlags, Selector, Bool)] = []
    for digit in SwitcherKey.digits {
      for modifiers in [[], .command, .numericPad, [.numericPad, .command]] as [UIKeyModifierFlags] {
        digits.append((digit, modifiers, #selector(SwitcherKeyResponder.switcherDigit(_:)), false))
      }
    }
    return (table + digits).map { input, modifiers, action, repeats in
      let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
      command.wantsPriorityOverSystemBehavior = true
      if !repeats { command.repeatBehavior = .nonRepeatable }
      return command
    }
  }()

  private static let actions: Set<Selector> = [
    #selector(switcherDown), #selector(switcherUp), #selector(switcherConfirm), #selector(switcherClose),
    #selector(switcherSwallow), #selector(switcherDigit(_:)),
  ]

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if Self.actions.contains(action) { return holding }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc func switcherDown() { onKey(.down) }
  @objc func switcherUp() { onKey(.up) }
  @objc func switcherConfirm() { onKey(.confirm) }
  @objc func switcherClose() { onKey(.close) }
  /// 0–9: the row with that number.
  @objc func switcherDigit(_ sender: UIKeyCommand) {
    guard let digit = sender.input.flatMap(Int.init) else { return }
    onKey(.digit(digit))
  }
  /// Tab and Shift+Tab: nothing, and nothing under the window.
  @objc func switcherSwallow() {}

  // Other keys without Cmd do nothing and do not go up the chain; the window's keys (their key commands) and keys
  // with Cmd (menu shortcuts) go on.
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let passed = passing(presses)
    if !passed.isEmpty { super.pressesBegan(passed, with: event) }
  }

  override func pressesChanged(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let passed = passing(presses)
    if !passed.isEmpty { super.pressesChanged(passed, with: event) }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let passed = passing(presses)
    if !passed.isEmpty { super.pressesEnded(passed, with: event) }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let passed = passing(presses)
    if !passed.isEmpty { super.pressesCancelled(passed, with: event) }
  }

  /// UIKit matches the key commands while the press goes up the chain through `super.pressesBegan`, so the window's
  /// own keys must go on too (dropping them killed the arrows and Return on the device and in XCUITest).
  private func passing(_ presses: Set<UIPress>) -> Set<UIPress> {
    guard holding else { return presses }
    return presses.filter { press in
      guard let key = press.key else { return false }
      return key.modifierFlags.contains(.command) || Self.isWindowKey(key)
    }
  }

  private static let modifierMask: UIKeyModifierFlags = [.command, .shift, .alternate, .control]

  /// The press is one of ``commands`` (the input compared without case: Shift+S may come as "S").
  static func isWindowKey(_ key: UIKey) -> Bool {
    let input = key.charactersIgnoringModifiers.lowercased()
    let modifiers = key.modifierFlags.intersection(modifierMask)
    return commands.contains { ($0.input ?? "").lowercased() == input && $0.modifierFlags == modifiers }
  }
}
#endif
