#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// The icons in the top right corner of the session header, as ONE group: first the lit circle of a running voice
/// conversation across sessions where the list header is off screen (`VoiceAgentSessionsHeaderCircle`; a tap ends
/// the conversation), then "Pop-Up Terminal" (the same as Cmd+F),
/// the right panel toggle (on the iPad only when the panel fits, on the phone at every session with a panel, as a
/// sheet), and on the terminal screen its "⋯" (`TerminalHeaderButtons`). The session's and the terminal's "×" stand
/// in the current tab (`TabCloseButton`), not here; only a terminal without a tab bar (no known project directory)
/// keeps its "×" here. Separate toolbar items would stand 12 pt apart (the system spacing); the group keeps them
/// `HeaderMetrics.iconSpacing` apart. ``HeaderTrailingIcons`` says which icons stand (on the phone three at most).
/// A disabled terminal says its sentence under the tab bar (`RarogNavigation.togglePopup`), as the
/// shortcut does. The Recent Sessions clock stands in the project header of the list (`TreeRecentButton`), not here.
/// Owner: session control.
struct HeaderSessionSlot: ViewModifier {
  let store: RarogStore
  /// Przyciski ekranu terminala na trasie (pokazane, gdy ekran jest podpięty).
  let terminal: TerminalChrome
  @Environment(RarogNavigation.self) private var navigation
  /// The voice conversation across sessions and its place (the root's `VoiceAgentSessionsBarSlot`).
  @Environment(\.voiceAgentSessionsFeed) private var voiceSessions

  func body(content: Content) -> some View {
    let state = store.state
    // Ta sama bramka co Cmd+F w menu: przycisk stoi wszędzie tam, gdzie skrót ma projekt.
    let popup = navigation.canTogglePopup(state)
    let terminalButtons = terminal.isAttached && navigation.terminalRoute(state) != nil
    // The lit circle only where the list header is off screen: beside the list it stands there, once.
    let circle = voiceSessions?.sessionHeaderCircle
    // The right panel: on the iPad only where the panel fits, on the phone at every session with a panel (a sheet).
    let icons = HeaderTrailingIcons(
      voiceSessions: circle != nil, popup: popup,
      inspector: navigation.inspectorButtonShown(state, phone: PopoverLayout.sheetBar),
      terminal: terminalButtons, closeInCorner: navigation.terminalCloseInCorner(state))
    content
      .toolbar {
        if icons.count > 0 {
          ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: HeaderMetrics.iconSpacing) {
              if let circle { VoiceAgentSessionsHeaderCircle(indicator: circle, navigation: navigation) }
              if icons.popup { terminalPopupButton }
              if icons.inspector { InspectorToggleButton(store: store, navigation: navigation) }
              if icons.terminalMenu {
                TerminalHeaderButtons(
                  chrome: terminal, closes: icons.terminalClose, machine: store.state.serverMachine)
              }
            }
          }
          // Ciche ikony bez szklanej kapsuły, jak `.head-close` w PWA; glif i cel 44 pt daje `HeaderIconButtonStyle`.
          .sharedBackgroundVisibility(.hidden)
        }
      }
  }

  /// Przełącznik jak skrót: drugie tapnięcie nad tym samym projektem zamyka okno.
  private var terminalPopupButton: some View {
    Button {
      navigation.togglePopup(.popup, state: store.state)
    } label: {
      Label(UICopy.shortcutPopupShell, systemImage: "macwindow")
    }
    .buttonStyle(HeaderIconButtonStyle())
    .shortcutTip(UICopy.shortcutPopupShell, .popupShell)
    .accessibilityLabel(UICopy.shortcutPopupShell)
    .accessibilityIdentifier("header.terminalPopup")
  }
}

/// The terminal screen's "⋯" (Copy, Paste, History) in the icon group of the top right corner, and its "×" there only
/// when the screen has no tab bar (``HeaderTrailingIcons/terminalClose``); otherwise the "×" stands in the current
/// tab. The corner "×" takes two presses like the tab's: the first arms with "Sure?" in text, the second ends the
/// shell on the server's machine. State and actions: ``TerminalChrome``.
struct TerminalHeaderButtons: View {
  let chrome: TerminalChrome
  /// The "×" stands here (a terminal without a tab bar).
  let closes: Bool
  /// The server machine's word in the armed "×"'s label (``AppState/serverMachine``).
  let machine: ServerMachine

  var body: some View {
    Menu {
      Button(UICopy.terminalCopy, systemImage: TerminalBarKey.copy.symbol) { chrome.copy() }
      Button(UICopy.terminalPaste, systemImage: TerminalBarKey.paste.symbol) { chrome.paste() }
      Button(UICopy.terminalSelectOutput, systemImage: TerminalBarKey.history.symbol) { chrome.history() }
        .disabled(!chrome.historyAvailable)
    } label: {
      Label(UICopy.terminalMoreSpoken, systemImage: "ellipsis.circle")
    }
    .menuStyle(.button)
    .buttonStyle(HeaderIconButtonStyle())
    .help(UICopy.terminalMoreSpoken)
    .accessibilityLabel(UICopy.terminalMoreSpoken)
    .accessibilityIdentifier("terminal.menu")
    if closes {
      Button {
        chrome.tapClose()
      } label: {
        switch chrome.close {
        case .closing:
          ProgressView().controlSize(.small)
        case .armed:
          Text(UICopy.terminalCloseConfirm)
            .appFont(.subheadline.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.err))
        case .idle:
          Label(UICopy.terminalClose, systemImage: "xmark")
        }
      }
      .buttonStyle(HeaderIconButtonStyle())
      .disabled(chrome.close == .closing)
      .shortcutTip(UICopy.terminalClose, .closeTab)
      .accessibilityLabel(chrome.close == .armed ? UICopy.terminalCloseConfirmSpoken(machine) : UICopy.terminalClose)
      .accessibilityIdentifier("terminal.close")
    }
  }
}
#endif
