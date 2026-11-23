#if os(iOS)
import SwiftUI
import UIKit

// The pointer over what can be clicked: a delicate effect without the system glass — a link gets a lighter color,
// a list row a smoky background. Values: `HoverTokens`, tests on macOS.
// Właściciel: wygląd wspólny.

/// Stan wskaźnika nad widokiem — WYŁĄCZNIE wskaźnik (gładzik, mysz, rysik w zawisie). Palec nie „najeżdża”: `onHover`
/// nie słyszy dotyku, więc tapnięcie niczego nie zapala i nie traci się na „najechanie”.
/// Gest wskaźnika nie przechwytuje tapnięć ani fokusu
/// klawiatury. Systemowe efekty wskaźnika (`hoverEffect`: szkło, uniesienie) są w poddrzewie zdjęte — reakcją jest
/// nasz kolor albo tło. Treść dostaje stan także w środowisku (`rarogHovered`), dla etykiet przycisków.
struct RarogHoverReader<Content: View>: View {
  /// Wyłączony element (przycisk `disabled`, wiersz bez gestu) nie reaguje.
  var enabled = true
  @ViewBuilder var content: (Bool) -> Content
  @State private var hovering = false

  var body: some View {
    let lit = enabled && hovering
    content(lit)
      .environment(\.rarogHovered, lit)
      .onHover { hovering = $0 }
      .hoverEffectDisabled()
  }
}

extension EnvironmentValues {
  /// Wskaźnik stoi nad przyciskiem, w którego etykiecie jest ten widok (`RarogHoverReader`).
  @Entry var rarogHovered = false
}

/// Rodzaj reakcji na wskaźnik dla prostych przypadków (`rarogHover`). Wiersze z własnym tłem i style przycisków, które
/// same składają wygląd, czytają stan przez `RarogHoverReader`.
enum RarogHover {
  /// Atrament: spoczynkowy kolor → `text` pod wskaźnikiem (`.icon-btn:hover`, `.msg__copy:hover`, `.tool-call >
  /// summary:hover` w PWA). Kolor daje modyfikator, więc widok w środku nie może ustawiać własnego.
  case ink(rest: UIColor)
  /// Wypełnienie: atrament tekstu w kryciu `HoverTokens.wash` w kształcie (`.option:hover`, `.btn--text:hover`).
  case fill
}

extension View {
  /// Reakcja na wskaźnik bez własnego stanu w widoku: jaśniejszy atrament albo delikatne wypełnienie w kształcie.
  /// Zasięg wskaźnika = kształt treści (`contentShape` przed modyfikatorem: cały cel dotyku, nie sam glif).
  func rarogHover(_ hover: RarogHover, in shape: some Shape = Rectangle(), enabled: Bool = true) -> some View {
    RarogHoverReader(enabled: enabled) { hovered in
      switch hover {
      case let .ink(rest):
        self.foregroundStyle(Color(uiColor: hovered ? Palette.text : rest))
      case .fill:
        self.background(hovered ? Color(uiColor: Palette.text).opacity(HoverTokens.wash) : .clear, in: shape)
      }
    }
  }
}

/// Wskaźnik nad widokiem UIKit (ikona kopiowania przy bloku kodu i etykiecie „agent”): `UIHoverGestureRecognizer`
/// słyszy wyłącznie wskaźnik i nie przechwytuje tapnięć. Zastępuje systemowy efekt (`isPointerInteractionEnabled`,
/// szkło): widok sam zmienia kolor w `changed`.
@MainActor
final class RarogHoverTracker: NSObject, UIGestureRecognizerDelegate {
  private let changed: (Bool) -> Void
  private(set) var hovering = false

  init(view: UIView, changed: @escaping (Bool) -> Void) {
    self.changed = changed
    super.init()
    let recognizer = UIHoverGestureRecognizer(target: self, action: #selector(hover(_:)))
    recognizer.delegate = self
    view.addGestureRecognizer(recognizer)
  }

  /// Zmiana stanu wskaźnika (z gestu albo z testu): zgłasza tylko różnicę.
  func set(_ now: Bool) {
    guard now != hovering else { return }
    hovering = now
    changed(now)
  }

  @objc private func hover(_ recognizer: UIHoverGestureRecognizer) {
    set(recognizer.state == .began || recognizer.state == .changed)
  }

  /// Gest wskaźnika nikomu nie odbiera zdarzeń.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}
#endif
