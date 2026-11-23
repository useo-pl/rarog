#if os(iOS)
import Combine
import GameController
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Zakładki projektu w nagłówku (także terminale) i zdanie pod paskiem. „×" bieżącej sesji
/// (`HeaderCloseButton`) stoi w grupie ikon prawego górnego rogu (`HeaderSessionSlot`).
/// Właściciel: projekty i zakładki.
///
/// Pasek stoi też przy jednej sesji i na ekranie projektu bez sesji (sam „+"); sesja nieznana
/// liście paska nie ma. Pisanie w polu wiadomości paska NIE zwija.
///
/// Uzbrojenie „×" (i Cmd+X) gaśnie, gdy pole wiadomości dostaje albo oddaje fokus i gdy scena
/// przestaje być aktywna (tło, przełącznik aplikacji, centrum sterowania)
struct HeaderTabsSlot: ViewModifier {
  let store: RarogStore
  let selection: String?
  @Environment(RarogNavigation.self) private var navigation
  /// Notatki projektów; bez rejestru (testy widoków) pasek stoi bez notatki.
  @Environment(ProjectNotes.self) private var notes: ProjectNotes?
  /// Przełącznik aktywnych sesji: drugie tapnięcie w bieżącą zakładkę otwiera jego okno.
  @Environment(SessionSwitcher.self) private var switcher: SessionSwitcher?
  @Environment(\.scenePhase) private var scenePhase
  /// Klawiatura sprzętowa: tylko z nią zakładki pokazują klawisze z cyfrą skrótu Cmd (`ShortcutMenu.tabDigits`).
  @State private var hardwareKeyboard = TerminalKeyboard.isConnected()

  func body(content: Content) -> some View {
    let state = store.state
    let cwd = navigation.currentProjectCwd(state)
    // Linia statusu stoi pod paskiem (`HeaderStatusSlot`, ta sama sesja): wtedy kreska należy do niej.
    let statusLine = selection.flatMap { state.sessions[$0] }.map {
      StatusLine.isShown(
        $0, fresh: state.transcripts[$0.id]?.git, backgroundInPanel: navigation.inspectorVisible(state),
        restarting: state.restartInProgress($0.id))
    } ?? false
    // Nad terminalem kreski nie ma: pasek przechodzi w powierzchnię jak w linię statusu sesji (kreska tuż pod
    // zakładkami „podkreślałaby" pasek tylko na ekranie terminala).
    let terminalBelow = navigation.terminalRoute(state) != nil
    content
      .safeAreaInset(edge: .top, spacing: 0) {
        if let cwd {
          let tabs = state.projectTabModels(cwd: cwd, current: navigation.currentTab(state), opening: opening)
          ProjectTabBar(
            tabs: tabs,
            digits: ShortcutMenu.tabDigits(tabs.compactMap(\.target), hardwareKeyboard: hardwareKeyboard),
            addBlocked: state.launchBlocked ? UICopy.launchBlocked(state.launchBlockedDetail) : nil,
            addBusy: navigation.creating,
            terminalAvailable: state.terminalFeature == .on,
            divider: !statusLine && !terminalBelow,
            note: notes.flatMap { NoteTabModel.make(cwd: cwd, state: state, notes: $0) },
            hardwareKeyboard: hardwareKeyboard,
            // Wejście „dyktuj” zakładki notatki zawsze: trasę (ekran, systemowe, Soniox) bierze notatka.
            voice: true,
            select: { select($0, cwd: cwd) },
            addSession: { Task { await navigation.createSession(in: cwd, store: store) } },
            addTerminal: { navigation.openTerminal(.next, in: cwd, state: store.state) }
          )
        }
      }
      .overlay(alignment: .top) {
        if let notice = navigation.notice {
          NavigationNoticeCard(notice: notice) { navigation.clearNotice($0) }
        }
      }
      .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { note in
        if note.object is ComposerTextView { navigation.disarmClose() }
      }
      .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { note in
        if note.object is ComposerTextView { navigation.disarmClose() }
      }
      .onChange(of: scenePhase) { _, phase in
        if phase != .active { navigation.disarmClose() }
        // Klawiatura podłączona albo odłączona, gdy apka stała w tle.
        if phase == .active { hardwareKeyboard = TerminalKeyboard.isConnected() }
      }
      .onReceive(Self.keyboardChanges) { _ in hardwareKeyboard = TerminalKeyboard.isConnected() }
      // Wejście w projekt: jeden odczyt notatki na katalog na epokę, gdy bitu nie ma (projekt spoza `notesCwds`).
      .task(id: navigation.currentProjectCwd(store.state)) {
        guard let cwd = navigation.currentProjectCwd(store.state) else { return }
        notes?.probe(cwd, state: store.state)
      }
  }

  /// Podłączenie i odłączenie klawiatury sprzętowej. Zgłoszenia `GCKeyboard` bywają spoza głównego wątku
  /// (jak w `TerminalScreenViewController.keyboardsChanged`), stąd przesiadka na główną kolejkę.
  /// Also the tree's tab digits (`SessionListView`).
  static var keyboardChanges: some Publisher<Notification, Never> {
    NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)
      .merge(with: NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect))
      .receive(on: DispatchQueue.main)
  }

  /// Na ekranie terminal, którego id jeszcze nie znamy (zaproszenie, „Nowy terminal").
  private var opening: Bool {
    if case .openingTerminal = navigation.detail { return true }
    return false
  }

  /// Tap w zakładkę: sesja i terminal nawigują, zaproszenie zakłada slot 1 (wygaszone mówi dlaczego). Tap
  /// w bieżącą otwiera okno przełącznika sesji, jak Cmd+S.
  private func select(_ tab: ProjectTabModel, cwd: String) {
    if tab.current, let switcher {
      SessionSwitcherHost.openByTap(switcher: switcher, store: store, navigation: navigation)
    } else if let target = tab.target {
      navigation.openTab(target, state: store.state)
    } else if case .invite = tab.kind {
      navigation.openTerminal(.first, in: cwd, state: store.state)
    }
  }
}
#endif
