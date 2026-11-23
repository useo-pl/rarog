#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

/// Most SwiftUI → UIKit dla ekranu sesji. Banery prawej kolumny (także „Transkrypt nie dochodzi")
/// stawia `DetailView` (`Model/BannerSlots`).
struct SessionScreen: View {
  let store: RarogStore
  let sessionId: String
  let drafts: ComposerDrafts

  var body: some View {
    SessionControllerHost(store: store, sessionId: sessionId, drafts: drafts)
      // Ekran sesji sięga dolnej krawędzi ekranu: odstęp pola od niej liczy sam (`FootRest`). Z safe
      // area kontenera widok kończyłby się nad wskaźnikiem home, a pole stałoby jeszcze 10 pt wyżej — 44 pt nad
      // krawędzią na iPhonie Air.
      // Wszystkie regiony, nie sam kontener: klawiaturę — też pigułkę paska skrótów klawiatury sprzętowej — SwiftUI
      // liczy jako osobny region i przy nim kontener nie oddaje już pasa wskaźnika home. Ekran kończyłby się wtedy
      // nad tym pasem, tracił dolną wstawkę i pole podjeżdżałoby o 21 pt nad czarnym pasem okna (iPad).
      // Klawiaturę obsługuje `keyboardLayoutGuide` w UIKit.
      .ignoresSafeArea(edges: .bottom)
  }
}

struct SessionControllerHost: UIViewControllerRepresentable {
  let store: RarogStore
  let sessionId: String
  let drafts: ComposerDrafts
  @Environment(RarogNavigation.self) private var navigation
  /// Dymek o innej sesji nad promptem; bez centrum (testy) ekran nie ma dymka.
  @Environment(ToastCenter.self) private var toasts: ToastCenter?
  /// Przełącznik sesji: ekran pyta go, czy Esc jest jego.
  @Environment(SessionSwitcher.self) private var switcher: SessionSwitcher?

  func makeUIViewController(context: Context) -> SessionViewController {
    let controller = SessionViewController(store: store, sessionId: sessionId, drafts: drafts)
    controller.switcher = switcher
    // Okno tekstu transkryptu z menu wiadomości staje przez arkusz nawigacji.
    controller.navigation = navigation
    // Pigułki modelu i trybu w rzędzie pod polem (`+Controls`).
    controller.installComposerPills(navigation: navigation)
    // Karta stanu w miejscu pola (karty, `+StateCard`).
    controller.installStateCard(navigation: navigation)
    // Dymek nad promptem (`+Toast`).
    controller.installToast(center: toasts, navigation: navigation)
    // Ekran „Dyktowanie” z mikrofonu pola, gdy trasa dyktowania pyta (`+Voice`).
    controller.installVoice(navigation: navigation)
    return controller
  }

  func updateUIViewController(_ controller: SessionViewController, context: Context) {}
}
#endif
