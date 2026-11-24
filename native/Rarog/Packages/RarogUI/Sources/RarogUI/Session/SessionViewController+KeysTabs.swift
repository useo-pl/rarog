#if os(iOS)
import RarogCore
import UIKit

// Cmd+X on the session screen: closes the current tab in two presses, unless the message field holds a selection;
// then it stays the system Cut. Owner: shortcuts.
//
// The controller's shortcut comes before text editing (the message field handles Cmd+X itself and does not pass it
// up the responder chain), so with a selection in the field the shortcut calls the field's system Cut itself; we do
// not rely on a disabled shortcut handing the key to the editor. The arming ("Sure?" for 5 s) lives in the
// navigation, the same one as at the tab's "×".
extension SessionViewController {
  var tabKeyCommands: [UIKeyCommand] {
    let close = UIKeyCommand(
      title: UICopy.shortcutCloseTab, action: #selector(closeTabShortcut), input: "x", modifierFlags: .command)
    close.discoverabilityTitle = UICopy.shortcutCloseTab
    close.wantsPriorityOverSystemBehavior = true
    return [close]
  }

  /// `nil` = akcja nie należy do zakładek. Lista w `canPerformAction` kontrolera.
  func tabKeyVerdict(_ action: Selector) -> Bool? {
    guard action == #selector(closeTabShortcut) else { return nil }
    return closeTabKey != .unavailable
  }

  /// Zaznaczony tekst w polu wiadomości z fokusem — Cmd+X należy wtedy do wycinania.
  private var closeTabKey: CloseTabKey {
    CloseTabKey(
      composerFocused: composer.textView.isFirstResponder,
      selectionLength: composer.textView.selectedRange.length,
      canClose: store.state.sessions[sessionId]?.canClose == true)
  }

  @objc private func closeTabShortcut() {
    switch closeTabKey {
    case .cut:
      composer.textView.cut(nil)
    case .close:
      NotificationCenter.default.post(name: .rarogCloseTabShortcut, object: sessionId)
    case .unavailable:
      break
    }
  }
}
#endif
