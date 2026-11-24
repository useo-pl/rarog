#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Prawa kolumna: ekran sesji, ekran terminala (trasa terminala i wpis agenta z `termId` — Codex albo Claude
/// uruchomiony w terminalu Raroga), ekran stanu Codexa bez terminala, ekran projektu bez sesji albo
/// zdanie, gdy nic nie wybrano. Nagłówek składają sloty (`Views/Header/`) — terminal ma ten sam nagłówek i pasek
/// zakładek co sesja, a nad terminalem z agentem stoi linia statusu jego sesji.
/// Obok ekranu sesji Claude na iPadzie stoi prawy panel (`InspectorPanel`), gdy
/// człowiek go otworzył, a kolumna go mieści — szerokość kolumny mierzy ten widok (`RarogInspector.noteLayout`).
struct DetailView: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let drafts: ComposerDrafts
  /// Pamięć strumienia globalnego (ta sama co lista) — baner „Serwer nie odpowiada" przy schowanej liście.
  let memory: ConnectionMemory
  /// Pamięć strumienia transkryptu: baner nie mruga przy każdej próbie ponownego połączenia. The root keeps it, next
  /// to the global memory, because the list column reads it too.
  let transcriptLink: TranscriptConnectionMemory
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// „⋯" i „×" ekranu terminala w grupie ikon paska nawigacji.
  @State private var terminalChrome = TerminalChrome()
  /// Szerokość kolumny szczegółu — miejsce na prawy panel (histereza w `InspectorModel`).
  @State private var columnWidth: CGFloat = 0

  /// Kolumnę listy widać obok: nie zwinięta (Cmd+B) i okno nie jest wąskie (wtedy podział zwija się do stosu).
  private var listVisible: Bool {
    !navigation.listHidden && sizeClass != .compact
  }

  var body: some View {
    let state = store.state
    Group {
      if let route = navigation.terminalRoute(state) {
        TerminalRouteView(store: store, navigation: navigation, route: route, chrome: terminalChrome)
          // Agent stojący w tym terminalu: wejście na ekran jest odbiorem jego wyniku.
          .modifier(ResultViewedReporter(store: store, sessionId: navigation.listSelection(state)))
      } else {
        content(state)
      }
    }
    // Dymek o innej sesji i komunikaty apki: na ekranie sesji nad promptem (osadzony w ekranie), na innych
    // ekranach u dołu kolumny.
    .modifier(ToastOverlay(
      navigation: navigation, placement: ToastPlacement.resolve(navigation: navigation, state: state)))
    // Banery prawej kolumny pod nagłówkiem: transkrypt otwartej sesji, a przy niewidocznej liście
    // także globalne (`Model/BannerSlots`).
    .safeAreaInset(edge: .top, spacing: 0) {
      let column = BannerColumn.detail(sessionId: navigation.selectedSessionId, listVisible: listVisible)
      BannerStack(
        banners: state.banners(in: column, global: memory, transcript: transcriptLink.connection(for: state.viewedSessionId)),
        pushPrompt: state.pushPromptVisible(in: column, global: memory, now: Date()) ? store : nil)
    }
    // Tło we wszystkich regionach, także klawiatury: przy pigułce paska skrótów pod prawym panelem zostawał czarny
    // pas okna, bo tło samego kontenera tam nie sięga (iPad; tak samo robi kolumna listy).
    .background { Color(uiColor: Palette.background).ignoresSafeArea() }
    // Nagłówek ze slotami per obszar (`Views/Header/`). Na trasie terminala sesją nagłówka jest agent, który
    // w nim stoi — linia statusu wygląda tak samo po wejściu z wiersza listy i z zakładki terminala.
    .modifier(SessionHeader(store: store, selection: navigation.listSelection(state), terminal: terminalChrome))
    // Telefon: ten sam panel jako arkusz, otwierany z linii statusu i pigułki „w tle”.
    .inspectorSheet(store: store, navigation: navigation) { id in gitStale(store.state, id) }
    // Miejsce na prawy panel: szerokość kolumny razem z panelem (pomiar nie zależy od tego, czy panel stoi).
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
    .onChange(of: InspectorLayout(width: columnWidth, eligible: inspectorEligible), initial: true) { _, layout in
      navigation.inspector.noteLayout(columnWidth: Double(layout.width), eligible: layout.eligible)
    }
  }

  /// Panel wchodzi w grę tylko na iPadzie w zwykłej szerokości (nie telefon, nie wąskie okno Split View).
  private var inspectorEligible: Bool {
    UIDevice.current.userInterfaceIdiom == .pad && sizeClass == .regular
  }

  /// Zmiany w katalogu bez kontaktu ze źródłem: strumień sesji padł, sesja `stale` albo lista z pamięci.
  private func gitStale(_ state: AppState, _ id: String) -> Bool {
    transcriptLink.connection(for: id).showsServerUnreachable || state.sessions[id]?.stale == true || state.listStale
  }

  @ViewBuilder
  private func content(_ state: AppState) -> some View {
    switch navigation.detail {
    case let .session(id):
      if let session = state.sessions[id] {
        if session.engine == .codex {
          CodexStateView(session: session)
            // Odbiór wyniku z ekranu Codexa.
            .modifier(ResultViewedReporter(store: store, sessionId: id))
        } else {
          HStack(spacing: 0) {
            // Ta sama instancja kontrolera przy otwieraniu i zamykaniu panelu: tożsamość z sesji, nie z panelu —
            // przypięcie, kotwica, fokus, szkic i dyktowanie przeżywają.
            SessionScreen(store: store, sessionId: id, drafts: drafts)
              .id(id)
            if navigation.inspectorVisible(state) {
              // Tożsamość sesji: zmiana sesji zamyka arkusz diffa i nie zostawia danych poprzedniej.
              InspectorPanel(store: store, sessionId: id, gitStale: gitStale(state, id))
                // The width handle straddles the panel's left hairline. It sits outside the panel's accessibility
                // container, so the panel's frame stays its own width.
                .overlay(alignment: .leading) {
                  InspectorResizeHandle(inspector: navigation.inspector)
                    .offset(x: -InspectorResizeHandle.hitWidth / 2)
                }
                .id(id)
            }
          }
          // Klawiaturę obsługuje `keyboardLayoutGuide` w UIKit — SwiftUI ma nie ściskać ekranu drugi raz. Na CAŁYM
          // rzędzie z panelem: rząd skurczony nad klawiaturą ścisnąłby ekran sesji drugi raz; panel odmierza ją sam.
          .ignoresSafeArea(.keyboard)
          // Zamiana ekranu sesji nigdy się nie animuje: przejście krycia dwóch ekranów idzie na wątku zajętym
          // budową nowego kontrolera i rwie, niezależnie od tego, czyja animacja je niesie.
          .transaction { $0.animation = nil }
        }
      } else if navigation.isLaunching(id, now: Date()) {
        // Sesja założona przed chwilą z tego urządzenia: 202 bywa szybsze niż ramka listy.
        LaunchingSessionView()
      } else if state.transcriptPhase(for: id) == .unknownSession {
        UnknownSessionView { navigation.detail = nil }
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    case let .project(cwd):
      ProjectEmptyView(cwd: cwd, store: store, navigation: navigation)
    case .terminal, .openingTerminal:
      // Trasa bez celu (id spoza kształtu `TERM_ID_RE`, katalog odrzucony) — nigdy ślepy zaułek.
      UnknownSessionView(text: UICopy.terminalMissing) { navigation.detail = nil }
    case .inbox:
      InboxScreen(store: store, drafts: drafts)
    case nil:
      Placeholder(text: UICopy.detailPlaceholder, store: store)
    }
  }
}

