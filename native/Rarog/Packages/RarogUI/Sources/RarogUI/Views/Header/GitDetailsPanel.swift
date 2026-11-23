#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Popover rozwinięcia linii gita: treść to wspólna sekcja `GitChangesSection`, a popover dokłada
/// przewijanie, stopkę i rozmiar. Dymek NICZEGO nie pobiera: wiersze plików z literą A/M/D i bilansem
/// idą z `fileDetails` ramki `git-status`, jak w prawym panelu (bez pola same ścieżki), więc otwiera się od
/// razu. „Pokaż diff” i stuknięcie pliku proszą o okno diffa (`RarogNavigation.openDiff`): system
/// zdejmuje dymek i stawia okno, które samo pobiera listę i patch stukniętego pliku. Właściciel: nagłówek.
struct GitDetailsPanel: View {
  let store: RarogStore
  let sessionId: String
  /// Dymek stoi jako arkusz (wąska klasa PREZENTUJĄCEGO): wysokość daje detent, nie treść.
  let compact: Bool
  /// Prośba o okno diffa: plik, od którego ma się otworzyć (`nil` = od góry).
  let openDiff: (_ path: String?) -> Void
  @State private var contentHeight: CGFloat = 0
  @State private var footerHeight: CGFloat = 0

  var body: some View {
    let state = store.state
    if let session = state.sessions[sessionId] {
      let fresh = state.transcripts[sessionId]?.git
      content(meta: GitMeta(session: session, fresh: fresh), fresh: fresh)
    }
  }

  private func content(meta: GitMeta, fresh: GitStatusEvent?) -> some View {
    let rows = GitChangesModel.rows(fresh: fresh)
    let available = GitChangesModel.diffAvailable(meta: meta)
    return ScrollView {
      GitChangesSection(meta: meta, rows: rows, shown: GitChangesModel.shownNote(fresh: fresh, rows: rows.count)) { path in
        openDiff(path)
      }
      .padding(PopoverLayout.contentInset)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    // „Pokaż diff" to przejście do większego widoku — ten sam wiersz stopki co „Otwórz w panelu z prawej".
    .safeAreaInset(edge: .bottom, spacing: 0) {
      PopoverFooterRow(
        symbol: "plus.forwardslash.minus", title: UICopy.showDiff,
        spoken: available ? UICopy.showDiffSpoken : UICopy.diffDisabledSpoken, identifier: "header.git.diff"
      ) {
        openDiff(nil)
      }
      .disabled(!available)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
    }
    // Dymek jest tak wysoki jak treść (dwa pliki nie zostawiają pustego pasa), do sufitu.
    .popoverLayout(
      contentHeight: contentHeight, footerHeight: footerHeight, ceiling: compact ? nil : PopoverLayout.ceiling)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("header.git.panel")
  }
}
#endif
