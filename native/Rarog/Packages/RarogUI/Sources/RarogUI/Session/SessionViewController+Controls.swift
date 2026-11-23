#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Pigułki modelu i trybu w rzędzie kontrolek pola wiadomości (`docs/design.md`
// „Composer"). Właściciel: nagłówek.
extension SessionViewController {
  /// Wstawia `ComposerPills` za spinacz. Woła host ekranu przy tworzeniu kontrolera: SwiftUI
  /// osadzone w UIKit nie dziedziczy środowiska ekranu, więc nawigację (zdanie pod paskiem
  /// zakładek) podaje on.
  func installComposerPills(navigation: RarogNavigation) {
    // Dymek modelu otwiera też komenda apki `/model` (`modelSheetRequests`, `+AppCommands`).
    let pills = ComposerPills(store: store, sessionId: sessionId, modelSheetRequests: modelSheetRequests)
    let host = UIHostingController(rootView: pills.environment(navigation).textScaleHost())
    // Szerokość i wysokość z treści (pigułka zmienia długość z modelem); bez wstawek bezpiecznego
    // obszaru i klawiatury — rzędem steruje układ pola, nie SwiftUI.
    host.sizingOptions = [.intrinsicContentSize]
    host.safeAreaRegions = []
    host.view.backgroundColor = .clear
    addChild(host)
    composer.installControls(host.view)
    host.didMove(toParent: self)
  }
}
#endif
