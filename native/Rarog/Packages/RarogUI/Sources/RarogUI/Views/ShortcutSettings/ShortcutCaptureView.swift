#if os(iOS)
import UIKit

// The key receiver of a listening shortcut row. It lies over the shortcut (zero touches of its own) and takes the
// keyboard only while the row listens, in the pattern of the session switcher (`Switcher/SwitcherKeyResponder.swift`):
// the previous responder (the page's keyboard anchor) is kept weakly and gets the keyboard back on the next turn of
// the main loop, if nobody else took it meanwhile. While it holds the keyboard every key press with its modifiers
// goes to the row and no further up the chain, so neither a menu command nor the sheet's ⌘W and Esc see it. Esc is
// also the view's own key command, found before the sheet's Esc because the view is first in the chain, in case a
// key command is matched before the press reaches the view.
// A tap anywhere outside the view ends the listening, and so does losing the keyboard or leaving the window.
// Owner: shortcuts.

/// Takes a listening row's key presses.
final class ShortcutCaptureView: UIView {
  /// A key press with its modifiers; Esc without modifiers too, from the press or from the key command.
  var onPress: @MainActor (AppShortcut.Combination) -> Void = { _ in }
  /// The view lost the keyboard while holding it: somebody else became the first responder, or the view left its
  /// window (then it gives the keyboard back itself).
  var onLost: @MainActor () -> Void = {}
  /// A tap outside the view while it held the keyboard.
  var onEnd: @MainActor () -> Void = {}
  /// The current first responder — injected in tests (the test process has no `UIApplication`).
  var currentResponder: @MainActor () -> UIResponder? = { FirstResponder.current() }
  /// Who held the keyboard before the row listened.
  private weak var previous: UIResponder?
  /// The view holds the keyboard: keys come to the row and losing the first responder ends the listening.
  private(set) var holding = false
  /// Only inside ``take()``: nobody else (a sheet anchor giving the keyboard back) makes this view the first
  /// responder of a row that does not listen.
  private var accepting = false
  /// Watches taps in the window while the view holds the keyboard.
  private var outsideTap: UITapGestureRecognizer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) unused") }

  override var canBecomeFirstResponder: Bool { accepting || holding }

  /// Takes the keyboard; `false` = UIKit refused (no window).
  @discardableResult
  func take() -> Bool {
    if isFirstResponder {
      holding = true
      watchTaps()
      return true
    }
    let before = currentResponder()
    accepting = true
    defer { accepting = false }
    guard becomeFirstResponder() else { return false }
    holding = true
    previous = before === self ? nil : before
    watchTaps()
    return true
  }

  /// Gives the keyboard up. `restore`: back to the responder from before the row listened — read only on the next
  /// turn of the main loop, so the key that ended the listening does not reach it, and only if nobody took the
  /// keyboard meanwhile and the previous responder is still in a window.
  func release(restore: Bool) {
    let previous = self.previous
    self.previous = nil
    guard holding else { return }
    holding = false
    stopWatchingTaps()
    if isFirstResponder { _ = resignFirstResponder() }
    guard restore else { return }
    giveBack(to: previous)
  }

  private func giveBack(to previous: UIResponder?) {
    guard let previous else { return }
    let currentResponder = currentResponder
    DispatchQueue.main.async {
      guard currentResponder() == nil else { return }
      if let view = previous as? UIView, view.window == nil { return }
      previous.becomeFirstResponder()
    }
  }

  /// Lost while holding: somebody else took the keyboard (it stays with them), or UIKit resigned the view because the
  /// row left the window, before `willMove(toWindow:)` (the keyboard goes back to the page). ``giveBack(to:)`` tells
  /// the two apart on the next turn of the main loop.
  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned, holding { letGo() }
    return resigned
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    if newWindow == nil, holding { letGo() }
    super.willMove(toWindow: newWindow)
  }

  private func letGo() {
    let previous = self.previous
    self.previous = nil
    holding = false
    stopWatchingTaps()
    giveBack(to: previous)
    onLost()
  }

  // MARK: - Taps beside the shortcut

  private func watchTaps() {
    guard outsideTap == nil, let window else { return }
    let tap = UITapGestureRecognizer(target: self, action: #selector(windowTapped(_:)))
    tap.cancelsTouchesInView = false
    tap.delaysTouchesEnded = false
    tap.delegate = self
    window.addGestureRecognizer(tap)
    outsideTap = tap
  }

  private func stopWatchingTaps() {
    guard let tap = outsideTap else { return }
    tap.view?.removeGestureRecognizer(tap)
    outsideTap = nil
  }

  @objc private func windowTapped(_ tap: UITapGestureRecognizer) {
    guard tap.state == .ended, holding, !bounds.contains(tap.location(in: self)) else { return }
    onEnd()
  }

  // MARK: - Keys

  override var keyCommands: [UIKeyCommand]? { Self.commands }

  private static let commands: [UIKeyCommand] = {
    let command = UIKeyCommand(
      input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(ShortcutCaptureView.shortcutCaptureCancel))
    command.wantsPriorityOverSystemBehavior = true
    command.repeatBehavior = .nonRepeatable
    return [command]
  }()

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(shortcutCaptureCancel) { return holding }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc func shortcutCaptureCancel() { onPress(ShortcutRowEditor.cancelKey) }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard holding else {
      super.pressesBegan(presses, with: event)
      return
    }
    for press in presses {
      guard let key = press.key, let combination = Self.combination(key) else { continue }
      onPress(combination)
    }
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

  /// While holding, nothing goes up the chain: UIKit matches key commands while the press goes up through
  /// `super.pressesBegan`, so a press kept here reaches no menu command and no shortcut of the sheet.
  private func passing(_ presses: Set<UIPress>) -> Set<UIPress> {
    holding ? [] : presses
  }

  /// `nil` = a modifier alone or a key without a combination form (arrows, function keys).
  static func combination(_ key: UIKey) -> AppShortcut.Combination? {
    var modifiers: AppShortcut.Modifiers = []
    if key.modifierFlags.contains(.control) { modifiers.insert(.control) }
    if key.modifierFlags.contains(.alternate) { modifiers.insert(.option) }
    if key.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
    if key.modifierFlags.contains(.command) { modifiers.insert(.command) }
    switch key.keyCode {
    case .keyboardEscape: return AppShortcut.Combination(key: .escape, modifiers: modifiers)
    case .keyboardReturnOrEnter, .keypadEnter: return AppShortcut.Combination(key: .returnKey, modifiers: modifiers)
    default: break
    }
    let characters = key.charactersIgnoringModifiers
    guard characters.count == 1, let character = characters.first else { return nil }
    return AppShortcut.Combination(key: .character(character), modifiers: modifiers)
  }
}

extension ShortcutCaptureView: UIGestureRecognizerDelegate {
  /// The watching tap never takes a touch from the control under it (a switch, Back, the shortcut itself).
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}
#endif