/// Szerokość kolumny szczegółu i to, czy panel w ogóle wchodzi w grę — jedna wartość do `onChange`.
private struct InspectorLayout: Equatable {
  let width: CGFloat
  let eligible: Bool
}

/// The terminal screen on the route: the `TerminalScreen` bridge with the screen identity from the navigation, so
/// moving "New Terminal" onto its id makes no new controller (and no new shell), while another terminal does. "×"
/// goes back to the project's session last active, History opens a sheet. "⋯" and "×" stand in the icon group of the
/// navigation bar (`chrome`, `HeaderSessionSlot`).
struct TerminalRouteView: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let route: TerminalRoute
  let chrome: TerminalChrome
  /// Tożsamość TEGO widoku: odtworzony widok dostaje nową i nie prosi drugi raz o nową powłokę.
  @State private var instance = UUID()

  var body: some View {
    if let opening = route.opening, !navigation.claimsOpening(opening, view: instance) {
      NewTerminalUnconfirmedView {
        navigation.openTerminal(.next, in: opening.cwd, state: store.state)
      }
    } else {
      screen
    }
  }

  private var screen: some View {
    let key = route.key
    return TerminalScreen(
      store: store, target: route.target, chrome: chrome,
      onClose: { navigation.terminalClosed(screen: key, state: store.state) },
      onHistory: { navigation.showTerminalHistory($0) },
      onTerminalIdentified: { navigation.terminalIdentified($0, screen: key, state: store.state) })
      .id(key)
      // Klawiaturę obsługuje `keyboardLayoutGuide` w UIKit — SwiftUI ma nie ściskać ekranu drugi raz.
      .ignoresSafeArea(.keyboard)
      .accessibilityIdentifier("detail.terminal")
  }
}

