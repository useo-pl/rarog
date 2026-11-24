#if os(iOS)
import UIKit

/// Bramka przełącznika sesji: gdy w oknie apki cokolwiek jest zaprezentowane — arkusz, popover,
/// okno terminala, historia, potwierdzenie, podgląd załącznika, wybór plików — okno przełącznika nie staje, a gest w toku kończy
/// się bez przejścia. Pyta korzeń okna i wszystkich jego potomków: popover paska promptów prezentuje kontroler
/// sesji, nie korzeń. Jedno miejsce zamiast piętnastu haków przy każdej prezentacji. Właściciel: skróty.
@MainActor
enum SwitcherPresentationGate {
  static func isBlocked() -> Bool {
    isBlocked(window())
  }

  static func isBlocked(_ window: UIWindow?) -> Bool {
    guard let root = window?.rootViewController else { return false }
    return presented(under: root) != nil
  }

  /// Zaprezentowany kontroler widziany przez `controller` albo któregokolwiek z jego potomków.
  static func presented(under controller: UIViewController) -> UIViewController? {
    if let presented = controller.presentedViewController { return presented }
    for child in controller.children {
      if let hit = presented(under: child) { return hit }
    }
    return nil
  }

  /// Okno apki na pierwszym planie.
  static func window() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    return scene?.keyWindow ?? scene?.windows.first
  }

  /// Scena apki jest aktywna. Przejście do sesji idzie tylko wtedy: gest przerwany przełącznikiem aplikacji
  /// (Cmd+Tab) albo zejściem apki w tło niczego nie przełącza.
  static func sceneIsActive() -> Bool {
    UIApplication.shared.connectedScenes.contains { $0.activationState == .foregroundActive }
  }
}
#endif
