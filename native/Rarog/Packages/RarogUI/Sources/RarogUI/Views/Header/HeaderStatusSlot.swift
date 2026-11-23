#if os(iOS)
import RarogCore
import SwiftUI

/// Linia statusu sesji pod paskiem zakładek: kontekst i git po lewej, pigułki „w tle" i nowszego
/// CLI po prawej. Jedna linia zamiast dwóch: pigułki stoją przy
/// statusie, bo na iPadzie przy klawiaturze każdy rząd chromu zabiera transkryptowi miejsce.
/// Model i tryb mieszkają w rzędzie pod polem wiadomości (`Session/ComposerPills`). Sesja jeszcze
/// nieznana liście, ekran projektu bez sesji i sesja bez gita, kontekstu i pigułek linii nie mają.
/// Właściciel: nagłówek.
struct HeaderStatusSlot: ViewModifier {
  let store: RarogStore
  let selection: String?

  func body(content: Content) -> some View {
    let session = selection.flatMap { store.state.sessions[$0] }
    content
      .safeAreaInset(edge: .top, spacing: 0) {
        if let session {
          SessionStatusBar(store: store, session: session)
            .id(session.id)
        }
      }
  }
}
#endif
