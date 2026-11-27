#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Popover zadań w tle przy pigułce — nie przesuwa transkryptu (w PWA panel w nagłówku
/// skakał o 79 px). Treść to wspólna sekcja (`BackgroundTasksHeader`, `BackgroundTasksRows`) pod wspólnym
/// zegarem (`BackgroundClock`); popover dokłada przewijanie i rozwinięcia faz (`WorkflowExpansion`). Licznik
/// czasu tyka tylko tutaj, a kotwica przewinięcia trzyma czytany wiersz, gdy rozkład rośnie nad nim.
/// Panel czyta magazyn wprost (`@Observable`), więc nowe ramki listy odświeżają otwarty popover.
/// Bez kontaktu ze źródłem zegary stoją, a panel mówi „ostatni znany stan".
///
/// Popover mówi to samo co prawy panel, zwięźlej: nagłówek z liczbą i podziałem, pod zadaniami
/// SKOŃCZONE OSTATNIO (do 3 — to, co skończyło się obok trwającej pracy; po ostatnim zadaniu popover znika razem
/// z pigułką), a na iPadzie, gdy panel się mieści, przypięta stopka „Otwórz w panelu z prawej ⌘I". Wysokość idzie
/// za treścią (bez dawnego minimum 120 pt, które zostawiało pustą plamę pod jednym wierszem).
/// Właściciel: nagłówek.
struct BackgroundTasksPanel: View {
  let store: RarogStore
  let sessionId: String
  /// Sufit wysokości popovera (iPad); w arkuszu telefonu `nil` — wysokość daje detent.
  let ceiling: CGFloat?
  /// Przejście do prawego panelu; `nil` = panel się nie mieści albo to nie iPad (stopki nie ma).
  var openInPanel: (() -> Void)?

  @State private var expansion = WorkflowExpansion()
  /// Najwyższy widoczny wiersz — SwiftUI trzyma go w miejscu, gdy treść rośnie nad nim.
  @State private var anchor: String?
  @State private var contentHeight: CGFloat = 0
  @State private var footerHeight: CGFloat = 0

  var body: some View {
    let state = store.state
    let tasks = state.sessions[sessionId]?.backgroundTasks ?? []
    let lines = BackgroundPanel.lines(
      tasks, in: state.sessions[sessionId]?.state, choices: state.sessionControls.models ?? [], expansion: expansion)
    let finished = FinishedTasks.rows(state.transcripts[sessionId]?.messages ?? [])
    BackgroundClock(store: store, sessionId: sessionId) { now, frozen in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          BackgroundTasksHeader(frozen: frozen, header: BackgroundHeader(tasks))
            .padding(.bottom, 10)
          LazyVStack(alignment: .leading, spacing: 0) {
            BackgroundTasksRows(
              lines: lines, now: now, frozen: frozen,
              toggle: { key, current in expansion.toggle(key, current: current) },
              toggleDone: { key in expansion.toggleDone(key) })
            if !finished.isEmpty {
              BackgroundSectionTitle(text: UICopy.inspectorFinishedTitle)
                .padding(.top, 20)
                .padding(.bottom, 8)
                .accessibilityIdentifier("header.finished.title")
              ForEach(finished) { row in
                FinishedTaskRowView(row: row, identifier: "header.finished.\(row.id)")
              }
            }
          }
          .scrollTargetLayout()
        }
        .padding(.horizontal, PopoverLayout.contentInset)
        .padding(.top, 16)
        .padding(.bottom, 16)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollPosition(id: $anchor, anchor: .top)
      .scrollBounceBehavior(.basedOnSize)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if let openInPanel {
          // Ten sam skrót co globalne Cmd+I, ale przy otwartym dymku robi to, co stopka: zamyka dymek i otwiera
          // panel na W TLE (globalna ścieżka zostawiłaby zapamiętaną kotwicę panelu).
          PopoverFooterRow(
            symbol: "sidebar.right", title: UICopy.backgroundOpenInPanel,
            trailing: UICopy.backgroundOpenInPanelShortcut, shortcut: KeyboardShortcut("i", modifiers: .command),
            spoken: UICopy.backgroundOpenInPanelSpoken, identifier: "header.background.openPanel", action: openInPanel)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
        }
      }
    }
    // Dymek rośnie do treści z sufitem; arkusz telefonu bierze wysokość z detentu (`PopoverLayout`).
    .popoverLayout(
      contentHeight: contentHeight, footerHeight: openInPanel == nil ? 0 : footerHeight, ceiling: ceiling)
    .environment(\.waitCheckScope, WaitCheckScope(store: store, sessionId: sessionId))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("header.background.panel")
    .onChange(of: BackgroundPanel.currentKeys(tasks), initial: true) { _, keys in
      expansion.noteCurrent(keys)
    }
  }
}

#endif
