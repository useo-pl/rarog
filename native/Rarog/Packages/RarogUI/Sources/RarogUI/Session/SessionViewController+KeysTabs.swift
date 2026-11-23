#if os(iOS)
import RarogCore
import UIKit

// Cmd+X na ekranie sesji: zamyka bieżącą zakładkę dwoma naciśnięciami, chyba że
// w polu wiadomości jest zaznaczenie — wtedy zostaje systemowym „Wytnij". Właściciel: skróty.
//
// Skrót kontrolera ma pierwszeństwo przed edycją tekstu (pole wiadomości obsługuje Cmd+X samo
// i nie oddaje go łańcuchowi respondera), więc przy zaznaczeniu w polu skrót sam woła systemowe
// „Wytnij" pola — nie polegamy na tym, czy wyłączony skrót odda klawisz edytorowi. Stan
// uzbrojenia („Na pewno?" na 5 s) żyje w nawigacji — ten sam, co przy „×" w nagłówku.
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
