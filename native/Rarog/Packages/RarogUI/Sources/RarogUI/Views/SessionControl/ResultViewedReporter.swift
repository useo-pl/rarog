#if os(iOS)
import RarogCore
import SwiftUI

// Odbiór wyniku z ekranu bez kontrolera sesji: stan Codexa i terminal Raroga. Właściciel: sterowanie sesją.

/// Odbiór wyniku z ekranu, który nie jest ekranem sesji: stan Codexa i terminal Raroga, w którym
/// stoi agent (Codex albo Claude). `nil` = na ekranie nie ma sesji (goła powłoka).
struct ResultViewedReporter: ViewModifier {
  let store: RarogStore
  let sessionId: String?
  @Environment(\.scenePhase) private var scenePhase
  /// Wejście w sesję: zwalnia ręczne „nieprzeczytane” RAZ na wejście (`ResultEntryMemory`).
  @State private var entry = ResultEntryMemory()

  func body(content: Content) -> some View {
    content
      .task(id: seenKey) {
        if entry.enters(sessionId), let sessionId { store.enterResultView(sessionId) }
        guard scenePhase == .active, let sessionId else { return }
        store.noteResultViewed(sessionId)
      }
      .onChange(of: sessionId) { old, _ in
        // Agent w terminalu się zmienił albo zniknął: wejście w następny wynik liczy się od nowa.
        if let old { store.leaveResultView(old) }
      }
      .onDisappear {
        if let sessionId { store.leaveResultView(sessionId) }
      }
  }

  /// Zmiana sesji, wyniku albo powrót apki na wierzch — ponowna ocena „obejrzane" (dedup trzyma rdzeń).
  private var seenKey: String {
    let target = sessionId.flatMap { store.state.seenTarget($0) } ?? ""
    return "\(sessionId ?? "")\u{0}\(target)\u{0}\(scenePhase == .active)"
  }
}
#endif