/// Prawa kolumna bez wyboru, jak `.empty` w PWA: u góry etykieta „SESJA", zdanie
/// i „Nowa sesja" — wyjście zamiast ślepej ściany. Przy zakazie zakładania przycisk jest przygaszony,
/// ale klikalny: formularz mówi powód (jak przycisk w pasku listy).
struct Placeholder: View {
  let text: String
  let store: RarogStore
  @Environment(NewSessionPresenter.self) private var presenter: NewSessionPresenter?

  var body: some View {
    let blocked = store.state.launchBlocked ? UICopy.launchBlocked(store.state.launchBlockedDetail) : nil
    VStack(spacing: 12) {
      Text(UICopy.detailEyebrow)
        .eyebrow()
        .accessibilityAddTraits(.isHeader)
      Text(text)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("detail.placeholder")
      Button(UICopy.newSessionTitle) {
        presenter?.openNewSession()
      }
      // Pigułka akcji głównej jak `.btn--primary` w PWA: achromatycznie, atrament tekstu.
      .buttonStyle(FilledButtonStyle(
        fill: Color(uiColor: Palette.text), text: Color(uiColor: Palette.background), hover: .inkFill))
      .opacity(blocked == nil ? 1 : 0.6)
      .accessibilityHint(blocked ?? "")
      .accessibilityIdentifier("detail.newSession")
      .padding(.top, 4)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}

/// „startuje" — sesja założona z tego urządzenia, której lista jeszcze nie pokazała.
struct LaunchingSessionView: View {
  var body: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(UICopy.sessionStarting)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("detail.launching")
  }
}

/// Widok „Nowego terminala" odtworzony, zanim przyszła odpowiedź serwera: nowy terminal mógł powstać, więc
/// drugiego nie zakładamy sami — zdanie i świadome „Spróbuj od nowa" (jak `newTerminalUnconfirmed` w rdzeniu).
struct NewTerminalUnconfirmedView: View {
  let retry: () -> Void

  var body: some View {
    VStack(spacing: 16) {
      Text(UICopy.terminalNewUnconfirmed)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.text))
        .multilineTextAlignment(.center)
      Button(UICopy.terminalRetry, action: retry)
        .buttonStyle(NeutralButtonStyle())
        .accessibilityIdentifier("terminal.unconfirmed.retry")
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// „Nie znam takiej sesji." (albo „Tego terminala już nie ma.") z wyjściem — nigdy ślepy zaułek.
struct UnknownSessionView: View {
  var text = UICopy.unknownSession
  let back: () -> Void

  var body: some View {
    VStack(spacing: 16) {
      Text(text)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.text))
      Button(UICopy.backToList, action: back)
        .buttonStyle(NeutralButtonStyle())
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// Wpis Codexa: Rarog widzi tylko stan — bez transkryptu, pola i zgód.
struct CodexStateView: View {
  let session: SessionSummary

  var body: some View {
    let status = RowStatus(session)
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Circle().fill(Color(uiColor: Palette.tone(status.tone))).frame(width: 10, height: 10).accessibilityHidden(true)
        Text(status.text)
          .appFont(.headline.monospaced())
          .foregroundStyle(Color(uiColor: Palette.text))
      }
      Text(UICopy.sendBlock(.codex, session: session))
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
      Spacer()
    }
    .padding(24)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}
#endif
