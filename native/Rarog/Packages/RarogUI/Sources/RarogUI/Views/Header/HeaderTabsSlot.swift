#if os(iOS)
import Combine
import GameController
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// The project's tabs in the header (terminals too) and the card under the bar. The "×" of the current tab stands in
/// it (`TabCloseButton`): a session's runs the session's close, a terminal's (also an agent inside a Rarog terminal
/// and New Terminal while it opens) the terminal screen's (`TerminalChrome`). While a close is armed the card under
/// the bar says what the next press does (`CloseArmCard`). Owner: projects and tabs.
///
/// The bar stands also with one session and on the screen of a project without a session ("+" only); a session the
/// list does not know has no bar. Typing in the message field does NOT collapse the bar.
///
/// The arming of the session's "×" (and of Cmd+X) goes after 5 s, when the message field takes or gives up focus, and
/// when the scene stops being active (background, the app switcher, Control Center). The terminal screen keeps its own
/// arming and 5 s and reports them through `terminal`.
struct HeaderTabsSlot: ViewModifier {
  let store: RarogStore
  let selection: String?
  /// The terminal screen on the route: the state of its "×" and its close.
  let terminal: TerminalChrome
  @Environment(RarogNavigation.self) private var navigation
  /// Notatki projektów; bez rejestru (testy widoków) pasek stoi bez notatki.
  @Environment(ProjectNotes.self) private var notes: ProjectNotes?
  /// The session switcher: a tap on the current tab opens its window with the project's tabs.
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
    let terminalClose = terminal.closeState
    content
      // The card under the bar: the error notice if one stands, else the arming card of the session or the terminal
      // (`closeArmCard` is nil while a notice stands). It is laid out in the room the bar leaves, so it never covers
      // the current tab's "×": a notice there would take, with its tap-to-dismiss, the taps meant for the "×".
      .overlay(alignment: .top) {
        if let notice = navigation.notice {
          NavigationNoticeCard(notice: notice) { navigation.clearNotice($0) }
        } else if let card = navigation.closeArmCard(state, terminal: terminalClose) {
          CloseArmCard(card: card)
        }
      }
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
            close: navigation.tabClose(state, terminal: terminalClose),
            closePress: { pressClose($0) },
            closeBlur: { navigation.disarmClose() },
            select: { select($0, cwd: cwd) },
            addSession: { Task { await navigation.createSession(in: cwd, store: store) } },
            addTerminal: { navigation.openTerminal(.next, in: cwd, state: store.state) }
          )
        }
      }
      // The arming's clock: whichever way armed it (the tab's "×", Cmd+X, the state card), the arming goes after 5 s.
      // A cancelled wait (the screen went away, a new arming) takes nothing down.
      .task(id: navigation.closeArm) {
        guard let arm = navigation.closeArm else { return }
        guard (try? await Task.sleep(for: .seconds(max(0, arm.until.timeIntervalSinceNow)))) != nil else { return }
        navigation.disarm(arm)
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

  /// A press of the current tab's "×": the first arms, the second within 5 s closes. A session goes where the screen
  /// went before (`RarogNavigation.close`); a terminal route runs the terminal screen's close, the same as Cmd+X there
  /// (`TerminalChrome.tapClose`). The arming speaks when it arms; the press says nothing itself.
  private func pressClose(_ close: TabCloseModel) {
    guard let sessionId = close.sessionId else { return terminal.tapClose() }
    if navigation.requestClose(sessionId, state: store.state, now: Date()) == .confirmed {
      Task { await navigation.close(sessionId, store: store) }
    }
  }

  /// Tap w zakładkę (`ProjectTabModel.tap`): sesja i terminal nawigują, zaproszenie zakłada slot 1 (wygaszone mówi
  /// dlaczego). Tap w bieżącą otwiera okno przełącznika sesji (jedyne wejście do okna).
  private func select(_ tab: ProjectTabModel, cwd: String) {
    switch tab.tap {
    case .switcher:
      if let switcher { SessionSwitcherHost.openByTap(switcher: switcher, store: store, navigation: navigation) }
    case let .open(target):
      navigation.openTab(target, state: store.state)
    case .invite:
      navigation.openTerminal(.first, in: cwd, state: store.state)
    case .none:
      break
    }
  }
}
#endif
