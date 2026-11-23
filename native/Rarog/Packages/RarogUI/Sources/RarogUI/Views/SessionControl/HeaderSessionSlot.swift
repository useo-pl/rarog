#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// Ikony w prawym górnym rogu nagłówka sesji, JEDNĄ grupą: „Terminal w oknie" (to samo co Cmd+F),
/// przełącznik prawego panelu (iPad tylko gdy panel się mieści, telefon zawsze przy sesji z panelem — arkusz),
/// na ekranie terminala jego „⋯" i „×"
/// (`TerminalHeaderButtons`) i „×" bieżącej sesji (przycisk `HeaderCloseButton` należy do projektów
/// i zakładek). Osobne elementy paska narzędzi stałyby co
/// 12 pt (odstęp systemu), grupa trzyma je co `HeaderMetrics.iconSpacing`. Które ikony
/// stoją, mówi ``HeaderTrailingIcons`` (na telefonie najwyżej trzy). Wyłączony
/// terminal mówi zdanie pod paskiem zakładek (`RarogNavigation.togglePopup`), jak skrót. The Recent Sessions clock
/// stands in the project header of the list (`TreeRecentButton`), not here. Właściciel: sterowanie sesją.
struct HeaderSessionSlot: ViewModifier {
  let store: RarogStore
  /// Przyciski ekranu terminala na trasie (pokazane, gdy ekran jest podpięty).
  let terminal: TerminalChrome
  @Environment(RarogNavigation.self) private var navigation
  @Environment(\.horizontalSizeClass) private var sizeClass

  func body(content: Content) -> some View {
    let state = store.state
    // Ta sama bramka co Cmd+F w menu: przycisk stoi wszędzie tam, gdzie skrót ma projekt.
    let popup = navigation.canTogglePopup(state)
    // Lista z pamięci podręcznej: bez „×" do świeżego stanu.
    let closable = navigation.selectedSessionId.flatMap { state.sessions[$0] }.flatMap { session in
      session.canClose && !state.listStale ? session : nil
    }
    // Wpis Codexa w terminalu Raroga ma „×" sesji (zamyka panel, a z nim powłokę): drugiego „×" obok nie ma.
    let terminalButtons = terminal.isAttached && navigation.terminalRoute(state) != nil
    // Prawy panel: na iPadzie przycisk tylko tam, gdzie panel się mieści, na telefonie
    // przy każdej sesji z panelem (arkusz). Na telefonie przy czterech ikonach „Terminal w oknie" schodzi do „⋯"
    // terminala (``HeaderTrailingIcons``).
    let icons = HeaderTrailingIcons(
      popup: popup, inspector: navigation.inspectorButtonShown(state, phone: PopoverLayout.sheetBar),
      terminal: terminalButtons, sessionClose: closable != nil, compact: sizeClass == .compact)
    content
      .toolbar {
        if icons.count > 0 {
          ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: HeaderMetrics.iconSpacing) {
              if icons.popup { terminalPopupButton }
              if icons.inspector { InspectorToggleButton(store: store, navigation: navigation) }
              if icons.terminalMenu {
                TerminalHeaderButtons(
                  chrome: terminal, closes: icons.terminalClose, machine: store.state.serverMachine,
                  popup: icons.popupInMenu ? { navigation.togglePopup(.popup, state: store.state) } : nil)
              }
              if icons.sessionClose, let closable {
                HeaderCloseButton(session: closable, store: store, navigation: navigation)
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

/// „⋯" (Kopiuj, Wklej, Historia) i „×" ekranu terminala w grupie ikon prawego rogu — to samo miejsce i ten sam
/// cichy glif co „×" sesji. „×" dwa razy jak u sesji: pierwsze uzbraja „Na pewno?", drugie
/// zamyka powłokę na Macu. Stan i akcje: ``TerminalChrome``.
struct TerminalHeaderButtons: View {
  let chrome: TerminalChrome
  /// `false` = „×" daje wpis sesji obok (Codex w terminalu Raroga).
  let closes: Bool
  /// Słowo maszyny serwera w etykiecie uzbrojonego „×” (``AppState/serverMachine``).
  let machine: ServerMachine
  /// „Terminal w oknie" w menu zamiast ikony w pasku (telefon, ``HeaderSessionSlot``); `nil` = bez pozycji.
  var popup: (() -> Void)?

  var body: some View {
    Menu {
      Button(UICopy.terminalCopy, systemImage: TerminalBarKey.copy.symbol) { chrome.copy() }
      Button(UICopy.terminalPaste, systemImage: TerminalBarKey.paste.symbol) { chrome.paste() }
      Button(UICopy.terminalHistory, systemImage: TerminalBarKey.history.symbol) { chrome.history() }
        .disabled(!chrome.historyAvailable)
      if let popup {
        Divider()
        Button(UICopy.shortcutPopupShell, systemImage: "macwindow") { popup() }
          .accessibilityIdentifier("terminal.menu.popup")
      }
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
