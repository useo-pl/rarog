#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Arkusz „Limity” komendy apki `/usage`: na iPadzie dymek przy przycisku „Wyślij”, z którego komenda
// wyszła, na telefonie i w zwężonym oknie arkusz z detentami jak dymek promptów. Treść i odczyty: `Views/Usage/
// UsageSheet`. Właściciel: pole.
extension SessionViewController {
  /// Otwiera arkusz, chyba że nad ekranem stoi już inne okno — także prezentowane przez dziecko ekranu, jak dymek
  /// pigułki modelu (`overlayPresented`). `false` = arkusz nie wstał.
  func presentUsageSheet() -> Bool {
    guard !overlayPresented else { return false }
    let sheet = UsageSheet(
      store: store, compact: traitCollection.horizontalSizeClass != .regular,
      dismiss: { [weak self] in self?.dismiss(animated: true) })
    let host = UIHostingController(rootView: sheet)
    host.modalPresentationStyle = .popover
    // Rozmiar dymka z treści (`popoverLayout`): szerokość 320/420/560 pt, wysokość zmierzona do sufitu.
    host.sizingOptions = [.preferredContentSize]
    // Pełne tło zamiast szkła popovera, także pod strzałką (`PopoverSurface`).
    host.view.backgroundColor = Palette.surface
    host.popoverPresentationController?.backgroundColor = Palette.surface
    host.popoverPresentationController?.sourceView = composer.sendButtonView
    host.popoverPresentationController?.permittedArrowDirections = [.down, .up]
    if let sheet = host.popoverPresentationController?.adaptiveSheetPresentationController {
      sheet.detents = [.medium(), .large()]
      sheet.prefersGrabberVisible = true
    }
    present(host, animated: true)
    return true
  }
}
#endif
