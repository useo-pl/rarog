// Pełne tło popoverów apki. Systemowe szkło iOS 26/27 (Liquid Glass) rozmywa to, co leży pod
// popoverem: nad ciemnym transkryptem i listą agentów wychodziła szara plama z rozmytymi literami, drugorzędny
// atrament (`muted2`: liczby `+a −b`, etykiety) tracił kontrast, a ciemne kapsuły (`surface2`, wygaszone
// „Zatwierdź") znikały na jaśniejszym szkle (zrzuty iPada 13" w `GlassScreenshotUITests`). Popover z treścią
// do czytania stoi więc na pełnym `Palette.surface`, jak karta: `muted2` trzyma na nim AA w obu motywach
// (`PaletteContrastTests`). Na telefonie popover jest arkuszem i ten sam modyfikator daje mu to samo tło.
//
// Rogi i strzałka: `presentationBackground` maluje tylko obszar treści — zaokrąglony
// prostokąt z czterema jednakowymi rogami. Platforma szkła pod spodem ma strzałkę i ciaśniejszy róg obok niej,
// więc na iPadzie przy strzałce wystawało jaśniejsze szkło (zrzut: ciało #171717, strzałka i „ucho” w kolorze
// szkła). Mostek `PopoverChrome` koloruje samą platformę popovera tym samym `surface`: strzałka i rogi mają kolor
// treści z definicji. Telefon i wąskie okno (popover zaadaptowany do arkusza) zostają przy samym tle prezentacji.
// Strażnik: `PopoverSurfaceSourceTests` (każdy `.popover(` w kodzie ma `.popoverSurface()`, a modyfikator — mostek).
// Właściciel: nagłówek.

#if os(iOS)
import SwiftUI
import UIKit

extension View {
  /// Tło prezentacji (popover iPada i arkusz, w który zmienia się na telefonie): pełne `Palette.surface` zamiast
  /// systemowego szkła, a na iPadzie ten sam kolor na strzałce i rogach popovera. Stawia się w domknięciu
  /// `.popover { … }`, na treści popovera.
  func popoverSurface() -> some View {
    presentationBackground(Color(uiColor: Palette.surface))
      .background(PopoverChrome())
  }
}

/// Niewidoczny kontroler w treści popovera: przed pokazaniem (i raz jeszcze po nim, gdyby system przestawił
/// platformę w trakcie prezentacji) bierze `popoverPresentationController` najbliższego przodka i daje mu kolor
/// `surface`; od iOS 26.1 także efekt tła (`UIColorEffect`), który zastępuje szkło platformy. Tylko popover
/// w zwykłej szerokości — zaadaptowany do arkusza ma tło z `presentationBackground`.
private struct PopoverChrome: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> Controller { Controller() }

  func updateUIViewController(_ controller: Controller, context: Context) {}

  final class Controller: UIViewController {
    override func loadView() {
      let view = UIView()
      view.isUserInteractionEnabled = false
      view.isAccessibilityElement = false
      view.backgroundColor = .clear
      self.view = view
    }

    override func viewWillAppear(_ animated: Bool) {
      super.viewWillAppear(animated)
      paint()
    }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      paint()
    }

    private func paint() {
      // Szerokość PREZENTUJĄCEGO: treść popovera na iPadzie bywa sama w wąskiej klasie, a o tym, czy popover
      // zostaje popoverem (`presentationCompactAdaptation(.sheet)`), decyduje okno pod nim.
      guard let popover = popoverPresentationController,
        popover.presentingViewController.traitCollection.horizontalSizeClass == .regular
      else { return }
      if popover.backgroundColor != Palette.surface { popover.backgroundColor = Palette.surface }
      if #available(iOS 26.1, *), !(popover.backgroundEffect is UIColorEffect) {
        popover.backgroundEffect = UIColorEffect(color: Palette.surface)
      }
    }
  }
}
#endif
