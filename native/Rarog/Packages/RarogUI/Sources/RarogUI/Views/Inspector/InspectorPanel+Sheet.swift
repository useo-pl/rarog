#if os(iOS)
import RarogCore
import SwiftUI

// Prawy panel sesji na telefonie: ten sam `InspectorPanel` w arkuszu zamiast kolumny obok
// transkryptu. Kontener jak dymki telefonu: dymek, który na telefonie system zawsze stawia jako arkusz, z paskiem
// tytułu, uchwytem i detentami pół ekranu i pełnym (`popoverSheetChrome`), tło `surface` (`popoverSurface`). Dymek,
// a nie własny `.sheet`: okno diffa ze stukniętego pliku staje z korzenia (`SheetHost`), a dymek system zdejmuje sam,
// gdy arkusz staje. Kiedy i z jaką kotwicą panel się otwiera, mówi `Model/InspectorSheet.swift`.
// Właściciel: panel.

/// Gdzie stoi panel: kolumna obok transkryptu (iPad) albo arkusz (telefon).
enum InspectorPlacement {
  /// Kolumna 320 pt z kreską od transkryptu; panel sam odmierza klawiaturę.
  case column
  /// Arkusz telefonu: szerokość, tło i klawiaturę daje kontener.
  case sheet
}

extension View {
  /// Arkusz panelu przy sesji z `RarogNavigation.inspectorSheetSession` (telefon). `gitStale` liczy wołający, bo
  /// pamięć strumienia transkryptu trzyma ekran szczegółu (`DetailView`).
  func inspectorSheet(store: RarogStore, navigation: RarogNavigation, gitStale: @escaping (String) -> Bool) -> some View {
    modifier(InspectorSheetHost(store: store, navigation: navigation, gitStale: gitStale))
  }
}

private struct InspectorSheetHost: ViewModifier {
  let store: RarogStore
  let navigation: RarogNavigation
  let gitStale: (String) -> Bool

  func body(content: Content) -> some View {
    let sessionId = navigation.inspectorSheetSession(store.state)
    content
      .popover(isPresented: presented(sessionId), arrowEdge: .top) {
        if let sessionId {
          InspectorPanel(store: store, sessionId: sessionId, gitStale: gitStale(sessionId), placement: .sheet)
            .environment(navigation)
            .dismissOnEscape { navigation.closeInspectorSheet() }
            .popoverSheetChrome(title: UICopy.inspectorSheetTitle)
            .popoverSurface()
            .presentationCompactAdaptation(.sheet)
        }
      }
  }

  /// Gest, Esc i okno apki nad arkuszem zamykają go w nawigacji; otwiera tylko `openInspectorSheet`.
  private func presented(_ sessionId: String?) -> Binding<Bool> {
    Binding(get: { sessionId != nil }, set: { if !$0 { navigation.closeInspectorSheet() } })
  }
}
#endif
