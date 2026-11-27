#if os(iOS)
import SwiftUI
import UIKit

// Odbiorca klawiatury okna. Arkusz nie zabiera klawiatury temu, kto trzymał ją pod nim: pole wiadomości
// i terminal zostają pierwszym respondentem. Klawisze idą wtedy JEGO łańcuchem, a skrótów
// okna w nim nie ma: Cmd+W przy diffie zamykał scenę apki, a pod historią klawisze dostawał terminal. Okno
// z kotwicą bierze klawiaturę od chwili pokazania, w każdym stanie treści (wczytuję, pusta, błąd, tekst): liter
// nie przyjmuje, a Esc i Cmd+W idą jego łańcuchem do skrótów arkusza. Przy zejściu okna klawiatura wraca do
// poprzedniego odbiorcy, jeśli nikt inny jej w międzyczasie nie wziął.

/// Stawia ją szkielet okna (`WindowSheet`): `.background { SheetKeyboardAnchor() }`.
struct SheetKeyboardAnchor: UIViewRepresentable {
  func makeUIView(context: Context) -> AnchorView { AnchorView() }

  func updateUIView(_ view: AnchorView, context: Context) {}

  /// Oddaje klawiaturę okna jego treści (tekst historii: Cmd+A zaznacza, Cmd+C kopiuje bez dotykania tekstu).
  /// Tylko od kotwicy albo od nikogo: komuś spoza okna (terminal, pole wiadomości, zanim kotwica zdążyła ją
  /// wziąć) treść klawiatury nie zabiera. Kotwica dalej pamięta poprzedniego odbiorcę i oddaje mu klawiaturę,
  /// gdy okno schodzi razem z treścią. `false` = klawiaturę trzyma ktoś inny (można ponowić za chwilę).
  @MainActor
  @discardableResult
  static func handKeyboard(to responder: UIResponder, from current: UIResponder?) -> Bool {
    if responder.isFirstResponder { return true }
    guard current == nil || current is AnchorView else { return false }
    return responder.becomeFirstResponder()
  }

  final class AnchorView: UIView {
    /// Kto trzymał klawiaturę przed oknem (pole wiadomości, terminal pod arkuszem).
    private weak var previous: UIResponder?
    /// Bieżący pierwszy respondent — wstrzykiwany w testach (proces testów nie ma `UIApplication`).
    var currentResponder: @MainActor () -> UIResponder? = { FirstResponder.current() }

    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
      isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

    override var canBecomeFirstResponder: Bool { true }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard window != nil else { return }
      // Poza przebiegiem układu: widok jest już w hierarchii, a prezentacja zdążyła ustawić swoje okno.
      DispatchQueue.main.async { [weak self] in
        guard let self, self.window != nil, !self.isFirstResponder else { return }
        let before = self.currentResponder()
        guard self.becomeFirstResponder() else { return }
        // Another anchor of the same sheet (the page under a pushed page, or the page left by a pop) hands over the
        // responder it keeps, not itself: it leaves the window, and the keyboard would stay with nobody once the
        // sheet closes.
        // An anchor coming back into the window (a pop) keeps the responder it remembered while that one is still on
        // screen: whoever held the keyboard meanwhile (a shortcut row listening on the page it pops from) leaves with
        // that page.
        if let anchor = before as? AnchorView {
          self.previous = anchor.previous ?? self.previous
        } else if !Self.isOnScreen(self.previous) {
          self.previous = before
        }
      }
    }

    /// A remembered responder that can still take the keyboard: set and, when it is a view, in a window.
    private static func isOnScreen(_ responder: UIResponder?) -> Bool {
      guard let responder else { return false }
      return (responder as? UIView).map { $0.window != nil } ?? true
    }

    override func willMove(toWindow newWindow: UIWindow?) {
      super.willMove(toWindow: newWindow)
      guard newWindow == nil, let previous else { return }
      let currentResponder = currentResponder
      DispatchQueue.main.async {
        // Stan czytany DOPIERO teraz: klawiaturę mógł w międzyczasie wziąć ktoś inny (pole w następnym arkuszu)
        // i jemu jej nie odbieramy. Poprzedni odbiorca, który sam zszedł z ekranu, też jej nie dostaje.
        guard currentResponder() == nil else { return }
        if let view = previous as? UIView, view.window == nil { return }
        previous.becomeFirstResponder()
      }
    }
  }
}
#endif
